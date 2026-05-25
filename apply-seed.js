// Run from your production server: node apply-seed.js
// Requires DATABASE_URL env var to be set.
import { readFileSync } from "fs";
import { loadState, saveState } from "./state-store.js";

const patch = JSON.parse(readFileSync("./seed-patch.json", "utf8"));

console.log(`[SEED] Applying patch (${patch.months}m backtest, generated ${patch.generatedAt})`);
const state = await loadState();

// ── Regime stats ─────────────────────────────────────────────────────────────
if (!state.regimeStats) state.regimeStats = {};
let regimeUpdated = 0;
for (const [regime, rs] of Object.entries(patch.regimeStats)) {
  const cur = state.regimeStats[regime];
  if (!cur || cur.count < rs.count) {
    state.regimeStats[regime] = rs;
    regimeUpdated++;
  }
}
console.log(`  ✓ regimeStats: ${regimeUpdated} regimes updated`);

// ── Signal stats ──────────────────────────────────────────────────────────────
if (!state.signalStats) state.signalStats = {};
let sigUpdated = 0;
for (const [sig, ss] of Object.entries(patch.signalStats)) {
  const cur = state.signalStats[sig];
  if (!cur || cur.count < ss.count) {
    state.signalStats[sig] = ss;
    sigUpdated++;
  }
}
console.log(`  ✓ signalStats: ${sigUpdated} signals updated`);

// ── Dynamic weights ───────────────────────────────────────────────────────────
if (!state.dynamicWeights) state.dynamicWeights = {};
let weightUpdated = 0;
for (const [sig, w] of Object.entries(patch.dynamicWeights)) {
  state.dynamicWeights[sig] = w;
  weightUpdated++;
}
state.lastWeightUpdate = Date.now();
console.log(`  ✓ dynamicWeights: ${weightUpdated} weights updated`);

await saveState(state);
console.log("[SEED] ✅ Done — full seed complete, all weights and stats updated in production DB.");
process.exit(0);
