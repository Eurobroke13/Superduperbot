/**
 * Unit tests for bot/limit-entry-engine.js — the selective limit-order engine.
 * Entirely pure (no DB/network), so every export is tested directly with
 * hand-computed expectations.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SETUP_PROFILES,
  shouldUseLimit,
  calcLimitPrice,
  decideEntry,
  createPendingLimit,
  tickPendingLimit,
  cancelPendingLimit,
  toOrderParams,
  calcImprovement,
  backtestLimitEntries
} from "../bot/limit-entry-engine.js";

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ── shouldUseLimit ─────────────────────────────────────────────────────────────

test("shouldUseLimit - overbought signal demands a pullback", () => {
  const r = shouldUseLimit({ signalSet: ["trend-vs-overbought"] });
  assert.equal(r.useLimit, true);
});

test("shouldUseLimit - oversold signal demands a pullback", () => {
  assert.equal(shouldUseLimit({ signalSet: ["trend-vs-oversold"] }).useLimit, true);
});

test("shouldUseLimit - ordinary signals use market entry", () => {
  assert.equal(shouldUseLimit({ signalSet: ["volume", "adx-strong-bull"] }).useLimit, false);
});

// ── calcLimitPrice ─────────────────────────────────────────────────────────────

test("calcLimitPrice - high-score trend tightens the offset (long)", () => {
  // trend base 0.5, score 8 → factor 0.6 → 0.3 ATR offset
  const r = calcLimitPrice({
    currentPrice: 100, atrVal: 2, direction: "long",
    setupType: "trend", score: 8, signalSet: []
  });
  assert.ok(approx(r.atrOffset, 0.3));
  assert.ok(approx(r.limitPrice, 99.4));   // 100 - 0.3*2
  assert.equal(r.maxCandles, SETUP_PROFILES.trend.maxCandles);
  assert.ok(approx(r.improvement, 0.6));   // |100-99.4|/100*100
});

test("calcLimitPrice - widen signal pushes the limit further from price", () => {
  // trend base 0.5, score 5 → factor 1.0, rsi-overbought widen 1.2 → 0.6
  const r = calcLimitPrice({
    currentPrice: 100, atrVal: 2, direction: "long",
    setupType: "trend", score: 5, signalSet: ["rsi-overbought"]
  });
  assert.ok(approx(r.atrOffset, 0.6));
  assert.ok(approx(r.limitPrice, 98.8));   // 100 - 0.6*2
});

test("calcLimitPrice - short places the limit above current price", () => {
  const r = calcLimitPrice({
    currentPrice: 100, atrVal: 2, direction: "short",
    setupType: "trend", score: 8, signalSet: []
  });
  assert.ok(r.limitPrice > 100);
  assert.ok(approx(r.limitPrice, 100.6));  // 100 + 0.3*2
});

test("calcLimitPrice - offset is always clamped to [0.1, 1.5]", () => {
  const wide = calcLimitPrice({
    currentPrice: 100, atrVal: 2, direction: "long",
    setupType: "unknown", score: 0,
    signalSet: ["trend-vs-overbought", "rsi-overbought", "bb-overbought", "fisher-overbought"]
  });
  assert.ok(wide.atrOffset >= 0.1 && wide.atrOffset <= 1.5);
});

test("calcLimitPrice - unknown setup falls back to the default profile", () => {
  const r = calcLimitPrice({
    currentPrice: 100, atrVal: 1, direction: "long",
    setupType: "no-such-setup", score: 5, signalSet: []
  });
  assert.ok(approx(r.atrOffset, SETUP_PROFILES.unknown.atrOffset));
});

// ── createPendingLimit ─────────────────────────────────────────────────────────

test("createPendingLimit - copies candidate + limit fields, starts pending", () => {
  const candidate = {
    symbol: "BTC-USDT-SWAP", score: 7, signalSet: ["volume"],
    leverage: 5, atrVal: 2, notional: 1000, size: 0.1
  };
  const limitCalc = {
    direction: "long", limitPrice: 99, maxCandles: 3, setupType: "trend",
    currentPrice: 100, improvement: 1.0, adjustments: []
  };
  const p = createPendingLimit(candidate, limitCalc);
  assert.equal(p.symbol, "BTC-USDT-SWAP");
  assert.equal(p.status, "pending");
  assert.equal(p.candlesElapsed, 0);
  assert.equal(p.limitPrice, 99);
  assert.equal(p.marketPriceAtSignal, 100);
  assert.notEqual(p.signalSet, candidate.signalSet); // cloned array
  assert.deepEqual(p.signalSet, ["volume"]);
});

// ── tickPendingLimit ───────────────────────────────────────────────────────────

test("tickPendingLimit - long fills when candle low touches limit", () => {
  const pending = { direction: "long", limitPrice: 99, candlesElapsed: 0, maxCandles: 3 };
  const r = tickPendingLimit(pending, { low: 98, high: 101, time: "t1" });
  assert.equal(r.action, "fill");
  assert.equal(r.fillPrice, 99);
  assert.equal(pending.status, "filled");
});

test("tickPendingLimit - short fills when candle high touches limit", () => {
  const pending = { direction: "short", limitPrice: 101, candlesElapsed: 0, maxCandles: 3 };
  const r = tickPendingLimit(pending, { low: 99, high: 102 });
  assert.equal(r.action, "fill");
});

test("tickPendingLimit - waits when neither fill nor expiry", () => {
  const pending = { direction: "long", limitPrice: 99, candlesElapsed: 0, maxCandles: 3 };
  const r = tickPendingLimit(pending, { low: 99.5, high: 101 });
  assert.equal(r.action, "wait");
  assert.equal(pending.candlesElapsed, 1);
});

test("tickPendingLimit - cancels on expiry at maxCandles", () => {
  const pending = { direction: "long", limitPrice: 99, candlesElapsed: 2, maxCandles: 3 };
  const r = tickPendingLimit(pending, { low: 99.5, high: 101 });
  assert.equal(r.action, "cancel");
  assert.equal(r.reason, "expired");
  assert.equal(pending.status, "cancelled");
});

// ── cancelPendingLimit ─────────────────────────────────────────────────────────

test("cancelPendingLimit - marks cancelled with reason", () => {
  const p = cancelPendingLimit({ status: "pending" }, "signals-flipped");
  assert.equal(p.status, "cancelled");
  assert.equal(p.cancelReason, "signals-flipped");
  assert.ok(p.cancelledAt);
});

// ── toOrderParams ──────────────────────────────────────────────────────────────

test("toOrderParams - maps a filled limit to exchange order params", () => {
  const filled = {
    symbol: "ETH-USDT-SWAP", direction: "short", limitPrice: 200, leverage: 3,
    size: 1, notional: 600, marketPriceAtSignal: 198, improvement: 1.0,
    setupType: "trend", score: 7, candlesElapsed: 2
  };
  const o = toOrderParams(filled);
  assert.equal(o.side, "sell");
  assert.equal(o.type, "limit");
  assert.equal(o.price, 200);
  assert.equal(o._entryType, "limit");
  assert.equal(o._candlesWaited, 2);
});

// ── calcImprovement ────────────────────────────────────────────────────────────

test("calcImprovement - long limit entry beats market by entry delta", () => {
  const filled = { limitPrice: 99, marketPriceAtSignal: 100, direction: "long", candlesElapsed: 1 };
  const r = calcImprovement(filled, 110, 2);
  assert.equal(r.marketEntryPnlPct, 20);          // (110-100)/100*100*2
  assert.ok(approx(r.limitEntryPnlPct, 22.22, 0.01)); // (110-99)/99*100*2
  assert.ok(r.improvementPct > 0);
  assert.equal(r.entryImprovement, 1);
});

test("calcImprovement - short limit entry math", () => {
  const filled = { limitPrice: 101, marketPriceAtSignal: 100, direction: "short", candlesElapsed: 1 };
  const r = calcImprovement(filled, 90, 1);
  assert.equal(r.marketEntryPnlPct, 10);          // (100-90)/100*100
  assert.ok(r.limitEntryPnlPct > r.marketEntryPnlPct); // better entry from above
});

// ── decideEntry ────────────────────────────────────────────────────────────────

test("decideEntry - ordinary candidate returns a market instruction", () => {
  const r = decideEntry(
    { setupType: "trend", score: 6, signalSet: ["volume"], atrVal: 2, signal: "long" },
    { currentPrice: 100, ema21: 99 }
  );
  assert.equal(r.type, "market");
});

test("decideEntry - overbought candidate returns a limit instruction", () => {
  const r = decideEntry(
    { setupType: "trend", score: 6, signalSet: ["trend-vs-overbought"], atrVal: 2, signal: "long" },
    { currentPrice: 100, ema21: 99 }
  );
  assert.equal(r.type, "limit");
  assert.ok(r.limitPrice < 100);
});

// ── backtestLimitEntries ────────────────────────────────────────────────────────

test("backtestLimitEntries - counts fills, misses, and fill rate", () => {
  const trades = [
    { symbol: "A", entryPrice: 100, atrVal: 2, direction: "long", setupType: "trend", score: 5, openedAt: "t" },
    { symbol: "B", entryPrice: 100, atrVal: 2, direction: "long", setupType: "trend", score: 5, openedAt: "t" }
  ];
  // A dips to fill; B never does
  const getCandlesFn = (symbol) =>
    symbol === "A" ? [{ low: 90, high: 101 }] : [{ low: 99.9, high: 101 }];
  const r = backtestLimitEntries(trades, getCandlesFn);
  assert.equal(r.total, 2);
  assert.equal(r.improved, 1);
  assert.equal(r.missed, 1);
  assert.equal(r.fillRate, 50);
});

test("backtestLimitEntries - skips trades with no candle data", () => {
  const trades = [{ symbol: "A", entryPrice: 100, atrVal: 2, direction: "long", openedAt: "t" }];
  const r = backtestLimitEntries(trades, () => []);
  assert.equal(r.total, 0);
});
