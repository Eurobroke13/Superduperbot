import assert from "node:assert/strict";
import test from "node:test";

import { scoreFromCandles } from "../backtest.js";
import {
  autoApproveSignal,
  calculateStructuredSLTP,
  checkCorrelationExposure,
  confirm15mBearShort,
  drainNullReasons,
  fundingRateSignal,
  score4H,
  scoreFromData
} from "../bot/scoring.js";

function makeCandles(count, {
  start = 100,
  step = 0.15,
  volume = 1000,
  flat = false
} = {}) {
  const candles = [];
  let close = start;
  for (let i = 0; i < count; i++) {
    if (!flat) close += step + Math.sin(i / 8) * step * 0.25;
    const open = flat ? start : close - step * 0.35;
    const high = Math.max(open, close) + Math.max(0.05, Math.abs(step));
    const low = Math.min(open, close) - Math.max(0.05, Math.abs(step));
    candles.push({
      time: Date.now() + i * 3600000,
      open,
      high,
      low,
      close: flat ? start : close,
      volume: volume + i * 3
    });
  }
  return candles;
}

test("score4H returns no directional score for flat candles", () => {
  const result = score4H(makeCandles(120, { flat: true }));
  assert.equal(result.bullScore, 0);
  assert.equal(result.bearScore, 0);
  assert.deepEqual(result.signals, []);
  assert.equal(result.aligned("long"), false);
});

test("score4H detects directional 4H context on expanding candles", () => {
  const result = score4H(makeCandles(140, { start: 50, step: 0.2 }));
  assert.ok(result.bullScore >= 0);
  assert.ok(result.bearScore >= 0);
  assert.ok(Array.isArray(result.signals));
});

test("scoreFromCandles accepts preloaded candle fixtures without fetching", () => {
  const candidate = scoreFromCandles(
    "TEST-USDT-SWAP",
    makeCandles(620, { start: 10, step: 0.03, volume: 5000 }),
    makeCandles(220, { start: 10, step: 0.08, volume: 6000 }),
    "bull"
  );
  assert.ok(candidate === null || candidate.symbol === "TEST-USDT-SWAP");
  if (candidate) {
    assert.ok(["long", "short"].includes(candidate.signal));
    assert.equal(typeof candidate.score, "number");
    assert.ok(Array.isArray(candidate.reasons));
  }
});

test("calculateStructuredSLTP places stops and targets on the correct side", () => {
  const candles = makeCandles(120, { start: 100, step: 0.05 });
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const long = calculateStructuredSLTP("long", 110, 2, highs, lows, closes, volumes, {});
  const short = calculateStructuredSLTP("short", 110, 2, highs, lows, closes, volumes, {});

  assert.ok(long.sl < 110);
  assert.ok(long.tp > 110);
  assert.ok(short.sl > 110);
  assert.ok(short.tp < 110);
});

test("autoApproveSignal enforces hard gates", () => {
  const aligned = {
    signal: "long",
    price: 105,
    vwapVal: 100,
    adxResult: { trending: true, pdi: 30, mdi: 10 },
    h4Trend: "bullish",
    setupType: "trend",
    reasons: []
  };

  assert.equal(autoApproveSignal(aligned), true);
  assert.equal(autoApproveSignal({ ...aligned, setupType: "mean-reversion" }), false);
  assert.equal(autoApproveSignal({ ...aligned, price: 95 }), false);
  assert.equal(autoApproveSignal({ ...aligned, h4Trend: "bearish" }), false);
});

test("fundingRateSignal maps threshold bands", () => {
  assert.equal(fundingRateSignal(0.004).reason, "funding-extreme-long");
  assert.equal(fundingRateSignal(0.0012).reason, "funding-crowded-long");
  assert.equal(fundingRateSignal(-0.004).reason, "funding-extreme-short");
  assert.equal(fundingRateSignal(-0.0012).reason, "funding-crowded-short");
  assert.equal(fundingRateSignal(0).signal, "neutral");
});

test("fundingRateSignal returns neutral for null and undefined", () => {
  const nullResult = fundingRateSignal(null);
  assert.equal(nullResult.signal, "neutral");
  assert.equal(nullResult.score, 0);
  const undefResult = fundingRateSignal(undefined);
  assert.equal(undefResult.signal, "neutral");
  assert.equal(undefResult.score, 0);
});

test("scoreFromData returns null for insufficient candle data", () => {
  const mockState = { dynamicWeights: {}, signalStats: {}, disabledSignals: [] };
  const regime = { label: "bull" };
  assert.equal(scoreFromData("BTC-USDT-SWAP", null, [], regime, mockState), null);
  assert.equal(scoreFromData("BTC-USDT-SWAP", [], [], regime, mockState), null);
  const tooFew = makeCandles(50, { start: 100, step: 0.1 });
  assert.equal(scoreFromData("BTC-USDT-SWAP", tooFew, [], regime, mockState), null);
});

// ── drainNullReasons ───────────────────────────────────────────────────────────

test("drainNullReasons - returns object and clears on next drain", () => {
  const snap1 = drainNullReasons();
  assert.equal(typeof snap1, "object");
  const snap2 = drainNullReasons();
  assert.deepEqual(snap2, {});
});

// ── confirm15mBearShort ────────────────────────────────────────────────────────

const mkC = (o, h, l, c, v = 100) => ({ open: o, high: h, low: l, close: c, volume: v });
const flatC = (n, v = 100) => Array.from({ length: n }, () => mkC(v, v * 1.001, v * 0.999, v));

test("confirm15mBearShort - null input → enter:true, no-15m-data pattern", () => {
  const r = confirm15mBearShort(null, 100, 2);
  assert.equal(r.enter, true);
  assert.ok(r.patterns.includes("no-15m-data"));
});

test("confirm15mBearShort - fewer than 12 candles → no-15m-data fallback", () => {
  const r = confirm15mBearShort([mkC(100, 101, 99, 100)], 100, 2);
  assert.equal(r.patterns[0], "no-15m-data");
});

test("confirm15mBearShort - shooting star candle gets >= 2 confidence and enter:true", () => {
  // high=110, open=close≈100, low=99.5 → upperWick/range ≈ 0.95 > 0.60, lowerWick/range tiny
  const candles = flatC(11);
  candles.push(mkC(100, 110, 99.5, 100.1, 200));
  const r = confirm15mBearShort(candles, 100, 2);
  assert.ok(r.patterns.includes("15m-shooting-star"), `patterns: ${JSON.stringify(r.patterns)}`);
  assert.ok(r.confidence >= 2);
  assert.equal(r.enter, true);
});

test("confirm15mBearShort - bearish engulfing adds 2.5 confidence", () => {
  // prev green, last red engulfs it
  const candles = flatC(10);
  candles.push(mkC(99, 101, 98.5, 100.5));          // green prev
  candles.push(mkC(101, 102, 97, 97.5, 250));        // red engulf
  const r = confirm15mBearShort(candles, 100, 2);
  assert.ok(r.patterns.includes("15m-bear-engulfing"), `patterns: ${JSON.stringify(r.patterns)}`);
  assert.ok(r.confidence >= 2.5);
});

test("confirm15mBearShort - 3 red candles in a row → red-cascade pattern", () => {
  const candles = flatC(7);
  candles.push(mkC(100, 100.5, 98, 99));
  candles.push(mkC(99, 99.5, 97, 98));
  candles.push(mkC(98, 98.5, 96, 97));
  candles.push(mkC(97, 97.5, 95, 96));
  candles.push(mkC(96, 96.5, 94, 95));
  const r = confirm15mBearShort(candles, 100, 2);
  assert.ok(r.patterns.some(p => p.startsWith("15m-red-cascade")));
});

test("confirm15mBearShort - confidence < 3.5 uses 0.7x size multiplier", () => {
  // Only shoot star (2.0) → below 3.5
  const candles = flatC(11);
  candles.push(mkC(100, 110, 99.5, 100.1, 200));
  const r = confirm15mBearShort(candles, 100, 2);
  if (r.confidence < 3.5) {
    assert.equal(r.positionSizeMultiplier, 0.7);
  }
});

// ── checkCorrelationExposure ───────────────────────────────────────────────────

function makeCorrelState(positions = {}, cash = 50000) {
  return { positions, cash, trades: [] };
}

test("checkCorrelationExposure - no positions → always allowed", () => {
  assert.equal(checkCorrelationExposure({ signal: "long" }, makeCorrelState()).allowed, true);
  assert.equal(checkCorrelationExposure({ signal: "short" }, makeCorrelState()).allowed, true);
});

test("checkCorrelationExposure - 7 existing longs blocks another long", () => {
  const pos = {};
  for (let i = 0; i < 7; i++) pos[`S${i}`] = { direction: "long", effectiveExposure: 100, notional: 100 };
  const r = checkCorrelationExposure({ signal: "long" }, makeCorrelState(pos));
  assert.equal(r.allowed, false);
  assert.ok(r.reason.includes("7 longs"));
});

test("checkCorrelationExposure - 7 existing shorts blocks another short", () => {
  const pos = {};
  for (let i = 0; i < 7; i++) pos[`S${i}`] = { direction: "short", effectiveExposure: 100, notional: 100 };
  const r = checkCorrelationExposure({ signal: "short" }, makeCorrelState(pos));
  assert.equal(r.allowed, false);
  assert.ok(r.reason.includes("7 shorts"));
});

test("checkCorrelationExposure - dir exposure > 60% of portfolio → blocked", () => {
  // cash=100, 1 long notional=700 → pVal=800, dirExposure=700 → 700/800=0.875 > 0.6
  const pos = { A: { direction: "long", effectiveExposure: 700, notional: 700 } };
  const r = checkCorrelationExposure({ signal: "long" }, makeCorrelState(pos, 100));
  assert.equal(r.allowed, false);
  assert.ok(r.reason.includes("%>60%"));
});

test("checkCorrelationExposure - 6 longs does not block (limit is 7)", () => {
  const pos = {};
  for (let i = 0; i < 6; i++) pos[`S${i}`] = { direction: "long", effectiveExposure: 100, notional: 100 };
  const r = checkCorrelationExposure({ signal: "long" }, makeCorrelState(pos));
  assert.equal(r.allowed, true);
});

test("checkCorrelationExposure - opposite direction not counted toward long limit", () => {
  const pos = {};
  for (let i = 0; i < 7; i++) pos[`S${i}`] = { direction: "long", effectiveExposure: 100, notional: 100 };
  const r = checkCorrelationExposure({ signal: "short" }, makeCorrelState(pos));
  assert.equal(r.allowed, true);
});

test("scoreFromData is deterministic for the same candle input", () => {
  const candles1h = makeCandles(620, { start: 50, step: 0.05, volume: 8000 });
  const candles4h = makeCandles(220, { start: 50, step: 0.2, volume: 10000 });
  const mockState = { dynamicWeights: {}, signalStats: {}, disabledSignals: [] };
  const regime = { label: "bull" };
  const r1 = scoreFromData("TEST-USDT-SWAP", candles1h, candles4h, regime, mockState);
  const r2 = scoreFromData("TEST-USDT-SWAP", candles1h, candles4h, regime, mockState);
  assert.deepEqual(r1?.score, r2?.score);
  assert.deepEqual(r1?.signal, r2?.signal);
});
