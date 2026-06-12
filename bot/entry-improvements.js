// =============================================================================
// ENTRY IMPROVEMENTS — all fixes + sideways mean-reversion strategy
//
// Contents:
//   FIX 1: checkEarlyReversalTighten()    — tighten SL on stalled trades
//   FIX 2: liquidityTrapQualityGate()     — require 2+ confirmations for LT
//   FIX 3: sidewaysFilter()               — block trend setups in sideways
//   NEW:   scoreSidewaysMeanReversion()   — dedicated MR scoring for sideways
//   NEW:   check15mReversal()             — 15m candle reversal detection
//   NEW:   stochRSI15m()                  — 15m StochRSI oscillator
//   NEW:   confirmMeanReversionEntry()    — combined MR go/no-go decision
//   NEW:   checkMeanReversionExit()       — tighter exit rules for MR trades
//
// Drop this file into bot/ and import what you need.
// =============================================================================


// =============================================================================
// FIX 1 — EARLY REVERSAL STOP TIGHTENING
//
// Problem:  397 trades hit SL with zero partial TPs, averaging -$20.
//           31% of losers die within 3 bars. Median loser holds 6h vs
//           median winner 10h.
//
// Solution: If price hasn't moved favorably by N bars after entry, tighten
//           the stop. The trade can still win — the allowed drawdown shrinks.
//
// Impact:   ~100-150 trades lose $3-5 less each → saves $300-500
// =============================================================================

/**
 * Tighten stop if price hasn't confirmed the entry direction.
 * Call in checkAllExits() alongside graduated exit logic.
 *
 * @param {object} pos       - position from state.positions
 * @param {number} price     - current price
 * @param {number} currentAtr - current ATR value
 * @param {number} barsOpen  - hours since entry
 * @returns {{ tighten: boolean, newSl: number|null, reason: string|null }}
 */
export function checkEarlyReversalTighten(pos, price, currentAtr, barsOpen) {
  const { direction, entryPrice, sl, atrVal } = pos;
  const entryAtr = atrVal || currentAtr;

  // Skip if already hit a TP level — trade is working
  if (pos.tpLevels?.tp1?.hit) return { tighten: false, newSl: null, reason: null };

  // Skip mean-reversion — it has its own exit logic (checkMeanReversionExit)
  if (pos.setupType === "mean-reversion") return { tighten: false, newSl: null, reason: null };

  const favorableMove = direction === "long"
    ? (pos.maxFavorable || price) - entryPrice
    : entryPrice - (pos.maxFavorable || price);

  // Phase 1: 3h with no 0.3 ATR move → halve SL distance (2.0 ATR → 1.0 ATR)
  if (barsOpen >= 3 && favorableMove < entryAtr * 0.3) {
    const tighterSl = direction === "long"
      ? Math.max(sl, entryPrice - entryAtr * 1.0)
      : Math.min(sl, entryPrice + entryAtr * 1.0);

    const shouldTighten = direction === "long" ? tighterSl > sl : tighterSl < sl;
    if (shouldTighten) {
      return {
        tighten: true,
        newSl: tighterSl,
        reason: `early-tighten-3h(fav=${(favorableMove / entryAtr).toFixed(1)}ATR)`
      };
    }
  }

  // Phase 2: 6h with no T2 fill and no 0.5 ATR move → near-breakeven
  if (barsOpen >= 6 && !pos.tranches?.plan?.tranche2?.filled && favorableMove < entryAtr * 0.5) {
    const nearBE = direction === "long"
      ? entryPrice - entryAtr * 0.3
      : entryPrice + entryAtr * 0.3;

    const shouldTighten = direction === "long" ? nearBE > sl : nearBE < sl;
    if (shouldTighten) {
      return {
        tighten: true,
        newSl: nearBE,
        reason: `early-tighten-6h(noT2,fav=${(favorableMove / entryAtr).toFixed(1)}ATR)`
      };
    }
  }

  return { tighten: false, newSl: null, reason: null };
}


// =============================================================================
// FIX 2 — LIQUIDITY-TRAP QUALITY GATE
//
// Problem:  477 liquidity-trap entries. 216 with 0-1 tranche fills = pure loss.
//           Tranche 0: 103 trades, 0% WR, -$12 avg
//           Tranche 1: 113 trades, 3.5% WR, -$21 avg
//           Tranche 2: 261 trades, 88.9% WR, +$25 avg
//
// Solution: Require 2+ confirmations (volume, divergence, H4, ADX) before
//           entering a liquidity-trap. The trap detection is fine — the
//           problem is entering without conviction behind the reversal.
//
// Impact:   Blocks ~100-150 low-quality LT entries → saves $1400-2500
// =============================================================================

/**
 * Quality gate for liquidity-trap setups.
 * Call after scoring, before entry decision.
 *
 * @param {object} candidate      - scored candidate from scoreSymbol
 * @param {object} volumeData     - from volumeConfirmation() { ratio, isAboveAverage, ... }
 * @param {object} rsiDivergence  - from detectRSIDivergence() { type, strength }
 * @returns {{ pass: boolean, confirmations: number, reason: string }}
 */
export function liquidityTrapQualityGate(candidate, volumeData, rsiDivergence) {
  if (candidate.setupType !== "liquidity-trap") {
    return { pass: true, confirmations: 0, reason: "not-liquidity-trap" };
  }

  let confirmations = 0;
  const details = [];

  // Confirmation 1: Volume above average on the recapture
  if (volumeData && volumeData.ratio > 1.2) {
    confirmations++;
    details.push(`vol(${volumeData.ratio.toFixed(1)}x)`);
  }

  // Confirmation 2: RSI or OBV divergence supports the reversal
  if (rsiDivergence && rsiDivergence.type !== "none") {
    const divMatch =
      (candidate.signal === "long" && rsiDivergence.type === "bullish") ||
      (candidate.signal === "short" && rsiDivergence.type === "bearish");
    if (divMatch) {
      confirmations++;
      details.push(`rsi-div(${rsiDivergence.type})`);
    }
  }

  // Confirmation 3: H4 trend alignment
  if (
    (candidate.signal === "long" && candidate.h4Trend === "bullish") ||
    (candidate.signal === "short" && candidate.h4Trend === "bearish")
  ) {
    confirmations++;
    details.push(`h4(${candidate.h4Trend})`);
  }

  // Confirmation 4: ADX showing trend strength in reversal direction
  if (candidate.adxResult?.trending) {
    const aligned =
      (candidate.signal === "long" && candidate.adxResult.pdi > candidate.adxResult.mdi) ||
      (candidate.signal === "short" && candidate.adxResult.mdi > candidate.adxResult.pdi);
    if (aligned) {
      confirmations++;
      details.push(`adx(${candidate.adxResult.adx?.toFixed(0)})`);
    }
  }

  const pass = confirmations >= 2;

  return {
    pass,
    confirmations,
    reason: pass
      ? `lt-confirmed(${confirmations}): ${details.join(",")}`
      : `lt-rejected(${confirmations}/2): ${details.join(",") || "no-confirmation"}`
  };
}


// =============================================================================
// FIX 3 — SIDEWAYS REGIME TRADE FILTER
//
// Problem:  Sideways has $2.54 expectancy pre-friction, ~$1.29 after.
//           "trend" setups in sideways: NEGATIVE expectancy (-$2.07 avg).
//           Trend-following in a range is structurally wrong.
//
// Solution: Block trend setups in sideways entirely. Raise minimum score
//           for all sideways entries from 4 to 5.
//
// Impact:   Blocks ~27 neg-EV trend trades + ~40-60 marginal ones → saves $100-200
// =============================================================================

/**
 * Sideways regime entry filter.
 * Call after scoring, before entry/Claude validation.
 * Mean-reversion setups are exempt (they're designed for sideways).
 *
 * @param {object} candidate    - scored candidate
 * @param {string} regimeLabel  - current regime label
 * @param {object} regimeStats  - state.regimeStats (for adaptive tightening)
 * @returns {{ allowed: boolean, reason: string }}
 */
export function sidewaysFilter(candidate, regimeLabel, regimeStats) {
  if (regimeLabel !== "sideways") {
    return { allowed: true, reason: "not-sideways" };
  }

  // Mean-reversion setups are the RIGHT play in sideways — let them through
  if (candidate.setupType === "mean-reversion") {
    return { allowed: true, reason: "mr-exempt-from-sideways-filter" };
  }

  // Block trend and momentum setups — negative expectancy in sideways
  if (candidate.setupType === "trend" || candidate.setupType === "momentum") {
    return { allowed: false, reason: `${candidate.setupType}-in-sideways-blocked(neg-EV)` };
  }

  // Raise minimum score for all other setups in sideways
  const sidewaysMinScore = 5.0;
  if (candidate.score < sidewaysMinScore) {
    return {
      allowed: false,
      reason: `sideways-score-too-low(${candidate.score}<${sidewaysMinScore})`
    };
  }

  // Adaptive: if regime stats show sideways is deeply negative, restrict further
  if (regimeStats?.sideways?.count >= 30) {
    const rs = regimeStats.sideways;
    const avgPnl = rs.totalPnl / rs.count;
    const winRate = rs.wins / rs.count;

    if (avgPnl < -2 && winRate < 0.42) {
      const stricter = 6.0;
      if (candidate.score < stricter) {
        return {
          allowed: false,
          reason: `sideways-restrict(avgPnl=${avgPnl.toFixed(1)},WR=${(winRate * 100).toFixed(0)}%,need>=${stricter})`
        };
      }
    }
  }

  return { allowed: true, reason: "sideways-passed" };
}


// =============================================================================
// SIDEWAYS MEAN-REVERSION SCORING
//
// Activates ONLY in sideways regime when price is at a Bollinger Band edge.
// Different parameters than trend trades:
//   - Entries at BB edges + S/R confluence
//   - Tighter SL (1.2 ATR vs 2.0 ATR)
//   - Shorter TP (target EMA20/VWAP, not 5× ATR)
//   - Time-limited: auto-exit at 12h if < 0.5 ATR profit
//   - Smaller position size (70% of normal)
//
// Philosophy: In a range, fade the extremes, take quick profits, get out.
// =============================================================================

/**
 * Score a candidate for mean-reversion in sideways regime.
 * Returns null if conditions aren't met (falls through to normal scoring).
 *
 * @param {object} ind — all computed indicators from scoreSymbol
 * @returns {object|null} — { signal, score, setupType, reasons, sl, tp, ... }
 */
export function scoreSidewaysMeanReversion({
  price, closes, highs, lows, volumes,
  rsiVal, stochResult, fisherVal, fisherPrev,
  pctB, bbUpper, bbLower, bbMiddle, bbWidth,
  vwapVal, currentEMA20,
  supports, resistances,
  adxResult, atrVal,
  obvDiv, volConfirm,
  regime
}) {
  // Gate 1: sideways only
  if (regime?.label !== "sideways") return null;

  // Gate 2: ADX must be below trending threshold — > 35 means a real trend, not ranging chop
  if (adxResult?.adx > 35) return null;

  // Gate 3: Bollinger Bands must exist
  if (!bbUpper || !bbLower || !bbMiddle || bbWidth === undefined) return null;

  // Gate 4: Price must be at a range edge (widened to 25/75 for narrow-band sideways)
  const atLowerEdge = pctB < 0.25;
  const atUpperEdge = pctB > 0.75;
  if (!atLowerEdge && !atUpperEdge) return null;

  let score = 0;
  const reasons = [];

  if (atLowerEdge) {
    // ── LONG REVERSAL — price at bottom of range ──

    if (rsiVal < 30)      { score += 2.0; reasons.push("mr-rsi-extreme-low"); }
    else if (rsiVal < 35) { score += 1.0; reasons.push("mr-rsi-low"); }

    if (stochResult?.oversold)                          { score += 1.5; reasons.push("mr-stoch-oversold"); }
    if (stochResult?.crossUp && stochResult?.k < 25)    { score += 1.0; reasons.push("mr-stoch-cross-up"); }

    if (fisherVal < -1.5 && fisherVal > fisherPrev)     { score += 1.5; reasons.push("mr-fisher-reversal"); }

    const nearSupport = supports?.some(s => Math.abs(price - s) / price < 0.005);
    if (nearSupport)                                    { score += 2.0; reasons.push("mr-at-support"); }

    // Volume exhaustion: declining volume on the drop
    if (volumes && volumes.length >= 10) {
      const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const priorVol  = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
      if (priorVol > 0 && recentVol < priorVol * 0.7)  { score += 1.0; reasons.push("mr-vol-exhaustion"); }
    }
    if (volConfirm?.isSignificant)                      { score += 0.5; reasons.push("mr-vol-spike"); }
    if (obvDiv === "bullish")                           { score += 1.5; reasons.push("mr-obv-div-bull"); }
    if (pctB < 0.0)                                     { score += 0.5; reasons.push("mr-below-bb"); }

    if (score < 4.5) return null;

    const sl = price - atrVal * 1.2;
    const meanTarget = Math.min(currentEMA20 || bbMiddle, vwapVal || bbMiddle);
    const tp = meanTarget > price ? meanTarget - atrVal * 0.1 : price + atrVal * 1.5;

    return {
      signal: "long", score, setupType: "mean-reversion", reasons, price,
      sl, tp, atrVal,
      riskReward: Math.abs(tp - price) / Math.abs(price - sl),
      positionSizeMultiplier: 0.70,
      maxHoldHours: 12
    };

  } else {
    // ── SHORT REVERSAL — price at top of range ──

    if (rsiVal > 70)      { score += 2.0; reasons.push("mr-rsi-extreme-high"); }
    else if (rsiVal > 65) { score += 1.0; reasons.push("mr-rsi-high"); }

    if (stochResult?.overbought)                        { score += 1.5; reasons.push("mr-stoch-overbought"); }
    if (stochResult?.crossDown && stochResult?.k > 75)  { score += 1.0; reasons.push("mr-stoch-cross-down"); }

    if (fisherVal > 1.5 && fisherVal < fisherPrev)      { score += 1.5; reasons.push("mr-fisher-reversal"); }

    const nearResistance = resistances?.some(r => Math.abs(price - r) / price < 0.005);
    if (nearResistance)                                 { score += 2.0; reasons.push("mr-at-resistance"); }

    if (volumes && volumes.length >= 10) {
      const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const priorVol  = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
      if (priorVol > 0 && recentVol < priorVol * 0.7)  { score += 1.0; reasons.push("mr-vol-exhaustion"); }
    }
    if (volConfirm?.isSignificant)                      { score += 0.5; reasons.push("mr-vol-spike"); }
    if (obvDiv === "bearish")                           { score += 1.5; reasons.push("mr-obv-div-bear"); }
    if (pctB > 1.0)                                     { score += 0.5; reasons.push("mr-above-bb"); }

    if (score < 4.5) return null;

    const sl = price + atrVal * 1.2;
    const meanTarget = Math.max(currentEMA20 || bbMiddle, vwapVal || bbMiddle);
    const tp = meanTarget < price ? meanTarget + atrVal * 0.1 : price - atrVal * 1.5;

    return {
      signal: "short", score, setupType: "mean-reversion", reasons, price,
      sl, tp, atrVal,
      riskReward: Math.abs(price - tp) / Math.abs(sl - price),
      positionSizeMultiplier: 0.70,
      maxHoldHours: 12
    };
  }
}


// =============================================================================
// 15-MINUTE REVERSAL CONFIRMATION
//
// Called ONLY for candidates that pass the 1h MR screen.
// Fetch 15m candles for that one symbol (1 API call), then check for
// actual micro-structure reversal: hammer, engulfing, exhaustion, vol spike.
// =============================================================================

/**
 * Check if 15m candles show a reversal forming.
 *
 * @param {Array}  candles15m — 15m candles, chronological, at least 12 bars
 * @param {string} direction  — "long" or "short"
 * @returns {{ confirmed: boolean, confidence: number, patterns: string[] }}
 */
export function check15mReversal(candles15m, direction) {
  if (!candles15m || candles15m.length < 12) {
    return { confirmed: false, confidence: 0, patterns: ["insufficient-data"] };
  }

  const n = candles15m.length;
  const patterns = [];
  let confidence = 0;

  const last  = candles15m[n - 1];
  const prev  = candles15m[n - 2];
  const prev2 = candles15m[n - 3];

  const lastRange = last.high - last.low;
  if (lastRange === 0) return { confirmed: false, confidence: 0, patterns: ["zero-range-bar"] };

  const avgVol = candles15m.slice(-8, -1).reduce((s, c) => s + c.volume, 0) / 7;

  // RSI divergence helper — works in low-vol flat markets where candle patterns don't form
  const allCloses = candles15m.map(c => c.close);
  const rsiVals = (() => {
    const period = 14;
    if (allCloses.length < period + 5) return null;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = allCloses[i] - allCloses[i - 1];
      if (d > 0) avgGain += d; else avgLoss -= d;
    }
    avgGain /= period; avgLoss /= period;
    const vals = [];
    for (let i = period; i < allCloses.length; i++) {
      if (i > period) {
        const d = allCloses[i] - allCloses[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
      }
      vals.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return vals;
  })();

  if (direction === "long") {
    // 1. Hammer / pin bar: long lower wick, small body at top
    const lowerWick = Math.min(last.close, last.open) - last.low;
    const upperWick = last.high - Math.max(last.close, last.open);
    if (lowerWick / lastRange > 0.60 && upperWick / lastRange < 0.15) {
      confidence += 2; patterns.push("15m-hammer");
    }

    // 2. Bullish engulfing: red → larger green that engulfs it
    if (prev.close < prev.open && last.close > last.open &&
        last.close > prev.open && last.open <= prev.close) {
      confidence += 2.5; patterns.push("15m-bull-engulfing");
    }

    // 3. Three-bar reversal: lower low → recovery above prev high
    if (prev.low < prev2.low && last.close > prev.high) {
      confidence += 1.5; patterns.push("15m-three-bar-reversal");
    }

    // 4. Momentum divergence: price falling but rate-of-change lifting
    const closes = candles15m.slice(-8).map(c => c.close);
    if (closes[closes.length - 1] < closes[0] &&
        (closes[closes.length - 1] - closes[closes.length - 2]) >
        (closes[2] - closes[1])) {
      confidence += 1; patterns.push("15m-momentum-divergence");
    }

    // 5. Volume spike on green candle (capitulation bounce)
    if (last.close > last.open && avgVol > 0 && last.volume > avgVol * 1.8) {
      confidence += 1.5; patterns.push("15m-volume-reversal");
    }

    // 6. Seller exhaustion: 3+ red candles ending with green
    let redCount = 0;
    for (let i = n - 2; i >= Math.max(0, n - 6); i--) {
      if (candles15m[i].close < candles15m[i].open) redCount++;
      else break;
    }
    if (redCount >= 3 && last.close > last.open) {
      confidence += 1; patterns.push(`15m-red-exhaustion(${redCount})`);
    }

    // 7. RSI bullish divergence: price lower low, RSI higher low (flat-market friendly)
    if (rsiVals && rsiVals.length >= 10) {
      const recentLow  = Math.min(...allCloses.slice(-5));
      const priorLow   = Math.min(...allCloses.slice(-10, -5));
      const recentRsiL = Math.min(...rsiVals.slice(-5));
      const priorRsiL  = Math.min(...rsiVals.slice(-10, -5));
      if (recentLow < priorLow && recentRsiL > priorRsiL) {
        confidence += 2; patterns.push("15m-rsi-bull-div");
      }
    }

  } else {
    // 1. Shooting star: long upper wick, small body at bottom
    const upperWick = last.high - Math.max(last.close, last.open);
    const lowerWick = Math.min(last.close, last.open) - last.low;
    if (upperWick / lastRange > 0.60 && lowerWick / lastRange < 0.15) {
      confidence += 2; patterns.push("15m-shooting-star");
    }

    // 2. Bearish engulfing
    if (prev.close > prev.open && last.close < last.open &&
        last.close < prev.open && last.open >= prev.close) {
      confidence += 2.5; patterns.push("15m-bear-engulfing");
    }

    // 3. Three-bar reversal (short side)
    if (prev.high > prev2.high && last.close < prev.low) {
      confidence += 1.5; patterns.push("15m-three-bar-reversal");
    }

    // 4. Momentum divergence (short)
    const closes = candles15m.slice(-8).map(c => c.close);
    if (closes[closes.length - 1] > closes[0] &&
        (closes[closes.length - 1] - closes[closes.length - 2]) <
        (closes[2] - closes[1])) {
      confidence += 1; patterns.push("15m-momentum-divergence");
    }

    // 5. Volume spike on red candle
    if (last.close < last.open && avgVol > 0 && last.volume > avgVol * 1.8) {
      confidence += 1.5; patterns.push("15m-volume-reversal");
    }

    // 6. Buyer exhaustion
    let greenCount = 0;
    for (let i = n - 2; i >= Math.max(0, n - 6); i--) {
      if (candles15m[i].close > candles15m[i].open) greenCount++;
      else break;
    }
    if (greenCount >= 3 && last.close < last.open) {
      confidence += 1; patterns.push(`15m-green-exhaustion(${greenCount})`);
    }

    // 7. RSI bearish divergence: price higher high, RSI lower high (flat-market friendly)
    if (rsiVals && rsiVals.length >= 10) {
      const recentHigh  = Math.max(...allCloses.slice(-5));
      const priorHigh   = Math.max(...allCloses.slice(-10, -5));
      const recentRsiH  = Math.max(...rsiVals.slice(-5));
      const priorRsiH   = Math.max(...rsiVals.slice(-10, -5));
      if (recentHigh > priorHigh && recentRsiH < priorRsiH) {
        confidence += 2; patterns.push("15m-rsi-bear-div");
      }
    }
  }

  return { confirmed: confidence >= 1.5, confidence, patterns };
}


/**
 * Fast StochRSI on 15m closes. Confirms the 1h extreme on micro timeframe.
 *
 * @param {Array}  candles15m — 15m candles
 * @param {number} period     — RSI/Stoch period (default 14)
 * @returns {{ k, oversold, overbought, crossUp, crossDown }|null}
 */
export function stochRSI15m(candles15m, period = 14) {
  if (!candles15m || candles15m.length < period + 5) return null;

  const closes = candles15m.map(c => c.close);
  const n = closes.length;

  // RSI
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) avgGain += delta; else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;

  const rsiValues = [];
  for (let i = period; i < n; i++) {
    if (i > period) {
      const delta = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (delta > 0 ? delta : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (delta < 0 ? -delta : 0)) / period;
    }
    const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
    rsiValues.push(100 - 100 / (1 + rs));
  }

  if (rsiValues.length < period) return null;

  const recent = rsiValues.slice(-period);
  const minRsi = Math.min(...recent);
  const maxRsi = Math.max(...recent);
  const range = maxRsi - minRsi;
  const k     = range > 0 ? ((rsiValues[rsiValues.length - 1] - minRsi) / range) * 100 : 50;
  const kPrev = range > 0 && rsiValues.length >= 2
    ? ((rsiValues[rsiValues.length - 2] - minRsi) / range) * 100 : 50;

  return {
    k,
    oversold:  k < 20,
    overbought: k > 80,
    crossUp:   k > kPrev && kPrev < 20,
    crossDown: k < kPrev && kPrev > 80,
  };
}


// =============================================================================
// COMBINED MEAN-REVERSION ENTRY DECISION
//
// Flow: 1h screen → 15m fetch (1 API call) → this function → go/no-go
// =============================================================================

/**
 * Full mean-reversion entry check with optional 15m confirmation.
 *
 * @param {object}     candidate  — from scoreSidewaysMeanReversion()
 * @param {Array|null} candles15m — 15m candles (null if not fetched)
 * @returns {{ enter: boolean, reason: string, adjustedScore: number,
 *             patterns: string[], positionSizeMultiplier: number }}
 */
export function confirmMeanReversionEntry(candidate, candles15m) {
  if (!candidate || candidate.setupType !== "mean-reversion") {
    return { enter: false, reason: "not-mr", adjustedScore: 0, patterns: [], positionSizeMultiplier: 0 };
  }

  // --- No 15m data: fall back to 1h-only with score penalty ---
  if (!candles15m || candles15m.length < 12) {
    const penalized = candidate.score * 0.85;
    return {
      enter: penalized >= 5.0,
      reason: penalized >= 5.0 ? "mr-no-15m-high-score" : "mr-no-15m-low-score",
      adjustedScore: penalized,
      patterns: [],
      positionSizeMultiplier: penalized >= 5.0 ? 0.50 : 0  // half size without 15m
    };
  }

  // --- 15m reversal patterns ---
  const reversal = check15mReversal(candles15m, candidate.signal);

  // --- 15m StochRSI bonus ---
  const stoch = stochRSI15m(candles15m);
  let stochBonus = 0;
  if (stoch) {
    if (candidate.signal === "long" && stoch.crossUp)       stochBonus = 1.0;
    else if (candidate.signal === "short" && stoch.crossDown) stochBonus = 1.0;
    else if (candidate.signal === "long" && stoch.oversold)   stochBonus = 0.5;
    else if (candidate.signal === "short" && stoch.overbought) stochBonus = 0.5;
  }

  const adjustedScore = candidate.score + (reversal.confidence * 0.5) + stochBonus;

  // StochRSI crossover in extreme territory = independent confirmation path
  const stochConfirmed = stoch && (
    (candidate.signal === "long"  && stoch.crossUp)   ||
    (candidate.signal === "short" && stoch.crossDown)
  );

  // 15m confirmed (candle patterns or RSI divergence) OR StochRSI crossover → enter
  if (reversal.confirmed || stochConfirmed) {
    const source = reversal.confirmed
      ? reversal.patterns.join(",")
      : "stochrsi-crossover";
    const allPatterns = reversal.confirmed
      ? reversal.patterns
      : [...reversal.patterns, "stochrsi-crossover"];
    return {
      enter: true,
      reason: `mr-15m-confirmed(${source})`,
      adjustedScore,
      patterns: allPatterns,
      positionSizeMultiplier: adjustedScore >= 6 ? 0.80 : 0.65
    };
  }

  // 15m NOT confirmed but 1h score strong enough → enter at half size
  if (candidate.score >= 5.5) {
    return {
      enter: true,
      reason: `mr-15m-unconfirmed-but-strong(${candidate.score})`,
      adjustedScore: candidate.score * 0.9,
      patterns: reversal.patterns,
      positionSizeMultiplier: 0.50
    };
  }

  // Skip — 15m doesn't confirm and score isn't high enough
  return {
    enter: false,
    reason: `mr-15m-rejected(conf=${reversal.confidence.toFixed(1)},patterns=${reversal.patterns.join(",")})`,
    adjustedScore,
    patterns: reversal.patterns,
    positionSizeMultiplier: 0
  };
}


// =============================================================================
// MEAN-REVERSION EXIT RULES
//
// Tighter time management than trend trades.
// Wire into checkGraduatedExit():
//   if (pos.setupType === "mean-reversion") {
//     const mrExit = checkMeanReversionExit(pos, price, currentAtr, hoursOpen);
//     if (mrExit.exit) return mrExit;
//   }
// =============================================================================

/**
 * Exit logic specifically for mean-reversion positions.
 *
 * @param {object} pos        - position object
 * @param {number} price      - current price
 * @param {number} currentAtr - current ATR
 * @param {number} hoursOpen  - hours since entry
 * @returns {{ exit: boolean, reason: string, partial: boolean }}
 */
export function checkMeanReversionExit(pos, price, currentAtr, hoursOpen) {
  const { direction, entryPrice, atrVal } = pos;
  const entryAtr = atrVal || currentAtr;

  const profitATRs = direction === "long"
    ? (price - entryPrice) / entryAtr
    : (entryPrice - price) / entryAtr;

  // Rule 1: 12h with < 0.5 ATR profit → thesis failed, exit
  if (hoursOpen >= 12 && profitATRs < 0.5) {
    return { exit: true, reason: "mr-time-expired-12h", partial: false };
  }

  // Rule 2: 8h and underwater → don't let MR become a bag hold
  if (hoursOpen >= 8 && profitATRs < 0) {
    return { exit: true, reason: "mr-underwater-8h", partial: false };
  }

  // Rule 3: 1.0 ATR profit → trail stop to breakeven + 0.2 ATR
  if (profitATRs >= 1.0) {
    const trail = direction === "long"
      ? entryPrice + entryAtr * 0.2
      : entryPrice - entryAtr * 0.2;
    if (direction === "long" ? trail > pos.sl : trail < pos.sl) {
      pos.sl = trail;
    }
  }

  // Rule 4: 1.5+ ATR profit (overshot the mean) → tight trail
  if (profitATRs >= 1.5) {
    const trail = direction === "long"
      ? price - entryAtr * 0.4
      : price + entryAtr * 0.4;
    if (direction === "long" ? trail > pos.sl : trail < pos.sl) {
      pos.sl = trail;
    }
  }

  return { exit: false, partial: false };
}

// =============================================================================
// BEAR REGIME FILTER
//
// In bear regime, shorts are encouraged (lower bar: 4.0), longs discouraged (7.0+)
// Prevents weak longs from entering during sustained downtrends
// =============================================================================

/**
 * Gate entry candidates based on bear regime and signal type
 * @param {object} candidate - candidate from scoring
 * @param {string} regimeLabel - regime.label (bull/bear/sideways)
 * @param {object} regimeStats - regime stats (unused but reserved)
 * @returns {{ allowed: boolean, reason: string }}
 */
export function bearFilter(candidate, regimeLabel, regimeStats) {
  if (regimeLabel !== "bear") {
    return { allowed: true, reason: "not-bear" };
  }

  // In bear regime: shorts are encouraged, longs are discouraged
  if (candidate.signal === "short") {
    // Lower the bar for shorts in bear regime
    if (candidate.score >= 4.0) return { allowed: true, reason: "bear-short-approved" };
    return { allowed: false, reason: `bear-short-low-score(${candidate.score.toFixed(1)})` };
  } else {
    // Long in bear: need VERY high conviction (7.0+)
    if (candidate.score >= 7.0) return { allowed: true, reason: "bear-long-extreme-conviction" };
    return { allowed: false, reason: `bear-long-blocked(${candidate.score.toFixed(1)}<7.0)` };
  }
}
