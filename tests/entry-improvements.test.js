/**
 * Unit tests for bot/entry-improvements.js — the pure entry/exit gate
 * functions that decide whether trades open and how they're sized. These
 * directly shape every entry, so behavior is pinned with constructed
 * scenarios and hand-computed expectations.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkEarlyReversalTighten,
  liquidityTrapQualityGate,
  sidewaysFilter,
  scoreSidewaysMeanReversion,
  check15mReversal,
  stochRSI15m,
  confirmMeanReversionEntry,
  checkMeanReversionExit,
  bearFilter
} from "../bot/entry-improvements.js";

const candle = (open, high, low, close, volume = 100) => ({ open, high, low, close, volume });
const flat = (n, v = 10, vol = 100) => Array.from({ length: n }, () => candle(v, v + 0.1, v - 0.1, v, vol));

// ── checkEarlyReversalTighten ──────────────────────────────────────────────────

test("checkEarlyReversalTighten - skips when TP1 already hit", () => {
  const pos = { direction: "long", entryPrice: 100, sl: 95, atrVal: 2, tpLevels: { tp1: { hit: true } } };
  assert.deepEqual(checkEarlyReversalTighten(pos, 100, 2, 5), { tighten: false, newSl: null, reason: null });
});

test("checkEarlyReversalTighten - skips mean-reversion positions", () => {
  const pos = { direction: "long", entryPrice: 100, sl: 95, atrVal: 2, setupType: "mean-reversion" };
  assert.equal(checkEarlyReversalTighten(pos, 100, 2, 5).tighten, false);
});

test("checkEarlyReversalTighten - phase 1 tightens after 3h with no move (long)", () => {
  const pos = { direction: "long", entryPrice: 100, sl: 95, atrVal: 2, maxFavorable: 100 };
  const r = checkEarlyReversalTighten(pos, 100, 2, 3);
  assert.equal(r.tighten, true);
  assert.equal(r.newSl, 98); // max(95, 100 - 2*1.0)
  assert.match(r.reason, /^early-tighten-3h/);
});

test("checkEarlyReversalTighten - phase 2 near-breakeven after 6h, no T2, mild move", () => {
  // favorableMove 0.8 ATR: above phase-1 0.3 threshold, below phase-2 0.5*... wait
  // entryAtr=2 -> phase1 needs fav<0.6 (skip at 0.8); phase2 needs fav<1.0 (0.8 qualifies)
  const pos = { direction: "long", entryPrice: 100, sl: 95, atrVal: 2, maxFavorable: 100.8 };
  const r = checkEarlyReversalTighten(pos, 100.8, 2, 6);
  assert.equal(r.tighten, true);
  assert.equal(r.newSl, 99.4); // 100 - 2*0.3
  assert.match(r.reason, /^early-tighten-6h/);
});

test("checkEarlyReversalTighten - no tighten before 3h", () => {
  const pos = { direction: "long", entryPrice: 100, sl: 95, atrVal: 2, maxFavorable: 100 };
  assert.equal(checkEarlyReversalTighten(pos, 100, 2, 1).tighten, false);
});

test("checkEarlyReversalTighten - short side phase 1", () => {
  const pos = { direction: "short", entryPrice: 100, sl: 105, atrVal: 2, maxFavorable: 100 };
  const r = checkEarlyReversalTighten(pos, 100, 2, 3);
  assert.equal(r.tighten, true);
  assert.equal(r.newSl, 102); // min(105, 100 + 2*1.0)
});

// ── liquidityTrapQualityGate ───────────────────────────────────────────────────

test("liquidityTrapQualityGate - non-LT setup passes through", () => {
  const r = liquidityTrapQualityGate({ setupType: "trend" }, null, null);
  assert.equal(r.pass, true);
  assert.equal(r.reason, "not-liquidity-trap");
});

test("liquidityTrapQualityGate - zero confirmations fails", () => {
  const c = { setupType: "liquidity-trap", signal: "long", h4Trend: "bearish" };
  const r = liquidityTrapQualityGate(c, { ratio: 0.8 }, { type: "none" });
  assert.equal(r.pass, false);
  assert.equal(r.confirmations, 0);
});

test("liquidityTrapQualityGate - two confirmations (volume + h4) passes", () => {
  const c = { setupType: "liquidity-trap", signal: "long", h4Trend: "bullish" };
  const r = liquidityTrapQualityGate(c, { ratio: 1.5 }, { type: "none" });
  assert.equal(r.confirmations, 2);
  assert.equal(r.pass, true);
});

test("liquidityTrapQualityGate - divergence must match signal direction", () => {
  const c = { setupType: "liquidity-trap", signal: "long", h4Trend: "neutral" };
  // bearish divergence on a long signal does NOT count
  const r = liquidityTrapQualityGate(c, { ratio: 1.5 }, { type: "bearish" });
  assert.equal(r.confirmations, 1); // only volume
  assert.equal(r.pass, false);
});

// ── sidewaysFilter ─────────────────────────────────────────────────────────────

test("sidewaysFilter - non-sideways always allowed", () => {
  assert.equal(sidewaysFilter({ setupType: "trend", score: 1 }, "bull").allowed, true);
});

test("sidewaysFilter - mean-reversion exempt in sideways", () => {
  const r = sidewaysFilter({ setupType: "mean-reversion", score: 3 }, "sideways");
  assert.equal(r.allowed, true);
});

test("sidewaysFilter - trend/momentum blocked in sideways", () => {
  assert.equal(sidewaysFilter({ setupType: "trend", score: 9 }, "sideways").allowed, false);
  assert.equal(sidewaysFilter({ setupType: "momentum", score: 9 }, "sideways").allowed, false);
});

test("sidewaysFilter - raises min score to 5 in sideways", () => {
  assert.equal(sidewaysFilter({ setupType: "breakout", score: 4.9 }, "sideways").allowed, false);
  assert.equal(sidewaysFilter({ setupType: "breakout", score: 5.0 }, "sideways").allowed, true);
});

test("sidewaysFilter - adaptive tightening when sideways stats are poor", () => {
  const stats = { sideways: { count: 30, totalPnl: -90, wins: 10 } }; // avg -3, WR 33%
  const r = sidewaysFilter({ setupType: "breakout", score: 5.5 }, "sideways", stats);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /^sideways-restrict/);
});

// ── scoreSidewaysMeanReversion ─────────────────────────────────────────────────

test("scoreSidewaysMeanReversion - returns null outside sideways", () => {
  assert.equal(scoreSidewaysMeanReversion({ regime: { label: "bull" } }), null);
});

test("scoreSidewaysMeanReversion - returns null when ADX shows a real trend", () => {
  assert.equal(scoreSidewaysMeanReversion({ regime: { label: "sideways" }, adxResult: { adx: 40 } }), null);
});

test("scoreSidewaysMeanReversion - returns null mid-range (no BB edge)", () => {
  const r = scoreSidewaysMeanReversion({
    regime: { label: "sideways" }, adxResult: { adx: 20 },
    bbUpper: 110, bbLower: 90, bbMiddle: 100, bbWidth: 0.2, pctB: 0.5
  });
  assert.equal(r, null);
});

test("scoreSidewaysMeanReversion - qualifying long at lower edge", () => {
  const r = scoreSidewaysMeanReversion({
    regime: { label: "sideways" }, adxResult: { adx: 20 },
    price: 100, atrVal: 2,
    bbUpper: 110, bbLower: 90, bbMiddle: 100, bbWidth: 0.2, pctB: 0.1,
    rsiVal: 28,                              // +2 (extreme low)
    stochResult: { oversold: true, k: 10 },  // +1.5
    supports: [100],                         // +2 (at support)
    currentEMA20: 102, vwapVal: 101
  });
  assert.ok(r, "should produce a setup");
  assert.equal(r.signal, "long");
  assert.equal(r.setupType, "mean-reversion");
  assert.equal(r.positionSizeMultiplier, 0.70);
  assert.equal(r.maxHoldHours, 12);
  assert.ok(r.score >= 3.5);
  assert.ok(approxLt(r.sl, 100)); // SL below price for a long
});

test("scoreSidewaysMeanReversion - qualifying short at upper edge", () => {
  const r = scoreSidewaysMeanReversion({
    regime: { label: "sideways" }, adxResult: { adx: 20 },
    price: 100, atrVal: 2,
    bbUpper: 110, bbLower: 90, bbMiddle: 100, bbWidth: 0.2, pctB: 0.9,
    rsiVal: 72,                                  // +2
    stochResult: { overbought: true, k: 90 },    // +1.5
    resistances: [100],                          // +2
    currentEMA20: 98, vwapVal: 99
  });
  assert.ok(r);
  assert.equal(r.signal, "short");
  assert.ok(r.sl > 100); // SL above price for a short
});

test("scoreSidewaysMeanReversion - returns null when score below 3.5", () => {
  const r = scoreSidewaysMeanReversion({
    regime: { label: "sideways" }, adxResult: { adx: 20 },
    price: 100, atrVal: 2,
    bbUpper: 110, bbLower: 90, bbMiddle: 100, bbWidth: 0.2, pctB: 0.2,
    rsiVal: 50, stochResult: { oversold: false }, supports: []
  });
  assert.equal(r, null);
});

function approxLt(a, b) { return a < b; }

// ── check15mReversal ───────────────────────────────────────────────────────────

test("check15mReversal - insufficient data", () => {
  const r = check15mReversal(flat(5), "long");
  assert.equal(r.confirmed, false);
  assert.deepEqual(r.patterns, ["insufficient-data"]);
});

test("check15mReversal - zero-range last bar bails out", () => {
  const candles = [...flat(11), candle(10, 10, 10, 10)];
  const r = check15mReversal(candles, "long");
  assert.deepEqual(r.patterns, ["zero-range-bar"]);
});

test("check15mReversal - long hammer is confirmed", () => {
  // last bar: long lower wick, tiny upper wick
  const candles = [...flat(11), candle(10, 10.15, 9, 10.1)];
  const r = check15mReversal(candles, "long");
  assert.ok(r.patterns.includes("15m-hammer"));
  assert.ok(r.confidence >= 2);
  assert.equal(r.confirmed, true);
});

test("check15mReversal - short shooting star is confirmed", () => {
  const candles = [...flat(11), candle(10, 11, 9.85, 9.9)];
  const r = check15mReversal(candles, "short");
  assert.ok(r.patterns.includes("15m-shooting-star"));
  assert.equal(r.confirmed, true);
});

test("check15mReversal - flat tape is not confirmed", () => {
  const r = check15mReversal(flat(12), "long");
  assert.equal(r.confirmed, false);
});

// ── stochRSI15m ────────────────────────────────────────────────────────────────

test("stochRSI15m - returns null with insufficient candles", () => {
  assert.equal(stochRSI15m(flat(10), 14), null);
});

test("stochRSI15m - monotonic rise yields neutral k (flat RSI window)", () => {
  // rising closes -> RSI pinned ~100 -> zero range in window -> k defaults to 50
  // needs n >= 2*period (rsiValues length must reach `period`)
  const candles = Array.from({ length: 32 }, (_, i) => candle(100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i));
  const s = stochRSI15m(candles, 14);
  assert.ok(s);
  assert.equal(s.k, 50);
  assert.equal(s.oversold, false);
  assert.equal(s.overbought, false);
});

// ── confirmMeanReversionEntry ──────────────────────────────────────────────────

test("confirmMeanReversionEntry - non-MR candidate rejected", () => {
  const r = confirmMeanReversionEntry({ setupType: "trend" }, null);
  assert.equal(r.enter, false);
  assert.equal(r.reason, "not-mr");
});

test("confirmMeanReversionEntry - no 15m, high score enters at half size", () => {
  const r = confirmMeanReversionEntry({ setupType: "mean-reversion", signal: "long", score: 7 }, null);
  assert.equal(r.enter, true);
  assert.equal(r.reason, "mr-no-15m-high-score");
  assert.equal(r.positionSizeMultiplier, 0.50);
  assert.ok(Math.abs(r.adjustedScore - 5.95) < 1e-9); // 7 * 0.85
});

test("confirmMeanReversionEntry - no 15m, low score rejected", () => {
  const r = confirmMeanReversionEntry({ setupType: "mean-reversion", signal: "long", score: 4 }, null);
  assert.equal(r.enter, false);
  assert.equal(r.reason, "mr-no-15m-low-score");
});

test("confirmMeanReversionEntry - 15m confirmed enters with sizing", () => {
  const candles = [...flat(11), candle(10, 10.15, 9, 10.1)]; // hammer
  const r = confirmMeanReversionEntry({ setupType: "mean-reversion", signal: "long", score: 6 }, candles);
  assert.equal(r.enter, true);
  assert.match(r.reason, /^mr-15m-confirmed/);
  assert.ok(r.positionSizeMultiplier > 0);
});

test("confirmMeanReversionEntry - 15m unconfirmed but strong 1h still enters", () => {
  const r = confirmMeanReversionEntry({ setupType: "mean-reversion", signal: "long", score: 7.5 }, flat(12));
  assert.equal(r.enter, true);
  assert.match(r.reason, /^mr-15m-unconfirmed-but-strong/);
  assert.equal(r.positionSizeMultiplier, 0.50);
});

test("confirmMeanReversionEntry - 15m rejected when unconfirmed and score modest", () => {
  const r = confirmMeanReversionEntry({ setupType: "mean-reversion", signal: "long", score: 6 }, flat(12));
  assert.equal(r.enter, false);
  assert.match(r.reason, /^mr-15m-rejected/);
});

// ── checkMeanReversionExit ─────────────────────────────────────────────────────

test("checkMeanReversionExit - 12h with <0.5 ATR profit exits", () => {
  const pos = { direction: "long", entryPrice: 100, atrVal: 2, sl: 95 };
  const r = checkMeanReversionExit(pos, 100, 2, 12);
  assert.equal(r.exit, true);
  assert.equal(r.reason, "mr-time-expired-12h");
});

test("checkMeanReversionExit - 8h underwater exits", () => {
  const pos = { direction: "long", entryPrice: 100, atrVal: 2, sl: 95 };
  const r = checkMeanReversionExit(pos, 99, 2, 8);
  assert.equal(r.exit, true);
  assert.equal(r.reason, "mr-underwater-8h");
});

test("checkMeanReversionExit - 1.0 ATR profit trails SL to BE+0.2 ATR (long)", () => {
  const pos = { direction: "long", entryPrice: 100, atrVal: 2, sl: 95 };
  const r = checkMeanReversionExit(pos, 102.5, 2, 3); // profit 1.25 ATR
  assert.equal(r.exit, false);
  assert.equal(pos.sl, 100.4); // 100 + 2*0.2
});

test("checkMeanReversionExit - 1.5+ ATR profit applies tighter trail", () => {
  const pos = { direction: "long", entryPrice: 100, atrVal: 2, sl: 95 };
  const r = checkMeanReversionExit(pos, 104, 2, 3); // profit 2.0 ATR
  assert.equal(r.exit, false);
  assert.equal(pos.sl, 103.2); // price 104 - 2*0.4
});

test("checkMeanReversionExit - early & profitable: no exit, SL unchanged", () => {
  const pos = { direction: "long", entryPrice: 100, atrVal: 2, sl: 95 };
  const r = checkMeanReversionExit(pos, 100.4, 2, 2); // profit 0.2 ATR
  assert.equal(r.exit, false);
  assert.equal(pos.sl, 95);
});

test("checkMeanReversionExit - SL never loosens (existing tighter SL kept)", () => {
  const pos = { direction: "long", entryPrice: 100, atrVal: 2, sl: 101 }; // already above BE
  checkMeanReversionExit(pos, 102.5, 2, 3); // would propose 100.4 < 101
  assert.equal(pos.sl, 101, "SL must not loosen");
});

// ── bearFilter ─────────────────────────────────────────────────────────────────

test("bearFilter - non-bear regime always allowed", () => {
  assert.equal(bearFilter({ signal: "long", score: 2 }, "bull").allowed, true);
});

test("bearFilter - bear short approved at 4.0+", () => {
  assert.equal(bearFilter({ signal: "short", score: 4.0 }, "bear").allowed, true);
  assert.equal(bearFilter({ signal: "short", score: 3.9 }, "bear").allowed, false);
});

test("bearFilter - bear long requires 7.0+ conviction", () => {
  assert.equal(bearFilter({ signal: "long", score: 7.0 }, "bear").allowed, true);
  assert.equal(bearFilter({ signal: "long", score: 6.9 }, "bear").allowed, false);
});
