// =============================================================================
// SWEEP CONFIRMATION — Replacement for unreliable liquidity-trap entries
//
// The old liquidity-trap setup fired on generic trend signals (ema-ribbon,
// h4-bear, ribbon-align) with no actual verification that a liquidity sweep
// occurred. This led to batches of 6-8 correlated small-loss trades per cycle.
//
// This module requires ACTUAL sweep evidence before allowing entry:
//   1. Price wicks through a known S/R level (the "sweep")
//   2. Closes back inside the range (the "reclaim")
//   3. Volume spike on the sweep candle (climax volume)
//   4. Entry only AFTER the reclaim candle closes
//
// Integration: call isConfirmedSweep() from phaseScan when setupType === 'liquidity-trap'.
// If it returns false, the candidate is blocked — no entry.
// =============================================================================

import { sma } from "./indicators.js";

// ── Configuration ──────────────────────────────────────────────────────────

/** Minimum volume multiple vs 20-period SMA to qualify as climax */
const VOLUME_CLIMAX_MULT = 1.8;

/** How many recent candles to check for sweep wicks */
const SWEEP_LOOKBACK = 3;

/** Max ATR distance the wick can extend past S/R to count as a sweep
 *  (prevents counting massive trend moves as "sweeps") */
const MAX_WICK_EXTENSION_ATR = 2.0;

/** Minimum wick-to-body ratio for the sweep candle */
const MIN_WICK_BODY_RATIO = 1.5;


// ── Core ───────────────────────────────────────────────────────────────────

/**
 * Check whether recent price action shows a confirmed liquidity sweep.
 *
 * @param {object} params
 * @param {object[]} params.candles     - Recent 1h candles (need ~25 for volume SMA)
 * @param {object}   params.srLevels    - { supports: number[], resistances: number[] }
 * @param {string}   params.direction   - 'long' (bear-trap sweep) or 'short' (bull-trap sweep)
 * @param {number}   params.atrVal      - Current ATR value
 * @returns {{ confirmed: boolean, details: object }}
 */
export function isConfirmedSweep({ candles, srLevels, direction, atrVal }) {
  if (!candles || candles.length < 20 || !srLevels || !atrVal) {
    return { confirmed: false, details: { reason: "insufficient-data" } };
  }

  const recent = candles.slice(-SWEEP_LOOKBACK);
  const volumes = candles.slice(-20).map(c => c.volume || 0);
  const avgVolume = sma(volumes, volumes.length);

  if (direction === "long") {
    // Bear-trap: price swept below support, then reclaimed above it
    return checkBearTrapSweep(recent, srLevels.supports, avgVolume, atrVal);
  } else {
    // Bull-trap: price swept above resistance, then reclaimed below it
    return checkBullTrapSweep(recent, srLevels.resistances, avgVolume, atrVal);
  }
}

/**
 * Bear-trap sweep: wick below support → close back above.
 * This is bullish — enter long after the sweep.
 */
function checkBearTrapSweep(recent, supports, avgVolume, atrVal) {
  for (const support of supports) {
    for (let i = 0; i < recent.length; i++) {
      const candle = recent[i];
      const open = candle.open ?? candle.close;

      // 1. Did the candle wick below support?
      if (candle.low >= support) continue;

      // 2. Did it close back above support? (the "reclaim")
      if (candle.close < support) continue;

      // 3. Is the wick extension reasonable? (not a massive trend move)
      const wickExtension = (support - candle.low) / atrVal;
      if (wickExtension > MAX_WICK_EXTENSION_ATR) continue;

      // 4. Does the candle have a significant lower wick relative to body?
      const body = Math.abs(candle.close - open);
      const lowerWick = Math.min(open, candle.close) - candle.low;
      if (body > 0 && lowerWick / body < MIN_WICK_BODY_RATIO) continue;

      // 5. Volume spike?
      const vol = candle.volume || 0;
      const isClimax = avgVolume > 0 && vol >= avgVolume * VOLUME_CLIMAX_MULT;
      if (!isClimax) continue;

      // 6. Is there a reclaim candle AFTER the sweep? (don't enter on the sweep candle itself)
      const hasReclaim = i < recent.length - 1 && recent[i + 1].close > support;

      if (hasReclaim) {
        return {
          confirmed: true,
          details: {
            type: "bear-trap-sweep",
            sweepLevel: support,
            sweepLow: candle.low,
            reclaimClose: recent[i + 1].close,
            wickExtensionATR: parseFloat(wickExtension.toFixed(2)),
            volumeRatio: parseFloat((vol / avgVolume).toFixed(2)),
          }
        };
      }
    }
  }

  return { confirmed: false, details: { reason: "no-bear-trap-sweep-found" } };
}

/**
 * Bull-trap sweep: wick above resistance → close back below.
 * This is bearish — enter short after the sweep.
 */
function checkBullTrapSweep(recent, resistances, avgVolume, atrVal) {
  for (const resistance of resistances) {
    for (let i = 0; i < recent.length; i++) {
      const candle = recent[i];
      const open = candle.open ?? candle.close;

      // 1. Did the candle wick above resistance?
      if (candle.high <= resistance) continue;

      // 2. Did it close back below resistance?
      if (candle.close > resistance) continue;

      // 3. Reasonable wick extension?
      const wickExtension = (candle.high - resistance) / atrVal;
      if (wickExtension > MAX_WICK_EXTENSION_ATR) continue;

      // 4. Significant upper wick relative to body?
      const body = Math.abs(candle.close - open);
      const upperWick = candle.high - Math.max(open, candle.close);
      if (body > 0 && upperWick / body < MIN_WICK_BODY_RATIO) continue;

      // 5. Volume spike?
      const vol = candle.volume || 0;
      const isClimax = avgVolume > 0 && vol >= avgVolume * VOLUME_CLIMAX_MULT;
      if (!isClimax) continue;

      // 6. Reclaim candle after the sweep?
      const hasReclaim = i < recent.length - 1 && recent[i + 1].close < resistance;

      if (hasReclaim) {
        return {
          confirmed: true,
          details: {
            type: "bull-trap-sweep",
            sweepLevel: resistance,
            sweepHigh: candle.high,
            reclaimClose: recent[i + 1].close,
            wickExtensionATR: parseFloat(wickExtension.toFixed(2)),
            volumeRatio: parseFloat((vol / avgVolume).toFixed(2)),
          }
        };
      }
    }
  }

  return { confirmed: false, details: { reason: "no-bull-trap-sweep-found" } };
}


// ── Batch cap helper ───────────────────────────────────────────────────────

/**
 * Track how many liquidity-trap entries have been opened this scan cycle.
 * Call from phaseScan after each successful liquidity-trap entry.
 *
 * @param {object} scanSummary - the scan summary being built
 * @param {number} [maxPerCycle=2] - max liquidity-trap entries per scan
 * @returns {boolean} true if another entry is allowed
 */
export function canOpenMoreTraps(scanSummary, maxPerCycle = 2) {
  const opened = scanSummary.openedBySetup?.["liquidity-trap"] || 0;
  return opened < maxPerCycle;
}
