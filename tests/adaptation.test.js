/**
 * Unit tests for bot/adaptation.js
 * updateDynamicWeights, updateRegimeStats, getAdaptiveThreshold,
 * getRegimePerformance — all pure state mutations.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  updateDynamicWeights,
  updateRegimeStats,
  getAdaptiveThreshold,
  getRegimePerformance
} from "../bot/adaptation.js";

// ── helpers ────────────────────────────────────────────────────────────────────

const trade = (pnl, reasons = ["ema-ribbon"], regime = "bull") =>
  ({ pnl, reasons, regime, closedAt: new Date().toISOString() });

function makeState(nTrades = 0, pnl = 10, reasons = ["ema-ribbon"], overrides = {}) {
  return {
    cash: 10000,
    positions: {},
    trades: Array.from({ length: nTrades }, () => trade(pnl, reasons)),
    lastRegime: { label: "bull" },
    signalStats: {},
    dynamicWeights: {},
    disabledSignals: [],
    ...overrides
  };
}

// ── updateDynamicWeights ───────────────────────────────────────────────────────

test("updateDynamicWeights - no-op when fewer than 10 trades", () => {
  const state = makeState(5);
  updateDynamicWeights(state);
  assert.deepEqual(state.dynamicWeights, {}); // unchanged
});

test("updateDynamicWeights - populates signalStats from trades", () => {
  const state = makeState(20, 10, ["ema-ribbon"]);
  updateDynamicWeights(state);
  assert.ok(state.signalStats["ema-ribbon"]);
  assert.equal(state.signalStats["ema-ribbon"].count, 20);
  assert.equal(state.signalStats["ema-ribbon"].wins, 20);
});

test("updateDynamicWeights - high WR signal gets weight > 1", () => {
  // 20 trades all winning with the same signal
  const state = makeState(20, 10, ["ema-ribbon"]);
  updateDynamicWeights(state);
  const w = state.dynamicWeights["ema-ribbon"];
  assert.ok(w !== undefined);
  assert.ok(w > 1.0, `expected weight > 1.0 for 100% WR signal, got ${w}`);
});

test("updateDynamicWeights - consistently losing signal gets weight < 1", () => {
  // 20 trades all losing
  const state = makeState(20, -10, ["bad-signal"]);
  updateDynamicWeights(state);
  const w = state.dynamicWeights["bad-signal"];
  assert.ok(w !== undefined);
  assert.ok(w < 1.0, `expected weight < 1.0 for 0% WR signal, got ${w}`);
});

test("updateDynamicWeights - disables signal with WR < 30% over 25+ trades", () => {
  const state = makeState(25, -5, ["terrible-signal"]);
  updateDynamicWeights(state);
  assert.ok(state.disabledSignals.includes("terrible-signal"));
});

test("updateDynamicWeights - does not disable signal with < 25 trades", () => {
  const state = makeState(20, -5, ["risky-signal"]);
  updateDynamicWeights(state);
  assert.ok(!state.disabledSignals.includes("risky-signal"));
});

test("updateDynamicWeights - sets lastWeightUpdate timestamp", () => {
  const state = makeState(15, 10);
  updateDynamicWeights(state);
  assert.ok(typeof state.lastWeightUpdate === "number");
  assert.ok(state.lastWeightUpdate > 0);
});

test("updateDynamicWeights - signal weight is clamped between 0.2 and 1.6", () => {
  const state = makeState(25, 100, ["super-signal"]);
  updateDynamicWeights(state);
  const w = state.dynamicWeights["super-signal"] ?? 1.0;
  assert.ok(w >= 0.2 && w <= 1.6, `weight ${w} outside [0.2, 1.6]`);
});

// ── updateRegimeStats ──────────────────────────────────────────────────────────

test("updateRegimeStats - initialises regimeStats if missing", () => {
  const state = { trades: [], lastRegime: { label: "bull" } };
  updateRegimeStats(state, { pnl: 10 });
  assert.ok(state.regimeStats);
  assert.ok(state.regimeStats.bull);
});

test("updateRegimeStats - increments win count on positive PnL", () => {
  const state = makeState(0);
  updateRegimeStats(state, { pnl: 15 });
  assert.equal(state.regimeStats.bull.wins, 1);
  assert.equal(state.regimeStats.bull.losses, 0);
  assert.equal(state.regimeStats.bull.count, 1);
});

test("updateRegimeStats - increments loss count on negative PnL", () => {
  const state = makeState(0);
  updateRegimeStats(state, { pnl: -5 });
  assert.equal(state.regimeStats.bull.losses, 1);
  assert.equal(state.regimeStats.bull.wins, 0);
});

test("updateRegimeStats - accumulates totalPnl correctly", () => {
  const state = makeState(0);
  updateRegimeStats(state, { pnl: 10 });
  updateRegimeStats(state, { pnl: -3 });
  assert.ok(Math.abs(state.regimeStats.bull.totalPnl - 7) < 1e-9);
});

test("updateRegimeStats - uses lastRegime label to bucket the trade", () => {
  const state = { ...makeState(0), lastRegime: { label: "bear" } };
  updateRegimeStats(state, { pnl: 5 });
  assert.equal(state.regimeStats.bear.wins, 1);
  // bear bucket gets the trade; bull not incremented by this call
  assert.ok(!state.regimeStats.bull || state.regimeStats.bull.count === 0);
});

// ── getAdaptiveThreshold ───────────────────────────────────────────────────────

test("getAdaptiveThreshold - no regimeStats returns ENTRY_THRESHOLD (4)", () => {
  const state = {};
  const t = getAdaptiveThreshold(state, "bull");
  assert.equal(t, 4); // ENTRY_THRESHOLD from config
});

test("getAdaptiveThreshold - count < 15 returns base threshold", () => {
  const state = { regimeStats: { bull: { wins: 5, losses: 5, totalPnl: 10, count: 10 } } };
  assert.equal(getAdaptiveThreshold(state, "bull"), 4);
});

test("getAdaptiveThreshold - high WR regime lowers threshold", () => {
  // WR > 55% and avgPnl > 0 → adjustment = -1 → threshold = 4-1 = 3
  const state = {
    regimeStats: { bull: { wins: 12, losses: 3, totalPnl: 100, count: 15 } },
    trades: []
  };
  const t = getAdaptiveThreshold(state, "bull");
  assert.ok(t < 4, `expected threshold < 4 for high WR regime, got ${t}`);
  assert.ok(t >= 3);
});

test("getAdaptiveThreshold - low WR regime raises threshold", () => {
  // WR < 38% → adjustment = 1 → threshold = 5 (capped at 6)
  const state = {
    regimeStats: { bull: { wins: 5, losses: 15, totalPnl: -50, count: 20 } },
    trades: []
  };
  const t = getAdaptiveThreshold(state, "bull");
  assert.ok(t > 4, `expected threshold > 4 for low WR regime, got ${t}`);
});

test("getAdaptiveThreshold - result is always clamped to [3, 6]", () => {
  // Extreme cases should still be within [3, 6]
  const highWR = { regimeStats: { bull: { wins: 100, losses: 0, totalPnl: 1000, count: 100 } }, trades: [] };
  const lowWR  = { regimeStats: { bull: { wins: 0, losses: 100, totalPnl: -1000, count: 100 } }, trades: [] };
  assert.ok(getAdaptiveThreshold(highWR, "bull") >= 3);
  assert.ok(getAdaptiveThreshold(lowWR, "bull") <= 6);
});

test("getAdaptiveThreshold - chop regime adds 0.5 on top of adjustment", () => {
  const base  = { regimeStats: { bull:  { wins: 7, losses: 8, totalPnl: -10, count: 15 } }, trades: [] };
  const chop  = { regimeStats: { chop:  { wins: 7, losses: 8, totalPnl: -10, count: 15 } }, trades: [] };
  const tBull = getAdaptiveThreshold(base, "bull");
  const tChop = getAdaptiveThreshold(chop, "chop");
  assert.ok(tChop >= tBull, `chop threshold ${tChop} should be >= bull ${tBull}`);
});

// ── getRegimePerformance ───────────────────────────────────────────────────────

test("getRegimePerformance - no trades returns N/A winRate", () => {
  const state = { trades: [], coinHistory: {} };
  const r = getRegimePerformance(state, "bull");
  assert.equal(r.winRate, "N/A");
  assert.equal(r.avgPnl, "0");
});

test("getRegimePerformance - falls back to last 50 trades when no coinHistory match", () => {
  const trades = Array.from({ length: 20 }, (_, i) => ({ pnl: i % 2 === 0 ? 10 : -5, closedAt: "2024-01-01T00:00:00Z" }));
  const state = { trades, coinHistory: {} };
  const r = getRegimePerformance(state, "bull");
  assert.equal(r.total, 20);
  assert.ok(typeof r.winRate === "string");
});

test("getRegimePerformance - correct win count and avgPnl", () => {
  // 10 trades: 6 wins of +10, 4 losses of -5 → wins=6, total=10, avgPnl = (60-20)/10 = 4
  const trades = Array.from({ length: 10 }, (_, i) => ({
    pnl: i < 6 ? 10 : -5,
    closedAt: "2024-01-01T00:00:00Z"
  }));
  const state = { trades, coinHistory: {} };
  const r = getRegimePerformance(state, "bull");
  assert.equal(r.wins, 6);
  assert.equal(r.total, 10);
  assert.equal(r.avgPnl, "4.00");
});
