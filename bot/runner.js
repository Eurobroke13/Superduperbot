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
  drainNullReasons,
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
import { estimateMonthlySpend } from "./stats.js";
import { MONTHLY_BUDGET_USD } from "./config.js";
import { isConfirmedSweep, canOpenMoreTraps } from "./sweep-confirmation.js";
import {
  checkEarlyReversalTighten,
  confirmMeanReversionEntry,
  checkMeanReversionExit
} from "./entry-improvements.js";

import {
  applyBearShort15m,
  applyClaudeSpendGuardrail,
  applyFundingAdjustments,
  applyLunarAdjustments,
  applyMrGate,
  applySyncFilters,
  buildTopUnqualified,
  buildRegimeConsensus,
  checkMidRunDrawdown,
  claudeSpendMode,
  compute4hBias,
  interleaveLongsShorts,
  rankTradeable,
  resolveClaudeFallback,
  resolveClaudeValidations,
  routeToApprovalLists,
  selectTopSignals,
  trimToClosedCandles
} from "./runner-utils.js";
export {
  applyBearShort15m,
  applyClaudeSpendGuardrail,
  applyFundingAdjustments,
  applyLunarAdjustments,
  applyMrGate,
  applySyncFilters,
  buildTopUnqualified,
  buildRegimeConsensus,
  checkMidRunDrawdown,
  claudeSpendMode,
  compute4hBias,
  interleaveLongsShorts,
  rankTradeable,
  resolveClaudeFallback,
  resolveClaudeValidations,
  routeToApprovalLists,
  selectTopSignals,
  trimToClosedCandles
};

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

  // Single-pass: regime refresh + full scan every run.
  // The old 3-phase rotation caused the bot to never scan when lastPhase failed
  // to advance (ran Phase 0 every time). Now every 15-min run does both.
  // Regime refresh is skipped when a custom _phaseRegimeAndExits seam is not
  // provided and the last regime was refreshed less than 14 minutes ago.
  state.lastPhase = 0;

  try {
    const regimeAgeMs = state.lastRegime?.refreshedAt
      ? Date.now() - new Date(state.lastRegime.refreshedAt).getTime()
      : Infinity;
    const regimeFresh = regimeAgeMs < 14 * 60 * 1000;
    // Injectable seam for tests; real runs use phaseRegimeAndExits.
    const _runPhaseRegime = deps._phaseRegimeAndExits ?? phaseRegimeAndExits;

    if (!FAST_SCAN) {
      // Refresh regime every run unless it was just refreshed (e.g. tests pre-set it).
      // Always refresh if no regime cached yet (first run).
      if (!regimeFresh || !state.lastRegime) {
        await _runPhaseRegime(env, state, deps);
      }
    } else {
      await phaseExitsOnly(env, state, deps);
    }
    await phaseScan(env, state, 0, 1.0, deps);
  } catch (err) {
    console.error(`[RUN] Error:`, err.message || err);
  }

  const drift = checkPerformanceDrift(state);
  if (drift?.status === "warning") {
    console.warn("[DRIFT WARNING]", drift.alerts.join(" | "));
  }

  const liveHealth = calculateRecentLiveHealth(state, 100);
  state.lastRunSummary = {
    runAt: new Date().toISOString(),
    phaseStarted: 0,
    nextPhase: 0,
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

      await checkTranches(pos, price, state, { notifyTrade, env });
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

  // ── Multi-TF regime consensus ────────────────────────────────────────────────
  // Daily HMM alone is noisy. Require ≥2 of 3 timeframes (daily, 4H, 1H) to
  // agree before committing to a directional label.  Bear also requires
  // markovProb ≥ 0.55 to confirm.  Disagreement defaults to "sideways".
  try {
    const { ema } = await import("./indicators.js");
    const [btc4h, btc1h] = await Promise.all([
      fetchCandles("BTC-USDT-SWAP", "4h", 60),
      fetchCandles("BTC-USDT-SWAP", "1h", 60)
    ]);

    const h4Bias = btc4h && btc4h.length >= 20 ? compute4hBias(btc4h, { ema }) : "sideways";
    const h1Bias = btc1h && btc1h.length >= 20 ? compute4hBias(btc1h, { ema }) : "sideways";

    regime.h4Bias = h4Bias;
    regime.h1Bias = h1Bias;

    const consensus = buildRegimeConsensus(regime.label, h4Bias, h1Bias, regime.markovProb);
    if (consensus.label !== regime.label) {
      console.log(`[REGIME] Consensus override: ${regime.label} → ${consensus.label} (${consensus.consensus})`);
      regime.label = consensus.label;
      regime.consensusOverride = true;
    } else {
      console.log(`[REGIME] Consensus confirmed: ${regime.label} (${consensus.consensus})`);
    }
    regime.consensusVotes = consensus.votes;
  } catch (err) {
    console.warn("[REGIME] Consensus check failed:", err.message);
  }

  regime.refreshedAt = new Date().toISOString();
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
    // Auto-tighten positions whose direction is now against the regime.
    // When bear → sideways/bull: shorts lose their thesis → tighten SL to breakeven.
    // When bull → sideways/bear: longs lose their thesis → tighten SL to breakeven.
    // We tighten rather than force-close to let the position exit naturally via SL
    // if price is already at entry, and avoid closing into a brief whipsaw.
    const tightenedSymbols = [];
    for (const pos of Object.values(state.positions)) {
      const shortInvalidated = pos.direction === "short" && (regime.label === "bull" || (prevLabel === "bear" && regime.label === "sideways"));
      const longInvalidated  = pos.direction === "long"  && (regime.label === "bear" || (prevLabel === "bull" && regime.label === "sideways"));
      if (shortInvalidated || longInvalidated) {
        const prevSl = pos.sl;
        if (pos.direction === "short") {
          // Tighten: SL moves down toward entry (tighter ceiling)
          pos.sl = Math.min(pos.sl, pos.entryPrice);
        } else {
          // Tighten: SL moves up toward entry (tighter floor)
          pos.sl = Math.max(pos.sl, pos.entryPrice);
        }
        if (pos.sl !== prevSl) {
          tightenedSymbols.push(`${pos.symbol} ${pos.direction} SL ${prevSl.toFixed(6)}→${pos.sl.toFixed(6)}`);
          console.log(`[REGIME] Auto-tightened ${pos.symbol} ${pos.direction} to breakeven (${prevLabel}→${regime.label})`);
        }
      }
    }
    await sendRegimeChangeAlert(env, state, prevLabel, regime, tightenedSymbols);
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
    sleep,
    // IO seams — default to real implementations; injectable for testing
    _fetchAllTickers   = fetchAllTickers,
    _fetchAllContracts = fetchAllContracts,
    _fetchCandles      = fetchCandles,
    _fetchFundingRate  = fetchFundingRate,
    _fetchLunarCrush   = fetchLunarCrush,
    _loadTodayTrades   = loadTodayTrades,
    _scoreSymbol       = scoreSymbol,
    _getApiHealth      = getApiHealth,
    _getTimeFilter     = getTimeFilter,
    _stageCandidateEntry = stageCandidateEntry
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

  const apiHealth = _getApiHealth();
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

  const timeFilter = _getTimeFilter();
  if (timeFilter.shouldAvoidEntry) {
    console.log(`[SCAN] Avoiding entries - near funding settlement (${timeFilter.utcHour}:${String(timeFilter.utcMin).padStart(2, "0")} UTC)`);
    incrementCount(scanSummary.skippedByReason, "funding-settlement-window");
    incrementCount(scanSummary.blockedByReason, "funding-settlement-window");
    state.lastScanSummary = scanSummary;
    return;
  }

  let todayTrades = null;
  try {
    todayTrades = await _loadTodayTrades();
  } catch (err) {
    console.error("[TRADE-STORE] Could not load today's trades:", err.message);
  }
  // Trades closed earlier this run are buffered (not yet committed to the DB),
  // so merge them in to keep the daily-loss gate accurate within the run.
  if (todayTrades && Array.isArray(state._pendingTrades) && state._pendingTrades.length) {
    todayTrades = [...todayTrades, ...state._pendingTrades];
  }
  const dailyCheck = checkDailyLossLimit(state, todayTrades);
  if (!dailyCheck.allowed) {
    console.log(`[SCAN] ${dailyCheck.reason} - halting new entries for today`);
    incrementCount(scanSummary.skippedByReason, "daily-loss-limit");
    incrementCount(scanSummary.blockedByReason, "daily-loss-limit");
    state.lastScanSummary = scanSummary;
    return;
  }

  // ── Mid-run drawdown halt ────────────────────────────────────────────────────
  // If positions hit SL earlier in this same run, block new entries immediately
  // rather than waiting for the daily cap to trigger retroactively next run.
  // Logic lives in the unit-tested checkMidRunDrawdown helper (runner-utils.js).
  if (checkMidRunDrawdown(state)) {
    console.warn("[SCAN] Mid-run drawdown halt: today's realized PnL exceeds -3.0% — skipping new entries");
    incrementCount(scanSummary.skippedByReason, "mid-run-drawdown-halt");
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

  const tickers = await _fetchAllTickers();
  const volumeMap = {};
  const livePrices = {};
  if (tickers) for (const t of tickers) {
    volumeMap[t.contract] = parseFloat(t.volume_24h_quote || t.volume_24h_usd || t.volume_24h || 0);
    if (t.last) livePrices[t.contract] = t.last;
  }

  const allContracts = await _fetchAllContracts();
  if (!allContracts || allContracts.length === 0) return;

  const blocked = state.newsBlocked || [];
  const boosted = state.newsBoosted || [];

  // Symbols that hit a stop-loss earlier in this same run — block same-run re-entry.
  const slThisRun = new Set(
    (state._pendingTrades || []).filter(t => t.reason === "stop-loss").map(t => t.symbol)
  );

  const tradeable = allContracts
    .filter(c => (volumeMap[c] || 0) > 450_000)
    .filter(c => !BLACKLISTED_COINS.has(c))
    .filter(c => !state.positions[c])
    .filter(c => !state.pendingLimits[c])
    .filter(c => !state.decayingLimits[c])
    .filter(c => !cooldownDecision(state, c).onCooldown)
    .filter(c => !slThisRun.has(c))
    .filter(c => !blocked.includes(c.replace("-USDT-SWAP", "")));

  const tickerMap = {};
  if (tickers) {
    for (const t of tickers) {
      tickerMap[t.contract] = t;
    }
  }

  const rankedTradeable = rankTradeable(tradeable, {
    tickerMap,
    volumeMap,
    regimeLabel: regime?.label
  });

  const isSidewaysRegime = regime?.label === "sideways";
  const maxSymbolsPerRun = isSidewaysRegime ? 60 : 50;

  // Rotate through the ranked list across runs so every symbol eventually gets scanned.
  // phaseScan is always called with startFrac=0/endFrac=1 now (phase rotation removed),
  // so we track the offset in state instead.
  const totalTradeable = rankedTradeable.length;
  const offset = (state.scanBatchOffset || 0) % totalTradeable;
  state.scanBatchOffset = (offset + maxSymbolsPerRun) % totalTradeable;

  // Wrap-around: if the window would go past the end, start a second slice from 0
  const sliceA = rankedTradeable.slice(offset, offset + maxSymbolsPerRun);
  const rawBatch = sliceA.length >= maxSymbolsPerRun
    ? sliceA
    : [...sliceA, ...rankedTradeable.slice(0, maxSymbolsPerRun - sliceA.length)];

  const effectiveStart = offset;
  const effectiveEnd   = offset + maxSymbolsPerRun;
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
    `(${effectiveStart}-${Math.min(effectiveEnd, effectiveStart + maxSymbolsPerRun)} of ${rankedTradeable.length})`
  );

  const candidates = [];
  const chunkSize = 10;
  for (let i = 0; i < batch.length; i += chunkSize) {
    const chunk = batch.slice(i, i + chunkSize);
    const results = await Promise.allSettled(chunk.map(s => _scoreSymbol(s, regime, state)));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) candidates.push(r.value);
    }
    if (i + chunkSize < batch.length) await sleep(100);
  }
  scanSummary.candidatesScored = candidates.length;
  scanSummary.candidatesFilteredByScorer = Math.max(0, batch.length - candidates.length);
  const nullReasons = drainNullReasons();
  const nullSummary = Object.entries(nullReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");
  if (nullSummary) console.log(`[SCAN NULL] ${nullSummary}`);

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

  const lunarData = await _fetchLunarCrush(lunarSymbols, env, state);

  for (const c of candidates) {
    const base = c.symbol.replace("-USDT-SWAP", "");
    const lunar = lunarData[base];
    if (!lunar) continue;
    c.lunarSentiment = lunar.sentiment;
    c.lunarGalaxyScore = lunar.galaxyScore;

    const { scoreDelta, reasons } = applyLunarAdjustments(c, lunar, {
      bull: getWeight("lunar-bull", state),
      bear: getWeight("lunar-bear", state),
      warning: getWeight("lunar-sentiment-warning", state)
    });
    c.score += scoreDelta;
    c.reasons.push(...reasons);
  }

  const topSignals = selectTopSignals(candidates, 0.2);
  for (const candidate of topSignals) topSignalSet.add(candidate.symbol);

  if (topSignals.length > 0) {
    const fundingResults = await Promise.allSettled(
      topSignals.map(c => _fetchFundingRate(c.symbol))
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

      const { scoreDelta, reasons } = applyFundingAdjustments(c, fundSig, fundRate);
      c.score += scoreDelta;
      c.reasons.push(...reasons);
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

  // ── Synchronous candidate gates: sideways → liquidity-trap quality → bear ──
  // Ordering, skip semantics, and block-reason tags live in the unit-tested
  // applySyncFilters helper (runner-utils.js).
  for (const c of topSignals) {
    const { score, blockReason } = applySyncFilters(c, {
      regimeLabel: regime.label,
      regimeStats: state.regimeStats
    });
    c.score = score;
    if (blockReason) {
      incrementCount(scanSummary.blockedByReason, blockReason);
      if (blockReason === "lt-quality-gate") console.log(`[${c.symbol}] LT quality gate blocked`);
    }
  }

  // ── MR: fetch 15m candles then apply go/no-go gate ──
  for (const c of topSignals) {
    if (c.score === 0 || c.setupType !== "mean-reversion") continue;
    try {
      const candles15m = await _fetchCandles(c.symbol, "15m", 50);
      if (candles15m && candles15m.length >= 12) c._candles15m = candles15m;
    } catch (_) { /* proceed without 15m — gate will penalize */ }
    const mr = applyMrGate(c, confirmMeanReversionEntry);
    if (mr.blocked) {
      c.score = 0;
      incrementCount(scanSummary.blockedByReason, mr.blockReason);
    } else if (mr.adjustedScore !== undefined) {
      c.adjustedScore = mr.adjustedScore;
      c.positionSizeMultiplier = mr.positionSizeMultiplier;
      if (mr.patterns?.length) c.reasons.push(...mr.patterns);
    }
  }

  // ── Bear shorts: fetch 15m for confirmation ──
  for (const c of topSignals) {
    if (c.score === 0 || c.signal !== "short" || regime.label !== "bear") continue;
    try {
      const candles15m = await _fetchCandles(c.symbol, "15m", 50);
      if (candles15m && candles15m.length >= 12) {
        const confirmation = confirm15mBearShort(candles15m, c.price, c.atrVal);
        c._15mConfirmation = confirmation;
        const m = applyBearShort15m(c, confirmation);
        c.score *= m.scoreFactor;
        if (m.adjustedScore !== undefined) {
          c.adjustedScore = m.adjustedScore;
          c.positionSizeMultiplier = m.positionSizeMultiplier;
          c.reasons.push(...(m.patterns || []));
          console.log(`[${c.symbol}] Bear short 15m confirmed: ${(m.patterns || []).join(", ")}`);
        } else {
          console.log(`[${c.symbol}] Bear short 15m unconfirmed, score reduced`);
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

  const interleaved = interleaveLongsShorts(longs, shorts, slotsAvailable);

  // ── Mean-reversion concurrency cap ───────────────────────────────────────────
  // MR entries fade the same extremes and so correlate heavily — several at once
  // is really one concentrated bet. Cap total concurrent MR at 2 across already-
  // open positions plus this run's picks (highest-scored MR kept, since interleave
  // preserves the per-side score ordering).
  const MAX_CONCURRENT_MR = 2;
  const openMR = Object.values(state.positions).filter(p => p.setupType === "mean-reversion").length;
  let mrBudget = Math.max(0, MAX_CONCURRENT_MR - openMR);
  const toConsider = [];
  for (const candidate of interleaved) {
    if (candidate.setupType === "mean-reversion") {
      if (mrBudget <= 0) {
        finalizeDecision(candidate, "rejected", "mr-concurrency-cap", {
          details: { openMR, cap: MAX_CONCURRENT_MR }
        });
        continue;
      }
      mrBudget--;
    }
    toConsider.push(candidate);
  }
  for (const candidate of toConsider) consideredSet.add(candidate.symbol);

  const { autoList, claudeList, decisions: routingDecisions } = routeToApprovalLists(toConsider, {
    regime, state,
    autoApproveSignalFn: autoApproveSignal,
    checkCorrelationExposureFn: checkCorrelationExposure,
    checkMinRRFn: checkMinRR,
    shouldSkipClaudeFn: shouldSkipClaude
  });
  for (const { candidate, outcome, reason, extra } of routingDecisions) {
    console.log(`[${candidate.symbol}] Blocked: ${reason}`);
    finalizeDecision(candidate, outcome, reason, extra || {});
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
        const staged = await _stageCandidateEntry(c, approvalType, state, livePrices, env, { notifyTrade, sendTelegram, scanSummary });
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
      const staged = await _stageCandidateEntry(c, approvalType, state, livePrices, env, { notifyTrade, sendTelegram, scanSummary });
      if (!staged) {
        finalizeDecision(c, "skipped", "entry-not-staged", { approvalType });
      }
    } else {
      finalizeDecision(c, "rejected", "auto-approval-blocked", {
        approvalType: "auto"
      });
    }
  }

  // ── Claude spend guardrail ───────────────────────────────────────────────────
  const claudeSpend = estimateMonthlySpend(state.tokenUsage || { input: 0, output: 0 });
  const spendMode = applyClaudeSpendGuardrail(claudeList, autoList, {
    spend: claudeSpend,
    budget: MONTHLY_BUDGET_USD
  });
  if (spendMode === "exceeded") {
    console.warn(`[CLAUDE] Monthly budget exhausted ($${claudeSpend.toFixed(2)}/$${MONTHLY_BUDGET_USD}) — skipping all Claude calls`);
  } else if (spendMode === "warning") {
    const pct = MONTHLY_BUDGET_USD > 0 ? ((claudeSpend / MONTHLY_BUDGET_USD) * 100).toFixed(0) : "?";
    console.warn(`[CLAUDE] Budget at ${pct}% ($${claudeSpend.toFixed(2)}/$${MONTHLY_BUDGET_USD}) — switching to auto-only`);
  }

  if (claudeList.length > 0) {
    try {
      const claudeResult = await claudeBatchAnalysis({
        headlines: [],
        candidatesToValidate: claudeList.slice(0, 5),
        positionsToClose: [],
        regime, env, state
      });

      if (!state.claudeValidations) state.claudeValidations = {};
      const { cacheEntries, routing } = resolveClaudeValidations(claudeList, claudeResult, {
        getSetupFingerprintFn: getSetupFingerprint
      });
      Object.assign(state.claudeValidations, cacheEntries);
      pruneClaudeValidationCache(state);

      for (const { candidate, action, approvalType, claudeReason } of routing) {
        if (action === "stage") {
          const staged = await _stageCandidateEntry(candidate, approvalType, state, livePrices, env, { notifyTrade, sendTelegram, scanSummary });
          if (staged) {
            console.log(`[${candidate.symbol}] Claude approved: ${claudeReason}`);
          } else {
            finalizeDecision(candidate, "skipped", "entry-not-staged", {
              approvalType, details: { claudeReason }
            });
          }
        } else {
          const skipReason = action === "fallback-rejected"
            ? "claude-unavailable-fallback-rejected"
            : "claude-rejected";
          console.log(`[${candidate.symbol}] Claude ${action}: ${claudeReason}`);
          finalizeDecision(candidate, "rejected", skipReason, {
            approvalType, details: { claudeReason }
          });
        }
      }
    } catch (err) {
      console.error("[CLAUDE VALIDATE]", err.message);
      const fallbackRouting = resolveClaudeFallback(claudeList, {
        regime, autoApproveSignalFn: autoApproveSignal, scoreThreshold: 9
      });
      for (const { candidate, action, approvalType, claudeReason } of fallbackRouting) {
        if (action === "stage") {
          const staged = await _stageCandidateEntry(candidate, approvalType, state, livePrices, env, { notifyTrade, sendTelegram, scanSummary });
          if (staged) {
            console.log(`[${candidate.symbol}] Claude unavailable, fallback decision: ${claudeReason}`);
          } else {
            finalizeDecision(candidate, "skipped", "entry-not-staged", {
              approvalType, details: { claudeReason }
            });
          }
        } else {
          console.log(`[${candidate.symbol}] Not opened: Claude unavailable and fallback did not approve`);
          finalizeDecision(candidate, "rejected", "claude-unavailable-fallback-rejected", {
            approvalType, details: { claudeReason }
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
  scanSummary.topUnqualified = buildTopUnqualified(candidates, qualifiedSet, roundValue);
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

