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
  macd,
  obv,
  rsiSeries,
  sma,
  volumeConfirmation,
  volumeProfile,
  vwap
} from "./indicators.js";
import { portfolioValue } from "./execution.js";

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
    const obvSeries = obv(closes, volumes);
    const obvDiv = detectOBVDivergence(closes, obvSeries, 20);
    const fisherArr = fisher(highs, lows, 10);
    const fisherVal = fisherArr[n - 1];
    const vwapVal = vwap(highs, lows, closes, volumes, 24);
    const vpvr = volumeProfile(closes, volumes, 20);
    const srLevels = findSupportResistance(highs, lows, 50) || { supports: [], resistances: [] };
    const supports = Array.isArray(srLevels.supports) ? srLevels.supports : [];
    const resistances = Array.isArray(srLevels.resistances) ? srLevels.resistances : [];
    const trap = detectLiquidityTrap(price, closes, { supports, resistances });
    const rsiArr = rsiSeries(closes, 14);
    const rsiVal = rsiArr[n - 1];
    const rsiDiv = detectRSIDivergence(closes, rsiArr, 20);

    const macdRaw = macd(closes) || {};
    const macdResult = {
      crossUp: !!macdRaw.crossUp,
      crossDown: !!macdRaw.crossDown
    };
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
    if (candles4h && candles4h.length >= 50) {
      const c4 = candles4h.map(c => c.close);
      const e20 = ema(c4, 20);
      const e50 = ema(c4, 50);
      const last = c4.length - 1;

      if (e20[last] > e50[last] && c4[last] > e20[last]) h4Trend = "bullish";
      else if (e20[last] < e50[last] && c4[last] < e20[last]) h4Trend = "bearish";
    }

    let longScore = 0;
    let shortScore = 0;
    const reasons = [];

    const TIERS = {
      weak: 0.5,
      medium: 1,
      strong: 2
    };

    const add = (cond, name, isLong, weight = TIERS.medium) => {
      if (!cond || disabled.includes(name)) return;
      if (isLong) longScore += weight;
      else shortScore += weight;
      reasons.push(name);
    };

    if (isStrongTrend) {
      add(ribbon.bullishAligned && ribbon.expanding && ribbon.priceAboveAll, "ema-ribbon-bull", true, TIERS.strong);
      add(ribbon.bearishAligned && ribbon.expanding && ribbon.priceBelowAll, "ema-ribbon-bear", false, TIERS.strong);
      add(h4Trend === "bullish", "h4-bull", true, TIERS.strong);
      add(h4Trend === "bearish", "h4-bear", false, TIERS.strong);
    } else if (!isTrending) {
      const isGoodRange =
        (adxResult?.adx ?? 0) < 20 &&
        bbWidth > 0.02;

      const nearSupport = supports.some(s => Math.abs(price - s) / price < 0.005);
      const nearResistance = resistances.some(r => Math.abs(price - r) / price < 0.005);

      if (isGoodRange) {
        add(rsiVal < 35 && nearSupport, "rsi-support-bounce", true, TIERS.medium);
        add(rsiVal > 65 && nearResistance, "rsi-resistance-reject", false, TIERS.medium);

        if (!nearSupport && !nearResistance) {
          add(rsiVal < 35, "rsi-oversold", true, TIERS.weak);
          add(rsiVal > 65, "rsi-overbought", false, TIERS.weak);
          add(pctB < 0.05, "bb-oversold", true, TIERS.weak);
          add(pctB > 0.95, "bb-overbought", false, TIERS.weak);
        }
      } else {
        longScore *= 0.7;
        shortScore *= 0.7;
        reasons.push("dead-range");
      }
    } else {
      add(ribbon.bullishAligned, "ema-ribbon-bull", true, TIERS.weak);
      add(ribbon.bearishAligned, "ema-ribbon-bear", false, TIERS.weak);
      longScore *= 0.85;
      shortScore *= 0.85;
      reasons.push("transition-market");
    }

    add(rsiDiv.type === "bullish", "rsi-bull-div", true, TIERS.strong);
    add(rsiDiv.type === "bearish", "rsi-bear-div", false, TIERS.strong);
    add(obvDiv.type === "bullish", "OBV-bull-div", true, TIERS.strong);
    add(obvDiv.type === "bearish", "OBV-bear-div", false, TIERS.strong);
    add(trap === "bear-trap", "liquidity-bull", true, TIERS.strong);
    add(trap === "bull-trap", "liquidity-bear", false, TIERS.strong);
    add(trap === "bear-trap" && rsiVal < 40, "trap-bull-confirm", true, TIERS.strong);
    add(trap === "bull-trap" && rsiVal > 60, "trap-bear-confirm", false, TIERS.strong);
    add(trap === "bear-trap" && volConfirm.isClimax, "trap-vol-bull", true, TIERS.strong);
    add(trap === "bull-trap" && volConfirm.isClimax, "trap-vol-bear", false, TIERS.strong);
    add(macdResult.crossUp, "macd-cross-up", true, TIERS.medium);
    add(macdResult.crossDown, "macd-cross-down", false, TIERS.medium);
    add(price > vwapVal, "above-VWAP", true, TIERS.medium);
    add(price < vwapVal, "below-VWAP", false, TIERS.medium);
    add(
      ribbon.wasCompressed && ribbon.expanding && ribbon.bullishAligned,
      "ribbon-expansion-bull",
      true,
      TIERS.strong
    );
    add(
      ribbon.wasCompressed && ribbon.expanding && ribbon.bearishAligned,
      "ribbon-expansion-bear",
      false,
      TIERS.strong
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
    if (h4Trend === "bullish" && price < vwapVal) {
      longScore *= 0.7;
      reasons.push("htf-vs-vwap");
    }
    if (h4Trend === "bearish" && price > vwapVal) {
      shortScore *= 0.7;
      reasons.push("htf-vs-vwap");
    }

    const scoreDiff = Math.abs(longScore - shortScore);
    const minDiff = regime.label === "chop" ? 1.5 : 1.0;
    if (scoreDiff < minDiff) return null;

    const minScore = regime.label === "chop" ? 4 : 3;
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

    let setupType = "unknown";
    if (trap !== "none") {
      setupType = "liquidity-trap";
    } else if (ribbon.wasCompressed && ribbon.expanding) {
      setupType = "breakout";
    } else if (!isTrending) {
      setupType = "mean-reversion";
    } else if (isStrongTrend) {
      setupType = "trend";
    }

    const quality =
      (ribbon.bullishAligned || ribbon.bearishAligned ? 1 : 0) +
      (h4Trend !== "neutral" ? 1 : 0) +
      (Math.abs(price - vwapVal) / price > 0.002 ? 1 : 0);

    if (quality < 2) return null;

    const structured = calculateStructuredSLTP(
      signal, price, atrVal, highs, lows, closes, volumes
    );

    return {
      symbol,
      signal,
      score: Math.round(score * 10) / 10,
      setupType,
      price,
      atrVal,
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

export function calculateStructuredSLTP(signal, price, atrVal, highs, lows, closes, volumes) {
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

  const risk = Math.abs(price - sl);
  const reward = Math.abs(tp - price);

  if ((risk > 0 ? reward / risk : 0) < 1.5) {
    sl = atrSL;
    tp = atrTP;
    slType = "atr-fallback(rr-too-low)";
    tpType = "atr-fallback(rr-too-low)";
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
