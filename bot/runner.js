import {
  ENTRY_THRESHOLD,
  FUNDING_SETTLEMENT_HOURS,
  HOUR_PERFORMANCE,
  MAX_POSITIONS,
  SETTLEMENT_AVOID_MINUTES
} from "./config.js";
import {
  calculateRecentLiveHealth,
  checkPerformanceDrift,
  getAdaptiveClaudeThreshold,
  LIVE_BASELINE
} from "./stats.js";
import {
  fetchAllContracts,
  fetchAllTickers,
  fetchCandles,
  fetchCryptoPanicNews,
  fetchFundingRate,
  fetchLunarCrush,
  getApiHealth
} from "./market-data.js";
import { atr } from "./indicators.js";
import { detectRegime } from "./regime.js";
import {
  checkGraduatedExit,
  closePosition,
  executePartialClose,
  checkBearShortExit
} from "./exits.js";
import { loadTodayTrades } from "../trade-store.js";
import { insertDecisionLog } from "../state-store.js";
import {
  checkDCA,
  checkTranches,
  openPositionGradual
} from "./execution.js";
import {
  autoApproveSignal,
  checkCorrelationExposure,
  fundingRateSignal,
  scoreSymbol,
  confirm15mBearShort
} from "./scoring.js";
import {
  applyEntryFilters,
  cooldownDecision,
  ensureEntryPolicyState,
  pendingEntrySymbols,
  pruneEntryCooldowns,
  queueEntry,
  tickEntryPolicy,
  tickRetestPaper
} from "./entry-policy.js";
import {
  checkDailyLossLimit,
  checkMinRR
} from "./risk-gates.js";
import { isConfirmedSweep, canOpenMoreTraps } from "./sweep-confirmation.js";
import {
  checkEarlyReversalTighten,
  liquidityTrapQualityGate,
  sidewaysFilter,
  confirmMeanReversionEntry,
  checkMeanReversionExit,
  bearFilter
} from "./entry-improvements.js";

const DECISION_LOG_LIMIT = 150;
const FAST_SCAN = process.env.FAST_SCAN_MODE === "true";
const CLAUDE_SETUP_COOLDOWN_MS = 20 * 60 * 1000;
const CLAUDE_SETUP_MAX_AGE_MS = 45 * 60 * 1000;
const CLAUDE_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;
const VOLATILITY_FLAG_RETENTION_MS = 30 * 60 * 1000;
const CONTEXT_ONLY_SIGNALS = new Set([
  "TK-bull",
  "chikou-bull",
  "above-VWAP",
  "ema-ribbon-bull",
  "TK-bear",
  "chikou-bear",
  "below-VWAP",
  "ema-ribbon-bear"
]);
const REVERSAL_SIGNALS = new Set([
  "rsi-bull-div",
  "rsi-bear-div",
  "trap-detected",
  "liquidity-bull",
  "liquidity-bear",
  "trap-bull-confirm",
  "trap-bear-confirm",
  "fisher-rising",
  "fisher-falling",
  "4h-macd-cross-up",
  "4h-macd-cross-down",
  "OBV-bull-div",
  "OBV-bear-div"
]);
const BLACKLISTED_COINS = new Set(["AVAX-USDT-SWAP", "LINK-USDT-SWAP"]);

function roundValue(value, digits = 6) {
  return Number.isFinite(value) ? parseFloat(value.toFixed(digits)) : value;
}

function incrementCount(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function pushDecisionLog(state, entry) {
  if (!state.decisionLog) state.decisionLog = [];
  state.decisionLog.push(entry);
  if (state.decisionLog.length > DECISION_LOG_LIMIT) {
    state.decisionLog = state.decisionLog.slice(-DECISION_LOG_LIMIT);
  }
  insertDecisionLog(entry).catch(err =>
    console.error("[HISTORY-STORE]", err.message)
  );
}

function getSetupFingerprint(candidate) {
  return [
    candidate.symbol,
    candidate.signal,
    candidate.setupType,
    Math.round(candidate.score * 2) / 2,
    [...(candidate.reasons || [])].slice(0, 5).sort().join(",")
  ].join(":");
}

function shouldSkipClaude(candidate, state) {
  const cache = state.claudeValidations?.[candidate.symbol];
  if (!cache) return false;

  const age = Date.now() - cache.ts;
  const sameSetup = cache.fingerprint === getSetupFingerprint(candidate);

  if (age > CLAUDE_SETUP_MAX_AGE_MS) return false;
  if (sameSetup && age < CLAUDE_SETUP_COOLDOWN_MS) return true;
  return false;
}

function pruneClaudeValidationCache(state) {
  if (!state.claudeValidations) return;
  const cutoff = Date.now() - CLAUDE_CACHE_RETENTION_MS;
  for (const [symbol, entry] of Object.entries(state.claudeValidations)) {
    if (!entry?.ts || entry.ts < cutoff) delete state.claudeValidations[symbol];
  }
}

function pruneVolatilityFlags(state) {
  if (!state.volatilityFlags) return;
  const cutoff = Date.now() - VOLATILITY_FLAG_RETENTION_MS;
  for (const [symbol, flag] of Object.entries(state.volatilityFlags)) {
    if (!flag?.ts || flag.ts < cutoff) delete state.volatilityFlags[symbol];
  }
}

export async function runBot(env, deps) {
  const {
    loadState,
    saveState,
    printPortfolioSummary
  } = deps;

  console.log("=== BOT RUN ===", new Date().toISOString());
  let state;
  try {
    state = await loadState(env);
  } catch (err) {
    console.error("[BOT] Cannot load state, aborting run:", err.message);
    return;
  }

  state.runCount = (state.runCount || 0) + 1;
  state.lastRunAt = new Date().toISOString();
  ensureEntryPolicyState(state);

  await checkAllExits(env, state, deps);
  await processPendingEntries(env, state, deps);

  const phase = state.lastPhase || 0;
  console.log(`[PHASE ${phase}]`);

  try {
    switch (phase) {
      case 0:
        if (!FAST_SCAN) {
          await phaseRegimeAndExits(env, state, deps);
        } else {
          await phaseExitsOnly(env, state, deps);
        }
        state.lastPhase = 1;
        break;
      case 1:
        await phaseScan(env, state, 0, 0.5, deps);
        state.lastPhase = 2;
        break;
      case 2:
        await phaseScan(env, state, 0.5, 1.0, deps);
        state.lastPhase = 0;
        break;
      default:
        state.lastPhase = 0;
    }
  } catch (err) {
    console.error(`[PHASE ${phase}] Error:`, err.message || err);
    state.lastPhase = (phase + 1) % 3;
  }

  const drift = checkPerformanceDrift(state);
  if (drift?.status === "warning") {
    console.warn("[DRIFT WARNING]", drift.alerts.join(" | "));
  }

  const liveHealth = calculateRecentLiveHealth(state, 100);
  state.lastRunSummary = {
    runAt: new Date().toISOString(),
    phaseStarted: phase,
    nextPhase: state.lastPhase,
    driftStatus: state.driftStatus?.status || (drift ? drift.status : "healthy"),
    baseline: LIVE_BASELINE,
    liveHealth,
    lastScanSummary: state.lastScanSummary || null
  };

  if (liveHealth.enoughData) {
    console.log(
      `[LIVE HEALTH] n=${liveHealth.count} WR=${(liveHealth.winRate * 100).toFixed(1)}% ` +
      `EV=$${liveHealth.expectancy.toFixed(2)} PF=${liveHealth.profitFactor.toFixed(2)} ` +
      `DD=${((state.drawdown || 0) * 100).toFixed(1)}% | ` +
      `Baseline WR=${(LIVE_BASELINE.winRate * 100).toFixed(1)}% ` +
      `EV=$${LIVE_BASELINE.expectancy.toFixed(2)} PF=${LIVE_BASELINE.profitFactor.toFixed(2)} ` +
      `DD=${(LIVE_BASELINE.maxDrawdown * 100).toFixed(1)}%`
    );
  } else {
    console.log(`[LIVE HEALTH] Not enough closed-trade data yet (${liveHealth.count}/30).`);
  }

  await saveState(env, state);
  printPortfolioSummary(state);
}

async function processPendingEntries(env, state, deps) {
  const { notifyTrade = async () => {}, sendTelegram = async () => {} } = deps;
  ensureEntryPolicyState(state);

  const symbols = pendingEntrySymbols(state);
  if (symbols.length === 0) return;

  const tickers = await fetchAllTickers();
  const livePrices = {};
  if (tickers) {
    for (const t of tickers) {
      if (t.last) livePrices[t.contract] = t.last;
    }
  }

  for (const symbol of symbols) {
    if (state.positions[symbol]) {
      delete state.pendingLimits[symbol];
      delete state.decayingLimits[symbol];
      delete state.pendingRetests[symbol];
      continue;
    }

    try {
      const candles = await fetchCandles(symbol, "15m", 5);
      if (!candles || candles.length === 0) continue;
      const candle = candles[candles.length - 1];

      tickRetestPaper(state, symbol, candle);
      const result = tickEntryPolicy(state, symbol, candle);

      if (result.action === "fill") {
        if (Object.keys(state.positions).length >= MAX_POSITIONS) {
          console.log(`[${symbol}] Limit filled but skipped: all slots full`);
          continue;
        }

        const openResult = openPositionGradual(result.candidate, state, livePrices, env, {
          sendTelegram
        });
        if (openResult.opened) {
          await notifyTrade("OPEN", result.candidate, state, env);
          console.log(`[${symbol}] Limit entry filled @$${result.fillPrice}`);
        } else {
          console.log(`[${symbol}] Limit fill skipped: ${openResult.reason || "open-failed"}`);
        }
      }

      if (result.action === "cancel") {
        console.log(`[${symbol}] Pending limit cancelled: ${result.reason}`);
      }
    } catch (err) {
      console.error(`[PENDING ${symbol}]`, err.message || err);
    }
  }
}

async function phaseExitsOnly(env, state, deps) {
  void env;
  void deps;
  if (!state.lastRegime) {
    console.warn("[FAST] No regime cached yet - skipped phase 0 refresh.");
    return;
  }

  // checkAllExits() already ran at the top of runBot().
  // Fast scans skip BTC daily regime refresh and news Claude work here.
  console.log(
    `[FAST] Using cached regime ${state.lastRegime.label} | ` +
    `Exits already processed:${state.lastExitCount || 0}`
  );
}

async function checkAllExits(env, state, deps) {
  const {
    claudeBatchAnalysis,
    notifyTrade,
    updateCoinHistory,
    updateDynamicWeights,
    updateRegimeStats
  } = deps;

  ensureEntryPolicyState(state);

  const tickers = await fetchAllTickers();
  const livePrices = {};

  if (tickers) {
    for (const t of tickers) {
      if (t.last) livePrices[t.contract] = t.last;
    }
  }

  const positionsToClose = [];
  for (const symbol of Object.keys(state.positions)) {
    try {
      const candles = await fetchCandles(symbol, "15m", 100);
      if (!candles || candles.length < 50) {
        const fallbackPrice = livePrices[symbol];
        const pos = state.positions[symbol];
        if (Number.isFinite(fallbackPrice) && pos) {
          console.warn(`[EXIT ${symbol}] Candle fetch failed; checking hard SL/TP with live ticker $${fallbackPrice}`);
          const fallbackExit = checkHardExitFromLivePrice(pos, fallbackPrice);
          if (fallbackExit.exit) {
            positionsToClose.push({ ...pos, exitPrice: fallbackPrice, exitReason: fallbackExit.reason });
          }
        } else {
          console.warn(`[EXIT ${symbol}] Candle fetch failed and no live ticker fallback available.`);
        }
        continue;
      }
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const last = candles[candles.length - 1];
      const price = livePrices[symbol] || last.close;
      const high = last.high;
      const low = last.low;
      const atrVal = atr(highs, lows, closes, 14);
      const pos = state.positions[symbol];

      const hoursOpen = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
      if (hoursOpen > 168) {
        const pnl = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
        if (pnl <= 0) {
          positionsToClose.push({ ...pos, exitPrice: price, exitReason: "max-age-expired" });
          continue;
        }
      }

      if (pos.forceClose) {
        positionsToClose.push({ ...pos, exitPrice: price, exitReason: "claude-reeval" });
        continue;
      }

      checkTranches(pos, price, state);
      await checkDCA(pos, price, atrVal, state, env, { notifyTrade });

      // ── Fix 1: mean-reversion custom exit ──
      if (pos.setupType === "mean-reversion") {
        const mrExit = checkMeanReversionExit(pos, price, atrVal, hoursOpen);
        if (mrExit.exit) {
          positionsToClose.push({ ...pos, exitPrice: price, exitReason: mrExit.reason });
          continue;
        }
      }

      // ── Fix 1: early reversal SL tighten (all non-MR trades) ──
      const earlyCheck = checkEarlyReversalTighten(pos, price, atrVal, hoursOpen);
      if (earlyCheck.tighten && earlyCheck.newSl != null) {
        pos.sl = earlyCheck.newSl;
        console.log(`[EARLY-TIGHTEN] ${symbol} SL→${earlyCheck.newSl.toFixed(6)} (${earlyCheck.reason})`);
      }

      // ── Bear regime short exit rules ──
      const bearExit = checkBearShortExit(pos, price, atrVal, hoursOpen);
      if (bearExit.exit) {
        positionsToClose.push({ ...pos, exitPrice: price, exitReason: bearExit.reason });
        continue;
      }

      const exit = checkGraduatedExit(pos, price, high, low, atrVal);
      if (exit.exit) {
        positionsToClose.push({ ...pos, exitPrice: price, exitReason: exit.reason });
      } else if (exit.partial && exit.partialCloses) {
        for (const pc of exit.partialCloses) {
          executePartialClose(symbol, price, pc.pct, pc.reason, pos, state, {
            updateCoinHistory,
            updateDynamicWeights,
            updateRegimeStats
          });
          await notifyTrade("PARTIAL", {
            symbol,
            direction: pos.direction,
            exitPrice: price,
            reason: pc.reason,
            pct: pc.pct,
            pnl: pos.direction === "long"
              ? (price - pos.entryPrice) * pos.size * pc.pct
              : (pos.entryPrice - price) * pos.size * pc.pct
          }, state, env);
        }
        if (pos.size < 0.0001 || pos.notional < 1) {
          positionsToClose.push({ ...pos, exitPrice: price, exitReason: "fully-partialed" });
        }
      }
    } catch (err) {
      console.error(`[EXIT ${symbol}]`, err.message);
    }
  }

  state.lastExitCount = positionsToClose.length;
  if (positionsToClose.length === 0) return;

  const regime = state.lastRegime || { label: "unknown", hmmLabel: "?", piCycle: "?", markovProb: 0 };

  try {
    const claudeResult = await claudeBatchAnalysis({
      headlines: [],
      candidatesToValidate: [],
      positionsToClose,
      regime,
      env,
      state
    });

    for (const p of positionsToClose) {
      if (state.positions[p.symbol]) {
        const journal = claudeResult.journals[p.symbol] || null;
        closePosition(p.symbol, p.exitPrice, p.exitReason, state.positions[p.symbol], state, journal, {
          updateCoinHistory,
          updateDynamicWeights,
          updateRegimeStats
        });
        await notifyTrade("CLOSE", p, state, env);
      }
    }
  } catch (err) {
    console.error("[BATCH CLOSE]", err.message);
    for (const p of positionsToClose) {
      if (state.positions[p.symbol]) {
        closePosition(p.symbol, p.exitPrice, p.exitReason, state.positions[p.symbol], state, null, {
          updateCoinHistory,
          updateDynamicWeights,
          updateRegimeStats
        });
      }
    }
  }
}

function checkHardExitFromLivePrice(pos, price) {
  if (!pos || !Number.isFinite(price)) return { exit: false, reason: null };

  if (pos.direction === "long") {
    if (Number.isFinite(pos.sl) && price <= pos.sl) return { exit: true, reason: "stop-loss" };
    if (Number.isFinite(pos.tp) && price >= pos.tp) return { exit: true, reason: "take-profit-full" };
  } else {
    if (Number.isFinite(pos.sl) && price >= pos.sl) return { exit: true, reason: "stop-loss" };
    if (Number.isFinite(pos.tp) && price <= pos.tp) return { exit: true, reason: "take-profit-full" };
  }

  return { exit: false, reason: null };
}

async function phaseRegimeAndExits(env, state, deps) {
  const { claudeBatchAnalysis, sendRegimeChangeAlert } = deps;

  const btcDaily = await fetchCandles("BTC-USDT-SWAP", "1d", 500);
  if (!btcDaily || btcDaily.length < 200) {
    console.warn("[REGIME] Insufficient BTC data.");
    return;
  }

  const prevLabel = state.lastRegime?.label;
  const regime = detectRegime(btcDaily, state);
  state.lastRegime = regime;
  console.log(`[REGIME] ${regime.label} | HMM:${regime.hmmLabel} | PI:${regime.piCycle} | Markov:${regime.markovProb.toFixed(3)}`);

  for (const pos of Object.values(state.positions)) {
    if (!pos.tpLevels && pos.atrVal) {
      const entryAtr = pos.atrVal;
      pos.tpLevels = {
        tp1: {
          atrMult: 2.0, pct: 0.30, hit: false,
          price: pos.direction === "long"
            ? pos.entryPrice + entryAtr * 2.0
            : pos.entryPrice - entryAtr * 2.0
        },
        tp2: {
          atrMult: 3.5, pct: 0.30, hit: false,
          price: pos.direction === "long"
            ? pos.entryPrice + entryAtr * 3.5
            : pos.entryPrice - entryAtr * 3.5
        },
        tp3: { pct: 0.40, hit: false }
      };
      console.log(`[MIGRATE] ${pos.symbol} tpLevels: TP1@$${pos.tpLevels.tp1.price.toFixed(6)} TP2@$${pos.tpLevels.tp2.price.toFixed(6)}`);
    }
    if (pos.dcaApplied === undefined) pos.dcaApplied = false;
    if (pos.maxFavorable === undefined) pos.maxFavorable = pos.entryPrice;
  }

  if (prevLabel && prevLabel !== regime.label) {
    await sendRegimeChangeAlert(env, state, prevLabel, regime);
  }

  const newsResult = await fetchCryptoPanicNews(state);
  state.newsBlocked = newsResult.blockedCoins;
  state.newsBoosted = newsResult.boostedCoins;
  state.newsHeadlines = newsResult.headlines;
  state.newsNeedsClaude = newsResult.needsClaude;

  if (newsResult.needsClaude && !FAST_SCAN) {
    try {
      const claudeResult = await claudeBatchAnalysis({
        headlines: newsResult.headlines,
        candidatesToValidate: [],
        positionsToClose: [],
        regime,
        env,
        state
      });

      if (claudeResult.newsBlocked.length > 0) {
        state.newsBlocked = [...new Set([...state.newsBlocked, ...claudeResult.newsBlocked])];
      }
      if (claudeResult.newsBoosted.length > 0) {
        state.newsBoosted = [...new Set([...state.newsBoosted, ...claudeResult.newsBoosted])];
      }
    } catch (err) {
      console.error("[NEWS BATCH]", err.message);
    }
  }

  console.log(`[PHASE 0] Regime:${regime.label} | Exits:${state.lastExitCount || 0} | News blocked:${state.newsBlocked.length} boosted:${state.newsBoosted.length}`);
}

async function phaseScan(env, state, startFrac, endFrac, deps) {
  const {
    claudeBatchAnalysis,
    getAdaptiveThreshold,
    getWeight,
    notifyTrade,
    sendTelegram,
    sleep
  } = deps;

  const regime = state.lastRegime;
  ensureEntryPolicyState(state);
  pruneEntryCooldowns(state);
  if (!regime) {
    console.warn("[SCAN] No regime, skip.");
    return;
  }

  pruneClaudeValidationCache(state);
  pruneVolatilityFlags(state);

  const scanSummary = {
    ranAt: new Date().toISOString(),
    phaseWindow: `${startFrac}-${endFrac}`,
    regime: regime.label,
    candidatesScored: 0,
    candidatesQualified: 0,
    candidatesFilteredByScorer: 0,
    autoCandidates: 0,
    claudeCandidates: 0,
    openedCount: 0,
    blockedByReason: {},
    openedBySetup: {},
    openedBySignal: {},
    skippedByReason: {},
    rejectedByReason: {}
  };

  const apiHealth = getApiHealth();
  if (apiHealth.tripped) {
    console.warn(
      `[SCAN] OKX API circuit open: ${apiHealth.consecutiveFailures} consecutive failures; skipping scoring.`
    );
    incrementCount(scanSummary.skippedByReason, "api-circuit-open");
    incrementCount(scanSummary.blockedByReason, "api-circuit-open");
    scanSummary.apiHealth = apiHealth;
    state.lastScanSummary = scanSummary;
    return;
  }

  const timeFilter = getTimeFilter();
  if (timeFilter.shouldAvoidEntry) {
    console.log(`[SCAN] Avoiding entries - near funding settlement (${timeFilter.utcHour}:${String(timeFilter.utcMin).padStart(2, "0")} UTC)`);
    incrementCount(scanSummary.skippedByReason, "funding-settlement-window");
    incrementCount(scanSummary.blockedByReason, "funding-settlement-window");
    state.lastScanSummary = scanSummary;
    return;
  }

  let todayTrades = null;
  try {
    todayTrades = await loadTodayTrades();
  } catch (err) {
    console.error("[TRADE-STORE] Could not load today's trades:", err.message);
  }
  const dailyCheck = checkDailyLossLimit(state, todayTrades);
  if (!dailyCheck.allowed) {
    console.log(`[SCAN] ${dailyCheck.reason} - halting new entries for today`);
    incrementCount(scanSummary.skippedByReason, "daily-loss-limit");
    incrementCount(scanSummary.blockedByReason, "daily-loss-limit");
    state.lastScanSummary = scanSummary;
    return;
  }

  const entryThreshold = getAdaptiveThreshold(state, regime.label);
  const claudeThreshold = getAdaptiveClaudeThreshold(state, regime.label);

  console.log(`[SCAN] Regime:${regime.label} Entry:${entryThreshold} Claude:${claudeThreshold} TimeAdj:${timeFilter.scoreAdjustment.toFixed(1)}`);
  const slotsAvailable = MAX_POSITIONS
    - Object.keys(state.positions).length
    - Object.keys(state.pendingLimits || {}).length
    - Object.keys(state.decayingLimits || {}).length;
  if (slotsAvailable <= 0) {
    console.log("[SCAN] All slots full.");
    return;
  }

  pruneEntryCooldowns(state);

  const tickers = await fetchAllTickers();
  const volumeMap = {};
  const livePrices = {};
  if (tickers) for (const t of tickers) {
    volumeMap[t.contract] = parseFloat(t.volume_24h_quote || t.volume_24h_usd || t.volume_24h || 0);
    if (t.last) livePrices[t.contract] = t.last;
  }

  const allContracts = await fetchAllContracts();
  if (!allContracts || allContracts.length === 0) return;

  const blocked = state.newsBlocked || [];
  const boosted = state.newsBoosted || [];

  const tradeable = allContracts
    .filter(c => (volumeMap[c] || 0) > 450_000)
    .filter(c => !BLACKLISTED_COINS.has(c))
    .filter(c => !state.positions[c])
    .filter(c => !state.pendingLimits[c])
    .filter(c => !state.decayingLimits[c])
    .filter(c => !cooldownDecision(state, c).onCooldown)
    .filter(c => !blocked.includes(c.replace("-USDT-SWAP", "")));

  const tickerMap = {};
  if (tickers) {
    for (const t of tickers) {
      tickerMap[t.contract] = t;
    }
  }

  const rankedTradeable = tradeable
    .map(symbol => {
      const t = tickerMap[symbol] || {};
      const vol = volumeMap[symbol] || 0;
      const last = parseFloat(t.last || 0);
      const open24h = parseFloat(t.open24h || t.open_24h || t.open24hPrice || 0);
      const movePct =
        open24h > 0 && last > 0
          ? Math.abs((last - open24h) / open24h)
          : 0;

      const rankScore =
        (vol / 1_000_000) +
        (movePct * 100 * 0.3);

      return { symbol, vol, movePct, rankScore };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .map(x => x.symbol);

  const startIdx = Math.floor(rankedTradeable.length * startFrac);
  const endIdx = Math.floor(rankedTradeable.length * endFrac);
  const rawBatch = rankedTradeable.slice(startIdx, endIdx);
  const flagged = Object.keys(state.volatilityFlags || {});
  const batch = !FAST_SCAN
    ? [
        ...flagged.filter(symbol => rawBatch.includes(symbol)),
        ...rawBatch.filter(symbol => !flagged.includes(symbol))
      ]
    : rawBatch;
  scanSummary.batchScanned = batch.length;
  scanSummary.contractUniverse = rankedTradeable.length;
  scanSummary.newsBlockedCount = blocked.length;
  scanSummary.existingPositions = Object.keys(state.positions).length;

  console.log(
    `[SCAN] Scoring ${batch.length} contracts ` +
    `(${startIdx}-${endIdx} of ${rankedTradeable.length})`
  );

  const candidates = [];
  const chunkSize = 10;
  for (let i = 0; i < batch.length; i += chunkSize) {
    const chunk = batch.slice(i, i + chunkSize);
    const results = await Promise.allSettled(chunk.map(s => scoreSymbol(s, regime, state)));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) candidates.push(r.value);
    }
    if (i + chunkSize < batch.length) await sleep(100);
  }
  scanSummary.candidatesScored = candidates.length;
  scanSummary.candidatesFilteredByScorer = Math.max(0, batch.length - candidates.length);

  const decisions = new Set();
  const topSignalSet = new Set();
  const qualifiedSet = new Set();
  const consideredSet = new Set();

  function finalizeDecision(candidate, outcome, skipReason = null, extra = {}) {
    if (!candidate || decisions.has(candidate.symbol)) return;
    decisions.add(candidate.symbol);

    const entry = {
      timestamp: new Date().toISOString(),
      symbol: candidate.symbol,
      regime: regime.label,
      setupType: candidate.setupType || "unknown",
      signal: candidate.signal,
      score: roundValue(candidate.score, 3),
      adjustedScore: candidate.adjustedScore != null ? roundValue(candidate.adjustedScore, 3) : undefined,
      reasons: [...new Set(candidate.reasons || [])].slice(0, 20),
      approvalType: extra.approvalType || candidate.approvalType || null,
      h4Trend: candidate.h4Trend || "unknown",
      fundingRate: Number.isFinite(candidate.fundingRate) ? roundValue(candidate.fundingRate, 6) : candidate.fundingRate ?? null,
      correlationBlocked: extra.correlationBlocked || false,
      outcome,
      skipReason,
      details: extra.details || null
    };

    pushDecisionLog(state, entry);

    if (outcome === "opened") {
      scanSummary.openedCount += 1;
      incrementCount(scanSummary.openedBySetup, entry.setupType);
      incrementCount(scanSummary.openedBySignal, entry.signal);
    } else if (outcome === "skipped") {
      incrementCount(scanSummary.skippedByReason, skipReason || "unknown");
      incrementCount(scanSummary.blockedByReason, skipReason || "unknown");
    } else if (outcome === "rejected") {
      incrementCount(scanSummary.rejectedByReason, skipReason || "unknown");
      incrementCount(scanSummary.blockedByReason, skipReason || "unknown");
    }
  }

  for (const c of candidates) {
    const base = c.symbol.replace("-USDT-SWAP", "");
    if (boosted.includes(base)) {
      c.score += getWeight("news-boost", state);
      c.reasons.push("news-boost");
    }
  }

  if (FAST_SCAN) {
    if (!state.volatilityFlags) state.volatilityFlags = {};
    for (const c of candidates) {
      if ((c.atrPct || 0) > 0.008) {
        state.volatilityFlags[c.symbol] = {
          ts: Date.now(),
          reason: "atr-spike",
          score: roundValue(c.score, 3)
        };
        console.log(`[FAST] Volatility flag: ${c.symbol} atrPct=${((c.atrPct || 0) * 100).toFixed(2)}%`);
      }
    }
    pruneVolatilityFlags(state);
  }

  if (timeFilter.scoreAdjustment !== 0) {
    for (const c of candidates) {
      c.score += timeFilter.scoreAdjustment;
      c.reasons.push(`time(${timeFilter.scoreAdjustment > 0 ? "+" : ""}${timeFilter.scoreAdjustment.toFixed(1)})`);
    }
  }

  const lunarSymbols = [...new Set([
    ...candidates.filter(c => c.score >= ENTRY_THRESHOLD).slice(0, 25).map(c => c.symbol.replace("-USDT-SWAP", "")),
    ...Object.keys(state.positions).map(s => s.replace("-USDT-SWAP", ""))
  ])].slice(0, 15);

  const lunarData = await fetchLunarCrush(lunarSymbols, env, state);

  for (const c of candidates) {
    const base = c.symbol.replace("-USDT-SWAP", "");
    const lunar = lunarData[base];
    if (!lunar) continue;
    c.lunarSentiment = lunar.sentiment;
    c.lunarGalaxyScore = lunar.galaxyScore;

    if (lunar.galaxyScore > 60 && c.signal === "long") {
      c.score += getWeight("lunar-bull", state);
      c.reasons.push(`lunar-bull(${lunar.galaxyScore})`);
    }
    if (lunar.galaxyScore < 30 && c.signal === "short") {
      c.score += getWeight("lunar-bear", state);
      c.reasons.push(`lunar-bear(${lunar.galaxyScore})`);
    }
    if (c.signal === "long" && lunar.sentiment < 30) {
      c.score += getWeight("lunar-sentiment-warning", state);
      c.reasons.push("lunar-sentiment-warning");
    }
    if (c.signal === "short" && lunar.sentiment > 70) {
      c.score += getWeight("lunar-sentiment-warning", state);
      c.reasons.push("lunar-sentiment-warning");
    }
  }

  const scores = candidates.map(c => c.score).sort((a, b) => b - a);
  const cutoff = scores[Math.floor(scores.length * 0.2)] ?? -Infinity;
  const topSignals = candidates.filter(c => c.score >= cutoff);
  for (const candidate of topSignals) topSignalSet.add(candidate.symbol);

  if (topSignals.length > 0) {
    const fundingResults = await Promise.allSettled(
      topSignals.map(c => fetchFundingRate(c.symbol))
    );

    for (let i = 0; i < topSignals.length; i++) {
      const c = topSignals[i];
      const fundRate = fundingResults[i].status === "fulfilled"
        ? fundingResults[i].value
        : null;
      const fundSigRaw = fundingRateSignal(fundRate) || {};
      const fundSig = {
        signal: fundSigRaw.signal || "none",
        reason: fundSigRaw.reason || null
      };

      c.fundingRate = fundRate;

      if (fundSig.signal === "short" && c.h4Trend === "bullish") {
        c.score += 1.5;
        c.reasons.push("funding-squeeze");
      }

      if (fundSig.signal === "long" && c.h4Trend === "bearish") {
        c.score += 1.5;
        c.reasons.push("funding-squeeze");
      }

      if (fundSig.reason === "funding-extreme-long") {
        c.score += c.signal === "short" ? 2.0 : -0.5;
        c.reasons.push("funding-extreme-long");
      }

      if (fundSig.reason === "funding-extreme-short") {
        c.score += c.signal === "long" ? 2.0 : -0.5;
        c.reasons.push("funding-extreme-short");
      }

      if (fundSig.reason === "funding-crowded-long" && fundRate > 0.0015) {
        if (c.signal === "short") c.score += 1.0;
        c.reasons.push("funding-skew-short");
      }

      if (fundSig.reason === "funding-crowded-short" && fundRate < -0.0015) {
        if (c.signal === "long") c.score += 1.0;
        c.reasons.push("funding-skew-long");
      }
    }
  }

  // ── Sweep confirmation gate for liquidity-trap candidates ──────────────
  // Require actual sweep evidence (wick through S/R + reclaim + volume spike)
  for (const c of topSignals) {
    if (c.setupType !== "liquidity-trap") continue;
    const sweep = isConfirmedSweep({
      candles: c._candles1h,
      srLevels: c._srLevels || { supports: [], resistances: [] },
      direction: c.signal,
      atrVal: c.atrVal
    });
    if (!sweep.confirmed) {
      console.log(`[${c.symbol}] Liquidity-trap blocked: no confirmed sweep (${sweep.details.reason})`);
      c.score = 0;
      c._sweepBlocked = true;
      incrementCount(scanSummary.blockedByReason, "no-confirmed-sweep");
    } else {
      console.log(`[${c.symbol}] Sweep confirmed: ${sweep.details.type} @ ${sweep.details.sweepLevel}`);
      c._sweepDetails = sweep.details;
    }
  }

  // ── Fix 3: sideways regime filter (blocks trend setups, raises min score) ──
  for (const c of topSignals) {
    if (c._sweepBlocked) continue;
    const swf = sidewaysFilter(c, regime.label, state.regimeStats);
    if (!swf.allowed) {
      c.score = 0;
      incrementCount(scanSummary.blockedByReason, `sideways-filter:${swf.reason}`);
    }
  }

  // ── Fix 2: liquidity-trap quality gate (requires 2+ confirmations) ──
  for (const c of topSignals) {
    if (c._sweepBlocked || c.score === 0) continue;
    if (c.setupType !== "liquidity-trap") continue;
    const volumeData = { ratio: c.reasons.includes("volume") ? 1.5 : 0.8 };
    const rsiDivergence = c.obvDiv && c.obvDiv !== "none"
      ? { type: c.obvDiv }
      : { type: "none" };
    const ltGate = liquidityTrapQualityGate(c, volumeData, rsiDivergence);
    if (!ltGate.pass) {
      c.score = 0;
      incrementCount(scanSummary.blockedByReason, "lt-quality-gate");
      console.log(`[${c.symbol}] LT quality gate: ${ltGate.reason}`);
    }
  }

  // ── Bear regime filter: shorts encouraged (4.0+), longs discouraged (7.0+) ──
  for (const c of topSignals) {
    if (c.score === 0) continue;
    const bearGate = bearFilter(c, regime.label, state.regimeStats);
    if (!bearGate.allowed) {
      c.score = 0;
      incrementCount(scanSummary.blockedByReason, `bear-gate:${bearGate.reason}`);
    }
  }

  // ── MR: apply 15m-based sizing gradient for mean-reversion candidates ──
  for (const c of topSignals) {
    if (c.score === 0 || c.setupType !== "mean-reversion") continue;
    const candles15m = c._candles15m || null; // populated if fetched upstream
    const mrDecision = confirmMeanReversionEntry(c, candles15m);
    if (!mrDecision.enter) {
      c.score = 0;
      incrementCount(scanSummary.blockedByReason, `mr-entry-gate:${mrDecision.reason}`);
    } else {
      c.adjustedScore = mrDecision.adjustedScore;
      c.positionSizeMultiplier = mrDecision.positionSizeMultiplier;
      if (mrDecision.patterns?.length) c.reasons.push(...mrDecision.patterns);
    }
  }

  // ── Bear shorts: fetch 15m for confirmation ──
  for (const c of topSignals) {
    if (c.score === 0 || c.signal !== "short" || regime.label !== "bear") continue;

    // Fetch 15m candles (1 API call per bear short)
    try {
      const candles15m = await fetchCandles(c.symbol, "15m", 50);
      if (candles15m && candles15m.length >= 12) {
        const confirm = confirm15mBearShort(candles15m, c.price, c.atrVal);
        c._15mConfirmation = confirm;

        if (!confirm.enter) {
          c.score *= 0.85;  // penalty but don't block
          console.log(`[${c.symbol}] Bear short 15m unconfirmed, score reduced`);
        } else {
          c.adjustedScore = c.score + (confirm.confidence * 0.3);
          c.positionSizeMultiplier = confirm.positionSizeMultiplier;
          c.reasons.push(...confirm.patterns);
          console.log(`[${c.symbol}] Bear short 15m confirmed: ${confirm.patterns.join(", ")}`);
        }
      }
    } catch (err) {
      console.warn(`[${c.symbol}] 15m fetch failed, proceeding with 1h score`);
    }
  }

  const qualified = topSignals.filter(c => c.score >= entryThreshold);
  scanSummary.candidatesQualified = qualified.length;
  for (const candidate of qualified) qualifiedSet.add(candidate.symbol);
  const longs = qualified.filter(c => c.signal === "long").sort((a, b) => b.score - a.score);
  const shorts = qualified.filter(c => c.signal === "short").sort((a, b) => b.score - a.score);

  const toConsider = [];
  let li = 0, si = 0;
  while (toConsider.length < slotsAvailable && (li < longs.length || si < shorts.length)) {
    if (li < longs.length) toConsider.push(longs[li++]);
    if (toConsider.length < slotsAvailable && si < shorts.length) toConsider.push(shorts[si++]);
  }
  for (const candidate of toConsider) consideredSet.add(candidate.symbol);

  const autoList = [];
  const claudeList = [];

  for (const c of toConsider) {
    const exposure = checkCorrelationExposure(c, state);
    if (!exposure.allowed) {
      console.log(`[${c.symbol}] Blocked: ${exposure.reason}`);
      finalizeDecision(c, "skipped", "correlation-limit", {
        correlationBlocked: true,
        details: { reason: exposure.reason }
      });
      continue;
    }

    const rrCheck = checkMinRR(c);
    if (!rrCheck.allowed) {
      console.log(`[${c.symbol}] Blocked: ${rrCheck.reason}`);
      finalizeDecision(c, "skipped", "min-rr", {
        details: { reason: rrCheck.reason }
      });
      continue;
    }

    if (autoApproveSignal(c, regime)) {
      autoList.push(c);
      continue;
    }

    if (shouldSkipClaude(c, state)) {
      const cached = state.claudeValidations?.[c.symbol];
      if (cached?.approved) {
        autoList.push({ ...c, approvalType: "claude-cached" });
      } else {
        const ageMin = Math.round((Date.now() - cached.ts) / 60000);
        console.log(`[${c.symbol}] Claude cooldown - last rejected (${ageMin}m ago)`);
        finalizeDecision(c, "rejected", "claude-cached-rejected", {
          approvalType: "claude-cached",
          details: {
            ageMinutes: ageMin,
            claudeReason: cached?.reason || "cached-rejected"
          }
        });
      }
    } else {
      claudeList.push(c);
    }
  }
  scanSummary.autoCandidates = autoList.length;
  scanSummary.claudeCandidates = claudeList.length;

  for (const candidate of candidates) {
    if (!topSignalSet.has(candidate.symbol)) {
      finalizeDecision(candidate, "rejected", "below-top-cutoff");
    } else if (!qualifiedSet.has(candidate.symbol)) {
      finalizeDecision(candidate, "rejected", "below-threshold", {
        details: { threshold: roundValue(entryThreshold, 3) }
      });
    } else if (!consideredSet.has(candidate.symbol)) {
      finalizeDecision(candidate, "skipped", "max-positions");
    }
  }

  if (FAST_SCAN) {
    for (const c of [...autoList, ...claudeList]) {
      const cachedApproved = c.approvalType === "claude-cached";
      const canOpen = cachedApproved || autoApproveSignal(c, regime);
      const approvalType = cachedApproved ? "claude-cached" : "auto-fast";
      if (canOpen) {
        const staged = await stageCandidateEntry(c, approvalType, state, livePrices, env, { notifyTrade, sendTelegram, scanSummary });
        if (!staged) {
          finalizeDecision(c, "skipped", "entry-not-staged", { approvalType });
        }
      } else {
        finalizeDecision(c, "rejected", c.score >= claudeThreshold ? "claude-skipped-fast-mode" : "auto-approval-blocked", {
          approvalType
        });
      }
    }
    scanSummary.liveHealth = calculateRecentLiveHealth(state, 100);
    scanSummary.baseline = LIVE_BASELINE;
    state.lastScanSummary = scanSummary;

    const blockedSummary = Object.entries(scanSummary.blockedByReason)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(", ");
    const openedSummary = Object.entries(scanSummary.openedBySetup)
      .map(([setup, count]) => `${setup}:${count}`)
      .join(", ");

    console.log(`[SCAN] FAST Qualified:${qualified.length} Auto:${autoList.length} ClaudeBypassed:${claudeList.length}`);
    console.log(
      `[SCAN SUMMARY] scored:${scanSummary.candidatesScored}/${scanSummary.batchScanned} ` +
      `qualified:${scanSummary.candidatesQualified} opened:${scanSummary.openedCount} ` +
      `blocked:${blockedSummary || "none"} | openedBySetup:${openedSummary || "none"}`
    );
    return;
  }

  for (const c of autoList) {
    const approvalType = c.approvalType || "auto";
    if (approvalType === "claude-cached" || autoApproveSignal(c, regime)) {
      const staged = await stageCandidateEntry(c, approvalType, state, livePrices, env, { notifyTrade, sendTelegram, scanSummary });
      if (!staged) {
        finalizeDecision(c, "skipped", "entry-not-staged", { approvalType });
      }
    } else {
      finalizeDecision(c, "rejected", "auto-approval-blocked", {
        approvalType: "auto"
      });
    }
  }

  if (claudeList.length > 0) {
    try {
      const claudeResult = await claudeBatchAnalysis({
        headlines: [],
        candidatesToValidate: claudeList.slice(0, 5),
        positionsToClose: [],
        regime,
        env,
        state
      });

      if (!state.claudeValidations) state.claudeValidations = {};
      for (const c of claudeList) {
        const v = claudeResult.validations[c.symbol];
        state.claudeValidations[c.symbol] = {
          fingerprint: getSetupFingerprint(c),
          ts: Date.now(),
          approved: v?.approved === true,
          reason: v?.reason || "unknown"
        };
      }
      pruneClaudeValidationCache(state);

      for (const c of claudeList) {
        const v = claudeResult.validations[c.symbol];
        if (v?.approved === true) {
          const staged = await stageCandidateEntry(c, "claude", state, livePrices, env, { notifyTrade, sendTelegram, scanSummary });
          if (staged) {
            console.log(`[${c.symbol}] Claude approved: ${v.reason}`);
          } else {
            finalizeDecision(c, "skipped", "entry-not-staged", {
              approvalType: "claude",
              details: { claudeReason: v.reason || "approved" }
            });
          }
        } else {
          if (v?.reason === "auto-fallback") {
            console.log(`[${c.symbol}] Claude unavailable, fallback decision: ${v.reason}`);
            finalizeDecision(c, "rejected", "claude-unavailable-fallback-rejected", {
              approvalType: "claude",
              details: { claudeReason: v.reason }
            });
          } else {
            console.log(`[${c.symbol}] Claude rejected: ${v?.reason || "no response"}`);
            finalizeDecision(c, "rejected", "claude-rejected", {
              approvalType: "claude",
              details: { claudeReason: v?.reason || "no response" }
            });
          }
        }
      }
    } catch (err) {
      console.error("[CLAUDE VALIDATE]", err.message);
      for (const c of claudeList) {
        if (c.score >= 9 && autoApproveSignal(c, regime)) {
          const staged = await stageCandidateEntry(c, "claude", state, livePrices, env, { notifyTrade, sendTelegram, scanSummary });
          if (staged) {
            console.log(`[${c.symbol}] Claude unavailable, fallback decision: auto-fallback`);
          } else {
            finalizeDecision(c, "skipped", "entry-not-staged", {
              approvalType: "claude",
              details: { claudeReason: "auto-fallback" }
            });
          }
        } else {
          console.log(`[${c.symbol}] Not opened: Claude unavailable and fallback did not approve`);
          finalizeDecision(c, "rejected", "claude-unavailable-fallback-rejected", {
            approvalType: "claude",
            details: { claudeReason: "auto-fallback-rejected" }
          });
        }
      }
    }
  }

  if (qualified.length === 0 && candidates.length > 0) {
    const topScores = candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(c => `${c.symbol}:${c.score.toFixed(1)}(${c.signal})`);
    console.log(`[SCAN] No qualified candidates. Top unqualified: ${topScores.join(", ")} | Threshold:${entryThreshold}`);
  }
  if (candidates.length === 0) {
    console.log(`[SCAN] Zero candidates passed indicator filters. ${batch.length} contracts scanned.`);
  }
  scanSummary.topUnqualified = candidates
    .filter(c => !qualifiedSet.has(c.symbol))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(c => ({
      symbol: c.symbol,
      signal: c.signal,
      score: roundValue(c.score, 2)
    }));
  scanSummary.liveHealth = calculateRecentLiveHealth(state, 100);
  scanSummary.baseline = LIVE_BASELINE;
  state.lastScanSummary = scanSummary;

  const blockedSummary = Object.entries(scanSummary.blockedByReason)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(", ");
  const openedSummary = Object.entries(scanSummary.openedBySetup)
    .map(([setup, count]) => `${setup}:${count}`)
    .join(", ");

  console.log(`[SCAN] Qualified:${qualified.length} Auto:${autoList.length} Claude:${claudeList.length}`);
  console.log(
    `[SCAN SUMMARY] scored:${scanSummary.candidatesScored}/${scanSummary.batchScanned} ` +
    `qualified:${scanSummary.candidatesQualified} opened:${scanSummary.openedCount} ` +
    `blocked:${blockedSummary || "none"} | openedBySetup:${openedSummary || "none"}`
  );
}

async function stageCandidateEntry(candidate, approvalType, state, livePrices, env, deps) {
  const { notifyTrade = async () => {}, sendTelegram = async () => {}, scanSummary = {} } = deps;
  const withApproval = { ...candidate, approvalType };

  // Batch cap: max 2 liquidity-trap entries per scan cycle
  if (candidate.setupType === "liquidity-trap") {
    if (!canOpenMoreTraps(scanSummary)) {
      console.log(`[${candidate.symbol}] Blocked: liquidity-trap batch cap reached`);
      return false;
    }
  }

  const filter = applyEntryFilters(withApproval);

  if (filter.action === "block") {
    console.log(`[${candidate.symbol}] Entry blocked: ${filter.reason}`);
    return false;
  }

  const result = queueEntry(filter.candidate, state, livePrices);

  if (result.action === "enter-market") {
    const openResult = openPositionGradual(result.candidate, state, livePrices, env, {
      sendTelegram
    });
    if (openResult.opened) await notifyTrade("OPEN", result.candidate, state, env);
    return openResult.opened;
  }

  const improvementText = Number.isFinite(result.improvement)
    ? `${result.improvement.toFixed(2)}% better`
    : result.reason || result.action;
  console.log(
    `[${candidate.symbol}] Queued limit entry @$${result.limitPrice} ` +
    `(${improvementText}, ${result.maxCandles} candles)`
  );
  return true;
}

function getTimeFilter() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();

  let nearSettlement = false;
  for (const settleHour of FUNDING_SETTLEMENT_HOURS) {
    const minutesToSettle = ((settleHour - utcHour + 24) % 24) * 60 - utcMin;
    const minutesAfter = ((utcHour - settleHour + 24) % 24) * 60 + utcMin;
    if (minutesToSettle >= 0 && minutesToSettle <= SETTLEMENT_AVOID_MINUTES) { nearSettlement = true; break; }
    if (minutesAfter >= 0 && minutesAfter <= SETTLEMENT_AVOID_MINUTES) { nearSettlement = true; break; }
  }

  const utcDay = now.getUTCDay();
  const isWeekend = utcDay === 0 || utcDay === 6;
  const hourModifier = HOUR_PERFORMANCE[utcHour] || 0;

  return {
    utcHour,
    utcMin,
    nearSettlement,
    isWeekend,
    hourModifier,
    shouldAvoidEntry: nearSettlement,
    scoreAdjustment: nearSettlement ? -1.0 : hourModifier + (isWeekend ? -0.15 : 0)
  };
}

