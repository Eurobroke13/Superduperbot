import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEntryFilters
} from "../bot/entry-policy.js";
import {
  createPendingLimit,
  tickPendingLimit
} from "../bot/limit-entry-engine.js";
import {
  isOnCooldown
} from "../bot/cooldown.js";

test("isOnCooldown distinguishes active and expired entries", () => {
  const active = {
    "BTC-USDT-SWAP": { expiresAt: new Date(Date.now() + 60_000).toISOString() }
  };
  assert.equal(isOnCooldown(active, "BTC-USDT-SWAP").onCooldown, true);

  const expired = {
    "ETH-USDT-SWAP": { expiresAt: new Date(Date.now() - 60_000).toISOString() }
  };
  assert.equal(isOnCooldown(expired, "ETH-USDT-SWAP").onCooldown, false);
  assert.equal(expired["ETH-USDT-SWAP"], undefined);
});

test("applyEntryFilters records EMA distance penalty without mutating raw score", () => {
  const candidate = {
    symbol: "TEST-USDT-SWAP",
    signal: "long",
    score: 6,
    price: 110,
    ema21: 100,
    atrVal: 5,
    reasons: ["trend-vs-overbought"]
  };

  const result = applyEntryFilters(candidate, {
    enableEmaDistanceGate: true,
    emaGate: { warningThreshold: 1.5, blockThreshold: 2.5, scorePenalty: 1 }
  });

  assert.equal(result.action, "allow");
  assert.equal(candidate.score, 6);
  assert.equal(result.candidate.rawScore, 6);
  assert.equal(result.candidate.adjustedScore, 5);
  assert.ok(result.candidate.reasons.some((reason) => reason.startsWith("ema-distance-penalty")));
});

test("tickPendingLimit fills and cancels pending limits", () => {
  const candidate = {
    symbol: "TEST-USDT-SWAP",
    score: 5,
    signalSet: ["trend-vs-overbought"],
    leverage: 2,
    atrVal: 1
  };

  const longPending = createPendingLimit(candidate, {
    direction: "long",
    limitPrice: 99,
    maxCandles: 2,
    setupType: "trend",
    currentPrice: 100,
    improvement: 1,
    adjustments: []
  });
  assert.equal(tickPendingLimit(longPending, { high: 101, low: 98, close: 100 }).action, "fill");

  const shortPending = createPendingLimit(candidate, {
    direction: "short",
    limitPrice: 101,
    maxCandles: 1,
    setupType: "trend",
    currentPrice: 100,
    improvement: 1,
    adjustments: []
  });
  const cancelled = tickPendingLimit(shortPending, { high: 100.5, low: 99, close: 100 });
  assert.equal(cancelled.action, "cancel");
  assert.equal(cancelled.reason, "expired");
});
