import assert from "node:assert/strict";
import test from "node:test";

import {
  checkDailyLossLimit,
  checkMinRR,
  getWeightRegimeAware
} from "../bot/risk-gates.js";

const WEIGHTS = {
  "ema-ribbon-bull": 1.5,
  "ema-ribbon-bear": 0.5,
  "volume": 1.2
};

test("checkMinRR blocks only below the minimum", () => {
  assert.equal(checkMinRR({ riskReward: 0.5 }).allowed, false);
  assert.equal(checkMinRR({ riskReward: 0.8 }).allowed, true);
  assert.equal(checkMinRR({ riskReward: 2.0 }).allowed, true);
});

test("checkDailyLossLimit halts when today's realized losses exceed 3 percent", () => {
  const state = { cash: 10000, positions: {}, trades: [] };
  const todayTrades = [
    { pnl: -150, closedAt: new Date().toISOString() },
    { pnl: -160, closedAt: new Date().toISOString() },
    { pnl: 200, closedAt: new Date().toISOString() }
  ];
  const result = checkDailyLossLimit(state, todayTrades);
  assert.equal(result.allowed, false);
  assert.ok(result.dailyLoss >= 300);
});

test("getWeightRegimeAware equalizes paired sideways weights", () => {
  const state = { dynamicWeights: {} };
  assert.equal(getWeightRegimeAware("ema-ribbon-bull", state, "sideways", WEIGHTS), 1.0);
  assert.equal(getWeightRegimeAware("ema-ribbon-bear", state, "sideways", WEIGHTS), 1.0);
  assert.equal(getWeightRegimeAware("ema-ribbon-bull", state, "bull", WEIGHTS), 1.5);
  assert.equal(getWeightRegimeAware("volume", state, "sideways", WEIGHTS), 1.2);
});
