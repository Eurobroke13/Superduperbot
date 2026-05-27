// Run once on the production server: node reset-sideways-stats.js
// Requires DATABASE_URL env var. Resets regimeStats.sideways to zero so
// count < 15 triggers the default sideways bump (ENTRY_THRESHOLD + 0.5)
// instead of a stale performance-adjusted value.
import { loadState, saveState } from "./state-store.js";

const state = await loadState();

const before = state.regimeStats?.sideways ?? "(missing)";
console.log("[RESET] regimeStats.sideways before:", JSON.stringify(before));

if (!state.regimeStats) state.regimeStats = {};
state.regimeStats.sideways = { wins: 0, losses: 0, totalPnl: 0, count: 0 };

console.log("[RESET] regimeStats.sideways after: ", JSON.stringify(state.regimeStats.sideways));

await saveState(state);
console.log("[RESET] ✅ Done — sideways regime stats cleared.");
process.exit(0);
