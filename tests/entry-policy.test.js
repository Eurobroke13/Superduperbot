/**
 * Unit tests for bot/entry-policy.js and related helpers.
 * ensureEntryPolicyState, pruneEntryCooldowns, cooldownDecision,
 * applyEntryFilters, queueEntry, tickEntryPolicy, pendingEntrySymbols
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEntryFilters,
  ensureEntryPolicyState,
  pruneEntryCooldowns,
  cooldownDecision,
  queueEntry,
  tickEntryPolicy,
  pendingEntrySymbols,
} from "../bot/entry-policy.js";
import {
  createPendingLimit,
  tickPendingLimit,
} from "../bot/limit-entry-engine.js";
import { isOnCooldown } from "../bot/cooldown.js";

// ── helpers ────────────────────────────────────────────────────────────────────

function freshState(overrides = {}) {
  return {
    cash: 10000,
    positions: {},
    trades: [],
    cooldowns: {},
    decayingLimits: {},
    pendingLimits: {},
    pendingRetests: {},
    ...overrides,
  };
}

function baseCandidate(overrides = {}) {
  return {
    symbol: "BTC-USDT-SWAP",
    signal: "long",
    score: 6,
    price: 100,
    atrVal: 2,
    ema21: 95,
    reasons: ["ema-ribbon"],
    setupType: "trend",
    leverage: 5,
    sl: 96,
    tp: 110,
    riskReward: 2,
    ...overrides,
  };
}

// ── isOnCooldown (sanity check) ────────────────────────────────────────────────

test("isOnCooldown distinguishes active and expired entries", () => {
  const active = {
    "BTC-USDT-SWAP": { expiresAt: new Date(Date.now() + 60_000).toISOString() },
  };
  assert.equal(isOnCooldown(active, "BTC-USDT-SWAP").onCooldown, true);

  const expired = {
    "ETH-USDT-SWAP": { expiresAt: new Date(Date.now() - 60_000).toISOString() },
  };
  assert.equal(isOnCooldown(expired, "ETH-USDT-SWAP").onCooldown, false);
  assert.equal(expired["ETH-USDT-SWAP"], undefined);
});

// ── ensureEntryPolicyState ─────────────────────────────────────────────────────

test("ensureEntryPolicyState - creates all required fields when missing", () => {
  const state = {};
  ensureEntryPolicyState(state);
  assert.ok(typeof state.cooldowns === "object" && !Array.isArray(state.cooldowns));
  assert.ok(typeof state.decayingLimits === "object" && !Array.isArray(state.decayingLimits));
  assert.ok(typeof state.pendingLimits === "object" && !Array.isArray(state.pendingLimits));
  assert.ok(typeof state.pendingRetests === "object" && !Array.isArray(state.pendingRetests));
});

test("ensureEntryPolicyState - does not overwrite existing cooldowns", () => {
  const cooldowns = { "BTC-USDT-SWAP": { expiresAt: "2099-01-01T00:00:00Z" } };
  const state = { cooldowns };
  ensureEntryPolicyState(state);
  assert.equal(state.cooldowns, cooldowns);
});

test("ensureEntryPolicyState - resets array-typed pendingLimits to object", () => {
  const state = { pendingLimits: [] };
  ensureEntryPolicyState(state);
  assert.ok(!Array.isArray(state.pendingLimits));
  assert.equal(typeof state.pendingLimits, "object");
});

// ── pruneEntryCooldowns ────────────────────────────────────────────────────────

test("pruneEntryCooldowns - removes expired cooldowns from state", () => {
  const state = freshState({
    cooldowns: {
      "BTC-USDT-SWAP": { expiresAt: new Date(Date.now() - 10000).toISOString() },
      "ETH-USDT-SWAP": { expiresAt: new Date(Date.now() + 10000).toISOString() },
    },
  });
  pruneEntryCooldowns(state);
  assert.equal(state.cooldowns["BTC-USDT-SWAP"], undefined);
  assert.ok(state.cooldowns["ETH-USDT-SWAP"]);
});

test("pruneEntryCooldowns - no-op on empty cooldowns", () => {
  const state = freshState();
  assert.doesNotThrow(() => pruneEntryCooldowns(state));
  assert.deepEqual(state.cooldowns, {});
});

// ── cooldownDecision ───────────────────────────────────────────────────────────

test("cooldownDecision - returns onCooldown:true when symbol is on cooldown", () => {
  const state = freshState({
    cooldowns: {
      "BTC-USDT-SWAP": { expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    },
  });
  const r = cooldownDecision(state, "BTC-USDT-SWAP");
  assert.equal(r.onCooldown, true);
  assert.ok(r.expiresAt);
});

test("cooldownDecision - returns onCooldown:false when symbol has no cooldown", () => {
  const state = freshState();
  const r = cooldownDecision(state, "BTC-USDT-SWAP");
  assert.equal(r.onCooldown, false);
});

test("cooldownDecision - returns onCooldown:false when cooldown is expired", () => {
  const state = freshState({
    cooldowns: {
      "BTC-USDT-SWAP": { expiresAt: new Date(Date.now() - 1000).toISOString() },
    },
  });
  const r = cooldownDecision(state, "BTC-USDT-SWAP");
  assert.equal(r.onCooldown, false);
});

// ── applyEntryFilters ──────────────────────────────────────────────────────────

test("applyEntryFilters records EMA distance penalty without mutating raw score", () => {
  const candidate = {
    symbol: "TEST-USDT-SWAP",
    signal: "long",
    score: 6,
    price: 110,
    ema21: 100,
    atrVal: 5,
    reasons: ["trend-vs-overbought"],
  };

  const result = applyEntryFilters(candidate, {
    enableEmaDistanceGate: true,
    emaGate: { warningThreshold: 1.5, blockThreshold: 2.5, scorePenalty: 1 },
  });

  assert.equal(result.action, "allow");
  assert.equal(candidate.score, 6); // original untouched
  assert.equal(result.candidate.rawScore, 6);
  assert.equal(result.candidate.adjustedScore, 5);
  assert.ok(
    result.candidate.reasons.some((r) => r.startsWith("ema-distance-penalty"))
  );
});

test("applyEntryFilters - blocks when EMA distance exceeds blockThreshold (1.8 ATR default)", () => {
  // price=100, ema21=82, atrVal=5 → dist=18/5=3.6 ATR > default blockThreshold=1.8
  const candidate = baseCandidate({
    price: 100,
    ema21: 82,
    atrVal: 5,
    reasons: ["trend-vs-overbought"],
  });
  const result = applyEntryFilters(candidate, { enableEmaDistanceGate: true });
  assert.equal(result.action, "block");
});

test("applyEntryFilters - allows non-overbought signal even with large EMA distance", () => {
  // ema gate only applies to overbought/oversold signals
  const candidate = baseCandidate({ price: 100, ema21: 50, atrVal: 2, reasons: ["ema-ribbon"] });
  const result = applyEntryFilters(candidate, { enableEmaDistanceGate: true });
  assert.equal(result.action, "allow");
});

test("applyEntryFilters - disabled gate always allows", () => {
  const candidate = baseCandidate({
    price: 100,
    ema21: 50,
    atrVal: 2,
    reasons: ["trend-vs-overbought"],
  });
  const result = applyEntryFilters(candidate, { enableEmaDistanceGate: false });
  assert.equal(result.action, "allow");
});

test("applyEntryFilters - candidate in result has rawScore field for overbought", () => {
  const candidate = baseCandidate({ reasons: ["trend-vs-overbought"], ema21: 98, atrVal: 2 });
  const result = applyEntryFilters(candidate, { enableEmaDistanceGate: true });
  assert.ok("rawScore" in result.candidate);
});

// ── queueEntry ─────────────────────────────────────────────────────────────────

test("queueEntry - overbought signal queues as decaying limit", () => {
  const state = freshState();
  const candidate = baseCandidate({ reasons: ["trend-vs-overbought"] });
  const r = queueEntry(candidate, state, { "BTC-USDT-SWAP": 100 });
  assert.equal(r.action, "queued-decaying-limit");
  assert.ok(state.decayingLimits["BTC-USDT-SWAP"]);
});

test("queueEntry - ordinary signal with atrVal=0 falls back to market entry", () => {
  const state = freshState();
  const candidate = baseCandidate({ reasons: ["ema-ribbon"], atrVal: 0 });
  const r = queueEntry(candidate, state, { "BTC-USDT-SWAP": 100 });
  assert.equal(r.action, "enter-market");
});

test("queueEntry - oversold signal also queues as decaying limit", () => {
  const state = freshState();
  const candidate = baseCandidate({ signal: "short", reasons: ["trend-vs-oversold"] });
  const r = queueEntry(candidate, state, { "BTC-USDT-SWAP": 100 });
  assert.equal(r.action, "queued-decaying-limit");
});

test("queueEntry - returns symbol and limitPrice in result", () => {
  const state = freshState();
  const candidate = baseCandidate({ reasons: ["trend-vs-overbought"] });
  const r = queueEntry(candidate, state, { "BTC-USDT-SWAP": 100 });
  assert.equal(r.symbol, "BTC-USDT-SWAP");
  assert.ok(Number.isFinite(r.limitPrice));
});

// ── tickEntryPolicy ────────────────────────────────────────────────────────────

test("tickEntryPolicy - returns null or object (does not throw)", () => {
  const state = freshState();
  assert.doesNotThrow(() => tickEntryPolicy(state, "BTC-USDT-SWAP", { high: 101, low: 99, close: 100 }));
});

test("tickEntryPolicy - fills decaying limit when candle low touches limit", () => {
  const state = freshState();
  const candidate = baseCandidate({ reasons: ["trend-vs-overbought"] });
  queueEntry(candidate, state, { "BTC-USDT-SWAP": 100 });

  // limitPrice = 100 - 0.5×2 = 99; trigger with candle low=98
  const result = tickEntryPolicy(state, "BTC-USDT-SWAP", { high: 101, low: 98, close: 100 });
  assert.ok(result);
  assert.equal(result.action, "fill");
  assert.ok(result.candidate);
  assert.equal(state.decayingLimits["BTC-USDT-SWAP"], undefined);
});

test("tickEntryPolicy - returns action:none when symbol has no pending orders", () => {
  const state = freshState();
  const result = tickEntryPolicy(state, "BTC-USDT-SWAP", { high: 101, low: 99, close: 100 });
  assert.ok(result);
  assert.equal(result.action, "none");
});

test("tickEntryPolicy - advances step when price does not fill", () => {
  const state = freshState();
  const candidate = baseCandidate({ reasons: ["trend-vs-overbought"] });
  queueEntry(candidate, state, { "BTC-USDT-SWAP": 100 });

  const order = state.decayingLimits["BTC-USDT-SWAP"];
  assert.ok(order);
  const stepBefore = order.currentStep ?? 0;

  // candle low=99.5 > limitPrice=99 → no fill, step advances
  tickEntryPolicy(state, "BTC-USDT-SWAP", { high: 101, low: 99.5, close: 100 });

  if (state.decayingLimits["BTC-USDT-SWAP"]) {
    assert.ok(state.decayingLimits["BTC-USDT-SWAP"].currentStep > stepBefore);
  }
});

// ── pendingEntrySymbols ────────────────────────────────────────────────────────

test("pendingEntrySymbols - returns empty array when all queues empty", () => {
  const state = freshState();
  assert.deepEqual(pendingEntrySymbols(state), []);
});

test("pendingEntrySymbols - includes symbols from decayingLimits", () => {
  const state = freshState({
    decayingLimits: { "BTC-USDT-SWAP": { status: "active" } },
  });
  assert.ok(pendingEntrySymbols(state).includes("BTC-USDT-SWAP"));
});

test("pendingEntrySymbols - includes symbols from pendingLimits", () => {
  const state = freshState({
    pendingLimits: { "ETH-USDT-SWAP": { status: "active" } },
  });
  assert.ok(pendingEntrySymbols(state).includes("ETH-USDT-SWAP"));
});

test("pendingEntrySymbols - includes symbols from pendingRetests", () => {
  const state = freshState({
    pendingRetests: { "SOL-USDT-SWAP": { status: "active" } },
  });
  assert.ok(pendingEntrySymbols(state).includes("SOL-USDT-SWAP"));
});

test("pendingEntrySymbols - deduplicates symbols across all queues", () => {
  const state = freshState({
    decayingLimits: { "BTC-USDT-SWAP": { status: "active" } },
    pendingLimits: { "BTC-USDT-SWAP": { status: "active" } },
    pendingRetests: { "BTC-USDT-SWAP": { status: "active" } },
  });
  const syms = pendingEntrySymbols(state);
  const btcCount = syms.filter((s) => s === "BTC-USDT-SWAP").length;
  assert.equal(btcCount, 1);
});

test("pendingEntrySymbols - returns all unique symbols across all 3 queues", () => {
  const state = freshState({
    decayingLimits: { "BTC-USDT-SWAP": { status: "active" } },
    pendingLimits: { "ETH-USDT-SWAP": { status: "active" } },
    pendingRetests: { "SOL-USDT-SWAP": { status: "active" } },
  });
  const syms = pendingEntrySymbols(state);
  assert.ok(syms.includes("BTC-USDT-SWAP"));
  assert.ok(syms.includes("ETH-USDT-SWAP"));
  assert.ok(syms.includes("SOL-USDT-SWAP"));
  assert.equal(syms.length, 3);
});

// ── tickPendingLimit (limit-entry-engine helper) ───────────────────────────────

test("tickPendingLimit fills and cancels pending limits", () => {
  const candidate = {
    symbol: "TEST-USDT-SWAP",
    score: 5,
    signalSet: ["trend-vs-overbought"],
    leverage: 2,
    atrVal: 1,
  };

  const longPending = createPendingLimit(candidate, {
    direction: "long",
    limitPrice: 99,
    maxCandles: 2,
    setupType: "trend",
    currentPrice: 100,
    improvement: 1,
    adjustments: [],
  });
  assert.equal(
    tickPendingLimit(longPending, { high: 101, low: 98, close: 100 }).action,
    "fill"
  );

  const shortPending = createPendingLimit(candidate, {
    direction: "short",
    limitPrice: 101,
    maxCandles: 1,
    setupType: "trend",
    currentPrice: 100,
    improvement: 1,
    adjustments: [],
  });
  const cancelled = tickPendingLimit(shortPending, {
    high: 100.5,
    low: 99,
    close: 100,
  });
  assert.equal(cancelled.action, "cancel");
  assert.equal(cancelled.reason, "expired");
});
