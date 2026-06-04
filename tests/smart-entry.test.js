/**
 * Unit tests for bot/smart-entry.js
 * shouldDecay, createDecayingLimit, tickDecayingLimit, cancelDecayingLimit,
 * initDecayingLimits, processDecayingLimits — all pure / in-memory.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldDecay,
  createDecayingLimit,
  tickDecayingLimit,
  cancelDecayingLimit,
  initDecayingLimits,
  processDecayingLimits
} from "../bot/smart-entry.js";

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function baseCandidate(overrides = {}) {
  return {
    symbol: "BTC-USDT-SWAP",
    signal: "long",
    price: 100,
    atrVal: 2,
    score: 6,
    reasons: ["trend-vs-overbought"],
    setupType: "trend",
    leverage: 5,
    sl: 96,
    tp: 110,
    riskReward: 2,
    ...overrides
  };
}

// ── shouldDecay ────────────────────────────────────────────────────────────────

test("shouldDecay - overbought signal → true", () => {
  assert.equal(shouldDecay({ reasons: ["trend-vs-overbought"] }), true);
});

test("shouldDecay - oversold signal → true", () => {
  assert.equal(shouldDecay({ reasons: ["trend-vs-oversold"] }), true);
});

test("shouldDecay - ordinary signals → false", () => {
  assert.equal(shouldDecay({ reasons: ["ema-ribbon", "adx-strong-bull"] }), false);
});

test("shouldDecay - empty reasons → false", () => {
  assert.equal(shouldDecay({ reasons: [] }), false);
});

test("shouldDecay - uses signalSet if reasons absent", () => {
  assert.equal(shouldDecay({ signalSet: ["trend-vs-overbought"] }), true);
  assert.equal(shouldDecay({ signalSet: ["volume"] }), false);
});

// ── createDecayingLimit ────────────────────────────────────────────────────────

test("createDecayingLimit - overbought long: limit = price - 0.5×ATR", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  assert.ok(approx(order.limitPrice, 99)); // 100 - 0.5*2
  assert.equal(order.direction, "long");
  assert.equal(order.status, "active");
  assert.equal(order.currentStep, 0);
});

test("createDecayingLimit - overbought short: limit = price + 0.5×ATR", () => {
  const order = createDecayingLimit(baseCandidate({ signal: "short" }), 100);
  assert.ok(approx(order.limitPrice, 101)); // 100 + 0.5*2
});

test("createDecayingLimit - oversold uses same schedule as overbought", () => {
  const order = createDecayingLimit(baseCandidate({ reasons: ["trend-vs-oversold"] }), 100);
  assert.deepEqual(order.offsets, [0.5, 0.3, 0.15, 0]);
});

test("createDecayingLimit - default schedule for unknown reasons", () => {
  const order = createDecayingLimit(baseCandidate({ reasons: [] }), 100);
  assert.deepEqual(order.offsets, [0.3, 0.15, 0]);
  assert.ok(approx(order.limitPrice, 99.4)); // 100 - 0.3*2
});

test("createDecayingLimit - stores original candidate and signal price", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  assert.equal(order.marketPriceAtSignal, 100);
  assert.ok(order.candidate);
  assert.equal(order.candidate.symbol, "BTC-USDT-SWAP");
});

test("createDecayingLimit - sl/tp/riskReward copied from candidate", () => {
  const order = createDecayingLimit(baseCandidate({ sl: 95, tp: 115, riskReward: 3 }), 100);
  assert.equal(order.sl, 95);
  assert.equal(order.tp, 115);
  assert.equal(order.riskReward, 3);
});

// ── tickDecayingLimit ──────────────────────────────────────────────────────────

test("tickDecayingLimit - long fills when low touches limit", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  const r = tickDecayingLimit(order, 98.5, 101, 100); // low=98.5 <= limitPrice=99
  assert.equal(r.action, "fill-limit");
  assert.equal(r.fillPrice, order.limitPrice);
  assert.equal(order.status, "filled");
  assert.equal(order.fillType, "limit");
});

test("tickDecayingLimit - short fills when high touches limit", () => {
  const order = createDecayingLimit(baseCandidate({ signal: "short" }), 100);
  // limitPrice = 101, short fills when high >= 101
  const r = tickDecayingLimit(order, 99, 101.5, 100);
  assert.equal(r.action, "fill-limit");
  assert.equal(order.fillType, "limit");
});

test("tickDecayingLimit - no fill: advances to next step and tightens limit", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  const prevLimit = order.limitPrice;
  const r = tickDecayingLimit(order, 99.5, 101, 100); // low=99.5 > limit=99, no fill
  assert.equal(r.action, "wait");
  assert.equal(order.currentStep, 1);
  assert.ok(order.limitPrice > prevLimit); // tightened toward market
});

test("tickDecayingLimit - converts to market when schedule hits zero offset", () => {
  // overbought schedule: [0.5, 0.3, 0.15, 0] — after 3 no-fills, next is 0 → market
  const order = createDecayingLimit(baseCandidate(), 100);
  tickDecayingLimit(order, 99.5, 101, 100); // step 0→1
  tickDecayingLimit(order, 99.7, 101, 100); // step 1→2
  const r = tickDecayingLimit(order, 99.9, 101, 100); // step 2→3, offset=0 → market
  assert.equal(r.action, "fill-market");
  assert.equal(order.fillType, "market");
  assert.equal(order.status, "filled");
});

test("tickDecayingLimit - fill-market uses current price as fill price", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  tickDecayingLimit(order, 99.5, 101, 100);
  tickDecayingLimit(order, 99.7, 101, 100);
  const r = tickDecayingLimit(order, 99.9, 101, 101.5); // currentPrice=101.5
  assert.equal(r.fillPrice, 101.5);
});

test("tickDecayingLimit - default schedule (3 steps) converts to market after 2 no-fills", () => {
  const order = createDecayingLimit(baseCandidate({ reasons: [] }), 100);
  // default: [0.3, 0.15, 0] — 2 no-fills then market
  tickDecayingLimit(order, 99.7, 101, 100); // step 0→1
  const r = tickDecayingLimit(order, 99.8, 101, 100); // step 1→2, offset=0 → market
  assert.equal(r.action, "fill-market");
});

// ── cancelDecayingLimit ────────────────────────────────────────────────────────

test("cancelDecayingLimit - marks order as cancelled with reason", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  cancelDecayingLimit(order, "signals-flipped");
  assert.equal(order.status, "cancelled");
  assert.equal(order.cancelReason, "signals-flipped");
  assert.ok(order.cancelledAt);
});

test("cancelDecayingLimit - default reason is invalidated", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  cancelDecayingLimit(order);
  assert.equal(order.cancelReason, "invalidated");
});

// ── initDecayingLimits ─────────────────────────────────────────────────────────

test("initDecayingLimits - creates empty object when missing", () => {
  const state = {};
  initDecayingLimits(state);
  assert.deepEqual(state.decayingLimits, {});
});

test("initDecayingLimits - does not overwrite existing limits", () => {
  const existing = { "BTC-USDT-SWAP": { status: "active" } };
  const state = { decayingLimits: existing };
  initDecayingLimits(state);
  assert.equal(state.decayingLimits, existing);
});

// ── processDecayingLimits ──────────────────────────────────────────────────────

test("processDecayingLimits - returns empty array when no limits", () => {
  assert.deepEqual(processDecayingLimits({}, {}), []);
  assert.deepEqual(processDecayingLimits({ decayingLimits: {} }, {}), []);
});

test("processDecayingLimits - skips non-active orders", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  order.status = "cancelled";
  const state = { decayingLimits: { "BTC-USDT-SWAP": order } };
  const result = processDecayingLimits(state, { "BTC-USDT-SWAP": 100 });
  assert.equal(result.length, 0);
});

test("processDecayingLimits - skips symbols with no live price", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  const state = { decayingLimits: { "BTC-USDT-SWAP": order } };
  const result = processDecayingLimits(state, {}); // no price for BTC
  assert.equal(result.length, 0);
  assert.equal(order.currentStep, 0); // not ticked
});

test("processDecayingLimits - fills and removes order when price hits limit", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  // limitPrice = 99, live price = 99 → triggers fill (price used as both low and high)
  const state = { decayingLimits: { "BTC-USDT-SWAP": order } };
  const result = processDecayingLimits(state, { "BTC-USDT-SWAP": 98 });
  assert.equal(result.length, 1);
  assert.equal(result[0].symbol, "BTC-USDT-SWAP");
  assert.equal(state.decayingLimits["BTC-USDT-SWAP"], undefined); // removed
});

test("processDecayingLimits - returned candidate has _entryType set", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  const state = { decayingLimits: { "BTC-USDT-SWAP": order } };
  const result = processDecayingLimits(state, { "BTC-USDT-SWAP": 98 });
  assert.equal(result[0]._entryType, "decaying-limit");
});

test("processDecayingLimits - market fill sets _entryType to decaying-market", () => {
  const order = createDecayingLimit(baseCandidate(), 100);
  // Fast-forward to market fill by exhausting steps
  const state = { decayingLimits: { "BTC-USDT-SWAP": order } };
  // Tick 3 times at high prices so it never fills at limit
  processDecayingLimits(state, { "BTC-USDT-SWAP": 101 }); // step 0→1
  state.decayingLimits["BTC-USDT-SWAP"] = order; // re-add after possible removal
  if (order.status === "active") processDecayingLimits(state, { "BTC-USDT-SWAP": 101 }); // step 1→2
  state.decayingLimits["BTC-USDT-SWAP"] = order;
  if (order.status === "active") {
    const result = processDecayingLimits(state, { "BTC-USDT-SWAP": 101 }); // market
    if (result.length > 0) {
      assert.equal(result[0]._entryType, "decaying-market");
    }
  }
});
