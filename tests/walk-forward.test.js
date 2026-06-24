import test from "node:test";
import assert from "node:assert";
import { foldMetrics } from "../backtest.js";

test("foldMetrics - empty input is safe", () => {
  assert.deepEqual(foldMetrics([]), { n: 0, wr: 0, ev: 0, pf: 0, pnl: 0, maxDD: 0 });
  assert.equal(foldMetrics(null).n, 0);
});

test("foldMetrics - basic WR / EV / PF / PnL", () => {
  // 3 wins (+10) + 1 loss (-10): WR 75%, EV +5, PF 30/10=3, PnL +20
  const m = foldMetrics([{ pnl: 10 }, { pnl: 10 }, { pnl: 10 }, { pnl: -10 }]);
  assert.equal(m.n, 4);
  assert.equal(m.wr, 75);
  assert.equal(m.ev, 5);
  assert.equal(m.pf, 3);
  assert.equal(m.pnl, 20);
});

test("foldMetrics - drawdown is a sane % of capital (equity based at PAPER_CASH)", () => {
  // Equity 10000 → 10010 (peak) → 9980; DD = 30/10010 = 0.3% of capital.
  // (Pre-fix this used a 0-based curve and exploded to 300%.)
  const m = foldMetrics([{ pnl: 10 }, { pnl: -30 }]);
  assert.equal(m.maxDD, 0.3);
});

test("foldMetrics - all losses → PF 0", () => {
  const m = foldMetrics([{ pnl: -5 }, { pnl: -5 }]);
  assert.equal(m.pf, 0);
  assert.equal(m.wr, 0);
});
