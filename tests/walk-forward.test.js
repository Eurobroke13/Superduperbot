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

test("foldMetrics - drawdown is computed on the trade-ordered equity curve", () => {
  // +10, then -30 → peak 10, trough -20, DD = 30/10 = 300%? capped by peak math:
  // peak=10 at t1; eq after t2 = -20; dd=(10-(-20))/10=3.0 → 300%
  const m = foldMetrics([{ pnl: 10 }, { pnl: -30 }]);
  assert.equal(m.maxDD, 300);
});

test("foldMetrics - all losses → PF 0", () => {
  const m = foldMetrics([{ pnl: -5 }, { pnl: -5 }]);
  assert.equal(m.pf, 0);
  assert.equal(m.wr, 0);
});
