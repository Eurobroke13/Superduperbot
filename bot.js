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

const API_BASE           = "https://www.okx.com";
const ANTHROPIC_API      = "https://api.anthropic.com/v1/messages";
const LUNARCRUSH_API     = "https://lunarcrush.com/api4/public/coins";
const CLAUDE_MODEL       = "claude-sonnet-4-20250514";

const PAPER_CASH         = 10000;
const RISK_PCT           = 0.03;
const MAX_LEVERAGE       = 6;
const MAX_POSITION_SHARE = 1 / 10;
const ATR_SL_MULT        = 2.0;
const ATR_TP_MULT        = 4.0;
const MAX_POSITIONS      = 10;
const ENTRY_THRESHOLD    = 4;
const CLAUDE_THRESHOLD   = 8;
const CANDLE_LIMIT       = 500;
const DRAWDOWN_LIMIT     = 0.15;

const MONTHLY_BUDGET_USD   = 40.00;
const INPUT_COST_PER_MTOK  = 3.00;
const OUTPUT_COST_PER_MTOK = 15.00;

const SIGNAL_WEIGHTS = {
  "TK-bull": 1.0, "TK-bear": 1.0,
  "above-cloud": 1.5, "below-cloud": 1.5,
  "chikou-bull": 0.8, "chikou-bear": 0.8,
  "OBV-bull-div": 2.5, "OBV-bear-div": 2.5,
  "fisher-rising": 0.8, "fisher-falling": 0.8,
  "rsi-bull-div": 2.0, "rsi-bear-div": 2.0,
  "ema-ribbon-bull": 1.5, "ema-ribbon-bear": 1.5,
  "fisher-oversold": 1.2, "fisher-overbought": 1.2,
  "above-VWAP": 1.0, "below-VWAP": 1.0,
  "gauss-up": 0.7, "gauss-down": 0.7,
  "rsi-oversold": 1.3, "rsi-overbought": 1.3,
  "near-support": 1.5, "near-resistance": 1.5,
  "in-HVN": -1.5,
  "macd-cross-up": 1.2, "macd-cross-down": 1.2,
  "adx-strong-bull": 1.0, "adx-strong-bear": 1.0,
  "bb-oversold": 1.0, "bb-overbought": 1.0,
  "stochrsi-oversold": 1.0, "stochrsi-overbought": 1.0,
  "stochrsi-cross-up": 0.8, "stochrsi-cross-down": 0.8,
  "volume-confirm": 1.5, "volume-climax": -0.5,
  "funding-crowded-long": 1.0, "funding-crowded-short": 1.0,
  "funding-extreme-long": 1.5, "funding-extreme-short": 1.5,
  "h4-bull": 2.0, "h4-bear": 2.0,
  "news-boost": 0.8,
  "lunar-bull": 0.7, "lunar-bear": 0.7,
  "lunar-sentiment-warning": -1.0,
};
const BASE_WEIGHTS = { ...SIGNAL_WEIGHTS };

const FUNDING_SETTLEMENT_HOURS = [0, 8, 16];
const SETTLEMENT_AVOID_MINUTES = 10;

const HOUR_PERFORMANCE = {
  0: -0.3, 1: 0.0, 2: 0.0, 3: 0.0, 4: 0.1, 5: 0.2, 6: 0.2, 7: 0.0,
  8: -0.3, 9: 0.1, 10: 0.2, 11: 0.2, 12: 0.1, 13: 0.2, 14: 0.3,
  15: 0.2, 16: -0.3, 17: 0.1, 18: 0.1, 19: 0.1, 20: 0.0,
  21: -0.1, 22: -0.1, 23: 0.0,
};

function getTimeFilter() {
  const now     = new Date();
  const utcHour = now.getUTCHours();
  const utcMin  = now.getUTCMinutes();

  let nearSettlement = false;
  for (const settleHour of FUNDING_SETTLEMENT_HOURS) {
    const minutesToSettle = ((settleHour - utcHour + 24) % 24) * 60 - utcMin;
    const minutesAfter    = ((utcHour - settleHour + 24) % 24) * 60 + utcMin;
    if (minutesToSettle >= 0 && minutesToSettle <= SETTLEMENT_AVOID_MINUTES) { nearSettlement = true; break; }
    if (minutesAfter   >= 0 && minutesAfter   <= SETTLEMENT_AVOID_MINUTES) { nearSettlement = true; break; }
  }

  const utcDay    = now.getUTCDay();
  const isWeekend = utcDay === 0 || utcDay === 6;
  const hourModifier = HOUR_PERFORMANCE[utcHour] || 0;

  return {
    utcHour, utcMin, nearSettlement, isWeekend, hourModifier,
    shouldAvoidEntry: nearSettlement,
    scoreAdjustment: nearSettlement ? -1.0 : hourModifier + (isWeekend ? -0.15 : 0)
  };
}

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
        await runBot(env);
      }
    } catch (err) {
      console.error("[BOT] Fatal:", err.message || err);
    }
  },

  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/run") {
      await runBot(env);
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
// MAIN BOT — PHASE-BASED EXECUTION
// Each cron trigger (every 20 min) runs one phase.
// Full cycle: Phase 0 → 1 → 2 → 0 (one complete hour)
// This keeps each execution well under Cloudflare CPU limits.
// =============================================================================
async function runBot(env) {
  console.log("=== BOT RUN ===", new Date().toISOString());
  let state;
  try {
    state = await loadState(env);
  } catch (err) {
    console.error("[BOT] Cannot load state, aborting run:", err.message);
    return;  // Don't run with broken state
  }

  state.runCount = (state.runCount || 0) + 1;
  state.lastRunAt = new Date().toISOString();

  await checkAllExits(env, state);

  const phase = state.lastPhase || 0;
  console.log(`[PHASE ${phase}]`);

  try {
    switch (phase) {
      case 0:
        await phaseRegimeAndExits(env, state);
        state.lastPhase = 1;
        break;
      case 1:
        await phaseScan(env, state, 0, 0.5);
        state.lastPhase = 2;
        break;
      case 2:
        await phaseScan(env, state, 0.5, 1.0);
        state.lastPhase = 0;
        break;
      default:
        state.lastPhase = 0;
    }
  } catch (err) {
    console.error(`[PHASE ${phase}] Error:`, err.message || err);
    // Cycle to next phase regardless so bot doesn't get stuck
    state.lastPhase = (phase + 1) % 3;
  }

  await saveState(env, state);
  printPortfolioSummary(state);
}

async function checkAllExits(env, state) {
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
      if (!candles || candles.length < 50) continue;
      const closes = candles.map(c => c.close);
      const highs  = candles.map(c => c.high);
      const lows   = candles.map(c => c.low);
      const last   = candles[candles.length - 1];
      const price  = livePrices[symbol] || last.close;
      const high   = last.high;
      const low    = last.low;
      const atrVal = atr(highs, lows, closes, 14);
      const pos    = state.positions[symbol];

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
      await checkDCA(pos, price, atrVal, state, env);

      const exit = checkGraduatedExit(pos, price, high, low, atrVal, state);
      if (exit.exit) {
        positionsToClose.push({ ...pos, exitPrice: price, exitReason: exit.reason });
      } else if (exit.partial && exit.partialCloses) {
        for (const pc of exit.partialCloses) {
          executePartialClose(symbol, price, pc.pct, pc.reason, pos, state);
          await notifyTrade("PARTIAL", {
            symbol, direction: pos.direction, exitPrice: price,
            reason: pc.reason, pct: pc.pct,
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
      env, state
    });

    for (const p of positionsToClose) {
      if (state.positions[p.symbol]) {
        const journal = claudeResult.journals[p.symbol] || null;
        closePosition(p.symbol, p.exitPrice, p.exitReason, state.positions[p.symbol], state, journal);
        await notifyTrade("CLOSE", p, state, env);
      }
    }
  } catch (err) {
    console.error("[BATCH CLOSE]", err.message);
    for (const p of positionsToClose) {
      if (state.positions[p.symbol]) {
        closePosition(p.symbol, p.exitPrice, p.exitReason, state.positions[p.symbol], state, null);
      }
    }
  }
}

// =============================================================================
// PHASE 0: REGIME + EXITS + NEWS
// =============================================================================
async function phaseRegimeAndExits(env, state) {
  // 1. BTC regime
  const btcDaily = await fetchCandles("BTC-USDT-SWAP", "1d", 500);
  if (!btcDaily || btcDaily.length < 200) {
    console.warn("[REGIME] Insufficient BTC data.");
    return;
  }

  const prevLabel = state.lastRegime?.label;
  const regime    = detectRegime(btcDaily, state);
  state.lastRegime = regime;
  console.log(`[REGIME] ${regime.label} | HMM:${regime.hmmLabel} | PI:${regime.piCycle} | Markov:${regime.markovProb.toFixed(3)}`);
  // Migrate legacy positions missing tpLevels or dcaApplied
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
  // Regime change alert
  if (prevLabel && prevLabel !== regime.label) {
    await sendRegimeChangeAlert(env, state, prevLabel, regime);
  }

  // 2. News (rule-based + cached)
  const newsResult   = await fetchCryptoPanicNews(state);
  state.newsBlocked  = newsResult.blockedCoins;
  state.newsBoosted  = newsResult.boostedCoins;
  state.newsHeadlines = newsResult.headlines;
  state.newsNeedsClaude = newsResult.needsClaude;

  // 3. Single Claude batch: news analysis
  if (newsResult.needsClaude) {
    try {
      const claudeResult = await claudeBatchAnalysis({
        headlines:            newsResult.headlines,
        candidatesToValidate: [],
        positionsToClose: [],
        regime,
        env, state
      });

      // Update cached news
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

// =============================================================================
// PHASE 1 & 2: SCAN + ENTER
// =============================================================================
async function phaseScan(env, state, startFrac, endFrac) {
  const regime = state.lastRegime;
  if (!regime) { console.warn("[SCAN] No regime, skip."); return; }

  // Time filter
  const timeFilter = getTimeFilter();
  if (timeFilter.shouldAvoidEntry) {
    console.log(`[SCAN] Avoiding entries — near funding settlement (${timeFilter.utcHour}:${String(timeFilter.utcMin).padStart(2, "0")} UTC)`);
    return;
  }

  const entryThreshold  = getAdaptiveThreshold(state, regime.label);
  const claudeThreshold = getAdaptiveClaudeThreshold(state, regime.label);

  console.log(`[SCAN] Regime:${regime.label} Entry:${entryThreshold} Claude:${claudeThreshold} TimeAdj:${timeFilter.scoreAdjustment.toFixed(1)}`);	
  const slotsAvailable = MAX_POSITIONS - Object.keys(state.positions).length;
  if (slotsAvailable <= 0) { console.log("[SCAN] All slots full."); return; }

  // Fetch contracts
  const allContracts = await fetchAllContracts();
  if (!allContracts || allContracts.length === 0) return;

  const tickers = await fetchAllTickers();
  const volumeMap = {};
  const livePrices = {};
  if (tickers) for (const t of tickers) {
    volumeMap[t.contract] = parseFloat(t.volume_24h_quote || t.volume_24h_usd || t.volume_24h || 0);
    if (t.last) livePrices[t.contract] = t.last;
  }
  const blocked = state.newsBlocked || [];
  const boosted = state.newsBoosted || [];

  const tradeable = allContracts
    .filter(c => (volumeMap[c] || 0) > 450_000)
    .filter(c => !state.positions[c])
    .filter(c => !blocked.includes(c.replace("-USDT-SWAP", "")));

  const tickerMap = {};
  if (tickers) {
    for (const t of tickers) {
      tickerMap[t.contract] = t;
    }
  }

  // Rank symbols by cheap features only:
  // 1) strong liquidity
  // 2) meaningful movement
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

      // volume dominates, move is a smaller bonus
      const rankScore =
        (vol / 1_000_000) +
        (movePct * 100 * 0.3);

      return {
        symbol,
        vol,
        movePct,
        rankScore
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .map(x => x.symbol);

  // Keep your phase split, but hard-cap symbols per run
  const startIdx = Math.floor(rankedTradeable.length * startFrac);
  const endIdx   = Math.floor(rankedTradeable.length * endFrac);

  const MAX_SYMBOLS_PER_RUN = 20;

  const batch = rankedTradeable.slice(
    startIdx,
    Math.min(endIdx, startIdx + MAX_SYMBOLS_PER_RUN)
  );

  console.log(
    `[SCAN] Scoring ${batch.length} contracts ` +
    `(${startIdx}-${Math.min(endIdx, startIdx + MAX_SYMBOLS_PER_RUN)} of ${rankedTradeable.length})`
  );

  // Score in small batches to stay within CPU limits
  const candidates = [];
  const chunkSize  = 10;
  for (let i = 0; i < batch.length; i += chunkSize) {
    const chunk   = batch.slice(i, i + chunkSize);
    const results = await Promise.allSettled(chunk.map(s => scoreSymbol(s, regime, state)));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) candidates.push(r.value);
    }
    if (i + chunkSize < batch.length) await sleep(100);
  }

  // Apply news boost
  for (const c of candidates) {
    const base = c.symbol.replace("-USDT-SWAP", "");
    if (boosted.includes(base)) {
      c.score += getWeight("news-boost", state);
      c.reasons.push("news-boost");
    }
  }
  // Apply time adjustment
  if (timeFilter.scoreAdjustment !== 0) {
    for (const c of candidates) {
      c.score += timeFilter.scoreAdjustment;
      c.reasons.push(`time(${timeFilter.scoreAdjustment > 0 ? "+" : ""}${timeFilter.scoreAdjustment.toFixed(1)})`);
    }
  }

  // LunarCrush for qualified candidates (max 30 to stay in free tier)
  const lunarSymbols = [...new Set([
    ...candidates.filter(c => c.score >= ENTRY_THRESHOLD).slice(0, 25).map(c => c.symbol.replace("-USDT-SWAP", "")),
    ...Object.keys(state.positions).map(s => s.replace("-USDT-SWAP", ""))
  ])].slice(0, 15);

  const lunarData = await fetchLunarCrush(lunarSymbols, env, state);

  for (const c of candidates) {
    const base  = c.symbol.replace("-USDT-SWAP", "");
    const lunar = lunarData[base];
    if (!lunar) continue;
    c.lunarSentiment   = lunar.sentiment;
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

  // Sort and pick best
  const scores = candidates.map(c => c.score).sort((a, b) => b - a);
  const cutoff = scores[Math.floor(scores.length * 0.2)] ?? -Infinity;

  const topSignals = candidates.filter(c => c.score >= cutoff);

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

  const qualified = topSignals.filter(c => c.score >= entryThreshold);
  const longs     = qualified.filter(c => c.signal === "long").sort((a, b) => b.score - a.score);
  const shorts    = qualified.filter(c => c.signal === "short").sort((a, b) => b.score - a.score);

  const toConsider = [];
  let li = 0, si = 0;
  while (toConsider.length < slotsAvailable && (li < longs.length || si < shorts.length)) {
    if (li < longs.length)  toConsider.push(longs[li++]);
    if (toConsider.length < slotsAvailable && si < shorts.length) toConsider.push(shorts[si++]);
  }

  // Split by threshold
  const autoList   = [];
  const claudeList = [];

  for (const c of toConsider) {
    const exposure = checkCorrelationExposure(c, state);
    if (!exposure.allowed) { console.log(`[${c.symbol}] Blocked: ${exposure.reason}`); continue; }

    if (c.score >= claudeThreshold) claudeList.push(c);
    else autoList.push(c);
  }

  // Auto-approve lower scores
  for (const c of autoList) {
    if (autoApproveSignal(c, regime)) {
      const opened = openPositionGradual({ ...c, approvalType: "auto" }, state, livePrices, env);
      if (opened) await notifyTrade("OPEN", c, state, env);
    }
  }

  // Claude batch for high scores
  if (claudeList.length > 0) {
    try {
      const claudeResult = await claudeBatchAnalysis({
        headlines: [], candidatesToValidate: claudeList.slice(0, 5),
        positionsToClose: [], regime, env, state
      });

      for (const c of claudeList) {
        const v = claudeResult.validations[c.symbol];
        if (v?.approved === true) {
          const opened = openPositionGradual({ ...c, approvalType: "claude" }, state, livePrices, env);
          if (opened) {
            await notifyTrade("OPEN", c, state, env);
            console.log(`[${c.symbol}] Claude approved: ${v.reason}`);
          }
        } else {
          if (v?.reason === "auto-fallback") {
            console.log(`[${c.symbol}] Claude unavailable, fallback decision: ${v.reason}`);
          } else {
            console.log(`[${c.symbol}] Claude rejected: ${v?.reason || "no response"}`);
          }
        }
      }
    } catch (err) {
      console.error("[CLAUDE VALIDATE]", err.message);
      for (const c of claudeList) {
        if (c.score >= 9 && autoApproveSignal(c, regime)) {
          const opened = openPositionGradual({ ...c, approvalType: "claude" }, state, livePrices, env);
          if (opened) {
            await notifyTrade("OPEN", c, state, env);
            console.log(`[${c.symbol}] Claude unavailable, fallback decision: auto-fallback`);
          }
        } else {
          console.log(`[${c.symbol}] Not opened: Claude unavailable and fallback did not approve`);
        }
      }
    }
  }
  // Diagnostic logging
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
  console.log(`[SCAN] Qualified:${qualified.length} Auto:${autoList.length} Claude:${claudeList.length}`);
}

// =============================================================================
// NEWS — RULE-BASED + CACHED (no API key needed)
// =============================================================================
async function fetchCryptoPanicNews(state) {
  const result = { blockedCoins: [], boostedCoins: [], headlines: [], needsClaude: false };

  try {
    const url = "https://cryptopanic.com/api/v1/posts/?auth_token=anonymous&public=true&kind=news&filter=hot";
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      result.blockedCoins = state.newsBlocked || [];
      result.boostedCoins = state.newsBoosted || [];
      return result;
    }
    const data = await res.json();
    if (!data.results) return result;

    const headlines = data.results.slice(0, 15).map(post => ({
      title:     post.title || "",
      coins:     (post.currencies || []).map(c => c.code?.toUpperCase()).filter(Boolean),
      sentiment: post.votes?.negative > post.votes?.positive ? "negative"
               : post.votes?.positive > post.votes?.negative ? "positive" : "neutral",
      id:        post.id
    }));
    result.headlines = headlines;

    // Cache check
    const ids = headlines.map(h => h.id).sort().join(",");
    if (ids === state.lastHeadlineIds) {
      result.blockedCoins = state.newsBlocked || [];
      result.boostedCoins = state.newsBoosted || [];
      result.needsClaude  = false;
      return result;
    }
    state.lastHeadlineIds = ids;

    // Rule-based classification
    const neg = ["hack","exploit","breach","lawsuit","ban","delist","bankrupt","freeze","suspend","scam","rug","sec","charged","fraud","investigation","stolen"];
    const pos = ["etf","approval","partnership","listing","upgrade","launch","integration","institutional","adoption","bullish","milestone","record","rally"];

    for (const h of headlines) {
      const lower = h.title.toLowerCase();
      for (const coin of h.coins) {
        if (neg.some(k => lower.includes(k))) result.blockedCoins.push(coin);
        if (pos.some(k => lower.includes(k))) result.boostedCoins.push(coin);
      }
    }
    result.blockedCoins = [...new Set(result.blockedCoins)];
    result.boostedCoins = [...new Set(result.boostedCoins)];

    const notable = headlines.filter(h => h.sentiment !== "neutral" || h.coins.length > 0).length;
    result.needsClaude = notable >= 3;
  } catch (err) {
    console.error("[NEWS]", err.message);
    result.blockedCoins = state.newsBlocked || [];
    result.boostedCoins = state.newsBoosted || [];
  }

  return result;
}

// =============================================================================
// LUNARCRUSH
// =============================================================================
async function fetchLunarCrush(symbols, env, state) {
  const result = {};
  if (!env.LUNARCRUSH_API_KEY || symbols.length === 0) return result;
  const now = Date.now();
  const ttlMs = 30 * 60 * 1000;

  if (
    state.lunarCache &&
    state.lunarCache.ts &&
    now - state.lunarCache.ts < ttlMs &&
    state.lunarCache.data
  ) {
    for (const symbol of symbols) {
      if (state.lunarCache.data[symbol]) {
        result[symbol] = state.lunarCache.data[symbol];
      }
    }
    if (Object.keys(result).length > 0) return result;
  }

  try {
    const url = `${LUNARCRUSH_API}/list/v1?symbols=${symbols.join(",")}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.LUNARCRUSH_API_KEY}`, Accept: "application/json" }
    });
    if (!res.ok) return result;
    const data = await res.json();
    if (!data.data) return result;

    const fetched = {};
    for (const coin of data.data) {
      const sym = coin.symbol?.toUpperCase();
      if (!sym) continue;
      const lunarPoint = {
        galaxyScore:  coin.galaxy_score      ?? 50,
        sentiment:    coin.sentiment         ?? 50,
        socialVolume: coin.social_volume_24h ?? 0,
        altRank:      coin.alt_rank          ?? 999
      };
      fetched[sym] = lunarPoint;
      if (symbols.includes(sym)) result[sym] = lunarPoint;
    }
    state.lunarCache = {
      ts: now,
      data: {
        ...(state.lunarCache?.data || {}),
        ...fetched
      }
    };
  } catch (err) {
    console.error("[LUNAR]", err.message);
    if (
      state.lunarCache &&
      state.lunarCache.data &&
      state.lunarCache.ts &&
      now - state.lunarCache.ts < ttlMs
    ) {
      for (const symbol of symbols) {
        if (state.lunarCache.data[symbol]) {
          result[symbol] = state.lunarCache.data[symbol];
        }
      }
    }
  }
  return result;
}

// =============================================================================
// SIGNAL SCORING — MULTI-TIMEFRAME + WEIGHTED
// =============================================================================
async function scoreSymbol(symbol, regime, state) {
  try {
    const disabled = state.disabledSignals || [];

  const [candles1h, candles4h] = await Promise.all([
    fetchCandles(symbol, "1h", CANDLE_LIMIT),
    fetchCandles(symbol, "4h", 200)
  ]);

  if (!candles1h || candles1h.length < 100) return null;

  // ===== DATA =====
  const closes  = candles1h.map(c => c.close);
  const highs   = candles1h.map(c => c.high);
  const lows    = candles1h.map(c => c.low);
  const volumes = candles1h.map(c => c.volume);
  const n       = closes.length;
  const price   = closes[n - 1];

  // ===== INDICATORS =====
  const atrVal     = atr(highs, lows, closes, 14);
  const ichi       = ichimoku(highs, lows, closes);
  const obvSeries  = obv(closes, volumes);
  const obvDiv     = detectOBVDivergence(closes, obvSeries, 20);
  const fisherArr  = fisher(highs, lows, 10);
  const fisherVal  = fisherArr[n - 1];
  const fisherPrev = fisherArr[n - 2];
  const vwapVal    = vwap(highs, lows, closes, volumes, 24);
  const vpvr       = volumeProfile(closes, volumes, 20);
  const srLevels   = findSupportResistance(highs, lows, 50) || { supports: [], resistances: [] };
  const supports   = Array.isArray(srLevels.supports) ? srLevels.supports : [];
  const resistances = Array.isArray(srLevels.resistances) ? srLevels.resistances : [];
  const trap       = detectLiquidityTrap(price, closes, { supports, resistances });
  const rsiArr     = rsiSeries(closes, 14);
  const rsiVal     = rsiArr[n - 1];
  const rsiDiv     = detectRSIDivergence(closes, rsiArr, 20);

  const macdRaw    = macd(closes) || {};
  const macdResult = {
    crossUp: !!macdRaw.crossUp,
    crossDown: !!macdRaw.crossDown
  };
  const adxResultRaw  = adx(highs, lows, closes, 14) || {};
  const adxResult = {
    strongTrend: !!adxResultRaw.strongTrend,
    trending: !!adxResultRaw.trending,
    adx: adxResultRaw.adx ?? 0,
    pdi: adxResultRaw.pdi ?? 0,
    mdi: adxResultRaw.mdi ?? 0
  };
  const bb         = bollingerBands(closes, 20, 2);
  const pctB       = bb.pctB[n - 1];
  const bbWidth    = bb?.width?.[n - 1] ?? 0;

  const ribbon     = emaRibbon(closes);
  const volConfirmRaw = volumeConfirmation(volumes) || {};
  const volConfirm = {
    isSignificant: !!volConfirmRaw.isSignificant,
    isClimax: !!volConfirmRaw.isClimax,
    ratio: volConfirmRaw.ratio ?? 1
  };

  // ===== CONTEXT =====
  const isStrongTrend = !!adxResult.strongTrend;
  const isTrending = !!adxResult.trending || isStrongTrend;
  const atrPct     = atrVal / price;

  // ===== 4H TREND =====
  let h4Trend = "neutral";
  if (candles4h && candles4h.length >= 50) {
    const c4   = candles4h.map(c => c.close);
    const e20  = ema(c4, 20);
    const e50  = ema(c4, 50);
    const last = c4.length - 1;

    if (e20[last] > e50[last] && c4[last] > e20[last]) h4Trend = "bullish";
    else if (e20[last] < e50[last] && c4[last] < e20[last]) h4Trend = "bearish";
  }

  // ===== SCORING =====
  let longScore = 0;
  let shortScore = 0;
  const reasons = [];

  const TIERS = {
    weak: 0.5,
    medium: 1,
    strong: 2
  };

  const add = (cond, name, isLong, weight = TIERS.medium) => {
    if (!cond || disabled.includes(name)) return;
    if (isLong) longScore += weight;
    else shortScore += weight;
    reasons.push(name);
  };

  // ===== SIGNAL GATING =====

  // ===== STRONG TREND =====
  if (isStrongTrend) {
    add(ribbon.bullishAligned && ribbon.expanding && ribbon.priceAboveAll, "ema-ribbon-bull", true, TIERS.strong);
    add(ribbon.bearishAligned && ribbon.expanding && ribbon.priceBelowAll, "ema-ribbon-bear", false, TIERS.strong);

    add(h4Trend === "bullish", "h4-bull", true, TIERS.strong);
    add(h4Trend === "bearish", "h4-bear", false, TIERS.strong);
  }

  // ===== RANGE / CHOP =====
  else if (!isTrending) {

    const isGoodRange =
      (adxResult?.adx ?? 0) < 20 &&
      bbWidth > 0.02;

    const nearSupport = supports.some(s => Math.abs(price - s) / price < 0.005);
    const nearResistance = resistances.some(r => Math.abs(price - r) / price < 0.005);

    if (isGoodRange) {

      // 🔥 PRIORITY: structured setups (stronger)
      add(rsiVal < 35 && nearSupport, "rsi-support-bounce", true, TIERS.medium);
      add(rsiVal > 65 && nearResistance, "rsi-resistance-reject", false, TIERS.medium);

      // fallback (weaker, only if no structure)
      if (!nearSupport && !nearResistance) {
        add(rsiVal < 35, "rsi-oversold", true, TIERS.weak);
        add(rsiVal > 65, "rsi-overbought", false, TIERS.weak);

        add(pctB < 0.05, "bb-oversold", true, TIERS.weak);
        add(pctB > 0.95, "bb-overbought", false, TIERS.weak);
      }

    } else {
      // dead range → avoid
      longScore *= 0.7;
      shortScore *= 0.7;
      reasons.push("dead-range");
    }
  }

  // ===== TRANSITION ZONE =====
  else {
    add(ribbon.bullishAligned, "ema-ribbon-bull", true, TIERS.weak);
    add(ribbon.bearishAligned, "ema-ribbon-bear", false, TIERS.weak);

    longScore *= 0.85;
    shortScore *= 0.85;

    reasons.push("transition-market");
  }

  // ===== UNIVERSAL SIGNALS =====

  // Divergences (strong)
  add(rsiDiv.type === "bullish", "rsi-bull-div", true, TIERS.strong);
  add(rsiDiv.type === "bearish", "rsi-bear-div", false, TIERS.strong);

  add(obvDiv.type === "bullish", "OBV-bull-div", true, TIERS.strong);
  add(obvDiv.type === "bearish", "OBV-bear-div", false, TIERS.strong);

  // ===== LIQUIDITY TRAPS =====
  add(trap === "bear-trap", "liquidity-bull", true, TIERS.strong);
  add(trap === "bull-trap", "liquidity-bear", false, TIERS.strong);

  // confirmation
  add(trap === "bear-trap" && rsiVal < 40, "trap-bull-confirm", true, TIERS.strong);
  add(trap === "bull-trap" && rsiVal > 60, "trap-bear-confirm", false, TIERS.strong);

  // volume confirmation
  add(trap === "bear-trap" && volConfirm.isClimax, "trap-vol-bull", true, TIERS.strong);
  add(trap === "bull-trap" && volConfirm.isClimax, "trap-vol-bear", false, TIERS.strong);
  
  // MACD
  add(macdResult.crossUp, "macd-cross-up", true, TIERS.medium);
  add(macdResult.crossDown, "macd-cross-down", false, TIERS.medium);

  // VWAP
  add(price > vwapVal, "above-VWAP", true, TIERS.medium);
  add(price < vwapVal, "below-VWAP", false, TIERS.medium);

  // EMA Ribbon Expansion (BREAKOUT EDGE)
  add(
    ribbon.wasCompressed && ribbon.expanding && ribbon.bullishAligned,
    "ribbon-expansion-bull",
    true,
    TIERS.strong
  );

  add(
    ribbon.wasCompressed && ribbon.expanding && ribbon.bearishAligned,
    "ribbon-expansion-bear",
    false,
    TIERS.strong
  );
  
  // ===== SYNERGY BOOST =====
  if (ribbon.bullishAligned && h4Trend === "bullish") longScore += 3;
  if (ribbon.bearishAligned && h4Trend === "bearish") shortScore += 3;

  // ===== VOLUME =====
  if (volConfirm.isSignificant) {
    longScore += 1;
    shortScore += 1;
    reasons.push("volume");
  }

  // ===== VOLATILITY FILTER =====
  if (atrPct < 0.003) {
    longScore *= 0.7;
    shortScore *= 0.7;
    reasons.push("low-volatility");
  }

  // ===== VPVR PENALTY =====
  const highVolumeNodes = Array.isArray(vpvr?.highVolumeNodes) ? vpvr.highVolumeNodes : [];

  if (highVolumeNodes.some(node => price >= node.low && price <= node.high)) {
    longScore *= 0.7;
    shortScore *= 0.7;
    reasons.push("in-HVN");
  }
  
  // ===== CONFLICTS =====
  if (ribbon.bullishAligned && rsiVal > 70) {
    longScore *= 0.7;
    reasons.push("trend-vs-overbought");
  }

  if (ribbon.bearishAligned && rsiVal < 30) {
    shortScore *= 0.7;
    reasons.push("trend-vs-oversold");
  }

  if (h4Trend === "bullish" && price < vwapVal) {
    longScore *= 0.7;
    reasons.push("htf-vs-vwap");
  }

  if (h4Trend === "bearish" && price > vwapVal) {
    shortScore *= 0.7;
    reasons.push("htf-vs-vwap");
  }
  // ===== NO TRADE ZONE =====
  const scoreDiff = Math.abs(longScore - shortScore);
  const minDiff = regime.label === "chop" ? 1.5 : 1.0;

  if (scoreDiff < minDiff) {
    return null;
  }

  // ===== DYNAMIC THRESHOLD =====
  const MIN_SCORE = regime.label === "chop" ? 4 : 3;

  let signal = null;
  let score = 0;

  // ===== SIGNAL SELECTION =====
  if (longScore >= MIN_SCORE && longScore > shortScore) {
    signal = "long";
    score = longScore;
  }
  else if (shortScore >= MIN_SCORE) {
    signal = "short";
    score = shortScore;
  }

  if (!signal) return null;

  // ===== SETUP CLASSIFICATION =====
  let setupType = "unknown";

  if (trap !== "none") {
    setupType = "liquidity-trap";
  }
  else if (ribbon.wasCompressed && ribbon.expanding) {
    setupType = "breakout";
  }
  else if (!isTrending) {
    setupType = "mean-reversion";
  }
  else if (isStrongTrend) {
    setupType = "trend";
  }

  // ===== QUALITY FILTER =====
  const quality =
    (ribbon.bullishAligned || ribbon.bearishAligned ? 1 : 0) +
    (h4Trend !== "neutral" ? 1 : 0) +
    (Math.abs(price - vwapVal) / price > 0.002 ? 1 : 0);

  if (quality < 2) return null;

  // ===== SL/TP =====
  const structured = calculateStructuredSLTP(
    signal, price, atrVal, highs, lows, closes, volumes
  );

  return {
    symbol,
    signal,
    score: Math.round(score * 10) / 10,
    setupType,
    price,
    atrVal,
    rsiVal,
    fisherVal,
    obvDiv: obvDiv.type,
    vwapVal,
    adxResult,
    fundingRate: null,
    sl: structured.sl,
    tp: structured.tp,
    riskReward: structured.riskReward,
    reasons,
    h4Trend,
    atrPct
  };
  } catch (err) {
    console.error(`[scoreSymbol:${symbol}]`, err.message || err);
    return null;
  }
}
function detectLiquidityTrap(price, closes, srLevels) {
  const recent = closes.slice(-5);

  const brokeAbove = srLevels.resistances.some(r =>
    recent.some(c => c > r)
  );

  const backBelow = srLevels.resistances.some(r =>
    price < r
  );

  const brokeBelow = srLevels.supports.some(s =>
    recent.some(c => c < s)
  );

  const backAbove = srLevels.supports.some(s =>
    price > s
  );

  if (brokeAbove && backBelow) return "bull-trap";
  if (brokeBelow && backAbove) return "bear-trap";

  return "none";
}
// =============================================================================
// AUTO-APPROVAL (score 5-6)
// =============================================================================

function autoApproveSignal(candidate, regime) {
  const {
    signal,
    obvDiv,
    fisherVal,
    price,
    vwapVal,
    adxResult,
    h4Trend,
    setupType,
    reasons = []
  } = candidate;

  const hasReason = name => reasons.includes(name);
  let conf = 0;

  if (setupType === "liquidity-trap") {
    conf += 2;
  } else if (setupType === "breakout") {
    if (
      (signal === "long" && hasReason("ribbon-expansion-bull")) ||
      (signal === "short" && hasReason("ribbon-expansion-bear"))
    ) {
      conf += 2;
    }
  } else if (setupType === "trend") {
    conf += 1;
  } else if (setupType === "mean-reversion") {
    conf += 1;
  }

  if (hasReason("transition-market")) {
    conf -= 1;
  }

  if (signal === "long") {
    if (obvDiv === "bullish" || obvDiv === "none") conf++;
    if (fisherVal > -1.0) conf++;
    if (price > vwapVal) conf++;
    if (adxResult?.trending && adxResult.pdi > adxResult.mdi) conf++;
    if (h4Trend === "bullish") conf++;
  } else {
    if (obvDiv === "bearish" || obvDiv === "none") conf++;
    if (fisherVal < 1.0) conf++;
    if (price < vwapVal) conf++;
    if (adxResult?.trending && adxResult.pdi < adxResult.mdi) conf++;
    if (h4Trend === "bearish") conf++;
  }

  return conf >= 3;
}

// =============================================================================
// CORRELATION / EXPOSURE CHECK
// =============================================================================
function checkCorrelationExposure(candidate, state) {
  const positions = Object.values(state.positions);
  if (positions.length === 0) return { allowed: true };

  const longCount  = positions.filter(p => p.direction === "long").length;
  const shortCount = positions.filter(p => p.direction === "short").length;

  if (candidate.signal === "long"  && longCount >= 7)  return { allowed: false, reason: "max 7 longs" };
  if (candidate.signal === "short" && shortCount >= 7) return { allowed: false, reason: "max 7 shorts" };

  const dirExposure = positions
    .filter(p => p.direction === candidate.signal)
    .reduce((sum, p) => sum + (p.effectiveExposure || 0), 0);
  const pVal = portfolioValue(state);
  if (pVal > 0 && dirExposure / pVal > 0.6) {
    return { allowed: false, reason: `dir exposure ${((dirExposure / pVal) * 100).toFixed(0)}%>60%` };
  }

  return { allowed: true };
}

// =============================================================================
// CLAUDE — BATCHED (1 call per phase max)
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
import { loadState as loadStateFromDb, saveState as saveStateToDb } from "./state-store.js";

// =============================================================================
async function sendDailyReport(env, options = {}) {
  const { force = false } = options;
  const state = await loadState(env);
  const reportEveryMs = 5 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const lastPeriodicReportAt = state.lastPeriodicReportAt
    ? new Date(state.lastPeriodicReportAt).getTime()
    : 0;

  if (!force && lastPeriodicReportAt && now - lastPeriodicReportAt < reportEveryMs) {
    return;
  }

  state.lastPeriodicReportAt = new Date(now).toISOString();
  await saveState(env, state);

  const regime = state.lastRegime;
  const recentTrades = state.trades.filter(t => Date.now() - new Date(t.closedAt).getTime() < 86400000);
  const openCount = Object.keys(state.positions).length;
  const currVal   = portfolioValue(state);
  const totalPnL  = state.trades.reduce((s, t) => s + t.pnl, 0);
  const wins      = state.trades.filter(t => t.pnl > 0).length;
  const winRate   = state.trades.length > 0 ? ((wins / state.trades.length) * 100).toFixed(1) : "N/A";
  const metrics   = calculatePerformanceMetrics(state.trades);
  const spend     = estimateMonthlySpend(state.tokenUsage || { input: 0, output: 0 });

  if (recentTrades.length === 0 && openCount === 0) {
    await sendTelegram(
      `📊 Daily (quiet)\nRegime: ${regime?.label ?? "?"} | PI: ${regime?.piCycle ?? "?"}\n` +
      `Value: $${currVal.toFixed(2)} | Cash: $${state.cash.toFixed(2)}\n` +
      `Open: ${openCount}/${MAX_POSITIONS} | Trades: ${state.trades.length}\n` +
      `PnL: $${totalPnL.toFixed(2)} | WR: ${winRate}%\n` +
      `${metrics ? `Sharpe:${metrics.sharpe} PF:${metrics.profitFactor}` : ""}\n` +
      `Claude: $${spend.toFixed(2)}/$${MONTHLY_BUDGET_USD}`, env);
    state.lastPeriodicReportAt = new Date(now).toISOString();
    await saveState(env, state);
    return;
  }

  if (!env.ANTHROPIC_API_KEY) {
    await sendTelegram(`📊 Value:$${currVal.toFixed(2)} Open:${openCount} PnL:$${totalPnL.toFixed(2)}`, env);
    return;
  }

  const prompt = `Crypto paper-trade 5-day brief, under 200 words, plain text, no markdown.\n` +
    `Regime:${regime?.label ?? "?"} HMM:${regime?.hmmLabel ?? "?"} PI:${regime?.piCycle ?? "?"}\n` +
    `Portfolio:$${currVal.toFixed(2)} Cash:$${state.cash.toFixed(2)} Open:${openCount}/${MAX_POSITIONS}\n` +
    `Today:${recentTrades.length} trades PnL:$${recentTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2)}\n` +
    `All-time:${state.trades.length} trades $${totalPnL.toFixed(2)} PnL ${winRate}%WR\n` +
    `${metrics ? `Sharpe:${metrics.sharpe} Sortino:${metrics.sortino} PF:${metrics.profitFactor} MaxDD:${metrics.maxDrawdown}%` : ""}\n` +
    `Cover: regime, health, one suggestion.`;

  try {
    const report = await callClaudePlaintext(prompt, env, state, 300);
    await sendTelegram(`📊 Daily Report\n\n${report}\n\nClaude:$${spend.toFixed(2)}/$${MONTHLY_BUDGET_USD}`, env);
  } catch (err) {
    await sendTelegram(`📊 Value:$${currVal.toFixed(2)} PnL:$${totalPnL.toFixed(2)} Open:${openCount}`, env);
  }
  state.lastPeriodicReportAt = new Date(now).toISOString();
  await saveState(env, state);
}

// =============================================================================
// RISK ASSESSMENT
// =============================================================================
async function sendRiskAssessment(env) {
  const state     = await loadState(env);
  const positions = Object.values(state.positions);
  if (positions.length === 0) return;

  const details = [];
  for (const pos of positions) {
    try {
      const candles = await fetchCandles(pos.symbol, "1h", 24);
      if (!candles || candles.length === 0) continue;
      const price     = candles[candles.length - 1].close;
      const pnl       = pos.direction === "long"
        ? (price - pos.entryPrice) * pos.size
        : (pos.entryPrice - price) * pos.size;
      const pnlPct    = pos.notional > 0 ? (pnl / pos.notional) * 100 : 0;
      const hoursOpen = ((Date.now() - new Date(pos.openedAt).getTime()) / 3600000).toFixed(0);
      details.push(`${pos.symbol} ${pos.direction.toUpperCase()} entry:$${pos.entryPrice.toFixed(4)} now:$${price.toFixed(4)} PnL:$${pnl.toFixed(2)}(${pnlPct.toFixed(1)}%) SL:$${pos.sl.toFixed(4)} ${hoursOpen}h`);
    } catch (_) { continue; }
  }
  if (details.length === 0) return;

  if (!env.ANTHROPIC_API_KEY) return;

  const prompt = `Crypto risk review. Each position: HOLD/TIGHTEN/CLOSE with 1 reason. Under 200 words, plain text.\n` +
    `Regime:${state.lastRegime?.label ?? "?"} Portfolio:$${portfolioValue(state).toFixed(2)}\n` +
    `${details.join("\n")}`;

  try {
    const analysis = await callClaudePlaintext(prompt, env, state, 300);
    await sendTelegram(`⚠️ Risk Check\n\n${analysis}`, env);
  } catch (err) {
    console.error("[RISK]", err.message);
  }
  await saveState(env, state);
}

// =============================================================================
// WEEKLY STRATEGY REVIEW
// =============================================================================
async function sendWeeklyReview(env) {
  const state      = await loadState(env);
  const weekAgo    = Date.now() - 7 * 86400000;
  const weekTrades = state.trades.filter(t => new Date(t.closedAt).getTime() > weekAgo);

  if (weekTrades.length === 0) {
    await sendTelegram("📈 Weekly: No trades this week.", env);
    return;
  }

  const wins     = weekTrades.filter(t => t.pnl > 0);
  const losses   = weekTrades.filter(t => t.pnl <= 0);
  const totalPnL = weekTrades.reduce((s, t) => s + t.pnl, 0);

  const sigOuts = {};
  for (const t of weekTrades) {
    for (const r of (t.reasons || [])) {
      if (!sigOuts[r]) sigOuts[r] = { w: 0, l: 0, pnl: 0 };
      sigOuts[r].pnl += t.pnl;
      if (t.pnl > 0) sigOuts[r].w++; else sigOuts[r].l++;
    }
  }
  const sigReport = Object.entries(sigOuts).sort((a, b) => b[1].pnl - a[1].pnl).slice(0, 12)
    .map(([s, d]) => `${s}:${d.w}W/${d.l}L $${d.pnl.toFixed(2)}`).join("\n");

  const setupTypes = ["trend", "breakout", "mean-reversion", "liquidity-trap"];
  const setupLines = setupTypes
    .map(type => {
      const s = getSetupStats(state.trades, type);
      if (!s) return `${type}: no data`;
      return `${type}: n=${s.count} WR=${(s.winRate * 100).toFixed(1)}% EV=${s.expectancy.toFixed(2)}`;
    })
    .join("\n");

  const approvalTypes = ["auto", "claude"];
  const approvalLines = approvalTypes
    .map(type => {
      const s = getApprovalStats(state.trades, type);
      if (!s) return `${type}: no data`;
      return `${type}: n=${s.count} WR=${(s.winRate * 100).toFixed(1)}% EV=${s.expectancy.toFixed(2)}`;
    })
    .join("\n");

  const metrics = calculatePerformanceMetrics(state.trades);

  if (!env.ANTHROPIC_API_KEY) {
    await sendTelegram(`📈 Weekly: ${weekTrades.length} trades PnL:$${totalPnL.toFixed(2)}`, env);
    return;
  }

  const prompt = `Quant bot weekly review. Under 350 words, plain text.\n` +
    `Week: ${weekTrades.length} trades W:${wins.length} L:${losses.length} PnL:$${totalPnL.toFixed(2)}\n` +
    `AvgWin:$${wins.length > 0 ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(2) : "0"}\n` +
    `AvgLoss:$${losses.length > 0 ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(2) : "0"}\n\n` +
    `SIGNALS:\n${sigReport}\n\n` +
    `ALL-TIME: ${state.trades.length} trades $${state.trades.reduce((s, t) => s + t.pnl, 0).toFixed(2)} PnL\n` +
    `Portfolio:$${portfolioValue(state).toFixed(2)} Regime:${state.lastRegime?.label ?? "?"}\n` +
    `${metrics ? `Sharpe:${metrics.sharpe} Sortino:${metrics.sortino} PF:${metrics.profitFactor}` : ""}\n\n` +
    `SETUP STATS:\n${setupLines}\n\nAPPROVAL STATS:\n${approvalLines}\n\n` +
    `Provide: 1.What worked 2.What failed 3.Signal weight changes 4.One parameter change 5.Next week outlook`;

  try {
    const review = await callClaudePlaintext(prompt, env, state, 500);
    await sendTelegram(`📈 Weekly Review\n\n${review}`, env);

    if (!state.weeklyReviews) state.weeklyReviews = [];
    state.weeklyReviews.push({ date: new Date().toISOString(), trades: weekTrades.length, pnl: totalPnL });
    if (state.weeklyReviews.length > 12) state.weeklyReviews = state.weeklyReviews.slice(-12);

    trackSignalPerformance(state);
    await saveState(env, state);
  } catch (err) {
    console.error("[WEEKLY]", err.message);
  }
}

// =============================================================================
// PRE-MARKET SCAN
// =============================================================================
async function premarketScan(env) {
  const state = await loadState(env);
  const regime = state.lastRegime;

  const btc = await fetchCandles("BTC-USDT-SWAP", "4h", 50);
  if (!btc || btc.length < 20) return;

  const closes = btc.map(c => c.close);
  const highs  = btc.map(c => c.high);
  const lows   = btc.map(c => c.low);
  const n      = closes.length;
  const price  = closes[n - 1];
  const rsiArr = rsiSeries(closes, 14);
  const bb     = bollingerBands(closes, 20, 2);
  const adxR   = adx(highs, lows, closes, 14);

  if (!env.ANTHROPIC_API_KEY) return;

  const prompt = `Pre-market crypto. Under 150 words, plain text.\n` +
    `BTC:$${price.toFixed(0)} RSI4h:${rsiArr[n - 1].toFixed(0)} BB%B:${((bb.pctB[n - 1] || 0.5) * 100).toFixed(0)}% ADX:${adxR.adx.toFixed(0)}\n` +
    `Regime:${regime?.label ?? "?"} PI:${regime?.piCycle ?? "?"}\n` +
    `Open:${Object.keys(state.positions).length} Portfolio:$${portfolioValue(state).toFixed(2)}\n` +
    `Set bias: LONG ONLY / SHORT ONLY / BOTH / FLAT. Key BTC levels.`;

  try {
    const scan = await callClaudePlaintext(prompt, env, state, 250);
    await sendTelegram(`🌅 Pre-Market\n\n${scan}`, env);
    state.dailyBias = scan;
    await saveState(env, state);
  } catch (err) {
    console.error("[PREMARKET]", err.message);
  }
}

// =============================================================================
// POSITION RE-EVALUATION (every 4h)
// =============================================================================
async function reevaluatePositions(env) {
  const state     = await loadState(env);
  const positions = Object.values(state.positions);
  if (positions.length === 0) return;

  const details = [];
  for (const pos of positions) {
    try {
      const candles = await fetchCandles(pos.symbol, "1h", 30);
      if (!candles) continue;
      const closes = candles.map(c => c.close);
      const price  = closes[closes.length - 1];
      const rsiArr = rsiSeries(closes, 14);
      const pnl    = pos.direction === "long" ? (price - pos.entryPrice) * pos.size : (pos.entryPrice - price) * pos.size;
      details.push(`${pos.symbol} ${pos.direction} @${pos.entryPrice.toFixed(4)} now:${price.toFixed(4)} PnL:$${pnl.toFixed(2)} RSI:${rsiArr[closes.length - 1].toFixed(0)} ${((Date.now() - new Date(pos.openedAt).getTime()) / 3600000).toFixed(0)}h`);
    } catch (_) { continue; }
  }
  if (details.length === 0) return;
  if (!env.ANTHROPIC_API_KEY) return;

  const prompt = `Re-evaluate ${positions.length} positions. JSON: {"SYM_USDT":"hold"or"tighten"or"close"}\nRegime:${state.lastRegime?.label ?? "?"}\n${details.join("\n")}\nJSON only:`;

  try {
    const raw     = await callClaudeBudgeted(prompt, env, state, 300);
    const actions = JSON.parse(raw);
    for (const [symbol, action] of Object.entries(actions)) {
      const pos = state.positions[symbol];
      if (!pos) continue;
      if (action === "tighten") {
        pos.sl = pos.direction === "long" ? Math.max(pos.sl, pos.entryPrice) : Math.min(pos.sl, pos.entryPrice);
        console.log(`[REEVAL] ${symbol} tightened to breakeven`);
      }
      if (action === "close") {
        pos.forceClose = true;
        console.log(`[REEVAL] ${symbol} flagged for close`);
      }
    }
    await saveState(env, state);
  } catch (err) {
    console.error("[REEVAL]", err.message);
  }
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
function getSetupStats(trades, setupType) {
  const rows = (trades || []).filter(t => t.setupType === setupType);
  if (rows.length === 0) return null;

  const wins = rows.filter(t => t.pnl > 0);
  const losses = rows.filter(t => t.pnl <= 0);

  const winRate = wins.length / rows.length;
  const avgWin = wins.length
    ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length)
    : 0;

  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  return {
    count: rows.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy
  };
}

function getApprovalStats(trades, approvalType) {
  const rows = (trades || []).filter(t => t.approvalType === approvalType);
  if (rows.length === 0) return null;

  const wins = rows.filter(t => t.pnl > 0);
  const losses = rows.filter(t => t.pnl <= 0);

  const winRate = wins.length / rows.length;
  const avgWin = wins.length
    ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length)
    : 0;

  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  return {
    count: rows.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy
  };
}

function getApprovalRiskMultiplier(state, approvalType) {
  const stats = getApprovalStats(state.trades || [], approvalType);
  if (!stats || stats.count < 15) return 1.0;
  if (stats.expectancy > 8 && stats.winRate > 0.52) return 1.10;
  if (stats.expectancy < -5 && stats.winRate < 0.45) return 0.85;
  if (stats.expectancy < 0) return 0.93;
  return 1.0;
}

function getAdaptiveSetupDecision(state, setupType) {
  const stats = getSetupStats(state.trades || [], setupType);

  // No evidence yet
  if (!stats) {
    return {
      allow: true,
      sizeMult: 1.0,
      reason: "no-stats"
    };
  }

  const { count, expectancy, winRate } = stats;

  // Small sample: ignore
  if (count < 10) {
    return {
      allow: true,
      sizeMult: 1.0,
      reason: "low-sample"
    };
  }

  // Medium sample: soft adjustments only
  if (count < 20) {
    if (expectancy > 5 && winRate > 0.5) {
      return {
        allow: true,
        sizeMult: 1.10,
        reason: `early-good n=${count} ev=${expectancy.toFixed(2)}`
      };
    }

    if (expectancy < 0) {
      return {
        allow: true,
        sizeMult: 0.85,
        reason: `early-weak n=${count} ev=${expectancy.toFixed(2)}`
      };
    }

    return {
      allow: true,
      sizeMult: 1.0,
      reason: `early-neutral n=${count} ev=${expectancy.toFixed(2)}`
    };
  }

  // Established sample: stronger adjustments
  if (count < 30) {
    if (expectancy > 8 && winRate > 0.52) {
      return {
        allow: true,
        sizeMult: 1.15,
        reason: `good n=${count} ev=${expectancy.toFixed(2)}`
      };
    }

    if (expectancy < -5) {
      return {
        allow: true,
        sizeMult: 0.70,
        reason: `bad-but-not-blocked n=${count} ev=${expectancy.toFixed(2)}`
      };
    }

    if (expectancy < 0) {
      return {
        allow: true,
        sizeMult: 0.85,
        reason: `weak n=${count} ev=${expectancy.toFixed(2)}`
      };
    }

    return {
      allow: true,
      sizeMult: 1.0,
      reason: `neutral n=${count} ev=${expectancy.toFixed(2)}`
    };
  }

  // Strong sample: allow hard skip only here
  if (expectancy < -5 && winRate < 0.45) {
    return {
      allow: false,
      sizeMult: 0.0,
      reason: `blocked n=${count} ev=${expectancy.toFixed(2)} wr=${(winRate * 100).toFixed(1)}%`
    };
  }

  if (expectancy < 0) {
    return {
      allow: true,
      sizeMult: 0.75,
      reason: `established-weak n=${count} ev=${expectancy.toFixed(2)}`
    };
  }

  if (expectancy > 8 && winRate > 0.52) {
    return {
      allow: true,
      sizeMult: 1.20,
      reason: `established-strong n=${count} ev=${expectancy.toFixed(2)}`
    };
  }

  return {
    allow: true,
    sizeMult: 1.0,
    reason: `established-neutral n=${count} ev=${expectancy.toFixed(2)}`
  };
}

function getSetupRiskMultiplier(state, setupType) {
  const stats = getSetupStats(state.trades || [], setupType);

  if (!stats || stats.count < 20) return 1.0;
  if (stats.expectancy > 8) return 1.25;
  if (stats.expectancy > 3) return 1.10;
  if (stats.expectancy < 0) return 0.75;
  return 1.0;
}

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

function getAdaptiveClaudeThreshold(state, currentRegime) {
  if (!state.regimeStats) return CLAUDE_THRESHOLD;

  const rs = state.regimeStats[currentRegime];
  if (!rs || rs.count < 15) return CLAUDE_THRESHOLD;

  const winRate = rs.wins / rs.count;
  const claudeStats = getApprovalStats(state.trades || [], "claude");
  const autoStats = getApprovalStats(state.trades || [], "auto");
  let adaptive = CLAUDE_THRESHOLD;

  // Bad regime → use Claude MORE (lower threshold)
  if (winRate < 0.40) adaptive -= 1;

  // Good regime → trust system MORE
  if (winRate > 0.55) adaptive += 1;

  if (claudeStats && claudeStats.count >= 15) {
    if (claudeStats.expectancy < 0) adaptive += 1;
    else if (claudeStats.expectancy > 0 && (!autoStats || autoStats.count < 15 || claudeStats.expectancy > autoStats.expectancy)) adaptive -= 1;
  }

  return Math.max(CLAUDE_THRESHOLD - 2, Math.min(CLAUDE_THRESHOLD + 2, adaptive));
}
// =============================================================================
// PERFORMANCE METRICS
// =============================================================================
function calculatePerformanceMetrics(trades) {
  if (trades.length < 5) return null;

  const returns = trades.map(t => (t.pnl / (t.notional || 500)) * 100);
  const avg = mean(returns);
  const sd  = std(returns);

  const sharpe  = sd > 0 ? (avg / sd) * Math.sqrt(365) : 0;
  const negRet  = returns.filter(r => r < 0);
  const downDev = negRet.length > 0 ? std(negRet) : 0.001;
  const sortino = (avg / downDev) * Math.sqrt(365);

  let peak = 0, maxDD = 0, eq = 0;
  for (const r of returns) { eq += r; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }

  const gp = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
  const pf = gl > 0 ? gp / gl : gp > 0 ? 999 : 0;

  return {
    totalTrades: trades.length,
    winRate:     ((trades.filter(t => t.pnl > 0).length / trades.length) * 100).toFixed(1),
    sharpe:      sharpe.toFixed(2),
    sortino:     sortino.toFixed(2),
    maxDrawdown: maxDD.toFixed(2),
    profitFactor: pf.toFixed(2)
  };
}

// =============================================================================
// POSITION MANAGEMENT
// =============================================================================
function portfolioValue(state, livePrices = null) {
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
  const reserved = Object.values(state.positions).reduce((s, p) => s + p.notional, 0);
  return state.cash + reserved + unrealizedPnl;
}

async function fetchLivePrices(state) {
  const prices = {};
  const symbols = Object.keys(state.positions);
  if (symbols.length === 0) return prices;
  const tickers = await fetchAllTickers();
  if (!tickers) return prices;
  for (const t of tickers) {
    if (state.positions[t.contract]) {
      prices[t.contract] = parseFloat(t.last);
    }
  }
  return prices;
}

// =============================================================================
// GRADUAL ENTRY — SCALED POSITION BUILDING
// Entry in up to 3 tranches:
//   Tranche 1 (40%): Initial signal triggers
//   Tranche 2 (35%): Price moves 0.5×ATR in our favor
//   Tranche 3 (25%): Price moves 1.5×ATR in our favor
// =============================================================================

function openPositionGradual(candidate, state, livePrices = null, env = null) {
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
      // Notify once when circuit breaker activates
      sendTelegram(`⚠️ CIRCUIT BREAKER ACTIVE\nDrawdown: ${(drawdown * 100).toFixed(1)}%\nNo new entries until portfolio recovers.`, env).catch(() => {});
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
    console.log(
      `[${symbol}] Skipped: setup blocked (${setupType}) ${setupDecision.reason}`
    );
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
  const slDist     = Math.abs(price - sl);
  if (slDist === 0) return false;

  let totalSize = riskAmount / slDist;
  let totalNotional = totalSize * price;
  const maxN = currVal * MAX_POSITION_SHARE;
  if (totalNotional > maxN) { totalNotional = maxN; totalSize = totalNotional / price; }

  // Tranche 1: 40% of total position
  const tranche1Pct = 0.40;
  const tranche1Notional = totalNotional * tranche1Pct;
  const tranche1Size     = totalSize * tranche1Pct * leverage;

  if (tranche1Notional > state.cash) {
    console.log(`[${symbol}] Cash too low ($${state.cash.toFixed(2)} < $${tranche1Notional.toFixed(2)})`);
    return false;
  }

  const liqPrice = signal === "long"
    ? price * (1 - 1 / leverage + 0.005)
    : price * (1 + 1 / leverage - 0.005);

  // Define tranche trigger prices
  const tranche2Trigger = signal === "long"
    ? price + atrVal * 0.5
    : price - atrVal * 0.5;
  const tranche3Trigger = signal === "long"
    ? price + atrVal * 1.5
    : price - atrVal * 1.5;

  state.cash -= tranche1Notional;

  state.positions[symbol] = {
    symbol, direction: signal, entryPrice: price,
    size: tranche1Size,
    notional: tranche1Notional,
    effectiveExposure: tranche1Notional * leverage,
    leverage: leverage, sl, tp, atrVal, riskReward, score,
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

    // Gradual entry tracking
    tranches: {
      plan: {
        totalSize: totalSize * leverage,
        totalNotional: totalNotional,
        tranche1: { pct: 0.40, filled: true, price: price, size: tranche1Size, notional: tranche1Notional },
        tranche2: { pct: 0.35, filled: false, triggerPrice: tranche2Trigger, size: 0, notional: 0 },
        tranche3: { pct: 0.25, filled: false, triggerPrice: tranche3Trigger, size: 0, notional: 0 },
      },
      filledCount: 1,
      avgEntryPrice: price
    },
    tpLevels: {
      tp1: {
        atrMult: 2.0,
        pct: 0.30,
        hit: false,
        price: signal === "long"
          ? price + atrVal * 2.0
          : price - atrVal * 2.0
      },
      tp2: {
        atrMult: 3.5,
        pct: 0.30,
        hit: false,
        price: signal === "long"
          ? price + atrVal * 3.5
          : price - atrVal * 3.5
      },
      tp3: {
        pct: 0.40,
        hit: false
      }
    },
    dcaApplied: false,
  };

  console.log(
    `🟢 [${symbol}] OPEN ${signal.toUpperCase()} T1/3 @$${price.toFixed(6)} | ` +
    `$${tranche1Notional.toFixed(2)} margin (40% of $${totalNotional.toFixed(2)}) | ` +
    `T2@$${tranche2Trigger.toFixed(6)} T3@$${tranche3Trigger.toFixed(6)} | ` +
    `Score:${score} [${reasons.join(",")}]`
  );
  return true;
}

// Check and fill remaining tranches during exit checks
function checkTranches(pos, price, state) {
  if (!pos.tranches) return; // Legacy position without tranches

  const plan = pos.tranches.plan;

  // Check tranche 2
  if (!plan.tranche2.filled) {
    const triggered = pos.direction === "long"
      ? price >= plan.tranche2.triggerPrice
      : price <= plan.tranche2.triggerPrice;

    if (triggered) {
      const t2Notional = plan.totalNotional * plan.tranche2.pct;
      const t2Size     = plan.totalSize * plan.tranche2.pct;

      if (t2Notional <= state.cash) {
        state.cash -= t2Notional;
        pos.size     += t2Size;
        pos.notional += t2Notional;
        pos.effectiveExposure = pos.notional * pos.leverage;

        plan.tranche2.filled   = true;
        plan.tranche2.price    = price;
        plan.tranche2.size     = t2Size;
        plan.tranche2.notional = t2Notional;
        pos.tranches.filledCount = 2;

        // Recalculate average entry
        const t1 = plan.tranche1;
        const t2 = plan.tranche2;
        pos.tranches.avgEntryPrice = (t1.price * t1.size + t2.price * t2.size) / (t1.size + t2.size);
        pos.entryPrice = pos.tranches.avgEntryPrice;

        // Tighten stop to breakeven on tranche 1
        if (pos.direction === "long") {
          pos.sl = Math.max(pos.sl, plan.tranche1.price);
        } else {
          pos.sl = Math.min(pos.sl, plan.tranche1.price);
        }

        console.log(`📈 [${pos.symbol}] TRANCHE 2 filled @$${price.toFixed(6)} | +$${t2Notional.toFixed(2)} | Total:$${pos.notional.toFixed(2)} | SL→$${pos.sl.toFixed(6)}`);
      }
    }
  }

  // Check tranche 3
  if (plan.tranche2.filled && !plan.tranche3.filled) {
    const triggered = pos.direction === "long"
      ? price >= plan.tranche3.triggerPrice
      : price <= plan.tranche3.triggerPrice;

    if (triggered) {
      const t3Notional = plan.totalNotional * plan.tranche3.pct;
      const t3Size     = plan.totalSize * plan.tranche3.pct;

      if (t3Notional <= state.cash) {
        state.cash -= t3Notional;
        pos.size     += t3Size;
        pos.notional += t3Notional;
        pos.effectiveExposure = pos.notional * pos.leverage;

        plan.tranche3.filled   = true;
        plan.tranche3.price    = price;
        plan.tranche3.size     = t3Size;
        plan.tranche3.notional = t3Notional;
        pos.tranches.filledCount = 3;

        // Recalculate average entry
        const sizes  = [plan.tranche1, plan.tranche2, plan.tranche3].filter(t => t.filled);
        const totalS = sizes.reduce((s, t) => s + t.size, 0);
        pos.tranches.avgEntryPrice = sizes.reduce((s, t) => s + t.price * t.size, 0) / totalS;
        pos.entryPrice = pos.tranches.avgEntryPrice;

        // Tighten stop to tranche 1 entry
        if (pos.direction === "long") {
          pos.sl = Math.max(pos.sl, plan.tranche1.price + pos.atrVal * 0.3);
        } else {
          pos.sl = Math.min(pos.sl, plan.tranche1.price - pos.atrVal * 0.3);
        }

        console.log(`📈 [${pos.symbol}] TRANCHE 3 filled @$${price.toFixed(6)} | FULL POSITION $${pos.notional.toFixed(2)} | SL→$${pos.sl.toFixed(6)}`);
      }
    }
  }
}
// =============================================================================
// GRADUATED TAKE-PROFIT
// TP1 (30%): Close 30% at 2×ATR profit — lock in base profit
// TP2 (30%): Close 30% at 3.5×ATR profit — capture momentum
// TP3 (40%): Remaining with trailing stop — let it run
// =============================================================================

function checkGraduatedExit(pos, price, high, low, currentAtr, state) {
  const { direction, entryPrice } = pos;
  if (!pos.maxFavorable) pos.maxFavorable = entryPrice;

  console.log(
    `[EXIT CHECK] ${pos.symbol} ${direction.toUpperCase()} ` +
    `live=${price.toFixed(6)} high=${high.toFixed(6)} low=${low.toFixed(6)} ` +
    `sl=${pos.sl.toFixed(6)} tp=${pos.tp.toFixed(6)}`
  );

  if (direction === "long" && low <= pos.sl) {
    console.log(`[SL HIT] ${pos.symbol} LONG | low=${low.toFixed(6)} <= sl=${pos.sl.toFixed(6)}`);
    return { exit: true, reason: "stop-loss-hit" };
  }

  if (direction === "short" && high >= pos.sl) {
    console.log(`[SL HIT] ${pos.symbol} SHORT | high=${high.toFixed(6)} >= sl=${pos.sl.toFixed(6)}`);
    return { exit: true, reason: "stop-loss-hit" };
  }

  if (direction === "long" && high >= pos.tp) {
    console.log(`[TP HIT] ${pos.symbol} LONG | high=${high.toFixed(6)} >= tp=${pos.tp.toFixed(6)}`);
    return { exit: true, reason: "take-profit-hit" };
  }

  if (direction === "short" && low <= pos.tp) {
    console.log(`[TP HIT] ${pos.symbol} SHORT | low=${low.toFixed(6)} <= tp=${pos.tp.toFixed(6)}`);
    return { exit: true, reason: "take-profit-hit" };
  }

  // Use entry ATR for TP levels, current ATR for trailing
  const entryAtr = pos.atrVal || currentAtr;

  // Initialize TP tracking if not present (fallback for legacy positions)
  if (!pos.tpLevels) {
    pos.tpLevels = {
      tp1: {
        atrMult: 2.0,
        pct: 0.30,
        hit: false,
        // TP1: Take 30% at the candidate's calculated TP (structure-aware)
        // or 2×ATR, whichever is CLOSER (lock profit early)
        price: direction === "long"
          ? entryPrice + entryAtr * 2.0
          : entryPrice - entryAtr * 2.0
      },
      tp2: {
        atrMult: 3.5,
        pct: 0.30,
        hit: false,
        // TP2: Take 30% at the full structure TP or 3.5×ATR
        price: direction === "long"
          ? entryPrice + entryAtr * 3.5
          : entryPrice - entryAtr * 3.5
      },
      tp3: {
        pct: 0.40,
        hit: false
      }
    };
  }

  const partialCloses = [];

  if (direction === "long") {
    pos.maxFavorable = Math.max(pos.maxFavorable, price);

    // Stop loss — close everything
    if (low <= pos.sl) return { exit: true, reason: "stop-loss", partial: false };
    // Liquidation
    if (pos.liquidationPrice && low <= pos.liquidationPrice) return { exit: true, reason: "liquidation", partial: false };

    // TP1: 30% at 2×ATR
    if (!pos.tpLevels.tp1.hit && high >= pos.tpLevels.tp1.price) {
      pos.tpLevels.tp1.hit = true;
      partialCloses.push({ pct: pos.tpLevels.tp1.pct, reason: "tp1-2xATR" });
      // Move stop to breakeven after TP1
      pos.sl = Math.max(pos.sl, entryPrice + currentAtr * 0.1);
    }

    // TP2: 30% at 3.5×ATR
    if (!pos.tpLevels.tp2.hit && high >= pos.tpLevels.tp2.price) {
      pos.tpLevels.tp2.hit = true;
      partialCloses.push({ pct: pos.tpLevels.tp2.pct, reason: "tp2-3.5xATR" });
      // Move stop to TP1 level
      pos.sl = Math.max(pos.sl, pos.tpLevels.tp1.price);
    }

    // TP3: adaptive trailing stop for remaining 40%
    if (pos.tpLevels.tp1.hit && pos.tpLevels.tp2.hit && !pos.tpLevels.tp3.hit) {
      const profitATRs = currentAtr > 0 ? (price - entryPrice) / currentAtr : 0;
      // Tighten trail as profit grows: starts at 1.2 ATR, shrinks to 0.6 ATR
      const trailDistance = currentAtr * Math.max(0.6, 1.2 - (profitATRs - 3.5) * 0.15);
      pos.sl = Math.max(pos.sl, pos.maxFavorable - trailDistance);

      // Never let stop go below TP2 level (protect profits)
      if (pos.tpLevels.tp2.price) {
        pos.sl = Math.max(pos.sl, pos.tpLevels.tp2.price);
      }
    }

    // Progressive trailing before TP1
    const profitATRs = currentAtr > 0 ? (price - entryPrice) / currentAtr : 0;
    if (profitATRs > 3 && !pos.tpLevels.tp1.hit) {
      const trail = currentAtr * Math.max(1.0, ATR_SL_MULT - (profitATRs - 3) * 0.2);
      pos.sl = Math.max(pos.sl, pos.maxFavorable - trail);
    }

    // Time-based tightening
    const hours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
    if (hours > 48 && profitATRs > 1) {
      pos.sl = Math.max(pos.sl, entryPrice + currentAtr * 0.5);
    }

    // Full TP safety net (legacy pos.tp field)
    if (pos.tp && high >= pos.tp) {
      return { exit: true, reason: "take-profit-full", partial: false };
    }

  } else {
    // SHORT
    pos.maxFavorable = Math.min(pos.maxFavorable, price);

    if (high >= pos.sl) return { exit: true, reason: "stop-loss", partial: false };
    if (pos.liquidationPrice && high >= pos.liquidationPrice) return { exit: true, reason: "liquidation", partial: false };

    // TP1: 30% at 2×ATR
    if (!pos.tpLevels.tp1.hit && low <= pos.tpLevels.tp1.price) {
      pos.tpLevels.tp1.hit = true;
      partialCloses.push({ pct: pos.tpLevels.tp1.pct, reason: "tp1-2xATR" });
      pos.sl = Math.min(pos.sl, entryPrice - currentAtr * 0.1);
    }

    // TP2: 30% at 3.5×ATR
    if (!pos.tpLevels.tp2.hit && low <= pos.tpLevels.tp2.price) {
      pos.tpLevels.tp2.hit = true;
      partialCloses.push({ pct: pos.tpLevels.tp2.pct, reason: "tp2-3.5xATR" });
      pos.sl = Math.min(pos.sl, pos.tpLevels.tp1.price);
    }

    // TP3 trailing
    if (pos.tpLevels.tp1.hit && pos.tpLevels.tp2.hit && !pos.tpLevels.tp3.hit) {
      const profitATRs = currentAtr > 0 ? (entryPrice - price) / currentAtr : 0;
      const trailDistance = currentAtr * Math.max(0.6, 1.2 - (profitATRs - 3.5) * 0.15);
      pos.sl = Math.min(pos.sl, pos.maxFavorable + trailDistance);

      if (pos.tpLevels.tp2.price) {
        pos.sl = Math.min(pos.sl, pos.tpLevels.tp2.price);
      }
    }

    // Progressive trailing before TP1
    const profitATRs = currentAtr > 0 ? (entryPrice - price) / currentAtr : 0;
    if (profitATRs > 3 && !pos.tpLevels.tp1.hit) {
      const trail = currentAtr * Math.max(1.0, ATR_SL_MULT - (profitATRs - 3) * 0.2);
      pos.sl = Math.min(pos.sl, pos.maxFavorable + trail);
    }

    // Time-based tightening
    const hours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
    if (hours > 48 && profitATRs > 1) {
      pos.sl = Math.min(pos.sl, entryPrice - currentAtr * 0.5);
    }

    // Full TP safety net (legacy pos.tp field)
    if (pos.tp && low <= pos.tp) {
      return { exit: true, reason: "take-profit-full", partial: false };
    }
  }

  if (partialCloses.length > 0) {
    return { exit: false, partial: true, partialCloses };
  }

  return { exit: false, partial: false };
}


// Execute a partial close
function executePartialClose(symbol, price, pct, reason, pos, state) {
  const closeSize     = pos.size * pct;
  const closeNotional = pos.notional * pct;

  const rawPnl   = pos.direction === "long"
    ? (price - pos.entryPrice) * closeSize
    : (pos.entryPrice - price) * closeSize;
  const clampPnl = Math.max(rawPnl, -closeNotional);
  const pnlPct   = closeNotional > 0 ? (clampPnl / closeNotional) * 100 : 0;

  // Return cash from partial close
  state.cash += closeNotional + clampPnl;

  // Reduce position
  pos.size     -= closeSize;
  pos.notional -= closeNotional;
  pos.effectiveExposure = pos.notional * pos.leverage;

  // Record partial trade
  state.trades.push({
    symbol, direction: pos.direction,
    entryPrice: pos.entryPrice, exitPrice: price,
    size: closeSize, leverage: pos.leverage, notional: closeNotional,
    pnl: parseFloat(clampPnl.toFixed(6)),
    pnlPct: parseFloat(pnlPct.toFixed(2)),
    reason: `partial-${reason}`, openedAt: pos.openedAt, closedAt: new Date().toISOString(),
    score: pos.score,
    reasons: [...(pos.reasons || [])],
    setupType: pos.setupType || "unknown",
    approvalType: pos.approvalType || "unknown",
    signalSet: [...(pos.signalSet || [])],
    journal: null, wasLiquidated: false,
    isPartial: true, partialPct: pct
  });

  // Update learning systems
  const tradeRecord = state.trades[state.trades.length - 1];
  updateCoinHistory(state, symbol, {
    direction: pos.direction, pnl: clampPnl, pnlPct,
    reasons: pos.reasons, reason: `partial-${reason}`
  });
  updateRegimeStats(state, tradeRecord);

  console.log(`📊 [${symbol}] PARTIAL CLOSE ${(pct * 100).toFixed(0)}% @$${price.toFixed(6)} | PnL:$${clampPnl.toFixed(2)} (${pnlPct.toFixed(1)}%) | ${reason} | Remaining:$${pos.notional.toFixed(2)}`);
  updateDynamicWeights(state);
}

// =============================================================================
// DCA — CONTROLLED AVERAGING DOWN
// Only triggers if:
//   1. Position is down 1-2×ATR (not catastrophically)
//   2. Original signal reasons are still mostly valid
//   3. Only one DCA per position (no infinite averaging)
//   4. Overall portfolio is not in drawdown
//   5. Position has been open at least 4 hours
// =============================================================================

async function checkDCA(pos, price, currentAtr, state, env) {
  // Already DCA'd once — no more
  if (pos.dcaApplied) return;

  // Position must be at least 4 hours old
  const hoursOpen = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
  if (hoursOpen < 4) return;

  // Must be in a loss of 1-2×ATR (not too deep, not shallow)
  const loss = pos.direction === "long"
    ? pos.entryPrice - price
    : price - pos.entryPrice;
  const lossATRs = currentAtr > 0 ? loss / currentAtr : 0;

  if (lossATRs < 0.7 || lossATRs > 2.5) return;

  // Portfolio must not be in drawdown
  const currVal = portfolioValue(state);
  if (state.peakValue && (state.peakValue - currVal) / state.peakValue > 0.08) return;

  // Re-validate the signal: at least 60% of original reasons should still be active
  try {
    const candles = await fetchCandles(pos.symbol, "1h", 100);
    if (!candles || candles.length < 50) return;

    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const n       = closes.length;

    // Quick signal recheck
    const rsiArr    = rsiSeries(closes, 14);
    const rsiVal    = rsiArr[n - 1];
    const vwapVal   = vwap(highs, lows, closes, volumes, 24);
    const ichi      = ichimoku(highs, lows, closes);
    const macdR     = macd(closes);

    let confirmations = 0;
    const needed = 3;

    if (pos.direction === "long") {
      if (rsiVal < 40) confirmations++;              // Still not overbought
      if (price > vwapVal) confirmations++;           // Still above VWAP
      if (ichi.tkCross > 0) confirmations++;          // Tenkan still above Kijun
      if (macdR.histogram > 0) confirmations++;       // MACD still positive
      if (price > ichi.senkouA) confirmations++;      // Still above cloud
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

    // Execute DCA: add 50% of original position size
    const dcaPct = 0.50;
    const oldSize = pos.size;
    const dcaSize = oldSize * dcaPct;
    const dcaNotional = pos.notional * dcaPct;

    if (dcaNotional > state.cash) {
      console.log(`[DCA ${pos.symbol}] Insufficient cash.`);
      return;
    }

    // Calculate new average BEFORE modifying size
    pos.entryPrice = (pos.entryPrice * oldSize + price * dcaSize) / (oldSize + dcaSize);

    state.cash -= dcaNotional;
    pos.notional += dcaNotional;
    pos.size += dcaSize;
    pos.effectiveExposure = pos.notional * pos.leverage;

    // Adjust stop
    const newSlDist = currentAtr * ATR_SL_MULT;
    if (pos.direction === "long") {
      pos.sl = pos.entryPrice - newSlDist;
    } else {
      pos.sl = pos.entryPrice + newSlDist;
    }

    // Recalculate TP levels with new entry
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
    pos.dcaPrice   = price;
    pos.dcaDate    = new Date().toISOString();

    console.log(`📉 [${pos.symbol}] DCA +50% @$${price.toFixed(6)} | New avg:$${pos.entryPrice.toFixed(6)} | New SL:$${pos.sl.toFixed(6)} | Margin:$${pos.notional.toFixed(2)}`);

    await notifyTrade("DCA", {
      symbol: pos.symbol, direction: pos.direction,
      price, entryPrice: pos.entryPrice, notional: pos.notional
    }, state, env);

  } catch (err) {
    console.error(`[DCA ${pos.symbol}]`, err.message);
  }
}
function closePosition(symbol, price, reason, pos, state, journal) {
  const rawPnl    = pos.direction === "long" ? (price - pos.entryPrice) * pos.size : (pos.entryPrice - price) * pos.size;
  const clampPnl  = Math.max(rawPnl, -pos.notional);
  const pnlPct    = pos.notional > 0 ? (clampPnl / pos.notional) * 100 : 0;
  const holdHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;

  state.cash += pos.notional + clampPnl;

  state.trades.push({
    symbol, direction: pos.direction,
    entryPrice: pos.entryPrice, exitPrice: price,
    size: pos.size, leverage: pos.leverage, notional: pos.notional,
    pnl: parseFloat(clampPnl.toFixed(6)),
    pnlPct: parseFloat(pnlPct.toFixed(2)),
    reason, openedAt: pos.openedAt, closedAt: new Date().toISOString(),
    setupType: pos.setupType || "unknown",
    approvalType: pos.approvalType || "unknown",
    reasons: [...(pos.reasons || [])],
    signalSet: [...(pos.signalSet || [])],
    holdHours: parseFloat(holdHours.toFixed(2)),
    score: pos.score, atrVal: pos.atrVal, riskReward: pos.riskReward,
    journal: journal || null, wasLiquidated: rawPnl <= -pos.notional
  });

  updateCoinHistory(state, symbol, {
    direction: pos.direction,
    pnl:       clampPnl,
    pnlPct:    pnlPct,
    reasons:   pos.reasons,
    reason:    reason
  });

  // UPGRADE 3
  const tradeRecord = state.trades[state.trades.length - 1];
  updateRegimeStats(state, tradeRecord);
  delete state.positions[symbol];
  updateDynamicWeights(state);

  const icon = clampPnl >= 0 ? "✅" : "❌";
  console.log(`${icon} [${symbol}] CLOSE ${pos.direction.toUpperCase()} @$${price.toFixed(6)} | PnL:$${clampPnl.toFixed(2)} (${pnlPct.toFixed(1)}%) | ${reason}${rawPnl <= -pos.notional ? " ⚠LIQUIDATED" : ""}`);
}


// =============================================================================
// REGIME DETECTION
// =============================================================================
function detectRegime(dailyCandles, state) {
  const closes = dailyCandles.map(c => c.close);
  const n      = closes.length;

  // PI Cycle
  const ma111 = sma(closes, 111);
  const ma350 = sma(closes, 350);
  const piCycle = (() => {
    const m111 = ma111[n - 1];
    const m350x2 = ma350[n - 1] != null ? ma350[n - 1] * 2 : null;
    if (!m111 || !m350x2) return "unknown";
    const r = m111 / m350x2;
    if (r >= 0.98) return "top";
    if (r >= 0.90) return "late_bull";
    return "bull";
  })();

  // Returns
  const returns = [];
  for (let i = 1; i < n; i++) returns.push(Math.log(closes[i] / closes[i - 1]));

  // HMM
  const hmmParams = state.hmmParams || initHMMParams(returns);
  const { hmmState, updatedParams } = viterbiHMM(returns, hmmParams);
  state.hmmParams = updatedParams;
  const hmmLabel = hmmState === 0 ? "bull" : "bear";

  // Markov
  const mc = state.markovChain || { transitions: [[0.8, 0.2], [0.2, 0.8]] };
  updateMarkovChain(mc, returns);
  state.markovChain = mc;
  const markovProb = mc.transitions[hmmState === 0 ? 0 : 1][0];

  // Sideways
  const recent = closes.slice(-14);
  const rangeR = (Math.max(...recent) - Math.min(...recent)) / Math.min(...recent);
  const sideways = rangeR < 0.10;

  // Vote
  let bull = 0, bear = 0;
  if (hmmLabel === "bull") bull++; else bear++;
  if (piCycle === "bull" || piCycle === "late_bull") bull++; else bear++;
  if (markovProb > 0.5) bull++; else bear++;

  let label;
  if (sideways) label = "sideways";
  else if (bull >= 2) label = "bull";
  else label = "bear";

  return { label, hmmState, hmmLabel, markovProb, piCycle };
}

function initHMMParams(returns) {
  const sorted = [...returns].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return {
    means: [mean(sorted.slice(mid)), mean(sorted.slice(0, mid))],
    stds:  [Math.max(std(sorted.slice(mid)), 0.001), Math.max(std(sorted.slice(0, mid)), 0.001)],
    trans: [[0.95, 0.05], [0.10, 0.90]],
    pi:    [0.7, 0.3]
  };
}

function viterbiHMM(observations, params) {
  const T = observations.length, K = 2;
  const vit  = Array.from({ length: T }, () => new Array(K).fill(-Infinity));
  const back = Array.from({ length: T }, () => new Array(K).fill(0));

  for (let s = 0; s < K; s++) {
    vit[0][s] = Math.log(params.pi[s] + 1e-300) + logGaussian(observations[0], params.means[s], params.stds[s]);
  }
  for (let t = 1; t < T; t++) {
    for (let s = 0; s < K; s++) {
      let best = -Infinity, bp = 0;
      for (let p = 0; p < K; p++) {
        const v = vit[t - 1][p] + Math.log(params.trans[p][s] + 1e-300);
        if (v > best) { best = v; bp = p; }
      }
      vit[t][s] = best + logGaussian(observations[t], params.means[s], params.stds[s]);
      back[t][s] = bp;
    }
  }

  let last = vit[T - 1][0] > vit[T - 1][1] ? 0 : 1;
  const path = [last];
  for (let t = T - 1; t > 0; t--) { last = back[t][last]; path.unshift(last); }

  const up = { ...params, means: [...params.means], stds: [...params.stds] };
  for (let s = 0; s < K; s++) {
    const obs = observations.filter((_, i) => path[i] === s);
    if (obs.length > 5) { up.means[s] = mean(obs); up.stds[s] = Math.max(std(obs), 0.001); }
  }
  return { hmmState: path[T - 1], updatedParams: up };
}

function updateMarkovChain(mc, returns) {
  const win = returns.slice(-90);
  const cnt = [[0, 0], [0, 0]];
  for (let i = 1; i < win.length; i++) {
    const p = win[i - 1] >= 0 ? 0 : 1;
    const c = win[i] >= 0 ? 0 : 1;
    cnt[p][c]++;
  }
  for (let s = 0; s < 2; s++) {
    const t = cnt[s][0] + cnt[s][1];
    if (t > 0) { mc.transitions[s][0] = cnt[s][0] / t; mc.transitions[s][1] = cnt[s][1] / t; }
  }
}

// =============================================================================
// TECHNICAL INDICATORS
// =============================================================================
function sma(data, period) {
  return data.map((_, i) => i < period - 1 ? null : data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
}

function ema(data, period) {
  if (!data.length) return [];
  const r = [data[0]], m = 2 / (period + 1);
  for (let i = 1; i < data.length; i++) r.push((data[i] - r[i - 1]) * m + r[i - 1]);
  return r;
}

function atr(highs, lows, closes, period = 14) {
  const trs = highs.map((h, i) => i === 0 ? h - lows[i] : Math.max(h - lows[i], Math.abs(h - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  const s = sma(trs, period).filter(v => v !== null);
  return s.length > 0 ? s[s.length - 1] : (highs[highs.length - 1] - lows[lows.length - 1]);
}

function rsiSeries(closes, period = 14) {
  const n = closes.length;
  const result = new Array(n).fill(50);
  if (n < period + 1) return result;
  const ch = closes.map((c, i) => i === 0 ? 0 : c - closes[i - 1]);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { if (ch[i] > 0) ag += ch[i]; else al -= ch[i]; }
  ag /= period; al /= period;
  result[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < n; i++) {
    ag = (ag * (period - 1) + Math.max(ch[i], 0)) / period;
    al = (al * (period - 1) + Math.max(-ch[i], 0)) / period;
    result[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return result;
}

function gaussianSmooth(data, sigma = 3) {
  const size = Math.ceil(sigma * 3) * 2 + 1;
  const half = Math.floor(size / 2);
  const kernel = [];
  let ks = 0;
  for (let i = 0; i < size; i++) {
    const w = Math.exp(-((i - half) ** 2) / (2 * sigma * sigma));
    kernel.push(w);
    ks += w;
  }
  const normK = kernel.map(w => w / ks);
  return data.map((_, i) => {
    let val = 0;
    for (let k = 0; k < size; k++) {
      const di = Math.max(0, Math.min(data.length - 1, i - half + k));
      val += data[di] * normK[k];
    }
    return val;
  });
}

function ichimoku(highs, lows, closes) {
  const n = closes.length;
  const midpoint = (period, endIdx) => {
    const start = Math.max(0, endIdx - period + 1);
    const h = Math.max(...highs.slice(start, endIdx + 1));
    const l = Math.min(...lows.slice(start, endIdx + 1));
    return (h + l) / 2;
  };

  const tenkan = midpoint(9, n - 1);
  const kijun  = midpoint(26, n - 1);

  const displaced = n - 1 - 26;
  const senkouA = displaced >= 26
    ? (midpoint(9, displaced) + midpoint(26, displaced)) / 2
    : (tenkan + kijun) / 2;
  const senkouB = displaced >= 52
    ? midpoint(52, displaced)
    : midpoint(52, n - 1);

  const chikouCompare = n > 26 ? closes[n - 27] : closes[0];

  return {
    tenkan, kijun, senkouA, senkouB,
    chikou: closes[n - 1],
    chikouCompare,
    cloudThickness: Math.abs(senkouA - senkouB),
    tkCross: tenkan - kijun,
    futureSenkouA: (tenkan + kijun) / 2,
    futureSenkouB: midpoint(52, n - 1)
  };
}

function obv(closes, volumes) {
  const result = [volumes[0]];
  for (let i = 1; i < closes.length; i++) {
    const prev = result[i - 1];
    if (closes[i] > closes[i - 1])      result.push(prev + volumes[i]);
    else if (closes[i] < closes[i - 1]) result.push(prev - volumes[i]);
    else                                  result.push(prev);
  }
  return result;
}

function findSwingPoints(data, type, order = 3) {
  const points = [];
  for (let i = order; i < data.length - order; i++) {
    const window = data.slice(i - order, i + order + 1);
    if (type === "low" && data[i] === Math.min(...window)) {
      points.push({ index: i, value: data[i] });
    }
    if (type === "high" && data[i] === Math.max(...window)) {
      points.push({ index: i, value: data[i] });
    }
  }
  return points;
}

function detectRSIDivergence(closes, rsiArr, lookback = 20) {
  const n = closes.length;
  if (n < lookback) return { type: "none", strength: 0 };

  const priceSlice = closes.slice(n - lookback);
  const rsiSlice = rsiArr.slice(n - lookback);

  const priceLows = findSwingPoints(priceSlice, "low", 2);
  const priceHighs = findSwingPoints(priceSlice, "high", 2);
  const rsiLows = findSwingPoints(rsiSlice, "low", 2);
  const rsiHighs = findSwingPoints(rsiSlice, "high", 2);

  // Bullish: price lower low + RSI higher low
  if (priceLows.length >= 2 && rsiLows.length >= 2) {
    const pLL = priceLows[priceLows.length - 1].value < priceLows[priceLows.length - 2].value;
    const rHL = rsiLows[rsiLows.length - 1].value > rsiLows[rsiLows.length - 2].value;
    if (pLL && rHL) {
      return { type: "bullish", strength: Math.abs(rsiLows[rsiLows.length - 1].value - rsiLows[rsiLows.length - 2].value) };
    }
  }

  // Bearish: price higher high + RSI lower high
  if (priceHighs.length >= 2 && rsiHighs.length >= 2) {
    const pHH = priceHighs[priceHighs.length - 1].value > priceHighs[priceHighs.length - 2].value;
    const rLH = rsiHighs[rsiHighs.length - 1].value < rsiHighs[rsiHighs.length - 2].value;
    if (pHH && rLH) {
      return { type: "bearish", strength: Math.abs(rsiHighs[rsiHighs.length - 2].value - rsiHighs[rsiHighs.length - 1].value) };
    }
  }

  return { type: "none", strength: 0 };
}

function emaRibbon(closes) {
  const periods = [8, 13, 21, 34, 55];
  const emas = periods.map(p => ema(closes, p));
  const n = closes.length;
  const last = emas.map(e => e[n - 1]);

  // Check if all EMAs are in order (bullish: 8 > 13 > 21 > 34 > 55)
  let bullishOrder = true;
  let bearishOrder = true;
  for (let i = 0; i < last.length - 1; i++) {
    if (last[i] <= last[i + 1]) bullishOrder = false;
    if (last[i] >= last[i + 1]) bearishOrder = false;
  }

  // Ribbon width (spread between fastest and slowest EMA)
  const width = last.length >= 2
    ? Math.abs(last[0] - last[last.length - 1]) / closes[n - 1]
    : 0;

  // Expanding or contracting
  const prevLast = emas.map(e => e[n - 2]);
  const prevWidth = prevLast.length >= 2
    ? Math.abs(prevLast[0] - prevLast[prevLast.length - 1]) / closes[n - 2]
    : 0;
  const expanding = width > prevWidth;

  return {
    bullishAligned: bullishOrder,
    bearishAligned: bearishOrder,
    width,
    expanding,
    priceAboveAll: closes[n - 1] > Math.max(...last),
    priceBelowAll: closes[n - 1] < Math.min(...last)
  };
}

function detectOBVDivergence(closes, obvSeries, lookback = 30) {
  const n = closes.length;
  if (n < lookback) return { type: "none", strength: 0 };

  const priceSlice = closes.slice(n - lookback);
  const obvSlice   = obvSeries.slice(n - lookback);

  const priceLows  = findSwingPoints(priceSlice, "low");
  const priceHighs = findSwingPoints(priceSlice, "high");
  const obvLows    = findSwingPoints(obvSlice, "low");
  const obvHighs   = findSwingPoints(obvSlice, "high");

  if (priceLows.length >= 2 && obvLows.length >= 2) {
    const pLL = priceLows[priceLows.length - 1].value < priceLows[priceLows.length - 2].value;
    const oHL = obvLows[obvLows.length - 1].value > obvLows[obvLows.length - 2].value;
    if (pLL && oHL) {
      const strength = Math.abs(
        (obvLows[obvLows.length - 1].value - obvLows[obvLows.length - 2].value) /
        (Math.abs(obvLows[obvLows.length - 2].value) + 1)
      );
      return { type: "bullish", strength: Math.min(strength * 100, 10) };
    }
  }

  if (priceHighs.length >= 2 && obvHighs.length >= 2) {
    const pHH = priceHighs[priceHighs.length - 1].value > priceHighs[priceHighs.length - 2].value;
    const oLH = obvHighs[obvHighs.length - 1].value < obvHighs[obvHighs.length - 2].value;
    if (pHH && oLH) {
      const strength = Math.abs(
        (obvHighs[obvHighs.length - 2].value - obvHighs[obvHighs.length - 1].value) /
        (Math.abs(obvHighs[obvHighs.length - 2].value) + 1)
      );
      return { type: "bearish", strength: Math.min(strength * 100, 10) };
    }
  }

  return { type: "none", strength: 0 };
}

function fisher(highs, lows, period = 10) {
  const n = highs.length;
  const result = new Array(n).fill(0);
  let prevF = 0;
  for (let i = period - 1; i < n; i++) {
    const hh = Math.max(...highs.slice(i - period + 1, i + 1));
    const ll = Math.min(...lows.slice(i - period + 1, i + 1));
    const range = hh - ll;
    let val = range > 0 ? 2 * ((highs[i] + lows[i]) / 2 - ll) / range - 1 : 0;
    val = Math.max(-0.999, Math.min(0.999, val));
    prevF = 0.5 * Math.log((1 + val) / (1 - val)) + 0.5 * prevF;
    result[i] = prevF;
  }
  return result;
}

function vwap(highs, lows, closes, volumes, windowSize = 24) {
  const n = closes.length;
  let sumPV = 0, sumV = 0;
  for (let i = Math.max(0, n - windowSize); i < n; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    sumPV += tp * volumes[i];
    sumV += volumes[i];
  }
  return sumV > 0 ? sumPV / sumV : closes[n - 1];
}

function volumeProfile(closes, volumes, bins = 20) {
  const minP = Math.min(...closes);
  const maxP = Math.max(...closes);
  const step = (maxP - minP) / bins || 1;
  const profile = Array.from({ length: bins }, (_, i) => ({
    low: minP + i * step, high: minP + (i + 1) * step, volume: 0
  }));
  for (let i = 0; i < closes.length; i++) {
    const bin = Math.min(Math.floor((closes[i] - minP) / step), bins - 1);
    if (bin >= 0) profile[bin].volume += volumes[i];
  }
  const avg = profile.reduce((s, b) => s + b.volume, 0) / bins;
  return { profile, highVolumeNodes: profile.filter(b => b.volume >= avg * 1.5) };
}

function findSupportResistance(highs, lows, lookback = 50) {
  const n = highs.length;
  const supports = [], resistances = [];
  for (let i = 2; i < Math.min(lookback, n - 2); i++) {
    const idx = n - 1 - i;
    if (idx < 2 || idx >= n - 2) continue;
    if (lows[idx] < lows[idx - 1] && lows[idx] < lows[idx + 1] &&
        lows[idx] < lows[idx - 2] && lows[idx] < lows[idx + 2]) supports.push(lows[idx]);
    if (highs[idx] > highs[idx - 1] && highs[idx] > highs[idx + 1] &&
        highs[idx] > highs[idx - 2] && highs[idx] > highs[idx + 2]) resistances.push(highs[idx]);
  }
  return { supports, resistances };
}

// =============================================================================
// STRUCTURE-AWARE SL/TP PLACEMENT
// Places SL below nearest support (longs) or above resistance (shorts)
// Places TP at nearest resistance (longs) or support (shorts)
// Falls back to ATR-based if no structure found
// =============================================================================

function calculateStructuredSLTP(signal, price, atrVal, highs, lows, closes, volumes) {
  const n = closes.length;

  // Get support/resistance levels
  const sr = findSupportResistance(highs, lows, 80);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const ema20Val = ema(closes, 20);
  const bb = bollingerBands(closes, 20, 2);
  const vpvr = volumeProfile(closes, volumes, 30);

  // Current MAs
  const currentMA50 = ma50[n - 1];
  const currentMA200 = ma200[n - 1];
  const currentEMA20 = ema20Val[n - 1];
  const currentBBUpper = bb.upper[n - 1];
  const currentBBLower = bb.lower[n - 1];

  // Collect all support levels (below price for longs, above for shorts)
  const supportLevels = [];
  const resistanceLevels = [];

  // S/R from swing points
  for (const s of sr.supports) supportLevels.push({ price: s, type: "swing-support", strength: 1.0 });
  for (const r of sr.resistances) resistanceLevels.push({ price: r, type: "swing-resistance", strength: 1.0 });

  // MA levels as dynamic S/R
  if (currentMA50) {
    if (currentMA50 < price) supportLevels.push({ price: currentMA50, type: "MA50", strength: 1.2 });
    else resistanceLevels.push({ price: currentMA50, type: "MA50", strength: 1.2 });
  }
  if (currentMA200) {
    if (currentMA200 < price) supportLevels.push({ price: currentMA200, type: "MA200", strength: 1.5 });
    else resistanceLevels.push({ price: currentMA200, type: "MA200", strength: 1.5 });
  }
  if (currentEMA20) {
    if (currentEMA20 < price) supportLevels.push({ price: currentEMA20, type: "EMA20", strength: 0.8 });
    else resistanceLevels.push({ price: currentEMA20, type: "EMA20", strength: 0.8 });
  }

  // Bollinger Bands as S/R
  if (currentBBLower) supportLevels.push({ price: currentBBLower, type: "BB-lower", strength: 0.7 });
  if (currentBBUpper) resistanceLevels.push({ price: currentBBUpper, type: "BB-upper", strength: 0.7 });

  // VPVR high volume nodes as S/R
  for (const node of vpvr.highVolumeNodes) {
    const nodeCenter = (node.low + node.high) / 2;
    if (nodeCenter < price) supportLevels.push({ price: node.high, type: "HVN-top", strength: 1.3 });
    if (nodeCenter > price) resistanceLevels.push({ price: node.low, type: "HVN-bottom", strength: 1.3 });
  }

  // Sort: supports descending (nearest to price first), resistances ascending
  supportLevels.sort((a, b) => b.price - a.price);
  resistanceLevels.sort((a, b) => a.price - b.price);

  // ATR-based defaults
  const atrSL = signal === "long" ? price - atrVal * ATR_SL_MULT : price + atrVal * ATR_SL_MULT;
  const atrTP = signal === "long" ? price + atrVal * ATR_TP_MULT : price - atrVal * ATR_TP_MULT;

  let sl, tp, slType, tpType;

  if (signal === "long") {
    // SL: Find nearest support below price, place SL just below it
    const nearestSupport = supportLevels.find(s =>
      s.price < price &&
      s.price > price * 0.95 &&  // Within 5% — don't use distant supports
      (price - s.price) > atrVal * 0.3  // At least 0.3 ATR away — not too tight
    );

    if (nearestSupport) {
      // Place SL 0.3×ATR below the support level (buffer for wicks)
      const structureSL = nearestSupport.price - atrVal * 0.3;
      // Use structure SL only if it's tighter than 3×ATR (don't allow huge stops)
      if ((price - structureSL) <= atrVal * 3.0) {
        sl = structureSL;
        slType = `below-${nearestSupport.type}@${nearestSupport.price.toFixed(6)}`;
      } else {
        sl = atrSL;
        slType = "atr-default(structure-too-far)";
      }
    } else {
      sl = atrSL;
      slType = "atr-default(no-support)";
    }

    // TP: Find nearest resistance above price
    const nearestResistance = resistanceLevels.find(r =>
      r.price > price &&
      r.price < price * 1.10 &&  // Within 10%
      (r.price - price) > atrVal * 1.0  // At least 1 ATR away — worth the trade
    );

    if (nearestResistance) {
      // Place TP just below the resistance (take profit before rejection)
      tp = nearestResistance.price - atrVal * 0.2;
      tpType = `below-${nearestResistance.type}@${nearestResistance.price.toFixed(6)}`;
    } else {
      tp = atrTP;
      tpType = "atr-default(no-resistance)";
    }

  } else {
    // SHORT — mirror logic
    // SL: Find nearest resistance above price
    const nearestResistance = resistanceLevels.find(r =>
      r.price > price &&
      r.price < price * 1.05 &&
      (r.price - price) > atrVal * 0.3
    );

    if (nearestResistance) {
      sl = nearestResistance.price + atrVal * 0.3;
      slType = `above-${nearestResistance.type}@${nearestResistance.price.toFixed(6)}`;
      if ((sl - price) > atrVal * 3.0) {
        sl = atrSL;
        slType = "atr-default(structure-too-far)";
      }
    } else {
      sl = atrSL;
      slType = "atr-default(no-resistance)";
    }

    // TP: Find nearest support below price
    const nearestSupport = supportLevels.find(s =>
      s.price < price &&
      s.price > price * 0.90 &&
      (price - s.price) > atrVal * 1.0
    );

    if (nearestSupport) {
      tp = nearestSupport.price + atrVal * 0.2;
      tpType = `above-${nearestSupport.type}@${nearestSupport.price.toFixed(6)}`;
    } else {
      tp = atrTP;
      tpType = "atr-default(no-support)";
    }
  }

  // Risk:Reward check — reject if R:R < 1.5
  const risk = Math.abs(price - sl);
  const reward = Math.abs(tp - price);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < 1.5) {
    // Fall back to ATR-based which guarantees 2:1
    sl = atrSL;
    tp = atrTP;
    slType = "atr-fallback(rr-too-low)";
    tpType = "atr-fallback(rr-too-low)";
  }

  return {
    sl, tp, slType, tpType,
    riskReward: risk > 0 ? parseFloat((reward / risk).toFixed(2)) : 0,
    supportLevelsFound: supportLevels.length,
    resistanceLevelsFound: resistanceLevels.length
  };
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) {
    return { macd: 0, signal: 0, histogram: 0, crossUp: false, crossDown: false, diverging: false };
  }
  const emaFast    = ema(closes, fast);
  const emaSlow    = ema(closes, slow);
  const macdLine   = emaFast.map((f, i) => f - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const histogram  = macdLine.map((m, i) => m - signalLine[i]);
  const n = closes.length;
  return {
    macd:      macdLine[n - 1],
    signal:    signalLine[n - 1],
    histogram: histogram[n - 1],
    crossUp:   n >= 2 && histogram[n - 1] > 0 && histogram[n - 2] <= 0,
    crossDown: n >= 2 && histogram[n - 1] < 0 && histogram[n - 2] >= 0,
    diverging: n >= 2 && Math.abs(histogram[n - 1]) > Math.abs(histogram[n - 2])
  };
}

function bollingerBands(closes, period = 20, stdDev = 2) {
  const n = closes.length;
  const smaVals = sma(closes, period);
  const result = { upper: [], middle: [], lower: [], width: [], pctB: [] };
  for (let i = 0; i < n; i++) {
    if (smaVals[i] === null) {
      result.upper.push(null); result.middle.push(null);
      result.lower.push(null); result.width.push(null);
      result.pctB.push(null);
      continue;
    }
    const slice = closes.slice(Math.max(0, i - period + 1), i + 1);
    const sd    = std(slice);
    const upper = smaVals[i] + stdDev * sd;
    const lower = smaVals[i] - stdDev * sd;
    result.upper.push(upper);
    result.middle.push(smaVals[i]);
    result.lower.push(lower);
    result.width.push(smaVals[i] > 0 ? (upper - lower) / smaVals[i] : 0);
    result.pctB.push(upper !== lower ? (closes[i] - lower) / (upper - lower) : 0.5);
  }
  return result;
}

function stochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiArr = rsiSeries(closes, rsiPeriod);
  const n = rsiArr.length;
  const stochK = new Array(n).fill(50);
  const stochD = new Array(n).fill(50);

  for (let i = stochPeriod - 1; i < n; i++) {
    const window = rsiArr.slice(i - stochPeriod + 1, i + 1);
    const minRSI = Math.min(...window);
    const maxRSI = Math.max(...window);
    stochK[i] = maxRSI !== minRSI
      ? ((rsiArr[i] - minRSI) / (maxRSI - minRSI)) * 100
      : 50;
  }

  // Smooth K
  const smoothK = sma(stochK, kSmooth);
  // D is SMA of smoothed K
  const dLine = sma(smoothK.map(v => v ?? 50), dSmooth);

  return {
    k: smoothK[n - 1] ?? 50,
    d: dLine[n - 1] ?? 50,
    prevK: smoothK[n - 2] ?? 50,
    prevD: dLine[n - 2] ?? 50,
    crossUp: (smoothK[n - 1] ?? 0) > (dLine[n - 1] ?? 0) && (smoothK[n - 2] ?? 0) <= (dLine[n - 2] ?? 0),
    crossDown: (smoothK[n - 1] ?? 0) < (dLine[n - 1] ?? 0) && (smoothK[n - 2] ?? 0) >= (dLine[n - 2] ?? 0),
    oversold: (smoothK[n - 1] ?? 50) < 20,
    overbought: (smoothK[n - 1] ?? 50) > 80
  };
}

function adx(highs, lows, closes, period = 14) {
  const n = highs.length;
  if (n < period * 2 + 1) return { adx: 25, pdi: 0, mdi: 0, trending: false, strongTrend: false };

  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    const up   = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  const smooth = (arr, p) => {
    if (arr.length < p) return [0];
    const r = [arr.slice(0, p).reduce((a, b) => a + b, 0)];
    for (let i = p; i < arr.length; i++) r.push(r[r.length - 1] - r[r.length - 1] / p + arr[i]);
    return r;
  };

  const sTR  = smooth(tr, period);
  const sPDM = smooth(plusDM, period);
  const sMDM = smooth(minusDM, period);

  const pdi = sPDM.map((v, i) => sTR[i] > 0 ? (v / sTR[i]) * 100 : 0);
  const mdi = sMDM.map((v, i) => sTR[i] > 0 ? (v / sTR[i]) * 100 : 0);
  const dx  = pdi.map((p, i) => (p + mdi[i]) > 0 ? Math.abs(p - mdi[i]) / (p + mdi[i]) * 100 : 0);

  const adxS = smooth(dx, period);
  const last = adxS.length > 0 ? adxS[adxS.length - 1] / period : 25;

  return {
    adx: last,
    pdi: pdi.length > 0 ? pdi[pdi.length - 1] : 0,
    mdi: mdi.length > 0 ? mdi[mdi.length - 1] : 0,
    trending: last > 25,
    strongTrend: last > 40
  };
}

function volumeConfirmation(volumes, lookback = 20) {
  const n   = volumes.length;
  const avg = volumes.slice(Math.max(0, n - lookback), n).reduce((a, b) => a + b, 0) / Math.min(lookback, n);
  const cur = volumes[n - 1];
  const r   = avg > 0 ? cur / avg : 1;
  return {
    ratio: r,
    isAboveAverage: r > 1.0,
    isSignificant: r > 1.5,
    isClimax: r > 3.0,
    score: r > 2.0 ? 2 : r > 1.2 ? 1 : 0
  };
}

function fundingRateSignal(rate) {
  if (rate === null || rate === undefined) return { signal: "neutral", score: 0, reason: "" };
  if (rate > 0.003)  return { signal: "short", score: 2, reason: "funding-extreme-long" };
  if (rate > 0.001)  return { signal: "short", score: 1, reason: "funding-crowded-long" };
  if (rate < -0.003) return { signal: "long",  score: 2, reason: "funding-extreme-short" };
  if (rate < -0.001) return { signal: "long",  score: 1, reason: "funding-crowded-short" };
  return { signal: "neutral", score: 0, reason: "" };
}

// =============================================================================
// OKX API
// =============================================================================
async function fetchAllContracts() {
  try {
    const data = await fetchWithRetry(`${API_BASE}/api/v5/public/instruments?instType=SWAP`);
    if (!data?.data) return null;
    return data.data
      .filter(c => c.state === "live" && c.settleCcy === "USDT" && c.ctType === "linear")
      .map(c => c.instId); // e.g. "BTC-USDT-SWAP"
  } catch (err) {
    console.error("[API] contracts:", err.message);
    return null;
  }
}

async function fetchAllTickers() {
  try {
    const data = await fetchWithRetry(`${API_BASE}/api/v5/market/tickers?instType=SWAP`);
    if (!data?.data) return null;
    return data.data
      .filter(t => t.instId.endsWith("-USDT-SWAP"))
      .map(t => ({
        contract: t.instId,
        volume_24h_quote: parseFloat(t.volCcy24h || 0),
        last: parseFloat(t.last || 0)
      }));
  } catch (err) {
    console.error("[API] tickers:", err.message);
    return null;
  }
}

async function fetchCandles(symbol, interval, limit = 200) {
  try {
    const intervalMap = { "1h": "1H", "4h": "4H", "1d": "1D", "15m": "15m" };
    const okxInterval = intervalMap[interval] || "1H";
    const raw = await fetchWithRetry(
      `${API_BASE}/api/v5/market/candles?instId=${symbol}&bar=${okxInterval}&limit=${limit}`
    );
    if (!raw?.data || raw.data.length === 0) return null;
    return raw.data.map(c => ({
      time:   parseInt(c[0]),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5])
    })).sort((a, b) => a.time - b.time);
  } catch (err) {
    return null;
  }
}

async function fetchFundingRate(symbol) {
  try {
    const data = await fetchWithRetry(
      `${API_BASE}/api/v5/public/funding-rate-history?instId=${symbol}&limit=1`
    );
    if (!data?.data?.[0]) return null;
    return parseFloat(data.data[0].fundingRate);
  } catch (_) {
    return null;
  }
}

async function fetchWithRetry(url, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.status === 429) {
        await sleep(Math.pow(2, attempt) * 500);
        continue;
      }
      if (!res.ok) {
        if (attempt < retries) { await sleep(500 * attempt); continue; }
        return null;
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) return null;
      await sleep(500 * attempt);
    }
  }
  return null;
}

// =============================================================================
// CLAUDE API — BUDGET GUARDED
// =============================================================================
function estimateMonthlySpend(usage) {
  if (!usage) return 0;
  return ((usage.input || 0) / 1_000_000) * INPUT_COST_PER_MTOK +
         ((usage.output || 0) / 1_000_000) * OUTPUT_COST_PER_MTOK;
}

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

// =============================================================================
// MATH
// =============================================================================
function mean(arr) { return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) { if (arr.length < 2) return 0; const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }
function logGaussian(x, mu, sigma) { if (sigma <= 0) sigma = 1e-6; return -0.5 * Math.log(2 * Math.PI * sigma * sigma) - (x - mu) ** 2 / (2 * sigma * sigma); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export {
  fetchAllTickers,
  estimateMonthlySpend,
  PAPER_CASH,
  MONTHLY_BUDGET_USD,
  runBot,
  sendDailyReport,
  sendWeeklyReview,
  premarketScan,
  reevaluatePositions
};

