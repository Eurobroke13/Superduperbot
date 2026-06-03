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
 * Rank tradeable symbols for scan ordering. Pure transform of the input list.
 *   rankScore = (24h quote volume / 1M) + (abs 24h move% * 100 * moveWeight)
 * In sideways regimes movement is weighted heavily (coins near range extremes
 * are the mean-reversion candidates); otherwise volume dominates.
 *
 * @param {string[]} tradeable
 * @param {{ tickerMap?: object, volumeMap?: object, regimeLabel?: string }} ctx
 * @returns {string[]} symbols sorted by descending rankScore
 */
export function rankTradeable(tradeable, { tickerMap = {}, volumeMap = {}, regimeLabel } = {}) {
  const movePctWeight = regimeLabel === "sideways" ? 1.5 : 0.3;
  return (tradeable || [])
    .map(symbol => {
      const t = tickerMap[symbol] || {};
      const vol = volumeMap[symbol] || 0;
      const last = parseFloat(t.last || 0);
      const open24h = parseFloat(t.open24h || t.open_24h || t.open24hPrice || 0);
      const movePct = open24h > 0 && last > 0 ? Math.abs((last - open24h) / open24h) : 0;
      const rankScore = (vol / 1_000_000) + (movePct * 100 * movePctWeight);
      return { symbol, vol, movePct, rankScore };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .map(x => x.symbol);
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
