// Pure stateless helpers extracted from runner.js for testability.
// No DB, network, or async dependencies.

import {
  bearFilter,
  liquidityTrapQualityGate,
  sidewaysFilter
} from "./entry-improvements.js";

/**
 * Applies the three synchronous candidate gates (sideways → liquidity-trap
 * quality → bear) in order, mirroring the inline phaseScan loops exactly.
 * Pure: does not mutate the candidate. Returns the resulting score (0 if any
 * gate blocked) and the single block reason that fired, if any.
 *
 * Gate ordering & skip semantics (preserved from the original loops):
 *   1. sideways  — skipped when candidate._sweepBlocked
 *   2. LT-gate   — skipped when _sweepBlocked, already-zeroed, or not a
 *                  liquidity-trap setup
 *   3. bear      — skipped when already-zeroed
 * Once a gate zeroes the score, later gates self-skip, so at most one reason
 * fires per candidate.
 *
 * @param {object} candidate
 * @param {{ regimeLabel: string, regimeStats?: object }} ctx
 * @returns {{ score:number, blockReason:(string|null) }}
 */
export function applySyncFilters(candidate, { regimeLabel, regimeStats } = {}) {
  let score = candidate.score;

  // 1. sideways regime filter
  if (!candidate._sweepBlocked) {
    const swf = sidewaysFilter(candidate, regimeLabel, regimeStats);
    if (!swf.allowed) {
      return { score: 0, blockReason: `sideways-filter:${swf.reason}` };
    }
  }

  // 2. liquidity-trap quality gate (requires 2+ confirmations)
  if (!candidate._sweepBlocked && score !== 0 && candidate.setupType === "liquidity-trap") {
    const volumeData = { ratio: (candidate.reasons || []).includes("volume") ? 1.5 : 0.8 };
    const rsiDivergence = candidate.obvDiv && candidate.obvDiv !== "none"
      ? { type: candidate.obvDiv }
      : { type: "none" };
    const ltGate = liquidityTrapQualityGate(candidate, volumeData, rsiDivergence);
    if (!ltGate.pass) {
      return { score: 0, blockReason: "lt-quality-gate" };
    }
  }

  // 3. bear regime filter
  if (score !== 0) {
    const bearGate = bearFilter(candidate, regimeLabel, regimeStats);
    if (!bearGate.allowed) {
      return { score: 0, blockReason: `bear-gate:${bearGate.reason}` };
    }
  }

  return { score, blockReason: null };
}

/**
 * Multi-timeframe regime consensus.
 *
 * The daily HMM alone is noisy — it can label "bear" on a strong uptrend.
 * This function requires at least 2 of 3 timeframes (daily, 4H, 1H) to agree
 * before committing to a directional label.  The "cautious default" when TFs
 * disagree is "sideways", which keeps entry thresholds elevated but doesn't
 * block all trades.
 *
 * Extra guard: bear label is only confirmed when markovProb ≥ 0.55 — a low
 * probability suggests the Markov chain is uncertain and we should not act on it.
 *
 * @param {string} dailyLabel   "bull"|"bear"|"sideways" from HMM+daily
 * @param {string} h4Bias       "bull"|"bear"|"sideways" from compute4hBias
 * @param {string} h1Bias       "bull"|"bear"|"sideways" from compute4hBias on 1H
 * @param {number} markovProb   Markov transition probability [0,1]
 * @returns {{ label:string, consensus:string, votes:object }}
 */
export function buildRegimeConsensus(dailyLabel, h4Bias, h1Bias, markovProb = 0.5) {
  const tfs = [dailyLabel, h4Bias, h1Bias];
  const bullVotes = tfs.filter(l => l === "bull").length;
  const bearVotes = tfs.filter(l => l === "bear").length;

  let label;
  if (bearVotes >= 2 && markovProb >= 0.55) {
    label = "bear";
  } else if (bullVotes >= 2) {
    label = "bull";
  } else {
    label = "sideways";
  }

  return {
    label,
    consensus: `d:${dailyLabel} 4h:${h4Bias} 1h:${h1Bias} markov:${markovProb.toFixed(2)}`,
    votes: { bull: bullVotes, bear: bearVotes, sideways: tfs.filter(l => l === "sideways").length }
  };
}

/**
 * Returns the closed-candle slice of a candle array.
 * The last candle from OKX is the currently forming candle.  Using it for
 * signal generation causes false signals that vanish by candle close.
 * Strip it when the candle has been open for fewer than CONFIRM_MINUTES.
 *
 * @param {Array<{time:number}>} candles   sorted oldest→newest
 * @param {number} timeframeMs             candle duration in milliseconds
 * @param {number} [confirmMs=900000]      15 min buffer before trusting close
 * @returns {Array}  safe closed-candle slice
 */
export function trimToClosedCandles(candles, timeframeMs, confirmMs = 15 * 60 * 1000) {
  if (!candles || candles.length < 2) return candles || [];
  const last = candles[candles.length - 1];
  const lastOpenTime = last.time;
  const expectedCloseTime = lastOpenTime + timeframeMs;
  if (Date.now() < expectedCloseTime + confirmMs) {
    // Still forming — drop it
    return candles.slice(0, -1);
  }
  return candles;
}

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

/**
 * Applies the mean-reversion entry gate for a single candidate. Pure: returns
 * mutation instructions rather than mutating in place.
 *
 * @param {object} candidate
 * @param {Function} confirmMeanReversionEntryFn  injected from entry-improvements
 * @returns {{ blocked:boolean, blockReason:string|null, adjustedScore?:number,
 *             positionSizeMultiplier?:number, patterns?:string[] }}
 */
export function applyMrGate(candidate, confirmMeanReversionEntryFn) {
  if (candidate.score === 0 || candidate.setupType !== "mean-reversion") {
    return { blocked: false, blockReason: null };
  }
  const candles15m = candidate._candles15m || null;
  const mrDecision = confirmMeanReversionEntryFn(candidate, candles15m);
  if (!mrDecision.enter) {
    return { blocked: true, blockReason: `mr-entry-gate:${mrDecision.reason}` };
  }
  return {
    blocked: false,
    blockReason: null,
    adjustedScore: mrDecision.adjustedScore,
    positionSizeMultiplier: mrDecision.positionSizeMultiplier,
    patterns: mrDecision.patterns || []
  };
}

/**
 * Applies the bear-short 15m confirmation result to a single candidate. Pure:
 * takes an already-fetched confirmation object and returns mutation
 * instructions. The caller owns the async candle fetch.
 *
 * @param {object} candidate
 * @param {{ enter:boolean, confidence:number, positionSizeMultiplier:number,
 *            patterns:string[] }} confirmation  output of confirm15mBearShort
 * @returns {{ scoreFactor:number, adjustedScore?:number,
 *             positionSizeMultiplier?:number, patterns?:string[] }}
 */
export function applyBearShort15m(candidate, confirmation) {
  if (!confirmation.enter) {
    return { scoreFactor: 0.85 };
  }
  return {
    scoreFactor: 1,
    adjustedScore: candidate.score + (confirmation.confidence * 0.3),
    positionSizeMultiplier: confirmation.positionSizeMultiplier,
    patterns: confirmation.patterns || []
  };
}

/**
 * Routes each considered candidate into autoList or claudeList (or logs a
 * finalizeDecision call). Pure: returns `{ autoList, claudeList, decisions }`
 * where `decisions` is an array of `{ candidate, outcome, reason, extra }`
 * objects for the caller to pass to finalizeDecision — keeping the routing
 * logic separate from the runner.js-local finalizeDecision closure.
 *
 * @param {object[]} toConsider
 * @param {{ regime: object, state: object,
 *            autoApproveSignalFn: Function,
 *            checkCorrelationExposureFn: Function,
 *            checkMinRRFn: Function,
 *            shouldSkipClaudeFn: Function,
 *            getSetupFingerprintFn: Function }} ctx
 * @returns {{ autoList: object[], claudeList: object[],
 *             decisions: Array<{candidate,outcome,reason,extra}> }}
 */
export function routeToApprovalLists(toConsider, {
  regime, state,
  autoApproveSignalFn,
  checkCorrelationExposureFn,
  checkMinRRFn,
  shouldSkipClaudeFn
}) {
  const autoList = [];
  const claudeList = [];
  const decisions = [];

  for (const c of toConsider) {
    const exposure = checkCorrelationExposureFn(c, state);
    if (!exposure.allowed) {
      decisions.push({ candidate: c, outcome: "skipped", reason: "correlation-limit",
        extra: { correlationBlocked: true, details: { reason: exposure.reason } } });
      continue;
    }

    const rrCheck = checkMinRRFn(c);
    if (!rrCheck.allowed) {
      decisions.push({ candidate: c, outcome: "skipped", reason: "min-rr",
        extra: { details: { reason: rrCheck.reason } } });
      continue;
    }

    if (autoApproveSignalFn(c, regime)) {
      autoList.push(c);
      continue;
    }

    if (shouldSkipClaudeFn(c, state)) {
      const cached = state.claudeValidations?.[c.symbol];
      if (cached?.approved) {
        autoList.push({ ...c, approvalType: "claude-cached" });
      } else {
        const ageMin = Math.round((Date.now() - cached.ts) / 60000);
        decisions.push({ candidate: c, outcome: "rejected", reason: "claude-cached-rejected",
          extra: { approvalType: "claude-cached",
            details: { ageMinutes: ageMin, claudeReason: cached?.reason || "cached-rejected" } } });
      }
    } else {
      claudeList.push(c);
    }
  }

  return { autoList, claudeList, decisions };
}

/**
 * Applies the Claude spend guardrail: moves candidates from claudeList to
 * autoList (with an appropriately-tagged approvalType) if the monthly budget
 * is exhausted or near-exhausted. Mutates both arrays in place.
 *
 * Pure (no async, no logging): returns the spend mode for the caller to log.
 *
 * @param {object[]} claudeList  mutated in place
 * @param {object[]} autoList    mutated in place
 * @param {{ spend: number, budget: number }} budgetCtx
 * @returns {"normal"|"warning"|"exceeded"} spendMode
 */
export function applyClaudeSpendGuardrail(claudeList, autoList, { spend, budget }) {
  const fraction = budget > 0 ? spend / budget : 0;
  if (fraction >= 1.0) {
    for (const c of claudeList) autoList.push({ ...c, approvalType: "auto-budget-exceeded" });
    claudeList.length = 0;
    return "exceeded";
  }
  if (fraction >= 0.9) {
    for (const c of claudeList) autoList.push({ ...c, approvalType: "auto-budget-warning" });
    claudeList.length = 0;
    return "warning";
  }
  return "normal";
}

/**
 * Processes a completed claudeBatchAnalysis result: writes the validation
 * cache entries and computes per-candidate routing decisions (staged /
 * rejected / fallback). Pure: returns cache entries to write and a decisions
 * array — does not touch state or call stageCandidateEntry.
 *
 * @param {object[]} claudeList
 * @param {{ validations: Record<string, {approved:boolean, reason:string}> }} claudeResult
 * @param {{ getSetupFingerprintFn: Function }} ctx
 * @returns {{ cacheEntries: Record<string, object>,
 *             routing: Array<{candidate, action, approvalType, claudeReason}> }}
 *   action ∈ "stage" | "rejected" | "fallback-rejected"
 */
export function resolveClaudeValidations(claudeList, claudeResult, { getSetupFingerprintFn }) {
  const cacheEntries = {};
  const routing = [];

  for (const c of claudeList) {
    const v = claudeResult.validations[c.symbol];
    cacheEntries[c.symbol] = {
      fingerprint: getSetupFingerprintFn(c),
      ts: Date.now(),
      approved: v?.approved === true,
      reason: v?.reason || "unknown"
    };
  }

  for (const c of claudeList) {
    const v = claudeResult.validations[c.symbol];
    if (v?.approved === true) {
      routing.push({ candidate: c, action: "stage", approvalType: "claude",
        claudeReason: v.reason || "approved" });
    } else if (v?.reason === "auto-fallback") {
      routing.push({ candidate: c, action: "fallback-rejected", approvalType: "claude",
        claudeReason: v.reason });
    } else {
      routing.push({ candidate: c, action: "rejected", approvalType: "claude",
        claudeReason: v?.reason || "no response" });
    }
  }

  return { cacheEntries, routing };
}

/**
 * Resolves per-candidate routing when claudeBatchAnalysis throws. Mirrors the
 * catch block: high-score auto-approvable candidates can still be staged;
 * others are rejected.
 *
 * @param {object[]} claudeList
 * @param {{ regime: object, autoApproveSignalFn: Function, scoreThreshold: number }} ctx
 * @returns {Array<{candidate, action, approvalType, claudeReason}>}
 */
export function resolveClaudeFallback(claudeList, { regime, autoApproveSignalFn, scoreThreshold = 9 }) {
  return claudeList.map(c => {
    if (c.score >= scoreThreshold && autoApproveSignalFn(c, regime)) {
      return { candidate: c, action: "stage", approvalType: "claude", claudeReason: "auto-fallback" };
    }
    return { candidate: c, action: "fallback-rejected", approvalType: "claude",
      claudeReason: "auto-fallback-rejected" };
  });
}

/**
 * Builds the topUnqualified summary slice: the top-5 candidates by score that
 * did not make the qualified set.
 *
 * @param {object[]} candidates
 * @param {Set<string>} qualifiedSet
 * @param {Function} roundValueFn
 * @returns {Array<{symbol, signal, score}>}
 */
export function buildTopUnqualified(candidates, qualifiedSet, roundValueFn) {
  return candidates
    .filter(c => !qualifiedSet.has(c.symbol))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(c => ({ symbol: c.symbol, signal: c.signal, score: roundValueFn(c.score, 2) }));
}
