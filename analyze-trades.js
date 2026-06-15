// =============================================================================
// ANALYZE TRADES — Break down post-fix trade performance by setup type,
// regime, and approval route to find where edge is leaking.
//
// USAGE (run where DATABASE_URL is set — e.g. a Railway one-off):
//   node analyze-trades.js
//       → analyzes all trades from 2026-06-10 onward (post-fix era)
//   node analyze-trades.js --from 2026-06-10 --to 2026-06-15
//       → analyzes a specific window
//   ANALYZE_FROM=2026-06-10 node analyze-trades.js
//       → same via env var (Railway-friendly)
// =============================================================================

import { pool, initDb } from "./db.js";

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const FROM = getArg("from") || process.env.ANALYZE_FROM || "2026-06-10";
const TO   = getArg("to")   || process.env.ANALYZE_TO   || null;

function summarize(rows) {
  const n = rows.length;
  if (n === 0) return null;
  let wins = 0, grossWin = 0, grossLoss = 0, sum = 0;
  for (const r of rows) {
    const pnl = parseFloat(r.pnl) || 0;
    sum += pnl;
    if (pnl > 0) { wins++; grossWin += pnl; }
    else { grossLoss += Math.abs(pnl); }
  }
  return {
    n,
    wr:  (wins / n * 100).toFixed(1) + "%",
    pf:  grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞",
    ev:  "$" + (sum / n).toFixed(2),
    sum: "$" + sum.toFixed(2)
  };
}

function fmtRow(label, s) {
  if (!s) return `  ${label.padEnd(28)} n=0`;
  return `  ${label.padEnd(28)} n=${String(s.n).padStart(3)}  WR=${s.wr.padStart(6)}  PF=${s.pf.padStart(5)}  EV=${s.ev.padStart(8)}  sum=${s.sum.padStart(10)}`;
}

function groupBy(rows, key) {
  const groups = {};
  for (const r of rows) {
    const v = r[key] || "unknown";
    (groups[v] ??= []).push(r);
  }
  return groups;
}

function section(title, groups) {
  console.log(`\n── ${title} ${"─".repeat(55 - title.length)}`);
  const sorted = Object.entries(groups).sort((a, b) => (b[1].length - a[1].length));
  for (const [label, rows] of sorted) {
    console.log(fmtRow(label, summarize(rows)));
  }
}

async function main() {
  await initDb();

  const params = [FROM];
  let dateClause = `closed_at >= $1::date`;
  if (TO) {
    params.push(TO);
    dateClause += ` AND closed_at < ($2::date + INTERVAL '1 day')`;
  }

  const { rows } = await pool.query(
    `SELECT pnl, setup_type, regime, approval_type, direction, reason,
            score, hold_hours, is_partial, closed_at, reasons, signal_set
     FROM trades
     WHERE ${dateClause}
     ORDER BY closed_at ASC`,
    params
  );

  const window = TO ? `${FROM} → ${TO}` : `${FROM} → now`;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`TRADE ANALYSIS  ${window}  (${rows.length} trades)`);
  console.log(`${"=".repeat(70)}`);

  if (rows.length === 0) {
    console.log("No trades in this window.");
    await pool.end();
    return;
  }

  // Overall
  const all = summarize(rows);
  console.log(`\nOVERALL: n=${all.n}  WR=${all.wr}  PF=${all.pf}  EV=${all.ev}  sum=${all.sum}`);

  // Full closes only (exclude partials — they distort WR since they always win)
  const fullCloses = rows.filter(r => !r.is_partial);
  const full = summarize(fullCloses);
  console.log(`FULL CLOSES: n=${full?.n}  WR=${full?.wr}  PF=${full?.pf}  EV=${full?.ev}  sum=${full?.sum}`);

  section("By Setup Type",    groupBy(rows, "setup_type"));
  section("By Regime",        groupBy(rows, "regime"));
  section("By Approval Route",groupBy(rows, "approval_type"));
  section("By Direction",     groupBy(rows, "direction"));

  // Exit reason breakdown (losses only)
  const losses = rows.filter(r => parseFloat(r.pnl) < 0);
  const byExitReason = groupBy(losses, "reason");
  console.log(`\n── Loss Exit Reasons ${"─".repeat(49)}`);
  const sorted = Object.entries(byExitReason).sort((a, b) => b[1].length - a[1].length);
  for (const [reason, rs] of sorted) {
    const total = rs.reduce((s, r) => s + parseFloat(r.pnl), 0);
    console.log(`  ${reason.padEnd(28)} n=${String(rs.length).padStart(3)}  sum=$${total.toFixed(2).padStart(9)}`);
  }

  // Score distribution
  const scored = rows.filter(r => r.score > 0);
  if (scored.length > 0) {
    const avgScore = scored.reduce((s, r) => s + parseFloat(r.score), 0) / scored.length;
    const winners = rows.filter(r => parseFloat(r.pnl) > 0);
    const losers  = rows.filter(r => parseFloat(r.pnl) < 0);
    const avgWinScore  = winners.length ? winners.reduce((s,r) => s + parseFloat(r.score||0), 0) / winners.length : 0;
    const avgLossScore = losers.length  ? losers.reduce((s,r)  => s + parseFloat(r.score||0), 0) / losers.length  : 0;
    console.log(`\n── Score Distribution ${"─".repeat(48)}`);
    console.log(`  Avg score (all):    ${avgScore.toFixed(2)}`);
    console.log(`  Avg score (winners):${avgWinScore.toFixed(2)}`);
    console.log(`  Avg score (losers): ${avgLossScore.toFixed(2)}`);
  }

  // ── By Signal (out-of-sample lift) ───────────────────────────────────────────
  // For each signal that fired, compare trades WHERE it was present vs absent.
  // lift = EV(present) − EV(absent): the signal's marginal contribution. Positive
  // lift = the signal earns its place; negative = it's noise (or worse) and a
  // candidate for deletion. These are live post-fix trades, so this is genuinely
  // out-of-sample evidence — unlike the in-sample backtest.
  const MIN_SAMPLE = Number(getArg("min") || process.env.ANALYZE_MIN_SIGNAL || 4);

  const sigsOf = (r) => {
    const a = Array.isArray(r.reasons) ? r.reasons : [];
    const b = Array.isArray(r.signal_set) ? r.signal_set : [];
    return [...new Set([...a, ...b])];
  };
  const evOf = (rs) => rs.length ? rs.reduce((s, r) => s + (parseFloat(r.pnl) || 0), 0) / rs.length : 0;

  const allSignals = new Set();
  for (const r of rows) for (const s of sigsOf(r)) allSignals.add(s);

  const signalRows = [];
  for (const sig of allSignals) {
    const withSig    = rows.filter(r => sigsOf(r).includes(sig));
    const withoutSig = rows.filter(r => !sigsOf(r).includes(sig));
    if (withSig.length < MIN_SAMPLE) continue;
    const s = summarize(withSig);
    const lift = evOf(withSig) - evOf(withoutSig);
    signalRows.push({ sig, s, lift });
  }
  // Best lift first → worst lift (kill-list) last.
  signalRows.sort((a, b) => b.lift - a.lift);

  console.log(`\n── By Signal — out-of-sample lift (n>=${MIN_SAMPLE}) ${"─".repeat(28)}`);
  console.log(`  ${"signal".padEnd(26)} n    WR      PF      EV         lift`);
  for (const { sig, s, lift } of signalRows) {
    const liftStr = (lift >= 0 ? "+" : "") + "$" + lift.toFixed(2);
    const flag = lift < 0 ? "  ⚠ delete?" : "";
    console.log(`  ${sig.padEnd(26)} ${String(s.n).padStart(3)}  ${s.wr.padStart(6)}  ${s.pf.padStart(5)}  ${s.ev.padStart(8)}  ${liftStr.padStart(9)}${flag}`);
  }
  console.log(`\n  ⚠ = negative lift (trades with this signal did WORSE than trades without it) — prune candidate.`);

  console.log(`\n${"=".repeat(70)}\n`);

  await pool.end();
}

main().catch(err => {
  console.error("analyze-trades failed:", err);
  process.exit(1);
});
