// =============================================================================
// FRICTION MODEL — realistic fees, slippage, and funding costs
//
// Drop-in module for both backtest.js and live execution.
// OKX perpetual swap fee schedule (VIP 0 tier):
//   Maker: 0.02%, Taker: 0.05%
//   Funding: every 8h, variable rate
//
// Usage in backtest:
//   import { applyEntryFriction, applyExitFriction, applyFundingCost } from "./bot/friction.js";
//   const adjustedEntry = applyEntryFriction(price, direction, notional);
//   const adjustedPnl   = applyExitFriction(rawPnl, exitPrice, direction, size);
// =============================================================================

// --- Fee schedule (OKX VIP 0) ---
const TAKER_FEE_PCT  = 0.0005;   // 0.05% — market orders, SL/TP fills
const MAKER_FEE_PCT  = 0.0002;   // 0.02% — limit orders
const FUNDING_8H_AVG = 0.0001;   // 0.01% avg funding per 8h settlement

// --- Slippage model ---
// Base slippage as fraction of price. Scales with sqrt(notional) to model
// market impact on thinner order books (altcoins vs BTC).
const BASE_SLIPPAGE_PCT = 0.0003;  // 0.03% base
const SLIPPAGE_SCALE_NOTIONAL = 5000; // notional at which slippage doubles

// --- Coin liquidity tiers ---
// Top coins get less slippage; low-cap gets more.
const LIQUIDITY_MULT = {
  "BTC-USDT-SWAP": 0.3,
  "ETH-USDT-SWAP": 0.5,
  "SOL-USDT-SWAP": 0.7,
  "BNB-USDT-SWAP": 0.7,
  "XRP-USDT-SWAP": 0.7,
  // Everything else defaults to 1.0
};

function getLiquidityMult(symbol) {
  return LIQUIDITY_MULT[symbol] ?? 1.0;
}

/**
 * Estimate slippage in price terms for a given fill.
 * Uses sqrt market-impact model: slippage grows sub-linearly with size.
 */
export function estimateSlippage(price, notional, symbol = null) {
  const liqMult = getLiquidityMult(symbol);
  const sizeFactor = Math.sqrt(Math.max(notional, 1) / SLIPPAGE_SCALE_NOTIONAL);
  return price * BASE_SLIPPAGE_PCT * liqMult * Math.max(1, sizeFactor);
}

/**
 * Apply entry friction: worse fill price + taker fee on notional.
 * Returns { adjustedPrice, feeCost, slippageCost }.
 */
export function applyEntryFriction(price, direction, notional, symbol = null, orderType = "taker") {
  const feePct = orderType === "maker" ? MAKER_FEE_PCT : TAKER_FEE_PCT;
  const feeCost = notional * feePct;

  const slip = estimateSlippage(price, notional, symbol);
  const adjustedPrice = direction === "long"
    ? price + slip    // buy higher
    : price - slip;   // sell lower (short entry = sell)

  const slippageCost = slip * (notional / price);

  return { adjustedPrice, feeCost, slippageCost };
}

/**
 * Apply exit friction: worse fill price + taker fee.
 * SL/TP exits are always taker. Returns { adjustedPnl, feeCost, slippageCost }.
 */
export function applyExitFriction(rawPnl, exitPrice, direction, size, symbol = null) {
  const notional = size * exitPrice;
  const feeCost = notional * TAKER_FEE_PCT;

  const slip = estimateSlippage(exitPrice, notional, symbol);
  // Exit is the opposite side: long exit = sell (lower), short exit = buy (higher)
  const slippagePerUnit = direction === "long" ? -slip : slip;
  const slippageCost = Math.abs(slippagePerUnit) * size;

  const adjustedPnl = rawPnl - feeCost - slippageCost;
  return { adjustedPnl, feeCost, slippageCost };
}

/**
 * Estimate funding cost for holding a position over N hours.
 * Positive funding = longs pay shorts (typical in bull markets).
 * @param {number} hoursHeld
 * @param {number} notional — position notional value
 * @param {string} direction — "long" or "short"
 * @param {number|null} fundingRate — actual funding rate if known, else uses average
 * @returns {number} cost (positive = cost to holder, negative = payment received)
 */
export function estimateFundingCost(hoursHeld, notional, direction, fundingRate = null) {
  const settlements = Math.floor(hoursHeld / 8);
  if (settlements === 0) return 0;

  const rate = fundingRate ?? FUNDING_8H_AVG;

  // Positive rate: longs pay shorts
  // Negative rate: shorts pay longs
  if (direction === "long") {
    return settlements * notional * rate; // positive rate = cost
  } else {
    return settlements * notional * -rate; // positive rate = income for shorts
  }
}

/**
 * Full round-trip friction for a completed trade.
 * Call this in backtest after simulatePosition() to get realistic PnL.
 */
export function applyRoundTripFriction(trade, symbol = null) {
  const {
    entryPrice, exitPrice, direction, size, notional,
    pnl: rawPnl, hoursHeld, fundingRate
  } = trade;

  // Entry friction
  const entry = applyEntryFriction(entryPrice, direction, notional, symbol);

  // Exit friction
  const exit = applyExitFriction(rawPnl, exitPrice, direction, size, symbol);

  // Funding cost
  const funding = estimateFundingCost(hoursHeld || 0, notional, direction, fundingRate);

  const totalFriction = entry.feeCost + exit.feeCost + entry.slippageCost + exit.slippageCost + funding;
  const adjustedPnl = rawPnl - totalFriction;

  return {
    rawPnl,
    adjustedPnl,
    friction: {
      entryFee: entry.feeCost,
      exitFee: exit.feeCost,
      entrySlippage: entry.slippageCost,
      exitSlippage: exit.slippageCost,
      funding,
      total: totalFriction
    }
  };
}

/**
 * Compute friction-adjusted metrics for an array of trades.
 * Returns the same shape as computeMetrics() but with friction applied.
 */
export function computeFrictionAdjustedMetrics(trades) {
  let totalFriction = 0;
  const adjusted = trades.map(t => {
    const result = applyRoundTripFriction({
      entryPrice: t.entryPrice,
      exitPrice:  t.exitPrice,
      direction:  t.signal || t.direction,
      size:       t.size || ((t.notional || (PAPER_CASH * 0.03)) / t.entryPrice),
      notional:   t.notional || (PAPER_CASH * 0.03 / Math.abs(t.entryPrice - (t.sl || t.entryPrice * 0.98)) * t.entryPrice * 0.40),
      pnl:        t.pnl,
      hoursHeld:  t.hoursHeld || t.barsHeld || 14,
      fundingRate: t.fundingRate || null
    }, t.symbol);
    totalFriction += result.friction.total;
    return { ...t, rawPnl: t.pnl, pnl: result.adjustedPnl, friction: result.friction };
  });

  const wins    = adjusted.filter(t => t.pnl > 0);
  const losses  = adjusted.filter(t => t.pnl <= 0);
  const totalPnl = adjusted.reduce((s, t) => s + t.pnl, 0);
  const winRate  = wins.length / adjusted.length;
  const avgWin   = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss  = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const exp      = (winRate * avgWin) - ((1 - winRate) * avgLoss);
  const pf       = avgLoss > 0 ? (winRate * avgWin) / ((1 - winRate) * avgLoss) : Infinity;

  return {
    totalTrades:       adjusted.length,
    wins:              wins.length,
    losses:            losses.length,
    winRate:           parseFloat((winRate * 100).toFixed(1)),
    totalPnl:          parseFloat(totalPnl.toFixed(2)),
    totalFriction:     parseFloat(totalFriction.toFixed(2)),
    avgFrictionPerTrade: parseFloat((totalFriction / adjusted.length).toFixed(2)),
    avgWin:            parseFloat(avgWin.toFixed(2)),
    avgLoss:           parseFloat(avgLoss.toFixed(2)),
    expectancy:        parseFloat(exp.toFixed(3)),
    profitFactor:      pf === Infinity ? 999 : parseFloat(pf.toFixed(3)),
    trades:            adjusted
  };
}

// For backtest config display
export const FRICTION_CONFIG = {
  takerFeePct:  TAKER_FEE_PCT,
  makerFeePct:  MAKER_FEE_PCT,
  baseSlippage: BASE_SLIPPAGE_PCT,
  fundingAvg:   FUNDING_8H_AVG
};
