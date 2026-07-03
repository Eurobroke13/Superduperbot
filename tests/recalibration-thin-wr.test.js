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

// effN defaults to count when omitted (legacy-state fallback path).
function stateWith(regCount, effN) {
  return {
    trades: [],
    regimeStats: { sideways: { wins: 3, count: 10, totalPnl: -50 } },
    signalStats: {
      "mr-stoch-overbought:sideways": { wins: 1, losses: regCount - 1, count: regCount, totalPnl: -5, ...(effN != null ? { effN } : {}) },
      "mr-at-resistance:sideways":    { wins: 1, losses: regCount - 1, count: regCount, totalPnl: -5, ...(effN != null ? { effN } : {}) },
    },
  };
}

test("thin (low sample) regime signal WR is tagged 'thin'", () => {
  const out = buildValidationSection([candidate], regime, stateWith(3), deps);
  assert.match(out, /\[sideways:33% n=3 eff=3 thin\]/);
});

test("reliable (n>=15, no decay) regime signal WR is NOT tagged thin", () => {
  const out = buildValidationSection([candidate], regime, stateWith(16), deps);
  assert.match(out, /\[sideways:\d+% n=16 eff=16\]/);
  assert.doesNotMatch(out, /n=16 eff=16 thin/);
});

test("legacy-fallback: count 12 (no effN) IS tagged thin", () => {
  const out = buildValidationSection([candidate], regime, stateWith(12), deps);
  assert.match(out, /\[sideways:\d+% n=12 eff=12 thin\]/);
});

// The core de-poison case: a large raw n whose decay-weighted effective sample
// is small (stale pre-pivot trades) must read as thin so it can't auto-reject.
test("stale high-n but low effN signal IS tagged thin", () => {
  const out = buildValidationSection([candidate], regime, stateWith(24, 3), deps);
  assert.match(out, /\[sideways:\d+% n=24 eff=3 thin\]/);
});

test("high-n with healthy effN is trustworthy (not thin)", () => {
  const out = buildValidationSection([candidate], regime, stateWith(24, 20), deps);
  assert.match(out, /\[sideways:\d+% n=24 eff=20\]/);
  assert.doesNotMatch(out, /eff=20 thin/);
});

test("displayed WR uses decWinRate (decayed) not raw lifetime wins/count", () => {
  // Raw WR = 2/10 = 20% (poisoned lifetime), but decWinRate=0.55 (recency-weighted),
  // effN=20 (reliable). The number Claude sees must be the decayed 55%, not 20%.
  const state = {
    trades: [],
    regimeStats: { sideways: { wins: 3, count: 10, totalPnl: -50 } },
    signalStats: {
      "mr-stoch-overbought:sideways": { wins: 2, losses: 8, count: 10, totalPnl: -5, effN: 20, decWinRate: 0.55 },
      "mr-at-resistance:sideways":    { wins: 2, losses: 8, count: 10, totalPnl: -5, effN: 20, decWinRate: 0.55 },
    },
  };
  const out = buildValidationSection([candidate], regime, state, deps);
  assert.match(out, /\[sideways:55% n=10 eff=20\]/);   // decayed 55%, reliable (not thin)
  assert.doesNotMatch(out, /sideways:20%/);            // NOT the raw lifetime 20%
});

test("recalibration prompt instructs Claude to ignore thin (stale) signal WR", () => {
  const out = buildValidationSection([candidate], regime, stateWith(3), deps);
  assert.match(out, /RECALIBRATION MODE/);
  assert.match(out, /thin.*NOT a valid rejection basis|do NOT reject a candidate because a thin signal/i);
  assert.match(out, /eff≥15/);
});

test("recalibration approve rule (b) is binding — 3 aligned signals is sufficient, not 'marginal'", () => {
  // Live 2026-07-03: Claude rejected every candidate that met rule (b) to the
  // letter (3 aligned signals + score met) as "marginal"/"only 3", re-freezing
  // the bot at the approval layer. The prompt must state the rule is binding
  // and that exactly 3 counts. A regression here re-opens deadlock #4.
  const out = buildValidationSection([candidate], regime, stateWith(3), deps);
  assert.match(out, /BINDING/);
  assert.match(out, /exactly 3 aligned signals IS/);
  assert.match(out, /do NOT call 3 "marginal"/);
  assert.match(out, /REJECT only when neither \(a\) nor \(b\) is met/);
  // hour-of-day nudges must not inflate the aligned-signal count
  assert.match(out, /time\(±x\) entries are hour-of-day nudges/);
  // verdicts must name the rule applied, so log review is unambiguous
  assert.match(out, /name the rule you applied/);
});
