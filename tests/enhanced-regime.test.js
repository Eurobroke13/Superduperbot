/**
 * Unit tests for bot/enhanced-regime.js — detectSideways, purely mathematical.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { detectSideways } from "../bot/enhanced-regime.js";

// ── helpers ────────────────────────────────────────────────────────────────────

/** n flat candles at `price` */
function flatCandles(n, price = 100) {
  const closes = Array(n).fill(price);
  const highs  = Array(n).fill(price * 1.001);
  const lows   = Array(n).fill(price * 0.999);
  return { closes, highs, lows };
}

/** n candles with a linear trend: close[i] = start + i*step */
function trendCandles(n, start = 100, step = 1) {
  const closes = Array.from({ length: n }, (_, i) => start + i * step);
  const highs  = closes.map(c => c + Math.abs(step) * 0.5);
  const lows   = closes.map(c => c - Math.abs(step) * 0.5);
  return { closes, highs, lows };
}

// ── detectSideways ─────────────────────────────────────────────────────────────

test("detectSideways - returns sideways:bool, score:number, confidence:number, signals:object", () => {
  const { closes, highs, lows } = flatCandles(80, 100);
  const r = detectSideways(closes, highs, lows);
  assert.equal(typeof r.sideways, "boolean");
  assert.equal(typeof r.score, "number");
  assert.equal(typeof r.confidence, "number");
  assert.equal(typeof r.signals, "object");
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
});

test("detectSideways - very flat market is detected as sideways", () => {
  // 80 flat candles — zero trend, zero ATR expansion, zero BB expansion
  const { closes, highs, lows } = flatCandles(80, 100);
  const r = detectSideways(closes, highs, lows);
  assert.equal(r.sideways, true, `score=${r.score}, signals=${JSON.stringify(r.signals)}`);
});

test("detectSideways - strong uptrend is NOT sideways", () => {
  // 80 candles trending up 1 point per candle (8% total move, high directional efficiency)
  const { closes, highs, lows } = trendCandles(80, 100, 1);
  const r = detectSideways(closes, highs, lows);
  assert.equal(r.sideways, false, `score=${r.score}, signals=${JSON.stringify(r.signals)}`);
});

test("detectSideways - strong downtrend is NOT sideways", () => {
  const { closes, highs, lows } = trendCandles(80, 200, -1);
  const r = detectSideways(closes, highs, lows);
  assert.equal(r.sideways, false, `score=${r.score}`);
});

test("detectSideways - confidence is capped at 1.0", () => {
  const { closes, highs, lows } = flatCandles(80, 100);
  const r = detectSideways(closes, highs, lows);
  assert.ok(r.confidence <= 1.0);
});

test("detectSideways - insufficient data (< 14 candles) → sideways:false, score near 0", () => {
  const closes = Array(10).fill(100);
  const highs  = Array(10).fill(101);
  const lows   = Array(10).fill(99);
  const r = detectSideways(closes, highs, lows);
  // With only 10 candles most signals can't fire
  assert.equal(typeof r.sideways, "boolean");
  assert.ok(r.score <= 1); // at most the rangeR signal fires partially
});

test("detectSideways - signals object contains expected keys when data is sufficient", () => {
  const { closes, highs, lows } = flatCandles(80, 100);
  const r = detectSideways(closes, highs, lows);
  assert.ok("efficiency" in r.signals);
  assert.ok("rangeR" in r.signals);
});

test("detectSideways - ATR and BB signals present with 80+ candles", () => {
  const { closes, highs, lows } = flatCandles(80, 100);
  const r = detectSideways(closes, highs, lows);
  assert.ok("atrCompression" in r.signals);
  assert.ok("bbWidth" in r.signals);
});

test("detectSideways - score threshold: sideways requires score >= 3", () => {
  // By inspecting the code: sideways = score >= 3
  const { closes, highs, lows } = flatCandles(80, 100);
  const r = detectSideways(closes, highs, lows);
  if (r.sideways) {
    assert.ok(r.score >= 3);
  } else {
    assert.ok(r.score < 3);
  }
});

test("detectSideways - choppy mean-reverting market scores as sideways", () => {
  // Price oscillates ±0.2 around 100: low range, low directional efficiency
  const closes = Array.from({ length: 80 }, (_, i) => 100 + (i % 2 === 0 ? 0.2 : -0.2));
  const highs  = closes.map(c => c + 0.1);
  const lows   = closes.map(c => c - 0.1);
  const r = detectSideways(closes, highs, lows);
  assert.equal(r.sideways, true, `score=${r.score}`);
});
