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
  getSetupRiskMultiplier
} from "./stats.js";
import { fetchCandles } from "./market-data.js";
import { ema, emaRibbon, ichimoku, macd, rsiSeries, vwap } from "./indicators.js";

function getTrancheDistribution(setupType, regime) {
  if ((setupType === "trend" || setupType === "bull-pullback") && regime?.label === "bull") {
    return { t1: 0.55, t2: 0.30, t3: 0.15, t2Mult: 0.4, t3Mult: 1.0 };
  }
  if (setupType === "breakout") {
    return { t1: 0.35, t2: 0.40, t3: 0.25, t2Mult: 0.7, t3Mult: 1.8 };
  }
  if (setupType === "liquidity-trap") {
    return { t1: 0.60, t2: 0.25, t3: 0.15, t2Mult: 0.6, t3Mult: 1.5 };
  }
  if (setupType === "mean-reversion") {
    return { t1: 0.50, t2: 0.30, t3: 0.20, t2Mult: 0.3, t3Mult: 0.8 };
  }
  return { t1: 0.40, t2: 0.35, t3: 0.25, t2Mult: 0.5, t3Mult: 1.5 };
}

function isTrancheTriggerConfirmed(pos, tranche, price, state) {
  const lastClose = state.lastClosePrices?.[pos.symbol];
  return pos.direction === "long"
    ? (Number.isFinite(lastClose) && lastClose >= tranche.triggerPrice) ||
      price >= tranche.triggerPrice * 1.002
    : (Number.isFinite(lastClose) && lastClose <= tranche.triggerPrice) ||
      price <= tranche.triggerPrice * 0.998;
}

async function isTrancheStillValid(pos) {
  try {
    const candles = await fetchCandles(pos.symbol, "1h", 50);
    if (!candles || candles.length < 30) return true;

    const closes = candles.map(c => c.close);
    const rsiArr = rsiSeries(closes, 14);
    const rsiVal = rsiArr[rsiArr.length - 1];
    const ribbon = emaRibbon(closes);

    if (pos.direction === "long") {
      return ribbon.bullishAligned && rsiVal < 75;
    }
    return ribbon.bearishAligned && rsiVal > 25;
  } catch (_) {
    return true;
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
    return false;
  }
  state.circuitBreakerActive = false;

  const leverage = score >= 8 ? 6
    : score >= 7 ? 5
      : score >= 6 ? 4
        : score >= 5 ? 3
          : 2;

  const setupDecision = getAdaptiveSetupDecision(state, setupType);
  if (!setupDecision.allow) {
    console.log(`[${symbol}] Skipped: setup blocked (${setupType}) ${setupDecision.reason}`);
    return false;
  }

  let sizeMultiplier = setupDecision.sizeMult;
  console.log(
    `[${symbol}] Setup decision (${setupType}) -> allow=${setupDecision.allow} ` +
    `sizeMult=${setupDecision.sizeMult.toFixed(2)} ${setupDecision.reason}`
  );

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
  if (slDist === 0) return false;

  let totalSize = riskAmount / slDist;
  let totalNotional = totalSize * price;
  const maxNotional = currVal * MAX_POSITION_SHARE;
  if (totalNotional > maxNotional) {
    totalNotional = maxNotional;
    totalSize = totalNotional / price;
  }

  const trancheDist = getTrancheDistribution(setupType, state.lastRegime);
  const tranche1Pct = trancheDist.t1;
  const tranche1Notional = totalNotional * tranche1Pct;
  const tranche1Size = totalSize * tranche1Pct * leverage;

  if (tranche1Notional > state.cash) {
    console.log(`[${symbol}] Cash too low ($${state.cash.toFixed(2)} < $${tranche1Notional.toFixed(2)})`);
    return false;
  }

  const liqPrice = signal === "long"
    ? price * (1 - 1 / leverage + 0.005)
    : price * (1 + 1 / leverage - 0.005);

  const tranche2Trigger = signal === "long"
    ? price + atrVal * trancheDist.t2Mult
    : price - atrVal * trancheDist.t2Mult;
  const tranche3Trigger = signal === "long"
    ? price + atrVal * trancheDist.t3Mult
    : price - atrVal * trancheDist.t3Mult;

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
        distribution: trancheDist,
        tranche1: { pct: trancheDist.t1, filled: true, price, size: tranche1Size, notional: tranche1Notional },
        tranche2: { pct: trancheDist.t2, filled: false, triggerPrice: tranche2Trigger, size: 0, notional: 0 },
        tranche3: { pct: trancheDist.t3, filled: false, triggerPrice: tranche3Trigger, size: 0, notional: 0 }
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
    `$${tranche1Notional.toFixed(2)} margin (${(trancheDist.t1 * 100).toFixed(0)}% of $${totalNotional.toFixed(2)}) | ` +
    `T2@$${tranche2Trigger.toFixed(6)} T3@$${tranche3Trigger.toFixed(6)} | ` +
    `Score:${score} [${reasons.join(",")}]`
  );
  return true;
}

function fillTranche(pos, price, state, trancheName) {
  const plan = pos.tranches.plan;
  const tranche = plan[trancheName];
  const trancheNumber = trancheName === "tranche2" ? 2 : 3;
  const trancheNotional = plan.totalNotional * tranche.pct;
  const trancheSize = plan.totalSize * tranche.pct;

  if (trancheNotional > state.cash) return false;

  state.cash -= trancheNotional;
  pos.size += trancheSize;
  pos.notional += trancheNotional;
  pos.effectiveExposure = pos.notional * pos.leverage;

  tranche.filled = true;
  tranche.price = price;
  tranche.size = trancheSize;
  tranche.notional = trancheNotional;
  pos.tranches.filledCount = trancheNumber;

  const filled = [plan.tranche1, plan.tranche2, plan.tranche3].filter(t => t.filled);
  const totalFilledSize = filled.reduce((sum, t) => sum + t.size, 0);
  pos.tranches.avgEntryPrice = filled.reduce((sum, t) => sum + t.price * t.size, 0) / totalFilledSize;
  pos.entryPrice = pos.tranches.avgEntryPrice;

  if (trancheName === "tranche2") {
    if (pos.direction === "long") {
      pos.sl = Math.max(pos.sl, plan.tranche1.price);
    } else {
      pos.sl = Math.min(pos.sl, plan.tranche1.price);
    }
  } else if (pos.direction === "long") {
    pos.sl = Math.max(pos.sl, plan.tranche1.price + pos.atrVal * 0.3);
  } else {
    pos.sl = Math.min(pos.sl, plan.tranche1.price - pos.atrVal * 0.3);
  }

  console.log(
    `📈 [${pos.symbol}] TRANCHE ${trancheNumber} filled @$${price.toFixed(6)} | ` +
    `+$${trancheNotional.toFixed(2)} | Total:$${pos.notional.toFixed(2)} | SL→$${pos.sl.toFixed(6)}`
  );
  return true;
}

export async function checkTranches(pos, price, state) {
  if (!pos.tranches) return;

  const plan = pos.tranches.plan;

  if (!plan.tranche2.filled) {
    if (isTrancheTriggerConfirmed(pos, plan.tranche2, price, state)) {
      if (!(await isTrancheStillValid(pos))) {
        console.log(`[${pos.symbol}] Tranche 2 skipped: setup no longer valid.`);
        return;
      }
      fillTranche(pos, price, state, "tranche2");
    }
  }

  if (plan.tranche2.filled && !plan.tranche3.filled) {
    if (isTrancheTriggerConfirmed(pos, plan.tranche3, price, state)) {
      if (!(await isTrancheStillValid(pos))) {
        console.log(`[${pos.symbol}] Tranche 3 skipped: setup no longer valid.`);
        return;
      }
      fillTranche(pos, price, state, "tranche3");
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
    const regime = state.lastRegime;
    if (regime?.label === "bear" && pos.direction === "long") return;
    if (regime?.label === "bull" && pos.direction === "short") return;

    const candles4h = await fetchCandles(pos.symbol, "4h", 60);
    if (candles4h && candles4h.length >= 50) {
      const c4 = candles4h.map(c => c.close);
      const e20 = ema(c4, 20);
      const e50 = ema(c4, 50);
      const last4 = c4.length - 1;
      const h4Bullish = e20[last4] > e50[last4] && c4[last4] > e20[last4];
      const h4Bearish = e20[last4] < e50[last4] && c4[last4] < e20[last4];

      if (pos.direction === "long" && h4Bearish) return;
      if (pos.direction === "short" && h4Bullish) return;
    }

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
