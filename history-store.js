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
