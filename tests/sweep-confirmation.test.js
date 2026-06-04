/**
 * Unit tests for bot/sweep-confirmation.js
 * isConfirmedSweep and canOpenMoreTraps — both pure.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isConfirmedSweep, canOpenMoreTraps } from "../bot/sweep-confirmation.js";

// ── helpers ────────────────────────────────────────────────────────────────────

const candle = (o, h, l, c, v = 100) => ({ open: o, high: h, low: l, close: c, volume: v });

/** 20 quiet candles clustered around `price` (no sweeps) */
function quietCandles(n, price, vol = 100) {
  return Array.from({ length: n }, () =>
    candle(price, price * 1.001, price * 0.999, price, vol)
  );
}

// ── isConfirmedSweep ───────────────────────────────────────────────────────────

test("isConfirmedSweep - null candles → confirmed:false, insufficient-data", () => {
  const r = isConfirmedSweep({ candles: null, srLevels: { supports: [99], resistances: [] }, direction: "long", atrVal: 2 });
  assert.equal(r.confirmed, false);
  assert.equal(r.details.reason, "insufficient-data");
});

test("isConfirmedSweep - fewer than 20 candles → insufficient-data", () => {
  const r = isConfirmedSweep({
    candles: quietCandles(10, 100),
    srLevels: { supports: [99], resistances: [] },
    direction: "long",
    atrVal: 2
  });
  assert.equal(r.confirmed, false);
  assert.equal(r.details.reason, "insufficient-data");
});

test("isConfirmedSweep - no S/R levels → confirmed:false", () => {
  const r = isConfirmedSweep({
    candles: quietCandles(25, 100),
    srLevels: { supports: [], resistances: [] },
    direction: "long",
    atrVal: 2
  });
  assert.equal(r.confirmed, false);
});

test("isConfirmedSweep - bear-trap: wick below support + reclaim + climax volume → confirmed", () => {
  // 20 quiet candles at 100, then:
  //   sweep candle: wicks below support=99, closes above it, high volume
  //   reclaim candle: closes above 99
  const support = 99;
  const avgVol = 100;
  const climaxVol = avgVol * 2.0; // 2x average > 1.8x threshold

  const base = quietCandles(20, 100, avgVol);
  // sweep candle: open=100, high=100.5, low=98 (below 99), close=99.5, volume=climax
  // body = |99.5-100| = 0.5, lowerWick = min(100,99.5)-98 = 99.5-98 = 1.5 → ratio = 1.5/0.5 = 3.0 > 1.5 ✓
  const sweepCandle = candle(100, 100.5, 98, 99.5, climaxVol);
  // reclaim candle: closes above support
  const reclaimCandle = candle(99.5, 101, 99, 100.5, avgVol);

  const candles = [...base.slice(0, 18), sweepCandle, reclaimCandle];

  const r = isConfirmedSweep({
    candles,
    srLevels: { supports: [support], resistances: [] },
    direction: "long",
    atrVal: 2
  });

  assert.equal(r.confirmed, true, `expected confirmed but got: ${JSON.stringify(r.details)}`);
  assert.equal(r.details.type, "bear-trap-sweep");
  assert.equal(r.details.sweepLevel, support);
});

test("isConfirmedSweep - bear-trap without reclaim candle → not confirmed", () => {
  const support = 99;
  const avgVol = 100;
  const climaxVol = avgVol * 2.0;

  const base = quietCandles(20, 100, avgVol);
  // sweep candle is the LAST candle — no subsequent reclaim candle
  const sweepCandle = candle(100, 100.5, 98, 99.5, climaxVol);

  const candles = [...base.slice(0, 19), sweepCandle];

  const r = isConfirmedSweep({
    candles,
    srLevels: { supports: [support], resistances: [] },
    direction: "long",
    atrVal: 2
  });

  assert.equal(r.confirmed, false);
});

test("isConfirmedSweep - bear-trap without volume spike → not confirmed", () => {
  const support = 99;
  const avgVol = 100;
  // low volume on sweep candle (< 1.8x avg)
  const lowVol = avgVol * 1.5;

  const base = quietCandles(20, 100, avgVol);
  const sweepCandle = candle(100, 100.5, 98, 99.5, lowVol);
  const reclaimCandle = candle(99.5, 101, 99, 100.5, avgVol);

  const candles = [...base.slice(0, 18), sweepCandle, reclaimCandle];

  const r = isConfirmedSweep({
    candles,
    srLevels: { supports: [support], resistances: [] },
    direction: "long",
    atrVal: 2
  });

  assert.equal(r.confirmed, false);
});

test("isConfirmedSweep - bull-trap: wick above resistance + reclaim + climax volume → confirmed", () => {
  const resistance = 101;
  const avgVol = 100;
  const climaxVol = avgVol * 2.0;

  const base = quietCandles(20, 100, avgVol);
  // sweep candle: open=100, high=102.5 (above 101), close=100.5 (below resistance), low=99.8
  // body = |100.5-100| = 0.5, upperWick = 102.5-max(100,100.5) = 102.5-100.5 = 2.0 → ratio = 2.0/0.5 = 4.0 > 1.5 ✓
  // wickExtension = (102.5-101)/2 = 0.75 ATR < 2.0 ✓
  const sweepCandle = candle(100, 102.5, 99.8, 100.5, climaxVol);
  // reclaim candle: closes below resistance
  const reclaimCandle = candle(100.5, 101, 99.5, 100.2, avgVol);

  const candles = [...base.slice(0, 18), sweepCandle, reclaimCandle];

  const r = isConfirmedSweep({
    candles,
    srLevels: { supports: [], resistances: [resistance] },
    direction: "short",
    atrVal: 2
  });

  assert.equal(r.confirmed, true, `expected confirmed but got: ${JSON.stringify(r.details)}`);
  assert.equal(r.details.type, "bull-trap-sweep");
  assert.equal(r.details.sweepLevel, resistance);
});

test("isConfirmedSweep - wick extension too large → not confirmed", () => {
  const support = 99;
  const avgVol = 100;
  const climaxVol = avgVol * 2.0;

  const base = quietCandles(20, 100, avgVol);
  // wick goes from 99 down to 93 → wickExtension = (99-93)/2 = 3.0 ATR > 2.0 threshold
  const sweepCandle = candle(100, 100.5, 93, 99.5, climaxVol);
  const reclaimCandle = candle(99.5, 101, 99, 100.5, avgVol);

  const candles = [...base.slice(0, 18), sweepCandle, reclaimCandle];

  const r = isConfirmedSweep({
    candles,
    srLevels: { supports: [support], resistances: [] },
    direction: "long",
    atrVal: 2
  });

  assert.equal(r.confirmed, false);
});

// ── canOpenMoreTraps ───────────────────────────────────────────────────────────

test("canOpenMoreTraps - empty scanSummary allows up to maxPerCycle", () => {
  assert.equal(canOpenMoreTraps({}, 2), true);
  assert.equal(canOpenMoreTraps({ openedBySetup: {} }, 2), true);
});

test("canOpenMoreTraps - below cap → allowed", () => {
  const s = { openedBySetup: { "liquidity-trap": 1 } };
  assert.equal(canOpenMoreTraps(s, 2), true);
});

test("canOpenMoreTraps - at cap → not allowed", () => {
  const s = { openedBySetup: { "liquidity-trap": 2 } };
  assert.equal(canOpenMoreTraps(s, 2), false);
});

test("canOpenMoreTraps - above cap → not allowed", () => {
  const s = { openedBySetup: { "liquidity-trap": 5 } };
  assert.equal(canOpenMoreTraps(s, 2), false);
});

test("canOpenMoreTraps - custom maxPerCycle=1 is respected", () => {
  const s = { openedBySetup: { "liquidity-trap": 1 } };
  assert.equal(canOpenMoreTraps(s, 1), false);
  assert.equal(canOpenMoreTraps({ openedBySetup: { "liquidity-trap": 0 } }, 1), true);
});
