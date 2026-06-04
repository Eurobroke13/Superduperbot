/**
 * Unit tests for bot/stats.js — all pure stat functions.
 * No I/O, no DB. Constants pulled from config.js (INPUT/OUTPUT cost, CLAUDE_THRESHOLD=6).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  getSetupStats,
  getApprovalStats,
  getSymbolStats,
  getSymbolRiskDecision,
  getApprovalRiskMultiplier,
  getAdaptiveSetupDecision,
  getSetupRiskMultiplier,
  getAdaptiveClaudeThreshold,
  calculatePerformanceMetrics,
  estimateMonthlySpend,
  calculateRecentLiveHealth,
  checkPerformanceDrift
} from "../bot/stats.js";

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── helpers ────────────────────────────────────────────────────────────────────

const trade = (pnl, setupType = "trend", approvalType = "auto", symbol = "BTC-USDT-SWAP", notional = 500) =>
  ({ pnl, setupType, approvalType, symbol, notional });

function makeN(n, winPnl, lossPnl, setupType = "trend", approvalType = "auto") {
  // Produces a 50/50 win/loss spread of exactly n trades
  return Array.from({ length: n }, (_, i) =>
    trade(i % 2 === 0 ? winPnl : lossPnl, setupType, approvalType)
  );
}

// ── getSetupStats ──────────────────────────────────────────────────────────────

test("getSetupStats - null/empty trades → null", () => {
  assert.equal(getSetupStats(null, "trend"), null);
  assert.equal(getSetupStats([], "trend"), null);
});

test("getSetupStats - filters by setupType", () => {
  const trades = [trade(10, "trend"), trade(-5, "mean-reversion"), trade(8, "trend")];
  const r = getSetupStats(trades, "trend");
  assert.equal(r.count, 2);
});

test("getSetupStats - correct winRate, avgWin, avgLoss, expectancy", () => {
  // 2 wins of +10, 1 loss of -5
  const trades = [trade(10, "trend"), trade(10, "trend"), trade(-5, "trend")];
  const r = getSetupStats(trades, "trend");
  assert.ok(approx(r.winRate, 2 / 3));
  assert.ok(approx(r.avgWin, 10));
  assert.ok(approx(r.avgLoss, 5));
  // expectancy = (2/3)*10 - (1/3)*5 = 20/3 - 5/3 = 15/3 = 5
  assert.ok(approx(r.expectancy, 5));
});

test("getSetupStats - all wins → avgLoss=0", () => {
  const trades = [trade(10, "trend"), trade(5, "trend")];
  const r = getSetupStats(trades, "trend");
  assert.equal(r.avgLoss, 0);
  assert.equal(r.winRate, 1);
});

// ── getApprovalStats ───────────────────────────────────────────────────────────

test("getApprovalStats - filters by approvalType", () => {
  const trades = [trade(10, "trend", "claude"), trade(-5, "trend", "auto"), trade(8, "trend", "claude")];
  const r = getApprovalStats(trades, "claude");
  assert.equal(r.count, 2);
  assert.equal(r.winRate, 1);
});

test("getApprovalStats - unknown type → null", () => {
  assert.equal(getApprovalStats([trade(10)], "unknown-type"), null);
});

// ── getSymbolStats ─────────────────────────────────────────────────────────────

test("getSymbolStats - filters by symbol and includes totalPnl", () => {
  const trades = [
    trade(10, "trend", "auto", "BTC-USDT-SWAP"),
    trade(-5, "trend", "auto", "ETH-USDT-SWAP"),
    trade(20, "trend", "auto", "BTC-USDT-SWAP")
  ];
  const r = getSymbolStats(trades, "BTC-USDT-SWAP");
  assert.equal(r.count, 2);
  assert.ok(approx(r.totalPnl, 30));
  assert.equal(r.winRate, 1);
});

test("getSymbolStats - no matching symbol → null", () => {
  assert.equal(getSymbolStats([trade(10)], "DOGE-USDT-SWAP"), null);
});

// ── getSymbolRiskDecision ──────────────────────────────────────────────────────

test("getSymbolRiskDecision - no stats → allow:true, sizeMult:1.0", () => {
  const state = { trades: [] };
  const r = getSymbolRiskDecision(state, "BTC-USDT-SWAP");
  assert.equal(r.allow, true);
  assert.equal(r.sizeMult, 1.0);
  assert.equal(r.reason, "no-symbol-stats");
});

test("getSymbolRiskDecision - 80+ trades with expectancy < -2 → blocked", () => {
  const trades = Array.from({ length: 80 }, () => trade(-10, "trend", "auto", "BTC-USDT-SWAP"));
  const r = getSymbolRiskDecision({ trades }, "BTC-USDT-SWAP");
  assert.equal(r.allow, false);
  assert.equal(r.sizeMult, 0);
});

test("getSymbolRiskDecision - 80+ trades weak but expectancy > -2 → neutral or weak", () => {
  // 80 trades: 40 wins of +1, 40 losses of -2 → winRate=0.5, expectancy=(0.5*1)-(0.5*2)=-0.5
  const trades = Array.from({ length: 80 }, (_, i) =>
    trade(i % 2 === 0 ? 1 : -2, "trend", "auto", "BTC-USDT-SWAP")
  );
  const r = getSymbolRiskDecision({ trades }, "BTC-USDT-SWAP");
  // expectancy=-0.5 > -2, winRate=0.5 >= 0.40 → not the second block
  // but 50 <= count, expectancy < 0 → sizeMult 0.6
  assert.equal(r.allow, true);
  assert.equal(r.sizeMult, 0.6);
});

test("getSymbolRiskDecision - 50+ trades with positive expectancy and winRate > 0.5 → boosted", () => {
  // 50 trades: all wins of +10
  const trades = Array.from({ length: 50 }, () => trade(10, "trend", "auto", "BTC-USDT-SWAP"));
  const r = getSymbolRiskDecision({ trades }, "BTC-USDT-SWAP");
  assert.equal(r.allow, true);
  assert.equal(r.sizeMult, 1.05);
});

// ── getApprovalRiskMultiplier ──────────────────────────────────────────────────

test("getApprovalRiskMultiplier - no stats or < 15 trades → 1.0", () => {
  assert.equal(getApprovalRiskMultiplier({ trades: [] }, "claude"), 1.0);
  assert.equal(getApprovalRiskMultiplier({ trades: makeN(10, 10, -5, "trend", "claude") }, "claude"), 1.0);
});

test("getApprovalRiskMultiplier - high expectancy + winRate → 1.10", () => {
  // 20 trades: all wins of +10 → expectancy=10, winRate=1.0
  const state = { trades: Array.from({ length: 20 }, () => trade(10, "trend", "claude")) };
  assert.equal(getApprovalRiskMultiplier(state, "claude"), 1.10);
});

test("getApprovalRiskMultiplier - negative expectancy low winRate → 0.85", () => {
  // 20 trades: 5 wins of +1, 15 losses of -10 → expectancy=(0.25*1)-(0.75*10)=-7.25, winRate=0.25
  const state = {
    trades: Array.from({ length: 20 }, (_, i) =>
      trade(i < 5 ? 1 : -10, "trend", "claude")
    )
  };
  assert.equal(getApprovalRiskMultiplier(state, "claude"), 0.85);
});

// ── getAdaptiveSetupDecision ───────────────────────────────────────────────────

test("getAdaptiveSetupDecision - no stats → allow:true, 1.0", () => {
  const r = getAdaptiveSetupDecision({ trades: [] }, "trend");
  assert.equal(r.allow, true);
  assert.equal(r.sizeMult, 1.0);
  assert.equal(r.reason, "no-stats");
});

test("getAdaptiveSetupDecision - < 15 trades → low-sample, 1.0", () => {
  const r = getAdaptiveSetupDecision({ trades: makeN(10, 10, -5) }, "trend");
  assert.equal(r.reason, "low-sample");
  assert.equal(r.sizeMult, 1.0);
});

test("getAdaptiveSetupDecision - 30+ trades, expectancy < -5 → blocked", () => {
  // 30 trades all losing -20 → expectancy = -20, winRate = 0
  const trades = Array.from({ length: 30 }, () => trade(-20));
  const r = getAdaptiveSetupDecision({ trades }, "trend");
  assert.equal(r.allow, false);
  assert.equal(r.sizeMult, 0.0);
});

test("getAdaptiveSetupDecision - 30+ trades, good expectancy and winRate → 1.20", () => {
  // 30 trades all winning +10 → expectancy=10, winRate=1.0
  const trades = Array.from({ length: 30 }, () => trade(10));
  const r = getAdaptiveSetupDecision({ trades }, "trend");
  assert.equal(r.allow, true);
  assert.equal(r.sizeMult, 1.20);
});

test("getAdaptiveSetupDecision - 30+ trades negative EV but winRate >= 0.45 → reduced size, allowed", () => {
  // 30 trades: 50% win at +1, 50% loss at -3 → winRate=0.5, expectancy=0.5*1-0.5*3=-1.0
  // Does NOT hit (expectancy < 0 && winRate < 0.45) block gate
  const trades = Array.from({ length: 30 }, (_, i) => trade(i % 2 === 0 ? 1 : -3));
  const r = getAdaptiveSetupDecision({ trades }, "trend");
  assert.equal(r.allow, true);
  assert.ok(r.sizeMult < 1.0);
});

// ── getSetupRiskMultiplier ─────────────────────────────────────────────────────

test("getSetupRiskMultiplier - < 20 trades → 1.0", () => {
  assert.equal(getSetupRiskMultiplier({ trades: makeN(10, 10, -5) }, "trend"), 1.0);
});

test("getSetupRiskMultiplier - expectancy > 8 → 1.25", () => {
  const trades = Array.from({ length: 20 }, () => trade(10));
  assert.equal(getSetupRiskMultiplier({ trades }, "trend"), 1.25);
});

test("getSetupRiskMultiplier - expectancy < 0 → 0.75", () => {
  const trades = Array.from({ length: 20 }, () => trade(-5));
  assert.equal(getSetupRiskMultiplier({ trades }, "trend"), 0.75);
});

// ── calculatePerformanceMetrics ────────────────────────────────────────────────

test("calculatePerformanceMetrics - < 5 trades → null", () => {
  assert.equal(calculatePerformanceMetrics([trade(10), trade(-5)]), null);
});

test("calculatePerformanceMetrics - returns expected fields", () => {
  const trades = Array.from({ length: 10 }, (_, i) => trade(i % 2 === 0 ? 20 : -5));
  const r = calculatePerformanceMetrics(trades);
  assert.ok(r !== null);
  assert.equal(typeof r.totalTrades, "number");
  assert.equal(r.totalTrades, 10);
  assert.ok(Number.isFinite(parseFloat(r.winRate)));
  assert.ok(Number.isFinite(parseFloat(r.sharpe)));
  assert.ok(Number.isFinite(parseFloat(r.profitFactor)));
  assert.ok(Number.isFinite(parseFloat(r.maxDrawdown)));
});

test("calculatePerformanceMetrics - all wins → profitFactor is 999", () => {
  const trades = Array.from({ length: 10 }, () => trade(10));
  const r = calculatePerformanceMetrics(trades);
  assert.equal(r.profitFactor, "999.00");
});

test("calculatePerformanceMetrics - 50% winRate is computed correctly", () => {
  const trades = Array.from({ length: 10 }, (_, i) => trade(i % 2 === 0 ? 10 : -10));
  const r = calculatePerformanceMetrics(trades);
  assert.equal(r.winRate, "50.0");
});

// ── estimateMonthlySpend ───────────────────────────────────────────────────────

test("estimateMonthlySpend - null → 0", () => {
  assert.equal(estimateMonthlySpend(null), 0);
});

test("estimateMonthlySpend - 1M input tokens at $3/MTok = $3", () => {
  const r = estimateMonthlySpend({ input: 1_000_000, output: 0 });
  assert.ok(approx(r, 3.0));
});

test("estimateMonthlySpend - 1M output tokens at $15/MTok = $15", () => {
  const r = estimateMonthlySpend({ input: 0, output: 1_000_000 });
  assert.ok(approx(r, 15.0));
});

test("estimateMonthlySpend - combined input + output", () => {
  const r = estimateMonthlySpend({ input: 500_000, output: 200_000 });
  // 0.5 * 3 + 0.2 * 15 = 1.5 + 3.0 = 4.5
  assert.ok(approx(r, 4.5));
});

// ── calculateRecentLiveHealth ──────────────────────────────────────────────────

test("calculateRecentLiveHealth - < 30 trades → enoughData:false", () => {
  const state = { trades: makeN(10, 10, -5) };
  const r = calculateRecentLiveHealth(state);
  assert.equal(r.enoughData, false);
  assert.equal(r.count, 10);
});

test("calculateRecentLiveHealth - 30+ trades returns health metrics", () => {
  const state = { trades: makeN(40, 10, -5) };
  const r = calculateRecentLiveHealth(state);
  assert.equal(r.enoughData, true);
  assert.equal(r.count, 40);
  assert.ok(Number.isFinite(r.winRate));
  assert.ok(Number.isFinite(r.expectancy));
  assert.ok(Number.isFinite(r.profitFactor));
});

test("calculateRecentLiveHealth - only uses last N trades (lookback)", () => {
  const old = makeN(50, -100, -100); // 50 terrible old trades
  const recent = makeN(40, 10, -2);  // 40 good recent trades
  const state = { trades: [...old, ...recent] };
  const r = calculateRecentLiveHealth(state, 40); // only last 40
  assert.equal(r.enoughData, true);
  assert.ok(r.expectancy > 0); // recent trades are profitable
});

// ── checkPerformanceDrift ──────────────────────────────────────────────────────

test("checkPerformanceDrift - < 30 trades → null (not enough data)", () => {
  const state = { trades: makeN(10, 10, -5), drawdown: 0 };
  assert.equal(checkPerformanceDrift(state), null);
});

test("checkPerformanceDrift - healthy portfolio → null", () => {
  // 40 trades, 50/50 wins of +20 and losses of -5 → profitFactor=2.0, winRate=0.5, expectancy=7.5
  const state = {
    trades: makeN(40, 20, -5),
    drawdown: 0.02
  };
  assert.equal(checkPerformanceDrift(state), null);
});

test("checkPerformanceDrift - unhealthy portfolio → driftStatus with alerts", () => {
  // 40 trades all losing → profitFactor=0, winRate=0, expectancy<0
  const state = {
    trades: Array.from({ length: 40 }, () => trade(-10)),
    drawdown: 0.10
  };
  const r = checkPerformanceDrift(state);
  assert.ok(r !== null);
  assert.equal(r.status, "warning");
  assert.ok(Array.isArray(r.alerts));
  assert.ok(r.alerts.length > 0);
  // state.driftStatus should be mutated
  assert.ok(state.driftStatus !== undefined);
});

test("checkPerformanceDrift - high drawdown triggers alert", () => {
  const state = {
    trades: makeN(40, 20, -5), // healthy trades
    drawdown: 0.09             // but drawdown > 8%
  };
  const r = checkPerformanceDrift(state);
  assert.ok(r !== null);
  assert.ok(r.alerts.some(a => a.includes("Drawdown")));
});
