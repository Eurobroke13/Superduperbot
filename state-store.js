import { initDb, pool } from "./db.js";
import {
  initTradesTable,
  insertTrade,
  loadRecentTrades,
  migrateTradesFromState
} from "./trade-store.js";

export { insertTrade };

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

  state.trades = await loadRecentTrades(500);
  if (!state.cooldowns) state.cooldowns = {};
  if (!state.decayingLimits) state.decayingLimits = {};

  return state;
}

export async function saveState(state) {
  await initDb();

  const stateForBlob = { ...state };
  delete stateForBlob.trades;

  await pool.query(
    `
      INSERT INTO bot_state (state_key, state, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (state_key)
      DO UPDATE SET
        state = EXCLUDED.state,
        updated_at = NOW()
    `,
    [STATE_KEY, JSON.stringify(stateForBlob)]
  );

  return state;
}
