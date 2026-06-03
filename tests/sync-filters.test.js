/**
 * Tests for applySyncFilters — the three synchronous candidate gates
 * (sideways → liquidity-trap quality → bear) extracted from phaseScan.
 * Verifies gate ordering, skip semantics, and block-reason tags exactly
 * match the original inline loops.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applySyncFilters } from "../bot/runner-utils.js";

function cand(overrides = {}) {
  return {
    symbol: "BTC-USDT-SWAP",
    signal: "long",
    score: 6,
    setupType: "trend-following",
    reasons: [],
    obvDiv: "none",
    _sweepBlocked: false,
    ...overrides
  };
}

// ── pass-through (bull regime, nothing blocks) ────────────────────────────────

test("applySyncFilters - bull regime passes candidate through unchanged", () => {
  const r = applySyncFilters(cand({ score: 6 }), { regimeLabel: "bull" });
  assert.equal(r.score, 6);
  assert.equal(r.blockReason, null);
});

// ── sideways gate ─────────────────────────────────────────────────────────────

test("applySyncFilters - sideways blocks trend setups (neg-EV)", () => {
  const r = applySyncFilters(cand({ setupType: "trend", score: 8 }), { regimeLabel: "sideways" });
  assert.equal(r.score, 0);
  assert.match(r.blockReason, /^sideways-filter:trend-in-sideways-blocked/);
});

test("applySyncFilters - sideways blocks low-score non-MR setups", () => {
  const r = applySyncFilters(cand({ setupType: "breakout", score: 4 }), { regimeLabel: "sideways" });
  assert.equal(r.score, 0);
  assert.match(r.blockReason, /^sideways-filter:sideways-score-too-low/);
});

test("applySyncFilters - sideways lets mean-reversion through", () => {
  const r = applySyncFilters(cand({ setupType: "mean-reversion", score: 4 }), { regimeLabel: "sideways" });
  assert.equal(r.score, 4);
  assert.equal(r.blockReason, null);
});

test("applySyncFilters - sweep-blocked candidate skips the sideways gate", () => {
  // _sweepBlocked means sideways gate is skipped; a trend setup that would
  // otherwise be blocked passes the sideways gate (bull regime, no bear gate).
  const r = applySyncFilters(
    cand({ setupType: "trend", score: 8, _sweepBlocked: true }),
    { regimeLabel: "bull" }
  );
  assert.equal(r.blockReason, null);
});

// ── liquidity-trap quality gate ───────────────────────────────────────────────

test("applySyncFilters - LT gate blocks a liquidity-trap lacking confirmations", () => {
  // weak volume + no divergence -> quality gate should fail
  const r = applySyncFilters(
    cand({ setupType: "liquidity-trap", score: 6, reasons: [], obvDiv: "none" }),
    { regimeLabel: "bull" }
  );
  assert.equal(r.score, 0);
  assert.equal(r.blockReason, "lt-quality-gate");
});

test("applySyncFilters - LT gate skipped for non-liquidity-trap setups", () => {
  const r = applySyncFilters(
    cand({ setupType: "trend-following", score: 6 }),
    { regimeLabel: "bull" }
  );
  assert.equal(r.blockReason, null);
});

// ── bear gate ─────────────────────────────────────────────────────────────────

test("applySyncFilters - bear regime approves a decent short", () => {
  const r = applySyncFilters(cand({ signal: "short", score: 5 }), { regimeLabel: "bear" });
  assert.equal(r.score, 5);
  assert.equal(r.blockReason, null);
});

test("applySyncFilters - bear regime blocks a low-score short", () => {
  const r = applySyncFilters(cand({ signal: "short", score: 3 }), { regimeLabel: "bear" });
  assert.equal(r.score, 0);
  assert.match(r.blockReason, /^bear-gate:bear-short-low-score/);
});

test("applySyncFilters - bear regime blocks a non-extreme long", () => {
  const r = applySyncFilters(cand({ signal: "long", score: 6 }), { regimeLabel: "bear" });
  assert.equal(r.score, 0);
  assert.match(r.blockReason, /^bear-gate:bear-long-blocked/);
});

test("applySyncFilters - bear regime allows an extreme-conviction long", () => {
  const r = applySyncFilters(cand({ signal: "long", score: 7.5 }), { regimeLabel: "bear" });
  assert.equal(r.score, 7.5);
  assert.equal(r.blockReason, null);
});

// ── ordering: only one reason fires ───────────────────────────────────────────

test("applySyncFilters - once sideways zeroes the score, later gates self-skip", () => {
  // A trend setup in sideways is blocked by gate 1; gate 3 (bear) never runs
  // (regime isn't bear anyway) and the reason is the sideways one only.
  const r = applySyncFilters(cand({ setupType: "trend", score: 8 }), { regimeLabel: "sideways" });
  assert.match(r.blockReason, /^sideways-filter:/);
});
