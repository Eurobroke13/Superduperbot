/**
 * Overbought Entry Strategies A, B, C
 * 
 * Drop-in module for improving entries when `trend-vs-overbought` is present.
 * Integrate into your scan → score → entry pipeline.
 */

// ============================================================
// STRATEGY A — Limit Entry (replace market orders)
// ============================================================
// Instead of market-buying at signal time, place a limit order
// 0.5×ATR below current price. Cancel if not filled in N candles.

/**
 * @param {object} params
 * @param {number} params.currentPrice  - price at signal time
 * @param {number} params.atrVal        - current ATR value
 * @param {string[]} params.signalSet   - signals present
 * @param {number} params.direction     - 'long' or 'short'
 * @param {number} [params.atrOffset=0.5] - how far below (long) or above (short) to place limit
 * @param {number} [params.maxCandlesWait=3] - cancel if not filled within N candles
 * @returns {object} { useLimit, limitPrice, expiryCandles }
 */
function calcLimitEntry({ currentPrice, atrVal, signalSet, direction, atrOffset = 0.5, maxCandlesWait = 3 }) {
  const isOverbought = signalSet.includes('trend-vs-overbought');
  const isOversold   = signalSet.includes('trend-vs-oversold');

  // Only apply limit logic for overbought/oversold setups
  if (!isOverbought && !isOversold) {
    return { useLimit: false, limitPrice: currentPrice, expiryCandles: 0 };
  }

  let limitPrice;
  if (direction === 'long') {
    // Buy below current price
    limitPrice = currentPrice - (atrOffset * atrVal);
  } else {
    // Sell above current price
    limitPrice = currentPrice + (atrOffset * atrVal);
  }

  return {
    useLimit: true,
    limitPrice: Math.round(limitPrice * 1e8) / 1e8, // 8dp precision
    expiryCandles: maxCandlesWait,
  };
}

/**
 * Check if a pending limit order should be cancelled.
 * Call this on each candle tick for pending orders.
 * 
 * @param {object} pendingOrder
 * @param {number} pendingOrder.limitPrice
 * @param {number} pendingOrder.expiryCandles
 * @param {number} pendingOrder.candlesElapsed
 * @param {number} candleLow   - current candle low
 * @param {number} candleHigh  - current candle high
 * @param {string} direction   - 'long' or 'short'
 * @returns {{ filled: boolean, cancel: boolean, fillPrice: number|null }}
 */
function checkLimitFill(pendingOrder, candleLow, candleHigh, direction) {
  const { limitPrice, expiryCandles, candlesElapsed } = pendingOrder;

  // Check fill
  if (direction === 'long' && candleLow <= limitPrice) {
    return { filled: true, cancel: false, fillPrice: limitPrice };
  }
  if (direction === 'short' && candleHigh >= limitPrice) {
    return { filled: true, cancel: false, fillPrice: limitPrice };
  }

  // Check expiry
  if (candlesElapsed >= expiryCandles) {
    return { filled: false, cancel: true, fillPrice: null };
  }

  return { filled: false, cancel: false, fillPrice: null };
}


// ============================================================
// STRATEGY B — EMA Distance Gate (scoring penalty)
// ============================================================
// If price is too far from the EMA midline, the "overbought"
// part dominates. Apply a score penalty or block the trade.

/**
 * @param {object} params
 * @param {number} params.currentPrice
 * @param {number} params.ema21        - 21-period EMA value (or your ribbon midline)
 * @param {number} params.atrVal
 * @param {string[]} params.signalSet
 * @param {string} params.direction
 * @param {number} [params.warningThreshold=1.5]  - ATR multiples: apply penalty
 * @param {number} [params.blockThreshold=2.5]    - ATR multiples: hard block
 * @param {number} [params.scorePenalty=1.5]       - points subtracted from score
 * @returns {{ allow: boolean, adjustedScore: number|null, emaDistance: number, reason: string|null }}
 */
function emaDistanceGate({ 
  currentPrice, 
  ema21, 
  atrVal, 
  signalSet, 
  direction, 
  currentScore,
  warningThreshold = 1.5, 
  blockThreshold = 2.5, 
  scorePenalty = 1.5 
}) {
  const isOverbought = signalSet.includes('trend-vs-overbought');
  const isOversold   = signalSet.includes('trend-vs-oversold');

  // Only gate overbought/oversold setups
  if (!isOverbought && !isOversold) {
    return { allow: true, adjustedScore: currentScore, emaDistance: 0, reason: null };
  }

  // Distance from EMA in ATR multiples
  let emaDistance;
  if (direction === 'long') {
    emaDistance = (currentPrice - ema21) / atrVal;
  } else {
    emaDistance = (ema21 - currentPrice) / atrVal;
  }

  // Negative distance = price is on the wrong side of EMA (already reversing)
  if (emaDistance < 0) {
    return { 
      allow: true, 
      adjustedScore: currentScore, 
      emaDistance, 
      reason: null 
    };
  }

  // Hard block
  if (emaDistance >= blockThreshold) {
    return { 
      allow: false, 
      adjustedScore: null, 
      emaDistance, 
      reason: `ema-distance-block (${emaDistance.toFixed(1)}x ATR > ${blockThreshold}x)` 
    };
  }

  // Score penalty
  if (emaDistance >= warningThreshold) {
    const adjusted = currentScore - scorePenalty;
    return { 
      allow: true, 
      adjustedScore: adjusted, 
      emaDistance, 
      reason: `ema-distance-penalty -${scorePenalty} (${emaDistance.toFixed(1)}x ATR)` 
    };
  }

  return { allow: true, adjustedScore: currentScore, emaDistance, reason: null };
}


// ============================================================
// STRATEGY C — Break-and-Retest Confirmation
// ============================================================
// When signal fires, don't enter immediately.
// Mark the candle high/low, wait for a pullback + reclaim.
// Works in both paper and live mode.

/**
 * Create a pending retest entry when a trend-vs-overbought signal fires.
 * Store this in a `pendingRetests` map in your state.
 * 
 * @param {object} params
 * @param {string} params.symbol
 * @param {string} params.direction
 * @param {number} params.candleHigh     - high of the signal candle
 * @param {number} params.candleLow      - low of the signal candle
 * @param {number} params.candleClose    - close of the signal candle
 * @param {string[]} params.signalSet
 * @param {number} params.score
 * @param {number} params.atrVal
 * @param {number} params.leverage
 * @param {number} [params.maxCandlesWait=3] - expiry window
 * @param {boolean} [params.paperMode=false] - if true, log but don't execute
 * @returns {object|null} pendingRetest entry, or null if not applicable
 */
function createPendingRetest({ 
  symbol, direction, candleHigh, candleLow, candleClose, 
  signalSet, score, atrVal, leverage,
  maxCandlesWait = 3, paperMode = false 
}) {
  const isOverbought = signalSet.includes('trend-vs-overbought');
  const isOversold   = signalSet.includes('trend-vs-oversold');

  if (!isOverbought && !isOversold) return null;

  const candleMid = (candleHigh + candleLow) / 2;

  return {
    symbol,
    direction,
    signalSet: [...signalSet],
    score,
    atrVal,
    leverage,
    paperMode,

    // Key levels
    breakLevel:    direction === 'long' ? candleHigh : candleLow,
    retestLevel:   direction === 'long' ? candleMid  : candleMid,
    
    // State tracking
    phase: 'waiting-for-pullback', // → 'pulled-back' → 'filled' / 'expired'
    candlesElapsed: 0,
    maxCandles: maxCandlesWait,
    pulledBack: false,
    
    createdAt: new Date().toISOString(),
    filledAt: null,
    expiredAt: null,
    fillPrice: null,
  };
}

/**
 * Evaluate a pending retest on each new candle.
 * Call this in your main scan loop for each item in pendingRetests.
 * 
 * @param {object} retest        - the pending retest object
 * @param {number} candleHigh    - new candle high
 * @param {number} candleLow     - new candle low
 * @param {number} candleClose   - new candle close
 * @returns {{ action: 'wait'|'enter'|'cancel', retest: object, entryPrice?: number }}
 */
function evaluateRetest(retest, candleHigh, candleLow, candleClose) {
  retest.candlesElapsed += 1;

  // Check expiry
  if (retest.candlesElapsed > retest.maxCandles) {
    retest.phase = 'expired';
    retest.expiredAt = new Date().toISOString();
    return { action: 'cancel', retest, reason: 'expired' };
  }

  if (retest.direction === 'long') {
    // Phase 1: wait for pullback below midpoint
    if (!retest.pulledBack) {
      if (candleLow <= retest.retestLevel) {
        retest.pulledBack = true;
        retest.phase = 'pulled-back';
      }
      return { action: 'wait', retest };
    }

    // Phase 2: wait for reclaim of the break level
    if (retest.pulledBack) {
      if (candleClose >= retest.breakLevel || candleHigh >= retest.breakLevel) {
        retest.phase = 'filled';
        retest.fillPrice = retest.breakLevel;
        retest.filledAt = new Date().toISOString();
        return { action: 'enter', retest, entryPrice: retest.breakLevel };
      }
    }
  }

  if (retest.direction === 'short') {
    // Phase 1: wait for rally above midpoint
    if (!retest.pulledBack) {
      if (candleHigh >= retest.retestLevel) {
        retest.pulledBack = true;
        retest.phase = 'pulled-back';
      }
      return { action: 'wait', retest };
    }

    // Phase 2: wait for break below the break level
    if (retest.pulledBack) {
      if (candleClose <= retest.breakLevel || candleLow <= retest.breakLevel) {
        retest.phase = 'filled';
        retest.fillPrice = retest.breakLevel;
        retest.filledAt = new Date().toISOString();
        return { action: 'enter', retest, entryPrice: retest.breakLevel };
      }
    }
  }

  return { action: 'wait', retest };
}


// ============================================================
// INTEGRATION HELPER — Patch into your scan loop
// ============================================================

/**
 * Full pre-entry filter combining A + B + C.
 * Call this after scoring, before order submission.
 * 
 * @param {object} candidate - your scored candidate with all fields
 * @param {object} marketData - { currentPrice, ema21, candleHigh, candleLow, candleClose }
 * @param {Map} pendingRetests - your state.pendingRetests map
 * @param {object} [config] - override thresholds
 * @returns {{ action: 'enter-market'|'enter-limit'|'defer-retest'|'block', details: object }}
 */
function overboughtEntryFilter(candidate, marketData, pendingRetests, config = {}) {
  const {
    symbol, direction, signalSet, score, atrVal, leverage
  } = candidate;

  const {
    currentPrice, ema21, candleHigh, candleLow, candleClose
  } = marketData;

  const {
    enableA = true,  // limit orders
    enableB = true,  // EMA distance gate
    enableC = true,  // break-and-retest
    paperMode = false,
  } = config;

  const isOverboughtSetup = signalSet.includes('trend-vs-overbought') 
                         || signalSet.includes('trend-vs-oversold');

  // Not an overbought setup → proceed normally
  if (!isOverboughtSetup) {
    return { action: 'enter-market', details: { reason: 'not-overbought-setup' } };
  }

  // --- Strategy B: EMA distance check first (might block entirely) ---
  if (enableB) {
    const gateResult = emaDistanceGate({
      currentPrice, ema21, atrVal, signalSet, direction, currentScore: score,
      ...config.emaGate,
    });

    if (!gateResult.allow) {
      return { 
        action: 'block', 
        details: { 
          reason: gateResult.reason, 
          emaDistance: gateResult.emaDistance 
        } 
      };
    }

    // Apply score penalty (may push below threshold)
    if (gateResult.adjustedScore !== score) {
      candidate.score = gateResult.adjustedScore;
      candidate._emaDistancePenalty = gateResult.reason;
    }
  }

  // --- Strategy C: Defer to break-and-retest ---
  if (enableC) {
    const retest = createPendingRetest({
      symbol, direction, candleHigh, candleLow, candleClose,
      signalSet, score: candidate.score, atrVal, leverage,
      paperMode,
      ...config.retest,
    });

    if (retest) {
      pendingRetests.set(symbol, retest);
      return { 
        action: 'defer-retest', 
        details: { 
          breakLevel: retest.breakLevel, 
          retestLevel: retest.retestLevel,
          maxCandles: retest.maxCandles,
        } 
      };
    }
  }

  // --- Strategy A: Limit entry fallback (if C is disabled) ---
  if (enableA) {
    const limitResult = calcLimitEntry({
      currentPrice, atrVal, signalSet, direction,
      ...config.limitEntry,
    });

    if (limitResult.useLimit) {
      return { 
        action: 'enter-limit', 
        details: { 
          limitPrice: limitResult.limitPrice, 
          expiryCandles: limitResult.expiryCandles 
        } 
      };
    }
  }

  return { action: 'enter-market', details: { reason: 'all-strategies-disabled' } };
}


// ============================================================
// PAPER TRADE LOGGER — For testing C before going live
// ============================================================

/**
 * Log paper results alongside live results for A/B comparison.
 * Append to a paperTrades array in state.
 * 
 * @param {object} retest - the filled retest object
 * @param {object} outcome - { exitPrice, exitReason, exitTime }
 * @param {number} atrVal
 * @returns {object} paper trade record
 */
function logPaperTrade(retest, outcome, atrVal) {
  const { fillPrice, direction, symbol, score, leverage } = retest;
  const { exitPrice, exitReason, exitTime } = outcome;

  let pnlPct;
  if (direction === 'long') {
    pnlPct = ((exitPrice - fillPrice) / fillPrice) * 100 * leverage;
  } else {
    pnlPct = ((fillPrice - exitPrice) / fillPrice) * 100 * leverage;
  }

  return {
    symbol,
    direction,
    score,
    leverage,
    entryPrice: fillPrice,
    exitPrice,
    exitReason,
    pnlPct: Math.round(pnlPct * 100) / 100,
    entryType: 'break-and-retest',
    signalCandle: retest.createdAt,
    filledAt: retest.filledAt,
    exitTime,
    candlesWaited: retest.candlesElapsed,
    // Compare field: what would the immediate entry have produced?
    immediateEntryPrice: null, // fill this from your live trade on the same signal
  };
}


// ============================================================
// EXPORTS
// ============================================================

export {
  // Strategy A
  calcLimitEntry,
  checkLimitFill,

  // Strategy B
  emaDistanceGate,

  // Strategy C
  createPendingRetest,
  evaluateRetest,

  // Combined filter
  overboughtEntryFilter,

  // Paper testing
  logPaperTrade,
};
