import { initDb, pool } from "./db.js";

let decisionLogTableReady = false;

export async function initDecisionLogTable() {
  if (decisionLogTableReady) return;
  await initDb();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS decision_log (
      id            SERIAL PRIMARY KEY,
      ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      symbol        TEXT,
      regime        TEXT,
      setup_type    TEXT,
      signal        TEXT,
      score         NUMERIC,
      outcome       TEXT,
      skip_reason   TEXT,
      approval_type TEXT,
      raw           JSONB NOT NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_decision_log_ts ON decision_log(ts DESC)
  `).catch(() => {});
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_decision_log_symbol_ts ON decision_log(symbol, ts DESC)
  `).catch(() => {});
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_decision_log_outcome ON decision_log(outcome)
  `).catch(() => {});
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_decision_log_skip_reason ON decision_log(skip_reason)
  `).catch(() => {});

  decisionLogTableReady = true;

  await pruneDecisionLog();
}

// ---------------------------------------------------------------------------
// Retention.
//
// This table had NO retention policy and grew unbounded: 356,783 rows / 318 MB
// between 2026-04-30 and 2026-09-01 (~2,800 rows/day at ~0.9 kB each). It
// filled the 500 MB Postgres volume, which left crash recovery with zero free
// disk, which meant Postgres could never finish starting — every bot cycle died
// on "the database system is in recovery mode" (2026-09-01).
//
// Nothing reads beyond `loadRecentDecisionLogs(150)`, so the rest was pure
// dead weight. Keep a short diagnostic window and drop the rest.
// ---------------------------------------------------------------------------

const RETENTION_DAYS = Number(process.env.DECISION_LOG_RETENTION_DAYS || 7);

// Backstop: if `ts` is ever null/garbage the date filter can't catch the row,
// so also enforce a hard ceiling on total rows.
const MAX_ROWS = Number(process.env.DECISION_LOG_MAX_ROWS || 50_000);

// Delete in chunks so a large backlog can't hold a long transaction or spike
// WAL on a volume that may already be tight.
const DELETE_BATCH = 5_000;

/**
 * Drop decision_log rows older than the retention window, then enforce the
 * row ceiling. Cheap in steady state (uses idx_decision_log_ts, deletes a few
 * thousand rows per day), so it's safe to run once per process on init.
 * Never throws: losing a prune must not take down a bot run.
 */
export async function pruneDecisionLog() {
  try {
    let deletedByAge = 0;
    for (;;) {
      const { rowCount } = await pool.query(
        `DELETE FROM decision_log
          WHERE id IN (
            SELECT id FROM decision_log
             WHERE ts < NOW() - ($1 || ' days')::INTERVAL
             LIMIT $2
          )`,
        [RETENTION_DAYS, DELETE_BATCH]
      );
      deletedByAge += rowCount;
      if (rowCount < DELETE_BATCH) break;
    }

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM decision_log`);
    let deletedByCap = 0;
    if (rows[0].count > MAX_ROWS) {
      const { rowCount } = await pool.query(
        `DELETE FROM decision_log
          WHERE id IN (
            SELECT id FROM decision_log ORDER BY ts DESC OFFSET $1
          )`,
        [MAX_ROWS]
      );
      deletedByCap = rowCount;
    }

    const total = deletedByAge + deletedByCap;
    if (total > 0) {
      console.log(
        `[HISTORY-STORE] Pruned ${total} decision_log rows ` +
        `(${deletedByAge} older than ${RETENTION_DAYS}d, ${deletedByCap} over the ${MAX_ROWS}-row cap)`
      );
    }
    return total;
  } catch (err) {
    console.warn(`[HISTORY-STORE] decision_log prune skipped: ${err.message}`);
    return 0;
  }
}

export async function insertDecisionLog(entry) {
  await initDecisionLogTable();

  const ts = entry.timestamp || entry.ts || new Date().toISOString();
  const result = await pool.query(
    `INSERT INTO decision_log (
      ts, symbol, regime, setup_type, signal, score, outcome,
      skip_reason, approval_type, raw
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
    ) RETURNING id`,
    [
      ts,
      entry.symbol || null,
      entry.regime || null,
      entry.setupType || entry.setup_type || null,
      entry.signal || null,
      Number.isFinite(entry.score) ? entry.score : null,
      entry.outcome || null,
      entry.skipReason || entry.skip_reason || null,
      entry.approvalType || entry.approval_type || null,
      JSON.stringify(entry)
    ]
  );

  return result.rows[0]?.id;
}

export async function loadRecentDecisionLogs(limit = 150) {
  await initDecisionLogTable();

  const result = await pool.query(
    `SELECT raw FROM decision_log ORDER BY ts DESC LIMIT $1`,
    [limit]
  );

  return result.rows.map(r => r.raw).reverse();
}

export async function countDecisionLogs() {
  await initDecisionLogTable();
  const result = await pool.query(`SELECT COUNT(*) AS count FROM decision_log`);
  return parseInt(result.rows[0].count, 10);
}

export async function migrateDecisionLogFromState(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  await initDecisionLogTable();

  const existing = await countDecisionLogs();
  if (existing > 0) {
    console.log(`[HISTORY-STORE] Skipping decision_log migration: ${existing} rows already exist`);
    return 0;
  }

  console.log(`[HISTORY-STORE] Migrating ${entries.length} decision log entries from state blob...`);
  let imported = 0;

  for (const entry of entries) {
    try {
      await insertDecisionLog(entry);
      imported++;
    } catch (err) {
      console.error("[HISTORY-STORE] Failed to import decision log entry:", err.message);
    }
  }

  console.log(`[HISTORY-STORE] Migrated ${imported}/${entries.length} decision log entries`);
  return imported;
}
