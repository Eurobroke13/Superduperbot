// =============================================================================
// SIDEWAYS TRADING SYSTEM
//
// A complete regime-specific strategy that replaces the old "block everything
// and hope" approach. Four trade types, each exploiting a different pattern
// that only exists in ranges:
//
//   1. RANGE FADE     — fade extreme touches at S/R + BB edges with oscillator conf
//   2. MEAN-REVERSION — deeper extension below/above range with vol exhaustion
//   3. SQUEEZE PLAY   — BB width compression → breakout anticipation
//   4. RANGE TRAP     — failed breakout recaptured back into range (tuned LT)
//
// Architecture:
//   - detectRange()           → identifies current range boundaries dynamically
//   - scoreSidewaysCandidate() → main entry point, tries each trade type in order
//   - Each trade type has its own SL/TP/sizing/exit parameters
//   - Wire into scoreSymbol() when regime === "sideways"
//
// Position management:
//   - 70% base size (reduced from trend trades)
//   - Further sized by zone confidence (edge = full, mid-range = reduced)
//   - Time-limited: 12h max for MR/fade, 24h for squeeze plays
//   - Aggressive trailing once target zone reached
// =============================================================================

import {
  sma, ema, bollingerBands, rsiSeries, atr,
  stochRSI, fisherTransform, volumeConfirmation,
  adx as computeADX, findSupportResistance, volumeProfile,
  detectRSIDivergence, obv as computeOBV
} from "./indicators.js";


// =============================================================================
// 1. DYNAMIC RANGE DETECTION
//
// Identifies the current range using multiple inputs:
//   - Recent swing highs/lows (structural range)
//   - Bollinger Bands (statistical range)
//   - High Volume Nodes from VPVR (liquidity range)
//   - Combines into a consensus range with confidence
// =============================================================================

/**
 * Detect the current trading range.
 * Returns { top, bottom, mid, width, widthPct, confidence, sources }
 *
 * @param {number[]} closes
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} volumes
 * @param {number}   atrVal — current ATR
 * @returns {object}
 */
export function detectRange(closes, highs, lows, volumes, atrVal) {
  const n = closes.length;
  const price = closes[n - 1];
  const lookback = Math.min(40, n - 2);  // ~2 weeks of hourly data on daily

  // Source 1: Recent swing high/low
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  const swingTop = Math.max(...recentHighs);
  const swingBottom = Math.min(...recentLows);

  // Source 2: Bollinger Bands
  const bb = bollingerBands(closes, 20, 2);
  const bbTop = bb.upper[n - 1];
  const bbBottom = bb.lower[n - 1];
  const bbMid = bb.middle[n - 1];

  // Source 3: S/R levels
  const sr = findSupportResistance(highs, lows, Math.min(80, n));
  const nearestResistance = sr.resistances.filter(r => r > price && r < price * 1.05);
  const nearestSupport = sr.supports.filter(s => s < price && s > price * 0.95);

  // Source 4: VPVR high-volume nodes (if enough data)
  let hvnTop = null, hvnBottom = null;
  if (volumes && volumes.length >= 30) {
    const vpvr = volumeProfile(closes, volumes, 30);
    if (vpvr.highVolumeNodes.length > 0) {
      hvnTop = Math.max(...vpvr.highVolumeNodes.map(n => n.high));
      hvnBottom = Math.min(...vpvr.highVolumeNodes.map(n => n.low));
    }
  }

  // Consensus: average the sources that exist
  const topCandidates = [swingTop, bbTop];
  const bottomCandidates = [swingBottom, bbBottom];
  if (nearestResistance.length > 0) topCandidates.push(nearestResistance[0]);
  if (nearestSupport.length > 0) bottomCandidates.push(nearestSupport[nearestSupport.length - 1]);
  if (hvnTop) topCandidates.push(hvnTop);
  if (hvnBottom) bottomCandidates.push(hvnBottom);

  const top = topCandidates.reduce((a, b) => a + b, 0) / topCandidates.length;
  const bottom = bottomCandidates.reduce((a, b) => a + b, 0) / bottomCandidates.length;
  const mid = (top + bottom) / 2;
  const width = top - bottom;
  const widthPct = bottom > 0 ? width / bottom : 0;

  // Where is price within the range? 0 = bottom, 1 = top
  const position = width > 0 ? (price - bottom) / width : 0.5;

  // Zone classification
  let zone;
  if (position < 0.15)      zone = "lower-extreme";
  else if (position < 0.30) zone = "lower-edge";
  else if (position > 0.85) zone = "upper-extreme";
  else if (position > 0.70) zone = "upper-edge";
  else                       zone = "mid-range";

  // Confidence: higher when sources agree, lower when they diverge
  const topSpread = topCandidates.length > 1
    ? (Math.max(...topCandidates) - Math.min(...topCandidates)) / atrVal
    : 0;
  const bottomSpread = bottomCandidates.length > 1
    ? (Math.max(...bottomCandidates) - Math.min(...bottomCandidates)) / atrVal
    : 0;
  const confidence = Math.max(0, 1 - (topSpread + bottomSpread) / 4);

  return {
    top, bottom, mid, width, widthPct,
    position, zone, confidence,
    bbTop, bbBottom, bbMid,
    sources: { swing: { top: swingTop, bottom: swingBottom }, bb: { top: bbTop, bottom: bbBottom } }
  };
}


// =============================================================================
// 2. MAIN SCORER — tries each trade type
// =============================================================================

/**
 * Score a symbol for sideways-specific trade types.
 * Call this from scoreSymbol() when regime.label === "sideways".
 *
 * Returns the highest-scoring candidate across all 4 trade types,
 * or null if nothing qualifies.
 *
 * @param {object} params — all indicator data from scoreSymbol
 * @returns {object|null} — { signal, score, setupType, reasons, sl, tp, ... }
 */
export function scoreSidewaysCandidate({
  symbol, price, closes, highs, lows, volumes,
  rsiVal, rsiArr, stochResult, fisherVal, fisherPrev,
  pctB, bbUpper, bbLower, bbMiddle, bbWidth,
  vwapVal, currentEMA20,
  supports, resistances,
  adxResult, atrVal,
  obvDiv, volConfirm, rsiDiv,
  h4Trend, ribbon,
  state, regime
}) {
  // Only in sideways regime
  if (regime?.label !== "sideways") return null;

  // Detect the range
  const range = detectRange(closes, highs, lows, volumes, atrVal);

  // Try each trade type; collect all that qualify
  const candidates = [];

  const fade = tryRangeFade({ price, range, rsiVal, stochResult, fisherVal, fisherPrev, pctB, atrVal, supports, resistances, volConfirm, obvDiv, adxResult, vwapVal, currentEMA20 });
  if (fade) candidates.push(fade);

  const mr = tryMeanReversion({ price, range, rsiVal, rsiArr, stochResult, fisherVal, fisherPrev, pctB, bbUpper, bbLower, bbMiddle, atrVal, supports, resistances, volConfirm, obvDiv, rsiDiv, volumes, vwapVal, currentEMA20, closes });
  if (mr) candidates.push(mr);

  const squeeze = trySqueezPlay({ price, range, bbWidth, closes, highs, lows, atrVal, adxResult, volConfirm, h4Trend, ribbon, pctB });
  if (squeeze) candidates.push(squeeze);

  const trap = tryRangeTrap({ price, range, closes, highs, lows, atrVal, supports, resistances, volConfirm, rsiVal, stochResult, h4Trend, adxResult });
  if (trap) candidates.push(trap);

  if (candidates.length === 0) return null;

  // Return highest-scoring candidate
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Tag for downstream identification
  best.symbol = symbol;
  best.regime = "sideways";
  best.rangeInfo = {
    zone: range.zone,
    position: parseFloat(range.position.toFixed(2)),
    confidence: parseFloat(range.confidence.toFixed(2)),
    widthPct: parseFloat(range.widthPct.toFixed(4))
  };

  return best;
}


// =============================================================================
// TRADE TYPE 1: RANGE FADE
//
// Simplest sideways trade: price touches range edge with oscillator
// confirmation → fade back to mid-range. Tight SL just outside the range.
//
// Win condition: price returns to EMA20/VWAP/BB middle
// Fail condition: range breaks (SL hit beyond edge)
// =============================================================================

function tryRangeFade({ price, range, rsiVal, stochResult, fisherVal, fisherPrev, pctB, atrVal, supports, resistances, volConfirm, obvDiv, adxResult, vwapVal, currentEMA20 }) {
  // Must be at an edge
  if (range.zone !== "lower-edge" && range.zone !== "lower-extreme" &&
      range.zone !== "upper-edge" && range.zone !== "upper-extreme") return null;

  // ADX must be low — if trending, don't fade
  if (adxResult?.adx > 22) return null;

  const isLong = range.zone.startsWith("lower");
  let score = 0;
  const reasons = [];

  if (isLong) {
    if (rsiVal < 30)  { score += 2.0; reasons.push("sw-fade-rsi<30"); }
    else if (rsiVal < 38) { score += 1.0; reasons.push("sw-fade-rsi<38"); }

    if (stochResult?.oversold) { score += 1.0; reasons.push("sw-fade-stoch-os"); }
    if (stochResult?.crossUp)  { score += 1.0; reasons.push("sw-fade-stoch-xup"); }

    if (fisherVal < -1.2 && fisherVal > fisherPrev) { score += 1.0; reasons.push("sw-fade-fisher-rev"); }

    const nearSupport = supports?.some(s => Math.abs(price - s) / price < 0.004);
    if (nearSupport) { score += 1.5; reasons.push("sw-fade-at-support"); }

    if (obvDiv === "bullish") { score += 1.0; reasons.push("sw-fade-obv-bull"); }
  } else {
    if (rsiVal > 70)  { score += 2.0; reasons.push("sw-fade-rsi>70"); }
    else if (rsiVal > 62) { score += 1.0; reasons.push("sw-fade-rsi>62"); }

    if (stochResult?.overbought) { score += 1.0; reasons.push("sw-fade-stoch-ob"); }
    if (stochResult?.crossDown)  { score += 1.0; reasons.push("sw-fade-stoch-xdn"); }

    if (fisherVal > 1.2 && fisherVal < fisherPrev) { score += 1.0; reasons.push("sw-fade-fisher-rev"); }

    const nearResistance = resistances?.some(r => Math.abs(price - r) / price < 0.004);
    if (nearResistance) { score += 1.5; reasons.push("sw-fade-at-resistance"); }

    if (obvDiv === "bearish") { score += 1.0; reasons.push("sw-fade-obv-bear"); }
  }

  // Extreme zones get a bonus (deeper into range edge = stronger reversion)
  if (range.zone === "lower-extreme" || range.zone === "upper-extreme") {
    score += 0.5; reasons.push("sw-fade-extreme-zone");
  }

  // Range confidence bonus
  score += range.confidence * 0.5;

  if (score < 4.0) return null;

  const signal = isLong ? "long" : "short";
  const sl = isLong ? range.bottom - atrVal * 0.5 : range.top + atrVal * 0.5;
  const target = currentEMA20 && Math.abs(currentEMA20 - price) > atrVal * 0.3
    ? currentEMA20
    : range.mid;
  const tp = isLong
    ? Math.min(target, range.mid) - atrVal * 0.1
    : Math.max(target, range.mid) + atrVal * 0.1;

  return {
    signal, score, setupType: "range-fade", reasons, price, sl, tp, atrVal,
    riskReward: Math.abs(tp - price) / Math.abs(price - sl),
    positionSizeMultiplier: 0.70,
    maxHoldHours: 12
  };
}


// =============================================================================
// TRADE TYPE 2: MEAN-REVERSION
//
// Deeper extension beyond BB with volume exhaustion and divergence.
// More conviction than fade — price has overshot and is snapping back.
// Slightly larger size allowed.
// =============================================================================

function tryMeanReversion({ price, range, rsiVal, rsiArr, stochResult, fisherVal, fisherPrev, pctB, bbUpper, bbLower, bbMiddle, atrVal, supports, resistances, volConfirm, obvDiv, rsiDiv, volumes, vwapVal, currentEMA20, closes }) {
  // Need to be outside or at BB edge
  if (pctB > 0.12 && pctB < 0.88) return null;

  const isLong = pctB < 0.12;
  let score = 0;
  const reasons = [];

  if (isLong) {
    if (rsiVal < 25)  { score += 2.5; reasons.push("sw-mr-rsi-extreme"); }
    else if (rsiVal < 32) { score += 1.5; reasons.push("sw-mr-rsi-low"); }

    if (stochResult?.oversold && stochResult?.crossUp) { score += 1.5; reasons.push("sw-mr-stoch-cross-os"); }
    else if (stochResult?.oversold) { score += 0.5; reasons.push("sw-mr-stoch-os"); }

    if (rsiDiv?.type === "bullish") { score += 2.0; reasons.push("sw-mr-rsi-div-bull"); }
    if (obvDiv === "bullish")       { score += 1.5; reasons.push("sw-mr-obv-div-bull"); }
    if (fisherVal < -2.0 && fisherVal > fisherPrev) { score += 1.0; reasons.push("sw-mr-fisher-snap"); }

    // Volume exhaustion on the drop
    if (volumes && volumes.length >= 10) {
      const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const priorVol = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
      if (priorVol > 0 && recentVol < priorVol * 0.65) {
        score += 1.5; reasons.push("sw-mr-vol-exhaustion");
      }
    }

    if (pctB < 0.0) { score += 0.5; reasons.push("sw-mr-below-bb"); }

    const nearSupport = supports?.some(s => Math.abs(price - s) / price < 0.005);
    if (nearSupport) { score += 1.0; reasons.push("sw-mr-at-support"); }
  } else {
    if (rsiVal > 75)  { score += 2.5; reasons.push("sw-mr-rsi-extreme"); }
    else if (rsiVal > 68) { score += 1.5; reasons.push("sw-mr-rsi-high"); }

    if (stochResult?.overbought && stochResult?.crossDown) { score += 1.5; reasons.push("sw-mr-stoch-cross-ob"); }
    else if (stochResult?.overbought) { score += 0.5; reasons.push("sw-mr-stoch-ob"); }

    if (rsiDiv?.type === "bearish") { score += 2.0; reasons.push("sw-mr-rsi-div-bear"); }
    if (obvDiv === "bearish")       { score += 1.5; reasons.push("sw-mr-obv-div-bear"); }
    if (fisherVal > 2.0 && fisherVal < fisherPrev) { score += 1.0; reasons.push("sw-mr-fisher-snap"); }

    if (volumes && volumes.length >= 10) {
      const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const priorVol = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
      if (priorVol > 0 && recentVol < priorVol * 0.65) {
        score += 1.5; reasons.push("sw-mr-vol-exhaustion");
      }
    }

    if (pctB > 1.0) { score += 0.5; reasons.push("sw-mr-above-bb"); }

    const nearResistance = resistances?.some(r => Math.abs(price - r) / price < 0.005);
    if (nearResistance) { score += 1.0; reasons.push("sw-mr-at-resistance"); }
  }

  score += range.confidence * 0.5;

  if (score < 4.5) return null;

  const signal = isLong ? "long" : "short";
  const sl = isLong ? price - atrVal * 1.2 : price + atrVal * 1.2;
  const meanTarget = isLong
    ? Math.min(currentEMA20 || bbMiddle, vwapVal || bbMiddle)
    : Math.max(currentEMA20 || bbMiddle, vwapVal || bbMiddle);
  const tp = isLong
    ? (meanTarget > price ? meanTarget - atrVal * 0.1 : price + atrVal * 1.5)
    : (meanTarget < price ? meanTarget + atrVal * 0.1 : price - atrVal * 1.5);

  return {
    signal, score, setupType: "mean-reversion", reasons, price, sl, tp, atrVal,
    riskReward: Math.abs(tp - price) / Math.abs(price - sl),
    positionSizeMultiplier: 0.75,  // slightly larger than fade — higher conviction
    maxHoldHours: 12
  };
}


// =============================================================================
// TRADE TYPE 3: SQUEEZE PLAY
//
// When BB width compresses to extreme levels within a sideways regime,
// a breakout is imminent. This doesn't predict direction — it uses
// momentum and structure to pick the likely breakout side.
//
// Key insight: the squeeze itself is the setup. Once BB width is at
// its 50-bar minimum and starts expanding, enter in the expansion direction.
// =============================================================================

function trySqueezPlay({ price, range, bbWidth, closes, highs, lows, atrVal, adxResult, volConfirm, h4Trend, ribbon, pctB }) {
  const n = closes.length;
  if (n < 50) return null;

  // Compute BB width history to find if current is compressed
  const bbWidths = [];
  for (let i = 19; i < n; i++) {
    const slice = closes.slice(i - 19, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / 20;
    const std = Math.sqrt(slice.reduce((s, x) => s + (x - mean) ** 2, 0) / 20);
    bbWidths.push(mean > 0 ? (4 * std) / mean : 0);
  }

  const currentBBW = bbWidths[bbWidths.length - 1];
  const prevBBW = bbWidths[bbWidths.length - 2];
  const recentBBW = bbWidths.slice(-50);
  const sortedBBW = [...recentBBW].sort((a, b) => a - b);
  const bbwPercentile = sortedBBW.findIndex(w => w >= currentBBW) / sortedBBW.length;

  // Need squeeze: current BBW in bottom 20% of recent, AND starting to expand
  const isSqueezed = bbwPercentile < 0.20;
  const isExpanding = currentBBW > prevBBW * 1.05;  // 5% expansion

  if (!isSqueezed && !isExpanding) return null;
  // If squeezed but not yet expanding, don't enter yet — wait for the expansion candle
  if (isSqueezed && !isExpanding) return null;

  let score = 0;
  const reasons = [];

  // The squeeze is the base score
  if (bbwPercentile < 0.10) { score += 2.5; reasons.push("sw-squeeze-extreme(<10%)"); }
  else { score += 1.5; reasons.push("sw-squeeze(<20%)"); }

  if (isExpanding) { score += 1.5; reasons.push("sw-squeeze-expanding"); }

  // Direction: use multiple signals
  let bullVotes = 0, bearVotes = 0;

  // Current candle direction (expansion candle)
  if (closes[n - 1] > closes[n - 2]) bullVotes++;
  else bearVotes++;

  // Where is price relative to BB middle?
  if (pctB > 0.5) bullVotes++;
  else bearVotes++;

  // H4 trend alignment
  if (h4Trend === "bullish") bullVotes++;
  else if (h4Trend === "bearish") bearVotes++;

  // EMA ribbon direction
  if (ribbon?.bullishAligned) bullVotes++;
  else if (ribbon?.bearishAligned) bearVotes++;

  // ADX: if +DI > -DI, lean bullish
  if (adxResult?.pdi > adxResult?.mdi) bullVotes++;
  else if (adxResult?.mdi > adxResult?.pdi) bearVotes++;

  // Volume on expansion candle
  if (volConfirm?.isSignificant) { score += 1.0; reasons.push("sw-squeeze-vol-spike"); }

  const signal = bullVotes > bearVotes ? "long" : "short";
  const directionConf = Math.abs(bullVotes - bearVotes);

  // Need at least 2-vote margin for direction confidence
  if (directionConf < 2) {
    score -= 1.0;
    reasons.push("sw-squeeze-weak-direction");
  } else {
    score += 0.5;
    reasons.push(`sw-squeeze-${signal}(${bullVotes}v${bearVotes})`);
  }

  score += range.confidence * 0.3;

  if (score < 4.5) return null;

  // SL/TP: wider than fade/MR — breakouts need room
  const sl = signal === "long"
    ? price - atrVal * 1.8
    : price + atrVal * 1.8;
  const tp = signal === "long"
    ? price + atrVal * 3.5
    : price - atrVal * 3.5;

  return {
    signal, score, setupType: "squeeze-breakout", reasons, price, sl, tp, atrVal,
    riskReward: Math.abs(tp - price) / Math.abs(price - sl),
    positionSizeMultiplier: 0.65,  // smaller — breakout direction is uncertain
    maxHoldHours: 24               // longer leash — breakouts take time
  };
}


// =============================================================================
// TRADE TYPE 4: RANGE TRAP
//
// Price breaks out of the range, then recaptures back inside.
// This is the existing liquidity-trap concept, tuned for range context.
//
// Key difference from general LT: we know the range boundaries precisely,
// so the "trap" is more defined — broke above range.top, came back below.
// =============================================================================

function tryRangeTrap({ price, range, closes, highs, lows, atrVal, supports, resistances, volConfirm, rsiVal, stochResult, h4Trend, adxResult }) {
  const n = closes.length;
  if (n < 10) return null;

  const recentHighs = highs.slice(-5);
  const recentLows = lows.slice(-5);

  // Bull trap: broke above range top → came back below
  const brokeAbove = recentHighs.some(h => h > range.top * 1.002);
  const backBelow = price < range.top;

  // Bear trap: broke below range bottom → came back above
  const brokeBelow = recentLows.some(l => l < range.bottom * 0.998);
  const backAbove = price > range.bottom;

  let signal = null;
  let score = 0;
  const reasons = [];

  if (brokeAbove && backBelow) {
    // Failed breakout upward → short (bull trap)
    signal = "short";
    score += 2.5; reasons.push("sw-trap-bull-failed");

    if (rsiVal > 60) { score += 1.0; reasons.push("sw-trap-rsi-high"); }
    if (stochResult?.overbought) { score += 0.5; reasons.push("sw-trap-stoch-ob"); }
    if (volConfirm?.isSignificant) { score += 1.0; reasons.push("sw-trap-vol-rejection"); }
    if (h4Trend === "bearish") { score += 1.0; reasons.push("sw-trap-h4-bear"); }
    if (adxResult?.mdi > adxResult?.pdi) { score += 0.5; reasons.push("sw-trap-adx-bear"); }

  } else if (brokeBelow && backAbove) {
    // Failed breakout downward → long (bear trap)
    signal = "long";
    score += 2.5; reasons.push("sw-trap-bear-failed");

    if (rsiVal < 40) { score += 1.0; reasons.push("sw-trap-rsi-low"); }
    if (stochResult?.oversold) { score += 0.5; reasons.push("sw-trap-stoch-os"); }
    if (volConfirm?.isSignificant) { score += 1.0; reasons.push("sw-trap-vol-rejection"); }
    if (h4Trend === "bullish") { score += 1.0; reasons.push("sw-trap-h4-bull"); }
    if (adxResult?.pdi > adxResult?.mdi) { score += 0.5; reasons.push("sw-trap-adx-bull"); }

  } else {
    return null;
  }

  score += range.confidence * 0.5;

  if (score < 4.5) return null;

  // SL: just beyond the breakout point. TP: opposite range edge.
  const sl = signal === "long"
    ? range.bottom - atrVal * 0.8
    : range.top + atrVal * 0.8;
  const tp = signal === "long"
    ? range.mid + (range.width * 0.3)   // not full opposite edge — take profit in upper-mid
    : range.mid - (range.width * 0.3);

  return {
    signal, score, setupType: "range-trap", reasons, price, sl, tp, atrVal,
    riskReward: Math.abs(tp - price) / Math.abs(price - sl),
    positionSizeMultiplier: 0.70,
    maxHoldHours: 16
  };
}


// =============================================================================
// SIDEWAYS EXIT MANAGEMENT
//
// All sideways trade types share these exit rules.
// Wire into checkGraduatedExit():
//   if (["range-fade","mean-reversion","squeeze-breakout","range-trap"].includes(pos.setupType)) {
//     return checkSidewaysExit(pos, price, currentAtr, hoursOpen);
//   }
// =============================================================================

/**
 * Exit logic for all sideways trade types.
 *
 * @param {object} pos        - position
 * @param {number} price      - current price
 * @param {number} currentAtr - current ATR
 * @param {number} hoursOpen  - hours since entry
 * @returns {{ exit: boolean, reason: string }}
 */
export function checkSidewaysExit(pos, price, currentAtr, hoursOpen) {
  const { direction, entryPrice, atrVal, setupType } = pos;
  const entryAtr = atrVal || currentAtr;

  const profitATRs = direction === "long"
    ? (price - entryPrice) / entryAtr
    : (entryPrice - price) / entryAtr;

  const maxHold = pos.maxHoldHours || 12;

  // Rule 1: Time-expire if barely profitable
  if (hoursOpen >= maxHold && profitATRs < 0.5) {
    return { exit: true, reason: `sw-time-expired-${maxHold}h` };
  }

  // Rule 2: Kill underwater positions earlier (8h)
  if (hoursOpen >= 8 && profitATRs < -0.2) {
    return { exit: true, reason: "sw-underwater-8h" };
  }

  // Rule 3: Quick profit trail at 0.8 ATR
  if (profitATRs >= 0.8) {
    const trail = direction === "long"
      ? entryPrice + entryAtr * 0.15
      : entryPrice - entryAtr * 0.15;
    if (direction === "long" ? trail > pos.sl : trail < pos.sl) {
      pos.sl = trail;
    }
  }

  // Rule 4: Aggressive trail at 1.2+ ATR
  if (profitATRs >= 1.2) {
    const trail = direction === "long"
      ? price - entryAtr * 0.35
      : price + entryAtr * 0.35;
    if (direction === "long" ? trail > pos.sl : trail < pos.sl) {
      pos.sl = trail;
    }
  }

  // Rule 5: Squeeze plays get longer leash but tighter trail once profitable
  if (setupType === "squeeze-breakout" && profitATRs >= 1.5) {
    const trail = direction === "long"
      ? price - entryAtr * 0.5
      : price + entryAtr * 0.5;
    if (direction === "long" ? trail > pos.sl : trail < pos.sl) {
      pos.sl = trail;
    }
  }

  return { exit: false };
}


// =============================================================================
// UPDATED SIDEWAYS FILTER
//
// Replaces the old "block everything" filter. Now:
//   - Blocks only trend setups with score < 5.5 (strong trends can still pass)
//   - Minimum score is 4.0 (down from 5.0 — the sideways scorer handles quality)
//   - Mean-reversion, range-fade, range-trap, squeeze are all exempt
// =============================================================================

const SIDEWAYS_SETUP_EXEMPT = new Set([
  "mean-reversion", "range-fade", "range-trap", "squeeze-breakout"
]);

/**
 * Updated sideways filter — less restrictive now that we have proper
 * sideways-specific trade types generating quality candidates.
 *
 * @param {object} candidate
 * @param {string} regimeLabel
 * @param {object} regimeStats
 * @returns {{ allowed: boolean, reason: string }}
 */
export function sidewaysFilter(candidate, regimeLabel, regimeStats) {
  if (regimeLabel !== "sideways") {
    return { allowed: true, reason: "not-sideways" };
  }

  // Sideways-specific setups bypass all filters
  if (SIDEWAYS_SETUP_EXEMPT.has(candidate.setupType)) {
    return { allowed: true, reason: `${candidate.setupType}-exempt` };
  }

  // Block weak trend setups — strong ones (>= 5.5) can still pass
  if (candidate.setupType === "trend" && candidate.score < 5.5) {
    return { allowed: false, reason: `trend-in-sideways-weak(${candidate.score}<5.5)` };
  }

  // Lower floor for other setups (LT, breakout, etc.)
  const sidewaysMinScore = 4.0;
  if (candidate.score < sidewaysMinScore) {
    return { allowed: false, reason: `sideways-score-low(${candidate.score}<${sidewaysMinScore})` };
  }

  return { allowed: true, reason: "sideways-passed" };
}


// =============================================================================
// INTEGRATION
// =============================================================================
//
// In bot/scoring.js scoreSymbol(), add after setupType assignment:
//
//   import { scoreSidewaysCandidate } from "./sideways-system.js";
//
//   // Try sideways-specific scoring when in sideways regime
//   if (regime?.label === "sideways") {
//     const swCandidate = scoreSidewaysCandidate({
//       symbol, price, closes, highs, lows, volumes,
//       rsiVal, rsiArr, stochResult, fisherVal, fisherPrev,
//       pctB, bbUpper, bbLower, bbMiddle, bbWidth,
//       vwapVal, currentEMA20,
//       supports: sr.supports, resistances: sr.resistances,
//       adxResult, atrVal,
//       obvDiv, volConfirm, rsiDiv,
//       h4Trend, ribbon,
//       state, regime
//     });
//
//     // If sideways scorer found something, compare with normal score
//     if (swCandidate && (!normalCandidate || swCandidate.score > normalCandidate.score)) {
//       return swCandidate;
//     }
//   }
//
//
// In bot/exits.js or runner.js, add:
//
//   import { checkSidewaysExit } from "./sideways-system.js";
//
//   // In the exit loop:
//   const swSetups = ["range-fade","mean-reversion","squeeze-breakout","range-trap"];
//   if (swSetups.includes(pos.setupType)) {
//     const swExit = checkSidewaysExit(pos, price, currentAtr, hoursOpen);
//     if (swExit.exit) {
//       closePosition(symbol, price, swExit.reason, state, deps);
//       continue;
//     }
//   }
//
//
// Replace the old sidewaysFilter import:
//   import { sidewaysFilter } from "./sideways-system.js";
//   // (remove the old one from entry-improvements.js)
// =============================================================================


// =============================================================================
// SIDEWAYS ENTRY INFRASTRUCTURE
//
// Adapts the existing openPositionGradual / tranche / TP system for sideways.
// Instead of trend parameters (T2 at +0.5 ATR, T3 at +1.5 ATR, TP1 at 2.0 ATR),
// sideways uses tighter values tuned for range-sized moves.
//
// Call getSidewaysPositionParams() to get the overrides, then pass them
// into openPositionGradual().
// =============================================================================

/**
 * Per-setup-type entry and exit parameters for sideways trades.
 * Returns overrides that plug into openPositionGradual().
 *
 * These are TIGHTER than trend params because range moves are smaller:
 *   - Tranches fill sooner (T2 at 0.3 ATR, T3 at 0.8 ATR)
 *   - TP levels are closer (TP1 at 1.0-1.5 ATR, TP2 at 2.0-2.5 ATR)
 *   - Trail is tighter (remaining 40% trails at 0.4 ATR behind price)
 *
 * @param {object} candidate — scored sideways candidate
 * @returns {object} — { trancheConfig, tpConfig, splitConfig }
 */
export function getSidewaysPositionParams(candidate) {
  const { setupType, signal, price, atrVal, sl, tp } = candidate;

  const configs = {

    "range-fade": {
      // Fade = quick mean-reversion from range edge
      // Fill fast, take profit fast, tight trail
      trancheConfig: {
        tranche1Pct: 0.50,   // bigger initial (higher confidence at edge)
        tranche2Pct: 0.30,
        tranche3Pct: 0.20,
        tranche2TriggerATR: 0.2,  // fills after 0.2 ATR (was 0.5)
        tranche3TriggerATR: 0.6   // fills after 0.6 ATR (was 1.5)
      },
      tpConfig: {
        tp1: { atrMult: 1.0, pct: 0.35 },   // take 35% at 1.0 ATR (was 2.0)
        tp2: { atrMult: 1.8, pct: 0.35 },   // take 35% at 1.8 ATR (was 3.5)
        tp3: { pct: 0.30, trail: true }       // trail remaining 30%
      },
      splitConfig: {
        immediatePct: 0.70,   // mostly market — edge is NOW
        limitPct: 0.30,
        limitOffsetATR: 0.15  // tiny pullback limit
      }
    },

    "mean-reversion": {
      // Deeper extension — slightly more patient
      trancheConfig: {
        tranche1Pct: 0.45,
        tranche2Pct: 0.30,
        tranche3Pct: 0.25,
        tranche2TriggerATR: 0.25,
        tranche3TriggerATR: 0.7
      },
      tpConfig: {
        tp1: { atrMult: 1.2, pct: 0.30 },
        tp2: { atrMult: 2.2, pct: 0.35 },
        tp3: { pct: 0.35, trail: true }
      },
      splitConfig: {
        immediatePct: 0.60,
        limitPct: 0.40,
        limitOffsetATR: 0.20  // MR can wait for a slightly better price
      }
    },

    "squeeze-breakout": {
      // Breakout — needs room to develop, more patient TP
      trancheConfig: {
        tranche1Pct: 0.40,   // standard sizing — direction less certain
        tranche2Pct: 0.35,
        tranche3Pct: 0.25,
        tranche2TriggerATR: 0.5,   // standard — breakout should move fast
        tranche3TriggerATR: 1.2
      },
      tpConfig: {
        tp1: { atrMult: 1.8, pct: 0.25 },   // wider — let breakout develop
        tp2: { atrMult: 3.0, pct: 0.30 },
        tp3: { pct: 0.45, trail: true }       // large trail portion — breakouts can run
      },
      splitConfig: {
        immediatePct: 0.80,   // mostly market — breakout won't wait
        limitPct: 0.20,
        limitOffsetATR: 0.3
      }
    },

    "range-trap": {
      // Failed breakout recapture — high confidence, fast TP
      trancheConfig: {
        tranche1Pct: 0.50,
        tranche2Pct: 0.30,
        tranche3Pct: 0.20,
        tranche2TriggerATR: 0.3,
        tranche3TriggerATR: 0.8
      },
      tpConfig: {
        tp1: { atrMult: 1.0, pct: 0.35 },   // quick partial — trap reversal is fast
        tp2: { atrMult: 2.0, pct: 0.30 },
        tp3: { pct: 0.35, trail: true }
      },
      splitConfig: {
        immediatePct: 0.75,
        limitPct: 0.25,
        limitOffsetATR: 0.15
      }
    }
  };

  return configs[setupType] || configs["range-fade"];
}


/**
 * Build the position object for openPositionGradual with sideways-specific params.
 * Call this instead of the default tranche/TP construction.
 *
 * @param {object} candidate — scored sideways candidate
 * @param {number} totalSize — full position size (before tranche split)
 * @param {number} totalNotional — full notional
 * @param {number} leverage — leverage multiplier
 * @returns {object} — { tranches, tpLevels } ready to merge into position
 */
export function buildSidewaysPosition(candidate, totalSize, totalNotional, leverage) {
  const { signal, price, atrVal, setupType } = candidate;
  const params = getSidewaysPositionParams(candidate);
  const tc = params.trancheConfig;
  const tp = params.tpConfig;

  const tranche1Size = totalSize * tc.tranche1Pct * leverage;
  const tranche1Notional = totalNotional * tc.tranche1Pct;

  const tranche2Trigger = signal === "long"
    ? price + atrVal * tc.tranche2TriggerATR
    : price - atrVal * tc.tranche2TriggerATR;
  const tranche3Trigger = signal === "long"
    ? price + atrVal * tc.tranche3TriggerATR
    : price - atrVal * tc.tranche3TriggerATR;

  const tranches = {
    plan: {
      totalSize: totalSize * leverage,
      totalNotional,
      tranche1: {
        pct: tc.tranche1Pct, filled: true, price,
        size: tranche1Size, notional: tranche1Notional
      },
      tranche2: {
        pct: tc.tranche2Pct, filled: false,
        triggerPrice: tranche2Trigger, size: 0, notional: 0
      },
      tranche3: {
        pct: tc.tranche3Pct, filled: false,
        triggerPrice: tranche3Trigger, size: 0, notional: 0
      }
    },
    filledCount: 1,
    avgEntryPrice: price
  };

  const tpLevels = {
    tp1: {
      atrMult: tp.tp1.atrMult,
      pct: tp.tp1.pct,
      hit: false,
      price: signal === "long"
        ? price + atrVal * tp.tp1.atrMult
        : price - atrVal * tp.tp1.atrMult
    },
    tp2: {
      atrMult: tp.tp2.atrMult,
      pct: tp.tp2.pct,
      hit: false,
      price: signal === "long"
        ? price + atrVal * tp.tp2.atrMult
        : price - atrVal * tp.tp2.atrMult
    },
    tp3: {
      pct: tp.tp3.pct,
      hit: false,
      trail: true
    }
  };

  return {
    tranches,
    tpLevels,
    tranche1Size,
    tranche1Notional,
    splitConfig: params.splitConfig
  };
}


// =============================================================================
// 15-MINUTE CONFIRMATION FOR SIDEWAYS ENTRIES
//
// Reused from the earlier entry-improvements concept, but adapted for
// each sideways trade type:
//
//   range-fade + mean-reversion: REQUIRE 15m reversal confirmation
//   squeeze-breakout: REQUIRE 15m expansion candle (momentum, not reversal)
//   range-trap: 15m is OPTIONAL (trap itself is confirmation)
// =============================================================================

/**
 * Check 15m candles for sideways entry confirmation.
 * Different patterns depending on trade type.
 *
 * @param {object}     candidate  — scored sideways candidate
 * @param {Array|null} candles15m — 15m candles (null = skip confirmation)
 * @returns {{ confirmed: boolean, confidence: number, patterns: string[],
 *             adjustedScore: number, positionSizeMultiplier: number }}
 */
export function confirmSidewaysEntry(candidate, candles15m) {
  const { setupType, signal, score } = candidate;

  // Range trap: 15m is optional — the trap IS the confirmation
  if (setupType === "range-trap") {
    if (!candles15m || candles15m.length < 8) {
      return { confirmed: true, confidence: 1, patterns: ["trap-self-confirming"],
               adjustedScore: score, positionSizeMultiplier: 0.70 };
    }
  }

  // No 15m data: penalize score, reduce size
  if (!candles15m || candles15m.length < 12) {
    const penalized = score * 0.85;
    return {
      confirmed: penalized >= 4.5,
      confidence: 0,
      patterns: ["no-15m-data"],
      adjustedScore: penalized,
      positionSizeMultiplier: penalized >= 4.5 ? 0.50 : 0
    };
  }

  const n = candles15m.length;
  const last = candles15m[n - 1];
  const prev = candles15m[n - 2];
  const prev2 = candles15m[n - 3];
  const lastRange = last.high - last.low;
  let confidence = 0;
  const patterns = [];

  if (lastRange === 0) {
    return { confirmed: false, confidence: 0, patterns: ["zero-range"],
             adjustedScore: score * 0.8, positionSizeMultiplier: 0 };
  }

  const avgVol = candles15m.slice(-8, -1).reduce((s, c) => s + c.volume, 0) / 7;

  // ── Squeeze breakout: look for MOMENTUM, not reversal ──
  if (setupType === "squeeze-breakout") {
    // Large expansion candle in the signal direction
    const bodyPct = Math.abs(last.close - last.open) / lastRange;
    const isGreen = last.close > last.open;
    const correctDirection = (signal === "long" && isGreen) || (signal === "short" && !isGreen);

    if (correctDirection && bodyPct > 0.60) {
      confidence += 2.0; patterns.push("15m-strong-expansion");
    }
    if (correctDirection && avgVol > 0 && last.volume > avgVol * 1.5) {
      confidence += 1.5; patterns.push("15m-vol-expansion");
    }
    // Multiple consecutive candles in same direction
    let streak = 0;
    for (let i = n - 1; i >= Math.max(0, n - 4); i--) {
      const bullish = candles15m[i].close > candles15m[i].open;
      if ((signal === "long" && bullish) || (signal === "short" && !bullish)) streak++;
      else break;
    }
    if (streak >= 3) { confidence += 1.0; patterns.push(`15m-streak-${streak}`); }

    const confirmed = confidence >= 2.0;
    return {
      confirmed, confidence, patterns,
      adjustedScore: confirmed ? score + confidence * 0.3 : score * 0.9,
      positionSizeMultiplier: confirmed ? 0.70 : 0.45
    };
  }

  // ── Range fade + mean-reversion: look for REVERSAL patterns ──
  if (signal === "long") {
    // Hammer
    const lowerWick = Math.min(last.close, last.open) - last.low;
    const upperWick = last.high - Math.max(last.close, last.open);
    if (lowerWick / lastRange > 0.55 && upperWick / lastRange < 0.20) {
      confidence += 2.0; patterns.push("15m-hammer");
    }

    // Bullish engulfing
    if (prev.close < prev.open && last.close > last.open &&
        last.close > prev.open && last.open <= prev.close) {
      confidence += 2.5; patterns.push("15m-bull-engulfing");
    }

    // Three-bar reversal
    if (n >= 4 && prev.low < prev2.low && last.close > prev.high) {
      confidence += 1.5; patterns.push("15m-3bar-reversal");
    }

    // Volume spike on green candle
    if (last.close > last.open && avgVol > 0 && last.volume > avgVol * 1.8) {
      confidence += 1.5; patterns.push("15m-vol-reversal");
    }

    // Seller exhaustion
    let redCount = 0;
    for (let i = n - 2; i >= Math.max(0, n - 6); i--) {
      if (candles15m[i].close < candles15m[i].open) redCount++;
      else break;
    }
    if (redCount >= 3 && last.close > last.open) {
      confidence += 1.0; patterns.push(`15m-exhaustion(${redCount})`);
    }

    // Momentum divergence
    const closes = candles15m.slice(-8).map(c => c.close);
    if (closes[closes.length - 1] < closes[0] &&
        (closes[closes.length - 1] - closes[closes.length - 2]) > (closes[2] - closes[1])) {
      confidence += 1.0; patterns.push("15m-mom-div");
    }

  } else {
    // Shooting star
    const upperWick = last.high - Math.max(last.close, last.open);
    const lowerWick = Math.min(last.close, last.open) - last.low;
    if (upperWick / lastRange > 0.55 && lowerWick / lastRange < 0.20) {
      confidence += 2.0; patterns.push("15m-shooting-star");
    }

    // Bearish engulfing
    if (prev.close > prev.open && last.close < last.open &&
        last.close < prev.open && last.open >= prev.close) {
      confidence += 2.5; patterns.push("15m-bear-engulfing");
    }

    // Three-bar reversal short
    if (n >= 4 && prev.high > prev2.high && last.close < prev.low) {
      confidence += 1.5; patterns.push("15m-3bar-reversal");
    }

    // Volume spike on red candle
    if (last.close < last.open && avgVol > 0 && last.volume > avgVol * 1.8) {
      confidence += 1.5; patterns.push("15m-vol-reversal");
    }

    // Buyer exhaustion
    let greenCount = 0;
    for (let i = n - 2; i >= Math.max(0, n - 6); i--) {
      if (candles15m[i].close > candles15m[i].open) greenCount++;
      else break;
    }
    if (greenCount >= 3 && last.close < last.open) {
      confidence += 1.0; patterns.push(`15m-exhaustion(${greenCount})`);
    }

    // Momentum divergence short
    const closes = candles15m.slice(-8).map(c => c.close);
    if (closes[closes.length - 1] > closes[0] &&
        (closes[closes.length - 1] - closes[closes.length - 2]) < (closes[2] - closes[1])) {
      confidence += 1.0; patterns.push("15m-mom-div");
    }
  }

  const confirmed = confidence >= 2.0;
  const adjustedScore = confirmed
    ? score + confidence * 0.4
    : (score >= 6.5 ? score * 0.92 : score * 0.80);

  // Size gradient based on 15m confidence
  let positionSizeMultiplier;
  if (confirmed && confidence >= 4.0) positionSizeMultiplier = 0.80;
  else if (confirmed)                  positionSizeMultiplier = 0.65;
  else if (score >= 6.5)               positionSizeMultiplier = 0.50;  // strong 1h, no 15m
  else                                  positionSizeMultiplier = 0;     // skip

  return { confirmed, confidence, patterns, adjustedScore, positionSizeMultiplier };
}


// =============================================================================
// FULL INTEGRATION — updated wiring with gradual entry + 15m
// =============================================================================
//
// In bot/runner.js phaseScan(), after scoreSidewaysCandidate returns a candidate:
//
//   import {
//     scoreSidewaysCandidate, confirmSidewaysEntry,
//     buildSidewaysPosition, checkSidewaysExit, sidewaysFilter
//   } from "./sideways-system.js";
//   import { fetchCandles } from "./market-data.js";
//
//   if (candidate.setupType matches sideways types) {
//     // 1. Fetch 15m only for this candidate (1 API call)
//     const candles15m = await fetchCandles(symbol, "15m", 50);
//
//     // 2. Confirm with 15m patterns
//     const conf = confirmSidewaysEntry(candidate, candles15m);
//     if (!conf.confirmed) {
//       console.log(`[SW-SKIP] ${symbol} ${conf.patterns.join(",")}`);
//       continue;
//     }
//     candidate.score = conf.adjustedScore;
//     candidate.positionSizeMultiplier = conf.positionSizeMultiplier;
//     candidate.reasons.push(...conf.patterns);
//
//     // 3. Build position with sideways-specific tranches + TP levels
//     const swPos = buildSidewaysPosition(candidate, totalSize, totalNotional, leverage);
//     // Merge into position object:
//     position.tranches = swPos.tranches;
//     position.tpLevels = swPos.tpLevels;
//     position.maxHoldHours = candidate.maxHoldHours;
//   }
//
//
// In bot/exits.js, for sideways positions:
//
//   const SW_SETUPS = ["range-fade","mean-reversion","squeeze-breakout","range-trap"];
//   if (SW_SETUPS.includes(pos.setupType)) {
//     // Check sideways-specific time/trail exits FIRST
//     const swExit = checkSidewaysExit(pos, price, currentAtr, hoursOpen);
//     if (swExit.exit) {
//       closePosition(symbol, price, swExit.reason, state, deps);
//       continue;
//     }
//     // Then fall through to normal checkGraduatedExit for TP1/TP2 partials
//     // (which will use the tighter tpLevels set by buildSidewaysPosition)
//   }
//
//
// The graduated exit system (checkGraduatedExit) works UNCHANGED because
// buildSidewaysPosition sets tpLevels with the same shape as the normal
// system — just tighter values. TP1 at 1.0-1.8 ATR instead of 2.0, TP2 at
// 1.8-3.0 ATR instead of 3.5. The 30/30/40 split and the SL-tighten-on-TP1
// logic all work the same way.
//
// checkTranches() also works UNCHANGED because buildSidewaysPosition
// sets the same tranche shape — just tighter trigger prices.
// =============================================================================
