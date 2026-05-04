import { MAX_POSITIONS, MONTHLY_BUDGET_USD } from "./config.js";
import {
  calculatePerformanceMetrics,
  estimateMonthlySpend,
  getApprovalStats,
  getSetupStats
} from "./stats.js";
import { fetchCandles } from "./market-data.js";
import { adx, bollingerBands, rsiSeries } from "./indicators.js";
import { portfolioValue } from "./execution.js";

export async function sendDailyReport(env, deps, options = {}) {
  const {
    loadState,
    saveState,
    sendTelegram,
    callClaudePlaintext
  } = deps;
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
  const currVal = portfolioValue(state);
  const totalPnL = state.trades.reduce((s, t) => s + t.pnl, 0);
  const wins = state.trades.filter(t => t.pnl > 0).length;
  const winRate = state.trades.length > 0 ? ((wins / state.trades.length) * 100).toFixed(1) : "N/A";
  const metrics = calculatePerformanceMetrics(state.trades);
  const spend = estimateMonthlySpend(state.tokenUsage || { input: 0, output: 0 });

  if (recentTrades.length === 0 && openCount === 0) {
    await sendTelegram(
      `📊 Daily (quiet)\nRegime: ${regime?.label ?? "?"} | PI: ${regime?.piCycle ?? "?"}\n` +
      `Value: $${currVal.toFixed(2)} | Cash: $${state.cash.toFixed(2)}\n` +
      `Open: ${openCount}/${MAX_POSITIONS} | Trades: ${state.trades.length}\n` +
      `PnL: $${totalPnL.toFixed(2)} | WR: ${winRate}%\n` +
      `${metrics ? `Sharpe:${metrics.sharpe} PF:${metrics.profitFactor}` : ""}\n` +
      `Claude: $${spend.toFixed(2)}/$${MONTHLY_BUDGET_USD}`,
      env
    );
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
    `${metrics ? `Sharpe:${metrics.sharpe} Sortino:${metrics.sortino} PF:${metrics.profitFactor} Worst single-trade margin loss:${metrics.maxDrawdown}%` : ""}\n` +
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

export async function sendRiskAssessment(env, deps) {
  const {
    loadState,
    saveState,
    sendTelegram,
    callClaudePlaintext
  } = deps;
  const state = await loadState(env);
  const positions = Object.values(state.positions);
  if (positions.length === 0) return;

  const details = [];
  for (const pos of positions) {
    try {
      const candles = await fetchCandles(pos.symbol, "1h", 24);
      if (!candles || candles.length === 0) continue;
      const price = candles[candles.length - 1].close;
      const pnl = pos.direction === "long"
        ? (price - pos.entryPrice) * pos.size
        : (pos.entryPrice - price) * pos.size;
      const pnlPct = pos.notional > 0 ? (pnl / pos.notional) * 100 : 0;
      const hoursOpen = ((Date.now() - new Date(pos.openedAt).getTime()) / 3600000).toFixed(0);
      details.push(`${pos.symbol} ${pos.direction.toUpperCase()} entry:$${pos.entryPrice.toFixed(4)} now:$${price.toFixed(4)} PnL:$${pnl.toFixed(2)}(${pnlPct.toFixed(1)}%) SL:$${pos.sl.toFixed(4)} ${hoursOpen}h`);
    } catch (_) {
      continue;
    }
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

export async function sendWeeklyReview(env, deps) {
  const {
    loadState,
    saveState,
    sendTelegram,
    callClaudePlaintext,
    trackSignalPerformance
  } = deps;
  const state = await loadState(env);
  const weekAgo = Date.now() - 7 * 86400000;
  const weekTrades = state.trades.filter(t => new Date(t.closedAt).getTime() > weekAgo);

  if (weekTrades.length === 0) {
    await sendTelegram("📈 Weekly: No trades this week.", env);
    return;
  }

  const wins = weekTrades.filter(t => t.pnl > 0);
  const losses = weekTrades.filter(t => t.pnl <= 0);
  const totalPnL = weekTrades.reduce((s, t) => s + t.pnl, 0);

  const sigOuts = {};
  for (const t of weekTrades) {
    for (const r of (t.reasons || [])) {
      if (!sigOuts[r]) sigOuts[r] = { w: 0, l: 0, pnl: 0 };
      sigOuts[r].pnl += t.pnl;
      if (t.pnl > 0) sigOuts[r].w++;
      else sigOuts[r].l++;
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

export async function premarketScan(env, deps) {
  const {
    loadState,
    saveState,
    callClaudePlaintext,
    sendTelegram
  } = deps;
  const state = await loadState(env);
  const regime = state.lastRegime;

  const btc = await fetchCandles("BTC-USDT-SWAP", "4h", 50);
  if (!btc || btc.length < 20) return;

  const closes = btc.map(c => c.close);
  const highs = btc.map(c => c.high);
  const lows = btc.map(c => c.low);
  const n = closes.length;
  const price = closes[n - 1];
  const rsiArr = rsiSeries(closes, 14);
  const bb = bollingerBands(closes, 20, 2);
  const adxR = adx(highs, lows, closes, 14);

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

export async function reevaluatePositions(env, deps) {
  const {
    loadState,
    saveState,
    callClaudeBudgeted
  } = deps;
  const state = await loadState(env);
  const positions = Object.values(state.positions);
  if (positions.length === 0) return;

  const details = [];
  for (const pos of positions) {
    try {
      const candles = await fetchCandles(pos.symbol, "1h", 30);
      if (!candles) continue;
      const closes = candles.map(c => c.close);
      const price = closes[closes.length - 1];
      const rsiArr = rsiSeries(closes, 14);
      const pnl = pos.direction === "long" ? (price - pos.entryPrice) * pos.size : (pos.entryPrice - price) * pos.size;
      details.push(`${pos.symbol} ${pos.direction} @${pos.entryPrice.toFixed(4)} now:${price.toFixed(4)} PnL:$${pnl.toFixed(2)} RSI:${rsiArr[closes.length - 1].toFixed(0)} ${((Date.now() - new Date(pos.openedAt).getTime()) / 3600000).toFixed(0)}h`);
    } catch (_) {
      continue;
    }
  }
  if (details.length === 0) return;
  if (!env.ANTHROPIC_API_KEY) return;

  const prompt = `Re-evaluate ${positions.length} positions. JSON: {"SYM_USDT":"hold"or"tighten"or"close"}\nRegime:${state.lastRegime?.label ?? "?"}\n${details.join("\n")}\nJSON only:`;

  try {
    const raw = await callClaudeBudgeted(prompt, env, state, 300);
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
