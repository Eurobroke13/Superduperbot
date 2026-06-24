import {
  ATR_SL_MULT,
  CHANDELIER_ATR_MULT,
  STRUCTURE_TRAIL_BUFFER_ATR,
  CHANDELIER_MIN_PROFIT_ATR
} from "./config.js";

// Recent swing highs/lows from a candle series — lightweight S/R for the trail.
// A bar is a pivot high if its high is the local max over ±span bars (mirror for
// lows). Returns a flat, de-duplicated price array; the trail filters by side.
export function recentSwingLevels(highs, lows, { span = 2, lookback = 40 } = {}) {
  const levels = [];
  const n = highs.length;
  const start = Math.max(span, n - lookback);
  for (let i = start; i < n - span; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isHigh = false;
      if (lows[j]  <= lows[i])  isLow = false;
    }
    if (isHigh) levels.push(highs[i]);
    if (isLow)  levels.push(lows[i]);
  }
  return levels;
}

// Structure-aware chandelier trailing stop. Mutates pos.sl, only ever tightening.
// Engages once the trade is CHANDELIER_MIN_PROFIT_ATR onside. The chandelier
// (peak − N×ATR) is the floor; the nearest cleared swing level pulls the stop up
// to just beyond structure when that is more protective. Safe with empty srLevels
// (chandelier-only) and with atr<=0 (no-op).
export function applyStructureChandelierTrail(pos, price, currentAtr, srLevels = []) {
  if (!pos || !(currentAtr > 0)) return;
  const { direction, entryPrice } = pos;
  const profitATRs = direction === "long"
    ? (price - entryPrice) / currentAtr
    : (entryPrice - price) / currentAtr;
  if (profitATRs < CHANDELIER_MIN_PROFIT_ATR) return;

  if (direction === "long") {
    let stop = pos.maxFavorable - currentAtr * CHANDELIER_ATR_MULT;
    const below = (srLevels || []).filter(l => Number.isFinite(l) && l < price);
    if (below.length) {
      stop = Math.max(stop, Math.max(...below) - currentAtr * STRUCTURE_TRAIL_BUFFER_ATR);
    }
    if (stop < price && stop > pos.sl) pos.sl = stop;
  } else {
    let stop = pos.maxFavorable + currentAtr * CHANDELIER_ATR_MULT;
    const above = (srLevels || []).filter(l => Number.isFinite(l) && l > price);
    if (above.length) {
      stop = Math.min(stop, Math.min(...above) + currentAtr * STRUCTURE_TRAIL_BUFFER_ATR);
    }
    if (stop > price && stop < pos.sl) pos.sl = stop;
  }
}
import { registerExit, registerOverboughtExit } from "./cooldown.js";

/**
 * Buffer a closed trade for atomic persistence. saveState() flushes
 * state._pendingTrades together with the state blob in one transaction,
 * so the trade and the position-removal/cash-update always land together.
 */
function bufferTrade(state, tradeRecord) {
  if (!Array.isArray(state._pendingTrades)) state._pendingTrades = [];
  state._pendingTrades.push(tradeRecord);
}

const EXECUTION_LOG_LIMIT = 150;

/**
 * Check bear short-specific exit conditions
 * - 16h with < 0.5 ATR profit: time-expired
 * - 10h underwater: reversal stop
 * - 0.5+ ATR profit: trail stop to 0.1 ATR
 */
export function checkBearShortExit(pos, price, currentAtr, hoursOpen) {
  if (pos.direction !== "short" || pos._bearRegime !== true) {
    return { exit: false, partial: false };
  }

  const profitATRs = currentAtr > 0 ? (pos.entryPrice - price) / currentAtr : 0;

  // Rule 1: 16h with < 0.5 ATR profit in bear, exit (setup failed)
  if (hoursOpen >= 16 && profitATRs < 0.5) {
    return { exit: true, reason: "bear-short-time-expired" };
  }

  // Rule 2: 10h underwater, exit (reversal = stop)
  if (hoursOpen >= 10 && profitATRs < 0) {
    return { exit: true, reason: "bear-short-underwater-10h" };
  }

  // Rule 3: 0.5 ATR profit, trail stop to 0.1 ATR
  if (profitATRs >= 0.5) {
    const trail = price + currentAtr * 0.1;  // short: trail above
    if (trail < pos.sl) {  // only tighten, never loosen
      pos.sl = trail;
    }
  }

  return { exit: false, partial: false };
}

function roundValue(value, digits = 6) {
  return Number.isFinite(value) ? parseFloat(value.toFixed(digits)) : value;
}

function pushExecutionEvent(state, event) {
  if (!state.executionLog) state.executionLog = [];
  state.executionLog.push({
    timestamp: new Date().toISOString(),
    ...event
  });
  if (state.executionLog.length > EXECUTION_LOG_LIMIT) {
    state.executionLog = state.executionLog.slice(-EXECUTION_LOG_LIMIT);
  }
}

export function checkGraduatedExit(pos, price, high, low, currentAtr, srLevels = []) {
  const { direction, entryPrice } = pos;
  if (!pos.maxFavorable) pos.maxFavorable = entryPrice;
  const entryAtr = pos.atrVal || currentAtr;

  if (!pos.tpLevels) {
    pos.tpLevels = {
      tp1: {
        atrMult: 2.0,
        pct: 0.30,
        hit: false,
        price: direction === "long"
          ? entryPrice + entryAtr * 2.0
          : entryPrice - entryAtr * 2.0
      },
      tp2: {
        atrMult: 3.5,
        pct: 0.30,
        hit: false,
        price: direction === "long"
          ? entryPrice + entryAtr * 3.5
          : entryPrice - entryAtr * 3.5
      },
      tp3: {
        // Explicit runner target for the final 40%, so the last tranche books a
        // real profit instead of rotting until the trail clips it. pos.tp3AtrMult
        // may be set at entry per-regime; default 5.5x ATR (≈1.57x the TP2 distance).
        atrMult: pos.tp3AtrMult || 5.5,
        pct: 0.40,
        hit: false,
        price: direction === "long"
          ? entryPrice + entryAtr * (pos.tp3AtrMult || 5.5)
          : entryPrice - entryAtr * (pos.tp3AtrMult || 5.5)
      }
    };
  }

  const partialCloses = [];

  if (direction === "long") {
    pos.maxFavorable = Math.max(pos.maxFavorable, price);
    applyStructureChandelierTrail(pos, price, currentAtr, srLevels);

    if (low <= pos.sl) return { exit: true, reason: "stop-loss", partial: false };
    if (pos.liquidationPrice && low <= pos.liquidationPrice) {
      return { exit: true, reason: "liquidation", partial: false };
    }

    if (!pos.tpLevels.tp1.hit && high >= pos.tpLevels.tp1.price) {
      pos.tpLevels.tp1.hit = true;
      partialCloses.push({ pct: pos.tpLevels.tp1.pct, reason: "tp1-2xATR" });
      pos.sl = Math.max(pos.sl, entryPrice + currentAtr * 0.1);
    }

    if (!pos.tpLevels.tp2.hit && high >= pos.tpLevels.tp2.price) {
      pos.tpLevels.tp2.hit = true;
      partialCloses.push({ pct: pos.tpLevels.tp2.pct, reason: "tp2-3.5xATR" });
      pos.sl = Math.max(pos.sl, pos.tpLevels.tp1.price);
    }

    const profitATRs = currentAtr > 0 ? (price - entryPrice) / currentAtr : 0;

    if (pos.tpLevels.tp1.hit && pos.tpLevels.tp2.hit && !pos.tpLevels.tp3.hit) {
      const trailDistance = currentAtr * Math.max(0.6, 1.2 - (profitATRs - 3.5) * 0.15);
      pos.sl = Math.max(pos.sl, pos.maxFavorable - trailDistance);

      if (pos.tpLevels.tp2.price) {
        pos.sl = Math.max(pos.sl, pos.tpLevels.tp2.price);
      }
    }

    if (profitATRs > 3 && !pos.tpLevels.tp1.hit) {
      const trail = currentAtr * Math.max(1.0, ATR_SL_MULT - (profitATRs - 3) * 0.2);
      pos.sl = Math.max(pos.sl, pos.maxFavorable - trail);
    }

    const hours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
    if (hours > 48 && profitATRs > 1) {
      pos.sl = Math.max(pos.sl, entryPrice + currentAtr * 0.5);
    }
    if (pos.setupType === "mean-reversion" && hours > 8 && profitATRs < 0.5) {
      return { exit: true, reason: "mr-time-expired", partial: false };
    }

    if (pos.tp && high >= pos.tp) {
      return { exit: true, reason: "take-profit-full", partial: false };
    }

    // Runner's fallback target: once TP1+TP2 are booked, take the final 40% at
    // an explicit ATR target rather than letting it rot until the trail clips it.
    // Structured pos.tp above takes precedence when it's the nearer target.
    if (pos.tpLevels.tp1.hit && pos.tpLevels.tp2.hit && !pos.tpLevels.tp3.hit &&
        pos.tpLevels.tp3.price && high >= pos.tpLevels.tp3.price) {
      pos.tpLevels.tp3.hit = true;
      return { exit: true, reason: "tp3-target", partial: false };
    }
  } else {
    pos.maxFavorable = Math.min(pos.maxFavorable, price);
    applyStructureChandelierTrail(pos, price, currentAtr, srLevels);

    if (high >= pos.sl) return { exit: true, reason: "stop-loss", partial: false };
    if (pos.liquidationPrice && high >= pos.liquidationPrice) {
      return { exit: true, reason: "liquidation", partial: false };
    }

    if (!pos.tpLevels.tp1.hit && low <= pos.tpLevels.tp1.price) {
      pos.tpLevels.tp1.hit = true;
      partialCloses.push({ pct: pos.tpLevels.tp1.pct, reason: "tp1-2xATR" });
      pos.sl = Math.min(pos.sl, entryPrice - currentAtr * 0.1);
    }

    if (!pos.tpLevels.tp2.hit && low <= pos.tpLevels.tp2.price) {
      pos.tpLevels.tp2.hit = true;
      partialCloses.push({ pct: pos.tpLevels.tp2.pct, reason: "tp2-3.5xATR" });
      pos.sl = Math.min(pos.sl, pos.tpLevels.tp1.price);
    }

    const profitATRs = currentAtr > 0 ? (entryPrice - price) / currentAtr : 0;

    if (pos.tpLevels.tp1.hit && pos.tpLevels.tp2.hit && !pos.tpLevels.tp3.hit) {
      const trailDistance = currentAtr * Math.max(0.6, 1.2 - (profitATRs - 3.5) * 0.15);
      pos.sl = Math.min(pos.sl, pos.maxFavorable + trailDistance);

      if (pos.tpLevels.tp2.price) {
        pos.sl = Math.min(pos.sl, pos.tpLevels.tp2.price);
      }
    }

    if (profitATRs > 3 && !pos.tpLevels.tp1.hit) {
      const trail = currentAtr * Math.max(1.0, ATR_SL_MULT - (profitATRs - 3) * 0.2);
      pos.sl = Math.min(pos.sl, pos.maxFavorable + trail);
    }

    const hours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
    if (hours > 48 && profitATRs > 1) {
      pos.sl = Math.min(pos.sl, entryPrice - currentAtr * 0.5);
    }
    if (pos.setupType === "mean-reversion" && hours > 8 && profitATRs < 0.5) {
      return { exit: true, reason: "mr-time-expired", partial: false };
    }

    if (pos.tp && low <= pos.tp) {
      return { exit: true, reason: "take-profit-full", partial: false };
    }

    // Runner's fallback target: once TP1+TP2 are booked, take the final 40% at
    // an explicit ATR target rather than letting it rot until the trail clips it.
    // Structured pos.tp above takes precedence when it's the nearer target.
    if (pos.tpLevels.tp1.hit && pos.tpLevels.tp2.hit && !pos.tpLevels.tp3.hit &&
        pos.tpLevels.tp3.price && low <= pos.tpLevels.tp3.price) {
      pos.tpLevels.tp3.hit = true;
      return { exit: true, reason: "tp3-target", partial: false };
    }
  }

  if (partialCloses.length > 0) {
    return { exit: false, partial: true, partialCloses };
  }

  return { exit: false, partial: false };
}

export function executePartialClose(symbol, price, pct, reason, pos, state, deps = {}) {
  const { updateCoinHistory = () => {}, updateDynamicWeights = () => {}, updateRegimeStats = () => {} } = deps;

  const closeSize = pos.size * pct;
  const closeNotional = pos.notional * pct;
  const rawPnl = pos.direction === "long"
    ? (price - pos.entryPrice) * closeSize
    : (pos.entryPrice - price) * closeSize;
  const clampPnl = Math.max(rawPnl, -closeNotional);
  const pnlPct = closeNotional > 0 ? (clampPnl / closeNotional) * 100 : 0;
  const holdHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;

  state.cash += closeNotional + clampPnl;

  pos.size -= closeSize;
  pos.notional -= closeNotional;
  pos.effectiveExposure = pos.notional * pos.leverage;

  state.trades.push({
    symbol,
    direction: pos.direction,
    entryPrice: pos.entryPrice,
    exitPrice: price,
    size: closeSize,
    leverage: pos.leverage,
    notional: closeNotional,
    pnl: parseFloat(clampPnl.toFixed(6)),
    pnlPct: parseFloat(pnlPct.toFixed(2)),
    reason: `partial-${reason}`,
    openedAt: pos.openedAt,
    closedAt: new Date().toISOString(),
    score: pos.score,
    reasons: [...(pos.reasons || [])],
    setupType: pos.setupType || "unknown",
    approvalType: pos.approvalType || "unknown",
    signalSet: [...(pos.signalSet || [])],
    h4Trend: pos.h4Trend || "unknown",
    holdHours: parseFloat(holdHours.toFixed(2)),
    journal: null,
    wasLiquidated: false,
    isPartial: true,
    partialPct: pct
  });
  state.trades[state.trades.length - 1].regime = state.lastRegime?.label || "unknown";

  const tradeRecord = state.trades[state.trades.length - 1];
  bufferTrade(state, tradeRecord);
  updateCoinHistory(state, symbol, tradeRecord);
  updateRegimeStats(state, tradeRecord);
  registerExit(state.cooldowns || (state.cooldowns = {}), {
    symbol,
    reason: tradeRecord.reason,
    closedAt: tradeRecord.closedAt
  });

  console.log(
    `📊 [${symbol}] PARTIAL CLOSE ${(pct * 100).toFixed(0)}% @$${price.toFixed(6)} | ` +
    `PnL:$${clampPnl.toFixed(2)} (${pnlPct.toFixed(1)}%) | ${reason} | Remaining:$${pos.notional.toFixed(2)}`
  );
  pushExecutionEvent(state, {
    type: "partial-close",
    symbol,
    direction: pos.direction,
    exitPrice: roundValue(price),
    closePct: roundValue(pct, 3),
    closedNotional: roundValue(closeNotional, 2),
    remainingNotional: roundValue(pos.notional, 2),
    remainingSize: roundValue(pos.size),
    pnl: roundValue(clampPnl),
    pnlPct: roundValue(pnlPct, 2),
    reason,
    setupType: pos.setupType || "unknown",
    approvalType: pos.approvalType || "unknown",
    holdHours: roundValue((Date.now() - new Date(pos.openedAt).getTime()) / 3600000, 2),
    cashAfter: roundValue(state.cash, 2)
  });
  updateDynamicWeights(state);
}

export function closePosition(symbol, price, reason, pos, state, journal, deps = {}) {
  const { updateCoinHistory = () => {}, updateDynamicWeights = () => {}, updateRegimeStats = () => {} } = deps;

  const rawPnl = pos.direction === "long"
    ? (price - pos.entryPrice) * pos.size
    : (pos.entryPrice - price) * pos.size;
  const clampPnl = Math.max(rawPnl, -pos.notional);
  const pnlPct = pos.notional > 0 ? (clampPnl / pos.notional) * 100 : 0;
  const holdHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;

  state.cash += pos.notional + clampPnl;

  state.trades.push({
    symbol,
    direction: pos.direction,
    entryPrice: pos.entryPrice,
    exitPrice: price,
    size: pos.size,
    leverage: pos.leverage,
    notional: pos.notional,
    pnl: parseFloat(clampPnl.toFixed(6)),
    pnlPct: parseFloat(pnlPct.toFixed(2)),
    reason,
    openedAt: pos.openedAt,
    closedAt: new Date().toISOString(),
    setupType: pos.setupType || "unknown",
    approvalType: pos.approvalType || "unknown",
    reasons: [...(pos.reasons || [])],
    signalSet: [...(pos.signalSet || [])],
    holdHours: parseFloat(holdHours.toFixed(2)),
    score: pos.score,
    h4Trend: pos.h4Trend || "unknown",
    atrVal: pos.atrVal,
    riskReward: pos.riskReward,
    journal: journal || null,
    wasLiquidated: rawPnl <= -pos.notional
  });
  state.trades[state.trades.length - 1].regime = state.lastRegime?.label || "unknown";

  const tradeRecord = state.trades[state.trades.length - 1];
  bufferTrade(state, tradeRecord);
  updateCoinHistory(state, symbol, tradeRecord);
  updateRegimeStats(state, tradeRecord);
  const cooldowns = state.cooldowns || (state.cooldowns = {});
  const cooldown = registerExit(cooldowns, {
    symbol,
    reason: tradeRecord.reason,
    closedAt: tradeRecord.closedAt
  });
  if (cooldown.applied) {
    console.log(`[COOLDOWN] ${cooldown.symbol} -> ${cooldown.reason}`);
  }
  // Overbought SL cooldown: prevent re-entering same symbol after stop-loss on overbought signal
  const obCooldown = registerOverboughtExit(cooldowns, {
    symbol,
    reason: tradeRecord.reason,
    closedAt: tradeRecord.closedAt,
    reasons: tradeRecord.reasons || []
  });
  if (obCooldown.applied) {
    console.log(`[OB-COOLDOWN] ${obCooldown.symbol} -> ${obCooldown.reason}`);
  }
  delete state.positions[symbol];
  updateDynamicWeights(state);

  const icon = clampPnl >= 0 ? "✅" : "❌";
  console.log(
    `${icon} [${symbol}] CLOSE ${pos.direction.toUpperCase()} @$${price.toFixed(6)} | ` +
    `PnL:$${clampPnl.toFixed(2)} (${pnlPct.toFixed(1)}%) | ${reason}` +
    `${rawPnl <= -pos.notional ? " ⚠LIQUIDATED" : ""}`
  );
  pushExecutionEvent(state, {
    type: "close",
    symbol,
    direction: pos.direction,
    entryPrice: roundValue(pos.entryPrice),
    exitPrice: roundValue(price),
    size: roundValue(pos.size),
    leverage: pos.leverage,
    notional: roundValue(pos.notional, 2),
    pnl: roundValue(clampPnl),
    pnlPct: roundValue(pnlPct, 2),
    holdHours: roundValue(holdHours, 2),
    reason,
    setupType: pos.setupType || "unknown",
    approvalType: pos.approvalType || "unknown",
    score: roundValue(pos.score, 3),
    reasons: [...(pos.reasons || [])],
    wasLiquidated: rawPnl <= -pos.notional,
    cashAfter: roundValue(state.cash, 2)
  });
}
