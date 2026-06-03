import {
  ATR_SL_MULT,
  ATR_TP_MULT,
  CANDLE_LIMIT
} from "./config.js";
import { fetchCandles } from "./market-data.js";
import {
  adx,
  atr,
  bollingerBands,
  detectLiquidityTrap,
  detectOBVDivergence,
  detectRSIDivergence,
  ema,
  emaRibbon,
  findSupportResistance,
  findSupportResistanceH4,
  clusterLevels,
  detectRsiHigherLows,
  detectRsiLowerHighs,
  fisher,
  ichimoku,
  macd,
  obv,
  rsiSeries,
  sma,
  stochRSI,
  volumeConfirmation,
  volumeProfile,
  vwap
} from "./indicators.js";
import { portfolioValue } from "./execution.js";
import { scoreSidewaysMeanReversion } from "./entry-improvements.js";

// ── Null-reason diagnostic counter ──────────────────────────────────────────
const _nullReasons = {};
function _trackNull(reason) { _nullReasons[reason] = (_nullReasons[reason] || 0) + 1; }
export function drainNullReasons() {
  const snap = { ..._nullReasons };
  for (const k of Object.keys(_nullReasons)) delete _nullReasons[k];
  return snap;
}

/**
 * Score bear regime short signals with specific indicators
 * Returns boost points + reasons for downstream integration
 */
function scoreBearShort(
  signal, price, rsiVal, fisherVal, stochResult,
  vwapVal, adxResult, pctB, nearResistance, obvDiv,
  atrVal, bbUpper, bbMiddle, reasons, currentScore
) {
  if (signal !== "short") return { scoreBoost: 0, reasons: [], positionSizeMultiplier: 1.0, maxHoldHours: null };

  let boost = 0;
  const bearReasons = [];

  // Resistance touches (short should sell resistance, not bounce support)
  if (nearResistance) {
    boost += 1.5;
    bearReasons.push("bear-at-resistance");
  }

  // Overbought extremes (RSI > 70 is SHORT signal in bear, not neutral)
  if (rsiVal > 70) {
    boost += 1.5;
    bearReasons.push("bear-rsi-overbought");
  } else if (rsiVal > 65) {
    boost += 0.75;
    bearReasons.push("bear-rsi-high");
  }

  // Fisher reversal (extreme positive = top, ready to fall)
  const fisherPrev = null; // Will be passed by caller if available
  if (fisherVal > 1.5) {
    boost += 1.5;
    bearReasons.push("bear-fisher-top");
  }

  // StochRSI overbought — only meaningful when price is also at resistance
  // (K > 80 in open air is momentum, not a reversal signal)
  if (stochResult?.overbought && nearResistance) {
    boost += 1.0;
    bearReasons.push("bear-stoch-overbought");
  }
  if (stochResult?.crossDown && stochResult?.k > 75) {
    boost += 1.0;
    bearReasons.push("bear-stoch-cross-down");
  }

  // Above Bollinger Band upper (stretched, likely to snap)
  if (pctB > 1.0) {
    boost += 0.75;
    bearReasons.push("bear-above-bb");
  }

  // ADX confirmation (trending + downtrend)
  if (adxResult?.trending && adxResult?.mdi > adxResult?.pdi) {
    boost += 1.0;
    bearReasons.push("bear-adx-confirmed");
  }

  return {
    scoreBoost: boost,
    reasons: bearReasons,
    positionSizeMultiplier: 0.75,  // Short in bear is 75% of normal (high conviction)
    maxHoldHours: 16               // Bear shorts can hold longer (trending)
  };
}

/**
 * Confirm bear short on 15m timeframe with pattern detection
 * Gradual entry: 70% if low confidence, 100% if high confidence
 */
export function confirm15mBearShort(candles15m, entryPrice, atrVal) {
  if (!candles15m || candles15m.length < 12) {
    return { enter: true, confidence: 0, patterns: ["no-15m-data"], positionSizeMultiplier: 1.0 };
  }

  let confidence = 0;
  const patterns = [];
  const n = candles15m.length;
  const last = candles15m[n - 1];

  // Shooting star: long upper wick, close at bottom
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const range = last.high - last.low;
  if (range > 0 && upperWick / range > 0.60 && lowerWick / range < 0.15) {
    confidence += 2;
    patterns.push("15m-shooting-star");
  }

  // Bearish engulfing: prev green > larger red
  if (n >= 2) {
    const prev = candles15m[n - 2];
    if (prev.close > prev.open && last.close < last.open &&
      last.close < prev.open && last.open >= prev.close) {
      confidence += 2.5;
      patterns.push("15m-bear-engulfing");
    }
  }

  // Series of lower highs (3+ reds in a row)
  let redCount = 0;
  for (let i = n - 1; i >= Math.max(0, n - 5); i--) {
    if (candles15m[i].close < candles15m[i].open) redCount++;
    else break;
  }
  if (redCount >= 3) {
    confidence += 1.5;
    patterns.push(`15m-red-cascade(${redCount})`);
  }

  // Volume on red candle
  const avgVol = candles15m.slice(-8, -1).reduce((s, c) => s + c.volume, 0) / 7;
  if (last.close < last.open && avgVol > 0 && last.volume > avgVol * 1.8) {
    confidence += 1.5;
    patterns.push("15m-volume-breakdown");
  }

  return {
    enter: confidence >= 2.0,
    confidence,
    patterns,
    positionSizeMultiplier: confidence >= 3.5 ? 1.0 : 0.7  // full or 70%
  };
}

function getSignalMultiplier(name, state, regimeLabel) {
  const weights = state?.dynamicWeights || {};
  const sigStats = state?.signalStats || {};

  const regimeKey = regimeLabel ? `${name}:${regimeLabel}` : null;
  if (regimeKey && sigStats[regimeKey] && sigStats[regimeKey].count >= 20) {
    const { wins, count } = sigStats[regimeKey];
    const wr = wins / count;
    if (wr >= 0.62) return 1.20;
    if (wr >= 0.52) return 1.08;
    if (wr >= 0.47) return 0.92;
    if (wr < 0.33) return 0.65;
    if (wr < 0.40) return 0.80;
  }

  if (weights[name] !== undefined) {
    return Math.max(0.2, Math.min(weights[name], 1.6));
  }

  if (sigStats[name] && sigStats[name].count >= 15) {
    const { wins, count } = sigStats[name];
    const wr = wins / count;
    if (wr >= 0.62) return 1.20;
    if (wr >= 0.52) return 1.08;
    if (wr >= 0.47) return 0.92;
    if (wr < 0.33) return 0.65;
    if (wr < 0.40) return 0.80;
  }

  return 1.0;
}

export function score4H(candles4h) {
  if (!candles4h || candles4h.length < 100) {
    return { bullScore: 0, bearScore: 0, signals: [], aligned: () => false };
  }

  const c4 = candles4h.map(c => c.close);
  const h4 = candles4h.map(c => c.high);
  const l4 = candles4h.map(c => c.low);
  const v4 = candles4h.map(c => c.volume);
  const n = c4.length;

  const signals = [];
  let bullScore = 0;
  let bearScore = 0;

  const rsi4 = rsiSeries(c4, 14);
  const rsiDiv4 = detectRSIDivergence(c4, rsi4, 30);
  const last4 = c4.length - 1;
  const strongDiv4 = rsiDiv4.strength >= 8;
  const rsiWasOversold = Math.min(...rsi4.slice(-30)) < 42;
  const rsiWasOverbought = Math.max(...rsi4.slice(-30)) > 58;
  const rsi4TurningUp =
    rsi4[last4] > rsi4[last4 - 1] &&
    rsi4[last4 - 1] > rsi4[last4 - 2];
  const rsi4TurningDown =
    rsi4[last4] < rsi4[last4 - 1] &&
    rsi4[last4 - 1] < rsi4[last4 - 2];
  if (rsiDiv4.type === "bullish" && strongDiv4 && rsiWasOversold && rsi4TurningUp) {
    bullScore += 2;
    signals.push("4h-rsi-div-bull");
  }
  if (rsiDiv4.type === "bearish" && strongDiv4 && rsiWasOverbought && rsi4TurningDown) {
    bearScore += 2;
    signals.push("4h-rsi-div-bear");
  }

  const macd4 = macd(c4) || {};
  const macd4Prev = macd(c4.slice(0, -1)) || {};
  const macdZeroCrossUp = (macd4.macd ?? 0) > 0 && (macd4Prev.macd ?? 0) <= 0;
  const macdZeroCrossDown = (macd4.macd ?? 0) < 0 && (macd4Prev.macd ?? 0) >= 0;
  const prevHist4 = macd4Prev.histogram ?? 0;
  const macdAccelUp =
    (macd4.histogram ?? 0) > 0 &&
    prevHist4 > 0 &&
    (macd4.histogram ?? 0) > prevHist4 * 1.4;
  const macdAccelDown =
    (macd4.histogram ?? 0) < 0 &&
    prevHist4 < 0 &&
    (macd4.histogram ?? 0) < prevHist4 * 1.4;
  if (macdZeroCrossUp || macdAccelUp) {
    bullScore += 2;
    signals.push("4h-macd-cross-up");
  }
  if (macdZeroCrossDown || macdAccelDown) {
    bearScore += 2;
    signals.push("4h-macd-cross-down");
  }

  const bb4 = bollingerBands(c4, 20, 2);
  const bbWidth4 = bb4?.width?.[n - 1] ?? 0;
  const bbPrev4 = bb4?.width?.[Math.max(0, n - 6)] ?? bbWidth4;
  const bbMiddle4 = bb4?.middle?.[n - 1] ?? c4[n - 1];
  if (bbWidth4 > bbPrev4 * 1.3 && c4[n - 1] > bbMiddle4) {
    bullScore += 1;
    signals.push("4h-bb-expansion-bull");
  }
  if (bbWidth4 > bbPrev4 * 1.3 && c4[n - 1] < bbMiddle4) {
    bearScore += 1;
    signals.push("4h-bb-expansion-bear");
  }

  const obv4 = obv(c4, v4);
  const obvDiv4 = detectOBVDivergence(c4, obv4, 30);
  if (obvDiv4.type === "bullish") {
    bullScore += 1;
    signals.push("4h-obv-div-bull");
  }
  if (obvDiv4.type === "bearish") {
    bearScore += 1;
    signals.push("4h-obv-div-bear");
  }

  return {
    bullScore,
    bearScore,
    signals,
    aligned: (dir) => dir === "long" ? bullScore > bearScore : bearScore > bullScore
  };
}

export async function scoreSymbol(symbol, regime, state) {
  try {
    const [candles1h, candles4h] = await Promise.all([
      fetchCandles(symbol, "1h", CANDLE_LIMIT),
      fetchCandles(symbol, "4h", 200)
    ]);
    if (!candles1h || candles1h.length < 100) { _trackNull("insufficient-candles"); return null; }
    return scoreFromData(symbol, candles1h, candles4h, regime, state);
  } catch (err) {
    console.error(`[scoreSymbol:${symbol}]`, err.message || err);
    _trackNull("score-error");
    return null;
  }
}

export function scoreFromData(symbol, candles1h, candles4h, regime, state) {
  try {
    if (!candles1h || candles1h.length < 100) { _trackNull("insufficient-candles"); return null; }
    const disabled = state.disabledSignals || [];

    const closes = candles1h.map(c => c.close);
    const highs = candles1h.map(c => c.high);
    const lows = candles1h.map(c => c.low);
    const volumes = candles1h.map(c => c.volume);
    const n = closes.length;
    const price = closes[n - 1];

    const atrVal = atr(highs, lows, closes, 14);
    const ichi = ichimoku(highs, lows, closes);
    const obvSeries = obv(closes, volumes);
    const obvDiv = detectOBVDivergence(closes, obvSeries, 20);
    const fisherArr = fisher(highs, lows, 10);
    const fisherVal = fisherArr[n - 1];
    const fisherPrev = fisherArr[n - 2] ?? fisherVal;
    const vwapVal = vwap(highs, lows, closes, volumes, 24);
    const vpvr = volumeProfile(closes, volumes, 20);
    const srLevels = findSupportResistance(highs, lows, 50) || { supports: [], resistances: [] };
    const supports = Array.isArray(srLevels.supports) ? srLevels.supports : [];
    const resistances = Array.isArray(srLevels.resistances) ? srLevels.resistances : [];
    const trap = detectLiquidityTrap(price, closes, { supports, resistances }, highs, lows);
    const rsiArr = rsiSeries(closes, 14);
    const rsiVal = rsiArr[n - 1];
    const rsiDiv = detectRSIDivergence(closes, rsiArr, 20);

    const macdRaw = macd(closes) || {};
    const macdResult = {
      crossUp: !!macdRaw.crossUp,
      crossDown: !!macdRaw.crossDown
    };
    const stochResult = stochRSI(closes);
    const adxResultRaw = adx(highs, lows, closes, 14) || {};
    const adxResult = {
      strongTrend: !!adxResultRaw.strongTrend,
      trending: !!adxResultRaw.trending,
      adx: adxResultRaw.adx ?? 0,
      pdi: adxResultRaw.pdi ?? 0,
      mdi: adxResultRaw.mdi ?? 0
    };
    const bb = bollingerBands(closes, 20, 2);
    const pctB = bb.pctB[n - 1];
    const bbWidth = bb?.width?.[n - 1] ?? 0;

    const ribbon = emaRibbon(closes);
    const ema21Series = ema(closes, 21);
    const ema21Val = ema21Series[n - 1] ?? null;
    const volConfirmRaw = volumeConfirmation(volumes) || {};
    const volConfirm = {
      isSignificant: !!volConfirmRaw.isSignificant,
      isClimax: !!volConfirmRaw.isClimax,
      ratio: volConfirmRaw.ratio ?? 1
    };

    const isStrongTrend = !!adxResult.strongTrend;
    const isTrending = !!adxResult.trending || isStrongTrend;
    const atrPct = atrVal / price;

    let h4Trend = "neutral";
    let h4RecentCross = false;
    let h4PullbackEntry = false;
    let h4BearStrong = false;
    if (candles4h && candles4h.length >= 60) {
      const c4 = candles4h.map(c => c.close);
      const h4h = candles4h.map(c => c.high);
      const e20 = ema(c4, 20);
      const e50 = ema(c4, 50);
      const e200 = ema(c4, Math.min(200, c4.length - 1));
      const last = c4.length - 1;

      if (e20[last] > e50[last] && c4[last] > e20[last]) {
        h4Trend = "bullish";
        for (let i = 1; i <= Math.min(20, last - 1); i++) {
          if (e20[last - i] <= e50[last - i] && e20[last - i + 1] > e50[last - i + 1]) {
            h4RecentCross = true;
            break;
          }
        }
        h4PullbackEntry = (c4[last] - e20[last]) / e20[last] < 0.015;
      } else if (e20[last] < e50[last] && c4[last] < e20[last]) {
        h4Trend = "bearish";
        for (let i = 1; i <= Math.min(20, last - 1); i++) {
          if (e20[last - i] >= e50[last - i] && e20[last - i + 1] < e50[last - i + 1]) {
            h4RecentCross = true;
            break;
          }
        }
        h4PullbackEntry = (e20[last] - c4[last]) / e20[last] < 0.015;
        const belowE200 = e200[last] && c4[last] < e200[last];
        const lowerHighs =
          last >= 8 &&
          h4h[last] < h4h[last - 4] &&
          h4h[last - 4] < h4h[last - 8];
        h4BearStrong = !!belowE200 && lowerHighs;
      }
    }

    // 4H RSI higher lows: bullish momentum divergence across >= 3 swing lows
    const rsiHigherLows = (candles4h && candles4h.length >= 20)
      ? detectRsiHigherLows(candles4h, 3, 80)
      : { detected: false, lowCount: 0, strength: 0 };

    // 4H RSI lower highs: bearish momentum divergence across >= 3 swing highs
    const rsiLowerHighs = (candles4h && candles4h.length >= 20)
      ? detectRsiLowerHighs(candles4h, 3, 80)
      : { detected: false, highCount: 0, strength: 0 };

    let longScore = 0;
    let shortScore = 0;
    const reasons = [];
    const hasReason = (list, name) => list.includes(name);

    const TIERS = {
      weak: 0.5,
      medium: 1,
      strong: 2
    };

    const add = (cond, name, isLong, weight = TIERS.medium) => {
      if (!cond || disabled.includes(name)) return;
      const dynMult = getSignalMultiplier(name, state, regime?.label);
      const effectiveWeight = weight * dynMult;
      if (effectiveWeight < 0.12) return;
      if (isLong) longScore += effectiveWeight;
      else shortScore += effectiveWeight;
      reasons.push(name);
    };

    if (isStrongTrend) {
      add(ribbon.bullishAligned && ribbon.expanding && ribbon.priceAboveAll, "ema-ribbon-bull", true, TIERS.strong);
      add(ribbon.bearishAligned && ribbon.expanding && ribbon.priceBelowAll, "ema-ribbon-bear", false, TIERS.strong);
      add(h4Trend === "bullish" && h4RecentCross, "h4-bull", true, TIERS.strong);
      add(h4Trend === "bullish" && h4PullbackEntry && !h4RecentCross, "h4-bull-pb", true, TIERS.medium);
      add(h4BearStrong, "h4-bear-strong", false, TIERS.strong);
      add(h4Trend === "bearish" && h4RecentCross && !h4BearStrong, "h4-bear", false, TIERS.strong);
      add(h4Trend === "bearish" && h4PullbackEntry && !h4RecentCross, "h4-bear-pb", false, TIERS.medium);
    } else if (!isTrending) {
      // Lowered bbWidth threshold: quiet sideways markets have BBs at 0.015-0.025
      const isGoodRange =
        (adxResult?.adx ?? 0) < 18 &&
        bbWidth > 0.015;

      const nearSupport = supports.some(s => Math.abs(price - s) / price < 0.003);
      const nearResistance = resistances.some(r => Math.abs(price - r) / price < 0.003);

      const mrBullConfirm = [
        rsiDiv.type === "bullish",
        stochResult.crossUp && stochResult.k < 35,
        volConfirm.isSignificant && pctB < 0.20,
        fisherVal < -1.5 && fisherVal > fisherPrev
      ].filter(Boolean).length;

      const mrBearConfirm = [
        rsiDiv.type === "bearish",
        stochResult.crossDown && stochResult.k > 65,
        volConfirm.isSignificant && pctB > 0.80,
        fisherVal > 1.5 && fisherVal < fisherPrev
      ].filter(Boolean).length;

      if (isGoodRange) {
        const supportActuallyTested = nearSupport && supports.some(s =>
          lows.slice(-4).some(l => l <= s * 1.002) &&
          closes[n - 1] > s
        );
        add(rsiVal < 38 && supportActuallyTested && mrBullConfirm >= 1, "rsi-support-bounce", true, TIERS.medium);
        add(rsiVal > 65 && nearResistance && mrBearConfirm >= 1, "rsi-resistance-reject", false, TIERS.medium);

        if (!nearSupport && !nearResistance) {
          const rsiPrev2 = rsiArr[n - 3] ?? rsiVal;
          const rsiTurningDown = rsiArr[n - 1] < rsiArr[n - 2] && rsiArr[n - 2] < rsiPrev2;
          const rsiTurningUp = rsiArr[n - 1] > rsiArr[n - 2] && rsiArr[n - 2] > rsiPrev2;
          const bbRejectionBear =
            pctB > 0.85 &&
            closes[n - 1] < bb.upper[n - 1] &&
            closes[n - 2] >= bb.upper[n - 2];
          const bbRejectionBull =
            pctB < 0.15 &&
            closes[n - 1] > bb.lower[n - 1] &&
            closes[n - 2] <= bb.lower[n - 2];

          add(rsiVal < 35 && rsiTurningUp && mrBullConfirm >= 1, "rsi-oversold", true, TIERS.medium);
          add(rsiVal > 65 && rsiTurningDown && mrBearConfirm >= 1, "rsi-overbought", false, TIERS.medium);
          add(bbRejectionBull && mrBullConfirm >= 1, "bb-oversold", true, TIERS.medium);
          add(bbRejectionBear && mrBearConfirm >= 1, "bb-overbought", false, TIERS.medium);
        }
      } else {
        _trackNull("no-good-range");
        return null;
      }
    } else {
      const adxVal = adxResult?.adx ?? 0;

      if (adxVal >= 18) {
        // Mild trend: raise weights so ribbon+h4 alignment alone can approach minScore
        add(ribbon.bullishAligned, "ema-ribbon-bull", true, TIERS.strong);
        add(ribbon.bearishAligned, "ema-ribbon-bear", false, TIERS.strong);
        add(h4Trend === "bullish", "h4-bull", true, TIERS.strong);
        add(h4Trend === "bearish", "h4-bear", false, TIERS.strong);
        // Add VWAP alignment as secondary boost in mild trend
        add(ribbon.bullishAligned && price > vwapVal, "mild-vwap-bull", true, TIERS.medium);
        add(ribbon.bearishAligned && price < vwapVal, "mild-vwap-bear", false, TIERS.medium);
        longScore *= 0.90;
        shortScore *= 0.90;
        reasons.push("mild-trend");
      } else {
        // Transition: add h4 alignment and raise ribbon to medium
        add(ribbon.bullishAligned, "ema-ribbon-bull", true, TIERS.medium);
        add(ribbon.bearishAligned, "ema-ribbon-bear", false, TIERS.medium);
        add(h4Trend === "bullish", "h4-bull", true, TIERS.medium);
        add(h4Trend === "bearish", "h4-bear", false, TIERS.medium);
        longScore *= 0.90;
        shortScore *= 0.90;
        reasons.push("transition-market");
      }
    }

    const rsiPrev2Global = rsiArr[n - 3] ?? rsiVal;
    const rsiTurningUp = rsiArr[n - 1] > rsiArr[n - 2] && rsiArr[n - 2] > rsiPrev2Global;
    const rsiTurningDown = rsiArr[n - 1] < rsiArr[n - 2] && rsiArr[n - 2] < rsiPrev2Global;
    const isInBullRegime = regime?.label === "bull";
    const recentRsi = rsiArr.slice(-15).filter(Number.isFinite);
    const minRecentRsi = recentRsi.length ? Math.min(...recentRsi) : rsiVal;
    const maxRecentRsi = recentRsi.length ? Math.max(...recentRsi) : rsiVal;
    const rsiDivBullConfirmed = isInBullRegime
      ? rsiDiv.type === "bullish" &&
        rsiDiv.strength >= 6 &&
        rsiTurningUp &&
        minRecentRsi < 38 &&
        h4Trend !== "bearish"
      : rsiDiv.type === "bullish" &&
        rsiDiv.strength >= 8.0 &&
        rsiVal < 42 &&
        price > vwapVal &&
        h4Trend !== "bearish" &&
        rsiTurningUp;
    const rsiDivBearConfirmed = isInBullRegime
      ? rsiDiv.type === "bearish" &&
        rsiDiv.strength >= 8 &&
        maxRecentRsi > 65 &&
        h4Trend !== "bullish"
      : rsiDiv.type === "bearish" &&
        rsiDiv.strength >= 8 &&
        rsiVal > 58 &&
        price < vwapVal;
    add(rsiDivBullConfirmed, "rsi-bull-div", true, isInBullRegime ? TIERS.medium : TIERS.weak);
    add(rsiDivBearConfirmed, "rsi-bear-div", false, isInBullRegime ? TIERS.medium : TIERS.weak);
    add(
      obvDiv.type === "bullish" &&
      price > vwapVal &&
      rsiVal < 50 &&
      h4Trend !== "bearish",
      "OBV-bull-div",
      true,
      TIERS.weak
    );
    add(
      obvDiv.type === "bearish" &&
      price < vwapVal &&
      h4Trend !== "bullish",
      "OBV-bear-div",
      false,
      TIERS.weak
    );
    const strongBounce =
      closes[n - 1] > closes[n - 2] &&
      (closes[n - 1] - lows[n - 1]) > (highs[n - 1] - closes[n - 1]);
    const candleRange = highs[n - 1] - lows[n - 1];
    const upperWick = highs[n - 1] - closes[n - 1];
    const bearishCandle = candleRange > 0 && upperWick / candleRange > 0.5;
    const lastVolumes = volumes.slice(-5);
    const maxVolIdx = lastVolumes.indexOf(Math.max(...lastVolumes));
    const climaxBarIndex = Math.max(0, n - 5 + maxVolIdx);
    const climaxBarBearish =
      closes[climaxBarIndex] < (candles1h[climaxBarIndex]?.open ?? closes[climaxBarIndex]);
    const climaxBarBullish =
      closes[climaxBarIndex] > (candles1h[climaxBarIndex]?.open ?? closes[climaxBarIndex]);
    const trapFreshBear = srLevels.resistances.some((resistance) =>
      highs.slice(-3).some((high) => high > resistance)
    );
    const trapFreshBull = srLevels.supports.some((support) =>
      lows.slice(-3).some((low) => low < support)
    );
    const bullTrapRsiLayer = trap === "bear-trap" && rsiVal < 38 && rsiTurningUp;
    const bullTrapCandleLayer = trap === "bear-trap" && strongBounce;
    const bullTrapVolumeLayer =
      trap === "bear-trap" &&
      volConfirm.isClimax &&
      climaxBarBullish &&
      trapFreshBull;
    const bearTrapRsiLayer = trap === "bull-trap" && rsiVal > 62 && rsiTurningDown;
    const bearTrapCandleLayer = trap === "bull-trap" && bearishCandle;
    const bearTrapVolumeLayer =
      trap === "bull-trap" &&
      volConfirm.isClimax &&
      climaxBarBearish &&
      trapFreshBear;
    const bullTrapLayers = [
      trap === "bear-trap",
      bullTrapRsiLayer,
      bullTrapCandleLayer,
      bullTrapVolumeLayer
    ].filter(Boolean).length;
    const bearTrapLayers = [
      trap === "bull-trap",
      bearTrapRsiLayer,
      bearTrapCandleLayer,
      bearTrapVolumeLayer
    ].filter(Boolean).length;
    const trapBearQuality =
      trap === "bull-trap" &&
      price < vwapVal &&
      h4Trend === "bearish" &&
      adxResult.pdi < adxResult.mdi &&
      rsiVal < 55;
    const liquidityBearQuality =
      regime.label !== "sideways" &&
      regime.label !== "chop" &&
      bearTrapLayers >= 3 &&
      h4Trend === "bearish" &&
      price < vwapVal &&
      price < ichi.senkouA &&
      price < ichi.senkouB &&
      adxResult.mdi > adxResult.pdi &&
      rsiVal < 58 &&
      bearishCandle;
    const allowLiquidityBearReason =
      liquidityBearQuality &&
      h4Trend === "bearish" &&
      price < vwapVal &&
      ribbon.bearishAligned &&
      adxResult.mdi > adxResult.pdi &&
      shortScore >= 4;
    const liquidityBullValid =
      bullTrapLayers >= 2 &&
      h4Trend !== "bearish";
    add(liquidityBullValid, "liquidity-bull", true, TIERS.medium);
    if (allowLiquidityBearReason) {
      reasons.push("liquidity-bear");
    }
    add(
      bullTrapLayers >= 3 &&
      bullTrapRsiLayer &&
      bullTrapCandleLayer &&
      trap === "bear-trap" &&
      rsiVal > 42 &&
      price >= vwapVal * 0.995,
      "trap-bull-confirm",
      true,
      TIERS.weak
    );
    add(
      bearTrapLayers >= 3 &&
      bearTrapRsiLayer &&
      bearTrapCandleLayer &&
      trapBearQuality,
      "trap-bear-confirm",
      false,
      TIERS.weak
    );
    add(
      bullTrapLayers >= 3 &&
      bullTrapVolumeLayer &&
      trap === "bear-trap" &&
      volConfirm.isClimax &&
      price >= vwapVal * 0.995,
      "trap-vol-bull",
      true,
      TIERS.weak
    );
    const macdCrossUpValid =
      macdResult.crossUp &&
      isTrending &&
      (macdRaw.signal ?? 0) < 0 &&
      Math.abs(macdRaw.histogram ?? 0) > Math.abs((macd(closes.slice(0, -1)) || {}).histogram ?? 0) * 1.2 &&
      h4Trend === "bullish" &&
      price > vwapVal &&
      price > ichi.senkouA &&
      price > ichi.senkouB &&
      ribbon.bullishAligned;

    const macdCrossDownValid =
      macdResult.crossDown &&
      isTrending &&
      (macdRaw.signal ?? 0) > 0 &&
      Math.abs(macdRaw.histogram ?? 0) > Math.abs((macd(closes.slice(0, -1)) || {}).histogram ?? 0) * 1.2 &&
      h4Trend === "bearish" &&
      price < vwapVal &&
      price < ichi.senkouA &&
      price < ichi.senkouB &&
      ribbon.bearishAligned;

    add(macdCrossUpValid, "macd-cross-up", true, TIERS.medium);
    add(macdCrossDownValid, "macd-cross-down", false, TIERS.medium);
    const stochOversoldConfirmed =
      stochResult.oversold &&
      stochResult.crossUp &&
      rsiVal < 45 &&
      price > vwapVal &&
      h4Trend !== "bearish";
    const rsiBullRegimeOversold = isInBullRegime
      ? rsiVal < 42 && rsiTurningUp && price >= vwapVal * 0.995
      : rsiVal < 35 && rsiTurningUp;
    const bbRejectBull =
      pctB < 0.10 &&
      closes[n - 1] > bb.lower[n - 1] &&
      closes[n - 2] <= bb.lower[n - 2];
    if (!isTrending) {
      add(stochOversoldConfirmed, "stochrsi-oversold", true, TIERS.weak);
      add(stochResult.overbought, "stochrsi-overbought", false, TIERS.weak);
    }
    add(
      !hasReason(reasons, "rsi-oversold") && rsiBullRegimeOversold && h4Trend !== "bearish",
      "rsi-oversold",
      true,
      TIERS.weak
    );
    add(
      !hasReason(reasons, "bb-oversold") && bbRejectBull && rsiTurningUp && h4Trend !== "bearish",
      "bb-oversold",
      true,
      TIERS.weak
    );
    // Only valid in bull/sideways — in bear regime a stoch cross-up is a bounce to fade, not a long signal
    add(stochResult.crossUp && stochResult.k < 30 && regime?.label !== "bear", "stochrsi-cross-up", true, TIERS.weak);
    add(stochResult.crossDown && stochResult.k > 50, "stochrsi-cross-down", false, TIERS.weak);

    const ichiPrev = n > 53 ? ichimoku(highs.slice(0, -1), lows.slice(0, -1), closes.slice(0, -1)) : null;
    const tkBullCross = ichi.tkCross > 0 && (ichiPrev?.tkCross ?? 0) <= 0;
    const tkBearCross = ichi.tkCross < 0 && (ichiPrev?.tkCross ?? 0) >= 0;
    add(tkBullCross, "TK-bull", true, TIERS.medium);
    add(tkBearCross, "TK-bear", false, TIERS.medium);
    const cloudTop = Math.max(ichi.senkouA, ichi.senkouB);
    const cloudBottom = Math.min(ichi.senkouA, ichi.senkouB);
    const aboveCloud = price > cloudTop;
    const belowCloud = price < cloudBottom;
    const wasBelowCloud = closes.slice(-8, -1).some(c => c < cloudTop);
    const wasAboveCloud = closes.slice(-8, -1).some(c => c > cloudBottom);
    const aboveCloudBreakout =
      aboveCloud &&
      wasBelowCloud &&
      ribbon.bullishAligned &&
      h4Trend === "bullish";
    const belowCloudBreakdown =
      belowCloud &&
      wasAboveCloud &&
      ribbon.bearishAligned &&
      h4Trend === "bearish";
    if (isTrending) {
      add(aboveCloudBreakout, "above-cloud", true, TIERS.weak);
      add(belowCloudBreakdown, "below-cloud", false, TIERS.medium);
    }
    const chikouAbove = n > 27 && ichi.chikou > ichi.chikouCompare;
    const chikouBelow = n > 27 && ichi.chikou < ichi.chikouCompare;
    const chikouWasBelow = n > 32 && [1, 2, 3, 4].some(i => closes[n - 1 - i] <= closes[n - 27 - i]);
    const chikouWasAbove = n > 32 && [1, 2, 3, 4].some(i => closes[n - 1 - i] >= closes[n - 27 - i]);
    add(chikouAbove && chikouWasBelow, "chikou-bull", true, TIERS.weak);
    add(chikouBelow && chikouWasAbove, "chikou-bear", false, TIERS.weak);

    const fisherCrossUp = fisherPrev <= 0 && fisherVal > 0;
    const fisherCrossDown = fisherPrev >= 0 && fisherVal < 0;
    const fisherTurnBull = fisherPrev < -1.5 && fisherVal > fisherPrev;
    const fisherTurnBear = fisherPrev > 1.5 && fisherVal < fisherPrev;
    const fisherBullZeroCross =
      fisherCrossUp &&
      price > vwapVal &&
      h4Trend === "bullish" &&
      adxResult.pdi > adxResult.mdi;
    const fisherBearZeroCross =
      fisherCrossDown &&
      price < vwapVal &&
      h4Trend === "bearish" &&
      adxResult.mdi > adxResult.pdi;
    const fisherBullMomentum =
      fisherVal > fisherPrev &&
      fisherVal < -0.5 &&
      price > vwapVal &&
      h4Trend === "bullish" &&
      adxResult.pdi > adxResult.mdi;
    const fisherBearMomentum =
      fisherVal < fisherPrev &&
      fisherVal > 0.5 &&
      price < vwapVal &&
      h4Trend === "bearish" &&
      adxResult.mdi > adxResult.pdi;
    const fisherBullReversal =
      fisherVal < -1.8 &&
      fisherVal > fisherPrev &&
      price > vwapVal * 0.995 &&
      (rsiVal < 40 || stochResult.crossUp);
    add(
      fisherBullZeroCross || (fisherTurnBull && fisherBullMomentum),
      "fisher-rising",
      true,
      TIERS.weak
    );
    add(
      fisherBearZeroCross || (fisherTurnBear && fisherBearMomentum),
      "fisher-falling",
      false,
      TIERS.weak
    );
    if (!isTrending) {
      add(fisherBullReversal, "fisher-oversold", true, TIERS.weak);
      add(fisherVal > 2.0, "fisher-overbought", false, TIERS.medium);
    }

    const vwapCrossUp =
      price > vwapVal &&
      closes.slice(-5, -1).some(c => c < vwapVal);
    const vwapCrossDown =
      price < vwapVal &&
      closes.slice(-5, -1).some(c => c > vwapVal);
    const vwapBounce =
      price > vwapVal &&
      lows[n - 1] < vwapVal * 1.003 &&
      closes[n - 1] > vwapVal;
    const vwapReject =
      price < vwapVal &&
      highs[n - 1] > vwapVal * 0.997 &&
      closes[n - 1] < vwapVal;
    add(vwapCrossUp || vwapBounce, "above-VWAP", true, TIERS.medium);
    add(vwapCrossDown || vwapReject, "below-VWAP", false, TIERS.medium);
    add(
      ribbon.wasCompressed && ribbon.expanding && ribbon.bullishAligned,
      "ribbon-expansion-bull",
      true,
      TIERS.strong
    );
    add(
      ribbon.wasCompressed &&
      ribbon.expanding &&
      ribbon.bearishAligned &&
      price < vwapVal &&
      adxResult.mdi > adxResult.pdi,
      "ribbon-expansion-bear",
      false,
      TIERS.medium
    );

    add(ribbon.bullishAligned && h4Trend === "bullish", "ribbon-h4-align-bull", true, TIERS.medium);
    add(ribbon.bearishAligned && h4Trend === "bearish", "ribbon-h4-align-bear", false, TIERS.medium);

    // (b) Bull-pullback boost: RSI dipping to 40-50 with stoch cross-up is the
    // clearest dip-buy signal in a bull trend — weight it above weak signals
    const bullPullbackDip =
      regime?.label === "bull" &&
      h4Trend === "bullish" &&
      ribbon.bullishAligned &&
      rsiVal >= 38 && rsiVal <= 52 &&
      stochResult.crossUp &&
      stochResult.k < 50;
    add(bullPullbackDip, "bull-pb-dip-buy", true, TIERS.strong);

    // (c) EMA21 bounce: price tagging EMA21 from above while h4 bullish + ribbon aligned
    // is a high-quality continuation entry missed by existing signals
    const ema21Bounce =
      regime?.label === "bull" &&
      h4Trend === "bullish" &&
      ribbon.bullishAligned &&
      ema21Val !== null &&
      price > ema21Val &&
      lows[n - 1] <= ema21Val * 1.005 &&
      closes[n - 1] > ema21Val &&
      rsiVal < 55 &&
      rsiTurningUp;
    add(ema21Bounce, "ema21-bounce-bull", true, TIERS.strong);

    // 4H RSI higher lows: 3+ consecutive higher RSI swing lows while price flat/lower
    // = classic hidden bullish divergence. Gate with h4=bullish + bull regime.
    const rsiHLBullSignal =
      rsiHigherLows.detected &&
      regime?.label === "bull" &&
      h4Trend === "bullish" &&
      ribbon.bullishAligned;
    add(rsiHLBullSignal, "4h-rsi-higher-lows", true, TIERS.strong);
    add(
      rsiHLBullSignal && (stochResult.crossUp || vwapBounce),
      "4h-rsi-hl-confirmed",
      true,
      TIERS.medium
    );

    // 4H RSI higher lows in sideways: accumulation inside range — only valid when
    // price is in lower half of BB (pctB < 0.40), near support, with 1 MR confirm.
    // Without location + confirmation it fires mid-range with no edge.
    const nearSupportSideways = supports.some(s => Math.abs(price - s) / price < 0.005);
    const mrConfirmSideways =
      (stochResult.crossUp && stochResult.k < 40) ||
      (fisherVal < -1.5 && fisherVal > fisherPrev) ||
      rsiDiv.type === "bullish";
    const rsiHLSidewaysSignal =
      rsiHigherLows.detected &&
      regime?.label === "sideways" &&
      pctB < 0.40 &&
      nearSupportSideways &&
      mrConfirmSideways;
    add(rsiHLSidewaysSignal, "4h-rsi-hl-sideways", true, TIERS.medium);

    // 4H RSI lower highs: 3+ consecutive lower RSI highs while price highs flat/rising
    // = bearish momentum divergence.
    // Bear regime: valid whenever h4=bearish + ribbon bearish aligned.
    // Sideways: additionally requires nearResistance + MR confirmation (otherwise fires mid-range).
    const nearResistanceSideways = resistances.some(r => Math.abs(price - r) / price < 0.005);
    const mrConfirmBearSideways =
      (stochResult.crossDown && stochResult.k > 60) ||
      (fisherVal > 1.5 && fisherVal < fisherPrev) ||
      rsiDiv.type === "bearish";

    const rsiLHBearBase =
      rsiLowerHighs.detected &&
      h4Trend === "bearish" &&
      ribbon.bearishAligned;

    const rsiLHBearSignal =
      rsiLHBearBase && regime?.label === "bear";
    const rsiLHSidewaysSignal =
      rsiLHBearBase && regime?.label === "sideways" &&
      nearResistanceSideways && mrConfirmBearSideways;

    add(rsiLHBearSignal, "4h-rsi-lower-highs", false, TIERS.strong);
    add(rsiLHSidewaysSignal, "4h-rsi-lh-sideways", false, TIERS.medium);
    // Extra confirmation bonus for bear regime (stoch cross-down or VWAP reject)
    add(
      rsiLHBearSignal && (stochResult.crossDown || vwapReject),
      "4h-rsi-lh-confirmed",
      false,
      TIERS.medium
    );

    if (volConfirm.isSignificant) {
      longScore += 1;
      shortScore += 1;
      reasons.push("volume");
    }

    if (atrPct < 0.003) {
      longScore *= 0.7;
      shortScore *= 0.7;
      reasons.push("low-volatility");
    }

    const highVolumeNodes = Array.isArray(vpvr?.highVolumeNodes) ? vpvr.highVolumeNodes : [];
    if (highVolumeNodes.some(node => price >= node.low && price <= node.high)) {
      longScore *= 0.7;
      shortScore *= 0.7;
      reasons.push("in-HVN");
    }

    if (ribbon.bullishAligned && rsiVal > 70) {
      longScore *= 0.7;
      reasons.push("trend-vs-overbought");
    }
    if (ribbon.bearishAligned && rsiVal < 30) {
      shortScore *= 0.7;
      reasons.push("trend-vs-oversold");
    }
    const isTrendChaseLong = reasons.includes("ema-ribbon-bull") || reasons.includes("h4-bull");
    const isTrendChaseShort =
      reasons.includes("ema-ribbon-bear") ||
      reasons.includes("h4-bear") ||
      reasons.includes("h4-bear-strong");
    const isDipBuy = h4PullbackEntry || reasons.includes("rsi-support-bounce");
    const isDipSell = h4PullbackEntry || reasons.includes("rsi-resistance-reject");
    if (h4Trend === "bullish" && price < vwapVal && isTrendChaseLong && !isDipBuy) {
      longScore *= 0.75;
      reasons.push("htf-vs-vwap");
    }
    if (h4Trend === "bearish" && price > vwapVal && isTrendChaseShort && !isDipSell) {
      shortScore *= 0.75;
      reasons.push("htf-vs-vwap");
    }

    const scoreDiff = Math.abs(longScore - shortScore);
    const minDiff = regime.label === "chop" ? 1.5 : 0.5;
    if (scoreDiff < minDiff) { _trackNull("scoreDiff"); return null; }

    const isBullPullback =
      regime?.label === "bull" &&
      h4Trend === "bullish" &&
      trap === "none" &&
      isTrending &&
      (
        Math.abs(price - vwapVal) / price < 0.005 ||
        (!ribbon.priceAboveAll && ribbon.bullishAligned)
      ) &&
      (rsiTurningUp || stochResult.crossUp || vwapBounce);

    let setupType = "unknown";
    if (isBullPullback) {
      setupType = "bull-pullback";
    } else if (ribbon.wasCompressed && ribbon.expanding) {
      setupType = "breakout";
    } else if (trap !== "none") {
      setupType = "liquidity-trap";
    } else if (!isTrending) {
      setupType = "mean-reversion";
    } else if (isStrongTrend) {
      setupType = "trend";
    } else if (isTrending) {
      setupType = "momentum";
    }

    const dominantSignal = longScore > shortScore ? "long" : "short";
    const candidateBullContinuation =
      (setupType === "momentum" || setupType === "unknown") &&
      regime.label === "bull" &&
      dominantSignal === "long" &&
      h4Trend === "bullish" &&
      h4PullbackEntry &&
      trap === "none" &&
      isTrending;

    if (candidateBullContinuation) {
      setupType = "bull-continuation";
    }

    const baseMinScore = regime.label === "chop" ? 4 : 3;
    const minScore = setupType === "mean-reversion"
      ? Math.max(baseMinScore, 4.5)
      : setupType === "bull-pullback"
        ? 3.5
        : baseMinScore;
    let signal = null;
    let score = 0;

    if (longScore >= minScore && longScore > shortScore) {
      signal = "long";
      score = longScore;
    } else if (shortScore >= minScore) {
      signal = "short";
      score = shortScore;
    }

    if (!signal) {
      // ── Pre-boost rescue paths before giving up ──────────────────────────

      // BEAR: apply scoreBearShort boost to shortScore pre-selection so
      // marginal shorts (scoring 1-2) can qualify instead of dying here
      if (regime?.label === "bear") {
        const nearRes = resistances.some(r => Math.abs(price - r) / price < 0.005);
        const bearBoostEarly = scoreBearShort(
          "short", price, rsiVal, fisherVal, stochResult,
          vwapVal, adxResult, pctB, nearRes, obvDiv.type,
          atrVal, bb.upper[n - 1], bb.middle[n - 1], reasons, shortScore
        );
        shortScore += bearBoostEarly.scoreBoost;
        if (shortScore >= minScore) {
          signal = "short";
          score = shortScore;
        }
      }

      // BULL: symmetric boost for longs — RSI oversold bounce at support,
      // VWAP reclaim, ribbon bullish aligned
      if (!signal && regime?.label === "bull") {
        const nearSup = supports.some(s => Math.abs(price - s) / price < 0.005);
        let bullBoost = 0;
        if (nearSup && rsiVal < 40)            bullBoost += 1.5;
        if (price > vwapVal && rsiTurningUp)   bullBoost += 1.0;
        if (ribbon.bullishAligned)             bullBoost += 1.0;
        if (h4Trend === "bullish")             bullBoost += 0.75;
        longScore += bullBoost;
        if (longScore >= minScore && longScore > shortScore) {
          signal = "long";
          score = longScore;
        }
      }

      // SIDEWAYS: try dedicated MR scorer before giving up
      if (!signal && regime?.label === "sideways") {
        const mrResult = scoreSidewaysMeanReversion({
          price, closes, highs, lows, volumes,
          rsiVal, stochResult, fisherVal, fisherPrev,
          pctB,
          bbUpper:  bb.upper[n - 1],
          bbLower:  bb.lower[n - 1],
          bbMiddle: bb.middle[n - 1],
          bbWidth,
          vwapVal, currentEMA20: ema21Val,
          supports, resistances,
          adxResult, atrVal,
          obvDiv: obvDiv.type, volConfirm,
          regime
        });
        if (mrResult) {
          return {
            symbol,
            direction: mrResult.signal,
            ema21: ema21Val,
            signalCandleHigh: highs[n - 1],
            signalCandleLow:  lows[n - 1],
            signalCandleClose: closes[n - 1],
            fundingRate: null,
            h4Trend, atrPct,
            _candles1h: candles1h,
            _srLevels: srLevels,
            ...mrResult
          };
        }
      }

      if (!signal) {
        _trackNull("no-signal");
        const best = Math.max(longScore, shortScore);
        if (best < 1)       _trackNull("no-signal:<1");
        else if (best < 2)  _trackNull("no-signal:1-2");
        else if (best < 3)  _trackNull("no-signal:2-3");
        else                _trackNull("no-signal:>=3(wrong-dir)");
        return null;
      }
    }

    if (
      signal === "short" &&
      reasons.includes("trap-bear-confirm") &&
      (
        h4Trend !== "bearish" ||
        price > vwapVal ||
        adxResult.pdi > adxResult.mdi ||
        rsiVal > 60
      )
    ) {
      _trackNull("trap-bear-confirm"); return null;
    }

    const h4Score = score4H(candles4h);

    if ((setupType === "trend" || setupType === "breakout") && !h4Score.aligned(signal)) {
      _trackNull("h4-misaligned"); return null;
    }
    if (setupType === "momentum" && !h4Score.aligned(signal)) {
      score *= 0.80;
      if (score < minScore) { _trackNull("momentum-h4-penalty"); return null; }
    }

    reasons.push(...h4Score.signals);
    if (signal === "long") score += h4Score.bullScore * 0.5;
    if (signal === "short") score += h4Score.bearScore * 0.5;

    const quality =
      (ribbon.bullishAligned || ribbon.bearishAligned ? 1 : 0) +
      (h4Trend !== "neutral" ? 1 : 0) +
      (Math.abs(price - vwapVal) / price > 0.002 ? 1 : 0) +
      (volConfirm.isSignificant ? 1 : 0);

    const nearSupport = supports.some(s => Math.abs(price - s) / price < 0.005);
    const nearResistance = resistances.some(r => Math.abs(price - r) / price < 0.005);
    const inHVN = highVolumeNodes.some(node => price >= node.low && price <= node.high);

    if (setupType === "liquidity-trap" && reasons.includes("transition-market")) {
      score *= 0.85;
    }

    if (setupType === "mean-reversion") {
      const isSidewaysRegime = regime?.label === "sideways";
      const extremeOscillatorLong =
        stochResult.oversold || fisherVal < -2.0 || rsiVal < 35 || pctB < 0.05;
      const extremeOscillatorShort =
        stochResult.overbought || fisherVal > 2.0 || rsiVal > 65 || pctB > 0.95;
      const hasLocationEdge =
        (signal === "long" && nearSupport) ||
        (signal === "short" && nearResistance);
      const hasExtreme =
        (signal === "long" && extremeOscillatorLong) ||
        (signal === "short" && extremeOscillatorShort);
      const h4AlignedAgainstMr =
        (signal === "long" && h4Trend === "bearish") ||
        (signal === "short" && h4Trend === "bullish");
      const recentVols = volumes.slice(-5);
      const priorVols = volumes.slice(-10, -5);
      const recentAvgVol = recentVols.reduce((a, b) => a + b, 0) / Math.max(recentVols.length, 1);
      const priorAvgVol = priorVols.reduce((a, b) => a + b, 0) / Math.max(priorVols.length, 1);
      const volumeDeclining = recentVols.length === 5 &&
        priorVols.length === 5 &&
        priorAvgVol > 0 &&
        recentAvgVol < priorAvgVol * 0.8;
      const bbWidthPrev = bb.width?.[n - 5] ?? bbWidth;
      const bandwidthContracting = Number.isFinite(bbWidth) &&
        Number.isFinite(bbWidthPrev) &&
        bbWidth < bbWidthPrev;

      if (!isSidewaysRegime) { _trackNull("mr-not-sideways"); return null; }
      if (!hasLocationEdge || !hasExtreme) { _trackNull("mr-no-edge"); return null; }
      if (hasReason(reasons, "transition-market") || h4AlignedAgainstMr) { _trackNull("mr-transition"); return null; }
      if (!volumeDeclining && !bandwidthContracting) {
        score *= 0.8;
        reasons.push("mr-no-vol-confirm");
        if (score < minScore) { _trackNull("mr-no-vol"); return null; }
      }
    }

    // ── Regime-gated setup restrictions ──
    // Block negative-EV crosses identified by backtest analysis
    if (setupType === "breakout" && regime?.label === "bear") { _trackNull("breakout-bear"); return null; }
    if (setupType === "trend" && regime?.label === "bull" && signal === "short" && score < 6) { _trackNull("trend-bull-short"); return null; }
    if (setupType === "liquidity-trap" && signal === "long" && regime?.label === "bear" && score < 6) { _trackNull("lt-bear-long"); return null; }
    if (setupType === "momentum" && signal === "long" && regime?.label === "bear" && score < 6) { _trackNull("momentum-bear-long"); return null; }

    // (a) Block shorts in strong bull: h4 bullish + ribbon aligned + bull regime requires
    // very high conviction to short — fighting the trend destroys WR
    if (
      signal === "short" &&
      regime?.label === "bull" &&
      h4Trend === "bullish" &&
      ribbon.bullishAligned &&
      score < 6
    ) {
      _trackNull("short-in-bull-trend");
      return null;
    }

    if (setupType === "breakout") {
      const h4Aligned =
        (signal === "long" && h4Trend === "bullish") ||
        (signal === "short" && h4Trend === "bearish");
      const cloudAligned =
        (signal === "long" && price > ichi.senkouA && price > ichi.senkouB) ||
        (signal === "short" && price < ichi.senkouA && price < ichi.senkouB);
      const vwapAligned =
        (signal === "long" && price > vwapVal) ||
        (signal === "short" && price < vwapVal);
      const activeHVN = highVolumeNodes.find(node => price >= node.low && price <= node.high) || null;
      const deepInHVN = !!activeHVN && (() => {
        const nodeDepth = activeHVN.high - activeHVN.low;
        return price >= activeHVN.low + nodeDepth * 0.15 &&
               price <= activeHVN.high - nodeDepth * 0.15;
      })();
      const hvnEdgeEscape = !!activeHVN && (() => {
        const nodeDepth = activeHVN.high - activeHVN.low;
        const atTopEdge = price >= activeHVN.high - nodeDepth * 0.15 && signal === "long";
        const atBottomEdge = price <= activeHVN.low + nodeDepth * 0.15 && signal === "short";
        return atTopEdge || atBottomEdge;
      })();

      if (!ribbon.wasCompressed || !ribbon.expanding) { _trackNull("breakout-no-ribbon"); return null; }
      if (!volConfirm.isSignificant) { _trackNull("breakout-no-vol"); return null; }
      if (!h4Aligned || !cloudAligned || !vwapAligned) { _trackNull("breakout-align"); return null; }
      if (deepInHVN && !hvnEdgeEscape) { _trackNull("breakout-hvn"); return null; }

      // Bar structure: breakout bar must close with momentum (top/bottom 60% of range)
      // Filters late entries where the breakout candle has already reversed intra-bar
      const barRange = highs[n - 1] - lows[n - 1];
      const barStructureOk = barRange > 0 && (
        signal === "long"
          ? (closes[n - 1] - lows[n - 1]) / barRange > 0.60
          : (highs[n - 1] - closes[n - 1]) / barRange > 0.60
      );
      if (!barStructureOk) { _trackNull("breakout-bar-struct"); return null; }
    }

    if (setupType === "bull-pullback") {
      if (signal !== "long") { _trackNull("bp-not-long"); return null; }
      if (!h4Score.aligned("long")) { _trackNull("bp-h4"); return null; }
      const hasPullbackTrigger = rsiTurningUp || stochResult.crossUp || vwapBounce;
      const hasPullbackLocation =
        Math.abs(price - vwapVal) / price < 0.005 ||
        (!ribbon.priceAboveAll && ribbon.bullishAligned);
      if (!hasPullbackTrigger || !hasPullbackLocation) { _trackNull("bp-no-trigger"); return null; }
    }

    if (setupType === "bull-continuation") {
      if (!h4Score.aligned("long")) { _trackNull("bc-h4"); return null; }
      const hasEntry = rsiTurningUp || stochResult.crossUp || macdCrossUpValid;
      if (!hasEntry) { _trackNull("bc-no-entry"); return null; }
    }

    if (quality < 2 || setupType === "unknown") {
      // Sideways regime fallback: try dedicated MR scoring at BB edges
      if (regime?.label === "sideways") {
        const mrResult = scoreSidewaysMeanReversion({
          price, closes, highs, lows, volumes,
          rsiVal, stochResult, fisherVal, fisherPrev,
          pctB,
          bbUpper:  bb.upper[n - 1],
          bbLower:  bb.lower[n - 1],
          bbMiddle: bb.middle[n - 1],
          bbWidth,
          vwapVal, currentEMA20: ema21Val,
          supports, resistances,
          adxResult, atrVal,
          obvDiv: obvDiv.type, volConfirm,
          regime
        });
        if (mrResult) {
          return {
            symbol,
            direction: mrResult.signal,
            ema21: ema21Val,
            signalCandleHigh: highs[n - 1],
            signalCandleLow:  lows[n - 1],
            signalCandleClose: closes[n - 1],
            fundingRate: null,
            h4Trend, atrPct,
            _candles1h: candles1h,
            _srLevels: srLevels,
            ...mrResult   // signal, score, setupType, reasons, price, sl, tp, riskReward, atrVal, positionSizeMultiplier, maxHoldHours
          };
        }
      }
      _trackNull("low-quality"); return null;
    }

    const structured = calculateStructuredSLTP(
      signal,
      price,
      atrVal,
      highs,
      lows,
      closes,
      volumes,
      { symbol, setupType, vwapVal, candles4h }
    );

    // Bear regime short scoring boost
    let finalScore = score;
    let finalReasons = [...reasons];
    let positionSizeMultiplier = 1.0;
    let maxHoldHours = null;
    let _bearRegime = false;

    if (regime?.label === "bear" && signal === "short") {
      _bearRegime = true;
      const bb = bollingerBands(closes, 20, 2);
      const bearBoost = scoreBearShort(
        signal, price, rsiVal, fisherVal, stochResult,
        vwapVal, adxResult, pctB, nearResistance,
        obvDiv.type, atrVal, bb.upper[n - 1], bb.middle[n - 1],
        reasons, score
      );

      if (bearBoost.scoreBoost > 0) {
        finalScore += bearBoost.scoreBoost;
        finalReasons = [...finalReasons, ...bearBoost.reasons];
        positionSizeMultiplier = bearBoost.positionSizeMultiplier;
        maxHoldHours = bearBoost.maxHoldHours;
      }
    }

    // (d) High-cap position size reduction: BTC/ETH/BNB have 3-4x lower EV per trade
    // than mid/low caps. In non-strong-trend regimes they consolidate too long,
    // waste slots, and drag portfolio EV.
    const HIGH_CAP_SYMBOLS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "BNB-USDT-SWAP"];
    if (
      HIGH_CAP_SYMBOLS.includes(symbol) &&
      !isStrongTrend &&
      regime?.label !== "bear"
    ) {
      positionSizeMultiplier *= 0.50;
    }

    // Score exhaustion: diminishing returns above 7 — too many confirming
    // signals means the move already happened
    if (finalScore > 7) {
      finalScore = 7 + (finalScore - 7) * 0.5;
    }

    // Score-based position sizing: sweet spot (5-7) gets more size, 7+ gets less
    if (finalScore >= 5 && finalScore <= 7) {
      positionSizeMultiplier *= 1.25;
    } else if (finalScore > 7) {
      positionSizeMultiplier *= 0.75;
    }

    return {
      symbol,
      signal,
      direction: signal,
      score: Math.round(finalScore * 10) / 10,
      setupType,
      price,
      atrVal,
      ema21: ema21Val,
      signalCandleHigh: highs[n - 1],
      signalCandleLow: lows[n - 1],
      signalCandleClose: closes[n - 1],
      rsiVal,
      fisherVal,
      obvDiv: obvDiv.type,
      vwapVal,
      adxResult,
      fundingRate: null,
      sl: structured.sl,
      tp: structured.tp,
      riskReward: structured.riskReward,
      reasons: finalReasons,
      h4Trend,
      atrPct,
      positionSizeMultiplier,
      maxHoldHours,
      _bearRegime,
      _requiresShortConfirmation: _bearRegime,
      _candles1h: candles1h,
      _srLevels: srLevels
    };
  } catch (err) {
    console.error(`[scoreFromData:${symbol}]`, err.message || err);
    _trackNull("score-error");
    return null;
  }
}

export function autoApproveSignal(candidate) {
  const {
    signal,
    price,
    vwapVal,
    adxResult,
    h4Trend,
    setupType,
    reasons = []
  } = candidate;

  if (reasons.includes("transition-market")) return false;
  if (setupType === "mean-reversion") return false;

  const h4Aligned = signal === "long"
    ? h4Trend === "bullish"
    : h4Trend === "bearish";

  const vwapAligned = signal === "long"
    ? Number.isFinite(price) && Number.isFinite(vwapVal) && price > vwapVal
    : Number.isFinite(price) && Number.isFinite(vwapVal) && price < vwapVal;

  const adxAligned = !!adxResult?.trending && (
    signal === "long"
      ? adxResult.pdi > adxResult.mdi
      : adxResult.mdi > adxResult.pdi
  );

  return h4Aligned && vwapAligned && adxAligned;
}

export function checkCorrelationExposure(candidate, state) {
  const positions = Object.values(state.positions);
  if (positions.length === 0) return { allowed: true };

  const longCount = positions.filter(p => p.direction === "long").length;
  const shortCount = positions.filter(p => p.direction === "short").length;

  if (candidate.signal === "long" && longCount >= 7) return { allowed: false, reason: "max 7 longs" };
  if (candidate.signal === "short" && shortCount >= 7) return { allowed: false, reason: "max 7 shorts" };

  const dirExposure = positions
    .filter(p => p.direction === candidate.signal)
    .reduce((sum, p) => sum + (p.effectiveExposure || 0), 0);
  const pVal = portfolioValue(state);
  if (pVal > 0 && dirExposure / pVal > 0.6) {
    return { allowed: false, reason: `dir exposure ${((dirExposure / pVal) * 100).toFixed(0)}%>60%` };
  }

  return { allowed: true };
}

export function calculateStructuredSLTP(signal, price, atrVal, highs, lows, closes, volumes, context = {}) {
  const { symbol, setupType, vwapVal, candles4h } = context;
  const n = closes.length;
  const sr = findSupportResistance(highs, lows, 80);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const ema20Val = ema(closes, 20);
  const bb = bollingerBands(closes, 20, 2);
  const vpvr = volumeProfile(closes, volumes, 30);

  const currentMA50 = ma50[n - 1];
  const currentMA200 = ma200[n - 1];
  const currentEMA20 = ema20Val[n - 1];
  const currentBBUpper = bb.upper[n - 1];
  const currentBBLower = bb.lower[n - 1];

  const supportLevels = [];
  const resistanceLevels = [];

  for (const s of sr.supports) supportLevels.push({ price: s, type: "swing-support", strength: 1.0 });
  for (const r of sr.resistances) resistanceLevels.push({ price: r, type: "swing-resistance", strength: 1.0 });

  // 4H swing pivots: institutional structure levels with 3-bar comparison
  if (candles4h && candles4h.length >= 8) {
    const h4sr = findSupportResistanceH4(candles4h, 60);
    for (const s of h4sr.supports) supportLevels.push(s);
    for (const r of h4sr.resistances) resistanceLevels.push(r);
  }

  if (currentMA50) {
    if (currentMA50 < price) supportLevels.push({ price: currentMA50, type: "MA50", strength: 1.2 });
    else resistanceLevels.push({ price: currentMA50, type: "MA50", strength: 1.2 });
  }
  if (currentMA200) {
    if (currentMA200 < price) supportLevels.push({ price: currentMA200, type: "MA200", strength: 1.5 });
    else resistanceLevels.push({ price: currentMA200, type: "MA200", strength: 1.5 });
  }
  if (currentEMA20) {
    if (currentEMA20 < price) supportLevels.push({ price: currentEMA20, type: "EMA20", strength: 0.8 });
    else resistanceLevels.push({ price: currentEMA20, type: "EMA20", strength: 0.8 });
  }

  if (currentBBLower) supportLevels.push({ price: currentBBLower, type: "BB-lower", strength: 0.7 });
  if (currentBBUpper) resistanceLevels.push({ price: currentBBUpper, type: "BB-upper", strength: 0.7 });

  for (const node of vpvr.highVolumeNodes) {
    const nodeCenter = (node.low + node.high) / 2;
    if (nodeCenter < price) supportLevels.push({ price: node.high, type: "HVN-top", strength: 1.3 });
    if (nodeCenter > price) resistanceLevels.push({ price: node.low, type: "HVN-bottom", strength: 1.3 });
  }

  // Cluster levels within 0.3% of each other into one stronger level
  const clusteredSupports = clusterLevels(supportLevels, 0.003).sort((a, b) => b.price - a.price);
  const clusteredResistances = clusterLevels(resistanceLevels, 0.003).sort((a, b) => a.price - b.price);
  // Replace raw arrays with clustered (promote to local vars for the rest of the function)
  const supportLevelsFinal = clusteredSupports;
  const resistanceLevelsFinal = clusteredResistances;

  const atrSL = signal === "long" ? price - atrVal * ATR_SL_MULT : price + atrVal * ATR_SL_MULT;
  const atrTP = signal === "long" ? price + atrVal * ATR_TP_MULT : price - atrVal * ATR_TP_MULT;

  let sl, tp, slType, tpType;

  if (signal === "long") {
    const nearestSupport = supportLevelsFinal.find(s =>
      s.price < price &&
      s.price > price * 0.95 &&
      (price - s.price) > atrVal * 0.3
    );

    if (nearestSupport) {
      const structureSL = nearestSupport.price - atrVal * 0.3;
      if ((price - structureSL) <= atrVal * 2.5) {
        sl = structureSL;
        slType = `below-${nearestSupport.type}@${nearestSupport.price.toFixed(6)}`;
      } else {
        sl = atrSL;
        slType = "atr-default(structure-too-far)";
      }
    } else {
      sl = atrSL;
      slType = "atr-default(no-support)";
    }

    const nearestResistance = resistanceLevelsFinal.find(r =>
      r.price > price &&
      r.price < price * 1.10 &&
      (r.price - price) > atrVal * 1.0
    );

    if (nearestResistance) {
      tp = nearestResistance.price - atrVal * 0.2;
      tpType = `below-${nearestResistance.type}@${nearestResistance.price.toFixed(6)}`;
    } else {
      tp = atrTP;
      tpType = "atr-default(no-resistance)";
    }
  } else {
    const nearestResistance = resistanceLevelsFinal.find(r =>
      r.price > price &&
      r.price < price * 1.05 &&
      (r.price - price) > atrVal * 0.3
    );

    if (nearestResistance) {
      sl = nearestResistance.price + atrVal * 0.3;
      slType = `above-${nearestResistance.type}@${nearestResistance.price.toFixed(6)}`;
      if ((sl - price) > atrVal * 2.5) {
        sl = atrSL;
        slType = "atr-default(structure-too-far)";
      }
    } else {
      sl = atrSL;
      slType = "atr-default(no-resistance)";
    }

    const nearestSupport = supportLevelsFinal.find(s =>
      s.price < price &&
      s.price > price * 0.90 &&
      (price - s.price) > atrVal * 1.0
    );

    if (nearestSupport) {
      tp = nearestSupport.price + atrVal * 0.2;
      tpType = `above-${nearestSupport.type}@${nearestSupport.price.toFixed(6)}`;
    } else {
      tp = atrTP;
      tpType = "atr-default(no-support)";
    }
  }

  if (setupType === "mean-reversion") {
    if (signal === "long") {
      const meanTarget = Math.min(
        currentEMA20 || price * 1.02,
        vwapVal || price * 1.02
      );
      tp = meanTarget - atrVal * 0.1;
      if (tp <= price) tp = price + atrVal * 1.2;
      sl = price - atrVal * 1.2;
      tpType = "mean-reversion-target";
      slType = "mean-reversion-atr-1.2";
    } else {
      const meanTarget = Math.max(
        currentEMA20 || price * 0.98,
        vwapVal || price * 0.98
      );
      tp = meanTarget + atrVal * 0.1;
      if (tp >= price) tp = price - atrVal * 1.2;
      sl = price + atrVal * 1.2;
      tpType = "mean-reversion-target";
      slType = "mean-reversion-atr-1.2";
    }
  }

  let risk = Math.abs(price - sl);
  let reward = Math.abs(tp - price);
  const riskReward = risk > 0 ? reward / risk : 0;

  if (setupType !== "mean-reversion" && riskReward < 1.5) {
    sl = atrSL;
    tp = atrTP;
    slType = "atr-fallback(rr-too-low)";
    tpType = "atr-fallback(rr-too-low)";
    risk = Math.abs(price - sl);
    reward = Math.abs(tp - price);
  }

  return {
    sl, tp, slType, tpType,
    riskReward: risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0,
    supportLevelsFound: supportLevels.length,
    resistanceLevelsFound: resistanceLevels.length
  };
}

export function fundingRateSignal(rate) {
  if (rate === null || rate === undefined) return { signal: "neutral", score: 0, reason: "" };
  if (rate > 0.003) return { signal: "short", score: 2, reason: "funding-extreme-long" };
  if (rate > 0.001) return { signal: "short", score: 1, reason: "funding-crowded-long" };
  if (rate < -0.003) return { signal: "long", score: 2, reason: "funding-extreme-short" };
  if (rate < -0.001) return { signal: "long", score: 1, reason: "funding-crowded-short" };
  return { signal: "neutral", score: 0, reason: "" };
}
