import test from "node:test";
import assert from "node:assert";
import { getSetupStatsRecent, getAdaptiveSetupDecision, MIN_EFF_RECENT_SETUP } from "../bot/stats.js";

const DAY = 86400000;
const now = Date.now();
const ageDays = (d) => new Date(now - d * DAY).toISOString();

// Helper: build N trades of a setup at a given age with a given win flag.
function trades(setupType, specs) {
  return specs.map(([d, pnl]) => ({ setupType, pnl, closedAt: ageDays(d) }));
}

test("getSetupStatsRecent: recent trades dominate the decayed WR", () => {
  // 10 old losses (100 days) + 4 recent wins (1 day). Raw WR = 4/14 = 29%.
  // Decayed: old losses ~0 weight, recent wins dominate -> WR near 100%.
  const ts = [
    ...trades("mean-reversion", Array.from({ length: 10 }, () => [100, -5])),
    ...trades("mean-reversion", Array.from({ length: 4 }, () => [1, 8])),
  ];
  const s = getSetupStatsRecent(ts, "mean-reversion", now);
  assert.equal(s.count, 14);            // raw count preserved
  assert.ok(s.winRate > 0.85, `decayed WR should be recency-biased high, got ${s.winRate}`);
  assert.ok(s.effN < 6, `effN dominated by 4 fresh + faded old, got ${s.effN}`);
});

test("getAdaptiveSetupDecision: stale negative-EV history does NOT block when recent evidence is thin", () => {
  // 40 old losing trades (120 days). Full-window logic would hard-block (allow:false).
  // Recency guard: effN tiny -> stays allow:true, neutral size.
  const ts = trades("mean-reversion", Array.from({ length: 40 }, () => [120, -6]));
  const d = getAdaptiveSetupDecision({ trades: ts }, "mean-reversion");
  assert.equal(d.allow, true);
  assert.equal(d.sizeMult, 1.0);
  assert.match(d.reason, /thin-recent/);
});

test("getAdaptiveSetupDecision: fresh negative-EV evidence DOES act (no longer thin)", () => {
  // 40 recent losing trades (within a few days) -> effN well above floor, EV negative
  // and large sample -> blocks, as intended on genuinely current bad performance.
  const ts = trades("mean-reversion", Array.from({ length: 40 }, (_, i) => [i % 4, -6]));
  const s = getSetupStatsRecent(ts, "mean-reversion", now);
  assert.ok(s.effN >= MIN_EFF_RECENT_SETUP, `effN should clear floor, got ${s.effN}`);
  const d = getAdaptiveSetupDecision({ trades: ts }, "mean-reversion");
  assert.equal(d.allow, false);
});
