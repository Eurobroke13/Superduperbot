// Pure stateless helpers extracted from runner.js for testability.
// No DB, network, or async dependencies.

/**
 * Returns true when today's realized PnL breaches the -1.5% mid-run halt.
 */
export function checkMidRunDrawdown(state, todayStr) {
  const today = todayStr ?? new Date().toISOString().slice(0, 10);
  const todayRealizedPnl = (state.trades || [])
    .filter(t => t.closedAt?.startsWith(today))
    .reduce((sum, t) => sum + (t.pnl || 0), 0);
  const approxPortfolioVal = (state.cash || 0) +
    Object.values(state.positions || {}).reduce((s, p) => s + (p.notional || 0), 0);
  if (approxPortfolioVal <= 0) return false;
  return todayRealizedPnl / approxPortfolioVal < -0.015;
}

/**
 * Returns the Claude spend mode: "normal" | "warning" | "exceeded".
 *   "warning"  — spend is 90–99% of budget
 *   "exceeded" — spend is ≥ 100% of budget
 */
export function claudeSpendMode(spend, budget) {
  if (budget <= 0) return "normal";
  const fraction = spend / budget;
  if (fraction >= 1.0) return "exceeded";
  if (fraction >= 0.9) return "warning";
  return "normal";
}

/**
 * Computes the intraday 4H bias from a candle array.
 * Returns "bull" | "bear" | "sideways".
 * Caller must pass the ema function to avoid a dynamic import here.
 */
export function compute4hBias(candles4h, { ema: emaFn } = {}) {
  if (!candles4h || candles4h.length < 20) return "sideways";
  if (!emaFn) throw new Error("compute4hBias: pass ema function as second arg");
  const c4 = candles4h.map(c => c.close);
  const n4 = c4.length;
  const e20 = emaFn(c4, 20);
  const e50 = emaFn(c4, 50);
  const last3Bullish = [n4 - 1, n4 - 2, n4 - 3].every(i => e20[i] > e50[i]);
  const last3Bearish = [n4 - 1, n4 - 2, n4 - 3].every(i => e20[i] < e50[i]);
  return last3Bullish ? "bull" : last3Bearish ? "bear" : "sideways";
}
