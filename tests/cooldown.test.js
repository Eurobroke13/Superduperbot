/**
 * Unit tests for bot/cooldown.js
 * Pure state-mutation logic — no I/O.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  registerExit,
  registerOverboughtExit,
  isOnCooldown,
  pruneExpired,
  initCooldowns
} from "../bot/cooldown.js";

const msAgo = ms => new Date(Date.now() - ms).toISOString();
const msFromNow = ms => new Date(Date.now() + ms).toISOString();

// ── registerExit ───────────────────────────────────────────────────────────────

test("registerExit - take-profit-full triggers cooldown", () => {
  const cooldowns = {};
  const r = registerExit(cooldowns, { symbol: "BTC-USDT-SWAP", reason: "take-profit-full", closedAt: new Date().toISOString() });
  assert.equal(r.applied, true);
  assert.ok(cooldowns["BTC-USDT-SWAP"]?.expiresAt);
});

test("registerExit - take-profit-hit triggers cooldown", () => {
  const cooldowns = {};
  const r = registerExit(cooldowns, { symbol: "ETH-USDT-SWAP", reason: "take-profit-hit", closedAt: new Date().toISOString() });
  assert.equal(r.applied, true);
});

test("registerExit - stop-loss does NOT trigger cooldown", () => {
  const cooldowns = {};
  const r = registerExit(cooldowns, { symbol: "BTC-USDT-SWAP", reason: "stop-loss", closedAt: new Date().toISOString() });
  assert.equal(r.applied, false);
  assert.equal(cooldowns["BTC-USDT-SWAP"], undefined);
});

test("registerExit - mr-time-expired does NOT trigger cooldown", () => {
  const cooldowns = {};
  const r = registerExit(cooldowns, { symbol: "BTC-USDT-SWAP", reason: "mr-time-expired", closedAt: new Date().toISOString() });
  assert.equal(r.applied, false);
});

test("registerExit - expiry is at least 4h in the future", () => {
  const cooldowns = {};
  registerExit(cooldowns, { symbol: "BTC-USDT-SWAP", reason: "take-profit-full", closedAt: new Date().toISOString() });
  const expiryMs = new Date(cooldowns["BTC-USDT-SWAP"].expiresAt).getTime();
  assert.ok(expiryMs > Date.now() + 4 * 60 * 60 * 1000 - 1000); // at least ~4h from now
});

// ── registerOverboughtExit ─────────────────────────────────────────────────────

test("registerOverboughtExit - stop-loss with overbought signal triggers 6h cooldown", () => {
  const cooldowns = {};
  const r = registerOverboughtExit(cooldowns, {
    symbol: "BTC-USDT-SWAP", reason: "stop-loss",
    closedAt: new Date().toISOString(),
    reasons: ["trend-vs-overbought", "ema-ribbon"]
  });
  assert.equal(r.applied, true);
  assert.ok(cooldowns["BTC-USDT-SWAP"]?.expiresAt);
});

test("registerOverboughtExit - stop-loss without overbought signal → no cooldown", () => {
  const cooldowns = {};
  const r = registerOverboughtExit(cooldowns, {
    symbol: "BTC-USDT-SWAP", reason: "stop-loss",
    closedAt: new Date().toISOString(),
    reasons: ["ema-ribbon", "adx-strong-bull"]
  });
  assert.equal(r.applied, false);
});

test("registerOverboughtExit - take-profit reason → no cooldown regardless of signals", () => {
  const cooldowns = {};
  const r = registerOverboughtExit(cooldowns, {
    symbol: "BTC-USDT-SWAP", reason: "take-profit-full",
    closedAt: new Date().toISOString(),
    reasons: ["trend-vs-overbought"]
  });
  assert.equal(r.applied, false);
});

test("registerOverboughtExit - does not overwrite a longer existing cooldown", () => {
  const longExpiry = msFromNow(12 * 60 * 60 * 1000); // 12h from now
  const cooldowns = { "BTC-USDT-SWAP": { expiresAt: longExpiry } };
  const r = registerOverboughtExit(cooldowns, {
    symbol: "BTC-USDT-SWAP", reason: "stop-loss",
    closedAt: new Date().toISOString(),
    reasons: ["trend-vs-overbought"]
  });
  assert.equal(r.applied, false);
  assert.equal(cooldowns["BTC-USDT-SWAP"].expiresAt, longExpiry); // unchanged
});

test("registerOverboughtExit - trend-vs-oversold also triggers cooldown", () => {
  const cooldowns = {};
  const r = registerOverboughtExit(cooldowns, {
    symbol: "ETH-USDT-SWAP", reason: "stop-loss",
    closedAt: new Date().toISOString(),
    reasons: ["trend-vs-oversold"]
  });
  assert.equal(r.applied, true);
});

// ── isOnCooldown ───────────────────────────────────────────────────────────────

test("isOnCooldown - symbol with future expiry is on cooldown", () => {
  const cooldowns = { "BTC-USDT-SWAP": { expiresAt: msFromNow(60 * 60 * 1000) } };
  const r = isOnCooldown(cooldowns, "BTC-USDT-SWAP");
  assert.equal(r.onCooldown, true);
  assert.ok(r.expiresAt);
});

test("isOnCooldown - symbol not in cooldowns → not on cooldown", () => {
  const r = isOnCooldown({}, "ETH-USDT-SWAP");
  assert.equal(r.onCooldown, false);
});

test("isOnCooldown - expired cooldown is cleared and returns not-on-cooldown", () => {
  const cooldowns = { "BTC-USDT-SWAP": { expiresAt: msAgo(60 * 60 * 1000) } };
  const r = isOnCooldown(cooldowns, "BTC-USDT-SWAP");
  assert.equal(r.onCooldown, false);
  assert.equal(cooldowns["BTC-USDT-SWAP"], undefined); // cleared
});

test("isOnCooldown - null/empty cooldowns object → not on cooldown", () => {
  assert.equal(isOnCooldown(null, "BTC-USDT-SWAP").onCooldown, false);
  assert.equal(isOnCooldown({}, "BTC-USDT-SWAP").onCooldown, false);
});

test("isOnCooldown - custom `now` respected", () => {
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const cooldowns = { "BTC-USDT-SWAP": { expiresAt } };
  // check from 3h in the future → should be expired
  const future = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const r = isOnCooldown(cooldowns, "BTC-USDT-SWAP", future);
  assert.equal(r.onCooldown, false);
});

// ── pruneExpired ───────────────────────────────────────────────────────────────

test("pruneExpired - removes expired entries and returns their symbols", () => {
  const cooldowns = {
    "BTC-USDT-SWAP": { expiresAt: msAgo(10000) },     // expired
    "ETH-USDT-SWAP": { expiresAt: msFromNow(10000) }  // still active
  };
  const cleared = pruneExpired(cooldowns);
  assert.ok(cleared.includes("BTC-USDT-SWAP"));
  assert.equal(cooldowns["BTC-USDT-SWAP"], undefined);
  assert.ok(cooldowns["ETH-USDT-SWAP"]); // untouched
});

test("pruneExpired - empty cooldowns returns empty array", () => {
  assert.deepEqual(pruneExpired({}), []);
});

test("pruneExpired - null cooldowns returns empty array without throwing", () => {
  assert.deepEqual(pruneExpired(null), []);
});

test("pruneExpired - does not clear active cooldowns", () => {
  const cooldowns = { "BTC-USDT-SWAP": { expiresAt: msFromNow(60000) } };
  pruneExpired(cooldowns);
  assert.ok(cooldowns["BTC-USDT-SWAP"]);
});

// ── initCooldowns ──────────────────────────────────────────────────────────────

test("initCooldowns - initializes missing cooldowns object", () => {
  const state = {};
  initCooldowns(state);
  assert.deepEqual(state.cooldowns, {});
});

test("initCooldowns - does not overwrite existing cooldowns", () => {
  const existing = { "BTC-USDT-SWAP": { expiresAt: "2099-01-01T00:00:00.000Z" } };
  const state = { cooldowns: existing };
  initCooldowns(state);
  assert.equal(state.cooldowns, existing); // same reference
});
