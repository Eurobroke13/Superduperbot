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

// ---------------------------------------------------------------------------
// Transient-failure handling.
//
// Railway's Postgres restarts (plan maintenance, OOM, crash recovery). When it
// does, two things happen and BOTH used to take the bot down:
//
//   1. Every idle socket in this pool dies. node-postgres emits 'error' on the
//      Pool — and with NO listener attached, Node treats it as an unhandled
//      'error' event and kills the process. That is an instant, uncatchable
//      crash of the always-on server; try/catch around queries does not help.
//   2. New connections are refused with 57P03 "the database system is in
//      recovery mode" for the ~10-60s the server spends replaying WAL. With no
//      retry, one blip = the whole run lost (and, on the cron runner, a
//      "deployment crashed" alert).
// ---------------------------------------------------------------------------

// Postgres SQLSTATEs that mean "try again shortly", not "your query is wrong".
const TRANSIENT_SQLSTATES = new Set([
  "57P01", // admin_shutdown — server terminated the connection
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now — "the database system is in recovery mode"
  "53300", // too_many_connections
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006"  // connection_failure
]);

const TRANSIENT_SYSCALL_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"
]);

const TRANSIENT_MESSAGE_RE =
  /recovery mode|is starting up|shutting down|terminating connection|connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error/i;

export function isTransientDbError(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_SQLSTATES.has(err.code)) return true;
  if (err.code && TRANSIENT_SYSCALL_CODES.has(err.code)) return true;
  return TRANSIENT_MESSAGE_RE.test(err.message || "");
}

// CRITICAL: without this listener Node crashes the whole process the moment an
// idle pooled client errors out. Do not remove.
pool.on("error", (err) => {
  console.error(
    `[DB] idle client error (${err.code || "no-code"}): ${err.message} — dropping it, pool will reconnect`
  );
  // The CREATE TABLE we cached may have been rolled back by crash recovery.
  initialized = false;
});

const DB_RETRY_ATTEMPTS = Number(process.env.DB_RETRY_ATTEMPTS || 6);
const DB_RETRY_BASE_MS = Number(process.env.DB_RETRY_BASE_MS || 1500);
const DB_RETRY_MAX_MS = Number(process.env.DB_RETRY_MAX_MS || 15_000);

/**
 * Run fn(), retrying with exponential backoff on transient Postgres failures.
 * Non-transient errors (bad SQL, constraint violations) rethrow immediately —
 * this must never paper over a real bug.
 * Defaults give ~37s of total patience, which covers a normal Railway PG
 * restart and stays well inside the 10-min task watchdog.
 */
export async function withDbRetry(fn, label = "query") {
  let lastErr;
  for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt === DB_RETRY_ATTEMPTS) throw err;
      initialized = false; // re-run schema init against the recovered server
      const wait =
        Math.min(DB_RETRY_BASE_MS * 2 ** (attempt - 1), DB_RETRY_MAX_MS) +
        Math.floor(Math.random() * 250);
      console.warn(
        `[DB] transient failure on ${label} (${err.code || "no-code"}: ${err.message}) — ` +
        `attempt ${attempt}/${DB_RETRY_ATTEMPTS}, retrying in ${wait}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastErr;
}

/** Check out a client, retrying while Postgres is still coming back up. */
async function connectWithRetry(label) {
  return withDbRetry(() => pool.connect(), `${label}:connect`);
}

export async function initDb() {
  if (initialized) return;

  await withDbRetry(
    () => pool.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        state_key TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `),
    "initDb"
  );

  initialized = true;
}

/**
 * Real liveness probe for /health. initDb() short-circuits on `initialized`,
 * so after the first successful call it stopped touching Postgres at all and
 * reported "connected" for a database that was long dead.
 */
export async function pingDb() {
  await pool.query("SELECT 1");
  return true;
}

/**
 * pool.end() waits for every checked-out client to be released. If a client is
 * wedged on a dead socket that wait never resolves — which is why a failed
 * fast-scan sat in "Stopping Container" limbo for 3+ minutes instead of exiting
 * immediately (2026-09-01). Bound it.
 */
export async function closeDb(timeoutMs = 5000) {
  initialized = false;
  let timer;
  try {
    await Promise.race([
      pool.end(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[DB] pool.end() did not settle in ${timeoutMs}ms — abandoning it`);
          resolve();
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `fn(client)` inside a single transaction. Commits on success,
 * rolls back on any error, and always releases the client.
 * Used to persist trades + the state blob atomically (no phantom positions).
 */
export async function withTransaction(fn) {
  await initDb();
  // Retry only the connect. The transaction body itself is NOT retried: the
  // trade inserts are not idempotent, and a lost COMMIT ack would double-count.
  // On failure the caller keeps `_pendingTrades` buffered for the next run.
  const client = await connectWithRetry("withTransaction");
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
  const client = await connectWithRetry("withBotLock");
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
      // If the run died because Postgres went away, this unlock throws too —
      // and being in a finally, it would REPLACE the real error with a useless
      // "connection terminated". Swallow it: the lock is session-scoped, so
      // Postgres drops it when this connection closes anyway.
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [BOT_LOCK_KEY]);
      } catch (err) {
        console.warn(`[LOCK] unlock failed (session drop will release it): ${err.message}`);
      }
    }
  } finally {
    client.release();
  }
}

export { pool };
