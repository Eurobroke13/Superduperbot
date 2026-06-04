/**
 * Unit tests for bot/reconciliation.js
 * computeStateChecksum, stampStateChecksum, validateState — all pure.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeStateChecksum,
  stampStateChecksum,
  validateState
} from "../bot/reconciliation.js";

function freshState(overrides = {}) {
  return {
    cash: 10000,
    positions: {},
    trades: [],
    ...overrides
  };
}

// ── computeStateChecksum ───────────────────────────────────────────────────────

test("computeStateChecksum - format is posCount:cash:tradeCount", () => {
  const state = freshState({ cash: 9876.54, trades: [{ pnl: 1 }, { pnl: 2 }] });
  const cs = computeStateChecksum(state);
  assert.equal(cs, "0:9876.54:2");
});

test("computeStateChecksum - reflects position count", () => {
  const state = freshState({
    positions: { "BTC-USDT-SWAP": { notional: 500 }, "ETH-USDT-SWAP": { notional: 300 } }
  });
  const cs = computeStateChecksum(state);
  assert.ok(cs.startsWith("2:"));
});

test("computeStateChecksum - same state always produces the same checksum", () => {
  const state = freshState({ cash: 5000 });
  assert.equal(computeStateChecksum(state), computeStateChecksum(state));
});

test("computeStateChecksum - different cash produces different checksum", () => {
  const a = computeStateChecksum(freshState({ cash: 5000 }));
  const b = computeStateChecksum(freshState({ cash: 5001 }));
  assert.notEqual(a, b);
});

test("computeStateChecksum - handles missing/invalid cash gracefully", () => {
  const cs = computeStateChecksum({ positions: {}, trades: [], cash: NaN });
  assert.equal(typeof cs, "string");
  assert.ok(cs.includes("0.00"));
});

// ── stampStateChecksum ─────────────────────────────────────────────────────────

test("stampStateChecksum - mutates state with checksum and timestamp", () => {
  const state = freshState();
  const cs = stampStateChecksum(state);
  assert.equal(typeof cs, "string");
  assert.equal(state.stateChecksum, cs);
  assert.ok(state.stateChecksumUpdatedAt);
  assert.ok(!isNaN(new Date(state.stateChecksumUpdatedAt).getTime()));
});

test("stampStateChecksum - returns same value as computeStateChecksum", () => {
  const state = freshState({ cash: 7500 });
  const stamped = stampStateChecksum(state);
  assert.equal(stamped, computeStateChecksum(state));
});

// ── validateState ──────────────────────────────────────────────────────────────

test("validateState - valid state returns valid:true, no warnings", () => {
  const state = freshState();
  const r = validateState(state);
  assert.equal(r.valid, true);
  assert.deepEqual(r.warnings, []);
});

test("validateState - non-object state returns valid:false", () => {
  assert.equal(validateState(null).valid, false);
  assert.equal(validateState("string").valid, false);
});

test("validateState - invalid positions object is reset to {}", () => {
  const state = { cash: 10000, trades: [], positions: "bad" };
  validateState(state);
  assert.deepEqual(state.positions, {});
});

test("validateState - invalid cash is reset to PAPER_CASH", () => {
  const state = { cash: NaN, trades: [], positions: {} };
  validateState(state);
  assert.ok(Number.isFinite(state.cash));
});

test("validateState - malformed position is removed and warned", () => {
  const state = freshState({
    positions: {
      "BAD-USDT-SWAP": { symbol: "BAD-USDT-SWAP", entryPrice: null, direction: "long", size: 1, notional: 500, sl: 90, openedAt: "2024-01-01" }
    }
  });
  const r = validateState(state);
  assert.equal(state.positions["BAD-USDT-SWAP"], undefined);
  assert.ok(r.fixed.some(f => f.includes("BAD-USDT-SWAP")));
});

test("validateState - position with invalid direction is removed", () => {
  const state = freshState({
    positions: {
      "ETH-USDT-SWAP": { symbol: "ETH-USDT-SWAP", entryPrice: 2000, direction: "sideways", size: 1, notional: 500, sl: 1900, openedAt: "2024-01-01" }
    }
  });
  validateState(state);
  assert.equal(state.positions["ETH-USDT-SWAP"], undefined);
});

test("validateState - valid position survives validation", () => {
  const state = freshState({
    positions: {
      "BTC-USDT-SWAP": { symbol: "BTC-USDT-SWAP", entryPrice: 50000, direction: "long", size: 0.01, notional: 500, sl: 48000, openedAt: "2024-01-01T00:00:00Z" }
    }
  });
  validateState(state);
  assert.ok(state.positions["BTC-USDT-SWAP"]);
});

test("validateState - checksum mismatch produces a warning", () => {
  const state = freshState();
  state.stateChecksum = "99:9999.99:99"; // deliberately wrong
  const r = validateState(state);
  assert.ok(r.warnings.some(w => w.includes("checksum mismatch")));
});

test("validateState - matching checksum produces no checksum warning", () => {
  const state = freshState();
  stampStateChecksum(state);
  const r = validateState(state);
  assert.ok(!r.warnings.some(w => w.includes("checksum")));
});

test("validateState - returns fixed array listing all repairs made", () => {
  const state = { cash: NaN, trades: [], positions: null };
  const r = validateState(state);
  assert.ok(r.fixed.length >= 2); // positions + cash both reset
});
