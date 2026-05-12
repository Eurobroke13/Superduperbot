/**
 * Selective Limit Entry Engine
 * 
 * Uses limit orders ONLY when the setup suggests chasing risk.
 * Most trades still enter at market — limits are reserved for
 * conditions where price is extended and a pullback is likely.
 * 
 * Backtest showed universal limits miss 24% of trades (mostly winners)
 * and cut PnL by 57%. Selective application preserves momentum entries.
 */

// ============================================================
// CONFIGURATION
// ============================================================

/**
 * Per-setup-type limit order profiles.
 * 
 * atrOffset:    how far from current price to place the limit (in ATR multiples)
 * maxCandles:   cancel if not filled within N candles
 * aggressive:   if true, use tighter offset (for setups where speed matters)
 * 
 * Rationale for each:
 * - trend:          price is moving, but real trends pull back. Wait for it.
 * - mean-reversion: already at an extreme, tighter offset — don't miss the reversal.
 * - breakout:       place limit at breakout level for a retest fill.
 * - liquidity-trap: similar to breakout, price should retest the trap level.
 * - unknown:        conservative default.
 */
const SETUP_PROFILES = {
  'trend': {
    atrOffset: 0.5,
    maxCandles: 3,
    aggressive: false,
  },
  'mean-reversion': {
    atrOffset: 0.25,
    maxCandles: 2,
    aggressive: true,
  },
  'breakout': {
    atrOffset: 0.4,
    maxCandles: 2,
    aggressive: false,
  },
  'liquidity-trap': {
    atrOffset: 0.4,
    maxCandles: 3,
    aggressive: false,
  },
  'unknown': {
    atrOffset: 0.35,
    maxCandles: 3,
    aggressive: false,
  },
};

/**
 * Score-based offset adjustment.
 * Higher score = more confident = tighter offset (closer to market price).
 * Lower score = less confident = wider offset (demand a better price).
 */
const SCORE_ADJUSTMENTS = {
  // score >= threshold → multiply atrOffset by this factor
  tiers: [
    { minScore: 8.0, factor: 0.6 },   // high conviction: tighter limit
    { minScore: 6.5, factor: 0.8 },   // moderate conviction
    { minScore: 5.0, factor: 1.0 },   // baseline
    { minScore: 0.0, factor: 1.3 },   // low conviction: demand better price
  ],
};

/**
 * Signal-based modifiers.
 * Certain signals suggest price is more/less likely to pull back.
 */
const SIGNAL_MODIFIERS = {
  // Signals that suggest price is extended → widen offset (demand more pullback)
  widen: {
    'trend-vs-overbought': 1.3,
    'trend-vs-oversold':   1.3,
    'rsi-overbought':      1.2,
    'rsi-oversold':        1.2,
    'bb-overbought':       1.2,
    'bb-oversold':         1.2,
    'fisher-overbought':   1.1,
    'fisher-oversold':     1.1,
  },

  // Signals that suggest strong momentum → tighten offset (price may not pull back much)
  tighten: {
    'volume':              0.85,
    'volume-confirm':      0.85,
    'adx-strong-bull':     0.8,
    'adx-strong-bear':     0.8,
    '4h-bb-expansion-bull': 0.9,
    '4h-bb-expansion-bear': 0.9,
  },
};


// ============================================================
// CORE FUNCTIONS
// ============================================================

/**
 * Determine whether this candidate should use a limit entry or market entry.
 * This is the gate — most trades pass through as market orders.
 * Limits only apply when chasing risk is high.
 * 
 * @param {object} params
 * @param {string} params.direction
 * @param {string} params.setupType
 * @param {number} params.score
 * @param {string[]} params.signalSet
 * @param {number} params.currentPrice
 * @param {number} params.ema21         - 21-period EMA (or ribbon midline)
 * @param {number} params.atrVal
 * @returns {{ useLimit: boolean, reason: string }}
 */
function shouldUseLimit({ signalSet }) {
  const overbought = signalSet.includes('trend-vs-overbought');
  const oversold = signalSet.includes('trend-vs-oversold');

  if (overbought || oversold) {
    return { useLimit: true, reason: 'overbought/oversold - demand pullback' };
  }

  return { useLimit: false, reason: 'default market entry' };
}

/**
 * Calculate the limit price for a candidate that shouldUseLimit() approved.
 * Only call this AFTER shouldUseLimit returns useLimit: true.
 * 
 * @param {object} params
 * @param {number} params.currentPrice
 * @param {number} params.atrVal
 * @param {string} params.direction     - 'long' or 'short'
 * @param {string} params.setupType     - 'trend', 'mean-reversion', 'breakout', etc.
 * @param {number} params.score
 * @param {string[]} params.signalSet
 * @param {object} [params.overrides]   - { atrOffset, maxCandles } to force specific values
 * @returns {object} { limitPrice, atrOffset, maxCandles, adjustments[] }
 */
function calcLimitPrice({ currentPrice, atrVal, direction, setupType, score, signalSet, overrides = {} }) {

  // 1. Get base profile for this setup type
  const profile = SETUP_PROFILES[setupType] || SETUP_PROFILES['unknown'];
  let atrOffset = overrides.atrOffset ?? profile.atrOffset;
  let maxCandles = overrides.maxCandles ?? profile.maxCandles;
  const adjustments = [];

  // 2. Apply score adjustment
  const scoreTier = SCORE_ADJUSTMENTS.tiers.find(t => score >= t.minScore);
  if (scoreTier && scoreTier.factor !== 1.0) {
    atrOffset *= scoreTier.factor;
    adjustments.push(`score ${score.toFixed(1)} → offset ×${scoreTier.factor}`);
  }

  // 3. Apply signal modifiers
  let signalFactor = 1.0;
  for (const signal of signalSet) {
    if (SIGNAL_MODIFIERS.widen[signal]) {
      signalFactor *= SIGNAL_MODIFIERS.widen[signal];
      adjustments.push(`${signal} → widen ×${SIGNAL_MODIFIERS.widen[signal]}`);
    }
    if (SIGNAL_MODIFIERS.tighten[signal]) {
      signalFactor *= SIGNAL_MODIFIERS.tighten[signal];
      adjustments.push(`${signal} → tighten ×${SIGNAL_MODIFIERS.tighten[signal]}`);
    }
  }
  atrOffset *= signalFactor;

  // 4. Clamp offset to sensible range (0.1 – 1.5 ATR)
  atrOffset = Math.max(0.1, Math.min(1.5, atrOffset));

  // 5. Calculate limit price
  let limitPrice;
  if (direction === 'long') {
    limitPrice = currentPrice - (atrOffset * atrVal);
  } else {
    limitPrice = currentPrice + (atrOffset * atrVal);
  }

  // 6. Ensure limit doesn't cross current price (sanity check)
  if (direction === 'long' && limitPrice >= currentPrice) {
    limitPrice = currentPrice - (0.1 * atrVal);
  }
  if (direction === 'short' && limitPrice <= currentPrice) {
    limitPrice = currentPrice + (0.1 * atrVal);
  }

  return {
    limitPrice: roundPrice(limitPrice),
    currentPrice,
    atrOffset: Math.round(atrOffset * 1000) / 1000,
    maxCandles,
    direction,
    setupType,
    adjustments,
    // How much better this entry is vs market, in % terms
    improvement: Math.abs(currentPrice - limitPrice) / currentPrice * 100,
  };
}


// ============================================================
// PENDING ORDER MANAGEMENT
// ============================================================

/**
 * Create a pending limit order and store in state.
 * 
 * @param {object} candidate  - scored trade candidate
 * @param {object} limitCalc  - output from calcLimitPrice()
 * @returns {object} pending order to store in state.pendingLimits
 */
function createPendingLimit(candidate, limitCalc) {
  return {
    symbol: candidate.symbol,
    direction: limitCalc.direction,
    limitPrice: limitCalc.limitPrice,
    maxCandles: limitCalc.maxCandles,
    candlesElapsed: 0,

    // Preserve original candidate data for execution
    score: candidate.score,
    setupType: limitCalc.setupType,
    signalSet: [...candidate.signalSet],
    leverage: candidate.leverage,
    atrVal: candidate.atrVal,
    notional: candidate.notional || null,
    size: candidate.size || null,

    // Tracking
    createdAt: new Date().toISOString(),
    marketPriceAtSignal: limitCalc.currentPrice,
    improvement: limitCalc.improvement,
    adjustments: limitCalc.adjustments,
    status: 'pending',  // 'pending' → 'filled' | 'cancelled'
    filledAt: null,
    cancelledAt: null,
  };
}

/**
 * Tick a pending limit order against new candle data.
 * Call this in your main loop for each pending order.
 * 
 * @param {object} pending     - pending limit order
 * @param {object} candle      - { high, low, close, time }
 * @returns {{ action: 'wait'|'fill'|'cancel', pending: object }}
 */
function tickPendingLimit(pending, candle) {
  pending.candlesElapsed += 1;

  // Check fill
  if (pending.direction === 'long' && candle.low <= pending.limitPrice) {
    pending.status = 'filled';
    pending.filledAt = candle.time || new Date().toISOString();
    return { action: 'fill', pending, fillPrice: pending.limitPrice };
  }

  if (pending.direction === 'short' && candle.high >= pending.limitPrice) {
    pending.status = 'filled';
    pending.filledAt = candle.time || new Date().toISOString();
    return { action: 'fill', pending, fillPrice: pending.limitPrice };
  }

  // Check expiry
  if (pending.candlesElapsed >= pending.maxCandles) {
    pending.status = 'cancelled';
    pending.cancelledAt = candle.time || new Date().toISOString();
    return { action: 'cancel', pending, reason: 'expired' };
  }

  return { action: 'wait', pending };
}

/**
 * Cancel a pending limit if the setup invalidates.
 * Call this if signals flip or a conflicting position opens.
 * 
 * @param {object} pending
 * @param {string} reason
 * @returns {object} updated pending order
 */
function cancelPendingLimit(pending, reason = 'invalidated') {
  pending.status = 'cancelled';
  pending.cancelledAt = new Date().toISOString();
  pending.cancelReason = reason;
  return pending;
}


// ============================================================
// EXECUTION BRIDGE
// ============================================================

/**
 * Convert a filled pending limit into the order params your 
 * exchange execution function expects.
 * Adapt the field names to match your exchange module.
 * 
 * @param {object} filled - the filled pending limit order
 * @returns {object} order params ready for your exchange API
 */
function toOrderParams(filled) {
  return {
    symbol: filled.symbol,
    side: filled.direction === 'long' ? 'buy' : 'sell',
    type: 'limit',
    price: filled.limitPrice,
    leverage: filled.leverage,
    size: filled.size,
    notional: filled.notional,

    // Metadata for your trade record
    _entryType: 'limit',
    _marketPriceAtSignal: filled.marketPriceAtSignal,
    _improvement: filled.improvement,
    _setupType: filled.setupType,
    _score: filled.score,
    _candlesWaited: filled.candlesElapsed,
  };
}


// ============================================================
// ANALYTICS — Compare limit vs market fills
// ============================================================

/**
 * After a limit fill, calculate how much the limit entry 
 * improved the trade vs a hypothetical market entry.
 * Store this in your trade journal for ongoing analysis.
 * 
 * @param {object} filled    - the filled pending limit
 * @param {number} exitPrice - eventual exit price
 * @param {number} leverage
 * @returns {object} comparison metrics
 */
function calcImprovement(filled, exitPrice, leverage) {
  const { limitPrice, marketPriceAtSignal, direction } = filled;

  let marketPnlPct, limitPnlPct;

  if (direction === 'long') {
    marketPnlPct = ((exitPrice - marketPriceAtSignal) / marketPriceAtSignal) * 100 * leverage;
    limitPnlPct  = ((exitPrice - limitPrice) / limitPrice) * 100 * leverage;
  } else {
    marketPnlPct = ((marketPriceAtSignal - exitPrice) / marketPriceAtSignal) * 100 * leverage;
    limitPnlPct  = ((limitPrice - exitPrice) / limitPrice) * 100 * leverage;
  }

  return {
    marketEntryPnlPct: Math.round(marketPnlPct * 100) / 100,
    limitEntryPnlPct: Math.round(limitPnlPct * 100) / 100,
    improvementPct: Math.round((limitPnlPct - marketPnlPct) * 100) / 100,
    entryImprovement: Math.abs(limitPrice - marketPriceAtSignal),
    candlesWaited: filled.candlesElapsed,
  };
}

/**
 * Backtest limit entries against historical trades.
 * For each trade, simulates whether a limit order would have filled
 * within the candle window and compares PnL.
 * 
 * @param {object[]} trades     - historical trades with entryPrice, exitPrice, etc.
 * @param {object[]} candles    - OHLC candles keyed by symbol+time (you provide the lookup)
 * @param {function} getCandlesFn - (symbol, startTime, count) => candle[]
 * @returns {object} { improved, missed, avgImprovement }
 */
function backtestLimitEntries(trades, getCandlesFn) {
  const results = { improved: 0, missed: 0, total: 0, totalImprovement: 0 };

  for (const trade of trades) {
    const limitCalc = calcLimitPrice({
      currentPrice: trade.entryPrice,
      atrVal: trade.atrVal || 0,
      direction: trade.direction,
      setupType: trade.setupType || 'unknown',
      score: trade.score || 5,
      signalSet: trade.signalSet || trade.reasons || [],
    });

    // Get candles after entry to check if limit would have filled
    const candles = getCandlesFn(trade.symbol, trade.openedAt, limitCalc.maxCandles);
    if (!candles || candles.length === 0) continue;

    results.total++;

    let wouldHaveFilled = false;
    for (const candle of candles) {
      if (trade.direction === 'long' && candle.low <= limitCalc.limitPrice) {
        wouldHaveFilled = true;
        break;
      }
      if (trade.direction === 'short' && candle.high >= limitCalc.limitPrice) {
        wouldHaveFilled = true;
        break;
      }
    }

    if (wouldHaveFilled) {
      results.improved++;
      results.totalImprovement += limitCalc.improvement;
    } else {
      results.missed++;
    }
  }

  results.avgImprovement = results.improved > 0
    ? Math.round(results.totalImprovement / results.improved * 100) / 100
    : 0;

  results.fillRate = results.total > 0
    ? Math.round(results.improved / results.total * 100)
    : 0;

  return results;
}


// ============================================================
// UTILS
// ============================================================

function roundPrice(price) {
  // Adaptive precision: more decimals for smaller prices
  if (price < 0.0001)  return Math.round(price * 1e10) / 1e10;
  if (price < 0.01)    return Math.round(price * 1e8) / 1e8;
  if (price < 1)       return Math.round(price * 1e6) / 1e6;
  if (price < 100)     return Math.round(price * 1e4) / 1e4;
  return Math.round(price * 100) / 100;
}


// ============================================================
// CONVENIENCE — Single call for your entry pipeline
// ============================================================

/**
 * One-call entry decision. Returns either a market or limit instruction.
 * Wire this into your pipeline as the single replacement for market orders.
 * 
 * @param {object} candidate - scored candidate with all fields
 * @param {object} marketData - { currentPrice, ema21 }
 * @returns {{ type: 'market'|'limit', reason: string, limitPrice?: number, maxCandles?: number, improvement?: number }}
 */
function decideEntry(candidate, marketData) {
  const { setupType, score, signalSet, atrVal } = candidate;
  const direction = candidate.direction || candidate.signal;
  const { currentPrice, ema21 } = marketData;

  const decision = shouldUseLimit({ 
    direction, setupType, score, signalSet, currentPrice, ema21, atrVal 
  });

  if (!decision.useLimit) {
    return { type: 'market', reason: decision.reason };
  }

  const limit = calcLimitPrice({ 
    currentPrice, atrVal, direction, setupType, score, signalSet 
  });

  return {
    ...limit,
    type: 'limit',
    reason: decision.reason,
  };
}


// ============================================================
// EXPORTS
// ============================================================

export {
  // Config
  SETUP_PROFILES,
  SCORE_ADJUSTMENTS,
  SIGNAL_MODIFIERS,

  // Core
  shouldUseLimit,
  calcLimitPrice,
  decideEntry,

  // Order management
  createPendingLimit,
  tickPendingLimit,
  cancelPendingLimit,

  // Execution
  toOrderParams,

  // Analytics
  calcImprovement,
  backtestLimitEntries,
};
