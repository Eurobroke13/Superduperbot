// =============================================================================
// BACKTEST ENGINE - SuperDuperBot
// Replicates the exact scoring, entry, and exit logic from the live bot.
// Runs on historical OKX data for high / mid / low cap coins.
//
// Usage:
//   node backtest.js                 - run backtest, save results to DB
//   node backtest.js --seed          - also seed bot state with results
//   node backtest.js --seed-safe     - seed only regimeStats and signalStats
//   node backtest.js --no-db         - skip DB write (dry run)
//   node backtest.js --months 3      - override lookback period (default: 6)

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

import {
  calculateStructuredSLTP,
  autoApproveSignal,
  fundingRateSignal,
  scoreFromData
} from "./bot/scoring.js";
import {
  API_BASE, CLAUDE_THRESHOLD, ENTRY_THRESHOLD, MAX_POSITIONS,
  MAX_POSITION_SHARE, RISK_PCT, PAPER_CASH
} from "./bot/config.js";
import { checkMinRR } from "./bot/risk-gates.js";
import { detectRegime } from "./bot/regime.js";
import { applyRoundTripFriction, FRICTION_CONFIG } from "./bot/friction.js";
import {
  checkEarlyReversalTighten,
  liquidityTrapQualityGate,
  sidewaysFilter,
  bearFilter,
  checkMeanReversionExit
} from "./bot/entry-improvements.js";
import { isOnCooldown, registerExit } from "./bot/cooldown.js";
import { shouldDecay, createDecayingLimit, tickDecayingLimit } from "./bot/smart-entry.js";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR  = path.join(__dirname, ".backtest-cache");

// CLI args
const ARGS         = process.argv.slice(2);
const SEED_MODE    = ARGS.includes("--seed");
const SAFE_SEED_MODE = ARGS.includes("--seed-safe");
const FORCE_REPLACE_REGIMES = ARGS.includes("--force-replace-regimes");
const NO_DB        = ARGS.includes("--no-db");
const DIAGNOSTIC_GATES = ARGS.includes("--diagnostic-gates");
const monthsFlag   = ARGS.indexOf("--months");
const BACKTEST_MONTHS = monthsFlag !== -1 ? parseInt(ARGS[monthsFlag + 1]) || 6 : 6;
const WARM_UP      = 520; // bars needed for SMA200 + buffer
const DISABLED_OVERRIDE = process.env.DISABLE_SIGNAL
  ? process.env.DISABLE_SIGNAL.split(",").map(s => s.trim()).filter(Boolean)
  : [];

// Entry-improvement ablation flags
// Usage: ENTRY_FILTER=fix1 node backtest.js --no-db
//        ENTRY_FILTER=fix1,fix2 node backtest.js --no-db
//        ENTRY_FILTER=bear node backtest.js --no-db
//        ENTRY_FILTER=all node backtest.js --no-db
const ENTRY_FILTER_RAW = (process.env.ENTRY_FILTER || "").toLowerCase().split(",").map(s => s.trim());
const useFix1 = ENTRY_FILTER_RAW.includes("fix1") || ENTRY_FILTER_RAW.includes("all");
const useFix2 = ENTRY_FILTER_RAW.includes("fix2") || ENTRY_FILTER_RAW.includes("all");
const useFix3 = ENTRY_FILTER_RAW.includes("fix3") || ENTRY_FILTER_RAW.includes("all");
const useBear = ENTRY_FILTER_RAW.includes("bear") || ENTRY_FILTER_RAW.includes("all");

let dbModulePromise = null;
let stateStoreModulePromise = null;

const gateDiagnostics = {
  breakout: {
    assigned: 0,
    h4ScoreMisaligned: 0,
    lowVolume: 0,
    h4TrendMisaligned: 0,
    cloudMisaligned: 0,
    vwapMisaligned: 0,
    inHVN: 0,
    inHVNEdgeAligned: 0,
    inHVNDeep: 0,
    inHVNLong: 0,
    inHVNShort: 0,
    qualityTooLow: 0,
    passed: 0
  },
  bullContinuation: {
    candidateChecks: 0,
    blockedSetupKnown: 0,
    blockedNonBullRegime: 0,
    blockedShortSignal: 0,
    blockedH4Trend: 0,
    blockedNoH4Pullback: 0,
    blockedTrapPresent: 0,
    blockedNotTrending: 0,
    assigned: 0,
    h4ScoreMisaligned: 0,
    missingEntryTrigger: 0,
    qualityTooLow: 0,
    passed: 0
  }
};

function bumpDiagnostic(setup, key) {
  if (!DIAGNOSTIC_GATES) return;
  if (gateDiagnostics[setup] && gateDiagnostics[setup][key] !== undefined) {
    gateDiagnostics[setup][key] += 1;
  }
}

async function getDbModule() {
  if (!dbModulePromise) dbModulePromise = import("./db.js");
  return dbModulePromise;
}

async function getStateStoreModule() {
  if (!stateStoreModulePromise) stateStoreModulePromise = import("./state-store.js");
  return stateStoreModulePromise;
}

function shouldReplaceRegimeStats(current, incoming, forceReplace = false) {
  if (forceReplace) return true;
  return !current || current.count < incoming.count;
}

// Coin universe
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

async function fetchOkxJson(url) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

async function fetchHistoricalCandles(instId, bar, months) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const slug      = instId.replace(/\//g, "_");
  const cacheFile = path.join(CACHE_DIR, `${slug}_${bar}_${months}m.json`);

  try {
    const raw  = await fs.readFile(cacheFile, "utf8");
    const data = JSON.parse(raw);
    if (
      Date.now() - data.fetchedAt < 6 * 3_600_000 &&
      Array.isArray(data.candles) &&
      data.candles.length > 0
    ) {
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
    const historyUrl = `${API_BASE}/api/v5/market/history-candles?${qs}`;
    const candlesUrl = `${API_BASE}/api/v5/market/candles?${qs}`;
    try {
      let json = await fetchOkxJson(historyUrl);
      if (json?.rateLimited) {
        await sleep(2_500);
        continue;
      }
      if (!json?.data?.length) {
        json = await fetchOkxJson(candlesUrl);
      }
      if (json?.rateLimited) {
        await sleep(2_500);
        continue;
      }
      if (json?.error) {
        console.error(`[fetch] ${instId} ${bar}: ${json.error}`);
        break;
      }
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

  if (candles.length > 0) {
    await fs.writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), candles }));
  }
  process.stdout.write(`  [fetch] ${instId} ${bar}: ${candles.length} bars\n`);
  return candles;
}

async function fetchHistoricalFundingRates(instId, months) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const slug = instId.replace(/\//g, "_");
  const cacheFile = path.join(CACHE_DIR, `${slug}_funding_${months}m.json`);

  try {
    const raw = await fs.readFile(cacheFile, "utf8");
    const data = JSON.parse(raw);
    if (
      Date.now() - data.fetchedAt < 6 * 3_600_000 &&
      Array.isArray(data.rates) &&
      data.rates.length > 0
    ) {
      process.stdout.write(`  [cache] ${instId} funding\n`);
      return data.rates;
    }
  } catch (_) {}

  const entriesNeeded = Math.ceil(months * 30 * 3) + 30;
  const allRows = [];
  let before;

  while (allRows.length < entriesNeeded) {
    const qs = `instId=${instId}&limit=100${before ? `&before=${before}` : ""}`;
    const url = `${API_BASE}/api/v5/public/funding-rate-history?${qs}`;
    const json = await fetchOkxJson(url);
    if (json?.rateLimited) {
      await sleep(2_500);
      continue;
    }
    if (json?.error) {
      console.error(`[funding] ${instId}: ${json.error}`);
      break;
    }
    if (!json?.data?.length) break;
    allRows.push(...json.data);
    before = json.data[json.data.length - 1]?.fundingTime;
    if (json.data.length < 100) break;
    await sleep(180);
  }

  const rates = allRows
    .reverse()
    .map((row) => ({
      ts: parseInt(row.fundingTime || 0, 10),
      rate: parseFloat(row.fundingRate || 0)
    }))
    .filter((row) => !Number.isNaN(row.ts) && !Number.isNaN(row.rate));

  if (rates.length > 0) {
    await fs.writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), rates }));
  }
  process.stdout.write(`  [fetch] ${instId} funding: ${rates.length} points\n`);
  return rates;
}

function getFundingRateAtTs(fundingSeries, ts) {
  if (!Array.isArray(fundingSeries) || fundingSeries.length === 0) return null;
  for (let i = fundingSeries.length - 1; i >= 0; i--) {
    if (fundingSeries[i].ts <= ts) return fundingSeries[i].rate;
  }
  return null;
}

// =============================================================================
// REGIME DETECTION — delegates to bot/regime.js (same logic as live bot)
// Pre-computed once per backtest run with persistent HMM/Markov state so
// each bar sees the same cumulative signal history the live bot would have.
// =============================================================================
let _regimeCache = new Map();

function precomputeRegimes(btcDaily) {
  _regimeCache.clear();
  const regState = { hmmParams: null, markovChain: null, logRegimeDetails: false };
  for (let i = 200; i < btcDaily.length; i++) {
    const regime = detectRegime(btcDaily.slice(0, i + 1), regState);
    _regimeCache.set(i, regime.label);
  }
}

function getRegimeLabel(btcEnd) {
  if (btcEnd < 200) return "sideways";
  return _regimeCache.get(btcEnd) ?? "sideways";
}

// =============================================================================
// SCORING — exact replica of scoreSymbol() using pre-loaded candle slices
// (scoreSymbol() fetches candles internally so we can't call it in backtest)
// =============================================================================
export function scoreFromCandles(symbol, candles1h, candles4h, regimeLabel) {
  const mockState = { dynamicWeights: {}, signalStats: {}, disabledSignals: [...DISABLED_OVERRIDE] };
  return scoreFromData(symbol, candles1h, candles4h, { label: regimeLabel }, mockState);
}


// =============================================================================
// POSITION SIMULATION — bar-by-bar SL/TP/tranche/partial logic
// =============================================================================
function simulatePosition(pos, futureCandles) {
  let { entryPrice, direction, sl, tp, atrVal, size, notional } = pos;
  const setupType = pos.setupType || "unknown";
  let tp1Hit = false, tp2Hit = false;
  let t2Filled = false, t3Filled = false;
  let partialPnl = 0;
  let maxFavorable = entryPrice; // track best price reached
  const events = [];

  const tp1Price = direction === "long" ? entryPrice + atrVal * 2.0 : entryPrice - atrVal * 2.0;
  const tp2Price = direction === "long" ? entryPrice + atrVal * 3.5 : entryPrice - atrVal * 3.5;
  const t2Trig   = direction === "long" ? entryPrice + atrVal * 0.5 : entryPrice - atrVal * 0.5;
  const t3Trig   = direction === "long" ? entryPrice + atrVal * 1.5 : entryPrice - atrVal * 1.5;

  const MAX_BARS = 168; // 7 days in 1h bars

  for (let i = 0; i < Math.min(MAX_BARS, futureCandles.length); i++) {
    const { high, low, close } = futureCandles[i];
    const profitATRs = atrVal > 0
      ? (direction === "long" ? (close - entryPrice) : (entryPrice - close)) / atrVal
      : 0;

    // Track best price reached (for checkEarlyReversalTighten)
    maxFavorable = direction === "long"
      ? Math.max(maxFavorable, high)
      : Math.min(maxFavorable, low);

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

    // ── Fix 1: early reversal SL tighten ──────────────────────────────────
    if (useFix1 && !tp1Hit) {
      const earlyCheck = checkEarlyReversalTighten(
        { direction, entryPrice, sl, atrVal, setupType, maxFavorable,
          tpLevels: { tp1: { hit: tp1Hit } },
          tranches: { plan: { tranche2: { filled: t2Filled } } } },
        close, atrVal, i
      );
      if (earlyCheck.tighten && earlyCheck.newSl != null) {
        sl = earlyCheck.newSl;
      }
    }

    // ── MR exit: time-based kills + trailing SL for mean-reversion trades ─
    if (setupType === "mean-reversion") {
      const mrPos = { direction, entryPrice, atrVal, sl };
      const mrCheck = checkMeanReversionExit(mrPos, close, atrVal, i + 1);
      sl = mrPos.sl; // capture any SL trail updates
      if (mrCheck.exit) {
        const remainPct = tp1Hit && tp2Hit ? 0.40 : tp1Hit ? 0.70 : 1.0;
        const pnl = (direction === "long"
          ? (close - entryPrice)
          : (entryPrice - close)) * size * remainPct + partialPnl;
        return { exit: close, exitReason: mrCheck.reason, pnl, barsHeld: i + 1, events };
      }
    }

    // ── LT 6h dead-zone exit: tighten SL when trade stalls ─────────────
    if (setupType === "liquidity-trap" && i >= 6 && !tp1Hit) {
      const profitATRsLT = atrVal > 0
        ? (direction === "long" ? (close - entryPrice) : (entryPrice - close)) / atrVal
        : 0;
      if (profitATRsLT < 0.3) {
        const tightSl = direction === "long"
          ? entryPrice - atrVal * 0.5
          : entryPrice + atrVal * 0.5;
        if (direction === "long" ? tightSl > sl : tightSl < sl) {
          sl = tightSl;
        }
      }
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
    const regime = getRegimeLabel(btcEnd > 0 ? btcEnd : 0);

    const candidate = scoreFromCandles(symbol, window1h, window4h, regime);

    if (!candidate || candidate.score < ENTRY_THRESHOLD) {
      bar += 1;
      continue;
    }

    // ── Fix 3: sideways regime filter ──
    if (useFix3) {
      const swf = sidewaysFilter(candidate, regime, null);
      if (!swf.allowed) { bar += 1; continue; }
    }

    // ── Fix 2: liquidity-trap quality gate ──
    if (useFix2 && candidate.setupType === "liquidity-trap") {
      const volumeData   = { ratio: candidate.reasons.includes("volume") ? 1.5 : 0.8 };
      const rsiDivergence = candidate.obvDiv && candidate.obvDiv !== "none"
        ? { type: candidate.obvDiv } : { type: "none" };
      const ltGate = liquidityTrapQualityGate(candidate, volumeData, rsiDivergence);
      if (!ltGate.pass) { bar += 1; continue; }
    }

    // ── Bear regime filter ──
    if (useBear) {
      const bf = bearFilter(candidate, regime.label, null);
      if (!bf.allowed) { bar += 1; continue; }
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
    if (slDist === 0 || !checkMinRR(candidate).allowed) { bar += 1; continue; }

    const riskAmount = PAPER_CASH * RISK_PCT;
    const fullSize   = riskAmount / slDist;
    const tranche1   = fullSize * 0.40;
    const notional   = tranche1 * price;

    // Score-based position sizing: 5-7 gets 25% more, 7+ gets 25% less
    const scoreSizeMult = candidate.score >= 5 && candidate.score <= 7 ? 1.25
      : candidate.score > 7 ? 0.75 : 1.0;
    const adjTranche1 = tranche1 * scoreSizeMult * (candidate.positionSizeMultiplier || 1.0);

    const pos = {
      symbol, direction: candidate.signal, entryPrice: price,
      size: adjTranche1, notional: adjTranche1 * price, sl, tp, atrVal,
      setupType: candidate.setupType
    };

    const futureCandles = candles1h.slice(bar + 1, bar + 170);
    if (futureCandles.length < 3) { bar += 1; continue; }

    const result = simulatePosition(pos, futureCandles);

    const rawTrade = {
      symbol, cap, regime,
      signal:    candidate.signal,
      direction: candidate.signal,
      setupType: candidate.setupType,
      score:     candidate.score,
      reasons:   candidate.reasons,
      riskReward: candidate.riskReward,
      entryPrice: price,
      entryTs:    ts,
      exitPrice:  result.exit,
      exitReason: result.exitReason,
      pnl:        result.pnl,
      size:       tranche1,
      notional,
      barsHeld:   result.barsHeld,
      hoursHeld:  result.barsHeld,
      partials:   result.events.filter(e => e.type?.startsWith("tp")).length,
      tranchesHit: result.events.filter(e => e.type?.startsWith("t")).length,
      atrPct:     candidate.atrPct
    };
    trades.push(applyBacktestFriction(rawTrade, symbol));

    // Skip past the position to avoid overlapping trades on the same symbol
    bar += result.barsHeld + 2;
  }

  return { symbol, trades, skipped };
}

function portfolioEquity(cash, openPositions) {
  return cash + openPositions.reduce((sum, pos) => sum + (pos.reservedNotional || 0), 0);
}

function backtestExposureAllowed(selection, openPositions, cash) {
  if (openPositions.length === 0) return { allowed: true };

  const sameDir = openPositions.filter(p => p.trade.signal === selection.trade.signal);
  if (selection.trade.signal === "long" && sameDir.length >= 7) {
    return { allowed: false, reason: "max 7 longs" };
  }
  if (selection.trade.signal === "short" && sameDir.length >= 7) {
    return { allowed: false, reason: "max 7 shorts" };
  }

  const dirExposure = sameDir.reduce((sum, p) => sum + (p.reservedNotional || 0), 0);
  const equity = portfolioEquity(cash, openPositions);
  if (equity > 0 && (dirExposure + selection.reservedNotional) / equity > 0.6) {
    return { allowed: false, reason: "dir exposure >60%" };
  }

  return { allowed: true };
}

function applyBacktestFriction(trade, symbol) {
  if (trade.friction) return trade;

  const rawPnl = Number(trade.rawPnl ?? trade.pnl ?? 0);
  const notional = Number(trade.notional || 0);
  const size = Number(trade.size || (notional > 0 && trade.entryPrice > 0 ? notional / trade.entryPrice : 0));
  const frictionResult = applyRoundTripFriction({
    ...trade,
    direction: trade.direction || trade.signal,
    size,
    notional,
    pnl: rawPnl
  }, symbol);
  const adjustedPnl = frictionResult.adjustedPnl;

  return {
    ...trade,
    direction: trade.direction || trade.signal,
    size,
    notional,
    rawPnl: parseFloat(rawPnl.toFixed(4)),
    pnl: parseFloat(adjustedPnl.toFixed(4)),
    pnlPct: notional > 0 ? parseFloat(((adjustedPnl / notional) * 100).toFixed(2)) : 0,
    friction: frictionResult.friction,
    win: adjustedPnl > 0
  };
}

function buildIndexMap(candles) {
  const map = new Map();
  if (!candles) return map;
  for (let i = 0; i < candles.length; i++) {
    map.set(candles[i].ts, i);
  }
  return map;
}

async function backtestPortfolio(map1h, map4h, fundingMap, btcDaily) {
  precomputeRegimes(btcDaily);
  const master = map1h["BTC-USDT-SWAP"] || Object.values(map1h)[0] || [];
  const h4IndexMaps = {};
  const h1IndexMaps = {};
  for (const sym of ALL_COINS) {
    h1IndexMaps[sym] = buildIndexMap(map1h[sym]);
    h4IndexMaps[sym] = buildIndexMap(map4h[sym]);
  }

  let cash = PAPER_CASH;
  const openPositions = [];
  const allTrades = [];
  const bySymbol = {};

  for (const sym of ALL_COINS) {
    bySymbol[sym] = { symbol: sym, trades: [], skipped: [] };
  }

  // Fix 4a: post-TP cooldown state
  const cooldowns = {};
  // Fix 4b: decaying limit pending orders { [symbol]: order }
  const pendingDecayLimits = {};
  // Fix 5: daily realized loss tracking { [utcDateStr]: trade[] }
  const dailyTrades = {};

  const releaseClosed = (ts) => {
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      if (pos.exitTs > ts) continue;
      cash += pos.reservedNotional + pos.trade.pnl;
      allTrades.push(pos.trade);
      bySymbol[pos.symbol].trades.push(pos.trade);
      // Fix 4a: register cooldown on full take-profit
      registerExit(cooldowns, {
        symbol: pos.symbol,
        reason: pos.trade.exitReason,
        closedAt: new Date(pos.trade.exitTs).toISOString()
      });
      // Fix 5: bucket closed trades by UTC day for daily-loss tracking
      const tradeDate = new Date(pos.trade.exitTs).toISOString().split("T")[0];
      if (!dailyTrades[tradeDate]) dailyTrades[tradeDate] = [];
      dailyTrades[tradeDate].push(pos.trade);
      openPositions.splice(i, 1);
    }
  };

  for (let masterIdx = WARM_UP; masterIdx < master.length - 10; masterIdx++) {
    const ts = master[masterIdx].ts;
    const barDate = new Date(ts).toISOString().split("T")[0];
    releaseClosed(ts);

    // Fix 4b: tick all pending decaying limits against this bar's prices
    for (const sym of Object.keys(pendingDecayLimits)) {
      const order = pendingDecayLimits[sym];
      if (openPositions.some(p => p.symbol === sym)) { delete pendingDecayLimits[sym]; continue; }
      const c1h = map1h[sym];
      const idx1h = h1IndexMaps[sym].get(ts);
      if (idx1h === undefined || !c1h) continue;
      const bar = c1h[idx1h];
      const result = tickDecayingLimit(order, bar.low, bar.high, bar.close);
      if (result.action === "fill-limit" || result.action === "fill-market") {
        const fillPrice = result.fillPrice;
        const cand = order.candidate;
        const slDist = Math.abs(fillPrice - cand.sl);
        if (slDist > 0) {
          const currEquity = portfolioEquity(cash, openPositions);
          const riskAmount = currEquity * RISK_PCT;
          const fullSize = riskAmount / slDist;
          const reservedNotional = Math.min(fullSize * fillPrice, currEquity * MAX_POSITION_SHARE);
          if (reservedNotional > 0 && reservedNotional <= cash) {
            const tranche1Size = (reservedNotional / fillPrice) * 0.40;
            const simPos = {
              symbol: sym, direction: cand.signal, entryPrice: fillPrice,
              size: tranche1Size, notional: reservedNotional * 0.40,
              sl: cand.sl, tp: cand.tp, atrVal: cand.atrVal
            };
            const futureCandles = c1h.slice(idx1h + 1, idx1h + 170);
            if (futureCandles.length >= 3) {
              const simResult = simulatePosition(simPos, futureCandles);
              const exitBar = Math.min(simResult.barsHeld - 1, futureCandles.length - 1);
              const exitTs = futureCandles[exitBar]?.ts ?? (ts + simResult.barsHeld * 3600000);
              const fundingRate = getFundingRateAtTs(fundingMap[sym], ts);
              const rawTrade = {
                symbol: sym,
                cap: CAP_MAP[sym] || "unknown",
                regime: cand.regime || "unknown",
                signal: cand.signal,
                direction: cand.signal,
                h4Trend: cand.h4Trend,
                setupType: cand.setupType,
                score: cand.score,
                reasons: [...(cand.reasons || []), "decaying-limit-fill"],
                riskReward: cand.riskReward,
                entryPrice: fillPrice,
                entryTs: ts,
                exitPrice: simResult.exit,
                exitTs,
                exitReason: simResult.exitReason,
                pnl: simResult.pnl,
                size: tranche1Size,
                notional: reservedNotional,
                fundingRate,
                barsHeld: simResult.barsHeld,
                hoursHeld: simResult.barsHeld,
                partials: simResult.events.filter(e => e.type?.startsWith("tp")).length,
                tranchesHit: simResult.events.filter(e => e.type === "t2" || e.type === "t3").length,
                atrPct: cand.atrPct
              };
              cash -= reservedNotional;
              openPositions.push({
                symbol: sym, reservedNotional, exitTs,
                trade: applyBacktestFriction(rawTrade, sym)
              });
            }
          }
        }
        delete pendingDecayLimits[sym];
      }
    }

    const slotsAvailable = MAX_POSITIONS - openPositions.length;
    if (slotsAvailable <= 0) continue;

    // Fix 5: daily loss limit — skip new entries if today's realized losses > 3% equity
    const todayClosedTrades = dailyTrades[barDate] || [];
    const dailyLoss = todayClosedTrades
      .filter(t => t.pnl < 0)
      .reduce((s, t) => s + Math.abs(t.pnl), 0);
    const equity = portfolioEquity(cash, openPositions);
    if (dailyLoss >= equity * 0.03) continue;

    const btcEnd = btcDaily.findLastIndex(c => c.ts <= ts);
    const regime = getRegimeLabel(btcEnd > 0 ? btcEnd : 0);

    const candidates = [];

    for (const sym of ALL_COINS) {
      if (openPositions.some(p => p.symbol === sym)) continue;
      // Fix 4b: skip if already has a pending decaying limit
      if (pendingDecayLimits[sym]) continue;
      // Fix 4a: skip if on post-TP cooldown
      if (isOnCooldown(cooldowns, sym, new Date(ts)).onCooldown) continue;

      const c1h = map1h[sym];
      if (!c1h || c1h.length < WARM_UP + 50) continue;

      const idx1h = h1IndexMaps[sym].get(ts);
      if (idx1h === undefined || idx1h < WARM_UP || idx1h >= c1h.length - 10) continue;

      const c4h = map4h[sym] || [];
      let h4End = c4h.length > 0 ? c4h.findLastIndex(c => c.ts <= ts) : -1;
      const window4h = h4End > 0 ? c4h.slice(0, h4End + 1) : null;
      const window1h = c1h.slice(0, idx1h + 1);

      const candidate = scoreFromCandles(sym, window1h, window4h, regime);
      if (!candidate || candidate.score < ENTRY_THRESHOLD) continue;

      // ── Fix 3: sideways regime filter ──
      if (useFix3) {
        const swf = sidewaysFilter(candidate, regime, null);
        if (!swf.allowed) continue;
      }

      // ── Fix 2: liquidity-trap quality gate ──
      if (useFix2 && candidate.setupType === "liquidity-trap") {
        const volumeData    = { ratio: candidate.reasons.includes("volume") ? 1.5 : 0.8 };
        const rsiDivergence = candidate.obvDiv && candidate.obvDiv !== "none"
          ? { type: candidate.obvDiv } : { type: "none" };
        if (!liquidityTrapQualityGate(candidate, volumeData, rsiDivergence).pass) continue;
      }

      // ── Bear regime filter ──
      if (useBear) {
        const bf = bearFilter(candidate, regime.label, null);
        if (!bf.allowed) continue;
      }

      const approved = autoApproveSignal(candidate) || candidate.score >= CLAUDE_THRESHOLD;
      if (!approved) {
        bySymbol[sym].skipped.push({ bar: idx1h, ts, score: candidate.score });
        continue;
      }

      // Fix 3: min R:R gate (0.8, matching live bot — replaces the old hardcoded 1.2)
      if (!checkMinRR(candidate).allowed) continue;

      const { price, sl, tp, atrVal, riskReward } = candidate;
      const slDist = Math.abs(price - sl);
      if (slDist === 0) continue;

      // Fix 4b: overbought/oversold setups use decaying limits instead of immediate entry
      if (shouldDecay(candidate)) {
        // Store regime on the candidate so the fill-bar trade object has it
        candidate.regime = regime;
        candidate.cap = CAP_MAP[sym] || "unknown";
        pendingDecayLimits[sym] = createDecayingLimit(candidate, price);
        continue;
      }

      const currEquity = portfolioEquity(cash, openPositions);
      const riskAmount = currEquity * RISK_PCT;
      const fullSize = riskAmount / slDist;
      const totalNotionalRaw = fullSize * price;
      const maxNotional = currEquity * MAX_POSITION_SHARE;
      const reservedNotional = Math.min(totalNotionalRaw, maxNotional);
      if (reservedNotional <= 0 || reservedNotional > cash) continue;

      // Score-based position sizing: 5-7 gets 25% more, 7+ gets 25% less
      const pScoreSizeMult = candidate.score >= 5 && candidate.score <= 7 ? 1.25
        : candidate.score > 7 ? 0.75 : 1.0;
      const pSizeMult = pScoreSizeMult * (candidate.positionSizeMultiplier || 1.0);
      const tranche1Size = (reservedNotional / price) * 0.40 * pSizeMult;
      const pos = {
        symbol: sym,
        direction: candidate.signal,
        entryPrice: price,
        size: tranche1Size,
        notional: reservedNotional * 0.40 * pSizeMult,
        sl,
        tp,
        atrVal,
        setupType: candidate.setupType
      };

      const futureCandles = c1h.slice(idx1h + 1, idx1h + 170);
      if (futureCandles.length < 3) continue;

      const result = simulatePosition(pos, futureCandles);
      const exitBar = Math.min(result.barsHeld - 1, futureCandles.length - 1);
      const exitTs = futureCandles[exitBar]?.ts ?? (ts + result.barsHeld * 3600000);

      const rawTrade = {
        symbol: sym,
        cap: CAP_MAP[sym] || "unknown",
        regime,
        signal: candidate.signal,
        direction: candidate.signal,
        h4Trend: candidate.h4Trend,
        setupType: candidate.setupType,
        score: candidate.score,
        reasons: candidate.reasons,
        riskReward: candidate.riskReward,
        entryPrice: price,
        entryTs: ts,
        exitPrice: result.exit,
        exitTs,
        exitReason: result.exitReason,
        pnl: result.pnl,
        size: tranche1Size,
        notional: reservedNotional,
        barsHeld: result.barsHeld,
        hoursHeld: result.barsHeld,
        partials: result.events.filter(e => e.type?.startsWith("tp")).length,
        tranchesHit: result.events.filter(e => e.type === "t2" || e.type === "t3").length,
        atrPct: candidate.atrPct
      };

      candidates.push({
        symbol: sym,
        idx1h,
        reservedNotional,
        exitTs,
        trade: rawTrade
      });
    }

    if (candidates.length === 0) continue;

    const scores = candidates.map(c => c.trade.score).sort((a, b) => b - a);
    const cutoff = scores[Math.floor(scores.length * 0.2)] ?? -Infinity;
    const topSignals = candidates.filter(c => c.trade.score >= cutoff);
    if (topSignals.length === 0) continue;

    for (const selection of topSignals) {
      const fundRate = getFundingRateAtTs(fundingMap[selection.symbol], ts);
      const fundSigRaw = fundingRateSignal(fundRate) || {};
      const fundSig = {
        signal: fundSigRaw.signal || "none",
        reason: fundSigRaw.reason || null
      };

      selection.trade.fundingRate = fundRate;

      if (fundSig.signal === "short" && selection.trade.h4Trend === "bullish") {
        selection.trade.score += 1.5;
        selection.trade.reasons.push("funding-squeeze");
      }

      if (fundSig.signal === "long" && selection.trade.h4Trend === "bearish") {
        selection.trade.score += 1.5;
        selection.trade.reasons.push("funding-squeeze");
      }

      if (fundSig.reason === "funding-extreme-long") {
        selection.trade.score += selection.trade.signal === "short" ? 2.0 : -0.5;
        selection.trade.reasons.push("funding-extreme-long");
      }

      if (fundSig.reason === "funding-extreme-short") {
        selection.trade.score += selection.trade.signal === "long" ? 2.0 : -0.5;
        selection.trade.reasons.push("funding-extreme-short");
      }

      if (fundSig.reason === "funding-crowded-long" && fundRate > 0.0015) {
        if (selection.trade.signal === "short") selection.trade.score += 1.0;
        selection.trade.reasons.push("funding-skew-short");
      }

      if (fundSig.reason === "funding-crowded-short" && fundRate < -0.0015) {
        if (selection.trade.signal === "long") selection.trade.score += 1.0;
        selection.trade.reasons.push("funding-skew-long");
      }
    }

    const longs = topSignals
      .filter(c => c.trade.signal === "long")
      .sort((a, b) => b.trade.score - a.trade.score);
    const shorts = topSignals
      .filter(c => c.trade.signal === "short")
      .sort((a, b) => b.trade.score - a.trade.score);

    const toOpen = [];
    let li = 0, si = 0;
    while (toOpen.length < slotsAvailable && (li < longs.length || si < shorts.length)) {
      if (li < longs.length) toOpen.push(longs[li++]);
      if (toOpen.length < slotsAvailable && si < shorts.length) toOpen.push(shorts[si++]);
    }

    for (const selection of toOpen) {
      const exposure = backtestExposureAllowed(selection, openPositions, cash);
      if (!exposure.allowed) continue;
      if (selection.reservedNotional > cash) continue;
      cash -= selection.reservedNotional;
      selection.trade = applyBacktestFriction(selection.trade, selection.symbol);
      openPositions.push(selection);
    }
  }

  releaseClosed(Number.POSITIVE_INFINITY);

  for (const sym of ALL_COINS) {
    bySymbol[sym].skipped = bySymbol[sym].skipped || [];
  }

  allTrades.sort((a, b) => (a.exitTs || a.entryTs) - (b.exitTs || b.entryTs));
  return { allTrades, bySymbol };
}

// =============================================================================
// ANALYTICS
// =============================================================================
function computeMetrics(allTrades) {
  if (!allTrades.length) return null;

  const wins   = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const rawPnl = allTrades.reduce((s, t) => s + (t.rawPnl ?? t.pnl), 0);
  const totalFriction = allTrades.reduce((s, t) => s + (t.friction?.total || 0), 0);
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
    rawPnl:       parseFloat(rawPnl.toFixed(2)),
    totalFriction: parseFloat(totalFriction.toFixed(2)),
    avgFrictionPerTrade: parseFloat((totalFriction / allTrades.length).toFixed(2)),
    frictionConfig: FRICTION_CONFIG,
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
  const { loadState, saveState } = await getStateStoreModule();
  const state = await loadState();
  if (FORCE_REPLACE_REGIMES) {
    console.log("[SEED] Forcing regimeStats replacement from corrected backtest.");
  }

  // ── 1. Regime stats ────────────────────────────────────────────────────────
  if (!state.regimeStats) state.regimeStats = {};
  let regimeUpdated = 0;
  for (const [regime, rs] of Object.entries(metrics.byRegime)) {
    const current = state.regimeStats[regime];
    if (shouldReplaceRegimeStats(current, rs, FORCE_REPLACE_REGIMES)) {
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

async function seedBotStateSafe(metrics) {
  console.log("\n[SEED] Loading current bot state...");
  const { loadState, saveState } = await getStateStoreModule();
  const state = await loadState();
  if (FORCE_REPLACE_REGIMES) {
    console.log("[SEED] Forcing regimeStats replacement from corrected backtest.");
  }

  if (!state.regimeStats) state.regimeStats = {};
  let regimeUpdated = 0;
  for (const [regime, rs] of Object.entries(metrics.byRegime)) {
    const current = state.regimeStats[regime];
    if (shouldReplaceRegimeStats(current, rs, FORCE_REPLACE_REGIMES)) {
      state.regimeStats[regime] = {
        wins: rs.wins,
        losses: rs.count - rs.wins,
        totalPnl: rs.totalPnl,
        count: rs.count
      };
      regimeUpdated++;
    }
  }
  console.log(`  ✓ regimeStats: ${regimeUpdated} regimes seeded`);

  if (!state.signalStats) state.signalStats = {};
  let sigUpdated = 0;
  for (const [sig, ss] of Object.entries(metrics.bySignal)) {
    const total = ss.wins + ss.losses;
    if (total < 5) continue;
    const current = state.signalStats[sig];
    if (!current || current.count < total) {
      state.signalStats[sig] = {
        wins: ss.wins,
        losses: ss.losses,
        totalPnl: parseFloat(ss.totalPnl.toFixed(2)),
        count: total
      };
      sigUpdated++;
    }
  }
  console.log(`  ✓ signalStats: ${sigUpdated} signals seeded`);
  console.log("  • safe-seed mode: leaving dynamicWeights unchanged");

  await saveState(state);
  console.log("[SEED] ✅ Safe seed complete — regimeStats and signalStats updated, dynamicWeights untouched.");
  return { regimeUpdated, sigUpdated, weightUpdated: 0 };
}

// =============================================================================
// PERSIST RESULTS TO POSTGRES
// =============================================================================
async function saveResultsToDb(metrics, allTrades, months) {
  const { initDb, pool } = await getDbModule();
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
  if (metrics.totalFriction !== undefined) {
    console.log(`  Raw PnL        : $${metrics.rawPnl}`);
    console.log(`  Friction       : $${metrics.totalFriction} ($${metrics.avgFrictionPerTrade}/trade)`);
  }
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

function printGateDiagnostics() {
  if (!DIAGNOSTIC_GATES) return;
  const line = "-".repeat(62);
  console.log(`\n${line}`);
  console.log("  GATE DIAGNOSTICS");
  console.log(line);
  console.log("  BREAKOUT");
  for (const [key, value] of Object.entries(gateDiagnostics.breakout)) {
    console.log(`  ${key.padEnd(24)} ${String(value).padStart(6)}`);
  }
  console.log(`\n  BULL CONTINUATION`);
  for (const [key, value] of Object.entries(gateDiagnostics.bullContinuation)) {
    console.log(`  ${key.padEnd(24)} ${String(value).padStart(6)}`);
  }
  console.log(`${line}\n`);
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  console.log(`\n[BACKTEST] SuperDuperBot - ${BACKTEST_MONTHS} months`);
  console.log(`  Coins: ${ALL_COINS.length} (${COINS.high.length} high / ${COINS.mid.length} mid / ${COINS.low.length} low cap)`);
  console.log(`  Seed mode: ${SAFE_SEED_MODE ? "SAFE (regimeStats + signalStats only)" : SEED_MODE ? "FULL (updates live bot weights)" : "OFF"}\n`);

  // Fetch BTC daily (regime detection)
  console.log("[1/4] Fetching BTC daily candles...");
  const btcRegimeMonths = Math.max(BACKTEST_MONTHS + 12, 18);
  const btcDaily = await fetchHistoricalCandles("BTC-USDT-SWAP", "1D", btcRegimeMonths);

  // Fetch all symbol data
  console.log(`\n[2/4] Fetching OHLCV data for ${ALL_COINS.length} coins...`);
  const map1h = {}, map4h = {};
  for (let i = 0; i < ALL_COINS.length; i++) {
    const sym = ALL_COINS[i];
    process.stdout.write(`  (${i + 1}/${ALL_COINS.length}) ${sym} `);
    map1h[sym] = await fetchHistoricalCandles(sym, "1H", BACKTEST_MONTHS + 1);
    await sleep(250);
    map4h[sym] = await fetchHistoricalCandles(sym, "4H", BACKTEST_MONTHS + 1);
    await sleep(250);
  }

  // Fetch funding history
  console.log(`\n[3/4] Fetching funding history for ${ALL_COINS.length} coins...`);
  const fundingMap = {};
  for (let i = 0; i < ALL_COINS.length; i++) {
    const sym = ALL_COINS[i];
    process.stdout.write(`  (${i + 1}/${ALL_COINS.length}) ${sym} `);
    fundingMap[sym] = await fetchHistoricalFundingRates(sym, BACKTEST_MONTHS + 1);
    await sleep(180);
  }

  console.log("\n[4/4] Running portfolio backtest...");
  const { allTrades, bySymbol } = await backtestPortfolio(map1h, map4h, fundingMap, btcDaily);


  // Compute metrics
  const metrics = computeMetrics(allTrades);
  if (!metrics) {
    console.log("\n[BACKTEST] No trades generated. Check coin availability or reduce WARM_UP.");
    return;
  }

  printReport(metrics, bySymbol);
  printGateDiagnostics();

  const outFile = path.join(__dirname, `backtest-${new Date().toISOString().split("T")[0]}.json`);
  await fs.writeFile(outFile, JSON.stringify({ metrics, allTrades }, null, 2));
  console.log(`[BACKTEST] Full results -> ${outFile}`);

  if (!NO_DB) {
    try {
      await saveResultsToDb(metrics, allTrades, BACKTEST_MONTHS);
    } catch (err) {
      console.error("[DB] Could not save:", err.message);
    }
  }

  if (SAFE_SEED_MODE) {
    await seedBotStateSafe(metrics);
    return;
  }
  if (SEED_MODE) {
    await seedBotState(metrics);
  } else {
    console.log("\n[BACKTEST] Run with --seed or --seed-safe to apply results to the live bot.\n");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
    .then(async () => {
      try {
        if (dbModulePromise) {
          const { closeDb } = await getDbModule();
          await closeDb();
        }
      } catch (_) {}
      process.exit(0);
    })
    .catch(err => {
      console.error("\n[BACKTEST] Fatal error:", err.message || err);
      Promise.resolve()
        .then(async () => {
          try {
            if (dbModulePromise) {
              const { closeDb } = await getDbModule();
              await closeDb();
            }
          } catch (_) {}
        })
        .finally(() => process.exit(1));
    });
}
