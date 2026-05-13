// =============================================================================
// POST-TP COOLDOWN — Prevents re-entering a symbol after take-profit
//
// After a TP the move is exhausted — re-entering is chasing the tail end.
// After a stop-loss the thesis may still be valid (decaying limits handle re-entry).
// Flat 4h cooldown, snapped to the next 4h candle close.
//
// State: store `cooldowns: {}` in the bot state (auto-initialized).
// =============================================================================

const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const SNAP_TO_4H = true;

const TP_REASONS = [
  "take-profit-full",
  "take-profit-hit",
  "partial-tp1-2xATR",     // partial TPs also trigger cooldown — move is partially exhausted
  "partial-tp2-3.5xATR",
];

// Only apply cooldown on full TPs, not partials
// (partials mean the position is still open, no re-entry issue)
const FULL_TP_REASONS = [
  "take-profit-full",
  "take-profit-hit",
];

function next4hBoundary(timestampMs) {
  const date = new Date(timestampMs);
  const hour = date.getUTCHours();
  const next4h = Math.ceil((hour + 1) / 4) * 4;
  const boundary = new Date(date);
  boundary.setUTCHours(next4h >= 24 ? 0 : next4h, 0, 0, 0);
  if (next4h >= 24) boundary.setUTCDate(boundary.getUTCDate() + 1);
  return boundary.getTime();
}

/**
 * Register a trade exit. Applies cooldown only on full take-profits.
 * Call immediately after closing any position.
 *
 * @param {object} cooldowns - state.cooldowns (mutated in place)
 * @param {{ symbol: string, reason: string, closedAt: string }} closedTrade
 * @returns {{ applied: boolean, symbol: string, expiresAt: string|null, reason: string|null }}
 */
export function registerExit(cooldowns, closedTrade) {
  const { symbol, reason, closedAt } = closedTrade;

  // Only trigger on full take-profits
  if (!FULL_TP_REASONS.includes(reason)) {
    return { applied: false, symbol, expiresAt: null, reason: null };
  }

  const closedMs = new Date(closedAt).getTime();
  let expiryMs = closedMs + COOLDOWN_MS;

  if (SNAP_TO_4H) {
    expiryMs = Math.max(expiryMs, next4hBoundary(closedMs));
  }

  const expiresAt = new Date(expiryMs).toISOString();
  cooldowns[symbol] = { expiresAt };

  return {
    applied: true,
    symbol,
    expiresAt,
    reason: `post-TP cooldown → expires ${expiresAt}`
  };
}

/**
 * Check if a symbol is on cooldown.
 * Call in candidate filter BEFORE scoring.
 *
 * @param {object} cooldowns - state.cooldowns
 * @param {string} symbol
 * @param {Date|string} [now]
 * @returns {{ onCooldown: boolean, expiresAt: string|null, reason: string|null }}
 */
export function isOnCooldown(cooldowns, symbol, now = new Date()) {
  const entry = cooldowns?.[symbol];
  if (!entry?.expiresAt) return { onCooldown: false, expiresAt: null, reason: null };

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
    reason: `post-TP cooldown (${minutesLeft}min remaining)`
  };
}

/**
 * Prune all expired cooldowns. Call once per scan cycle.
 */
export function pruneExpired(cooldowns, now = new Date()) {
  if (!cooldowns) return [];
  const nowMs = new Date(now).getTime();
  const cleared = [];
  for (const symbol of Object.keys(cooldowns)) {
    if (cooldowns[symbol]?.expiresAt && nowMs >= new Date(cooldowns[symbol].expiresAt).getTime()) {
      delete cooldowns[symbol];
      cleared.push(symbol);
    }
  }
  return cleared;
}

/**
 * Initialize cooldowns on state if missing.
 */
export function initCooldowns(state) {
  if (!state.cooldowns) state.cooldowns = {};
}
