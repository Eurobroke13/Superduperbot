/**
 * Sophisticated Limit Entry Strategies
 * 
 * Two approaches that NEVER miss trades but still capture better entries:
 * 
 * 1. DECAYING LIMIT — offset shrinks each candle, converges to market.
 *    You always get filled, just at the best price the market offers
 *    within the window.
 * 
 * 2. SPLIT ENTRY — immediate market fill for base size, limit order
 *    for the remainder at a pullback level. Worst case you're in 
 *    at 60% size. Best case your avg entry improves significantly.
 * 
 * Both solve the core problem: static limits miss 24% of winners.
 * These miss 0%.
 */


// ============================================================
// APPROACH 1 — DECAYING LIMIT
// ============================================================
// 
// Candle 0 (signal fires): place limit at price - 0.5 ATR
// Candle 1:                 move limit to price - 0.3 ATR  
// Candle 2:                 move limit to price - 0.1 ATR
// Candle 3:                 convert to market order (guaranteed fill)
//
// The decay schedule is configurable per setup type.
// Net effect: you give the market 3 candles to pull back.
// If it does, you got a better entry. If it doesn't, you 
// enter at market anyway — identical to the current system.

const DECAY_SCHEDULES = {
  // Setup-specific decay curves (ATR multiples per candle)
  // Last entry is always 0 (= market order)
  'trend-vs-overbought': {
    offsets: [0.5, 0.3, 0.15, 0],    // 4 candles, aggressive start
    description: 'extended move, demand pullback then relax',
  },
  'trend-vs-oversold': {
    offsets: [0.5, 0.3, 0.15, 0],
    description: 'extended move (short side)',
  },
  'trend': {
    offsets: [0.3, 0.15, 0],          // 3 candles, moderate
    description: 'trending but give it a candle to breathe',
  },
  'mean-reversion': {
    offsets: [0.15, 0],               // 2 candles, tight — don't miss reversals
    description: 'already at extreme, minimal delay',
  },
  'breakout': {
    offsets: [0.25, 0.1, 0],          // 3 candles, wait for retest
    description: 'breakout retest pattern',
  },
  'default': {
    offsets: [0.2, 0.1, 0],           // 3 candles, conservative
    description: 'generic fallback',
  },
};

/**
 * Create a decaying limit order.
 * 
 * @param {object} params
 * @param {string} params.symbol
 * @param {string} params.direction
 * @param {number} params.currentPrice   - price at signal time
 * @param {number} params.atrVal
 * @param {string} params.setupType
 * @param {string[]} params.signalSet
 * @param {number} params.score
 * @param {number} params.leverage
 * @param {number} params.size
 * @param {number} params.notional
 * @returns {object} decaying limit order to store in state
 */
function createDecayingLimit({
  symbol, direction, currentPrice, atrVal, setupType, 
  signalSet, score, leverage, size, notional
}) {
  // Pick decay schedule
  let scheduleKey = 'default';
  if (signalSet.includes('trend-vs-overbought')) scheduleKey = 'trend-vs-overbought';
  else if (signalSet.includes('trend-vs-oversold')) scheduleKey = 'trend-vs-oversold';
  else if (DECAY_SCHEDULES[setupType]) scheduleKey = setupType;

  const schedule = DECAY_SCHEDULES[scheduleKey];
  const initialOffset = schedule.offsets[0];

  // Calculate initial limit price
  let limitPrice;
  if (direction === 'long') {
    limitPrice = currentPrice - (initialOffset * atrVal);
  } else {
    limitPrice = currentPrice + (initialOffset * atrVal);
  }

  return {
    symbol,
    direction,
    atrVal,
    setupType,
    signalSet: [...signalSet],
    score,
    leverage,
    size,
    notional,

    // Decay state
    scheduleKey,
    offsets: [...schedule.offsets],
    currentStep: 0,
    limitPrice: roundPrice(limitPrice),
    marketPriceAtSignal: currentPrice,

    // Tracking
    status: 'active',  // 'active' → 'filled'
    createdAt: new Date().toISOString(),
    filledAt: null,
    fillPrice: null,
    fillType: null,     // 'limit' or 'market' (if decayed to 0)
  };
}

/**
 * Tick a decaying limit against new candle data.
 * Call each candle for every active decaying order.
 * 
 * @param {object} order  - the decaying limit order
 * @param {object} candle - { high, low, close, time }
 * @param {number} currentPrice - latest price (for market conversion)
 * @returns {{ action: 'wait'|'fill-limit'|'fill-market', order, fillPrice? }}
 */
function tickDecayingLimit(order, candle, currentPrice) {
  const { direction, offsets, atrVal } = order;

  // Check if current limit fills on this candle
  if (direction === 'long' && candle.low <= order.limitPrice) {
    order.status = 'filled';
    order.fillPrice = order.limitPrice;
    order.fillType = 'limit';
    order.filledAt = candle.time || new Date().toISOString();
    return { action: 'fill-limit', order, fillPrice: order.limitPrice };
  }
  if (direction === 'short' && candle.high >= order.limitPrice) {
    order.status = 'filled';
    order.fillPrice = order.limitPrice;
    order.fillType = 'limit';
    order.filledAt = candle.time || new Date().toISOString();
    return { action: 'fill-limit', order, fillPrice: order.limitPrice };
  }

  // Move to next step in decay schedule
  order.currentStep += 1;

  // If we've exhausted the schedule, convert to market
  if (order.currentStep >= offsets.length || offsets[order.currentStep] === 0) {
    order.status = 'filled';
    order.fillPrice = currentPrice;
    order.fillType = 'market';
    order.filledAt = candle.time || new Date().toISOString();
    return { action: 'fill-market', order, fillPrice: currentPrice };
  }

  // Update limit price to decayed offset
  const newOffset = offsets[order.currentStep];
  if (direction === 'long') {
    order.limitPrice = roundPrice(currentPrice - (newOffset * atrVal));
  } else {
    order.limitPrice = roundPrice(currentPrice + (newOffset * atrVal));
  }

  return { action: 'wait', order };
}


// ============================================================
// APPROACH 2 — SPLIT ENTRY
// ============================================================
//
// Enter immediately at market with 60% of planned size.
// Place limit order for remaining 40% at a pullback level.
// If limit fills → avg entry improves.
// If limit expires → you're in at 60%, which still captures the move.
//
// This maps naturally onto your existing tranche system:
// Tranche 1 = market (immediate), Tranche 2 = limit (pullback).

const SPLIT_CONFIG = {
  // What fraction enters immediately at market
  immediatePct: 0.6,

  // Limit order for the remainder
  limitPct: 0.4,

  // How far below (long) or above (short) to place the limit
  // This is per-setup-type, in ATR multiples
  limitOffsets: {
    'trend-vs-overbought': 0.6,   // extended — demand more pullback
    'trend-vs-oversold':   0.6,
    'trend':               0.35,
    'mean-reversion':      0.2,
    'breakout':            0.3,
    'default':             0.3,
  },

  // Cancel the limit portion if not filled within N candles
  maxCandles: 4,
};

/**
 * Create a split entry: immediate market + deferred limit.
 * 
 * @param {object} params - same as createDecayingLimit
 * @param {object} [config] - override SPLIT_CONFIG
 * @returns {{ immediate: object, deferred: object }}
 */
function createSplitEntry({
  symbol, direction, currentPrice, atrVal, setupType,
  signalSet, score, leverage, size, notional
}, config = {}) {
  const cfg = { ...SPLIT_CONFIG, ...config };

  // Determine offset
  let offsetKey = 'default';
  if (signalSet.includes('trend-vs-overbought')) offsetKey = 'trend-vs-overbought';
  else if (signalSet.includes('trend-vs-oversold')) offsetKey = 'trend-vs-oversold';
  else if (cfg.limitOffsets[setupType]) offsetKey = setupType;
  const atrOffset = cfg.limitOffsets[offsetKey];

  // Calculate sizes
  const immediateSize = size * cfg.immediatePct;
  const deferredSize  = size * cfg.limitPct;
  const immediateNotional = notional * cfg.immediatePct;
  const deferredNotional  = notional * cfg.limitPct;

  // Calculate limit price for deferred portion
  let limitPrice;
  if (direction === 'long') {
    limitPrice = currentPrice - (atrOffset * atrVal);
  } else {
    limitPrice = currentPrice + (atrOffset * atrVal);
  }

  return {
    // Execute this immediately as a market order
    immediate: {
      symbol,
      direction,
      size: immediateSize,
      notional: immediateNotional,
      leverage,
      type: 'market',
      price: currentPrice,
    },

    // Store this and check each candle
    deferred: {
      symbol,
      direction,
      size: deferredSize,
      notional: deferredNotional,
      leverage,
      limitPrice: roundPrice(limitPrice),
      atrOffset,
      maxCandles: cfg.maxCandles,
      candlesElapsed: 0,

      // Tracking
      status: 'pending',  // 'pending' → 'filled' | 'cancelled'
      createdAt: new Date().toISOString(),
      marketPriceAtSignal: currentPrice,
      filledAt: null,
      cancelledAt: null,
    },
  };
}

/**
 * Tick the deferred portion of a split entry.
 * 
 * @param {object} deferred - the deferred limit order
 * @param {object} candle   - { high, low, close, time }
 * @returns {{ action: 'wait'|'fill'|'cancel', deferred, fillPrice? }}
 */
function tickDeferredLimit(deferred, candle) {
  deferred.candlesElapsed += 1;

  // Check fill
  if (deferred.direction === 'long' && candle.low <= deferred.limitPrice) {
    deferred.status = 'filled';
    deferred.filledAt = candle.time || new Date().toISOString();
    return { action: 'fill', deferred, fillPrice: deferred.limitPrice };
  }
  if (deferred.direction === 'short' && candle.high >= deferred.limitPrice) {
    deferred.status = 'filled';
    deferred.filledAt = candle.time || new Date().toISOString();
    return { action: 'fill', deferred, fillPrice: deferred.limitPrice };
  }

  // Check expiry
  if (deferred.candlesElapsed >= deferred.maxCandles) {
    deferred.status = 'cancelled';
    deferred.cancelledAt = candle.time || new Date().toISOString();
    return { action: 'cancel', deferred, reason: 'expired — running at 60% size' };
  }

  return { action: 'wait', deferred };
}


// ============================================================
// DECISION HELPER — Which approach to use when
// ============================================================

/**
 * Recommend which entry approach to use for a given candidate.
 * 
 * Logic:
 * - Overbought/oversold → DECAYING LIMIT (full patience, guaranteed fill)
 * - High score + momentum → MARKET (don't delay, the signal is the edge)
 * - Everything else → SPLIT ENTRY (hedge your bets)
 * 
 * @param {object} candidate
 * @returns {{ approach: 'market'|'decaying-limit'|'split', reason: string }}
 */
function recommendApproach(candidate) {
  const { signalSet, score, setupType } = candidate;

  const isOverbought = signalSet.includes('trend-vs-overbought') 
                    || signalSet.includes('trend-vs-oversold');

  const hasMomentum = signalSet.some(s =>
    ['volume', 'volume-confirm', 'adx-strong-bull', 'adx-strong-bear',
     '4h-bb-expansion-bull', '4h-bb-expansion-bear'].includes(s)
  );

  // Overbought setups: use decaying limit (most patience)
  if (isOverbought) {
    return { 
      approach: 'decaying-limit', 
      reason: 'overbought/oversold — decay toward market over 3-4 candles' 
    };
  }

  // High conviction + momentum: just market enter
  if (score >= 7.0 && hasMomentum) {
    return { 
      approach: 'market', 
      reason: `score ${score.toFixed(1)} + momentum — signal IS the edge` 
    };
  }

  // Mean reversion: market enter (timing is critical, don't delay)
  if (setupType === 'mean-reversion') {
    return { 
      approach: 'market', 
      reason: 'mean-reversion — timing-sensitive, enter now' 
    };
  }

  // Everything else: split entry (60% market + 40% limit)
  return { 
    approach: 'split', 
    reason: 'moderate conviction — split 60/40 market/limit' 
  };
}


// ============================================================
// ANALYTICS
// ============================================================

/**
 * Calculate entry improvement for a filled decaying limit.
 * 
 * @param {object} order - filled decaying limit order
 * @returns {object} { savedPct, fillType, candlesWaited }
 */
function calcDecayImprovement(order) {
  const { fillPrice, marketPriceAtSignal, direction, leverage, currentStep } = order;

  let savedPct;
  if (direction === 'long') {
    savedPct = ((marketPriceAtSignal - fillPrice) / marketPriceAtSignal) * 100 * leverage;
  } else {
    savedPct = ((fillPrice - marketPriceAtSignal) / marketPriceAtSignal) * 100 * leverage;
  }

  return {
    savedPct: Math.round(savedPct * 100) / 100,
    fillType: order.fillType,
    candlesWaited: currentStep,
    // Negative savedPct means market would have been better (price moved favorably)
    wasWorthWaiting: savedPct > 0,
  };
}

/**
 * Calculate entry improvement for a filled split entry.
 * Compare blended avg entry vs pure market entry.
 * 
 * @param {number} marketFillPrice    - price of the immediate 60%
 * @param {number} limitFillPrice     - price of the deferred 40% (null if cancelled)
 * @param {number} immediatePct       - 0.6
 * @param {string} direction
 * @returns {object} { avgEntry, improvement }
 */
function calcSplitImprovement(marketFillPrice, limitFillPrice, immediatePct, direction) {
  if (!limitFillPrice) {
    // Limit didn't fill, running at reduced size
    return { 
      avgEntry: marketFillPrice, 
      improvementPct: 0, 
      limitFilled: false,
      effectiveSize: immediatePct,
    };
  }

  const limitPct = 1 - immediatePct;
  const avgEntry = (marketFillPrice * immediatePct) + (limitFillPrice * limitPct);

  let improvementPct;
  if (direction === 'long') {
    improvementPct = ((marketFillPrice - avgEntry) / marketFillPrice) * 100;
  } else {
    improvementPct = ((avgEntry - marketFillPrice) / marketFillPrice) * 100;
  }

  return {
    avgEntry: roundPrice(avgEntry),
    improvementPct: Math.round(improvementPct * 100) / 100,
    limitFilled: true,
    effectiveSize: 1.0,
  };
}


// ============================================================
// UTILS
// ============================================================

function roundPrice(price) {
  if (price < 0.0001)  return Math.round(price * 1e10) / 1e10;
  if (price < 0.01)    return Math.round(price * 1e8) / 1e8;
  if (price < 1)       return Math.round(price * 1e6) / 1e6;
  if (price < 100)     return Math.round(price * 1e4) / 1e4;
  return Math.round(price * 100) / 100;
}


// ============================================================
// EXPORTS
// ============================================================

export {
  // Approach 1: Decaying Limit
  DECAY_SCHEDULES,
  createDecayingLimit,
  tickDecayingLimit,

  // Approach 2: Split Entry
  SPLIT_CONFIG,
  createSplitEntry,
  tickDeferredLimit,

  // Decision
  recommendApproach,

  // Analytics
  calcDecayImprovement,
  calcSplitImprovement,
};
