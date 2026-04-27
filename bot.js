// =============================================================================
// QUANT PAPER-TRADING BOT — Cloudflare Worker (v4-free)
//
// Cloudflare FREE tier compliant:
//   • 5 cron triggers (max on free plan)
//   • KV: <1000 writes/day, <100k reads/day
//   • CPU: kept lean with batched API calls + phase execution
//   • Claude: $40/month budget guard
//
// Crons (5 max for free tier):
//   Main bot cadence should match wrangler: */15 * * * *
//   "*/20 * * * *"  — main bot (3 phases per hour)
//   "0 0 * * *"     — pre-market scan
//   "0 8 * * *"     — daily report + risk assessment combined
//   "0 */4 * * *"   — position re-evaluation
//   "0 10 * * 6"    — weekly strategy review (Saturday)
//
// KV binding: PAPER_TRADES
// Secrets: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LUNARCRUSH_API_KEY
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
import { loadState as loadStateFromDb, saveState as saveStateToDb } from "./state-store.js";

// =============================================================================
// ENTRY POINT
// =============================================================================
export default {
  async scheduled(event, env, ctx) {
    try {
      const hour   = new Date().getUTCHours();
      const minute = new Date().getUTCMinutes();

      if (event.cron === "0 10 * * 6") {
        await sendWeeklyReview(env);
      } else if (event.cron === "0 0 * * *") {
        await premarketScan(env);
      } else if (event.cron === "0 8 * * *") {
        await sendDailyReport(env);
      } else if (event.cron === "0 */4 * * *") {
        // Skip if it's 0 or 8 UTC (handled by other crons)
        if (hour !== 0 && hour !== 8) {
          await reevaluatePositions(env);
        }
      } else {
        // */20 * * * * — main bot run
        // Main bot cadence is expected to be driven by a */15 wrangler cron.
        await runBotRailway(env);
      }
    } catch (err) {
      console.error("[BOT] Fatal:", err.message || err);
    }
  },

  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/run") {
      await runBotRailway(env);
      const state = await loadState(env);
      return jsonResponse(state);
    }
    if (path === "/report") {
      await sendDailyReport(env, { force: true });
      return new Response("Report sent.");
    }
    if (path === "/risk") {
      await sendRiskAssessment(env);
      return new Response("Risk assessment sent.");
    }
    if (path === "/weekly") {
      await sendWeeklyReview(env);
      return new Response("Weekly review sent.");
    }
    if (path === "/premarket") {
      await premarketScan(env);
      return new Response("Pre-market scan sent.");
    }
    if (path === "/state") {
      return jsonResponse(await loadState(env));
    }
    if (path === "/budget") {
      const state = await loadState(env);
      const spend = estimateMonthlySpend(state.tokenUsage || { input: 0, output: 0 });
      return jsonResponse({
        month: state.tokenUsage?.month || "none",
        calls: state.tokenUsage?.calls || 0,
        inputTokens: state.tokenUsage?.input || 0,
        outputTokens: state.tokenUsage?.output || 0,
        spent: `$${spend.toFixed(2)}`,
        budget: `$${MONTHLY_BUDGET_USD}`,
        remaining: `$${Math.max(0, MONTHLY_BUDGET_USD - spend).toFixed(2)}`
      });
    }
    if (path === "/reset") {
      await env.PAPER_TRADES.delete(KV_KEY);
      return new Response("State reset. Bot will start fresh on next run.");
    }
    if (path === "/positions") {
      const state = await loadState(env);
      const tickers = await fetchAllTickers();
      const priceMap = {};
      if (tickers) for (const t of tickers) priceMap[t.contract] = t.last;

      const positions = Object.values(state.positions).map(pos => {
        const currentPrice = priceMap[pos.symbol] || pos.entryPrice;
        const rawPnl = pos.direction === "long"
          ? (currentPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - currentPrice) * pos.size;
        const clampPnl = Math.max(rawPnl, -pos.notional);
        const pnlPct = pos.notional > 0 ? (clampPnl / pos.notional) * 100 : 0;
        const hoursOpen = ((Date.now() - new Date(pos.openedAt).getTime()) / 3600000).toFixed(1);

        // Tranche info
        const trancheFilled = pos.tranches?.plan
          ? [pos.tranches.plan.tranche1?.filled, pos.tranches.plan.tranche2?.filled, pos.tranches.plan.tranche3?.filled]
          .filter(Boolean).length
          : "?";

        // TP levels hit
        const tpHit = pos.tpLevels
          ? [pos.tpLevels.tp1?.hit ? "TP1" : null, pos.tpLevels.tp2?.hit ? "TP2" : null]
          .filter(Boolean).join(",") || "none"
          : "n/a";

        // Distance to SL and TP
        const slDist = pos.direction === "long"
          ? ((currentPrice - pos.sl) / currentPrice * 100).toFixed(2)
          : ((pos.sl - currentPrice) / currentPrice * 100).toFixed(2);
        const tpDist = pos.direction === "long"
          ? ((pos.tp - currentPrice) / currentPrice * 100).toFixed(2)
          : ((currentPrice - pos.tp) / currentPrice * 100).toFixed(2);

        return {
          symbol: pos.symbol,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          currentPrice,
          pnl: parseFloat(clampPnl.toFixed(2)),
          pnlPct: parseFloat(pnlPct.toFixed(2)),
          status: clampPnl >= 0 ? "✅ PROFIT" : "❌ LOSS",
          notional: parseFloat(pos.notional.toFixed(2)),
          exposure: parseFloat(pos.effectiveExposure?.toFixed(2) || 0),
          leverage: pos.leverage,
          sl: pos.sl,
          tp: pos.tp,
          slDistance: `${slDist}%`,
          tpDistance: `${tpDist}%`,
          hoursOpen: `${hoursOpen}h`,
          score: pos.score,
          tranches: `${trancheFilled}/3`,
          tpLevelsHit: tpHit,
          dcaApplied: pos.dcaApplied || false,
          reasons: (pos.reasons || []).slice(0, 6)
        };
      });

      // Sort: biggest loss first
      positions.sort((a, b) => a.pnl - b.pnl);

      // Portfolio summary
      const totalUnrealizedPnl = positions.reduce((s, p) => s + p.pnl, 0);
      const totalRealizedPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
      const portfolioVal = state.cash + Object.values(state.positions).reduce((s, p) => s + p.notional, 0) + totalUnrealizedPnl;

      const summary = {
        portfolio: {
          value: parseFloat(portfolioVal.toFixed(2)),
          cash: parseFloat(state.cash.toFixed(2)),
          unrealizedPnl: parseFloat(totalUnrealizedPnl.toFixed(2)),
          realizedPnl: parseFloat(totalRealizedPnl.toFixed(2)),
          totalPnl: parseFloat((totalUnrealizedPnl + totalRealizedPnl).toFixed(2)),
          drawdownFromPeak: state.peakValue
            ? `${((state.peakValue - portfolioVal) / state.peakValue * 100).toFixed(2)}%`
            : "0%",
          startingCapital: PAPER_CASH,
          overallReturn: `${(((portfolioVal + totalRealizedPnl - PAPER_CASH) / PAPER_CASH) * 100).toFixed(2)}%`,
          regime: state.lastRegime?.label || "unknown",
          circuitBreaker: state.circuitBreakerActive || false
        },
        openPositions: positions.length,
        maxPositions: MAX_POSITIONS,
        positions,
        recentClosedTrades: state.trades.slice(-5).map(t => ({
          symbol: t.symbol,
          direction: t.direction,
          pnl: t.pnl,
          pnlPct: t.pnlPct,
          reason: t.reason,
          closedAt: t.closedAt
        }))
      };

      return new Response(JSON.stringify(summary, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    if (path === "/pnl") {
  const state = await loadState(env);
  const tickers = await fetchAllTickers();
  const priceMap = {};
  if (tickers) for (const t of tickers) priceMap[t.contract] = t.last;

  let text = `=== PORTFOLIO ===\n`;
  text += `Cash: $${state.cash.toFixed(2)}\n`;
  text += `Regime: ${state.lastRegime?.label || "?"}\n\n`;

  let totalUnrealized = 0;
  const positions = Object.values(state.positions);

  if (positions.length === 0) {
    text += `No open positions.\n`;
  } else {
    text += `=== ${positions.length} OPEN POSITIONS ===\n\n`;

    for (const pos of positions) {
      const cp = priceMap[pos.symbol] || pos.entryPrice;
      const pnl = pos.direction === "long"
        ? (cp - pos.entryPrice) * pos.size
        : (pos.entryPrice - cp) * pos.size;
      const clamped = Math.max(pnl, -pos.notional);
      const pct = pos.notional > 0 ? (clamped / pos.notional) * 100 : 0;
      totalUnrealized += clamped;
      const hours = ((Date.now() - new Date(pos.openedAt).getTime()) / 3600000).toFixed(1);
      const icon = clamped >= 0 ? "✅" : "❌";
      const trFilled = pos.tranches?.plan
        ? [pos.tranches.plan.tranche1?.filled, pos.tranches.plan.tranche2?.filled, pos.tranches.plan.tranche3?.filled].filter(Boolean).length
        : "?";

      text += `${icon} ${pos.symbol}\n`;
      text += `   ${pos.direction.toUpperCase()} ${pos.leverage}x | Score:${pos.score}\n`;
      text += `   Entry: $${pos.entryPrice.toFixed(4)}  Now: $${cp.toFixed(4)}\n`;
      text += `   PnL: $${clamped.toFixed(2)} (${pct.toFixed(1)}%)\n`;
      text += `   SL: $${pos.sl.toFixed(4)}  TP: $${pos.tp.toFixed(4)}\n`;
      text += `   Margin: $${pos.notional.toFixed(2)} | Tranches: ${trFilled}/3\n`;
      text += `   DCA: ${pos.dcaApplied ? "yes @$" + (pos.dcaPrice || 0).toFixed(4) : "no"}\n`;
      text += `   Open: ${hours}h\n\n`;
    }
  }

  const totalRealized = state.trades.reduce((s, t) => s + t.pnl, 0);
  const portfolioVal = state.cash + positions.reduce((s, p) => s + p.notional, 0) + totalUnrealized;

  text += `=== TOTALS ===\n`;
  text += `Unrealized PnL: $${totalUnrealized.toFixed(2)}\n`;
  text += `Realized PnL:   $${totalRealized.toFixed(2)}\n`;
  text += `Total PnL:      $${(totalUnrealized + totalRealized).toFixed(2)}\n`;
  text += `Portfolio Value: $${portfolioVal.toFixed(2)}\n`;
  text += `Started:         $${PAPER_CASH.toFixed(2)}\n`;
  text += `Return:          ${(((portfolioVal - PAPER_CASH + totalRealized) / PAPER_CASH) * 100).toFixed(2)}%\n`;

  const wins = state.trades.filter(t => t.pnl > 0).length;
  const total = state.trades.length;
  text += `\n=== STATS ===\n`;
  text += `Trades: ${total} | Wins: ${wins} | WR: ${total > 0 ? ((wins/total)*100).toFixed(1) : "N/A"}%\n`;
  text += `Claude: $${estimateMonthlySpend(state.tokenUsage || {input:0,output:0}).toFixed(2)}/$${MONTHLY_BUDGET_USD}\n`;

  return new Response(text, { headers: { "Content-Type": "text/plain" } });
}
    
    return new Response(
      "Quant Bot v4\n\n" +
      "GET /run        — trigger scan\n" +
      "GET /positions  — live P&L (JSON)\n" +
      "GET /pnl        — live P&L (text)\n" +
      "GET /report     — daily report\n" +
      "GET /risk       — risk check\n" +
      "GET /weekly     — weekly review\n" +
      "GET /premarket  — pre-market scan\n" +
      "GET /state      — raw state\n" +
      "GET /budget     — Claude spend\n" +
      "GET /reset      — factory reset"
        );
      }
    };

function jsonResponse(data) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
}

// =============================================================================
async function claudeBatchAnalysis({ headlines, candidatesToValidate, positionsToClose, regime, env, state }) {
  if (!env.ANTHROPIC_API_KEY) return fallbackResult(candidatesToValidate);
  if (headlines.length === 0 && candidatesToValidate.length === 0 && positionsToClose.length === 0) {
    return { newsBlocked: [], newsBoosted: [], newsSummary: "", validations: {}, journals: {} };
  }

  const sections = [];

  if (headlines.length > 0) {
    sections.push(`=== NEWS ===\nIdentify coins to BLOCK or BOOST:\n${headlines.slice(0, 10).map(h =>
      `- [${h.sentiment}] ${h.title} (${h.coins.join(",") || "general"})`).join("\n")}`);
  }

  if (candidatesToValidate.length > 0) {
    const regimePerf = getRegimePerformance(state, regime.label);

    const candidateLines = candidatesToValidate.map((c, i) => {
      const memory = getCoinMemory(state, c.symbol);
      const memText = formatCoinMemoryForClaude(memory, regime.label);
      const adxVal = c.adxResult?.adx?.toFixed(0) || "?";
      const galaxyText = c.lunarGalaxyScore ? ` Galaxy:${c.lunarGalaxyScore}` : "";
      const fundText = c.fundingRate != null ? ` Fund:${(c.fundingRate * 100).toFixed(3)}%` : "";

      return (
        `${i + 1}. ${c.symbol} ${c.signal.toUpperCase()} @$${c.price.toFixed(4)} ` +
        `Score:${c.score} RSI:${c.rsiVal.toFixed(0)} Fisher:${c.fisherVal.toFixed(2)} OBV:${c.obvDiv} ` +
        `ADX:${adxVal} 4h:${c.h4Trend} [${c.reasons.slice(0, 6).join(",")}]` +
        `${galaxyText}${fundText}\n${memText}`
      );
    }).join("\n");

    sections.push(
      `=== VALIDATE ===\n` +
      `Regime:${regime.label} HMM:${regime.hmmLabel} PI:${regime.piCycle}\n` +
      `StrategyStats: trades=${regimePerf.total} winRate=${regimePerf.winRate} avgPnl=${regimePerf.avgPnl}\n\n` +
      `IMPORTANT: Use coin history to identify repeating failure patterns. Reject trades matching historically losing setups.\n\n` +
      candidateLines
    );
  }
  
  

  if (positionsToClose.length > 0) {
    sections.push(`=== JOURNALS ===\n2-sentence journal each:\n${positionsToClose.slice(0, 5).map((p, i) => {
      const pnl = p.direction === "long" ? (p.exitPrice - p.entryPrice) * p.size : (p.entryPrice - p.exitPrice) * p.size;
      return `${i + 1}. ${p.symbol} ${p.direction.toUpperCase()} entry:$${p.entryPrice.toFixed(4)} exit:$${p.exitPrice.toFixed(4)} PnL:$${pnl.toFixed(2)} reason:${p.exitReason} [${(p.reasons || []).slice(0, 4).join(",")}]`;
    }).join("\n")}`);
  }

  const prompt = `Quant crypto analyst. Respond ALL sections in JSON. Concise.\n\n${sections.join("\n\n")}\n\nJSON only:\n{"news":{"blocked":[],"boosted":[],"summary":""},"validations":{"SYM_USDT":{"approved":true,"reason":"..."}},"journals":{"SYM_USDT":"..."}}`;

  try {
    const raw    = await callClaudeBudgeted(prompt, env, state, 1000);
    const parsed = JSON.parse(raw);
    return {
      newsBlocked: parsed.news?.blocked || [],
      newsBoosted: parsed.news?.boosted || [],
      newsSummary: parsed.news?.summary || "",
      validations: parsed.validations || {},
      journals:    parsed.journals || {}
    };
  } catch (err) {
    console.error("[CLAUDE BATCH]", err.message);
    return fallbackResult(candidatesToValidate);
  }
}

function fallbackResult(candidates) {
  const v = {};
  for (const c of (candidates || [])) v[c.symbol] = { approved: c.score >= 9, reason: "auto-fallback" };
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
  loadState,
  saveState,
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
  if (state.trades.length < 20) return;
  if (state.trades.length % 20 !== 0 && state.lastWeightUpdate === state.trades.length) return;
  state.lastWeightUpdate = state.trades.length;

  const recent = state.trades.slice(-200);
  if (recent.length < 20) return;

  const stats = {};
  for (const trade of recent) {
    for (const reason of (trade.reasons || [])) {
      if (!stats[reason]) stats[reason] = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
      stats[reason].count++;
      stats[reason].totalPnl += trade.pnl;
      if (trade.pnl > 0) stats[reason].wins++;
      else stats[reason].losses++;
    }
  }

  const newWeights = {};
  for (const [signal, base] of Object.entries(BASE_WEIGHTS)) {
    const s = stats[signal];
    if (!s || s.count < 10) { newWeights[signal] = base; continue; }
    const winRate = s.wins / s.count;
    const avgPnl  = s.totalPnl / s.count;
    let multiplier;
    if (winRate >= 0.70 && avgPnl > 0)     multiplier = 1.4;
    else if (winRate >= 0.55 && avgPnl > 0) multiplier = 1.2;
    else if (winRate >= 0.45)               multiplier = 1.0;
    else if (winRate >= 0.35)               multiplier = 0.7;
    else                                    multiplier = 0.4;
    const raw = base * multiplier;
    newWeights[signal] = Math.max(0.2, Math.min(4.0, parseFloat(raw.toFixed(2))));
    if (Math.abs(newWeights[signal] - base) > 0.3) {
      console.log(`[WEIGHTS] ${signal}: ${base} → ${newWeights[signal]} (WR:${(winRate*100).toFixed(0)}% n=${s.count} avgPnL:$${avgPnl.toFixed(2)})`);
    }
  }
  state.dynamicWeights = newWeights;

  const disabled = [];
  for (const [signal, s] of Object.entries(stats)) {
    if (s.count >= 25 && s.wins / s.count < 0.30 && s.totalPnl / s.count < 0) {
      disabled.push(signal);
      console.warn(`[WEIGHTS] DISABLED "${signal}": WR=${((s.wins/s.count)*100).toFixed(0)}% over ${s.count} trades`);
    }
  }
  state.disabledSignals = disabled;
  console.log(`[WEIGHTS] Updated ${Object.keys(newWeights).length} signal weights from ${recent.length} trades`);
}

function getWeight(signal, state) {
  if (state.dynamicWeights && state.dynamicWeights[signal] !== undefined) {
    return state.dynamicWeights[signal];
  }
  return SIGNAL_WEIGHTS[signal] || 1.0;
}

// =============================================================================
// UPGRADE 2 — PER-COIN TRADE MEMORY
// =============================================================================
function updateCoinHistory(state, symbol, trade) {
  if (!state.coinHistory) state.coinHistory = {};
  if (!state.coinHistory[symbol]) state.coinHistory[symbol] = [];
  state.coinHistory[symbol].push({
    direction:  trade.direction,
    pnl:        parseFloat(trade.pnl.toFixed(2)),
    pnlPct:     trade.pnlPct || 0,
    regime:     state.lastRegime?.label || "unknown",
    reasons:    (trade.reasons || []).slice(0, 6),
    date:       new Date().toISOString().split("T")[0],
    result:     trade.pnl > 0 ? "win" : "loss",
    exitReason: trade.reason
  });
  if (state.coinHistory[symbol].length > 10) {
    state.coinHistory[symbol] = state.coinHistory[symbol].slice(-10);
  }
}

function getCoinMemory(state, symbol) {
  const history = (state.coinHistory || {})[symbol];
  if (!history || history.length === 0) return null;
  const wins   = history.filter(h => h.result === "win").length;
  const total  = history.length;
  const avgPnl = history.reduce((s, h) => s + h.pnl, 0) / total;
  const regimeStats = {};
  for (const h of history) {
    if (!regimeStats[h.regime]) regimeStats[h.regime] = { wins: 0, total: 0 };
    regimeStats[h.regime].total++;
    if (h.result === "win") regimeStats[h.regime].wins++;
  }
  return {
    trades: history,
    summary: { total, wins, winRate: ((wins / total) * 100).toFixed(0), avgPnl: avgPnl.toFixed(2), regimeStats }
  };
}

function formatCoinMemoryForClaude(memory, currentRegime) {
  if (!memory) return "No prior trades on this coin.";
  const s = memory.summary;
  let text = `COIN HISTORY: ${s.total} trades, ${s.winRate}% WR, avg PnL $${s.avgPnl}\n`;
  const regimeStat = s.regimeStats[currentRegime];
  if (regimeStat) {
    const rwr = ((regimeStat.wins / regimeStat.total) * 100).toFixed(0);
    text += `In ${currentRegime} regime: ${regimeStat.total} trades, ${rwr}% WR\n`;
  }
  text += `Recent:\n`;
  for (const t of memory.trades.slice(-5)) {
    text += `  ${t.date} ${t.direction} ${t.result.toUpperCase()} $${t.pnl} (${t.regime}) exit:${t.exitReason} [${t.reasons.join(",")}]\n`;
  }
  return text;
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
      ? 3.5
      : ENTRY_THRESHOLD;
  } // Not enough data

  const winRate = rs.wins / rs.count;
  const avgPnl  = rs.totalPnl / rs.count;

  let adjustment = 0;

  if (winRate > 0.55 && avgPnl > 0) {
    adjustment = -1; // More aggressive
  } else if (winRate >= 0.45) {
    adjustment = 0;  // Neutral
  } else if (winRate >= 0.35) {
    adjustment = 1;  // More selective
  } else {
    adjustment = 2;  // Very selective
  }

  let adaptive = Math.max(3, Math.min(7, ENTRY_THRESHOLD + adjustment));

  if (currentRegime === "chop" || currentRegime === "sideways") {
    adaptive = Math.min(adaptive, 3.5);
  }

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
async function loadState(env) {
  try {
    return await loadStateFromDb();
  } catch (err) {
    console.error("[DB] CRITICAL: Failed to load state:", err.message);
    throw new Error("State load failed - aborting: " + err.message);
  }
}

async function saveState(env, state) {
  try {
    if (state.trades.length > 500) state.trades = state.trades.slice(-500);
    if (state.weeklyReviews && state.weeklyReviews.length > 12) state.weeklyReviews = state.weeklyReviews.slice(-12);
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
    await saveStateToDb(state);
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
    loadState,
    notifyTrade,
    printPortfolioSummary,
    saveState,
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
