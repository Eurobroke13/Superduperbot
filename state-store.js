import { initDb, pool, withTransaction } from "./db.js";
import {
  initTradesTable,
  insertTrade,
  insertTradeWithClient,
  loadRecentTrades,
  migrateTradesFromState
} from "./trade-store.js";
import {
  initDecisionLogTable,
  insertDecisionLog,
  loadRecentDecisionLogs,
  migrateDecisionLogFromState
} from "./history-store.js";
import {
  stampStateChecksum,
  validateState
} from "./bot/reconciliation.js";

export { insertDecisionLog, insertTrade };

const STATE_KEY = "bot_state_v1";

function defaultState() {
  return {
    cash: 10000,
    positions: {},
    pendingLimits: {},
    decayingLimits: {},
    pendingRetests: {},
    cooldowns: {},
    paperTrades: [],
    trades: [],
    lastRegime: null,
    hmmParams: null,
    markovChain: null,
    peakValue: 10000,
    circuitBreakerActive: false,
    startedAt: new Date().toISOString(),
    lastPhase: 0,
    lastHeadlineIds: null,
    newsBlocked: [],
    newsBoosted: [],
    newsHeadlines: [],
    newsNeedsClaude: false,
    decisionLog: [],
    tokenUsage: null,
    signalStats: {},
    disabledSignals: [],
    dynamicWeights: {},
    lastWeightUpdate: 0,
    coinHistory: {},
    dailyBias: null,
    weeklyReviews: [],
    lunarCache: null,
    lastPeriodicReportAt: null,
    lastRunAt: null,
    runCount: 0,
    regimeStats: {
      bull: { wins: 0, losses: 0, totalPnl: 0, count: 0 },
      bear: { wins: 0, losses: 0, totalPnl: 0, count: 0 },
      sideways: { wins: 0, losses: 0, totalPnl: 0, count: 0 }
    }
  };
}

export async function loadState() {
  await initDb();
  await initTradesTable();
  await initDecisionLogTable();

  const result = await pool.query(
    "SELECT state FROM bot_state WHERE state_key = $1",
    [STATE_KEY]
  );

  if (result.rows.length === 0) {
    const state = defaultState();
    await saveState(state);
    return state;
  }

  const state = {
    ...defaultState(),
    ...result.rows[0].state
  };

  if (state.trades && state.trades.length > 0) {
    const migrated = await migrateTradesFromState(state.trades);
    if (migrated > 0) {
      console.log(`[STATE] Migrated ${migrated} trades to trades table`);
    }
  }

  if (state.decisionLog && state.decisionLog.length > 0) {
    const migrated = await migrateDecisionLogFromState(state.decisionLog);
    if (migrated > 0) {
      console.log(`[STATE] Migrated ${migrated} decision log entries to decision_log table`);
    }
  }

  state.trades = await loadRecentTrades(500);
  state.decisionLog = await loadRecentDecisionLogs(150);
  if (!state.cooldowns) state.cooldowns = {};
  if (!state.decayingLimits) state.decayingLimits = {};

  const reconciliation = validateState(state);
  if (reconciliation.warnings.length > 0) {
    console.warn(`[STATE] Reconciliation warnings: ${reconciliation.warnings.join(" | ")}`);
  }
  if (reconciliation.fixed.length > 0) {
    console.warn(`[STATE] Reconciliation fixed: ${reconciliation.fixed.join(" | ")}`);
  }

  return state;
}

const UPSERT_STATE_SQL = `
  INSERT INTO bot_state (state_key, state, updated_at)
  VALUES ($1, $2::jsonb, NOW())
  ON CONFLICT (state_key)
  DO UPDATE SET
    state = EXCLUDED.state,
    updated_at = NOW()
`;

/**
 * Persist the state blob. Any trades buffered on `state._pendingTrades`
 * (closed this run) are written together with the blob in a SINGLE
 * transaction, so a crash can never leave a trade recorded while the
 * position is still "open" in the blob (no phantom positions / double-count).
 *
 * The buffer is cleared only after a successful COMMIT; if the transaction
 * fails the trades remain buffered and the blob is left unchanged.
 *
 * @param {object} state
 * @param {object} [deps] - injectable db layer for testing
 */
export async function saveState(state, deps = {}) {
  const {
    query = (text, values) => pool.query(text, values),
    runTransaction = withTransaction,
    insertTradeTx = insertTradeWithClient,
    ensureSchema = async () => { await initDb(); await initTradesTable(); }
  } = deps;

  await ensureSchema();
  stampStateChecksum(state);

  const pending = Array.isArray(state._pendingTrades) ? state._pendingTrades : [];

  const stateForBlob = { ...state };
  delete stateForBlob.trades;
  delete stateForBlob.decisionLog;
  delete stateForBlob._pendingTrades;
  delete stateForBlob._volumeMap;

  const blobValues = [STATE_KEY, JSON.stringify(stateForBlob)];

  if (pending.length === 0) {
    await query(UPSERT_STATE_SQL, blobValues);
    return state;
  }

  await runTransaction(async (client) => {
    for (const trade of pending) {
      await insertTradeTx(client, trade);
    }
    await client.query(UPSERT_STATE_SQL, blobValues);
  });

  // Only clear after a successful commit.
  state._pendingTrades = [];
  return state;
}
