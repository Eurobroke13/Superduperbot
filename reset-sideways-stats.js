// Run once on the production server: node reset-sideways-stats.js
// Clears all sideways-specific learned data so the bot falls back to
// overall dynamicWeights and the default ENTRY_THRESHOLD + 0.5 bump.
import { loadState, saveState } from "./state-store.js";

const state = await loadState();

// ── regimeStats.sideways ──────────────────────────────────────────────────────
const rsBefore = state.regimeStats?.sideways ?? "(missing)";
console.log("[RESET] regimeStats.sideways before:", JSON.stringify(rsBefore));
if (!state.regimeStats) state.regimeStats = {};
state.regimeStats.sideways = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
console.log("[RESET] regimeStats.sideways after: ", JSON.stringify(state.regimeStats.sideways));

// ── signalStats :sideways keys ────────────────────────────────────────────────
const sidewaysKeys = Object.keys(state.signalStats || {}).filter(k => k.endsWith(":sideways"));
console.log(`[RESET] signalStats sideways keys found: ${sidewaysKeys.length}`);
for (const key of sidewaysKeys) {
  delete state.signalStats[key];
}
console.log(`[RESET] signalStats sideways keys cleared: ${sidewaysKeys.length}`);

await saveState(state);
console.log("[RESET] ✅ Done — sideways regime and signal stats cleared.");
process.exit(0);
