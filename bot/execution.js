import {
  ATR_SL_MULT,
  DRAWDOWN_LIMIT,
  MAX_POSITION_SHARE,
  RISK_PCT
} from "./config.js";
import {
  getAdaptiveSetupDecision,
  getApprovalRiskMultiplier,
  getApprovalStats,
  getSetupRiskMultiplier,
  getSymbolRiskDecision
} from "./stats.js";
import { fetchCandles } from "./market-data.js";
import { ichimoku, macd, rsiSeries, vwap } from "./indicators.js";

const EXECUTION_LOG_LIMIT = 150;

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

export function portfolioValue(state, livePrices = null) {
  let unrealizedPnl = 0;
  for (const pos of Object.values(state.positions)) {
    const currentPrice = livePrices ? livePrices[pos.symbol] : null;
    if (currentPrice) {
      const rawPnl = pos.direction === "long"
        ? (currentPrice - pos.entryPrice) * pos.size
        : (pos.entryPrice - currentPrice) * pos.size;
      unrealizedPnl += Math.max(rawPnl, -pos.notional);
    }
  }
  const reserved = Object.values(state.positions).reduce((sum, pos) => sum + pos.notional, 0);
  return state.cash + reserved + unrealizedPnl;
}

export function openPositionGradual(candidate, state, livePrices = null, env = null, deps = {}) {
  const { sendTelegram = () => Promise.resolve() } = deps;
  const {
    symbol,
    signal,
    price,
    sl,
    tp,
    atrVal,
    riskReward,
    score,
    reasons,
    setupType = "unknown",
    approvalType = "auto"
  } = candidate;

  const currVal = portfolioValue(state, livePrices);
  if (!state.peakValue || currVal > state.peakValue) state.peakValue = currVal;
  const drawdown = (state.peakValue - currVal) / state.peakValue;
  state.drawdown = drawdown;
  if (drawdown >= DRAWDOWN_LIMIT) {
    if (!state.circuitBreakerActive) {
      state.circuitBreakerActive = true;
      console.warn(`[CIRCUIT] DD ${(drawdown * 100).toFixed(1)}% — halting entries`);
      sendTelegram(
        `⚠️ CIRCUIT BREAKER ACTIVE\nDrawdown: ${(drawdown * 100).toFixed(1)}%\nNo new entries until portfolio recovers.`,
        env
      ).catch(() => {});
    }
    return {
      opened: false,
      reason: "circuit-breaker",
      details: {
        drawdown: roundValue(drawdown, 4),
        portfolioValue: roundValue(currVal, 2)
      }
    };
  }
  state.circuitBreakerActive = false;

  // --- Max positions per setup type (prevents setup-type spam) ---
  const MAX_PER_SETUP = 2;
  const sameSetupCount = Object.values(state.positions)
    .filter(p => p.setupType === setupType).length;
  if (sameSetupCount >= MAX_PER_SETUP) {
    console.log(`[${symbol}] Skipped: ${sameSetupCount} open ${setupType} positions (max ${MAX_PER_SETUP})`);
    return {
      opened: false,
      reason: "setup-concentration-limit",
      details: { setupType, openCount: sameSetupCount, max: MAX_PER_SETUP }
    };
  }

  const leverage = score >= 8 ? 6
    : score >= 7 ? 5
      : score >= 6 ? 4
        : score >= 5 ? 3
          : 2;

  const setupDecision = getAdaptiveSetupDecision(state, setupType);
  if (!setupDecision.allow) {
    console.log(`[${symbol}] Skipped: setup blocked (${setupType}) ${setupDecision.reason}`);
    return {
      opened: false,
      reason: "setup-blocked",
      details: {
        setupType,
        setupDecision: setupDecision.reason
      }
    };
  }

  const symbolDecision = getSymbolRiskDecision(state, symbol);
  if (!symbolDecision.allow) {
    console.log(`[${symbol}] Skipped: ${symbolDecision.reason}`);
    return {
      opened: false,
      reason: "symbol-blocked",
      details: {
        symbolDecision: symbolDecision.reason
      }
    };
  }

  let sizeMultiplier = setupDecision.sizeMult;
  console.log(
    `[${symbol}] Setup decision (${setupType}) -> allow=${setupDecision.allow} ` +
    `sizeMult=${setupDecision.sizeMult.toFixed(2)} ${setupDecision.reason}`
  );
  if (symbolDecision.sizeMult !== 1.0) {
    console.log(
      `[${symbol}] Symbol decision -> sizeMult=${symbolDecision.sizeMult.toFixed(2)} ${symbolDecision.reason}`
    );
  }
  sizeMultiplier *= symbolDecision.sizeMult;

  if (setupType === "breakout") sizeMultiplier *= 1.15;
  else if (setupType === "liquidity-trap") sizeMultiplier *= 1.0;
  else if (setupType === "mean-reversion") sizeMultiplier *= 0.85;

  if (drawdown > 0.10) sizeMultiplier *= 0.7;

  const setupRiskMult = getSetupRiskMultiplier(state, setupType);
  const approvalRiskMult = getApprovalRiskMultiplier(state, approvalType);
  const combinedRiskMult = setupRiskMult * approvalRiskMult * sizeMultiplier;
  const adjustedRiskPct = Math.max(
    0.01,
    Math.min(RISK_PCT * combinedRiskMult, 0.05)
  );

  const approvalStats = getApprovalStats(state.trades, approvalType);
  if (approvalStats && approvalStats.count >= 20) {
    console.log(
      `[${symbol}] approval=${approvalType} n=${approvalStats.count} ` +
      `EV=${approvalStats.expectancy.toFixed(2)} mult=${approvalRiskMult.toFixed(2)}`
    );
  }

  const riskAmount = currVal * adjustedRiskPct;
  const slDist = Math.abs(price - sl);
  if (slDist === 0) {
    return {
      opened: false,
      reason: "invalid-stop-distance",
      details: {
        price: roundValue(price),
        sl: roundValue(sl)
      }
    };
  }

  let totalSize = riskAmount / slDist;
  let totalNotional = totalSize * price;
  const maxNotional = currVal * MAX_POSITION_SHARE;
  if (totalNotional > maxNotional) {
    totalNotional = maxNotional;
    totalSize = totalNotional / price;
  }

  const tranche1Pct = 0.40;
  const tranche1Notional = totalNotional * tranche1Pct;
  const tranche1Size = totalSize * tranche1Pct * leverage;

  if (tranche1Notional > state.cash) {
    console.log(`[${symbol}] Cash too low ($${state.cash.toFixed(2)} < $${tranche1Notional.toFixed(2)})`);
    return {
      opened: false,
      reason: "cash-too-low",
      details: {
        cash: roundValue(state.cash, 2),
        needed: roundValue(tranche1Notional, 2)
      }
    };
  }

  const liqPrice = signal === "long"
    ? price * (1 - 1 / leverage + 0.005)
    : price * (1 + 1 / leverage - 0.005);

  const tranche2Trigger = signal === "long"
    ? price + atrVal * 0.5
    : price - atrVal * 0.5;
  const tranche3Trigger = signal === "long"
    ? price + atrVal * 1.5
    : price - atrVal * 1.5;

  state.cash -= tranche1Notional;

  state.positions[symbol] = {
    symbol,
    direction: signal,
    entryPrice: price,
    size: tranche1Size,
    notional: tranche1Notional,
    effectiveExposure: tranche1Notional * leverage,
    leverage,
    sl,
    tp,
    atrVal,
    riskReward,
    score,
    reasons: [...(reasons || [])],
    setupType,
    approvalType,
    signalSet: [...new Set((reasons || []).slice().sort())],
    lunarSentiment: candidate.lunarSentiment ?? null,
    lunarGalaxyScore: candidate.lunarGalaxyScore ?? null,
    liquidationPrice: liqPrice,
    maxFavorable: price,
    forceClose: false,
    openedAt: new Date().toISOString(),
    tranches: {
      plan: {
        totalSize: totalSize * leverage,
        totalNotional,
        tranche1: { pct: 0.40, filled: true, price, size: tranche1Size, notional: tranche1Notional },
        tranche2: { pct: 0.35, filled: false, triggerPrice: tranche2Trigger, size: 0, notional: 0 },
        tranche3: { pct: 0.25, filled: false, triggerPrice: tranche3Trigger, size: 0, notional: 0 }
      },
      filledCount: 1,
      avgEntryPrice: price
    },
    tpLevels: {
      tp1: {
        atrMult: 2.0,
        pct: 0.30,
        hit: false,
        price: signal === "long" ? price + atrVal * 2.0 : price - atrVal * 2.0
      },
      tp2: {
        atrMult: 3.5,
        pct: 0.30,
        hit: false,
        price: signal === "long" ? price + atrVal * 3.5 : price - atrVal * 3.5
      },
      tp3: {
        pct: 0.40,
        hit: false
      }
    },
    dcaApplied: false
  };

  console.log(
    `🟢 [${symbol}] OPEN ${signal.toUpperCase()} T1/3 @$${price.toFixed(6)} | ` +
    `$${tranche1Notional.toFixed(2)} margin (40% of $${totalNotional.toFixed(2)}) | ` +
    `T2@$${tranche2Trigger.toFixed(6)} T3@$${tranche3Trigger.toFixed(6)} | ` +
    `Score:${score} [${reasons.join(",")}]`
  );
  pushExecutionEvent(state, {
    type: "open",
    symbol,
    direction: signal,
    setupType,
    approvalType,
    requestedEntryPrice: roundValue(price),
    filledEntryPrice: roundValue(price),
    initialMargin: roundValue(tranche1Notional, 2),
    plannedTotalMargin: roundValue(totalNotional, 2),
    requestedSize: roundValue(totalSize * leverage),
    filledSize: roundValue(tranche1Size),
    leverage,
    sl: roundValue(sl),
    tp: roundValue(tp),
    atrVal: roundValue(atrVal),
    score: roundValue(score, 3),
    riskAmount: roundValue(riskAmount, 2),
    adjustedRiskPct: roundValue(adjustedRiskPct, 4),
    setupDecision: setupDecision.reason,
    symbolDecision: symbolDecision.reason,
    reasons: [...(reasons || [])],
    cashAfter: roundValue(state.cash, 2)
  });
  return {
    opened: true,
    reason: "opened",
    details: {
      leverage,
      initialMargin: roundValue(tranche1Notional, 2),
      plannedTotalMargin: roundValue(totalNotional, 2),
      adjustedRiskPct: roundValue(adjustedRiskPct, 4)
    }
  };
}

export function checkTranches(pos, price, state) {
  if (!pos.tranches) return;

  const plan = pos.tranches.plan;

  if (!plan.tranche2.filled) {
    const triggered = pos.direction === "long"
      ? price >= plan.tranche2.triggerPrice
      : price <= plan.tranche2.triggerPrice;

    if (triggered) {
      const t2Notional = plan.totalNotional * plan.tranche2.pct;
      const t2Size = plan.totalSize * plan.tranche2.pct;

      if (t2Notional <= state.cash) {
        state.cash -= t2Notional;
        pos.size += t2Size;
        pos.notional += t2Notional;
        pos.effectiveExposure = pos.notional * pos.leverage;

        plan.tranche2.filled = true;
        plan.tranche2.price = price;
        plan.tranche2.size = t2Size;
        plan.tranche2.notional = t2Notional;
        pos.tranches.filledCount = 2;

        const t1 = plan.tranche1;
        const t2 = plan.tranche2;
        pos.tranches.avgEntryPrice = (t1.price * t1.size + t2.price * t2.size) / (t1.size + t2.size);
        pos.entryPrice = pos.tranches.avgEntryPrice;

        if (pos.direction === "long") {
          pos.sl = Math.max(pos.sl, plan.tranche1.price);
        } else {
          pos.sl = Math.min(pos.sl, plan.tranche1.price);
        }

        console.log(
          `📈 [${pos.symbol}] TRANCHE 2 filled @$${price.toFixed(6)} | ` +
          `+$${t2Notional.toFixed(2)} | Total:$${pos.notional.toFixed(2)} | SL→$${pos.sl.toFixed(6)}`
        );
        pushExecutionEvent(state, {
          type: "tranche-fill",
          symbol: pos.symbol,
          tranche: 2,
          direction: pos.direction,
          fillPrice: roundValue(price),
          addedMargin: roundValue(t2Notional, 2),
          totalMargin: roundValue(pos.notional, 2),
          totalSize: roundValue(pos.size),
          avgEntryPrice: roundValue(pos.entryPrice),
          sl: roundValue(pos.sl),
          cashAfter: roundValue(state.cash, 2)
        });
      }
    }
  }

  if (plan.tranche2.filled && !plan.tranche3.filled) {
    const triggered = pos.direction === "long"
      ? price >= plan.tranche3.triggerPrice
      : price <= plan.tranche3.triggerPrice;

    if (triggered) {
      const t3Notional = plan.totalNotional * plan.tranche3.pct;
      const t3Size = plan.totalSize * plan.tranche3.pct;

      if (t3Notional <= state.cash) {
        state.cash -= t3Notional;
        pos.size += t3Size;
        pos.notional += t3Notional;
        pos.effectiveExposure = pos.notional * pos.leverage;

        plan.tranche3.filled = true;
        plan.tranche3.price = price;
        plan.tranche3.size = t3Size;
        plan.tranche3.notional = t3Notional;
        pos.tranches.filledCount = 3;

        const sizes = [plan.tranche1, plan.tranche2, plan.tranche3].filter((tranche) => tranche.filled);
        const totalSize = sizes.reduce((sum, tranche) => sum + tranche.size, 0);
        pos.tranches.avgEntryPrice = sizes.reduce((sum, tranche) => sum + tranche.price * tranche.size, 0) / totalSize;
        pos.entryPrice = pos.tranches.avgEntryPrice;

        if (pos.direction === "long") {
          pos.sl = Math.max(pos.sl, plan.tranche1.price + pos.atrVal * 0.3);
        } else {
          pos.sl = Math.min(pos.sl, plan.tranche1.price - pos.atrVal * 0.3);
        }

        console.log(
          `📈 [${pos.symbol}] TRANCHE 3 filled @$${price.toFixed(6)} | ` +
          `FULL POSITION $${pos.notional.toFixed(2)} | SL→$${pos.sl.toFixed(6)}`
        );
        pushExecutionEvent(state, {
          type: "tranche-fill",
          symbol: pos.symbol,
          tranche: 3,
          direction: pos.direction,
          fillPrice: roundValue(price),
          addedMargin: roundValue(t3Notional, 2),
          totalMargin: roundValue(pos.notional, 2),
          totalSize: roundValue(pos.size),
          avgEntryPrice: roundValue(pos.entryPrice),
          sl: roundValue(pos.sl),
          cashAfter: roundValue(state.cash, 2)
        });
      }
    }
  }
}

export async function checkDCA(pos, price, currentAtr, state, env, deps = {}) {
  const { notifyTrade = async () => {} } = deps;

  if (pos.dcaApplied) return;

  const hoursOpen = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
  if (hoursOpen < 4) return;

  const loss = pos.direction === "long"
    ? pos.entryPrice - price
    : price - pos.entryPrice;
  const lossATRs = currentAtr > 0 ? loss / currentAtr : 0;
  if (lossATRs < 0.7 || lossATRs > 2.5) return;

  const currVal = portfolioValue(state);
  if (state.peakValue && (state.peakValue - currVal) / state.peakValue > 0.08) return;

  try {
    const candles = await fetchCandles(pos.symbol, "1h", 100);
    if (!candles || candles.length < 50) return;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);
    const n = closes.length;

    const rsiArr = rsiSeries(closes, 14);
    const rsiVal = rsiArr[n - 1];
    const vwapVal = vwap(highs, lows, closes, volumes, 24);
    const ichi = ichimoku(highs, lows, closes);
    const macdR = macd(closes);

    let confirmations = 0;
    const needed = 3;

    if (pos.direction === "long") {
      if (rsiVal < 40) confirmations++;
      if (price > vwapVal) confirmations++;
      if (ichi.tkCross > 0) confirmations++;
      if (macdR.histogram > 0) confirmations++;
      if (price > ichi.senkouA) confirmations++;
    } else {
      if (rsiVal > 60) confirmations++;
      if (price < vwapVal) confirmations++;
      if (ichi.tkCross < 0) confirmations++;
      if (macdR.histogram < 0) confirmations++;
      if (price < ichi.senkouA) confirmations++;
    }

    if (confirmations < needed) {
      console.log(`[DCA ${pos.symbol}] Signal invalidated (${confirmations}/${needed} confirmations). No DCA.`);
      return;
    }

    const dcaPct = 0.50;
    const oldSize = pos.size;
    const dcaSize = oldSize * dcaPct;
    const dcaNotional = pos.notional * dcaPct;

    if (dcaNotional > state.cash) {
      console.log(`[DCA ${pos.symbol}] Insufficient cash.`);
      return;
    }

    pos.entryPrice = (pos.entryPrice * oldSize + price * dcaSize) / (oldSize + dcaSize);

    state.cash -= dcaNotional;
    pos.notional += dcaNotional;
    pos.size += dcaSize;
    pos.effectiveExposure = pos.notional * pos.leverage;

    const newSlDist = currentAtr * ATR_SL_MULT;
    if (pos.direction === "long") {
      pos.sl = pos.entryPrice - newSlDist;
    } else {
      pos.sl = pos.entryPrice + newSlDist;
    }

    if (pos.tpLevels) {
      const entryAtr = pos.atrVal || currentAtr;
      if (!pos.tpLevels.tp1.hit) {
        pos.tpLevels.tp1.price = pos.direction === "long"
          ? pos.entryPrice + entryAtr * 2.0
          : pos.entryPrice - entryAtr * 2.0;
      }
      if (!pos.tpLevels.tp2.hit) {
        pos.tpLevels.tp2.price = pos.direction === "long"
          ? pos.entryPrice + entryAtr * 3.5
          : pos.entryPrice - entryAtr * 3.5;
      }
    }

    pos.dcaApplied = true;
    pos.dcaPrice = price;
    pos.dcaDate = new Date().toISOString();

    console.log(
      `📉 [${pos.symbol}] DCA +50% @$${price.toFixed(6)} | ` +
      `New avg:$${pos.entryPrice.toFixed(6)} | New SL:$${pos.sl.toFixed(6)} | Margin:$${pos.notional.toFixed(2)}`
    );
    pushExecutionEvent(state, {
      type: "dca",
      symbol: pos.symbol,
      direction: pos.direction,
      fillPrice: roundValue(price),
      newEntryPrice: roundValue(pos.entryPrice),
      totalMargin: roundValue(pos.notional, 2),
      totalSize: roundValue(pos.size),
      sl: roundValue(pos.sl),
      confirmations,
      cashAfter: roundValue(state.cash, 2)
    });

    await notifyTrade("DCA", {
      symbol: pos.symbol,
      direction: pos.direction,
      price,
      entryPrice: pos.entryPrice,
      notional: pos.notional
    }, state, env);
  } catch (err) {
    console.error(`[DCA ${pos.symbol}]`, err.message);
  }
}
