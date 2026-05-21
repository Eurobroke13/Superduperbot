// Enhanced sideways detection used by regime.js
// Returns { sideways, confidence, signals } where each signal has { signal, value }

export function detectSideways(closes, highs, lows) {
  const n = closes.length;
  const signals = {};
  let score = 0;

  // Signal 1: 14-bar price range < 8%
  if (n >= 14) {
    const slice = closes.slice(-14);
    const rangeR = (Math.max(...slice) - Math.min(...slice)) / Math.min(...slice);
    signals.range = { signal: rangeR < 0.08, value: rangeR };
    if (signals.range.signal) score++;
  }

  // Signal 2: Average daily absolute change < 1.5% over 20 bars
  if (n >= 20) {
    const slice = closes.slice(-20);
    const avgChange = slice.slice(1).reduce((s, c, i) => s + Math.abs(c - slice[i]) / slice[i], 0) / 19;
    signals.momentum = { signal: avgChange < 0.015, value: avgChange };
    if (signals.momentum.signal) score++;
  }

  // Signal 3: Price within 3% of 20-bar SMA
  if (n >= 20) {
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const deviation = Math.abs(closes[n - 1] - sma20) / sma20;
    signals.smaDeviation = { signal: deviation < 0.03, value: deviation };
    if (signals.smaDeviation.signal) score++;
  }

  // Signal 4: 14-bar high-low range relative to ATR-like measure < 1.5x
  if (n >= 20 && highs && lows) {
    const recentHighs = highs.slice(-14);
    const recentLows = lows.slice(-14);
    const trueRanges = recentHighs.map((h, i) => h - recentLows[i]);
    const avgTR = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
    const totalRange = Math.max(...recentHighs) - Math.min(...recentLows);
    const ratio = totalRange / (avgTR || 1);
    signals.atrRatio = { signal: ratio < 2.5, value: ratio };
    if (signals.atrRatio.signal) score++;
  }

  const totalSignals = Object.keys(signals).length;
  const confidence = totalSignals > 0 ? score / totalSignals : 0;
  return { sideways: confidence > 0.5, confidence, signals };
}
