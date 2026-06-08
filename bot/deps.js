// =============================================================================
// WIRING — assembles dependency bags for runner.js and reports.js.
// No business logic lives here; see claude.js, telegram.js, state.js,
// adaptation.js for the actual implementations.
// =============================================================================

import { callClaudeBudgeted, callClaudePlaintext } from "./claude.js";
import { sendTelegram, notifyTrade } from "./telegram.js";
import { loadBotState, saveBotState } from "./state.js";
import {
  updateDynamicWeights,
  trackSignalPerformance,
  updateRegimeStats,
  getAdaptiveThreshold,
  getWeight,
  printPortfolioSummary
} from "./adaptation.js";
import { runBot as runBotCore } from "./runner.js";
import {
  premarketScan as premarketScanCore,
  reevaluatePositions as reevaluatePositionsCore,
  sendDailyReport as sendDailyReportCore,
  sendWeeklyReview as sendWeeklyReviewCore,
  sendTradeAnalysis as sendTradeAnalysisCore
} from "./reports.js";
import {
  updateCoinHistory,
  getCoinMemory,
  formatCoinMemoryForClaude,
  claudeBatchAnalysis as claudeBatchAnalysisNew
} from "../coin-memory.js";
import { getApprovalStats, getSetupStats } from "./stats.js";

function fallbackResult(candidates) {
  const v = {};
  // Approve candidates that cleared the normal entry threshold (≥4) with a small buffer.
  // score>=10 was far too high — typical good candidates score 4-6.
  for (const c of (candidates || [])) v[c.symbol] = { approved: c.score >= 5, reason: "auto-fallback" };
  return { newsBlocked: [], newsBoosted: [], newsSummary: "", validations: v, journals: {} };
}

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

async function sendRegimeChangeAlert(env, state, prevLabel, regime, tightenedSymbols = []) {
  const positions = Object.values(state.positions);
  const tightenNote = tightenedSymbols.length
    ? `\n⚡ Auto-tightened to breakeven:\n${tightenedSymbols.map(s => `  ${s}`).join("\n")}`
    : "";
  const msg = `🔄 REGIME: ${prevLabel} → ${regime.label}\nHMM:${regime.hmmLabel} PI:${regime.piCycle} Markov:${regime.markovProb.toFixed(3)}\nOpen: ${positions.length} positions${tightenNote}`;

  if (env.ANTHROPIC_API_KEY) {
    try {
      const prompt = `Crypto regime changed ${prevLabel}→${regime.label}. HMM:${regime.hmmLabel} PI:${regime.piCycle} Markov:${regime.markovProb.toFixed(3)}. ${positions.length} open positions: ${positions.map(p => `${p.symbol} ${p.direction}`).join(", ") || "none"}. ${tightenedSymbols.length ? `Already auto-tightened to breakeven: ${tightenedSymbols.join(", ")}.` : ""} In 100 words: implications and any remaining action items. Plain text.`;
      const analysis = await callClaudePlaintext(prompt, env, state, 200);
      await sendTelegram(`${msg}\n\n${analysis}`, env);
    } catch (err) {
      await sendTelegram(msg, env);
    }
  } else {
    await sendTelegram(msg, env);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const reportDeps = {
  callClaudeBudgeted,
  callClaudePlaintext,
  loadState: loadBotState,
  saveState: saveBotState,
  sendTelegram,
  trackSignalPerformance
};

async function runBot(env) {
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

async function sendDailyReport(env, options = {}) {
  return sendDailyReportCore(env, reportDeps, options);
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

async function sendTradeAnalysis(env) {
  return sendTradeAnalysisCore(env, reportDeps);
}

export { runBot, sendDailyReport, sendWeeklyReview, premarketScan, reevaluatePositions, sendTradeAnalysis };
