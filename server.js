import express from "express";
import { initDb } from "./db.js";
import { loadState } from "./state-store.js";
import {
  fetchAllTickers,
  estimateMonthlySpend,
  MONTHLY_BUDGET_USD,
  PAPER_CASH,
  runBot
} from "./bot.js";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (_, res) => res.send("Live"));

app.get("/health", async (_, res) => {
  try {
    await initDb();
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    console.error("[health]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/state", async (_, res) => {
  try {
    const state = await loadState();
    res.json(state);
  } catch (error) {
    console.error("[state]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/pnl", async (_, res) => {
  try {
    const state = await loadState();
    const tickers = await fetchAllTickers();
    const priceMap = {};

    if (tickers) {
      for (const ticker of tickers) {
        priceMap[ticker.contract] = ticker.last;
      }
    }

    let totalUnrealized = 0;
    const positions = Object.values(state.positions || {});

    let text = "=== PORTFOLIO ===\n";
    text += `Cash: $${(state.cash || 0).toFixed(2)}\n`;
    text += `Regime: ${state.lastRegime?.label || "unknown"}\n\n`;

    if (positions.length === 0) {
      text += "No open positions.\n";
    } else {
      text += `=== ${positions.length} OPEN POSITIONS ===\n\n`;

      for (const pos of positions) {
        const currentPrice = priceMap[pos.symbol] || pos.entryPrice || 0;
        const rawPnl = pos.direction === "long"
          ? (currentPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - currentPrice) * pos.size;
        const pnl = Math.max(rawPnl, -(pos.notional || 0));
        const pnlPct = pos.notional > 0 ? (pnl / pos.notional) * 100 : 0;
        const hoursOpen = pos.openedAt
          ? ((Date.now() - new Date(pos.openedAt).getTime()) / 3600000).toFixed(1)
          : "?";
        const tranchesFilled = pos.tranches?.plan
          ? [
              pos.tranches.plan.tranche1?.filled,
              pos.tranches.plan.tranche2?.filled,
              pos.tranches.plan.tranche3?.filled
            ].filter(Boolean).length
          : "?";
        const icon = pnl >= 0 ? "PROFIT" : "LOSS";

        totalUnrealized += pnl;

        text += `${icon} ${pos.symbol}\n`;
        text += `   ${String(pos.direction || "").toUpperCase()} ${pos.leverage || "?"}x | Score:${pos.score ?? "?"}\n`;
        text += `   Entry: $${(pos.entryPrice || 0).toFixed(6)}  Now: $${currentPrice.toFixed(6)}\n`;
        text += `   PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)\n`;
        text += `   SL: $${(pos.sl || 0).toFixed(6)}  TP: $${(pos.tp || 0).toFixed(6)}\n`;
        text += `   Margin: $${(pos.notional || 0).toFixed(2)} | Tranches: ${tranchesFilled}/3\n`;
        text += `   DCA: ${pos.dcaApplied ? `yes @ $${(pos.dcaPrice || 0).toFixed(6)}` : "no"}\n`;
        text += `   Open: ${hoursOpen}h\n\n`;
      }
    }

    const totalRealized = (state.trades || []).reduce((sum, trade) => sum + (trade.pnl || 0), 0);
    const reservedMargin = positions.reduce((sum, pos) => sum + (pos.notional || 0), 0);
    const portfolioValue = (state.cash || 0) + reservedMargin + totalUnrealized;
    const wins = (state.trades || []).filter((trade) => (trade.pnl || 0) > 0).length;
    const totalTrades = (state.trades || []).length;
    const claudeSpend = estimateMonthlySpend(state.tokenUsage || { input: 0, output: 0 });

    text += "=== TOTALS ===\n";
    text += `Unrealized PnL: $${totalUnrealized.toFixed(2)}\n`;
    text += `Realized PnL:   $${totalRealized.toFixed(2)}\n`;
    text += `Total PnL:      $${(totalUnrealized + totalRealized).toFixed(2)}\n`;
    text += `Portfolio Value: $${portfolioValue.toFixed(2)}\n`;
    text += `Started:         $${PAPER_CASH.toFixed(2)}\n`;
    text += `Return:          ${(((portfolioValue + totalRealized - PAPER_CASH) / PAPER_CASH) * 100).toFixed(2)}%\n`;
    text += "\n=== STATS ===\n";
    text += `Trades: ${totalTrades} | Wins: ${wins} | WR: ${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "N/A"}%\n`;
    text += `Claude: $${claudeSpend.toFixed(2)}/$${MONTHLY_BUDGET_USD.toFixed(2)}\n`;

    res.type("text/plain").send(text);
  } catch (error) {
    console.error("[pnl]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/run", async (_, res) => {
  try {
    await runBot(process.env);
    const state = await loadState();

    res.json({
      ok: true,
      message: "Bot run completed",
      runCount: state.runCount,
      lastRunAt: state.lastRunAt,
      lastPhase: state.lastPhase,
      openPositions: Object.keys(state.positions || {}).length,
      trades: (state.trades || []).length
    });
  } catch (error) {
    console.error("[run]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
