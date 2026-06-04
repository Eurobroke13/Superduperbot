/**
 * Unit tests for bot/smart-entry-engine.js — decaying-limit and split-entry
 * strategies. Entirely pure, so all 9 exports are tested directly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDecayingLimit,
  tickDecayingLimit,
  createSplitEntry,
  tickDeferredLimit,
  recommendApproach,
  calcDecayImprovement,
  calcSplitImprovement
} from "../bot/smart-entry-engine.js";

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const base = {
  symbol: "BTC-USDT-SWAP", direction: "long", currentPrice: 100, atrVal: 2,
  setupType: "trend", signalSet: [], score: 6, leverage: 5, size: 1, notional: 1000
};

// ── createDecayingLimit ────────────────────────────────────────────────────────

test("createDecayingLimit - overbought signal picks the aggressive schedule", () => {
  const o = createDecayingLimit({ ...base, signalSet: ["trend-vs-overbought"] });
  assert.equal(o.scheduleKey, "trend-vs-overbought");
  assert.deepEqual(o.offsets, [0.5, 0.3, 0.15, 0]);
  assert.ok(approx(o.limitPrice, 99)); // 100 - 0.5*2
  assert.equal(o.status, "active");
  assert.equal(o.currentStep, 0);
});

test("createDecayingLimit - falls back to the setup-type schedule", () => {
  const o = createDecayingLimit({ ...base, setupType: "trend" });
  assert.equal(o.scheduleKey, "trend");
  assert.ok(approx(o.limitPrice, 99.4)); // 100 - 0.3*2
});

test("createDecayingLimit - unknown setup uses the default schedule", () => {
  const o = createDecayingLimit({ ...base, setupType: "no-such" });
  assert.equal(o.scheduleKey, "default");
  assert.ok(approx(o.limitPrice, 99.6)); // 100 - 0.2*2
});

test("createDecayingLimit - short places limit above price", () => {
  const o = createDecayingLimit({ ...base, direction: "short", setupType: "trend" });
  assert.ok(approx(o.limitPrice, 100.6)); // 100 + 0.3*2
});

// ── tickDecayingLimit ──────────────────────────────────────────────────────────

test("tickDecayingLimit - fills at limit when candle reaches it", () => {
  const order = { direction: "long", limitPrice: 99, offsets: [0.5, 0.3, 0.15, 0], currentStep: 0, atrVal: 2 };
  const r = tickDecayingLimit(order, { low: 98, high: 101 }, 100);
  assert.equal(r.action, "fill-limit");
  assert.equal(r.fillPrice, 99);
  assert.equal(order.fillType, "limit");
});

test("tickDecayingLimit - decays the offset on a no-fill candle", () => {
  const order = { direction: "long", limitPrice: 99, offsets: [0.5, 0.3, 0.15, 0], currentStep: 0, atrVal: 2 };
  const r = tickDecayingLimit(order, { low: 99.5, high: 101 }, 100);
  assert.equal(r.action, "wait");
  assert.equal(order.currentStep, 1);
  assert.ok(approx(order.limitPrice, 99.4)); // 100 - 0.3*2
});

test("tickDecayingLimit - converts to market when schedule hits zero", () => {
  const order = { direction: "long", limitPrice: 99.7, offsets: [0.15, 0], currentStep: 0, atrVal: 2 };
  const r = tickDecayingLimit(order, { low: 99.9, high: 101 }, 100);
  assert.equal(r.action, "fill-market");
  assert.equal(r.fillPrice, 100);
  assert.equal(order.fillType, "market");
});

// ── createSplitEntry ───────────────────────────────────────────────────────────

test("createSplitEntry - splits 60/40 market/limit with correct sizing", () => {
  const { immediate, deferred } = createSplitEntry({ ...base, setupType: "trend" });
  assert.ok(approx(immediate.size, 0.6));
  assert.ok(approx(immediate.notional, 600));
  assert.equal(immediate.type, "market");
  assert.ok(approx(deferred.size, 0.4));
  assert.ok(approx(deferred.notional, 400));
  assert.ok(approx(deferred.limitPrice, 99.3)); // 100 - 0.35*2
  assert.equal(deferred.maxCandles, 4);
  assert.equal(deferred.status, "pending");
});

test("createSplitEntry - overbought widens the deferred limit offset", () => {
  const { deferred } = createSplitEntry({ ...base, signalSet: ["trend-vs-overbought"] });
  assert.ok(approx(deferred.limitPrice, 98.8)); // 100 - 0.6*2
});

// ── tickDeferredLimit ──────────────────────────────────────────────────────────

test("tickDeferredLimit - fills when candle reaches the deferred limit", () => {
  const deferred = { direction: "long", limitPrice: 99, candlesElapsed: 0, maxCandles: 4 };
  const r = tickDeferredLimit(deferred, { low: 98, high: 101 });
  assert.equal(r.action, "fill");
  assert.equal(deferred.status, "filled");
});

test("tickDeferredLimit - waits inside the window", () => {
  const deferred = { direction: "long", limitPrice: 99, candlesElapsed: 0, maxCandles: 4 };
  const r = tickDeferredLimit(deferred, { low: 99.5, high: 101 });
  assert.equal(r.action, "wait");
  assert.equal(deferred.candlesElapsed, 1);
});

test("tickDeferredLimit - cancels at expiry (runs at 60% size)", () => {
  const deferred = { direction: "long", limitPrice: 99, candlesElapsed: 3, maxCandles: 4 };
  const r = tickDeferredLimit(deferred, { low: 99.5, high: 101 });
  assert.equal(r.action, "cancel");
  assert.equal(deferred.status, "cancelled");
});

// ── recommendApproach ──────────────────────────────────────────────────────────

test("recommendApproach - overbought → decaying-limit", () => {
  const r = recommendApproach({ signalSet: ["trend-vs-overbought"], score: 5, setupType: "trend" });
  assert.equal(r.approach, "decaying-limit");
});

test("recommendApproach - high score + momentum → market", () => {
  const r = recommendApproach({ signalSet: ["volume"], score: 8, setupType: "trend" });
  assert.equal(r.approach, "market");
});

test("recommendApproach - mean-reversion → market", () => {
  const r = recommendApproach({ signalSet: [], score: 5, setupType: "mean-reversion" });
  assert.equal(r.approach, "market");
});

test("recommendApproach - moderate conviction → split", () => {
  const r = recommendApproach({ signalSet: [], score: 5, setupType: "trend" });
  assert.equal(r.approach, "split");
});

// ── calcDecayImprovement ────────────────────────────────────────────────────────

test("calcDecayImprovement - long fill below signal price saved money", () => {
  const r = calcDecayImprovement({
    fillPrice: 99, marketPriceAtSignal: 100, direction: "long", leverage: 2, currentStep: 1, fillType: "limit"
  });
  assert.equal(r.savedPct, 2);       // (100-99)/100*100*2
  assert.equal(r.wasWorthWaiting, true);
  assert.equal(r.candlesWaited, 1);
});

test("calcDecayImprovement - short side and negative (market would've been better)", () => {
  const r = calcDecayImprovement({
    fillPrice: 99, marketPriceAtSignal: 100, direction: "short", leverage: 1, currentStep: 2, fillType: "market"
  });
  assert.equal(r.savedPct, -1);
  assert.equal(r.wasWorthWaiting, false);
});

// ── calcSplitImprovement ────────────────────────────────────────────────────────

test("calcSplitImprovement - limit not filled runs at reduced size", () => {
  const r = calcSplitImprovement(100, null, 0.6, "long");
  assert.equal(r.limitFilled, false);
  assert.equal(r.effectiveSize, 0.6);
  assert.equal(r.improvementPct, 0);
  assert.equal(r.avgEntry, 100);
});

test("calcSplitImprovement - long blended entry improves vs market", () => {
  const r = calcSplitImprovement(100, 99, 0.6, "long");
  assert.ok(approx(r.avgEntry, 99.6)); // 100*0.6 + 99*0.4
  assert.equal(r.improvementPct, 0.4); // (100-99.6)/100*100
  assert.equal(r.limitFilled, true);
  assert.equal(r.effectiveSize, 1.0);
});

test("calcSplitImprovement - short blended entry improves vs market", () => {
  const r = calcSplitImprovement(100, 101, 0.6, "short");
  assert.ok(approx(r.avgEntry, 100.4)); // 100*0.6 + 101*0.4
  assert.ok(r.improvementPct > 0);
});
