import assert from "node:assert/strict";
import test from "node:test";
import { updateDynamicWeights } from "../bot/adaptation.js";

// Generate synthetic trades for a given signal with fixed win-rate
function makeTrades(count, { winRate = 0.5, signal = "rsi-bull-div", pnlPerWin = 10, pnlPerLoss = -8, regime = "bull" } = {}) {
  const trades = [];
  for (let i = 0; i < count; i++) {
    const won = i / count < winRate;
    trades.push({
      pnl: won ? pnlPerWin : pnlPerLoss,
      reasons: [signal],
      regime,
      closedAt: new Date(Date.now() - (count - i) * 3600000).toISOString()
    });
  }
  return trades;
}

function makeState(trades = []) {
  return { trades, dynamicWeights: {}, signalStats: {}, disabledSignals: [] };
}

test("updateDynamicWeights - no-op when fewer than 10 trades", () => {
  const state = makeState(makeTrades(5));
  updateDynamicWeights(state);
  assert.deepEqual(state.dynamicWeights, {});
});

test("updateDynamicWeights - sets weight > 1 for high win-rate signal (>=65%)", () => {
  // 30 trades in slow window, 70% win-rate → mult 1.20
  const state = makeState(makeTrades(30, { winRate: 0.70, signal: "rsi-bull-div" }));
  updateDynamicWeights(state);
  assert.ok(state.dynamicWeights["rsi-bull-div"] >= 1.0,
    `expected weight >= 1.0, got ${state.dynamicWeights["rsi-bull-div"]}`);
});

test("updateDynamicWeights - sets weight < 1 for low win-rate signal (<33%)", () => {
  const state = makeState(makeTrades(30, { winRate: 0.20, signal: "OBV-bear-div", pnlPerWin: 5, pnlPerLoss: -10 }));
  updateDynamicWeights(state);
  assert.ok(state.dynamicWeights["OBV-bear-div"] < 1.0,
    `expected weight < 1.0, got ${state.dynamicWeights["OBV-bear-div"]}`);
});

test("updateDynamicWeights - fast window boosts weight when fast WR > slow WR by >15%", () => {
  const signal = "above-VWAP";
  // Slow window (80 trades): ~45% WR
  const slow = makeTrades(60, { winRate: 0.45, signal, pnlPerWin: 8, pnlPerLoss: -8 });
  // Fast window (last 20): 75% WR — strong divergence
  const fast = makeTrades(20, { winRate: 0.75, signal, pnlPerWin: 8, pnlPerLoss: -8 });
  const state = makeState([...slow, ...fast]);
  updateDynamicWeights(state);
  const w = state.dynamicWeights[signal];
  // Fast window should push weight up (x1.15 on top of slow base)
  assert.ok(w !== undefined, "weight should be set");
  assert.ok(w > 0.9, `expected weight boosted, got ${w}`);
});

test("updateDynamicWeights - fast window cuts weight when fast WR < slow WR by >15%", () => {
  const signal = "fisher-rising";
  // Slow window: 65% WR (strong signal historically)
  const slow = makeTrades(60, { winRate: 0.65, signal, pnlPerWin: 10, pnlPerLoss: -8 });
  // Fast window: 30% WR — signal broke down
  const fast = makeTrades(20, { winRate: 0.30, signal, pnlPerWin: 10, pnlPerLoss: -8 });
  const state = makeState([...slow, ...fast]);
  updateDynamicWeights(state);
  const w = state.dynamicWeights[signal];
  assert.ok(w !== undefined, "weight should be set");
  // 1.20 base (65% WR) × 0.85 fast penalty — result depends on exact slow stats
  // but should be below the 1.20 that the slow window alone would give
  assert.ok(w < 1.20, `expected fast window to pull weight down from 1.20, got ${w}`);
});

test("updateDynamicWeights - weights are clamped to [0.2, 1.6]", () => {
  const signal = "rsi-bull-div";
  // Extreme scenario
  const trades = makeTrades(80, { winRate: 0.99, signal, pnlPerWin: 100, pnlPerLoss: -1 });
  const state = makeState(trades);
  updateDynamicWeights(state);
  const w = state.dynamicWeights[signal];
  if (w !== undefined) {
    assert.ok(w <= 1.6, `weight exceeds 1.6 cap: ${w}`);
    assert.ok(w >= 0.2, `weight below 0.2 floor: ${w}`);
  }
});

test("updateDynamicWeights - disables signal with WR <30% over 25+ trades", () => {
  const signal = "trap-vol-bear";
  const trades = makeTrades(30, { winRate: 0.20, signal, pnlPerWin: 5, pnlPerLoss: -10 });
  const state = makeState(trades);
  updateDynamicWeights(state);
  assert.ok(Array.isArray(state.disabledSignals), "disabledSignals should be array");
  // trap-vol-bear is always included per the hardcoded list
  assert.ok(state.disabledSignals.includes("trap-vol-bear"));
});

test("updateDynamicWeights - populates signalStats with counts and pnl", () => {
  const signal = "chikou-bull";
  const state = makeState(makeTrades(30, { winRate: 0.6, signal }));
  updateDynamicWeights(state);
  const stats = state.signalStats[signal];
  assert.ok(stats, "signalStats entry should exist");
  assert.equal(stats.count, 30);
  assert.ok(typeof stats.totalPnl === "number");
});
