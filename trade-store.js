// =============================================================================
// TRADE STORE — Persistent trade history in a dedicated Postgres table
//
// Moves trades out of the monolithic state JSON blob into their own table.
// Keeps state.trades populated in-memory for backward compatibility — every
// module that reads state.trades continues to work unchanged.
//
// MIGRATION: On first load, any trades found in the old state blob are
// imported into the table, then stripped from the blob on next save.
// =============================================================================

import { initDb, pool } from "./db.js";

let tradesTableReady = false;

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
export async function initTradesTable() {
  if (tradesTableReady) return;
  await initDb();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id            SERIAL PRIMARY KEY,
      symbol        TEXT NOT NULL,
      direction     TEXT NOT NULL,
      entry_price   NUMERIC NOT NULL,
      exit_price    NUMERIC NOT NULL,
      size          NUMERIC NOT NULL,
      leverage      INTEGER,
      notional      NUMERIC,
      pnl           NUMERIC NOT NULL,
      pnl_pct       NUMERIC,
      reason        TEXT,
      setup_type    TEXT,
      approval_type TEXT,
      score         NUMERIC,
      risk_reward   NUMERIC,
      atr_val       NUMERIC,
      hold_hours    NUMERIC,
      is_partial    BOOLEAN DEFAULT FALSE,
      partial_pct   NUMERIC,
      was_liquidated BOOLEAN DEFAULT FALSE,
      regime        TEXT,
      opened_at     TIMESTAMPTZ,
      closed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reasons       JSONB,
      signal_set    JSONB,
      journal       TEXT,
      raw           JSONB NOT NULL
    )
  `);

  // Index for common queries
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol)
  `).catch(() => {});
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(closed_at DESC)
  `).catch(() => {});
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_trades_regime ON trades(regime)
  `).catch(() => {});

  tradesTableReady = true;
}

// -----------------------------------------------------------------------------
// Write a single trade
// -----------------------------------------------------------------------------
export async function insertTrade(trade) {
  await initTradesTable();

  const result = await pool.query(
    `INSERT INTO trades (
      symbol, direction, entry_price, exit_price, size, leverage, notional,
      pnl, pnl_pct, reason, setup_type, approval_type, score, risk_reward,
      atr_val, hold_hours, is_partial, partial_pct, was_liquidated, regime,
      opened_at, closed_at, reasons, signal_set, journal, raw
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
    ) RETURNING id`,
    [
      trade.symbol,
      trade.direction,
      trade.entryPrice,
      trade.exitPrice,
      trade.size,
      trade.leverage || null,
      trade.notional || null,
      trade.pnl,
      trade.pnlPct || null,
      trade.reason || null,
      trade.setupType || "unknown",
      trade.approvalType || "unknown",
      trade.score || null,
      trade.riskReward || null,
      trade.atrVal || null,
      trade.holdHours || null,
      trade.isPartial || false,
      trade.partialPct || null,
      trade.wasLiquidated || false,
      trade.regime || "unknown",
      trade.openedAt || null,
      trade.closedAt || new Date().toISOString(),
      JSON.stringify(trade.reasons || []),
      JSON.stringify(trade.signalSet || []),
      trade.journal || null,
      JSON.stringify(trade)
    ]
  );

  return result.rows[0]?.id;
}

// -----------------------------------------------------------------------------
// Read trades
// -----------------------------------------------------------------------------

/**
 * Load the most recent N trades (for populating state.trades in-memory).
 */
export async function loadRecentTrades(limit = 500) {
  await initTradesTable();

  const result = await pool.query(
    `SELECT raw FROM trades ORDER BY closed_at DESC LIMIT $1`,
    [limit]
  );

  // Return in chronological order (oldest first, like state.trades)
  return result.rows.map(r => r.raw).reverse();
}

/**
 * Count total trades in the database.
 */
export async function countTrades() {
  await initTradesTable();
  const result = await pool.query(`SELECT COUNT(*) AS count FROM trades`);
  return parseInt(result.rows[0].count);
}

/**
 * Load trades for a specific symbol (for coin history).
 */
export async function loadTradesBySymbol(symbol, limit = 20) {
  await initTradesTable();

  const result = await pool.query(
    `SELECT raw FROM trades WHERE symbol = $1 ORDER BY closed_at DESC LIMIT $2`,
    [symbol, limit]
  );

  return result.rows.map(r => r.raw).reverse();
}

/**
 * Load trades closed today (UTC) for daily loss limit checks.
 */
export async function loadTodayTrades() {
  await initTradesTable();

  const result = await pool.query(
    `SELECT raw FROM trades 
     WHERE closed_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
     ORDER BY closed_at ASC`
  );

  return result.rows.map(r => r.raw);
}

/**
 * Load trades closed within a time window.
 */
export async function loadTradesSince(sinceMs) {
  await initTradesTable();

  const since = new Date(Date.now() - sinceMs).toISOString();
  const result = await pool.query(
    `SELECT raw FROM trades WHERE closed_at >= $1 ORDER BY closed_at ASC`,
    [since]
  );

  return result.rows.map(r => r.raw);
}

// -----------------------------------------------------------------------------
// Migration: import trades from old state blob
// -----------------------------------------------------------------------------
export async function migrateTradesFromState(stateTrades) {
  if (!stateTrades || stateTrades.length === 0) return 0;
  await initTradesTable();

  // Check if we already have trades to avoid double-import
  const existing = await countTrades();
  if (existing > 0) {
    console.log(`[TRADE-STORE] Skipping migration: ${existing} trades already in table`);
    return 0;
  }

  console.log(`[TRADE-STORE] Migrating ${stateTrades.length} trades from state blob...`);
  let imported = 0;

  for (const trade of stateTrades) {
    try {
      await insertTrade(trade);
      imported++;
    } catch (err) {
      console.error(`[TRADE-STORE] Failed to import trade:`, err.message);
    }
  }

  console.log(`[TRADE-STORE] Migrated ${imported}/${stateTrades.length} trades`);
  return imported;
}

// -----------------------------------------------------------------------------
// Coin History from trades table
// -----------------------------------------------------------------------------

/**
 * Build coin history from the trades table instead of the state blob.
 * Returns the same format as state.coinHistory[symbol].
 */
export async function loadCoinHistory(symbol, limit = 10) {
  await initTradesTable();

  const result = await pool.query(
    `SELECT direction, pnl, pnl_pct, regime, reasons, reason, closed_at,
            setup_type, hold_hours, score, journal
     FROM trades 
     WHERE symbol = $1 
     ORDER BY closed_at DESC 
     LIMIT $2`,
    [symbol, limit]
  );

  return result.rows.map(r => ({
    direction: r.direction,
    pnl: parseFloat(r.pnl),
    pnlPct: parseFloat(r.pnl_pct || 0),
    regime: r.regime || "unknown",
    reasons: r.reasons || [],
    date: r.closed_at ? new Date(r.closed_at).toISOString().split("T")[0] : "",
    result: parseFloat(r.pnl) > 0 ? "win" : "loss",
    exitReason: r.reason,
    setupType: r.setup_type,
    holdHours: parseFloat(r.hold_hours || 0),
    score: parseFloat(r.score || 0),
    journal: r.journal,
    h4Trend: "unknown"
  })).reverse();
}

/**
 * Load full coin history map for all recently traded symbols.
 */
export async function loadAllCoinHistory(activeSymbols = [], limit = 10) {
  await initTradesTable();

  const result = await pool.query(
    `SELECT DISTINCT symbol FROM trades 
     WHERE closed_at >= NOW() - INTERVAL '30 days'
     ORDER BY symbol`
  );

  const allSymbols = [...new Set([
    ...activeSymbols,
    ...result.rows.map(r => r.symbol)
  ])];

  const history = {};
  for (const symbol of allSymbols) {
    const entries = await loadCoinHistory(symbol, limit);
    if (entries.length > 0) {
      history[symbol] = entries;
    }
  }

  return history;
}
