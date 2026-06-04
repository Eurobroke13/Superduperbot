/**
 * Unit tests for bot/friction.js
 * Pure math — no I/O. All values hand-verified.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateSlippage,
  applyEntryFriction,
  applyExitFriction,
  estimateFundingCost,
  applyRoundTripFriction,
  computeFrictionAdjustedMetrics,
  FRICTION_CONFIG
} from "../bot/friction.js";

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── FRICTION_CONFIG ────────────────────────────────────────────────────────────

test("FRICTION_CONFIG exports known constants", () => {
  assert.equal(FRICTION_CONFIG.takerFeePct,  0.0005);
  assert.equal(FRICTION_CONFIG.makerFeePct,  0.0002);
  assert.equal(FRICTION_CONFIG.baseSlippage, 0.0003);
  assert.equal(FRICTION_CONFIG.fundingAvg,   0.0001);
});

// ── estimateSlippage ───────────────────────────────────────────────────────────

test("estimateSlippage - BTC (0.3× liquidity mult) has lower slippage than unknown coin", () => {
  const btc = estimateSlippage(100, 1000, "BTC-USDT-SWAP");
  const unk = estimateSlippage(100, 1000, "DOGE-USDT-SWAP");
  assert.ok(btc < unk, `BTC slippage ${btc} should be less than unknown ${unk}`);
});

test("estimateSlippage - larger notional increases slippage (sqrt scaling)", () => {
  const small = estimateSlippage(100, 1000);
  const large = estimateSlippage(100, 50000);
  assert.ok(large > small);
});

test("estimateSlippage - returns positive number", () => {
  assert.ok(estimateSlippage(50000, 500, "BTC-USDT-SWAP") > 0);
});

test("estimateSlippage - scales with price", () => {
  const cheap = estimateSlippage(1, 1000);
  const expensive = estimateSlippage(1000, 1000);
  assert.ok(expensive > cheap);
});

// ── applyEntryFriction ─────────────────────────────────────────────────────────

test("applyEntryFriction - long entry worsens fill (higher price)", () => {
  const r = applyEntryFriction(100, "long", 1000);
  assert.ok(r.adjustedPrice > 100);
  assert.ok(r.feeCost > 0);
  assert.ok(r.slippageCost > 0);
});

test("applyEntryFriction - short entry worsens fill (lower price)", () => {
  const r = applyEntryFriction(100, "short", 1000);
  assert.ok(r.adjustedPrice < 100);
});

test("applyEntryFriction - taker fee = 0.05% of notional", () => {
  const r = applyEntryFriction(100, "long", 1000, null, "taker");
  assert.ok(approx(r.feeCost, 1000 * 0.0005));
});

test("applyEntryFriction - maker fee = 0.02% of notional", () => {
  const r = applyEntryFriction(100, "long", 1000, null, "maker");
  assert.ok(approx(r.feeCost, 1000 * 0.0002));
});

test("applyEntryFriction - BTC has lower slippage cost than unknown coin", () => {
  const btc = applyEntryFriction(100, "long", 1000, "BTC-USDT-SWAP");
  const unk = applyEntryFriction(100, "long", 1000, "RSR-USDT-SWAP");
  assert.ok(btc.slippageCost < unk.slippageCost);
});

// ── applyExitFriction ──────────────────────────────────────────────────────────

test("applyExitFriction - reduces raw PnL by fee + slippage", () => {
  const r = applyExitFriction(100, 110, "long", 1);
  assert.ok(r.adjustedPnl < 100);
  assert.ok(r.feeCost > 0);
  assert.ok(r.slippageCost > 0);
});

test("applyExitFriction - fee is 0.05% of exit notional", () => {
  // size=1, exitPrice=100 → notional=100 → fee=0.05
  const r = applyExitFriction(50, 100, "long", 1);
  assert.ok(approx(r.feeCost, 100 * 0.0005));
});

test("applyExitFriction - short exit also reduces PnL", () => {
  const r = applyExitFriction(50, 90, "short", 1);
  assert.ok(r.adjustedPnl < 50);
});

// ── estimateFundingCost ────────────────────────────────────────────────────────

test("estimateFundingCost - zero settlements under 8h → 0", () => {
  assert.equal(estimateFundingCost(7, 1000, "long"), 0);
});

test("estimateFundingCost - 8h = 1 settlement for long at avg rate", () => {
  // cost = 1 * 1000 * 0.0001 = 0.1
  const r = estimateFundingCost(8, 1000, "long");
  assert.ok(approx(r, 0.1));
});

test("estimateFundingCost - short receives funding when rate is positive", () => {
  // short: cost = settlements * notional * -rate → negative = income
  const r = estimateFundingCost(8, 1000, "short");
  assert.ok(r < 0, `short should receive funding (negative cost), got ${r}`);
});

test("estimateFundingCost - 24h = 3 settlements", () => {
  const r = estimateFundingCost(24, 1000, "long");
  assert.ok(approx(r, 3 * 1000 * 0.0001));
});

test("estimateFundingCost - custom funding rate overrides average", () => {
  const r = estimateFundingCost(8, 1000, "long", 0.001); // 10× the avg
  assert.ok(approx(r, 1000 * 0.001));
});

// ── applyRoundTripFriction ─────────────────────────────────────────────────────

test("applyRoundTripFriction - adjustedPnl is always less than rawPnl", () => {
  const trade = { entryPrice: 100, exitPrice: 110, direction: "long", size: 1, notional: 500, pnl: 10, hoursHeld: 12 };
  const r = applyRoundTripFriction(trade);
  assert.ok(r.adjustedPnl < r.rawPnl);
  assert.equal(r.rawPnl, 10);
});

test("applyRoundTripFriction - friction object has all expected keys", () => {
  const trade = { entryPrice: 100, exitPrice: 105, direction: "long", size: 1, notional: 500, pnl: 5, hoursHeld: 8 };
  const r = applyRoundTripFriction(trade);
  assert.ok("entryFee" in r.friction);
  assert.ok("exitFee" in r.friction);
  assert.ok("entrySlippage" in r.friction);
  assert.ok("exitSlippage" in r.friction);
  assert.ok("funding" in r.friction);
  assert.ok("total" in r.friction);
});

test("applyRoundTripFriction - total friction = sum of components", () => {
  const trade = { entryPrice: 100, exitPrice: 110, direction: "long", size: 1, notional: 500, pnl: 10, hoursHeld: 16 };
  const r = applyRoundTripFriction(trade);
  const { entryFee, exitFee, entrySlippage, exitSlippage, funding, total } = r.friction;
  assert.ok(approx(total, entryFee + exitFee + entrySlippage + exitSlippage + funding, 1e-6));
});

test("applyRoundTripFriction - BTC trade has less friction than altcoin", () => {
  const base = { entryPrice: 100, exitPrice: 110, direction: "long", size: 1, notional: 500, pnl: 10, hoursHeld: 8 };
  const btc = applyRoundTripFriction(base, "BTC-USDT-SWAP");
  const alt = applyRoundTripFriction(base, "RSR-USDT-SWAP");
  assert.ok(btc.friction.total < alt.friction.total);
});

// ── computeFrictionAdjustedMetrics ─────────────────────────────────────────────

test("computeFrictionAdjustedMetrics - returns expected metric keys", () => {
  const trades = [
    { entryPrice: 100, exitPrice: 110, direction: "long", size: 1, notional: 500, pnl: 10, hoursHeld: 8 },
    { entryPrice: 100, exitPrice: 95,  direction: "long", size: 1, notional: 500, pnl: -5, hoursHeld: 4 }
  ];
  const r = computeFrictionAdjustedMetrics(trades);
  assert.equal(r.totalTrades, 2);
  assert.ok(typeof r.winRate === "number");
  assert.ok(typeof r.totalPnl === "number");
  assert.ok(typeof r.totalFriction === "number");
  assert.ok(typeof r.expectancy === "number");
});

test("computeFrictionAdjustedMetrics - totalFriction is positive", () => {
  const trades = [
    { entryPrice: 100, exitPrice: 110, direction: "long", size: 1, notional: 500, pnl: 10, hoursHeld: 8 }
  ];
  const r = computeFrictionAdjustedMetrics(trades);
  assert.ok(r.totalFriction > 0);
});

test("computeFrictionAdjustedMetrics - friction-adjusted PnL is less than raw", () => {
  const trades = [
    { entryPrice: 100, exitPrice: 110, direction: "long", size: 1, notional: 500, pnl: 10, hoursHeld: 8 }
  ];
  const r = computeFrictionAdjustedMetrics(trades);
  assert.ok(r.totalPnl < 10);
});
