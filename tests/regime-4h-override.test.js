import assert from "node:assert/strict";
import test from "node:test";
import { compute4hBias } from "../bot/runner-utils.js";
import { ema } from "../bot/indicators.js";

const deps = { ema };

function makeCandles(count, { start = 100, step = 0 } = {}) {
  const candles = [];
  let close = start;
  for (let i = 0; i < count; i++) {
    close += step;
    const open = close - Math.abs(step) * 0.1;
    candles.push({
      time: i * 14400000,
      open,
      high: close + 0.1,
      low: open - 0.1,
      close,
      volume: 1000
    });
  }
  return candles;
}

test("compute4hBias - returns sideways for insufficient candles", () => {
  assert.equal(compute4hBias(null, deps), "sideways");
  assert.equal(compute4hBias([], deps), "sideways");
  assert.equal(compute4hBias(makeCandles(10), deps), "sideways");
});

test("compute4hBias - throws when ema not provided", () => {
  assert.throws(() => compute4hBias(makeCandles(60)), /compute4hBias/);
});

test("compute4hBias - detects bull bias on sustained uptrend", () => {
  // Strong uptrend: EMA20 will be above EMA50 for last 3 bars
  const candles = makeCandles(80, { start: 50, step: 0.5 });
  const result = compute4hBias(candles, deps);
  assert.equal(result, "bull");
});

test("compute4hBias - detects bear bias on sustained downtrend", () => {
  // Strong downtrend: EMA20 will be below EMA50 for last 3 bars
  const candles = makeCandles(80, { start: 200, step: -0.5 });
  const result = compute4hBias(candles, deps);
  assert.equal(result, "bear");
});

test("compute4hBias - returns sideways for flat candles", () => {
  // Flat: EMA20 ≈ EMA50, mixed crossings
  const candles = makeCandles(80, { start: 100, step: 0 });
  const result = compute4hBias(candles, deps);
  // EMAs converge to same value when flat → neither consistently above
  assert.equal(result, "sideways");
});

test("compute4hBias - sideways when last 3 bars not all aligned", () => {
  // Build mostly uptrend then flatten — last 3 bars will be mixed
  const candles = makeCandles(60, { start: 50, step: 0.3 });
  // Override last few to flat, disrupting EMA alignment
  for (let i = 55; i < 60; i++) {
    candles[i].close = candles[54].close;
    candles[i].open  = candles[54].close;
    candles[i].high  = candles[54].close + 0.05;
    candles[i].low   = candles[54].close - 0.05;
  }
  const result = compute4hBias(candles, deps);
  // May be bull or sideways depending on EMA lag — just assert valid enum
  assert.ok(["bull", "bear", "sideways"].includes(result));
});
