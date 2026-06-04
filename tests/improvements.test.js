/**
 * Unit tests for the five "next level" improvements:
 * 1. buildRegimeConsensus  (runner-utils.js)
 * 2. trimToClosedCandles   (runner-utils.js)
 * 3. computeKellySizing    (stats.js)
 * 4. trackAtrHistory       (stats.js)
 * 5. getSignalDegradationAlerts (stats.js)
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildRegimeConsensus, trimToClosedCandles } from "../bot/runner-utils.js";
import {
  computeKellySizing,
  trackAtrHistory,
  getSignalDegradationAlerts
} from "../bot/stats.js";

// ── buildRegimeConsensus ───────────────────────────────────────────────────────

test("buildRegimeConsensus - 3/3 agree bear + high markov → bear", () => {
  const r = buildRegimeConsensus("bear", "bear", "bear", 0.70);
  assert.equal(r.label, "bear");
});

test("buildRegimeConsensus - 2/3 bear + high markov → bear", () => {
  const r = buildRegimeConsensus("bear", "bear", "sideways", 0.60);
  assert.equal(r.label, "bear");
});

test("buildRegimeConsensus - 2/3 bear but low markov → sideways (not confirmed)", () => {
  const r = buildRegimeConsensus("bear", "bear", "sideways", 0.45);
  assert.equal(r.label, "sideways");
});

test("buildRegimeConsensus - only daily says bear (4H and 1H both say bull) → bull wins", () => {
  // 2 bull votes vs 1 bear vote: bull majority wins
  const r = buildRegimeConsensus("bear", "bull", "bull", 0.70);
  assert.equal(r.label, "bull");
});

test("buildRegimeConsensus - 3/3 agree bull → bull", () => {
  const r = buildRegimeConsensus("bull", "bull", "bull", 0.65);
  assert.equal(r.label, "bull");
});

test("buildRegimeConsensus - 2/3 bull → bull", () => {
  const r = buildRegimeConsensus("bull", "bull", "sideways", 0.50);
  assert.equal(r.label, "bull");
});

test("buildRegimeConsensus - all three disagree → sideways", () => {
  const r = buildRegimeConsensus("bear", "bull", "sideways", 0.55);
  assert.equal(r.label, "sideways");
});

test("buildRegimeConsensus - includes consensus string and votes", () => {
  const r = buildRegimeConsensus("bear", "bear", "bull", 0.60);
  assert.ok(typeof r.consensus === "string");
  assert.ok(typeof r.votes.bear === "number");
  assert.ok(typeof r.votes.bull === "number");
  assert.equal(r.votes.bear, 2);
  assert.equal(r.votes.bull, 1);
});

// ── trimToClosedCandles ────────────────────────────────────────────────────────

const H1_MS = 60 * 60 * 1000;
const CONFIRM_MS = 15 * 60 * 1000;

function makeCandles(n, lastOpenTime) {
  return Array.from({ length: n }, (_, i) => ({
    time: lastOpenTime - (n - 1 - i) * H1_MS,
    close: 100 + i
  }));
}

test("trimToClosedCandles - removes last candle when still forming", () => {
  // Last candle opened just now — close not confirmed
  const now = Date.now();
  const candles = makeCandles(10, now - 5 * 60 * 1000); // opened 5 min ago
  const result = trimToClosedCandles(candles, H1_MS, CONFIRM_MS);
  assert.equal(result.length, 9);
  assert.equal(result[result.length - 1].time, candles[8].time);
});

test("trimToClosedCandles - keeps all candles when last is confirmed closed", () => {
  const now = Date.now();
  // Last candle opened 75 min ago → close at 60min + 15min confirm = 75min ago is exactly at boundary
  // Use 80 min ago to be safely past
  const candles = makeCandles(10, now - 80 * 60 * 1000);
  const result = trimToClosedCandles(candles, H1_MS, CONFIRM_MS);
  assert.equal(result.length, 10);
});

test("trimToClosedCandles - handles empty array", () => {
  assert.deepEqual(trimToClosedCandles([], H1_MS), []);
});

test("trimToClosedCandles - handles null", () => {
  assert.deepEqual(trimToClosedCandles(null, H1_MS), []);
});

test("trimToClosedCandles - single candle array returns it unchanged (needs ≥2 to trim)", () => {
  // With only 1 candle, we can't drop it — would leave nothing to score
  const candles = [{ time: Date.now() - 1000, close: 100 }];
  const result = trimToClosedCandles(candles, H1_MS, CONFIRM_MS);
  assert.equal(result.length, 1);
});

// ── computeKellySizing ─────────────────────────────────────────────────────────

test("computeKellySizing - no stats returns mult:1.0", () => {
  const r = computeKellySizing(null, 2, []);
  assert.equal(r.mult, 1.0);
});

test("computeKellySizing - fewer than 20 trades returns mult:1.0", () => {
  const r = computeKellySizing({ count: 15, winRate: 0.6, avgWin: 10, avgLoss: 5 }, 2, []);
  assert.equal(r.mult, 1.0);
});

test("computeKellySizing - zero avgLoss returns mult:1.0 (no data)", () => {
  const r = computeKellySizing({ count: 30, winRate: 0.6, avgWin: 10, avgLoss: 0 }, 2, []);
  assert.equal(r.mult, 1.0);
});

test("computeKellySizing - strong WR and good avgWin/avgLoss → mult > 1", () => {
  // Kelly: b=2, p=0.65, q=0.35 → f = (2*0.65 - 0.35)/2 = 0.475, half=0.2375
  // kellyMult = 0.2375 / 0.03 ≈ 7.9 → clamped to 1.5
  const r = computeKellySizing({ count: 30, winRate: 0.65, avgWin: 20, avgLoss: 10 }, 2, []);
  assert.ok(r.mult > 1.0, `expected mult > 1, got ${r.mult}`);
  assert.ok(r.mult <= 1.5);
});

test("computeKellySizing - bad WR → mult < 1", () => {
  // Kelly: b=0.5, p=0.30, q=0.70 → f = (0.5*0.30 - 0.70)/0.5 = -1.1 → negative → clamp to 0.5
  const r = computeKellySizing({ count: 30, winRate: 0.30, avgWin: 5, avgLoss: 10 }, 2, []);
  assert.ok(r.mult <= 0.6, `expected mult ≤ 0.6, got ${r.mult}`);
});

test("computeKellySizing - mult is always clamped to [0.5, 1.5]", () => {
  const extremeGood = computeKellySizing({ count: 100, winRate: 0.99, avgWin: 100, avgLoss: 1 }, 1, []);
  const extremeBad  = computeKellySizing({ count: 100, winRate: 0.01, avgWin: 1, avgLoss: 100 }, 1, []);
  assert.ok(extremeGood.mult <= 1.5);
  assert.ok(extremeBad.mult >= 0.5);
});

test("computeKellySizing - high ATR relative to history reduces mult", () => {
  const stats = { count: 30, winRate: 0.55, avgWin: 10, avgLoss: 8 };
  const normalHistory = Array.from({ length: 20 }, () => 2); // median = 2
  const normalResult = computeKellySizing(stats, 2, normalHistory);
  const highVolResult = computeKellySizing(stats, 4, normalHistory); // 2x normal ATR
  assert.ok(highVolResult.mult < normalResult.mult, "high ATR should reduce size");
});

test("computeKellySizing - compressed ATR (low vol) increases mult", () => {
  const stats = { count: 30, winRate: 0.55, avgWin: 10, avgLoss: 8 };
  const normalHistory = Array.from({ length: 20 }, () => 2); // median = 2
  const normalResult = computeKellySizing(stats, 2, normalHistory);
  const lowVolResult  = computeKellySizing(stats, 1, normalHistory); // 0.5× normal
  assert.ok(lowVolResult.mult >= normalResult.mult, "low ATR should not reduce size");
});

test("computeKellySizing - includes reason string", () => {
  const stats = { count: 30, winRate: 0.55, avgWin: 10, avgLoss: 8 };
  const r = computeKellySizing(stats, 2, []);
  assert.ok(typeof r.reason === "string");
  assert.ok(r.reason.includes("kelly:"));
});

// ── trackAtrHistory ────────────────────────────────────────────────────────────

test("trackAtrHistory - initialises atrHistory on state", () => {
  const state = {};
  trackAtrHistory(state, "BTC-USDT-SWAP", 2.5);
  assert.ok(state.atrHistory);
  assert.ok(state.atrHistory["BTC-USDT-SWAP"]);
  assert.equal(state.atrHistory["BTC-USDT-SWAP"][0], 2.5);
});

test("trackAtrHistory - appends to existing history", () => {
  const state = {};
  trackAtrHistory(state, "BTC-USDT-SWAP", 2.0);
  trackAtrHistory(state, "BTC-USDT-SWAP", 3.0);
  assert.equal(state.atrHistory["BTC-USDT-SWAP"].length, 2);
});

test("trackAtrHistory - caps at 30 entries", () => {
  const state = {};
  for (let i = 0; i < 35; i++) trackAtrHistory(state, "BTC-USDT-SWAP", i + 1);
  assert.equal(state.atrHistory["BTC-USDT-SWAP"].length, 30);
  assert.equal(state.atrHistory["BTC-USDT-SWAP"][0], 6); // oldest kept
});

test("trackAtrHistory - ignores invalid values", () => {
  const state = {};
  trackAtrHistory(state, "BTC-USDT-SWAP", 0);
  trackAtrHistory(state, "BTC-USDT-SWAP", NaN);
  trackAtrHistory(state, "BTC-USDT-SWAP", -1);
  assert.equal(state.atrHistory, undefined); // nothing was stored
});

test("trackAtrHistory - tracks different symbols independently", () => {
  const state = {};
  trackAtrHistory(state, "BTC-USDT-SWAP", 2.0);
  trackAtrHistory(state, "ETH-USDT-SWAP", 0.5);
  assert.equal(state.atrHistory["BTC-USDT-SWAP"][0], 2.0);
  assert.equal(state.atrHistory["ETH-USDT-SWAP"][0], 0.5);
});

// ── getSignalDegradationAlerts ─────────────────────────────────────────────────

test("getSignalDegradationAlerts - returns empty when no signalStats", () => {
  const state = {};
  assert.deepEqual(getSignalDegradationAlerts(state), []);
});

test("getSignalDegradationAlerts - returns empty when all signals healthy", () => {
  const state = { signalStats: { "ema-ribbon": { count: 30, wins: 20 } } };
  assert.deepEqual(getSignalDegradationAlerts(state), []);
});

test("getSignalDegradationAlerts - fires alert when WR < 35% with 20+ trades", () => {
  const state = { signalStats: { "bad-signal": { count: 25, wins: 8 } } }; // WR=32%
  const alerts = getSignalDegradationAlerts(state);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes("bad-signal"));
});

test("getSignalDegradationAlerts - does not fire for signals with < 20 trades", () => {
  const state = { signalStats: { "new-signal": { count: 10, wins: 2 } } }; // WR=20% but too few
  const alerts = getSignalDegradationAlerts(state);
  assert.equal(alerts.length, 0);
});

test("getSignalDegradationAlerts - custom threshold respected", () => {
  const state = { signalStats: { "mediocre": { count: 30, wins: 13 } } }; // WR=43%
  // Default threshold 35% — 43% is fine
  assert.equal(getSignalDegradationAlerts(state).length, 0);
  // Custom threshold 50% — 43% triggers alert
  assert.equal(getSignalDegradationAlerts(state, { wrThreshold: 0.50 }).length, 1);
});
