// =============================================================================
// PRUNE TRADES — Surgically delete a contaminated window from the trades table
//
// Why: windowed stats (signalStats / dynamicWeights, last-80; drift, last-100)
// are RECOMPUTED from the trades table every run, so seeding can't clear them —
// the contamination regrows from the bad rows. Deleting the bad rows lets the
// next recompute build clean stats on its own.
//
// SAFETY: dry-run by default. Nothing is deleted unless you pass BOTH a date
// range (--from / --to) AND --apply. A delete runs inside a transaction.
//
// USAGE (run where DATABASE_URL is set — e.g. a Railway one-off service):
//   node prune-trades.js
//       → per-day breakdown of the last 60 days so you can spot the bad window
//   node prune-trades.js --from 2026-05-10 --to 2026-05-31
//       → dry run: aggregate stats for exactly the rows that WOULD be deleted
//   node prune-trades.js --from 2026-05-10 --to 2026-05-31 --apply
//       → actually delete that window (transactional)
//
// Dates are inclusive and interpreted as UTC days. --to 2026-05-31 covers all
// of the 31st (up to 2026-06-01 00:00 UTC).
// =============================================================================

import { pool, initDb } from "./db.js";

// ── arg parsing ──────────────────────────────────────────────────────────────
function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const FROM = getArg("from");
const TO = getArg("to");
const APPLY = process.argv.includes("--apply");

// ── stats helpers ────────────────────────────────────────────────────────────
function summarize(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: 0, pf: 0, ev: 0, sum: 0, grossWin: 0, grossLoss: 0 };
  let wins = 0, grossWin = 0, grossLoss = 0, sum = 0;
  for (const r of rows) {
    const pnl = parseFloat(r.pnl) || 0;
    sum += pnl;
    if (pnl > 0) { wins++; grossWin += pnl; }
    else { grossLoss += Math.abs(pnl); }
  }
  return {
    n,
    wr: wins / n,
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    ev: sum / n,
    sum,
    grossWin,
    grossLoss
  };
}

function fmt(s) {
  return `n=${s.n}  WR=${(s.wr * 100).toFixed(1)}%  PF=${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}  EV=$${s.ev.toFixed(2)}  sumPnL=$${s.sum.toFixed(2)}`;
}

// ── modes ────────────────────────────────────────────────────────────────────
async function perDayBreakdown() {
  // No range given → show daily stats for the last 60 days to locate the window.
  const { rows } = await pool.query(`
    SELECT pnl, closed_at FROM trades
    WHERE closed_at >= NOW() - INTERVAL '60 days'
    ORDER BY closed_at ASC
  `);

  const byDay = {};
  for (const r of rows) {
    const day = new Date(r.closed_at).toISOString().slice(0, 10);
    (byDay[day] ??= []).push(r);
  }

  console.log(`\nPer-day breakdown (last 60 days, ${rows.length} trades):`);
  console.log("date         " + "count  WR      PF     EV       sumPnL");
  console.log("-".repeat(64));
  for (const day of Object.keys(byDay).sort()) {
    const s = summarize(byDay[day]);
    const flag = (s.wr < 0.35 || s.pf < 1.0) ? "  ⚠" : "";
    console.log(
      `${day}   ${String(s.n).padStart(4)}  ${(s.wr * 100).toFixed(0).padStart(3)}%  ${(s.pf === Infinity ? "∞" : s.pf.toFixed(2)).padStart(5)}  $${s.ev.toFixed(2).padStart(6)}  $${s.sum.toFixed(2).padStart(8)}${flag}`
    );
  }
  console.log("-".repeat(64));
  console.log(`Overall: ${fmt(summarize(rows))}`);
  console.log(`\n⚠ marks days with WR<35% or PF<1.0 — candidate contamination.`);
  console.log(`Pick a window, then dry-run it:\n  node prune-trades.js --from <YYYY-MM-DD> --to <YYYY-MM-DD>\n`);
}

async function rangeDryRun() {
  const { rows: target } = await pool.query(
    `SELECT pnl, closed_at FROM trades
     WHERE closed_at >= $1::date AND closed_at < ($2::date + INTERVAL '1 day')
     ORDER BY closed_at ASC`,
    [FROM, TO]
  );
  const { rows: all } = await pool.query(`SELECT pnl FROM trades`);
  const remaining = await pool.query(
    `SELECT pnl FROM trades
     WHERE NOT (closed_at >= $1::date AND closed_at < ($2::date + INTERVAL '1 day'))`,
    [FROM, TO]
  );

  console.log(`\nWindow to delete: ${FROM} .. ${TO} (inclusive, UTC)`);
  console.log(`  TO DELETE : ${fmt(summarize(target))}`);
  console.log(`  BEFORE    : ${fmt(summarize(all))}   (whole table)`);
  console.log(`  AFTER     : ${fmt(summarize(remaining.rows))}   (what remains)`);

  if (target.length === 0) {
    console.log(`\nNothing matches that window — check the dates.\n`);
    return;
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing deleted. Re-run with --apply to delete these ${target.length} trades.\n`);
    return;
  }

  // ── actual delete (transactional) ──
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `DELETE FROM trades
       WHERE closed_at >= $1::date AND closed_at < ($2::date + INTERVAL '1 day')`,
      [FROM, TO]
    );
    await client.query("COMMIT");
    console.log(`\n✓ Deleted ${res.rowCount} trades from ${FROM}..${TO}.`);
    console.log(`Next bot run will reload state.trades clean and recompute windowed stats.\n`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`\n✗ Delete failed, rolled back:`, err.message, "\n");
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

// ── entry ────────────────────────────────────────────────────────────────────
async function main() {
  // db.js throws at import if DATABASE_URL is unset, so by here we have a DB.
  await initDb();

  if (APPLY && (!FROM || !TO)) {
    console.error("Refusing to --apply without an explicit --from and --to range.");
    process.exit(1);
  }

  if (FROM && TO) {
    await rangeDryRun();
  } else {
    await perDayBreakdown();
  }
  await pool.end();
}

main().catch(err => {
  console.error("prune-trades failed:", err);
  process.exit(1);
});
