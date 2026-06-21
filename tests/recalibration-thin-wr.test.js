import test from "node:test";
import assert from "node:assert";
import { buildValidationSection } from "../coin-memory.js";

// Minimal deps stubs — buildValidationSection only reads from them.
const deps = {
  getCoinMemory: () => null,
  formatCoinMemoryForClaude: () => "",
  getApprovalStats: () => ({ wins: 3, count: 10, winRate: 0.3, expectancy: -5 }),
  getSetupStats: () => ({ winRate: 0.3, expectancy: -5, count: 10 }),
  getWeight: () => 1.0,
};

const regime = { label: "sideways", hmmLabel: "x", piCycle: "y", markovProb: 0.5 };
const candidate = {
  symbol: "FOO-USDT-SWAP", signal: "short", score: 6, setupType: "mean-reversion",
  reasons: ["mr-stoch-overbought", "mr-at-resistance"], price: 1, h4Trend: "bearish", obvDiv: "none",
};

function stateWith(regCount) {
  // combined WR 30% (<42%) → recalibration mode on
  return {
    trades: [],
    regimeStats: { sideways: { wins: 3, count: 10, totalPnl: -50 } },
    signalStats: {
      "mr-stoch-overbought:sideways": { wins: 1, losses: regCount - 1, count: regCount, totalPnl: -5 },
      "mr-at-resistance:sideways":    { wins: 1, losses: regCount - 1, count: regCount, totalPnl: -5 },
    },
  };
}

test("thin (n<10) regime signal WR is tagged 'thin' and shows n", () => {
  const out = buildValidationSection([candidate], regime, stateWith(3), deps);
  assert.match(out, /\[sideways:33% n=3 thin\]/);
});

test("reliable (n>=10) regime signal WR is NOT tagged thin", () => {
  const out = buildValidationSection([candidate], regime, stateWith(12), deps);
  assert.match(out, /\[sideways:\d+% n=12\]/);
  assert.doesNotMatch(out, /n=12 thin/);
});

test("recalibration prompt instructs Claude to ignore thin signal WR", () => {
  const out = buildValidationSection([candidate], regime, stateWith(3), deps);
  assert.match(out, /RECALIBRATION MODE/);
  assert.match(out, /thin.*NOT a valid rejection basis|do NOT reject a candidate because a thin signal/i);
  assert.match(out, /n≥10/);
});
