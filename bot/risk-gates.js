// =============================================================================
// RISK GATES — Pre-entry filters that block bad trades before they open
//
// Fix 3: R:R minimum (0.8)
// Fix 5: Daily loss limit (3% of portfolio)
// Fix 6: Regime-aware weight equalization for sideways markets
//
// Wire into runner.js phaseScan() before entry execution.
// =============================================================================

import { portfolioValue } from "./execution.js";

// -----------------------------------------------------------------------------
// FIX 3 — R:R MINIMUM GATE
// -----------------------------------------------------------------------------
// Block any entry where risk exceeds reward below the minimum threshold.
// Your calculateStructuredSLTP already falls back to ATR when R:R < 1.5,
// but that fallback still produces entries. This is the hard block.

const MIN_RR = 0.8;

/**
 * @param {object} candidate - scored candidate with riskReward field
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function checkMinRR(candidate) {
  const rr = candidate.riskReward || 0;

  if (rr < MIN_RR) {
    return {
      allowed: false,
      reason: `R:R ${rr.toFixed(2)} < ${MIN_RR} minimum`
    };
  }

  return { allowed: true, reason: null };
}


// -----------------------------------------------------------------------------
// FIX 5 — DAILY LOSS LIMIT
// -----------------------------------------------------------------------------
// If realized losses today exceed X% of portfolio, stop opening new positions.
// Prevents the spiral seen on May 3 with BABY (8 trades, net +$180 after
// swinging through +$740 wins and -$766 losses in 11 hours).

const DAILY_LOSS_LIMIT_PCT = 0.04; // 4% of portfolio value (matches mid-run net halt)

/**
 * Check if daily realized losses have exceeded the limit.
 * Call once at the start of phaseScan(), before scoring candidates.
 *
 * @param {object} state - bot state
 * @param {object[]} [todayTradesOverride] - optional: pass pre-loaded today's trades
 * @returns {{ allowed: boolean, reason: string|null, dailyLoss: number, limit: number }}
 */
export function checkDailyLossLimit(state, todayTradesOverride = null) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  // Use override if provided (from trade-store.loadTodayTrades),
  // otherwise fall back to in-memory state.trades
  const todayTrades = todayTradesOverride || (state.trades || []).filter(t => {
    const closedAt = t.closedAt ? new Date(t.closedAt).getTime() : 0;
    return closedAt >= todayStartMs;
  });

  // Sum only losses (negative PnL)
  const dailyLoss = todayTrades
    .filter(t => (t.pnl || 0) < 0)
    .reduce((sum, t) => sum + Math.abs(t.pnl || 0), 0);

  const pVal = portfolioValue(state);
  const limit = pVal * DAILY_LOSS_LIMIT_PCT;

  if (dailyLoss >= limit) {
    return {
      allowed: false,
      reason: `daily loss $${dailyLoss.toFixed(2)} >= ${(DAILY_LOSS_LIMIT_PCT * 100).toFixed(0)}% limit ($${limit.toFixed(2)})`,
      dailyLoss,
      limit
    };
  }

  return { allowed: true, reason: null, dailyLoss, limit };
}


// -----------------------------------------------------------------------------
// FIX 6 — REGIME-AWARE WEIGHT EQUALIZATION
// -----------------------------------------------------------------------------
// In sideways regime, the bot structurally favors longs because several
// signal weights are asymmetric (ribbon-expansion-bull: 2.0 vs bear: 0.65,
// liquidity-bear: 0.0 vs bull: 0.75, etc.). The dynamic weights compound this.
//
// This fix: when regime is sideways, equalize paired signal weights so
// longs and shorts are scored on a level playing field.

const SIGNAL_PAIRS = [
  ["ema-ribbon-bull", "ema-ribbon-bear"],
  ["ribbon-expansion-bull", "ribbon-expansion-bear"],
  ["liquidity-bull", "liquidity-bear"],
  ["trap-bull-confirm", "trap-bear-confirm"],
  ["trap-vol-bull", "trap-vol-bear"],
  ["rsi-bull-div", "rsi-bear-div"],
  ["OBV-bull-div", "OBV-bear-div"],
  ["h4-bull", "h4-bear"],
  ["TK-bull", "TK-bear"],
  ["above-cloud", "below-cloud"],
  ["chikou-bull", "chikou-bear"],
  ["fisher-rising", "fisher-falling"],
  ["fisher-oversold", "fisher-overbought"],
  ["above-VWAP", "below-VWAP"],
  ["macd-cross-up", "macd-cross-down"],
  ["stochrsi-cross-up", "stochrsi-cross-down"],
  ["stochrsi-oversold", "stochrsi-overbought"],
  ["rsi-oversold", "rsi-overbought"],
  ["bb-oversold", "bb-overbought"],
  ["adx-strong-bull", "adx-strong-bear"],
  ["funding-crowded-long", "funding-crowded-short"],
  ["funding-extreme-long", "funding-extreme-short"],
];

/**
 * Get a weight for a signal, with regime-aware equalization.
 * Drop-in replacement for the existing getWeight() in bot.js.
 *
 * In sideways regime: for each bull/bear pair, use the average of both weights
 * so neither direction has a structural advantage.
 *
 * @param {string} signal
 * @param {object} state
 * @param {string} regimeLabel - state.lastRegime.label
 * @param {object} SIGNAL_WEIGHTS_STATIC - the static config weights
 * @returns {number}
 */
export function getWeightRegimeAware(signal, state, regimeLabel, SIGNAL_WEIGHTS_STATIC) {
  // Get the raw weight (dynamic or static)
  let weight;
  if (state.dynamicWeights && state.dynamicWeights[signal] !== undefined) {
    weight = state.dynamicWeights[signal];
  } else {
    weight = SIGNAL_WEIGHTS_STATIC[signal] || 1.0;
  }

  // Only equalize in sideways regime
  if (regimeLabel !== "sideways") return weight;

  // Find if this signal has a pair
  for (const [bull, bear] of SIGNAL_PAIRS) {
    let pairSignal = null;
    if (signal === bull) pairSignal = bear;
    else if (signal === bear) pairSignal = bull;
    else continue;

    // Get the pair's weight
    let pairWeight;
    if (state.dynamicWeights && state.dynamicWeights[pairSignal] !== undefined) {
      pairWeight = state.dynamicWeights[pairSignal];
    } else {
      pairWeight = SIGNAL_WEIGHTS_STATIC[pairSignal] || 1.0;
    }

    // Use the average — neither side gets a structural advantage
    const equalized = (weight + pairWeight) / 2;
    return equalized;
  }

  return weight;
}


// -----------------------------------------------------------------------------
// COMBINED PRE-ENTRY CHECK
// -----------------------------------------------------------------------------

/**
 * Run all pre-entry risk gates on a candidate.
 * Returns the first failing gate, or { allowed: true } if all pass.
 *
 * @param {object} candidate
 * @param {object} state
 * @param {object} [options]
 * @param {object[]} [options.todayTrades] - pre-loaded today's trades
 * @returns {{ allowed: boolean, gate: string|null, reason: string|null }}
 */
export function runPreEntryGates(candidate, state, options = {}) {
  // Gate 1: R:R minimum
  const rrCheck = checkMinRR(candidate);
  if (!rrCheck.allowed) {
    return { allowed: false, gate: "min-rr", reason: rrCheck.reason };
  }

  // Gate 2: Daily loss limit
  const dailyCheck = checkDailyLossLimit(state, options.todayTrades);
  if (!dailyCheck.allowed) {
    return { allowed: false, gate: "daily-loss", reason: dailyCheck.reason };
  }

  return { allowed: true, gate: null, reason: null };
}

export { MIN_RR, DAILY_LOSS_LIMIT_PCT, SIGNAL_PAIRS };
