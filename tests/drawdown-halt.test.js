import assert from "node:assert/strict";
import test from "node:test";
import { checkMidRunDrawdown } from "../bot/runner-utils.js";

const TODAY = "2026-06-03";

function makeState({ cash = 1000, positions = {}, trades = [] } = {}) {
  return { cash, positions, trades };
}

function trade(pnl, closedAt = `${TODAY}T10:00:00Z`) {
  return { pnl, closedAt };
}

test("checkMidRunDrawdown - returns false when no trades today", () => {
  const state = makeState({ cash: 1000, trades: [] });
  assert.equal(checkMidRunDrawdown(state, TODAY), false);
});

test("checkMidRunDrawdown - returns false when portfolio value is 0", () => {
  const state = makeState({ cash: 0, positions: {}, trades: [trade(-100)] });
  assert.equal(checkMidRunDrawdown(state, TODAY), false);
});

test("checkMidRunDrawdown - returns false when loss is below -4.0% threshold", () => {
  // -3% loss on 1000 portfolio = -30
  const state = makeState({ cash: 1000, trades: [trade(-30)] });
  assert.equal(checkMidRunDrawdown(state, TODAY), false);
});

test("checkMidRunDrawdown - returns false at exactly -4.0% (boundary is strict)", () => {
  // condition is < -0.04, so exact boundary returns false
  const state = makeState({ cash: 1000, trades: [trade(-40)] });
  assert.equal(checkMidRunDrawdown(state, TODAY), false);
});

test("checkMidRunDrawdown - returns true just past -4.0% threshold", () => {
  // -40.1 / 1000 = -4.01% — strictly less than -4.0%
  const state = makeState({ cash: 1000, trades: [trade(-40.1)] });
  assert.equal(checkMidRunDrawdown(state, TODAY), true);
});

test("checkMidRunDrawdown - returns true when loss exceeds -4.0%", () => {
  const state = makeState({ cash: 1000, trades: [trade(-60)] });
  assert.equal(checkMidRunDrawdown(state, TODAY), true);
});

test("checkMidRunDrawdown - aggregates multiple trades on same day", () => {
  const state = makeState({
    cash: 1000,
    trades: [trade(-21), trade(-21)]  // -42 total = -4.2%
  });
  assert.equal(checkMidRunDrawdown(state, TODAY), true);
});

test("checkMidRunDrawdown - ignores trades from other days", () => {
  const state = makeState({
    cash: 1000,
    trades: [
      trade(-50, "2026-06-02T09:00:00Z"),  // yesterday — large loss
      trade(-5,  `${TODAY}T10:00:00Z`)      // today — small loss
    ]
  });
  // Only today's -5 counts: -0.5% < 4.0% threshold
  assert.equal(checkMidRunDrawdown(state, TODAY), false);
});

test("checkMidRunDrawdown - includes open position notional in portfolio value", () => {
  // cash=500, open position notional=500 → portfolio=1000
  // loss = -50 = -5% → should halt
  const state = makeState({
    cash: 500,
    positions: { BTC: { notional: 500 } },
    trades: [trade(-50)]
  });
  assert.equal(checkMidRunDrawdown(state, TODAY), true);
});

test("checkMidRunDrawdown - returns false when net PnL is positive", () => {
  const state = makeState({ cash: 1000, trades: [trade(-50), trade(60)] });
  assert.equal(checkMidRunDrawdown(state, TODAY), false);
});
