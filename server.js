import express from "express";
import { initDb } from "./db.js";
import { loadState, saveState } from "./state-store.js";

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
    const state = await loadState();

    state.runCount = (state.runCount || 0) + 1;
    state.lastRunAt = new Date().toISOString();

    await saveState(state);

    res.json({
      ok: true,
      message: "Manual run completed",
      runCount: state.runCount,
      lastRunAt: state.lastRunAt
    });
  } catch (error) {
    console.error("[run]", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
