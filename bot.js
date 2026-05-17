// =============================================================================
// QUANT PAPER-TRADING BOT
// Railway runtime module: strategy/reporting helpers used by server.js and
// task-runner.js. This file no longer owns HTTP routing or cron entrypoints.
// =============================================================================

import {
  ANTHROPIC_API, CLAUDE_MODEL,
  PAPER_CASH,
  MAX_POSITIONS, ENTRY_THRESHOLD,
  MONTHLY_BUDGET_USD,
  SIGNAL_WEIGHTS, BASE_WEIGHTS,
} from "./bot/config.js";
import {
  estimateMonthlySpend,
  getApprovalStats,
  getSetupStats,
} from "./bot/stats.js";
import {
  fetchAllTickers
} from "./bot/market-data.js";
import { portfolioValue } from "./bot/execution.js";
import {
  premarketScan as premarketScanCore,
  reevaluatePositions as reevaluatePositionsCore,
  sendDailyReport as sendDailyReportCore,
  sendRiskAssessment as sendRiskAssessmentCore,
  sendWeeklyReview as sendWeeklyReviewCore
} from "./bot/reports.js";
import { runBot as runBotCore } from "./bot/runner.js";
import { getWeightRegimeAware } from "./bot/risk-gates.js";
import {
  loadState as loadPersistedState,
  saveState as savePersistedState
} from "./state-store.js";
import {
  updateCoinHistory,
  getCoinMemory,
  formatCoinMemoryForClaude,
  claudeBatchAnalysis as claudeBatchAnalysisNew
} from "./coin-memory.js";

// =============================================================================
// RAILWAY ENTRY SURFACE
// The active HTTP service lives in server.js and cron entrypoints live in task-runner.js.
// This module only exports bot/report functions used by those Railway wrappers.
// =============================================================================

async function claudeBatchAnalysis(params) {
  return claudeBatchAnalysisNew({
    ...params,
    deps: {
      callClaudeBudgeted,
      getCoinMemory,
      formatCoinMemory: formatCoinMemoryForClaude,
      getApprovalStats,
      getSetupStats,
      getWeight,
      fallbackResult
    }
  });
}

function fallbackResult(candidates) {
  const v = {};
  for (const c of (candidates || [])) v[c.symbol] = { approved: c.score >= 10, reason: "auto-fallback" };
  return { newsBlocked: [], newsBoosted: [], newsSummary: "", validations: v, journals: {} };
}

// =============================================================================
// REGIME CHANGE ALERT
// =============================================================================
async function sendRegimeChangeAlert(env, state, prevLabel, regime) {
  const positions = Object.values(state.positions);
  const msg = `🔄 REGIME: ${prevLabel} → ${regime.label}\nHMM:${regime.hmmLabel} PI:${regime.piCycle} Markov:${regime.markovProb.toFixed(3)}\nOpen: ${positions.length} positions`;

  if (env.ANTHROPIC_API_KEY) {
    try {
      const prompt = `Crypto regime changed ${prevLabel}→${regime.label}. HMM:${regime.hmmLabel} PI:${regime.piCycle} Markov:${regime.markovProb.toFixed(3)}. ${positions.length} open positions: ${positions.map(p => `${p.symbol} ${p.direction}`).join(", ") || "none"}. In 100 words: implications and action items. Plain text.`;
      const analysis = await callClaudePlaintext(prompt, env, state, 200);
      await sendTelegram(`${msg}\n\n${analysis}`, env);
    } catch (err) {
      await sendTelegram(msg, env);
    }
  } else {
    await sendTelegram(msg, env);
  }
}

// =============================================================================
// PERIODIC REPORT
// =============================================================================
const reportDeps = {
  callClaudeBudgeted,
  callClaudePlaintext,
  loadState: loadBotState,
  saveState: saveBotState,
  sendTelegram,
  trackSignalPerformance
};

async function sendDailyReport(env, options = {}) {
  return sendDailyReportCore(env, reportDeps, options);
}

async function sendRiskAssessment(env) {
  return sendRiskAssessmentCore(env, reportDeps);
}

async function sendWeeklyReview(env) {
  return sendWeeklyReviewCore(env, reportDeps);
}

async function premarketScan(env) {
  return premarketScanCore(env, reportDeps);
}

async function reevaluatePositions(env) {
  return reevaluatePositionsCore(env, reportDeps);
}

// =============================================================================
// SIGNAL PERFORMANCE TRACKING
// =============================================================================
function trackSignalPerformance(state) {
  updateDynamicWeights(state);
}

function updateDynamicWeights(state) {
  const recent = state.trades.slice(-80);
  if (recent.length < 10) return;

  const stats = {};
  for (const trade of recent) {
    const won = trade.pnl > 0;
    const regime = trade.regime || "unknown";

    for (const reason of (trade.reasons || [])) {
      if (!stats[reason]) stats[reason] = { wins: 0, losses: 0, pnl: 0 };
      stats[reason].wins += won ? 1 : 0;
      stats[reason].losses += won ? 0 : 1;
      stats[reason].pnl += trade.pnl;

      const regimeKey = `${reason}:${regime}`;
      if (!stats[regimeKey]) stats[regimeKey] = { wins: 0, losses: 0, pnl: 0 };
      stats[regimeKey].wins += won ? 1 : 0;
      stats[regimeKey].losses += won ? 0 : 1;
      stats[regimeKey].pnl += trade.pnl;
    }
  }

  if (!state.signalStats) state.signalStats = {};
  for (const [key, s] of Object.entries(stats)) {
    const count = s.wins + s.losses;
    state.signalStats[key] = {
      wins: s.wins,
      losses: s.losses,
      count,
      totalPnl: parseFloat(s.pnl.toFixed(2))
    };
  }

  const newWeights = { ...(state.dynamicWeights || {}) };
  for (const [signal, s] of Object.entries(stats)) {
    if (signal.includes(":")) continue;
    const count = s.wins + s.losses;
    if (count < 8) continue;

    const wr = s.wins / count;
    const ev = s.pnl / count;
    let mult = 1.0;
    if      (wr >= 0.65 && ev > 0) mult = 1.40;
    else if (wr >= 0.55 && ev > 0) mult = 1.20;
    else if (wr >= 0.50 && ev >= 0) mult = 1.05;
    else if (wr >= 0.47 && ev >= 0) mult = 0.90;
    else if (wr < 0.35 || ev < 0)  mult = 0.55;
    else if (wr < 0.42)            mult = 0.65;
    else if (wr < 0.47)            mult = 0.75;

    newWeights[signal] = parseFloat(mult.toFixed(3));
    if (Math.abs(newWeights[signal] - 1.0) > 0.2) {
      console.log(`[WEIGHTS] ${signal}: 1.0 -> ${newWeights[signal]} (WR:${(wr * 100).toFixed(0)}% n=${count} ev:$${ev.toFixed(2)})`);
    }
  }
  state.dynamicWeights = newWeights;

  const disabled = [];
  for (const [signal, s] of Object.entries(stats)) {
    if (signal.includes(":")) continue;
    const count = s.wins + s.losses;
    if (count >= 25 && s.wins / count < 0.30 && s.pnl / count < 0) {
      disabled.push(signal);
      console.warn(`[WEIGHTS] DISABLED "${signal}": WR=${((s.wins / count) * 100).toFixed(0)}% over ${count} trades`);
    }
  }
  state.disabledSignals = Array.from(new Set([...disabled, "trap-vol-bear"]));
  state.lastWeightUpdate = Date.now();
  console.log(`[WEIGHTS] Updated ${Object.keys(newWeights).length} signal weights from ${recent.length} trades`);
}

function getWeight(signal, state) {
  const regimeLabel = state.lastRegime?.label || "unknown";
  return getWeightRegimeAware(signal, state, regimeLabel, SIGNAL_WEIGHTS);
}

function getRegimePerformance(state, regimeLabel) {
  const regimeTrades = state.trades.filter(t => {
    const history = (state.coinHistory || {})[t.symbol];
    if (history) {
      const match = history.find(h => h.date === (t.closedAt || "").split("T")[0]);
      if (match) return match.regime === regimeLabel;
    }
    return false;
  });
  const trades = regimeTrades.length >= 5 ? regimeTrades : state.trades.slice(-50);
  const wins   = trades.filter(t => t.pnl > 0).length;
  const total  = trades.length;
  return {
    total,
    wins,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(0) : "N/A",
    avgPnl:  total > 0 ? (trades.reduce((s, t) => s + t.pnl, 0) / total).toFixed(2) : "0"
  };
}
// =============================================================================
// UPGRADE 3 — REGIME-CONDITIONAL PERFORMANCE TRACKING
// =============================================================================

function updateRegimeStats(state, trade) {
  if (!state.regimeStats) {
    state.regimeStats = {
      bull:     { wins: 0, losses: 0, totalPnl: 0, count: 0 },
      bear:     { wins: 0, losses: 0, totalPnl: 0, count: 0 },
      sideways: { wins: 0, losses: 0, totalPnl: 0, count: 0 }
    };
  }

  // Determine regime (simple + reliable)
  const regime = state.lastRegime?.label || "sideways";

  if (!state.regimeStats[regime]) {
    state.regimeStats[regime] = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
  }

  const rs = state.regimeStats[regime];

  rs.count++;
  rs.totalPnl += trade.pnl;

  if (trade.pnl > 0) rs.wins++;
  else rs.losses++;
}


// -----------------------------------------------------------------------------

function getAdaptiveThreshold(state, currentRegime) {
  if (!state.regimeStats) return ENTRY_THRESHOLD;

  const rs = state.regimeStats[currentRegime];
  if (!rs || rs.count < 15) {
    return currentRegime === "chop" || currentRegime === "sideways"
      ? ENTRY_THRESHOLD + 0.5
      : ENTRY_THRESHOLD;
  }

  const winRate = rs.wins / rs.count;
  const avgPnl  = rs.totalPnl / rs.count;

  let adjustment = 0;

  if (winRate > 0.55 && avgPnl > 0) {
    adjustment = -1;
  } else if (winRate >= 0.45) {
    adjustment = 0;
  } else if (winRate >= 0.38) {
    adjustment = 0.5;
  } else {
    adjustment = 1;
  }

  if (currentRegime === "chop" || currentRegime === "sideways") {
    adjustment += 0.5;
  }

  adjustment = Math.min(adjustment, 1.5);

  const adaptive = Math.max(5, Math.min(6, ENTRY_THRESHOLD + adjustment));

  if (adaptive !== ENTRY_THRESHOLD) {
    console.log(
      `[REGIME ADAPT] ${currentRegime} WR=${(winRate * 100).toFixed(0)}% ` +
      `n=${rs.count} avgPnL=${avgPnl.toFixed(2)} → ${ENTRY_THRESHOLD}→${adaptive}`
    );
  }

  return adaptive;
}


// -----------------------------------------------------------------------------




// =============================================================================
// CLAUDE API — BUDGET GUARDED
// =============================================================================

function initTokenUsage(state) {
  const now = new Date();
  const key = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
  if (!state.tokenUsage || state.tokenUsage.month !== key) {
    state.tokenUsage = { month: key, input: 0, output: 0, calls: 0 };
  }
}

function checkBudget(state) {
  const spend = estimateMonthlySpend(state.tokenUsage);
  if (spend >= 38) {
    console.warn(`[CLAUDE] BUDGET LIMIT $${spend.toFixed(2)} >= $38`);
    return false;
  }
  const now   = new Date();
  const day   = now.getUTCDate();
  const days  = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const pace  = (MONTHLY_BUDGET_USD / days) * day;
  if (spend > pace * 1.3) {
    console.warn(`[CLAUDE] Overpacing: $${spend.toFixed(2)} vs expected $${pace.toFixed(2)}`);
  }
  return true;
}

function trackUsage(state, data) {
  const u = data.usage || {};
  state.tokenUsage.input  += u.input_tokens  || 0;
  state.tokenUsage.output += u.output_tokens  || 0;
  state.tokenUsage.calls  += 1;
  const spend = estimateMonthlySpend(state.tokenUsage);
  console.log(`[CLAUDE] #${state.tokenUsage.calls} +${u.input_tokens || 0}in +${u.output_tokens || 0}out | $${spend.toFixed(2)}/$${MONTHLY_BUDGET_USD}`);
}

async function callClaudeBudgeted(prompt, env, state, maxTokens = 500) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("No ANTHROPIC_API_KEY");
  initTokenUsage(state);
  if (!checkBudget(state)) throw new Error("Claude budget exhausted");

  // Throttle tokens if overpacing
  const spend = estimateMonthlySpend(state.tokenUsage);
  const now   = new Date();
  const pace  = (MONTHLY_BUDGET_USD / new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate()) * now.getUTCDate();
  if (spend > pace * 1.2) maxTokens = Math.min(maxTokens, 300);

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "{" }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    if (
      errText.includes("You have reached your specified API") ||
      errText.includes("invalid_request_error")
    ) {
      console.warn("[CLAUDE] Budget/account limit hit, falling back to non-Claude mode");
      throw new Error("CLAUDE_LIMIT_FALLBACK");
    }
    throw new Error(`Claude ${res.status}: ${errText}`);
  }
  const data = await res.json();
  trackUsage(state, data);
  const text = data.content.map(b => b.text || "").join("").trim();
  return "{" + text;
}

async function callClaudePlaintext(prompt, env, state, maxTokens = 500) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("No ANTHROPIC_API_KEY");
  initTokenUsage(state);
  if (!checkBudget(state)) throw new Error("Claude budget exhausted");

  const spend = estimateMonthlySpend(state.tokenUsage);
  const now   = new Date();
  const pace  = (MONTHLY_BUDGET_USD / new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate()) * now.getUTCDate();
  if (spend > pace * 1.2) maxTokens = Math.min(maxTokens, 200);

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    if (
      errText.includes("You have reached your specified API") ||
      errText.includes("invalid_request_error")
    ) {
      console.warn("[CLAUDE] Budget/account limit hit, falling back to non-Claude mode");
      throw new Error("CLAUDE_LIMIT_FALLBACK");
    }
    throw new Error(`Claude ${res.status}: ${errText}`);
  }
  const data = await res.json();
  trackUsage(state, data);
  return data.content.map(b => b.text || "").join("").trim();
}

// =============================================================================
// TELEGRAM
// =============================================================================
async function sendTelegram(message, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const text = message.length > 4000 ? message.substring(0, 4000) + "\n...(truncated)" : message;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text })
    });
    if (!res.ok) console.error("[TG]", await res.text());
  } catch (err) {
    console.error("[TG]", err.message);
  }
}

async function notifyTrade(action, details, state, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  let msg;
  if (action === "OPEN") {
    const dir = (details.signal || details.direction || "").toUpperCase();
    const emoji = dir === "LONG" ? "🟢" : "🔴";
    msg = `${emoji} OPEN ${dir} ${details.symbol}\nEntry:$${details.price.toFixed(4)} SL:$${details.sl.toFixed(4)} TP:$${details.tp.toFixed(4)}\nScore:${details.score}\n[${(details.reasons || []).slice(0, 5).join(",")}]`;
  } else if (action === "PARTIAL") {
    msg = `📊 PARTIAL ${(details.direction || "").toUpperCase()} ${details.symbol}\n${((details.pct || 0) * 100).toFixed(0)}% closed @$${(details.exitPrice || 0).toFixed(4)}\n${details.reason}\nPnL:$${(details.pnl || 0).toFixed(2)}`;
  } else if (action === "DCA") {
    msg = `📉 DCA ${(details.direction || "").toUpperCase()} ${details.symbol}\n+50% @$${(details.price || 0).toFixed(4)} | Avg:$${(details.entryPrice || 0).toFixed(4)}\nMargin:$${(details.notional || 0).toFixed(2)}`;
  } else {
    const pnl = details.direction === "long"
      ? ((details.exitPrice || 0) - (details.entryPrice || 0)) * (details.size || 0)
      : ((details.entryPrice || 0) - (details.exitPrice || 0)) * (details.size || 0);
    const emoji = pnl >= 0 ? "💰" : "💸";
    msg = `${emoji} CLOSE ${(details.direction || "").toUpperCase()} ${details.symbol}\nExit:$${(details.exitPrice || 0).toFixed(4)} | ${details.exitReason || details.reason}\nPnL:$${pnl.toFixed(2)}`;
  }
  await sendTelegram(msg, env);
}

// =============================================================================
// STATE PERSISTENCE
// =============================================================================
async function loadBotState(env) {
  try {
    const state = await loadPersistedState();
    state.disabledSignals = Array.from(new Set([...(state.disabledSignals || []), "trap-vol-bear"]));
    return state;
  } catch (err) {
    console.error("[DB] CRITICAL: Failed to load state:", err.message);
    throw new Error("State load failed - aborting: " + err.message);
  }
}

async function saveBotState(env, state) {
  try {
    if (state.weeklyReviews && state.weeklyReviews.length > 12) state.weeklyReviews = state.weeklyReviews.slice(-12);
    if (state.claudeValidations) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [symbol, entry] of Object.entries(state.claudeValidations)) {
        if (!entry?.ts || entry.ts < cutoff) delete state.claudeValidations[symbol];
      }
    }
    if (state.volatilityFlags) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const [symbol, flag] of Object.entries(state.volatilityFlags)) {
        if (!flag?.ts || flag.ts < cutoff) delete state.volatilityFlags[symbol];
      }
    }
    if (state.coinHistory) {
      const coins = Object.keys(state.coinHistory);
      if (coins.length > 100) {
        const active = new Set([
          ...Object.keys(state.positions),
          ...state.trades.slice(-50).map(t => t.symbol)
        ]);
        for (const coin of coins) {
          if (!active.has(coin)) delete state.coinHistory[coin];
        }
      }
    }
    await savePersistedState(state);
  } catch (err) {
    console.error("[DB]", err.message);
  }
}

// =============================================================================
// PORTFOLIO SUMMARY
// =============================================================================
function printPortfolioSummary(state) {
  const open = Object.keys(state.positions).length;
  const total = state.trades.length;
  const pnl = state.trades.reduce((s, t) => s + t.pnl, 0);
  const wins = state.trades.filter(t => t.pnl > 0).length;
  const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : "N/A";
  const val = portfolioValue(state);
  const dd = state.peakValue ? ((state.peakValue - val) / state.peakValue * 100).toFixed(1) : "0.0";
  const cb = state.circuitBreakerActive ? " ⚠CB" : "";
  const spend = estimateMonthlySpend(state.tokenUsage || { input: 0, output: 0 });
  console.log(`=== $${val.toFixed(2)} | Cash:$${state.cash.toFixed(2)} | ${open}/${MAX_POSITIONS} | ${total}trades PnL:$${pnl.toFixed(2)} WR:${wr}% DD:${dd}% | ${state.lastRegime?.label ?? "?"}${cb} | Claude:$${spend.toFixed(2)} ===`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runBotRailway(env) {
  return runBotCore(env, {
    claudeBatchAnalysis,
    getAdaptiveThreshold,
    getWeight,
    loadState: loadBotState,
    notifyTrade,
    printPortfolioSummary,
    saveState: saveBotState,
    sendRegimeChangeAlert,
    sendTelegram,
    sleep,
    updateCoinHistory,
    updateDynamicWeights,
    updateRegimeStats
  });
}

export {
  runBotRailway as runBot,
  sendDailyReport,
  sendWeeklyReview,
  premarketScan,
  reevaluatePositions
};
