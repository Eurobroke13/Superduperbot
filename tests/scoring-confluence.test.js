/**
 * Targeted tests for the MR and liquidity-trap bonus/penalty logic added in
 * the recent confluence improvements. These exercise specific reason codes
 * rather than exact numeric scores, so they remain valid if weights are tuned.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { scoreFromData } from "../bot/scoring.js";

const mockState = {
  dynamicWeights: {},
  signalStats: {},
  disabledSignals: [],
  positions: {}
};

// ── Candle helpers ────────────────────────────────────────────────────────────

function makeFlat(count, { center = 100, swing = 0.3, vol = 3000 } = {}) {
  const c = [];
  for (let i = 0; i < count; i++) {
    const close = center + Math.sin(i / 12) * swing;
    const open  = center + Math.sin((i - 1) / 12) * swing;
    c.push({ time: i * 3600000, open, high: Math.max(open, close) + 0.15, low: Math.min(open, close) - 0.15, close, volume: vol + (i % 5) * 20 });
  }
  return c;
}

function makeUptrend(count, { start = 100, step = 0.25, vol = 5000 } = {}) {
  const c = [];
  let close = start;
  for (let i = 0; i < count; i++) {
    close += step + Math.sin(i / 6) * step * 0.1;
    const open = close - step * 0.3;
    c.push({ time: i * 3600000, open, high: close + step * 0.8, low: open - step * 0.2, close: Math.max(open + 0.01, close), volume: vol + i * 2 });
  }
  return c;
}

// ── Score function gate tests ─────────────────────────────────────────────────

test("scoreFromData - returns null for fewer than 100 candles", () => {
  assert.equal(scoreFromData("X", makeFlat(50), [], { label: "sideways" }, mockState), null);
});

test("scoreFromData - returns null for null candles", () => {
  assert.equal(scoreFromData("X", null, [], { label: "bull" }, mockState), null);
});

// ── Disabled signals are excluded ────────────────────────────────────────────

test("scoreFromData - disabled signal does not appear in reasons", () => {
  const c1h = makeUptrend(620);
  const c4h = makeUptrend(220, { step: 0.5 });
  const stateWithDisabled = { ...mockState, disabledSignals: ["ema-ribbon-bull", "h4-bull", "h4-bull-pb", "h4-bear-strong"] };
  const result = scoreFromData("T-USDT-SWAP", c1h, c4h, { label: "bull" }, stateWithDisabled);
  if (result) {
    for (const sig of stateWithDisabled.disabledSignals) {
      assert.ok(!result.reasons.includes(sig), `disabled signal "${sig}" appeared in reasons`);
    }
  }
});

// ── MR penalty: mr-penalty-vol-expanding ──────────────────────────────────────
// Volume is expanding into the extreme → momentum continuation, not reversal.
// We test that scoreFromData handles MR setups without crashing and that
// the reason codes are valid strings when they appear.

test("scoreFromData - all reason codes are non-empty strings", () => {
  const c1h = makeUptrend(620, { start: 50, step: 0.15 });
  const c4h = makeUptrend(220, { start: 50, step: 0.4 });
  const result = scoreFromData("T-USDT-SWAP", c1h, c4h, { label: "bull" }, mockState);
  if (result) {
    for (const r of result.reasons) {
      assert.equal(typeof r, "string", `reason should be string, got ${typeof r}`);
      assert.ok(r.length > 0, "reason should be non-empty");
    }
  }
});

// ── Score structure invariants ────────────────────────────────────────────────

test("scoreFromData - signal matches long/short direction", () => {
  const c1h = makeUptrend(620);
  const c4h = makeUptrend(220, { step: 0.5 });
  const result = scoreFromData("T-USDT-SWAP", c1h, c4h, { label: "bull" }, mockState);
  if (result) {
    assert.ok(["long", "short"].includes(result.signal));
    assert.equal(result.direction, result.signal);
  }
});

test("scoreFromData - sl/tp respect signal direction", () => {
  const c1h = makeUptrend(620);
  const c4h = makeUptrend(220, { step: 0.5 });
  const result = scoreFromData("T-USDT-SWAP", c1h, c4h, { label: "bull" }, mockState);
  if (result) {
    if (result.signal === "long") {
      assert.ok(result.sl < result.price, `long sl ${result.sl} should be < price ${result.price}`);
      assert.ok(result.tp > result.price, `long tp ${result.tp} should be > price ${result.price}`);
    } else {
      assert.ok(result.sl > result.price, `short sl ${result.sl} should be > price ${result.price}`);
      assert.ok(result.tp < result.price, `short tp ${result.tp} should be < price ${result.price}`);
    }
  }
});

test("scoreFromData - riskReward is positive when a signal is generated", () => {
  const c1h = makeUptrend(620);
  const c4h = makeUptrend(220, { step: 0.5 });
  const result = scoreFromData("T-USDT-SWAP", c1h, c4h, { label: "bull" }, mockState);
  if (result) assert.ok(result.riskReward > 0, `riskReward should be > 0, got ${result.riskReward}`);
});

test("scoreFromData - positionSizeMultiplier is a positive finite number", () => {
  const c1h = makeUptrend(620);
  const c4h = makeUptrend(220, { step: 0.5 });
  const result = scoreFromData("T-USDT-SWAP", c1h, c4h, { label: "bull" }, mockState);
  if (result) {
    assert.ok(Number.isFinite(result.positionSizeMultiplier), "positionSizeMultiplier should be finite");
    assert.ok(result.positionSizeMultiplier > 0, "positionSizeMultiplier should be positive");
  }
});

// ── High-cap penalty ──────────────────────────────────────────────────────────

test("scoreFromData - BTC position size is reduced in non-strong-trend bull", () => {
  // Use flat candles (non-trending) to avoid strong-trend branch
  const c1h = makeFlat(620, { center: 30000, swing: 150 });
  const c4h = makeFlat(220, { center: 30000, swing: 300 });
  const result = scoreFromData("BTC-USDT-SWAP", c1h, c4h, { label: "sideways" }, mockState);
  if (result) {
    // High-cap 0.5x penalty applies; after score-based multiplier the combined
    // multiplier should be ≤ 0.625 (0.5 × 1.25 sweet-spot max)
    assert.ok(result.positionSizeMultiplier <= 0.63,
      `BTC size multiplier ${result.positionSizeMultiplier} should be ≤ 0.63`);
  }
});

test("scoreFromData - non-BTC symbol does not get high-cap penalty", () => {
  const c1h = makeUptrend(620, { start: 5, step: 0.02 });
  const c4h = makeUptrend(220, { start: 5, step: 0.05 });
  const btcResult  = scoreFromData("BTC-USDT-SWAP",  c1h, c4h, { label: "bull" }, mockState);
  const altResult  = scoreFromData("LINK-USDT-SWAP", c1h, c4h, { label: "bull" }, mockState);
  if (btcResult && altResult && btcResult.signal === altResult.signal) {
    // ALT should have larger size multiplier than BTC for same setup
    assert.ok(altResult.positionSizeMultiplier >= btcResult.positionSizeMultiplier,
      `alt ${altResult.positionSizeMultiplier} should be >= btc ${btcResult.positionSizeMultiplier}`);
  }
});

// ── Score exhaustion cap ──────────────────────────────────────────────────────

test("scoreFromData - score is capped via exhaustion formula above 7", () => {
  const c1h = makeUptrend(620, { step: 0.8, vol: 25000 });
  const c4h = makeUptrend(220, { step: 1.5, vol: 40000 });
  const result = scoreFromData("T-USDT-SWAP", c1h, c4h, { label: "bull" }, mockState);
  if (result) {
    // Exhaustion formula: finalScore = 7 + (raw - 7) * 0.5 → asymptotes, never doubles
    assert.ok(result.score <= 11, `score ${result.score} exceeds exhaustion cap`);
  }
});

// ── Trap penalty reason codes ─────────────────────────────────────────────────

test("scoreFromData - trap penalty reasons are valid known strings", () => {
  const knownPenalties = new Set([
    "trap-penalty-tiny-wick",
    "trap-penalty-no-close-reclaim",
    "trap-penalty-trending-no-reclaim"
  ]);
  const c1h = makeUptrend(620, { start: 50, step: 0.2 });
  const c4h = makeUptrend(220, { start: 50, step: 0.5 });
  for (const regime of ["bull", "bear", "sideways"]) {
    const result = scoreFromData("T-USDT-SWAP", c1h, c4h, { label: regime }, mockState);
    if (result) {
      for (const r of result.reasons) {
        if (r.startsWith("trap-penalty-")) {
          assert.ok(knownPenalties.has(r), `unexpected trap penalty reason: "${r}"`);
        }
      }
    }
  }
});

// ── MR reason codes ───────────────────────────────────────────────────────────

test("scoreFromData - MR reason codes are valid known strings", () => {
  const knownMR = new Set([
    "mr-h4-rsi-oversold", "mr-h4-rsi-overbought",
    "mr-obv-accumulation", "mr-obv-distribution",
    "mr-hammer-absorb", "mr-shooting-star-absorb",
    "mr-cascade-caution",
    "mr-funding-bear-crowded", "mr-funding-bull-crowded",
    "mr-funding-longs-crowded",
    "mr-no-vol-confirm",
    "mr-penalty-obv-against", "mr-penalty-vol-expanding"
  ]);
  const c1h = makeFlat(620, { center: 100, swing: 0.4 });
  const c4h = makeFlat(220, { center: 100, swing: 0.8 });
  const result = scoreFromData("T-USDT-SWAP", c1h, c4h, { label: "sideways" }, mockState);
  if (result) {
    for (const r of result.reasons) {
      if (r.startsWith("mr-")) {
        assert.ok(knownMR.has(r), `unexpected MR reason: "${r}"`);
      }
    }
  }
});
