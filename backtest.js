// =============================================================================
// BACKTEST ENGINE — SuperDuperBot
// Replicates the exact scoring, entry, and exit logic from the live bot.
// Runs on historical OKX data for high / mid / low cap coins.
//
// Usage:
//   node backtest.js              — run backtest, save results to DB
//   node backtest.js --seed       — also seed bot state with results
//   node backtest.js --no-db      — skip DB write (dry run)
//   node backtest.js --months 3   — override lookback period (default: 6)
// =============================================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

import {
  adx, atr, bollingerBands, detectLiquidityTrap, detectOBVDivergence,
  detectRSIDivergence, ema, emaRibbon, findSupportResistance, fisher,
  ichimoku, macd, obv, rsiSeries, sma, stochRSI, volumeConfirmation,
  volumeProfile, vwap
} from "./bot/indicators.js";
import { calculateStructuredSLTP, autoApproveSignal } from "./bot/scoring.js";
import { initDb, pool } from "./db.js";
import { loadState, saveState } from "./state-store.js";
import {
  ENTRY_THRESHOLD, RISK_PCT, PAPER_CASH,
  ATR_SL_MULT, ATR_TP_MULT, SIGNAL_WEIGHTS
} from "./bot/config.js";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR  = path.join(__dirname, ".backtest-cache");

// ─── CLI args ─────────────────────────────────────────────────────────────────
const ARGS         = process.argv.slice(2);
const SEED_MODE    = ARGS.includes("--seed");
const NO_DB        = ARGS.includes("--no-db");
const monthsFlag   = ARGS.indexOf("--months");
const BACKTEST_MONTHS = monthsFlag !== -1 ? parseInt(ARGS[monthsFlag + 1]) || 6 : 6;
const WARM_UP      = 520; // bars needed for SMA200 + buffer

// ─── Coin universe ─────────────────────────────────────────────────────────────
export const COINS = {
  high: [
    "BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP",
    "BNB-USDT-SWAP", "XRP-USDT-SWAP"
  ],
  mid: [
    "AVAX-USDT-SWAP", "LINK-USDT-SWAP", "NEAR-USDT-SWAP",
    "ARB-USDT-SWAP",  "OP-USDT-SWAP"
  ],
  low: [
    "PENDLE-USDT-SWAP", "GMX-USDT-SWAP",  "WLD-USDT-SWAP",
    "JTO-USDT-SWAP",    "TIA-USDT-SWAP"
  ]
};
const ALL_COINS = [...COINS.high, ...COINS.mid, ...COINS.low];
const CAP_MAP   = {};
for (const [cap, coins] of Object.entries(COINS)) {
  for (const c of coins) CAP_MAP[c] = cap;
}

// =============================================================================
// DATA FETCHING — OKX public API with disk cache
// =============================================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHistoricalCandles(instId, bar, months) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const slug      = instId.replace(/\//g, "_");
  const cacheFile = path.join(CACHE_DIR, `${slug}_${bar}_${months}m.json`);

  try {
    const raw  = await fs.readFile(cacheFile, "utf8");
    const data = JSON.parse(raw);
    if (Date.now() - data.fetchedAt < 6 * 3_600_000) {
      process.stdout.write(`  [cache] ${instId} ${bar}\n`);
      return data.candles;
    }
  } catch (_) {}

  const multiplier  = bar === "4H" ? 4 : bar === "1D" ? 24 : 1;
  const barsNeeded  = Math.ceil(months * 30 * 24 / multiplier) + WARM_UP + 150;
  const allRaw      = [];
  let after;

  while (allRaw.length < barsNeeded) {
    const qs  = `instId=${instId}&bar=${bar}&limit=100${after ? `&after=${after}` : ""}`;
    const url = `https://www.okx.com/api/v5/market/history-candles?${qs}`;
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.status === 429) { await sleep(2_500); continue; }
      if (!res.ok)             { console.error(`[fetch] ${instId} ${bar} HTTP ${res.status}`); break; }
      const json = await res.json();
      if (!json?.data?.length) break;
      allRaw.push(...json.data);
      after = json.data[json.data.length - 1][0];
      if (json.data.length < 100) break;
      await sleep(220);
    } catch (err) { console.error(`[fetch] ${instId} ${bar}:`, err.message); break; }
  }

  // OKX returns newest-first → reverse to chronological
  const candles = allRaw
    .reverse()
    .map(c => ({
      ts:     parseInt(c[0]),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5])
    }))
    .filter(c => !isNaN(c.close) && c.close > 0);

  await fs.writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), candles }));
  process.stdout.write(`  [fetch] ${instId} ${bar}: ${candles.length} bars\n`);
  return candles;
}

// =============================================================================
// REGIME DETECTION (simplified BTC-based, no HMM dependency)
// =============================================================================
function detectRegimeSimple(btcDaily, upToIndex) {
  const slice  = btcDaily.slice(Math.max(0, upToIndex - 350), upToIndex + 1);
  const closes = slice.map(c => c.close);
  const n      = closes.length;
  if (n < 30) return "sideways";

  const ma111  = closes.slice(-Math.min(111, n)).reduce((a, b) => a + b, 0) / Math.min(111, n);
  const ma200  = closes.slice(-Math.min(200, n)).reduce((a, b) => a + b, 0) / Math.min(200, n);
  const price  = closes[n - 1];
  const recent = closes.slice(-14);
  const range  = (Math.max(...recent) - Math.min(...recent)) / Math.min(...recent);

  if (range < 0.10)                        return "sideways";
  if (price > ma111 && ma111 > ma200)      return "bull";
  if (price < ma111 && ma111 < ma200)      return "bear";
  return "sideways";
}

// =============================================================================
// SCORING — exact replica of scoreSymbol() using pre-loaded candle slices
// (scoreSymbol() fetches candles internally so we can't call it in backtest)
// =============================================================================
function scoreFromCandles(symbol, candles1h, candles4h, regimeLabel) {
  try {
    if (!candles1h || candles1h.length < 100) return null;

    const closes  = candles1h.map(c => c.close);
    const highs   = candles1h.map(c => c.high);
    const lows    = candles1h.map(c => c.low);
    const volumes = candles1h.map(c => c.volume);
    const n       = closes.length;
    const price   = closes[n - 1];

    const atrVal      = atr(highs, lows, closes, 14);
    const ichi        = ichimoku(highs, lows, closes);
    const obvSeries   = obv(closes, volumes);
    const obvDiv      = detectOBVDivergence(closes, obvSeries, 20);
    const fisherArr   = fisher(highs, lows, 10);
    const fisherVal   = fisherArr[n - 1];
    const fisherPrev  = fisherArr[n - 2] ?? fisherVal;
    const vwapVal     = vwap(highs, lows, closes, volumes, 24);
    const vpvr        = volumeProfile(closes, volumes, 20);
    const srLevels    = findSupportResistance(highs, lows, 50) || { supports: [], resistances: [] };
    const supports    = Array.isArray(srLevels.supports)    ? srLevels.supports    : [];
    const resistances = Array.isArray(srLevels.resistances) ? srLevels.resistances : [];
    const trap        = detectLiquidityTrap(price, closes, { supports, resistances });
    const rsiArr      = rsiSeries(closes, 14);
    const rsiVal      = rsiArr[n - 1];
    const rsiDiv      = detectRSIDivergence(closes, rsiArr, 20);
    const macdRaw     = macd(closes) || {};
    const macdResult  = { crossUp: !!macdRaw.crossUp, crossDown: !!macdRaw.crossDown };
    const stochResult = stochRSI(closes);
    const adxRaw      = adx(highs, lows, closes, 14) || {};
    const adxResult   = {
      strongTrend: !!adxRaw.strongTrend, trending: !!adxRaw.trending,
      adx: adxRaw.adx ?? 0, pdi: adxRaw.pdi ?? 0, mdi: adxRaw.mdi ?? 0
    };
    const bb          = bollingerBands(closes, 20, 2);
    const pctB        = bb.pctB[n - 1];
    const bbWidth     = bb?.width?.[n - 1] ?? 0;
    const ribbon      = emaRibbon(closes);
    const volRaw      = volumeConfirmation(volumes) || {};
    const volConfirm  = {
      isSignificant: !!volRaw.isSignificant,
      isClimax:      !!volRaw.isClimax,
      ratio:         volRaw.ratio ?? 1
    };

    const isStrongTrend = !!adxResult.strongTrend;
    const isTrending    = !!adxResult.trending || isStrongTrend;
    const atrPct        = atrVal / price;

    let h4Trend = "neutral";
    if (candles4h && candles4h.length >= 50) {
      const c4   = candles4h.map(c => c.close);
      const e20  = ema(c4, 20);
      const e50  = ema(c4, 50);
      const last = c4.length - 1;
      if (e20[last] > e50[last] && c4[last] > e20[last])      h4Trend = "bullish";
      else if (e20[last] < e50[last] && c4[last] < e20[last]) h4Trend = "bearish";
    }

    let longScore = 0, shortScore = 0;
    const reasons = [];

    const TIERS = { weak: 0.5, medium: 1, strong: 2 };
    const add   = (cond, name, isLong, weight = TIERS.medium) => {
      if (!cond) return;
      if (isLong) longScore += weight; else shortScore += weight;
      reasons.push(name);
    };

    // ── Trend / ranging regime ──
    if (isStrongTrend) {
      add(ribbon.bullishAligned && ribbon.expanding && ribbon.priceAboveAll, "ema-ribbon-bull", true,  TIERS.strong);
      add(ribbon.bearishAligned && ribbon.expanding && ribbon.priceBelowAll, "ema-ribbon-bear", false, TIERS.strong);
      add(h4Trend === "bullish", "h4-bull", true,  TIERS.strong);
      add(h4Trend === "bearish", "h4-bear", false, TIERS.strong);
    } else if (!isTrending) {
      const isGoodRange  = adxResult.adx < 20 && bbWidth > 0.02;
      const nearSupport  = supports.some(s    => Math.abs(price - s) / price < 0.005);
      const nearResist   = resistances.some(r => Math.abs(price - r) / price < 0.005);
      if (isGoodRange) {
        add(rsiVal < 35 && nearSupport, "rsi-support-bounce",    true,  TIERS.medium);
        add(rsiVal > 65 && nearResist,  "rsi-resistance-reject", false, TIERS.medium);
        if (!nearSupport && !nearResist) {
          add(rsiVal < 35,  "rsi-oversold",   true,  TIERS.weak);
          add(rsiVal > 65,  "rsi-overbought", false, TIERS.weak);
          add(pctB < 0.05,  "bb-oversold",    true,  TIERS.weak);
          add(pctB > 0.95,  "bb-overbought",  false, TIERS.weak);
        }
      } else {
        longScore  *= 0.7; shortScore *= 0.7;
        reasons.push("dead-range");
      }
    } else {
      add(ribbon.bullishAligned, "ema-ribbon-bull", true,  TIERS.weak);
      add(ribbon.bearishAligned, "ema-ribbon-bear", false, TIERS.weak);
      longScore  *= 0.85; shortScore *= 0.85;
      reasons.push("transition-market");
    }

    // ── Universal signals ──
    add(rsiDiv.type === "bullish",   "rsi-bull-div",   true,  TIERS.strong);
    add(rsiDiv.type === "bearish",   "rsi-bear-div",   false, TIERS.strong);
    add(obvDiv.type === "bullish",   "OBV-bull-div",   true,  TIERS.strong);
    add(obvDiv.type === "bearish",   "OBV-bear-div",   false, TIERS.strong);
    add(trap === "bear-trap",        "liquidity-bull",       true,  TIERS.strong);
    add(trap === "bull-trap",        "liquidity-bear",       false, TIERS.strong);
    add(trap === "bear-trap" && rsiVal < 40, "trap-bull-confirm", true,  TIERS.strong);
    add(trap === "bull-trap" && rsiVal > 60, "trap-bear-confirm", false, TIERS.strong);
    add(trap === "bear-trap" && volConfirm.isClimax, "trap-vol-bull", true,  TIERS.strong);
    add(trap === "bull-trap" && volConfirm.isClimax, "trap-vol-bear", false, TIERS.strong);
    add(macdResult.crossUp,   "macd-cross-up",   true,  TIERS.medium);
    add(macdResult.crossDown, "macd-cross-down", false, TIERS.medium);
    if (!isTrending) {
      add(stochResult.oversold,  "stochrsi-oversold",  true,  TIERS.weak);
      add(stochResult.overbought,"stochrsi-overbought",false, TIERS.weak);
    }
    add(stochResult.crossUp  && stochResult.k < 50, "stochrsi-cross-up",   true,  TIERS.weak);
    add(stochResult.crossDown && stochResult.k > 50, "stochrsi-cross-down", false, TIERS.weak);
    add(ichi.tkCross > 0, "TK-bull", true,  TIERS.medium);
    add(ichi.tkCross < 0, "TK-bear", false, TIERS.medium);
    if (isTrending) {
      add(price > ichi.senkouA && price > ichi.senkouB, "above-cloud", true,  TIERS.medium);
      add(price < ichi.senkouA && price < ichi.senkouB, "below-cloud", false, TIERS.medium);
    }
    add(n > 27 && ichi.chikou > ichi.chikouCompare, "chikou-bull", true,  TIERS.weak);
    add(n > 27 && ichi.chikou < ichi.chikouCompare, "chikou-bear", false, TIERS.weak);
    add(fisherVal > 0 && fisherVal > fisherPrev, "fisher-rising",  true,  TIERS.weak);
    add(fisherVal < 0 && fisherVal < fisherPrev, "fisher-falling", false, TIERS.weak);
    if (!isTrending) {
      add(fisherVal < -2.0, "fisher-oversold",  true,  TIERS.medium);
      add(fisherVal > 2.0,  "fisher-overbought",false, TIERS.medium);
    }
    add(price > vwapVal, "above-VWAP", true,  TIERS.medium);
    add(price < vwapVal, "below-VWAP", false, TIERS.medium);
    add(ribbon.wasCompressed && ribbon.expanding && ribbon.bullishAligned, "ribbon-expansion-bull", true,  TIERS.strong);
    add(ribbon.wasCompressed && ribbon.expanding && ribbon.bearishAligned, "ribbon-expansion-bear", false, TIERS.strong);

    // HTF confluence bonus
    if (ribbon.bullishAligned && h4Trend === "bullish") longScore  += 3;
    if (ribbon.bearishAligned && h4Trend === "bearish") shortScore += 3;

    if (volConfirm.isSignificant) { longScore += 1; shortScore += 1; reasons.push("volume"); }

    // Penalisers
    if (atrPct < 0.003) { longScore *= 0.7; shortScore *= 0.7; reasons.push("low-volatility"); }
    const hvns = Array.isArray(vpvr?.highVolumeNodes) ? vpvr.highVolumeNodes : [];
    if (hvns.some(n => price >= n.low && price <= n.high)) {
      longScore *= 0.7; shortScore *= 0.7; reasons.push("in-HVN");
    }
    if (ribbon.bullishAligned && rsiVal > 70)  { longScore  *= 0.7; reasons.push("trend-vs-overbought"); }
    if (ribbon.bearishAligned && rsiVal < 30)  { shortScore *= 0.7; reasons.push("trend-vs-oversold"); }
    if (h4Trend === "bullish" && price < vwapVal) { longScore  *= 0.7; reasons.push("htf-vs-vwap"); }
    if (h4Trend === "bearish" && price > vwapVal) { shortScore *= 0.7; reasons.push("htf-vs-vwap"); }

    const scoreDiff = Math.abs(longScore - shortScore);
    const minDiff   = regimeLabel === "chop" ? 1.5 : 1.0;
    if (scoreDiff < minDiff) return null;

    const minScore = regimeLabel === "chop" ? 4 : 3;
    let signal = null, score = 0;
    if (longScore >= minScore && longScore > shortScore) { signal = "long";  score = longScore; }
    else if (shortScore >= minScore)                     { signal = "short"; score = shortScore; }
    if (!signal) return null;

    let setupType = "unknown";
    if      (trap !== "none")                         setupType = "liquidity-trap";
    else if (ribbon.wasCompressed && ribbon.expanding) setupType = "breakout";
    else if (!isTrending)                              setupType = "mean-reversion";
    else if (isStrongTrend)                            setupType = "trend";

    const quality =
      (ribbon.bullishAligned || ribbon.bearishAligned ? 1 : 0) +
      (h4Trend !== "neutral" ? 1 : 0) +
      (Math.abs(price - vwapVal) / price > 0.002 ? 1 : 0);
    if (setupType !== "mean-reversion" && quality < 2) return null;
    if (setupType === "mean-reversion"  && quality < 1) return null;

    const structured = calculateStructuredSLTP(signal, price, atrVal, highs, lows, closes, volumes);
    if (!structured || !structured.sl || !structured.tp) return null;

    return {
      symbol, signal, score: Math.round(score * 10) / 10, setupType, price, atrVal,
      rsiVal, fisherVal, obvDiv: obvDiv.type, vwapVal, adxResult,
      sl: structured.sl, tp: structured.tp, riskReward: structured.riskReward,
      reasons, h4Trend, atrPct
    };
  } catch (err) {
    return null;
  }
}

// =============================================================================
// POSITION SIMULATION — bar-by-bar SL/TP/tranche/partial logic
// =============================================================================
function simulatePosition(pos, futureCandles) {
  let { entryPrice, direction, sl, tp, atrVal, size, notional } = pos;
  let tp1Hit = false, tp2Hit = false;
  let t2Filled = false, t3Filled = false;
  let partialPnl = 0;
  const events = [];

  const tp1Price = direction === "long" ? entryPrice + atrVal * 2.0 : entryPrice - atrVal * 2.0;
  const tp2Price = direction === "long" ? entryPrice + atrVal * 3.5 : entryPrice - atrVal * 3.5;
  const t2Trig   = direction === "long" ? entryPrice + atrVal * 0.5 : entryPrice - atrVal * 0.5;
  const t3Trig   = direction === "long" ? entryPrice + atrVal * 1.5 : entryPrice - atrVal * 1.5;

  const MAX_BARS = 168; // 7 days in 1h bars

  for (let i = 0; i < Math.min(MAX_BARS, futureCandles.length); i++) {
    const { high, low, close } = futureCandles[i];

    // ── Tranche 2: +35% position at +0.5 ATR ──────────────────────────────
    if (!t2Filled && (direction === "long" ? high >= t2Trig : low <= t2Trig)) {
      t2Filled = true;
      size    += size * 0.875; // 40% → 75%
      notional = size * entryPrice;
      events.push({ i, type: "t2", price: t2Trig });
    }

    // ── Tranche 3: fill to 100% at +1.5 ATR ─────────────────────────────
    if (t2Filled && !t3Filled && (direction === "long" ? high >= t3Trig : low <= t3Trig)) {
      t3Filled = true;
      size    *= (1 / 0.75);
      notional = size * entryPrice;
      events.push({ i, type: "t3", price: t3Trig });
    }

    // ── Partial TP1: 30% at ATR×2 ─────────────────────────────────────────
    if (!tp1Hit && (direction === "long" ? high >= tp1Price : low <= tp1Price)) {
      tp1Hit       = true;
      const p1pnl  = direction === "long"
        ? (tp1Price - entryPrice) * size * 0.30
        : (entryPrice - tp1Price) * size * 0.30;
      partialPnl  += p1pnl;
      sl           = direction === "long"
        ? Math.max(sl, entryPrice)   // trail to breakeven
        : Math.min(sl, entryPrice);
      events.push({ i, type: "tp1", price: tp1Price, pnl: p1pnl });
    }

    // ── Partial TP2: 30% at ATR×3.5 ───────────────────────────────────────
    if (tp1Hit && !tp2Hit && (direction === "long" ? high >= tp2Price : low <= tp2Price)) {
      tp2Hit       = true;
      const p2pnl  = direction === "long"
        ? (tp2Price - entryPrice) * size * 0.30
        : (entryPrice - tp2Price) * size * 0.30;
      partialPnl  += p2pnl;
      events.push({ i, type: "tp2", price: tp2Price, pnl: p2pnl });
    }

    // ── Stop loss ────────────────────────────────────────────────────────
    if (direction === "long" ? low <= sl : high >= sl) {
      const remainPct = tp1Hit && tp2Hit ? 0.40 : tp1Hit ? 0.70 : 1.0;
      const pnl = (direction === "long"
        ? (sl - entryPrice)
        : (entryPrice - sl)) * size * remainPct + partialPnl;
      return { exit: sl, exitReason: "sl", pnl, barsHeld: i + 1, events };
    }

    // ── Full take-profit ──────────────────────────────────────────────────
    if (direction === "long" ? high >= tp : low <= tp) {
      const remainPct = tp1Hit && tp2Hit ? 0.40 : tp1Hit ? 0.70 : 1.0;
      const pnl = (direction === "long"
        ? (tp - entryPrice)
        : (entryPrice - tp)) * size * remainPct + partialPnl;
      return { exit: tp, exitReason: "tp", pnl, barsHeld: i + 1, events };
    }
  }

  // Max hold or end of data
  const last      = futureCandles[Math.min(MAX_BARS, futureCandles.length) - 1];
  const exitPrice = last.close;
  const remainPct = tp1Hit && tp2Hit ? 0.40 : tp1Hit ? 0.70 : 1.0;
  const pnl       = (direction === "long"
    ? (exitPrice - entryPrice)
    : (entryPrice - exitPrice)) * size * remainPct + partialPnl;
  return {
    exit: exitPrice,
    exitReason: futureCandles.length <= MAX_BARS ? "end-of-data" : "max-age",
    pnl, barsHeld: Math.min(MAX_BARS, futureCandles.length), events
  };
}

// =============================================================================
// SINGLE SYMBOL BACKTEST
// =============================================================================
async function backtestSymbol(symbol, candles1h, candles4h, btcDaily, cap) {
  const trades = [];
  const skipped = [];
  let bar = WARM_UP;

  while (bar < candles1h.length - 10) {
    const window1h = candles1h.slice(0, bar + 1);
    const ts       = candles1h[bar].ts;

    // Align 4H candles to this timestamp
    let h4End = candles4h.findLastIndex(c => c.ts <= ts);
    const window4h = h4End > 0 ? candles4h.slice(0, h4End + 1) : null;

    // Align BTC daily for regime
    let btcEnd = btcDaily.findLastIndex(c => c.ts <= ts);
    const regime = detectRegimeSimple(btcDaily, btcEnd > 0 ? btcEnd : 0);

    const candidate = scoreFromCandles(symbol, window1h, window4h, regime);

    if (!candidate || candidate.score < ENTRY_THRESHOLD) {
      bar += 1;
      continue;
    }

    // In backtest we use autoApprove OR score >= 8 (Claude threshold)
    const approved = autoApproveSignal(candidate) || candidate.score >= 8;
    if (!approved) {
      skipped.push({ bar, ts, score: candidate.score });
      bar += 1;
      continue;
    }

    // Position sizing — risk 3% of starting capital, 40% first tranche
    const { price, sl, tp, atrVal, riskReward } = candidate;
    const slDist  = Math.abs(price - sl);
    if (slDist === 0 || riskReward < 1.2) { bar += 1; continue; }

    const riskAmount = PAPER_CASH * RISK_PCT;
    const fullSize   = riskAmount / slDist;
    const tranche1   = fullSize * 0.40;
    const notional   = tranche1 * price;

    const pos = {
      symbol, direction: candidate.signal, entryPrice: price,
      size: tranche1, notional, sl, tp, atrVal
    };

    const futureCandles = candles1h.slice(bar + 1, bar + 170);
    if (futureCandles.length < 3) { bar += 1; continue; }

    const result = simulatePosition(pos, futureCandles);

    trades.push({
      symbol, cap, regime,
      signal:    candidate.signal,
      setupType: candidate.setupType,
      score:     candidate.score,
      reasons:   candidate.reasons,
      riskReward: candidate.riskReward,
      entryPrice: price,
      entryTs:    ts,
      exitPrice:  result.exit,
      exitReason: result.exitReason,
      pnl:        parseFloat(result.pnl.toFixed(4)),
      pnlPct:     notional > 0 ? parseFloat(((result.pnl / notional) * 100).toFixed(2)) : 0,
      barsHeld:   result.barsHeld,
      hoursHeld:  result.barsHeld,
      partials:   result.events.filter(e => e.type?.startsWith("tp")).length,
      tranchesHit: result.events.filter(e => e.type?.startsWith("t")).length,
      win:        result.pnl > 0,
      atrPct:     candidate.atrPct
    });

    // Skip past the position to avoid overlapping trades on the same symbol
    bar += result.barsHeld + 2;
  }

  return { symbol, trades, skipped };
}

// =============================================================================
// ANALYTICS
// =============================================================================
function computeMetrics(allTrades) {
  if (!allTrades.length) return null;

  const wins   = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const winRate  = wins.length / allTrades.length;
  const avgWin   = wins.length   ? wins.reduce((s, t)   => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss  = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const exp      = (winRate * avgWin) - ((1 - winRate) * avgLoss);
  const pf       = avgLoss > 0 ? (winRate * avgWin) / ((1 - winRate) * avgLoss) : Infinity;

  // Sharpe (trade-level)
  const pnls  = allTrades.map(t => t.pnl);
  const mean  = totalPnl / pnls.length;
  const std   = Math.sqrt(pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length);
  const sharpe = std > 0 ? parseFloat(((mean / std) * Math.sqrt(pnls.length)).toFixed(3)) : 0;

  // Max drawdown on equity curve
  let equity = PAPER_CASH, peak = equity, maxDD = 0;
  for (const t of allTrades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Group by dimension
  const groupBy = key => {
    const map = {};
    for (const t of allTrades) {
      const k = t[key] || "unknown";
      if (!map[k]) map[k] = [];
      map[k].push(t);
    }
    return map;
  };

  const dimensionStats = grp => {
    const out = {};
    for (const [k, ts] of Object.entries(grp)) {
      const w   = ts.filter(t => t.pnl > 0);
      const l   = ts.filter(t => t.pnl <= 0);
      const wr  = w.length / ts.length;
      const aw  = w.length ? w.reduce((s, t) => s + t.pnl, 0) / w.length : 0;
      const al  = l.length ? Math.abs(l.reduce((s, t) => s + t.pnl, 0) / l.length) : 0;
      out[k] = {
        count:      ts.length,
        wins:       w.length,
        winRate:    parseFloat((wr * 100).toFixed(1)),
        totalPnl:   parseFloat(ts.reduce((s, t) => s + t.pnl, 0).toFixed(2)),
        expectancy: parseFloat(((wr * aw) - ((1 - wr) * al)).toFixed(3))
      };
    }
    return out;
  };

  // Signal-level stats
  const signalStats = {};
  for (const t of allTrades) {
    for (const r of (t.reasons || [])) {
      if (!signalStats[r]) signalStats[r] = { wins: 0, losses: 0, totalPnl: 0 };
      signalStats[r].totalPnl += t.pnl;
      if (t.pnl > 0) signalStats[r].wins++; else signalStats[r].losses++;
    }
  }

  return {
    totalTrades:  allTrades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      parseFloat((winRate * 100).toFixed(1)),
    totalPnl:     parseFloat(totalPnl.toFixed(2)),
    avgWin:       parseFloat(avgWin.toFixed(2)),
    avgLoss:      parseFloat(avgLoss.toFixed(2)),
    expectancy:   parseFloat(exp.toFixed(3)),
    profitFactor: pf === Infinity ? 999 : parseFloat(pf.toFixed(3)),
    sharpe,
    maxDrawdown:  parseFloat((maxDD * 100).toFixed(2)),
    avgHoursHeld: parseFloat((allTrades.reduce((s, t) => s + t.hoursHeld, 0) / allTrades.length).toFixed(1)),
    avgRR:        parseFloat((allTrades.reduce((s, t) => s + (t.riskReward || 0), 0) / allTrades.length).toFixed(2)),
    bySetup:      dimensionStats(groupBy("setupType")),
    byRegime:     dimensionStats(groupBy("regime")),
    byCap:        dimensionStats(groupBy("cap")),
    bySignal:     signalStats,
    bySymbol:     dimensionStats(groupBy("symbol"))
  };
}

// =============================================================================
// SEED BOT STATE — closes the feedback loop
// This is how backtest results actually improve the live bot:
//
//  state.regimeStats  → getAdaptiveThreshold() raises/lowers entry bar per regime
//  state.dynamicWeights → getWeight() boosts/reduces each signal's score contribution
//  state.signalStats  → trackSignalPerformance() in weekly review learns from this baseline
// =============================================================================
async function seedBotState(metrics) {
  console.log("\n[SEED] Loading current bot state...");
  const state = await loadState();

  // ── 1. Regime stats ────────────────────────────────────────────────────────
  if (!state.regimeStats) state.regimeStats = {};
  let regimeUpdated = 0;
  for (const [regime, rs] of Object.entries(metrics.byRegime)) {
    const current = state.regimeStats[regime];
    // Only seed if we have more backtest data than live data
    if (!current || current.count < rs.count) {
      state.regimeStats[regime] = {
        wins:     rs.wins,
        losses:   rs.count - rs.wins,
        totalPnl: rs.totalPnl,
        count:    rs.count
      };
      regimeUpdated++;
    }
  }
  console.log(`  ✓ regimeStats: ${regimeUpdated} regimes seeded`);

  // ── 2. Signal stats ─────────────────────────────────────────────────────────
  if (!state.signalStats) state.signalStats = {};
  let sigUpdated = 0;
  for (const [sig, ss] of Object.entries(metrics.bySignal)) {
    const total   = ss.wins + ss.losses;
    if (total < 5) continue;
    const current = state.signalStats[sig];
    if (!current || current.count < total) {
      state.signalStats[sig] = {
        wins: ss.wins, losses: ss.losses,
        totalPnl: parseFloat(ss.totalPnl.toFixed(2)),
        count: total
      };
      sigUpdated++;
    }
  }
  console.log(`  ✓ signalStats: ${sigUpdated} signals seeded`);

  // ── 3. Dynamic weights — derived from signal win rates ────────────────────
  if (!state.dynamicWeights) state.dynamicWeights = {};
  let weightUpdated = 0;
  for (const [sig, ss] of Object.entries(metrics.bySignal)) {
    const total = ss.wins + ss.losses;
    if (total < 5) continue;

    const wr       = ss.wins / total;
    const ev       = ss.totalPnl / total;
    const base     = SIGNAL_WEIGHTS[sig] || 1.0;

    // Graduated multiplier: reward consistency, penalise noise
    let mult = 1.0;
    if      (wr >= 0.65 && ev > 0)  mult = 1.40;
    else if (wr >= 0.55 && ev > 0)  mult = 1.20;
    else if (wr >= 0.50 && ev >= 0) mult = 1.05;
    else if (wr < 0.35 || ev < 0)   mult = 0.65;
    else if (wr < 0.45)              mult = 0.80;

    const adjusted = parseFloat((base * mult).toFixed(3));
    state.dynamicWeights[sig] = adjusted;
    weightUpdated++;
  }
  state.lastWeightUpdate = Date.now();
  console.log(`  ✓ dynamicWeights: ${weightUpdated} weights adjusted`);

  await saveState(state);
  console.log("[SEED] ✅ Bot state updated — live runs will use backtest-calibrated weights.");
  return { regimeUpdated, sigUpdated, weightUpdated };
}

// =============================================================================
// PERSIST RESULTS TO POSTGRES
// =============================================================================
async function saveResultsToDb(metrics, allTrades, months) {
  await initDb();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backtest_results (
      id          SERIAL PRIMARY KEY,
      run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      months      INTEGER,
      total_trades INTEGER,
      win_rate    NUMERIC,
      total_pnl   NUMERIC,
      sharpe      NUMERIC,
      max_drawdown NUMERIC,
      profit_factor NUMERIC,
      expectancy  NUMERIC,
      metrics     JSONB NOT NULL,
      trades      JSONB NOT NULL
    )
  `);
  await pool.query(
    `INSERT INTO backtest_results
       (months, total_trades, win_rate, total_pnl, sharpe, max_drawdown, profit_factor, expectancy, metrics, trades)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      months,
      metrics.totalTrades,
      metrics.winRate,
      metrics.totalPnl,
      metrics.sharpe,
      metrics.maxDrawdown,
      metrics.profitFactor,
      metrics.expectancy,
      JSON.stringify(metrics),
      JSON.stringify(allTrades.slice(-2000))
    ]
  );
  console.log("[DB] ✅ Backtest results saved to backtest_results table.");
}

// =============================================================================
// PRINT REPORT
// =============================================================================
function printReport(metrics, bySymbol) {
  const line = "─".repeat(62);
  console.log(`\n${"═".repeat(62)}`);
  console.log(`  BACKTEST REPORT  •  ${BACKTEST_MONTHS} months  •  ${ALL_COINS.length} coins`);
  console.log(`${"═".repeat(62)}`);
  console.log(`  Trades : ${metrics.totalTrades}  (${metrics.wins}W / ${metrics.losses}L)`);
  console.log(`  Win Rate       : ${metrics.winRate}%`);
  console.log(`  Total PnL      : $${metrics.totalPnl}`);
  console.log(`  Expectancy     : $${metrics.expectancy} / trade`);
  console.log(`  Profit Factor  : ${metrics.profitFactor}`);
  console.log(`  Sharpe         : ${metrics.sharpe}`);
  console.log(`  Max Drawdown   : ${metrics.maxDrawdown}%`);
  console.log(`  Avg Hold       : ${metrics.avgHoursHeld}h`);
  console.log(`  Avg R:R        : ${metrics.avgRR}`);

  console.log(`\n${line}`);
  console.log("  SETUP TYPE");
  console.log(line);
  for (const [t, s] of Object.entries(metrics.bySetup).sort((a,b) => b[1].totalPnl - a[1].totalPnl))
    console.log(`  ${t.padEnd(18)} n=${String(s.count).padStart(4)}  WR=${String(s.winRate).padStart(5)}%  EV=$${String(s.expectancy).padStart(7)}  PnL=$${s.totalPnl}`);

  console.log(`\n${line}`);
  console.log("  REGIME");
  console.log(line);
  for (const [r, s] of Object.entries(metrics.byRegime))
    console.log(`  ${r.padEnd(10)} n=${String(s.count).padStart(4)}  WR=${String(s.winRate).padStart(5)}%  PnL=$${s.totalPnl}`);

  console.log(`\n${line}`);
  console.log("  CAP TIER");
  console.log(line);
  for (const [c, s] of Object.entries(metrics.byCap).sort((a,b) => b[1].totalPnl - a[1].totalPnl))
    console.log(`  ${c.padEnd(6)} n=${String(s.count).padStart(4)}  WR=${String(s.winRate).padStart(5)}%  EV=$${String(s.expectancy).padStart(7)}  PnL=$${s.totalPnl}`);

  console.log(`\n${line}`);
  console.log("  TOP 15 SIGNALS  (min 5 trades, by win rate)");
  console.log(line);
  const topSigs = Object.entries(metrics.bySignal)
    .filter(([, s]) => s.wins + s.losses >= 5)
    .map(([name, s]) => {
      const total = s.wins + s.losses;
      return { name, ...s, total, wr: (s.wins / total * 100).toFixed(0) };
    })
    .sort((a, b) => b.wr - a.wr)
    .slice(0, 15);
  for (const s of topSigs)
    console.log(`  ${s.name.padEnd(30)} ${s.wins}W/${s.losses}L  ${String(s.wr).padStart(3)}%  PnL=$${s.totalPnl.toFixed(2)}`);

  console.log(`\n${line}`);
  console.log("  WORST 5 SIGNALS  (min 5 trades)");
  console.log(line);
  const worstSigs = Object.entries(metrics.bySignal)
    .filter(([, s]) => s.wins + s.losses >= 5)
    .map(([name, s]) => {
      const total = s.wins + s.losses;
      return { name, ...s, total, wr: (s.wins / total * 100).toFixed(0) };
    })
    .sort((a, b) => a.wr - b.wr)
    .slice(0, 5);
  for (const s of worstSigs)
    console.log(`  ${s.name.padEnd(30)} ${s.wins}W/${s.losses}L  ${String(s.wr).padStart(3)}%  PnL=$${s.totalPnl.toFixed(2)}`);

  console.log(`\n${line}`);
  console.log("  PER SYMBOL");
  console.log(line);
  for (const [sym, s] of Object.entries(metrics.bySymbol).sort((a,b) => b[1].totalPnl - a[1].totalPnl))
    console.log(`  ${sym.padEnd(22)} n=${String(s.count).padStart(3)}  WR=${String(s.winRate).padStart(5)}%  PnL=$${s.totalPnl}`);

  console.log(`${"═".repeat(62)}\n`);
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  console.log(`\n🔬 SuperDuperBot Backtest — ${BACKTEST_MONTHS} months`);
  console.log(`   Coins: ${ALL_COINS.length} (${COINS.high.length} high / ${COINS.mid.length} mid / ${COINS.low.length} low cap)`);
  console.log(`   Seed mode: ${SEED_MODE ? "YES — will update live bot weights" : "NO (pass --seed to enable)"}\n`);

  // ── Fetch BTC daily (regime detection) ──
  console.log("[1/3] Fetching BTC daily candles...");
  const btcDaily = await fetchHistoricalCandles("BTC-USDT-SWAP", "1D", BACKTEST_MONTHS + 3);

  // ── Fetch all symbol data ──
  console.log(`\n[2/3] Fetching OHLCV data for ${ALL_COINS.length} coins...`);
  const map1h = {}, map4h = {};
  for (let i = 0; i < ALL_COINS.length; i++) {
    const sym = ALL_COINS[i];
    process.stdout.write(`  (${i+1}/${ALL_COINS.length}) ${sym} `);
    map1h[sym] = await fetchHistoricalCandles(sym, "1H", BACKTEST_MONTHS + 1);
    await sleep(250);
    map4h[sym] = await fetchHistoricalCandles(sym, "4H", BACKTEST_MONTHS + 1);
    await sleep(250);
  }

  // ── Run backtest ──
  console.log("\n[3/3] Running backtest...");
  const allTrades = [];
  const bySymbol  = {};

  for (const [cap, coins] of Object.entries(COINS)) {
    for (const sym of coins) {
      process.stdout.write(`  ▶ ${sym} (${cap}) ... `);
      const c1h = map1h[sym];
      if (!c1h || c1h.length < WARM_UP + 50) {
        console.log(`SKIP (insufficient data: ${c1h?.length ?? 0} bars)`);
        continue;
      }
      const result = await backtestSymbol(sym, c1h, map4h[sym] || [], btcDaily, cap);
      bySymbol[sym] = result;
      allTrades.push(...result.trades);
      console.log(`${result.trades.length} trades`);
    }
  }

  // ── Compute metrics ──
  const metrics = computeMetrics(allTrades);
  if (!metrics) { console.log("\n⚠️  No trades generated. Check coin availability or reduce WARM_UP."); return; }

  // ── Print report ──
  printReport(metrics, bySymbol);

  // ── Save JSON ──
  const outFile = path.join(__dirname, `backtest-${new Date().toISOString().split("T")[0]}.json`);
  await fs.writeFile(outFile, JSON.stringify({ metrics, allTrades }, null, 2));
  console.log(`📄 Full results → ${outFile}`);

  // ── Save to DB ──
  if (!NO_DB) {
    try {
      await initDb();
      await saveResultsToDb(metrics, allTrades, BACKTEST_MONTHS);
    } catch (err) {
      console.error("[DB] Could not save:", err.message);
    }
  }

  // ── Seed live bot state ──
  if (SEED_MODE) {
    await seedBotState(metrics);
  } else {
    console.log("\n💡 Run with --seed to apply these results to the live bot's signal weights.\n");
  }
}

main()
  .then(() => { try { pool.end(); } catch (_) {} process.exit(0); })
  .catch(err => {
    console.error("\n[BACKTEST] Fatal error:", err.message || err);
    try { pool.end(); } catch (_) {}
    process.exit(1);
  });
