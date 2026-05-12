/**
 * Symbol Cooldown Manager
 * 
 * Prevents re-entering the same symbol after a take-profit.
 * Logic: after TP the move is exhausted — re-entering is chasing.
 * After a stop-loss the thesis may still be valid (use entry strategies A/B/C).
 * 
 * Flat 4h cooldown, snapped to the next 4h candle close.
 * 
 * Add `state.cooldowns = {}` to your persisted state.
 */

// ============================================================
// CONFIGURATION
// ============================================================

const DEFAULT_CONFIG = {
  // Cooldown duration after a take-profit (milliseconds)
  cooldownMs: 4 * 60 * 60 * 1000,  // 4 hours

  // If true, align expiry to next 4h candle close instead of raw timer
  snapTo4hCandle: true,

  // Apply cooldown on these exit reasons — take-profits and partials.
  // After TP the move is done, re-entering is chasing.
  // Stop-losses are NOT included: the thesis may still be valid.
  triggerReasons: ['take-profit-full', 'take-profit-hit', 'partial-tp1-2xATR', 'partial-tp2-3.5xATR'],
};


// ============================================================
// CORE FUNCTIONS
// ============================================================

/**
 * Get the next 4h candle boundary from a given timestamp.
 * 4h candles start at 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC.
 * 
 * @param {number} timestampMs 
 * @returns {number} next 4h boundary in ms
 */
function next4hBoundary(timestampMs) {
  const date = new Date(timestampMs);
  const hour = date.getUTCHours();
  const next4h = Math.ceil((hour + 1) / 4) * 4;

  const boundary = new Date(date);
  boundary.setUTCHours(next4h >= 24 ? 0 : next4h, 0, 0, 0);
  if (next4h >= 24) {
    boundary.setUTCDate(boundary.getUTCDate() + 1);
  }
  return boundary.getTime();
}

/**
 * Register a trade exit and apply cooldown if it was a take-profit.
 * Call this immediately after closing any position.
 * 
 * @param {object} cooldowns    - state.cooldowns (mutated in place)
 * @param {object} closedTrade  - { symbol, reason, closedAt }
 * @param {object} [config]     - override DEFAULT_CONFIG
 * @returns {{ applied: boolean, symbol: string, expiresAt: string|null, reason: string|null }}
 */
function registerExit(cooldowns, closedTrade, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { symbol, reason, closedAt } = closedTrade;
  const closedMs = new Date(closedAt).getTime();

  // Only trigger cooldown on take-profits (move is exhausted)
  if (!cfg.triggerReasons.includes(reason)) {
    return { applied: false, symbol, expiresAt: null, reason: null };
  }

  // Calculate expiry
  let expiryMs = closedMs + cfg.cooldownMs;

  // Snap to next 4h candle if configured
  if (cfg.snapTo4hCandle) {
    const nextBoundary = next4hBoundary(closedMs);
    expiryMs = Math.max(expiryMs, nextBoundary);
  }

  const expiresAt = new Date(expiryMs).toISOString();

  // Set cooldown (overwrite any existing — latest TP resets the timer)
  cooldowns[symbol] = { expiresAt };

  return {
    applied: true,
    symbol,
    expiresAt,
    reason: `post-TP cooldown ${Math.round(cfg.cooldownMs / 60000)}min → expires ${expiresAt}`,
  };
}

/**
 * Check if a symbol is currently on cooldown.
 * Call this in your candidate filter BEFORE scoring.
 * 
 * @param {object} cooldowns  - state.cooldowns
 * @param {string} symbol
 * @param {Date|string} [now] - current time (default: now)
 * @returns {{ onCooldown: boolean, expiresAt: string|null, reason: string|null }}
 */
function isOnCooldown(cooldowns, symbol, now = new Date()) {
  const entry = cooldowns[symbol];

  if (!entry || !entry.expiresAt) {
    return { onCooldown: false, expiresAt: null, reason: null };
  }

  const nowMs = new Date(now).getTime();
  const expiryMs = new Date(entry.expiresAt).getTime();

  if (nowMs >= expiryMs) {
    delete cooldowns[symbol];
    return { onCooldown: false, expiresAt: null, reason: null };
  }

  const minutesLeft = Math.round((expiryMs - nowMs) / 60000);

  return {
    onCooldown: true,
    expiresAt: entry.expiresAt,
    reason: `post-TP cooldown (${minutesLeft}min remaining)`,
  };
}

/**
 * Prune all expired cooldowns from state.
 * Call once per scan cycle to keep state clean.
 * 
 * @param {object} cooldowns - state.cooldowns
 * @param {Date|string} [now]
 * @returns {string[]} symbols that were cleared
 */
function pruneExpired(cooldowns, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const cleared = [];

  for (const symbol of Object.keys(cooldowns)) {
    const entry = cooldowns[symbol];
    if (entry.expiresAt && nowMs >= new Date(entry.expiresAt).getTime()) {
      delete cooldowns[symbol];
      cleared.push(symbol);
    }
  }

  return cleared;
}


// ============================================================
// INTEGRATION HELPER
// ============================================================

/**
 * Plug into your scan → score → entry pipeline:
 * 
 *   const { isOnCooldown, registerExit, pruneExpired } = require('./symbol-cooldown');
 * 
 *   // 1. At start of each scan cycle:
 *   pruneExpired(state.cooldowns);
 * 
 *   // 2. When filtering candidates:
 *   for (const candidate of candidates) {
 *     const cd = isOnCooldown(state.cooldowns, candidate.symbol);
 *     if (cd.onCooldown) {
 *       logDecision(candidate, 'rejected', cd.reason);
 *       continue;
 *     }
 *     // ... proceed with scoring and entry
 *   }
 * 
 *   // 3. When a position closes:
 *   const cdResult = registerExit(state.cooldowns, {
 *     symbol: trade.symbol,
 *     reason: trade.reason,       // 'take-profit-full', 'stop-loss', etc.
 *     closedAt: trade.closedAt,
 *   });
 *   if (cdResult.applied) {
 *     console.log(`[COOLDOWN] ${cdResult.symbol} → ${cdResult.reason}`);
 *   }
 */


// ============================================================
// RETROACTIVE ANALYSIS — See what cooldowns would have prevented
// ============================================================

/**
 * Run through historical trades to simulate cooldown impact.
 * Useful for tuning the cooldown duration before going live.
 * 
 * @param {object[]} trades - array of closed trades (chronological order)
 * @param {object} [config] - cooldown config overrides
 * @returns {object} { blocked, allowed, savedPnl, missedPnl, netSaved }
 */
function backtestCooldowns(trades, config = {}) {
  const cooldowns = {};
  const blocked = [];
  const allowed = [];

  for (const trade of trades) {
    const cd = isOnCooldown(cooldowns, trade.symbol, trade.openedAt);

    if (cd.onCooldown) {
      blocked.push({
        ...trade,
        _blockedReason: cd.reason,
      });
    } else {
      allowed.push(trade);
    }

    // Register the exit regardless (to maintain cooldown state for backtesting)
    if (trade.reason && trade.closedAt) {
      registerExit(cooldowns, {
        symbol: trade.symbol,
        reason: trade.reason,
        closedAt: trade.closedAt,
      }, config);
    }
  }

  const savedPnl = blocked
    .filter(t => t.pnl < 0)
    .reduce((sum, t) => sum + Math.abs(t.pnl), 0);

  const missedPnl = blocked
    .filter(t => t.pnl > 0)
    .reduce((sum, t) => sum + t.pnl, 0);

  return {
    blocked,
    allowed,
    savedPnl,
    missedPnl,
    netSaved: savedPnl - missedPnl,
    blockedCount: blocked.length,
    totalCount: trades.length,
  };
}


// ============================================================
// EXPORTS
// ============================================================

export {
  registerExit,
  isOnCooldown,
  pruneExpired,
  next4hBoundary,
  backtestCooldowns,
  DEFAULT_CONFIG,
};
