import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Bound every DB wait so a saturated/unreachable Postgres fails loudly
  // instead of parking the process forever (no-timeout awaits are what
  // wedged the fast-scan cron on 2026-07-02):
  connectionTimeoutMillis: 15_000, // pool.connect() — was infinite
  idleTimeoutMillis: 30_000,       // recycle idle clients
  statement_timeout: 60_000,       // server-side cap; saveState's full-blob write stays well under this
  keepAlive: true                  // detect silently-dropped TCP connections
});

let initialized = false;

export async function initDb() {
  if (initialized) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      state_key TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  initialized = true;
}

export async function closeDb() {
  initialized = false;
  await pool.end();
}

/**
 * Run `fn(client)` inside a single transaction. Commits on success,
 * rolls back on any error, and always releases the client.
 * Used to persist trades + the state blob atomically (no phantom positions).
 */
export async function withTransaction(fn) {
  await initDb();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore rollback failure */ }
    throw err;
  } finally {
    client.release();
  }
}

// Shared advisory lock key — same value across all Railway services.
const BOT_LOCK_KEY = 98765432;

/**
 * Acquire a Postgres session-level advisory lock before running fn().
 * If another bot instance (main server or fast-scan runner) already holds
 * the lock, this run is skipped immediately rather than running in parallel.
 * Lock is released in the finally block on the same client.
 */
export async function withBotLock(fn) {
  await initDb();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [BOT_LOCK_KEY]
    );
    if (!rows[0].acquired) {
      console.log("[LOCK] Another bot run is active — skipping this run");
      return { skipped: true, reason: "lock-held" };
    }
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [BOT_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export { pool };
