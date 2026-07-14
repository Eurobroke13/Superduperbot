import test from "node:test";
import assert from "node:assert";
import { applyConfluenceOverride } from "../bot/runner-utils.js";
import { getRecalibrationState } from "../coin-memory.js";
import { getApprovalStats } from "../bot/stats.js";

// Deadlock #5 (July 2026): five prompt iterations in, Claude kept re-interpreting
// the recalibration approve rules and rejecting 100% of candidates (34 reviews,
// 0 approvals), so rule (b) is now enforced in code. These tests pin the exact
// override conditions — a regression here re-freezes the bot silently.

function makeRouting(overrides = {}) {
  return [{
    action: "rejected",
    approvalType: "claude",
    claudeReason: "all signals thin — marginal",
    candidate: {
      symbol: "AAA-USDT-SWAP",
      setupType: "mean-reversion",
      score: 5.5,
      reasons: ["mr-stoch-overbought", "mr-at-resistance", "above-VWAP", "time(+0.1)"],
      ...overrides
    }
  }];
}

const thinStats = {
  "mr-stoch-overbought": { count: 8, effN: 2 },
  "mr-at-resistance": { count: 5, effN: 1 },
  "above-VWAP": { count: 6, effN: 3 }
};

const baseCtx = { recalibrating: true, signalStats: thinStats, regimeLabel: "bull" };

test("override fires: 3 non-time thin signals + score met → staged at reduced size", () => {
  const routing = makeRouting();
  const n = applyConfluenceOverride(routing, baseCtx);
  assert.equal(n, 1);
  assert.equal(routing[0].action, "stage");
  assert.equal(routing[0].approvalType, "confluence-override");
  assert.equal(routing[0].candidate.overrideSizeMult, 0.5);
  // Claude's prose verdict must be preserved as a risk note
  assert.match(routing[0].claudeReason, /rule \(b\) met in code/);
  assert.match(routing[0].claudeReason, /Claude said: all signals thin/);
});

test("no override outside recalibration", () => {
  const routing = makeRouting();
  const n = applyConfluenceOverride(routing, { ...baseCtx, recalibrating: false });
  assert.equal(n, 0);
  assert.equal(routing[0].action, "rejected");
});

test("time(±x) nudges do not count toward the 3-signal minimum", () => {
  const routing = makeRouting({ reasons: ["mr-stoch-overbought", "mr-at-resistance", "time(+0.1)", "time(-0.2)"] });
  assert.equal(applyConfluenceOverride(routing, baseCtx), 0);
});

test("no override when any fired signal has reliable recent data (rule (a) available)", () => {
  const routing = makeRouting();
  const stats = { ...thinStats, "mr-at-resistance": { count: 30, effN: 20 } };
  assert.equal(applyConfluenceOverride(routing, { ...baseCtx, signalStats: stats }), 0);
});

test("in-regime reliable stats also block the override", () => {
  const routing = makeRouting();
  const stats = { ...thinStats, "mr-at-resistance:bull": { count: 22, effN: 18 } };
  assert.equal(applyConfluenceOverride(routing, { ...baseCtx, signalStats: stats }), 0);
});

test("legacy stats with no effN fall back to raw count for reliability", () => {
  const routing = makeRouting();
  const stats = { ...thinStats, "above-VWAP": { count: 20 } }; // no effN → count 20 is reliable
  assert.equal(applyConfluenceOverride(routing, { ...baseCtx, signalStats: stats }), 0);
});

test("score thresholds: MR needs 4.5", () => {
  const mr44 = makeRouting({ score: 4.4 });
  assert.equal(applyConfluenceOverride(mr44, baseCtx), 0, "MR 4.4 must not override");

  const mr45 = makeRouting({ score: 4.5 });
  assert.equal(applyConfluenceOverride(mr45, baseCtx), 1, "MR 4.5 overrides");
});

test("non-MR setups are never overridden", () => {
  const trend = makeRouting({ setupType: "trend", score: 6.0, reasons: ["ema-ribbon-bull", "h4-bull", "above-VWAP"] });
  assert.equal(applyConfluenceOverride(trend, baseCtx), 0, "trend must not override");

  const lt = makeRouting({ setupType: "liquidity-trap", score: 8.0, reasons: ["trap-clean-sweep-bull", "h4-bull", "above-VWAP"] });
  assert.equal(applyConfluenceOverride(lt, baseCtx), 0, "LT must not override");

  const breakout = makeRouting({ setupType: "breakout", score: 6.0, reasons: ["breakout-confirm", "h4-bull", "above-VWAP"] });
  assert.equal(applyConfluenceOverride(breakout, baseCtx), 0, "breakout must not override");
});

test("overrides are capped per run (default 2)", () => {
  const routing = [
    ...makeRouting({ symbol: "A-USDT-SWAP" }),
    ...makeRouting({ symbol: "B-USDT-SWAP" }),
    ...makeRouting({ symbol: "C-USDT-SWAP" })
  ];
  const n = applyConfluenceOverride(routing, baseCtx);
  assert.equal(n, 2);
  assert.equal(routing[2].action, "rejected");
});

test("fallback-rejected (Claude never reviewed) is not overridden", () => {
  const routing = makeRouting();
  routing[0].action = "fallback-rejected";
  assert.equal(applyConfluenceOverride(routing, baseCtx), 0);
});

// ── getRecalibrationState ────────────────────────────────────────────────────

function trades(approvalType, wins, losses) {
  return [
    ...Array.from({ length: wins }, () => ({ approvalType, pnl: 10 })),
    ...Array.from({ length: losses }, () => ({ approvalType, pnl: -10 }))
  ];
}

test("getRecalibrationState: WR below floor → recalibrating", () => {
  const state = { trades: trades("claude", 3, 9) }; // 25% WR, n=12
  const r = getRecalibrationState(state, getApprovalStats);
  assert.equal(r.recalibrating, true);
  assert.ok(Math.abs(r.combinedWR - 0.25) < 1e-9);
});

test("getRecalibrationState: WR above floor → auto-reverts (the wins-field bug is fixed)", () => {
  // The old inline code read autoStats.wins, a field getApprovalStats never
  // returned — so combinedWR was permanently 0 and recalibration could never
  // self-revert. Pin the corrected computation.
  const state = { trades: trades("auto", 8, 4) }; // 66% WR, n=12
  const r = getRecalibrationState(state, getApprovalStats);
  assert.equal(r.recalibrating, false);
});

test("getRecalibrationState: confluence-override trades count toward the recovery WR", () => {
  const state = { trades: [...trades("claude", 1, 5), ...trades("confluence-override", 6, 0)] };
  // combined: 7 wins / 12 = 58% → not recalibrating; without the override route it'd be 17%
  const r = getRecalibrationState(state, getApprovalStats);
  assert.equal(r.recalibrating, false);
});

test("getRecalibrationState: n<10 → not recalibrating (insufficient data)", () => {
  const state = { trades: trades("claude", 1, 5) }; // n=6
  const r = getRecalibrationState(state, getApprovalStats);
  assert.equal(r.recalibrating, false);
  assert.equal(r.combinedWR, null);
});
