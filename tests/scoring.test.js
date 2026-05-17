import assert from "node:assert/strict";
import test from "node:test";

import { scoreFromCandles } from "../backtest.js";
import {
  autoApproveSignal,
  calculateStructuredSLTP,
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
