/**
 * Unit tests for bot/indicators.js — the pure technical-analysis primitives
 * that feed every score. A silent error here corrupts every downstream
 * signal, so the math is pinned with hand-computed expected values.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  sma, ema, atr, rsiSeries, gaussianSmooth, ichimoku, obv,
  findSwingPoints, detectRSIDivergence, emaRibbon, detectOBVDivergence,
  fisher, vwap, volumeProfile, clusterLevels, findSupportResistanceH4,
  detectRsiHigherLows, detectRsiLowerHighs, findSupportResistance,
  macd, bollingerBands, stochRSI, adx, volumeConfirmation, detectLiquidityTrap
} from "../bot/indicators.js";

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
function rising(n, start = 1, step = 1) {
  return Array.from({ length: n }, (_, i) => start + i * step);
}
function constant(n, v = 100) {
  return Array.from({ length: n }, () => v);
}

// ── sma ───────────────────────────────────────────────────────────────────────

test("sma - leading nulls then trailing averages", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test("sma - period 1 is identity", () => {
  assert.deepEqual(sma([5, 6, 7], 1), [5, 6, 7]);
});

// ── ema ───────────────────────────────────────────────────────────────────────

test("ema - seeds with first value and applies multiplier", () => {
  // period 3 -> multiplier 0.5
  assert.deepEqual(ema([2, 4, 6, 8], 3), [2, 3, 4.5, 6.25]);
});

test("ema - empty input returns empty array", () => {
  assert.deepEqual(ema([], 10), []);
});

test("ema - constant series stays constant", () => {
  assert.deepEqual(ema([5, 5, 5, 5], 4), [5, 5, 5, 5]);
});

// ── atr ───────────────────────────────────────────────────────────────────────

test("atr - constant range equals that range", () => {
  const highs = constant(20, 10), lows = constant(20, 8), closes = constant(20, 9);
  assert.ok(approx(atr(highs, lows, closes, 14), 2));
});

// ── rsiSeries ─────────────────────────────────────────────────────────────────

test("rsiSeries - monotonic rise pins to 100", () => {
  const r = rsiSeries(rising(20), 14);
  assert.equal(r[19], 100);
});

test("rsiSeries - monotonic fall pins to 0", () => {
  const r = rsiSeries(rising(20, 20, -1), 14);
  assert.equal(r[19], 0);
});

test("rsiSeries - short input returns neutral 50s", () => {
  const r = rsiSeries([1, 2, 3], 14);
  assert.ok(r.every(v => v === 50));
});

// ── gaussianSmooth ──────────────────────────────────────────────────────────────

test("gaussianSmooth - constant input is unchanged, same length", () => {
  const out = gaussianSmooth(constant(30, 7), 3);
  assert.equal(out.length, 30);
  assert.ok(out.every(v => approx(v, 7, 1e-6)));
});

// ── obv ───────────────────────────────────────────────────────────────────────

test("obv - accumulates/deducts volume by close direction", () => {
  assert.deepEqual(obv([1, 2, 1, 2], [10, 5, 3, 4]), [10, 15, 12, 16]);
});

test("obv - flat close carries the prior value", () => {
  assert.deepEqual(obv([5, 5, 5], [10, 4, 4]), [10, 10, 10]);
});

// ── findSwingPoints ─────────────────────────────────────────────────────────────

test("findSwingPoints - finds a local low", () => {
  const pts = findSwingPoints([5, 4, 3, 4, 5], "low", 1);
  assert.deepEqual(pts, [{ index: 2, value: 3 }]);
});

test("findSwingPoints - finds a local high", () => {
  const pts = findSwingPoints([1, 2, 3, 2, 1], "high", 1);
  assert.deepEqual(pts, [{ index: 2, value: 3 }]);
});

// ── ichimoku ─────────────────────────────────────────────────────────────────

test("ichimoku - returns the documented fields with sane values", () => {
  const highs = rising(60, 100), lows = rising(60, 98), closes = rising(60, 99);
  const ich = ichimoku(highs, lows, closes);
  for (const k of ["tenkan", "kijun", "senkouA", "senkouB", "chikou", "tkCross", "cloudThickness"]) {
    assert.ok(Number.isFinite(ich[k]), `${k} finite`);
  }
  assert.equal(ich.chikou, closes[closes.length - 1]);
  assert.ok(ich.cloudThickness >= 0);
});

// ── emaRibbon ────────────────────────────────────────────────────────────────

test("emaRibbon - strong uptrend is bullish-aligned & price above all", () => {
  const closes = rising(80, 100, 2);
  const rib = emaRibbon(closes);
  assert.equal(rib.bullishAligned, true);
  assert.equal(rib.bearishAligned, false);
  assert.equal(rib.priceAboveAll, true);
});

test("emaRibbon - strong downtrend is bearish-aligned & price below all", () => {
  const closes = rising(80, 300, -2);
  const rib = emaRibbon(closes);
  assert.equal(rib.bearishAligned, true);
  assert.equal(rib.priceBelowAll, true);
});

// ── fisher ───────────────────────────────────────────────────────────────────

test("fisher - returns array of input length, zeros before warmup", () => {
  const highs = rising(20, 10, 0.5), lows = rising(20, 9, 0.5);
  const f = fisher(highs, lows, 10);
  assert.equal(f.length, 20);
  assert.ok(f.slice(0, 9).every(v => v === 0));
  assert.ok(f.every(Number.isFinite));
});

// ── vwap ─────────────────────────────────────────────────────────────────────

test("vwap - uniform typical price returns that price", () => {
  const h = constant(30, 10), l = constant(30, 10), c = constant(30, 10), v = constant(30, 5);
  assert.ok(approx(vwap(h, l, c, v, 24), 10));
});

test("vwap - zero volume falls back to last close", () => {
  const h = constant(5, 10), l = constant(5, 10), c = [10, 11, 12, 13, 14], v = constant(5, 0);
  assert.equal(vwap(h, l, c, v, 24), 14);
});

// ── volumeProfile ────────────────────────────────────────────────────────────

test("volumeProfile - bins cover the price range and sum the volume", () => {
  const closes = rising(20, 100, 1);
  const volumes = constant(20, 10);
  const { profile } = volumeProfile(closes, volumes, 5);
  assert.equal(profile.length, 5);
  const total = profile.reduce((s, b) => s + b.volume, 0);
  assert.equal(total, 200);
});

// ── clusterLevels ────────────────────────────────────────────────────────────

test("clusterLevels - merges levels within clusterPct", () => {
  const merged = clusterLevels([{ price: 100, strength: 1 }, { price: 100.1, strength: 1 }], 0.003);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 2);
  assert.ok(approx(merged[0].price, 100.05));
  assert.equal(merged[0].strength, 2);
});

test("clusterLevels - keeps distant levels separate", () => {
  const merged = clusterLevels([{ price: 100, strength: 1 }, { price: 200, strength: 1 }], 0.003);
  assert.equal(merged.length, 2);
});

test("clusterLevels - empty input returns empty", () => {
  assert.deepEqual(clusterLevels([], 0.003), []);
});

// ── findSupportResistanceH4 ────────────────────────────────────────────────────

test("findSupportResistanceH4 - too-short input returns empty levels", () => {
  const candles = Array.from({ length: 5 }, () => ({ high: 10, low: 8 }));
  assert.deepEqual(findSupportResistanceH4(candles), { supports: [], resistances: [] });
});

test("findSupportResistanceH4 - detects a swing low/high", () => {
  // build 12 candles with a clear pivot low at the middle
  const base = [10, 10, 10, 10, 9, 8, 7, 8, 9, 10, 10, 10];
  const candles = base.map(v => ({ high: v + 5, low: v }));
  const { supports } = findSupportResistanceH4(candles, 60);
  assert.ok(supports.some(s => approx(s.price, 7)), "swing low at 7 detected");
});

// ── findSupportResistance ──────────────────────────────────────────────────────

test("findSupportResistance - returns supports/resistances arrays", () => {
  const highs = [10, 11, 12, 11, 10, 11, 12, 13, 12, 11, 10];
  const lows  = [8, 7, 6, 7, 8, 7, 6, 5, 6, 7, 8];
  const res = findSupportResistance(highs, lows, 50);
  assert.ok(Array.isArray(res.supports));
  assert.ok(Array.isArray(res.resistances));
});

// ── macd ─────────────────────────────────────────────────────────────────────

test("macd - insufficient data returns neutral object", () => {
  const m = macd(rising(10), 12, 26, 9);
  assert.equal(m.macd, 0);
  assert.equal(m.crossUp, false);
  assert.equal(m.crossDown, false);
});

test("macd - constant series has zero macd/histogram", () => {
  const m = macd(constant(50, 100));
  assert.ok(approx(m.macd, 0));
  assert.ok(approx(m.histogram, 0));
  assert.equal(m.crossUp, false);
});

// ── bollingerBands ───────────────────────────────────────────────────────────

test("bollingerBands - constant series collapses bands, pctB=0.5", () => {
  const bb = bollingerBands(constant(30, 50), 20, 2);
  const last = bb.middle.length - 1;
  assert.ok(approx(bb.upper[last], 50));
  assert.ok(approx(bb.lower[last], 50));
  assert.equal(bb.pctB[last], 0.5);
  assert.ok(approx(bb.width[last], 0));
});

test("bollingerBands - leading nulls before the period", () => {
  const bb = bollingerBands(rising(25), 20, 2);
  assert.equal(bb.middle[0], null);
  assert.equal(bb.upper[18], null);
  assert.ok(bb.middle[19] !== null);
});

// ── stochRSI ─────────────────────────────────────────────────────────────────

test("stochRSI - constant series returns neutral 50/50 with no crosses", () => {
  const s = stochRSI(constant(60, 100));
  assert.equal(s.k, 50);
  assert.equal(s.d, 50);
  assert.equal(s.crossUp, false);
  assert.equal(s.crossDown, false);
});

// ── adx ──────────────────────────────────────────────────────────────────────

test("adx - insufficient data returns neutral default", () => {
  const a = adx(rising(10, 10), rising(10, 8), rising(10, 9), 14);
  assert.equal(a.adx, 25);
  assert.equal(a.trending, false);
});

test("adx - strong uptrend trends with positive directional index", () => {
  const highs = rising(60, 100, 2), lows = rising(60, 98, 2), closes = rising(60, 99, 2);
  const a = adx(highs, lows, closes, 14);
  assert.ok(Number.isFinite(a.adx));
  assert.ok(a.pdi >= a.mdi, "uptrend: +DI dominates -DI");
});

// ── volumeConfirmation ─────────────────────────────────────────────────────────

test("volumeConfirmation - spike is significant/climax with score", () => {
  const volumes = [...constant(19, 10), 40]; // last bar 4x average-ish
  const vc = volumeConfirmation(volumes, 20);
  assert.ok(vc.ratio > 1.5);
  assert.equal(vc.isSignificant, true);
  assert.ok(vc.score >= 1);
});

test("volumeConfirmation - flat volume is not significant", () => {
  const vc = volumeConfirmation(constant(20, 10), 20);
  assert.ok(approx(vc.ratio, 1));
  assert.equal(vc.isSignificant, false);
  assert.equal(vc.score, 0);
});

// ── detectLiquidityTrap ─────────────────────────────────────────────────────────

test("detectLiquidityTrap - bull trap: wick above resistance then close below", () => {
  const srLevels = { resistances: [100], supports: [] };
  const closes = [98, 99, 100, 99, 99];
  const highs = [99, 100, 101, 100, 99];   // 101 > 100*1.003
  const lows = [97, 98, 99, 98, 98];
  const result = detectLiquidityTrap(99, closes, srLevels, highs, lows);
  assert.equal(result, "bull-trap");
});

test("detectLiquidityTrap - bear trap: wick below support then close above", () => {
  const srLevels = { resistances: [], supports: [100] };
  const closes = [102, 101, 100, 101, 101];
  const highs = [103, 102, 101, 102, 102];
  const lows = [101, 100, 99, 100, 101];    // 99 < 100*0.997
  const result = detectLiquidityTrap(101, closes, srLevels, highs, lows);
  assert.equal(result, "bear-trap");
});

test("detectLiquidityTrap - no trap when price stays inside levels", () => {
  const srLevels = { resistances: [110], supports: [90] };
  const closes = constant(5, 100), highs = constant(5, 101), lows = constant(5, 99);
  assert.equal(detectLiquidityTrap(100, closes, srLevels, highs, lows), "none");
});

// ── detectRSIDivergence / detectOBVDivergence (guards) ──────────────────────────

test("detectRSIDivergence - short input returns none", () => {
  assert.deepEqual(detectRSIDivergence([1, 2, 3], [50, 50, 50], 20), { type: "none", strength: 0 });
});

test("detectOBVDivergence - short input returns none", () => {
  assert.deepEqual(detectOBVDivergence([1, 2, 3], [10, 20, 30], 30), { type: "none", strength: 0 });
});

test("detectRSIDivergence - flat data yields no divergence", () => {
  const closes = constant(30, 100), rsi = constant(30, 50);
  assert.deepEqual(detectRSIDivergence(closes, rsi, 20), { type: "none", strength: 0 });
});

// ── detectRsiHigherLows / detectRsiLowerHighs (guards) ──────────────────────────

test("detectRsiHigherLows - too few candles returns not-detected", () => {
  const candles = Array.from({ length: 10 }, (_, i) => ({ close: 100, low: 99 }));
  assert.equal(detectRsiHigherLows(candles).detected, false);
});

test("detectRsiLowerHighs - too few candles returns not-detected", () => {
  const candles = Array.from({ length: 10 }, () => ({ close: 100, high: 101 }));
  assert.equal(detectRsiLowerHighs(candles).detected, false);
});

test("detectRsiHigherLows - flat data is not a divergence", () => {
  const candles = Array.from({ length: 80 }, () => ({ close: 100, low: 99 }));
  assert.equal(detectRsiHigherLows(candles).detected, false);
});
