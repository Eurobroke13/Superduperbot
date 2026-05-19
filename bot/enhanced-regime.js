// =============================================================================
// ENHANCED REGIME DETECTION — improved sideways classification
//
// Problem: The current sideways detection uses a fixed 10% range over 14 days:
//   const rangeR = (max - min) / min;
//   const sideways = rangeR < 0.10;
//
// This fails because:
//   1. After a sharp drop, the market can sit at the bottom and rangeR > 10%
//      even though it's clearly consolidating.
//   2. In low-vol environments, 10% is too generous — everything looks directional.
//   3. A single wick day can make a genuinely sideways period look trending.
//
// Fix: Compare current realized volatility to its own rolling median.
// If current vol is below median, the market is consolidating regardless of
// whether recent range happens to exceed some fixed threshold.
// =============================================================================

/**
 * Detect whether the market is in a sideways/consolidation regime.
 * Uses multiple signals and requires consensus.
 *
 * @param {number[]} closes - Daily closes (at least 60+ elements)
 * @param {number[]} highs  - Daily highs
 * @param {number[]} lows   - Daily lows
 * @returns {{ sideways: boolean, confidence: number, signals: object }}
 */
export function detectSideways(closes, highs, lows) {
  const n = closes.length;
  const signals = {};
  let score = 0;

  // ---------------------------------------------------------------------------
  // Signal 1: ATR compression
  // Current ATR(14) vs its own 60-day median.
  // If current ATR < 70% of median → compressing → sideways signal
  // ---------------------------------------------------------------------------
  if (n >= 74) {
    const atrValues = [];
    for (let i = 14; i < n; i++) {
      let sum = 0;
      for (let j = i - 13; j <= i; j++) {
        const tr = Math.max(
          highs[j] - lows[j],
          j > 0 ? Math.abs(highs[j] - closes[j - 1]) : highs[j] - lows[j],
          j > 0 ? Math.abs(lows[j] - closes[j - 1]) : highs[j] - lows[j]
        );
        sum += tr;
      }
      atrValues.push(sum / 14);
    }

    const currentATR = atrValues[atrValues.length - 1];
    const lookback = atrValues.slice(-60);
    const sortedATR = [...lookback].sort((a, b) => a - b);
    const medianATR = sortedATR[Math.floor(sortedATR.length / 2)];

    const atrRatio = medianATR > 0 ? currentATR / medianATR : 1;
    signals.atrCompression = { currentATR, medianATR, ratio: atrRatio };

    if (atrRatio < 0.70) { score += 2; signals.atrCompression.signal = "strong-sideways"; }
    else if (atrRatio < 0.85) { score += 1; signals.atrCompression.signal = "mild-sideways"; }
    else { signals.atrCompression.signal = "not-compressed"; }
  }

  // ---------------------------------------------------------------------------
  // Signal 2: Directional efficiency
  // How much of the absolute movement was "net" vs "noise"?
  // efficiency = |close[now] - close[14 ago]| / sum(|close[i] - close[i-1]|)
  // Low efficiency = lots of back-and-forth = sideways
  // ---------------------------------------------------------------------------
  if (n >= 15) {
    const window = 14;
    const netMove = Math.abs(closes[n - 1] - closes[n - 1 - window]);
    let totalMove = 0;
    for (let i = n - window; i < n; i++) {
      totalMove += Math.abs(closes[i] - closes[i - 1]);
    }
    const efficiency = totalMove > 0 ? netMove / totalMove : 0;
    signals.efficiency = { value: efficiency };

    if (efficiency < 0.15) { score += 2; signals.efficiency.signal = "strong-sideways"; }
    else if (efficiency < 0.25) { score += 1; signals.efficiency.signal = "mild-sideways"; }
    else { signals.efficiency.signal = "directional"; }
  }

  // ---------------------------------------------------------------------------
  // Signal 3: Bollinger Band width compression
  // Narrow bands = low vol = sideways
  // Compare current BBW to its 50-day median
  // ---------------------------------------------------------------------------
  if (n >= 70) {
    const period = 20;
    const bbWidths = [];
    for (let i = period - 1; i < n; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const stdDev = Math.sqrt(slice.reduce((s, x) => s + (x - mean) ** 2, 0) / period);
      const width = mean > 0 ? (4 * stdDev) / mean : 0; // full band width / price
      bbWidths.push(width);
    }

    const currentBBW = bbWidths[bbWidths.length - 1];
    const recentBBW = bbWidths.slice(-50);
    const sortedBBW = [...recentBBW].sort((a, b) => a - b);
    const medianBBW = sortedBBW[Math.floor(sortedBBW.length / 2)];

    const bbRatio = medianBBW > 0 ? currentBBW / medianBBW : 1;
    signals.bbWidth = { current: currentBBW, median: medianBBW, ratio: bbRatio };

    if (bbRatio < 0.70) { score += 2; signals.bbWidth.signal = "strong-squeeze"; }
    else if (bbRatio < 0.85) { score += 1; signals.bbWidth.signal = "mild-squeeze"; }
    else { signals.bbWidth.signal = "not-squeezed"; }
  }

  // ---------------------------------------------------------------------------
  // Signal 4: Original range check (kept as weak signal)
  // ---------------------------------------------------------------------------
  if (n >= 14) {
    const recent = closes.slice(-14);
    const rangeR = (Math.max(...recent) - Math.min(...recent)) / Math.min(...recent);
    signals.rangeR = { value: rangeR };

    if (rangeR < 0.05) { score += 1; signals.rangeR.signal = "tight-range"; }
    else if (rangeR < 0.08) { score += 0.5; signals.rangeR.signal = "moderate-range"; }
    else { signals.rangeR.signal = "wide-range"; }
  }

  // ---------------------------------------------------------------------------
  // Consensus: sideways if score >= 3 (out of max ~7)
  // ---------------------------------------------------------------------------
  const sideways = score >= 3;
  const confidence = Math.min(score / 5, 1.0); // normalized 0..1

  return { sideways, confidence, score, signals };
}

/**
 * Drop-in replacement for the sideways check in your detectRegime function.
 *
 * Before:
 *   const recent = closes.slice(-14);
 *   const rangeR = (Math.max(...recent) - Math.min(...recent)) / Math.min(...recent);
 *   const sideways = rangeR < 0.10;
 *
 * After:
 *   import { detectSideways } from "./enhanced-regime.js";
 *   const { sideways } = detectSideways(closes, highs, lows);
 *
 * The rest of your regime detection (HMM, Markov, Pi Cycle) stays the same.
 */
