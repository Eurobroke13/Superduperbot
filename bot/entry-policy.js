import {
  decideEntry,
  createPendingLimit,
  tickPendingLimit
} from "./limit-entry-engine.js";
import {
  createDecayingLimit,
  recommendApproach,
  tickDecayingLimit
} from "./smart-entry-engine.js";
import {
  emaDistanceGate,
  createPendingRetest,
  evaluateRetest
} from "./overbought-entry-strategies.js";
import {
  isOnCooldown,
  pruneExpired
} from "./cooldown.js";

const DEFAULT_POLICY = {
  enableLimitEntries: false,
  enableDecayingLimits: process.env.DECAYING_LIMITS === "true",
  enableEmaDistanceGate: true,        // was false — always check EMA distance on overbought
  enableRetestPaper: true,
  forceDecayOnOverbought: true,       // bypass enableDecayingLimits for overbought setups
  emaGate: {
    warningThreshold: 1.0,            // was 1.5 — penalty kicks in sooner
    blockThreshold: 1.8,              // was 2.5 — hard block much tighter
    scorePenalty: 2.0                 // was 1.0 — stronger penalty
  }
};

export function ensureEntryPolicyState(state) {
  if (!state.pendingLimits || Array.isArray(state.pendingLimits)) state.pendingLimits = {};
  if (!state.decayingLimits || Array.isArray(state.decayingLimits)) state.decayingLimits = {};
  if (!state.pendingRetests || Array.isArray(state.pendingRetests)) state.pendingRetests = {};
  if (!state.cooldowns || Array.isArray(state.cooldowns)) state.cooldowns = {};
  if (!state.paperTrades || !Array.isArray(state.paperTrades)) state.paperTrades = [];
}

export function pruneEntryCooldowns(state, now = new Date()) {
  ensureEntryPolicyState(state);
  return pruneExpired(state.cooldowns, now);
}

export function cooldownDecision(state, symbol, now = new Date()) {
  ensureEntryPolicyState(state);
  return isOnCooldown(state.cooldowns, symbol, now);
}

export function applyEntryFilters(candidate, config = {}) {
  const policy = mergePolicy(config);
  const signalSet = getSignalSet(candidate);
  const filtered = {
    ...candidate,
    rawScore: candidate.rawScore ?? candidate.score,
    signalSet
  };

  if (!policy.enableEmaDistanceGate || !isTrendVsExtended(signalSet)) {
    return { action: "allow", candidate: filtered };
  }

  if (!Number.isFinite(filtered.ema21) || !Number.isFinite(filtered.atrVal) || filtered.atrVal <= 0) {
    return { action: "allow", candidate: filtered };
  }

  const effectiveGate = { ...policy.emaGate };
  if (candidate.setupType && candidate.setupType !== "mean-reversion") {
    effectiveGate.blockThreshold = Math.max(effectiveGate.blockThreshold, 3.0);
  }

  const gate = emaDistanceGate({
    currentPrice: filtered.price,
    ema21: filtered.ema21,
    atrVal: filtered.atrVal,
    signalSet,
    direction: filtered.signal,
    currentScore: filtered.adjustedScore ?? filtered.score,
    ...effectiveGate
  });

  if (!gate.allow) {
    return {
      action: "block",
      reason: gate.reason,
      details: { emaDistance: gate.emaDistance }
    };
  }

  if (gate.adjustedScore !== (filtered.adjustedScore ?? filtered.score)) {
    filtered.adjustedScore = Math.round(gate.adjustedScore * 10) / 10;
    filtered.reasons = [...(filtered.reasons || []), gate.reason];
    filtered._emaDistancePenalty = gate.reason;
    filtered.signalSet = getSignalSet(filtered);
  }

  return { action: "allow", candidate: filtered };
}

export function queueEntry(candidate, state, livePrices = {}, config = {}) {
  ensureEntryPolicyState(state);
  const policy = mergePolicy(config);
  const signalSet = getSignalSet(candidate);
  const currentPrice = Number(livePrices[candidate.symbol] || candidate.price);
  const effectiveScore = candidate.adjustedScore ?? candidate.score;

  const isOverbought = signalSet.includes("trend-vs-overbought") || signalSet.includes("trend-vs-oversold");
  const forceDecay = policy.forceDecayOnOverbought && isOverbought;
  const wantsLimitHandling = policy.enableLimitEntries || policy.enableDecayingLimits || forceDecay;
  if (!wantsLimitHandling || !Number.isFinite(candidate.atrVal) || candidate.atrVal <= 0) {
    return { action: "enter-market", candidate: { ...candidate, price: currentPrice } };
  }

  const withCurrentPrice = { ...candidate, price: currentPrice, score: effectiveScore, signalSet };

  if (policy.enableDecayingLimits || forceDecay) {
    const rec = recommendApproach({
      ...withCurrentPrice,
      direction: candidate.signal,
      setupType: normalizeSetupType(candidate.setupType)
    });

    // Force overbought setups through decaying limit regardless of recommendApproach result
    if (rec.approach === "decaying-limit" || forceDecay) {
      const order = createDecayingLimit({
        ...withCurrentPrice,
        direction: candidate.signal,
        currentPrice,
        setupType: normalizeSetupType(candidate.setupType),
        signalSet
      });
      order.candidate = sanitizeCandidate(withCurrentPrice);
      order.reason = forceDecay ? "forced-overbought-decay" : rec.reason;
      state.decayingLimits[candidate.symbol] = order;
      maybeQueueRetestPaper(candidate, state, signalSet);

      return {
        action: "queued-decaying-limit",
        symbol: candidate.symbol,
        reason: order.reason,
        limitPrice: order.limitPrice,
        maxCandles: order.offsets.length
      };
    }
  }

  if (!policy.enableLimitEntries) {
    return {
      action: "enter-market",
      candidate: withCurrentPrice,
      reason: "limit-entries-disabled"
    };
  }

  const entry = decideEntry({
    ...withCurrentPrice,
    direction: candidate.signal,
    setupType: normalizeSetupType(candidate.setupType)
  }, {
    currentPrice,
    ema21: candidate.ema21
  });

  if (entry.type === "market") {
    return {
      action: "enter-market",
      candidate: withCurrentPrice,
      reason: entry.reason
    };
  }

  const pending = createPendingLimit(withCurrentPrice, entry);
  pending.candidate = sanitizeCandidate(withCurrentPrice);
  pending.originalPrice = candidate.price;
  state.pendingLimits[candidate.symbol] = pending;

  maybeQueueRetestPaper(candidate, state, signalSet);

  return {
    action: "queued-limit",
    symbol: candidate.symbol,
    reason: entry.reason,
    limitPrice: entry.limitPrice,
    improvement: entry.improvement,
    maxCandles: entry.maxCandles,
    adjustments: entry.adjustments
  };
}

export function tickEntryPolicy(state, symbol, candle) {
  ensureEntryPolicyState(state);
  const decaying = state.decayingLimits[symbol];
  if (decaying) {
    const currentPrice = Number(candle.close || decaying.marketPriceAtSignal);
    const result = tickDecayingLimit(decaying, candle, currentPrice);
    state.decayingLimits[symbol] = result.order;

    if (result.action === "fill-limit" || result.action === "fill-market") {
      delete state.decayingLimits[symbol];
      const candidate = repriceCandidateForFill(result.order.candidate, result.fillPrice);
      candidate.entryType = result.action === "fill-limit" ? "decaying-limit" : "decaying-market";
      return {
        action: "fill",
        candidate,
        pending: result.order,
        fillPrice: result.fillPrice,
        fillType: candidate.entryType
      };
    }

    return { action: "wait", pending: result.order };
  }

  const pending = state.pendingLimits[symbol];
  if (!pending) return { action: "none" };

  const result = tickPendingLimit(pending, candle);
  state.pendingLimits[symbol] = result.pending;

  if (result.action === "fill") {
    delete state.pendingLimits[symbol];
    const candidate = repriceCandidateForFill(result.pending.candidate, result.fillPrice);
    return { action: "fill", candidate, pending: result.pending, fillPrice: result.fillPrice };
  }

  if (result.action === "cancel") {
    delete state.pendingLimits[symbol];
    return { action: "cancel", pending: result.pending, reason: result.reason };
  }

  return { action: "wait", pending: result.pending };
}

export function tickRetestPaper(state, symbol, candle) {
  ensureEntryPolicyState(state);
  const retest = state.pendingRetests[symbol];
  if (!retest) return { action: "none" };

  const result = evaluateRetest(retest, candle.high, candle.low, candle.close);
  state.pendingRetests[symbol] = result.retest;

  if (result.action === "enter") {
    delete state.pendingRetests[symbol];
    state.paperTrades.push({
      symbol,
      direction: retest.direction,
      entryType: "break-and-retest-paper",
      entryPrice: result.entryPrice,
      score: retest.score,
      signalSet: [...(retest.signalSet || [])],
      createdAt: retest.createdAt,
      filledAt: retest.filledAt,
      candlesWaited: retest.candlesElapsed
    });
  }

  if (result.action === "cancel") {
    delete state.pendingRetests[symbol];
  }

  return result;
}

export function pendingEntrySymbols(state) {
  ensureEntryPolicyState(state);
  return [...new Set([
    ...Object.keys(state.pendingLimits),
    ...Object.keys(state.decayingLimits),
    ...Object.keys(state.pendingRetests)
  ])];
}

function mergePolicy(config) {
  return {
    ...DEFAULT_POLICY,
    ...config,
    emaGate: {
      ...DEFAULT_POLICY.emaGate,
      ...(config.emaGate || {})
    }
  };
}

function getSignalSet(candidate) {
  return [...new Set([...(candidate.signalSet || []), ...(candidate.reasons || [])])];
}

function isTrendVsExtended(signalSet) {
  return signalSet.includes("trend-vs-overbought") || signalSet.includes("trend-vs-oversold");
}

function normalizeSetupType(setupType) {
  if (setupType === "bull-pullback") return "trend";
  return setupType || "unknown";
}

function sanitizeCandidate(candidate) {
  return JSON.parse(JSON.stringify(candidate));
}

function maybeQueueRetestPaper(candidate, state, signalSet) {
  if (!DEFAULT_POLICY.enableRetestPaper || !isTrendVsExtended(signalSet)) return;
  const retest = createPendingRetest({
    symbol: candidate.symbol,
    direction: candidate.signal,
    candleHigh: candidate.signalCandleHigh,
    candleLow: candidate.signalCandleLow,
    candleClose: candidate.signalCandleClose,
    signalSet,
    score: candidate.adjustedScore ?? candidate.score,
    atrVal: candidate.atrVal,
    leverage: candidate.leverage || null,
    paperMode: true
  });
  if (retest) state.pendingRetests[candidate.symbol] = retest;
}

function repriceCandidateForFill(candidate, fillPrice) {
  const originalPrice = Number(candidate.price);
  const adjusted = { ...candidate, price: fillPrice, entryType: "limit" };

  if (!Number.isFinite(originalPrice) || originalPrice <= 0) return adjusted;

  const slDist = Math.abs(originalPrice - Number(candidate.sl));
  const tpDist = Math.abs(Number(candidate.tp) - originalPrice);

  if (Number.isFinite(slDist) && slDist > 0) {
    adjusted.sl = candidate.signal === "long" ? fillPrice - slDist : fillPrice + slDist;
  }
  if (Number.isFinite(tpDist) && tpDist > 0) {
    adjusted.tp = candidate.signal === "long" ? fillPrice + tpDist : fillPrice - tpDist;
  }

  return adjusted;
}
