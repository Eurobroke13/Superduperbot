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
            score, hold_hours, is_partial, closed_at
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

  console.log(`\n${"=".repeat(70)}\n`);

  await pool.end();
}

main().catch(err => {
  console.error("analyze-trades failed:", err);
  process.exit(1);
});
