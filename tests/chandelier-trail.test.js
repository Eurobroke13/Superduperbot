import test from "node:test";
import assert from "node:assert";
import { applyStructureChandelierTrail, recentSwingLevels } from "../bot/exits.js";

// CHANDELIER_ATR_MULT=2.5, MIN_PROFIT_ATR=1.0, STRUCTURE_BUFFER=0.25 (config.js)

test("trail no-ops when not yet onside enough (profit < 1 ATR)", () => {
  const pos = { direction: "long", entryPrice: 100, maxFavorable: 101, sl: 96 };
  applyStructureChandelierTrail(pos, 100.5, 2, []); // +0.25 ATR
  assert.equal(pos.sl, 96);
});

test("long chandelier raises SL to peak − 2.5×ATR once onside", () => {
  const pos = { direction: "long", entryPrice: 100, maxFavorable: 110, sl: 96 };
  applyStructureChandelierTrail(pos, 108, 2, []); // profit 4 ATR, peak 110
  assert.equal(pos.sl, 110 - 2.5 * 2); // 105
});

test("long structure anchor pulls SL up to just below nearest support", () => {
  const pos = { direction: "long", entryPrice: 100, maxFavorable: 110, sl: 96 };
  // chandelier would be 105; a support at 106.5 below price 108 → 106.5 − 0.25*2 = 106 is tighter/more protective
  applyStructureChandelierTrail(pos, 108, 2, [106.5, 120]);
  assert.equal(pos.sl, 106); // structure beats chandelier (105)
});

test("trail only ever tightens (never loosens) on a long", () => {
  const pos = { direction: "long", entryPrice: 100, maxFavorable: 110, sl: 107 };
  applyStructureChandelierTrail(pos, 108, 2, []); // chandelier 105 < existing 107
  assert.equal(pos.sl, 107);
});

test("short chandelier lowers SL to trough + 2.5×ATR", () => {
  const pos = { direction: "short", entryPrice: 100, maxFavorable: 90, sl: 104 };
  applyStructureChandelierTrail(pos, 92, 2, []); // profit 4 ATR, trough 90
  assert.equal(pos.sl, 90 + 2.5 * 2); // 95
});

test("never produces a stop on the wrong side of price", () => {
  const pos = { direction: "long", entryPrice: 100, maxFavorable: 100.5, sl: 96 };
  applyStructureChandelierTrail(pos, 100.5, 2, [100.4]); // barely onside; stop must stay < price
  assert.ok(pos.sl < 100.5);
});

test("atr<=0 is a no-op (no NaN)", () => {
  const pos = { direction: "long", entryPrice: 100, maxFavorable: 110, sl: 96 };
  applyStructureChandelierTrail(pos, 108, 0, [106]);
  assert.equal(pos.sl, 96);
});

test("recentSwingLevels finds pivot highs and lows", () => {
  // a clear pivot high at index 3 (value 10) and pivot low at index 7 (value 1)
  const highs = [5, 6, 7, 10, 7, 6, 5, 4, 5, 6];
  const lows  = [4, 5, 6, 9, 6, 5, 4, 1, 4, 5];
  const lv = recentSwingLevels(highs, lows, { span: 2, lookback: 40 });
  assert.ok(lv.includes(10), "should find the pivot high 10");
  assert.ok(lv.includes(1), "should find the pivot low 1");
});
