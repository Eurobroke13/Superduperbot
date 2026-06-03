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
 * Selects the top-percentile candidates by score. Mirrors the inline cutoff
 * logic in phaseScan: take the score at the 20th-percentile index of the
 * descending-sorted scores as the cutoff, then keep everything >= cutoff.
 *
 * @param {Array<{score:number}>} candidates
 * @param {number} percentile  fraction (default 0.2 = top band cutoff index)
 * @returns {Array} candidates with score >= cutoff
 */
export function selectTopSignals(candidates, percentile = 0.2) {
  const list = candidates || [];
  const scores = list.map(c => c.score).sort((a, b) => b - a);
  const cutoff = scores[Math.floor(scores.length * percentile)] ?? -Infinity;
  return list.filter(c => c.score >= cutoff);
}

/**
 * Interleaves longs and shorts (already score-sorted desc) into a single list
 * up to `slots`, alternating long/short so neither side starves the other.
 * Pure mirror of the phaseScan toConsider loop.
 *
 * @param {Array} longs   score-desc sorted long candidates
 * @param {Array} shorts  score-desc sorted short candidates
 * @param {number} slots  max entries to consider
 * @returns {Array}
 */
export function interleaveLongsShorts(longs, shorts, slots) {
  const out = [];
  const L = longs || [], S = shorts || [];
  let li = 0, si = 0;
  while (out.length < slots && (li < L.length || si < S.length)) {
    if (li < L.length) out.push(L[li++]);
    if (out.length < slots && si < S.length) out.push(S[si++]);
  }
  return out;
}

/**
 * Computes funding-rate score adjustments for a candidate. Pure: returns the
 * score delta and the reason tags to push; does not mutate the candidate.
 *
 * @param {{signal:string, h4Trend:string}} candidate
 * @param {{signal?:string, reason?:string}} fundSig  output of fundingRateSignal
 * @param {number|null} fundRate  raw funding rate
 * @returns {{scoreDelta:number, reasons:string[]}}
 */
export function applyFundingAdjustments(candidate, fundSig = {}, fundRate = null) {
  const { signal, h4Trend } = candidate;
  let scoreDelta = 0;
  const reasons = [];

  if (fundSig.signal === "short" && h4Trend === "bullish") {
    scoreDelta += 1.5; reasons.push("funding-squeeze");
  }
  if (fundSig.signal === "long" && h4Trend === "bearish") {
    scoreDelta += 1.5; reasons.push("funding-squeeze");
  }
  if (fundSig.reason === "funding-extreme-long") {
    scoreDelta += signal === "short" ? 2.0 : -0.5;
    reasons.push("funding-extreme-long");
  }
  if (fundSig.reason === "funding-extreme-short") {
    scoreDelta += signal === "long" ? 2.0 : -0.5;
    reasons.push("funding-extreme-short");
  }
  if (fundSig.reason === "funding-crowded-long" && fundRate > 0.0015) {
    if (signal === "short") scoreDelta += 1.0;
    reasons.push("funding-skew-short");
  }
  if (fundSig.reason === "funding-crowded-short" && fundRate < -0.0015) {
    if (signal === "long") scoreDelta += 1.0;
    reasons.push("funding-skew-long");
  }
  return { scoreDelta, reasons };
}

/**
 * Computes LunarCrush sentiment score adjustments for a candidate. Pure:
 * returns the score delta and reason tags; does not mutate the candidate.
 * Weights are passed in (caller resolves them via getWeight) to keep this
 * free of state/config dependencies.
 *
 * @param {{signal:string}} candidate
 * @param {{sentiment:number, galaxyScore:number}} lunar
 * @param {{bull:number, bear:number, warning:number}} weights
 * @returns {{scoreDelta:number, reasons:string[]}}
 */
export function applyLunarAdjustments(candidate, lunar, weights = {}) {
  const { signal } = candidate;
  const { bull = 0, bear = 0, warning = 0 } = weights;
  let scoreDelta = 0;
  const reasons = [];
  if (!lunar) return { scoreDelta, reasons };

  if (lunar.galaxyScore > 60 && signal === "long") {
    scoreDelta += bull; reasons.push(`lunar-bull(${lunar.galaxyScore})`);
  }
  if (lunar.galaxyScore < 30 && signal === "short") {
    scoreDelta += bear; reasons.push(`lunar-bear(${lunar.galaxyScore})`);
  }
  if (signal === "long" && lunar.sentiment < 30) {
    scoreDelta += warning; reasons.push("lunar-sentiment-warning");
  }
  if (signal === "short" && lunar.sentiment > 70) {
    scoreDelta += warning; reasons.push("lunar-sentiment-warning");
  }
  return { scoreDelta, reasons };
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
