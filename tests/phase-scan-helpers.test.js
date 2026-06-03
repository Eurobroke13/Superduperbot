/**
 * Tests for the pure scoring/selection helpers extracted from phaseScan into
 * runner-utils.js. These are the test-backed subset of the phaseScan
 * decomposition: each helper mirrors a previously-inline loop exactly, so
 * these tests pin the behavior before any further restructuring.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFundingAdjustments,
  applyLunarAdjustments,
  interleaveLongsShorts,
  selectTopSignals
} from "../bot/runner-utils.js";

// ── selectTopSignals ────────────────────────────────────────────────────────

test("selectTopSignals - keeps candidates at/above the percentile cutoff", () => {
  const cands = [10, 8, 6, 4, 2].map((score, i) => ({ symbol: `S${i}`, score }));
  // 5 scores, floor(5*0.2)=1 -> cutoff = sorted-desc[1] = 8
  const top = selectTopSignals(cands, 0.2);
  assert.deepEqual(top.map(c => c.score), [10, 8]);
});

test("selectTopSignals - empty input returns empty array", () => {
  assert.deepEqual(selectTopSignals([], 0.2), []);
  assert.deepEqual(selectTopSignals(undefined, 0.2), []);
});

test("selectTopSignals - single candidate is always kept", () => {
  const top = selectTopSignals([{ symbol: "A", score: 3 }], 0.2);
  assert.equal(top.length, 1);
});

// ── interleaveLongsShorts ─────────────────────────────────────────────────────

test("interleaveLongsShorts - alternates long/short up to slots", () => {
  const longs = [{ symbol: "L1" }, { symbol: "L2" }];
  const shorts = [{ symbol: "S1" }, { symbol: "S2" }];
  const out = interleaveLongsShorts(longs, shorts, 4);
  assert.deepEqual(out.map(c => c.symbol), ["L1", "S1", "L2", "S2"]);
});

test("interleaveLongsShorts - respects the slot cap", () => {
  const longs = [{ symbol: "L1" }, { symbol: "L2" }, { symbol: "L3" }];
  const shorts = [{ symbol: "S1" }];
  const out = interleaveLongsShorts(longs, shorts, 2);
  assert.deepEqual(out.map(c => c.symbol), ["L1", "S1"]);
});

test("interleaveLongsShorts - drains one side when the other is empty", () => {
  const longs = [{ symbol: "L1" }, { symbol: "L2" }];
  const out = interleaveLongsShorts(longs, [], 5);
  assert.deepEqual(out.map(c => c.symbol), ["L1", "L2"]);
});

test("interleaveLongsShorts - empty inputs return empty", () => {
  assert.deepEqual(interleaveLongsShorts([], [], 5), []);
});

// ── applyFundingAdjustments ───────────────────────────────────────────────────

test("applyFundingAdjustments - funding squeeze against bullish h4 short", () => {
  const r = applyFundingAdjustments(
    { signal: "short", h4Trend: "bullish" },
    { signal: "short" },
    0.001
  );
  assert.equal(r.scoreDelta, 1.5);
  assert.deepEqual(r.reasons, ["funding-squeeze"]);
});

test("applyFundingAdjustments - extreme-long boosts shorts, penalizes longs", () => {
  const shortR = applyFundingAdjustments({ signal: "short", h4Trend: "x" }, { reason: "funding-extreme-long" }, 0);
  assert.equal(shortR.scoreDelta, 2.0);
  const longR = applyFundingAdjustments({ signal: "long", h4Trend: "x" }, { reason: "funding-extreme-long" }, 0);
  assert.equal(longR.scoreDelta, -0.5);
});

test("applyFundingAdjustments - extreme-short boosts longs, penalizes shorts", () => {
  const longR = applyFundingAdjustments({ signal: "long", h4Trend: "x" }, { reason: "funding-extreme-short" }, 0);
  assert.equal(longR.scoreDelta, 2.0);
  const shortR = applyFundingAdjustments({ signal: "short", h4Trend: "x" }, { reason: "funding-extreme-short" }, 0);
  assert.equal(shortR.scoreDelta, -0.5);
});

test("applyFundingAdjustments - crowded-long only adds for shorts past threshold", () => {
  const hit = applyFundingAdjustments({ signal: "short", h4Trend: "x" }, { reason: "funding-crowded-long" }, 0.002);
  assert.equal(hit.scoreDelta, 1.0);
  assert.deepEqual(hit.reasons, ["funding-skew-short"]);
  // long signal: reason still tagged, but no score added
  const longHit = applyFundingAdjustments({ signal: "long", h4Trend: "x" }, { reason: "funding-crowded-long" }, 0.002);
  assert.equal(longHit.scoreDelta, 0);
  assert.deepEqual(longHit.reasons, ["funding-skew-short"]);
  // below threshold: nothing
  const below = applyFundingAdjustments({ signal: "short", h4Trend: "x" }, { reason: "funding-crowded-long" }, 0.001);
  assert.equal(below.scoreDelta, 0);
  assert.deepEqual(below.reasons, []);
});

test("applyFundingAdjustments - crowded-short only adds for longs past negative threshold", () => {
  const hit = applyFundingAdjustments({ signal: "long", h4Trend: "x" }, { reason: "funding-crowded-short" }, -0.002);
  assert.equal(hit.scoreDelta, 1.0);
  assert.deepEqual(hit.reasons, ["funding-skew-long"]);
});

test("applyFundingAdjustments - no matching signal yields zero delta", () => {
  const r = applyFundingAdjustments({ signal: "long", h4Trend: "neutral" }, { signal: "none" }, 0);
  assert.equal(r.scoreDelta, 0);
  assert.deepEqual(r.reasons, []);
});

// ── applyLunarAdjustments ─────────────────────────────────────────────────────

test("applyLunarAdjustments - bullish galaxy score boosts long", () => {
  const r = applyLunarAdjustments({ signal: "long" }, { galaxyScore: 70, sentiment: 50 }, { bull: 0.7, bear: 0.7, warning: -1.0 });
  assert.equal(r.scoreDelta, 0.7);
  assert.deepEqual(r.reasons, ["lunar-bull(70)"]);
});

test("applyLunarAdjustments - bearish galaxy score boosts short", () => {
  const r = applyLunarAdjustments({ signal: "short" }, { galaxyScore: 20, sentiment: 50 }, { bull: 0.7, bear: 0.7, warning: -1.0 });
  assert.equal(r.scoreDelta, 0.7);
  assert.deepEqual(r.reasons, ["lunar-bear(20)"]);
});

test("applyLunarAdjustments - low sentiment warns a long (can stack with bull)", () => {
  const r = applyLunarAdjustments({ signal: "long" }, { galaxyScore: 70, sentiment: 20 }, { bull: 0.7, bear: 0.7, warning: -1.0 });
  // bull (+0.7) and warning (-1.0) both fire
  assert.ok(Math.abs(r.scoreDelta - (-0.3)) < 1e-9);
  assert.deepEqual(r.reasons, ["lunar-bull(70)", "lunar-sentiment-warning"]);
});

test("applyLunarAdjustments - high sentiment warns a short", () => {
  const r = applyLunarAdjustments({ signal: "short" }, { galaxyScore: 50, sentiment: 80 }, { bull: 0.7, bear: 0.7, warning: -1.0 });
  assert.equal(r.scoreDelta, -1.0);
  assert.deepEqual(r.reasons, ["lunar-sentiment-warning"]);
});

test("applyLunarAdjustments - null lunar data is a no-op", () => {
  const r = applyLunarAdjustments({ signal: "long" }, null, { bull: 0.7 });
  assert.equal(r.scoreDelta, 0);
  assert.deepEqual(r.reasons, []);
});
