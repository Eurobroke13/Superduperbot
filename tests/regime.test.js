/**
 * Unit tests for bot/regime.js
 * detectBearSignals (pure), detectRegime (pure — mutates state.hmmParams/markovChain only).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { detectBearSignals, detectRegime } from "../bot/regime.js";

// ── helpers ────────────────────────────────────────────────────────────────────

/** n candles trending: close = start + i*step */
function trend(n, start = 100, step = 1) {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * step;
    return { open: c - step * 0.3, high: c + step * 0.2, low: c - step * 0.5, close: c, volume: 1000 };
  });
}

/** n flat candles */
function flat(n, price = 100) {
  return Array.from({ length: n }, () => ({ open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 1000 }));
}

// ── detectBearSignals ──────────────────────────────────────────────────────────

test("detectBearSignals - no signals → bearStrength 0", () => {
  const closes = Array.from({ length: 250 }, (_, i) => 100 + i * 0.1); // uptrend, no death cross
  const highs  = closes.map(c => c + 0.5);
  const lows   = closes.map(c => c - 0.5);
  const adx = { trending: true, pdi: 30, mdi: 10 }; // bullish adx
  const r = detectBearSignals(closes, highs, lows, 2, adx, 55, null);
  assert.equal(r.bearStrength, 0);
  assert.deepEqual(r.signals, []);
});

test("detectBearSignals - 4H lower highs adds 2 points", () => {
  // candles4h where last 5 highs are lower than previous 5
  const candles4h = [
    ...Array.from({ length: 5 }, (_, i) => ({ high: 110 + i, low: 100, close: 105 })),  // prev block: 110-114
    ...Array.from({ length: 5 }, (_, i) => ({ high: 105 + i, low: 95, close: 100 }))    // recent block: 105-109 < prev max 114
  ];
  const closes = Array(250).fill(100);
  const highs  = closes.map(c => c + 1);
  const lows   = closes.map(c => c - 1);
  const r = detectBearSignals(closes, highs, lows, 2, {}, 50, candles4h);
  assert.ok(r.signals.includes("4h-lower-highs"));
  assert.ok(r.bearStrength >= 2);
});

test("detectBearSignals - ADX downtrend adds 1 point", () => {
  const closes = Array(250).fill(100);
  const highs  = closes.map(c => c + 1);
  const lows   = closes.map(c => c - 1);
  const adx = { trending: true, pdi: 10, mdi: 30 }; // bearish ADX
  const r = detectBearSignals(closes, highs, lows, 2, adx, 50, null);
  assert.ok(r.signals.includes("adx-downtrend"));
  assert.ok(r.bearStrength >= 1);
});

test("detectBearSignals - death cross (MA50 < MA200) adds 1 point", () => {
  // declining prices: MA50 will be lower than MA200
  const closes = Array.from({ length: 250 }, (_, i) => 200 - i * 0.5);
  const highs  = closes.map(c => c + 1);
  const lows   = closes.map(c => c - 1);
  const r = detectBearSignals(closes, highs, lows, 2, {}, 50, null);
  assert.ok(r.signals.includes("death-cross"));
  assert.ok(r.bearStrength >= 1);
});

test("detectBearSignals - RSI < 40 adds 1 point", () => {
  const closes = Array(250).fill(100);
  const highs  = closes.map(c => c + 1);
  const lows   = closes.map(c => c - 1);
  const r = detectBearSignals(closes, highs, lows, 2, {}, 35, null); // rsiVal=35 < 40
  assert.ok(r.signals.includes("rsi-compression"));
  assert.ok(r.bearStrength >= 1);
});

test("detectBearSignals - RSI >= 40 does not add rsi-compression", () => {
  const closes = Array(250).fill(100);
  const highs  = closes.map(c => c + 1);
  const lows   = closes.map(c => c - 1);
  const r = detectBearSignals(closes, highs, lows, 2, {}, 45, null);
  assert.ok(!r.signals.includes("rsi-compression"));
});

test("detectBearSignals - bearStrength is capped at 5", () => {
  // Trigger all 4 signals: should give 2+1+1+1=5, capped at 5
  const closes = Array.from({ length: 250 }, (_, i) => 200 - i * 0.5); // declining → death cross
  const highs  = closes.map(c => c + 1);
  const lows   = closes.map(c => c - 1);
  const adx    = { trending: true, pdi: 10, mdi: 30 };
  const candles4h = [
    ...Array.from({ length: 5 }, () => ({ high: 115, low: 100, close: 105 })),
    ...Array.from({ length: 5 }, () => ({ high: 105, low: 90,  close: 95 }))
  ];
  const r = detectBearSignals(closes, highs, lows, 2, adx, 35, candles4h);
  assert.ok(r.bearStrength <= 5);
});

test("detectBearSignals - null candles4h skips 4H lower-highs check", () => {
  const closes = Array(250).fill(100);
  const highs  = closes.map(c => c + 1);
  const lows   = closes.map(c => c - 1);
  const r = detectBearSignals(closes, highs, lows, 2, {}, 50, null);
  assert.ok(!r.signals.includes("4h-lower-highs"));
});

// ── detectRegime ───────────────────────────────────────────────────────────────

test("detectRegime - returns label, hmmState, piCycle, markovProb", () => {
  const candles = trend(400, 100, 0.5); // 400 candles, gentle uptrend
  const state = {};
  const r = detectRegime(candles, state);
  assert.ok(["bull", "bear", "sideways"].includes(r.label));
  assert.ok([0, 1].includes(r.hmmState));
  assert.ok(typeof r.markovProb === "number");
  assert.ok(typeof r.piCycle === "string");
});

test("detectRegime - saves hmmParams and markovChain back to state", () => {
  const candles = trend(400, 100, 0.5);
  const state = {};
  detectRegime(candles, state);
  assert.ok(state.hmmParams);
  assert.ok(state.markovChain);
});

test("detectRegime - subsequent call uses updated hmmParams (no crash)", () => {
  const candles = trend(400, 100, 0.5);
  const state = {};
  detectRegime(candles, state);
  // Second call should use saved params without throwing
  assert.doesNotThrow(() => detectRegime(candles, state));
});

test("detectRegime - strong uptrend produces a valid label", () => {
  // 400 candles strongly trending up
  const candles = trend(400, 100, 1.0);
  const state = {};
  const r = detectRegime(candles, state);
  assert.ok(["bull", "bear", "sideways"].includes(r.label));
});

test("detectRegime - flat market produces sideways label", () => {
  const candles = flat(400, 100);
  const state = {};
  const r = detectRegime(candles, state);
  assert.equal(r.label, "sideways");
});

test("detectRegime - piCycle is unknown when not enough candles for MA350", () => {
  const candles = trend(200, 100, 0.5); // only 200 candles, MA350 needs 350
  const state = {};
  const r = detectRegime(candles, state);
  assert.equal(r.piCycle, "unknown");
});

test("detectRegime - sidewaysConfidence is a number 0..1", () => {
  const candles = trend(400, 100, 0.5);
  const state = {};
  const r = detectRegime(candles, state);
  assert.ok(r.sidewaysConfidence >= 0 && r.sidewaysConfidence <= 1);
});
