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

function getSignalMultiplier(name, state, regimeLabel) {
  const weights = state?.dynamicWeights || {};
  const sigStats = state?.signalStats || {};

  const regimeKey = regimeLabel ? `${name}:${regimeLabel}` : null;
  if (regimeKey && sigStats[regimeKey] && sigStats[regimeKey].count >= 8) {
    const { wins, count } = sigStats[regimeKey];
    const wr = wins / count;
    if (wr >= 0.60) return 1.35;
    if (wr >= 0.50) return 1.10;
    if (wr >= 0.47) return 0.90;
    if (wr < 0.35) return 0.55;
    if (wr < 0.42) return 0.75;
  }

  if (weights[name] !== undefined) {
    return Math.max(0.2, Math.min(weights[name], 1.6));
  }

  if (sigStats[name] && sigStats[name].count >= 10) {
    const { wins, count } = sigStats[name];
    const wr = wins / count;
    if (wr >= 0.60) return 1.30;
    if (wr >= 0.50) return 1.10;
    if (wr >= 0.47) return 0.90;
    if (wr < 0.35) return 0.55;
    if (wr < 0.42) return 0.75;
  }

  return 1.0;
}

function score4H(candles4h) {
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
    const disabled = state.disabledSignals || [];

    const [candles1h, candles4h] = await Promise.all([
      fetchCandles(symbol, "1h", CANDLE_LIMIT),
      fetchCandles(symbol, "4h", 200)
    ]);

    if (!candles1h || candles1h.length < 100) return null;

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
      const isGoodRange =
        (adxResult?.adx ?? 0) < 18 &&
        bbWidth > 0.03;

      const nearSupport = supports.some(s => Math.abs(price - s) / price < 0.003);
      const nearResistance = resistances.some(r => Math.abs(price - r) / price < 0.003);

      const mrBullConfirm = [
        rsiDiv.type === "bullish",
        stochResult.crossUp && stochResult.k < 30,
        volConfirm.isSignificant && pctB < 0.10,
        fisherVal < -1.8 && fisherVal > fisherPrev
      ].filter(Boolean).length;

      const mrBearConfirm = [
        rsiDiv.type === "bearish",
        stochResult.crossDown && stochResult.k > 70,
        volConfirm.isSignificant && pctB > 0.90,
        fisherVal > 1.8 && fisherVal < fisherPrev
      ].filter(Boolean).length;

      if (isGoodRange) {
        const supportActuallyTested = nearSupport && supports.some(s =>
          lows.slice(-4).some(l => l <= s * 1.002) &&
          closes[n - 1] > s
        );
        add(rsiVal < 35 && supportActuallyTested && mrBullConfirm >= 1, "rsi-support-bounce", true, TIERS.medium);
        add(rsiVal > 68 && nearResistance && mrBearConfirm >= 1, "rsi-resistance-reject", false, TIERS.medium);

        if (!nearSupport && !nearResistance) {
          const rsiPrev2 = rsiArr[n - 3] ?? rsiVal;
          const rsiTurningDown = rsiArr[n - 1] < rsiArr[n - 2] && rsiArr[n - 2] < rsiPrev2;
          const rsiTurningUp = rsiArr[n - 1] > rsiArr[n - 2] && rsiArr[n - 2] > rsiPrev2;
          const bbRejectionBear =
            pctB > 0.90 &&
            closes[n - 1] < bb.upper[n - 1] &&
            closes[n - 2] >= bb.upper[n - 2];
          const bbRejectionBull =
            pctB < 0.10 &&
            closes[n - 1] > bb.lower[n - 1] &&
            closes[n - 2] <= bb.lower[n - 2];

          add(rsiVal < 32 && rsiTurningUp && mrBullConfirm >= 2, "rsi-oversold", true, TIERS.weak);
          add(rsiVal > 68 && rsiTurningDown && mrBearConfirm >= 2, "rsi-overbought", false, TIERS.weak);
          add(bbRejectionBull && mrBullConfirm >= 2, "bb-oversold", true, TIERS.weak);
          add(bbRejectionBear && mrBearConfirm >= 2, "bb-overbought", false, TIERS.weak);
        }
      } else {
        longScore *= 0.7;
        shortScore *= 0.7;
        reasons.push("dead-range");
      }
    } else {
      add(
        ribbon.bullishAligned && ribbon.expanding && ribbon.priceAboveAll,
        "ema-ribbon-bull",
        true,
        TIERS.weak
      );
      add(
        ribbon.bearishAligned && ribbon.expanding && ribbon.priceBelowAll,
        "ema-ribbon-bear",
        false,
        TIERS.weak
      );
      longScore *= 0.85;
      shortScore *= 0.85;
      reasons.push("transition-market");
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
    add(stochResult.crossUp && stochResult.k < 50, "stochrsi-cross-up", true, TIERS.weak);
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

    if (ribbon.bullishAligned && h4Trend === "bullish") longScore += 3;
    if (ribbon.bearishAligned && h4Trend === "bearish") shortScore += 3;

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
    const minDiff = regime.label === "chop" ? 1.5 : 1.0;
    if (scoreDiff < minDiff) return null;

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

    if (!signal) return null;

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
      return null;
    }

    const h4Score = score4H(candles4h);

    if ((setupType === "trend" || setupType === "breakout") && !h4Score.aligned(signal)) {
      return null;
    }

    reasons.push(...h4Score.signals);
    if (signal === "long") score += h4Score.bullScore * 0.5;
    if (signal === "short") score += h4Score.bearScore * 0.5;

    const quality =
      (ribbon.bullishAligned || ribbon.bearishAligned ? 1 : 0) +
      (h4Trend !== "neutral" ? 1 : 0) +
      (Math.abs(price - vwapVal) / price > 0.002 ? 1 : 0);

    const nearSupport = supports.some(s => Math.abs(price - s) / price < 0.005);
    const nearResistance = resistances.some(r => Math.abs(price - r) / price < 0.005);
    const inHVN = highVolumeNodes.some(node => price >= node.low && price <= node.high);

    if (setupType === "liquidity-trap" && reasons.includes("transition-market")) {
      return null;
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

      if (!isSidewaysRegime) return null;
      if (!hasLocationEdge || !hasExtreme) return null;
      if (hasReason(reasons, "transition-market") || h4AlignedAgainstMr) return null;
      if (!volumeDeclining || !bandwidthContracting) return null;
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

      if (!ribbon.wasCompressed || !ribbon.expanding) return null;
      if (!volConfirm.isSignificant) return null;
      if (!h4Aligned || !cloudAligned || !vwapAligned) return null;
      if (deepInHVN && !hvnEdgeEscape) return null;
    }

    if (setupType === "bull-pullback") {
      if (signal !== "long") return null;
      if (!h4Score.aligned("long")) return null;
      const hasPullbackTrigger = rsiTurningUp || stochResult.crossUp || vwapBounce;
      const hasPullbackLocation =
        Math.abs(price - vwapVal) / price < 0.005 ||
        (!ribbon.priceAboveAll && ribbon.bullishAligned);
      if (!hasPullbackTrigger || !hasPullbackLocation) return null;
    }

    if (setupType === "bull-continuation") {
      if (!h4Score.aligned("long")) return null;
      const hasEntry = rsiTurningUp || stochResult.crossUp || macdCrossUpValid;
      if (!hasEntry) return null;
    }

    if (quality < 2) return null;
    if (setupType === "unknown") return null;

    const structured = calculateStructuredSLTP(
      signal,
      price,
      atrVal,
      highs,
      lows,
      closes,
      volumes,
      { symbol, setupType, vwapVal }
    );

    return {
      symbol,
      signal,
      score: Math.round(score * 10) / 10,
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
      reasons,
      h4Trend,
      atrPct
    };
  } catch (err) {
    console.error(`[scoreSymbol:${symbol}]`, err.message || err);
    return null;
  }
}

export function autoApproveSignal(candidate) {
  const {
    signal,
    obvDiv,
    fisherVal,
    price,
    vwapVal,
    adxResult,
    h4Trend,
    setupType,
    reasons = []
  } = candidate;

  const hasReason = name => reasons.includes(name);
  let conf = 0;

  if (setupType === "liquidity-trap") {
    conf += 2;
  } else if (setupType === "bull-pullback") {
    conf += 2;
  } else if (setupType === "breakout") {
    if (
      (signal === "long" && hasReason("ribbon-expansion-bull")) ||
      (signal === "short" && hasReason("ribbon-expansion-bear"))
    ) {
      conf += 2;
    }
  } else if (setupType === "trend") {
    conf += 1;
  } else if (setupType === "mean-reversion") {
    conf += 1;
  }

  if (hasReason("transition-market")) {
    conf -= 1;
  }

  if (signal === "long") {
    if (obvDiv === "bullish" || obvDiv === "none") conf++;
    if (fisherVal > -1.0) conf++;
    if (price > vwapVal) conf++;
    if (adxResult?.trending && adxResult.pdi > adxResult.mdi) conf++;
    if (h4Trend === "bullish") conf++;
  } else {
    if (obvDiv === "bearish" || obvDiv === "none") conf++;
    if (fisherVal < 1.0) conf++;
    if (price < vwapVal) conf++;
    if (adxResult?.trending && adxResult.pdi < adxResult.mdi) conf++;
    if (h4Trend === "bearish") conf++;
  }

  return conf >= 3;
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
  const { symbol, setupType, vwapVal } = context;
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

  supportLevels.sort((a, b) => b.price - a.price);
  resistanceLevels.sort((a, b) => a.price - b.price);

  const atrSL = signal === "long" ? price - atrVal * ATR_SL_MULT : price + atrVal * ATR_SL_MULT;
  const atrTP = signal === "long" ? price + atrVal * ATR_TP_MULT : price - atrVal * ATR_TP_MULT;

  let sl, tp, slType, tpType;

  if (signal === "long") {
    const nearestSupport = supportLevels.find(s =>
      s.price < price &&
      s.price > price * 0.95 &&
      (price - s.price) > atrVal * 0.3
    );

    if (nearestSupport) {
      const structureSL = nearestSupport.price - atrVal * 0.3;
      if ((price - structureSL) <= atrVal * 3.0) {
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

    const nearestResistance = resistanceLevels.find(r =>
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
    const nearestResistance = resistanceLevels.find(r =>
      r.price > price &&
      r.price < price * 1.05 &&
      (r.price - price) > atrVal * 0.3
    );

    if (nearestResistance) {
      sl = nearestResistance.price + atrVal * 0.3;
      slType = `above-${nearestResistance.type}@${nearestResistance.price.toFixed(6)}`;
      if ((sl - price) > atrVal * 3.0) {
        sl = atrSL;
        slType = "atr-default(structure-too-far)";
      }
    } else {
      sl = atrSL;
      slType = "atr-default(no-resistance)";
    }

    const nearestSupport = supportLevels.find(s =>
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
