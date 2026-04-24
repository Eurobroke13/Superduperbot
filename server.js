import express from "express";
import { initDb } from "./db.js";
import { loadState } from "./state-store.js";
import { runBot } from "./bot.js";

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
