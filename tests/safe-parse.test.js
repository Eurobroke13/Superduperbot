/**
 * Unit tests for bot/safe-parse.js
 * All three exports are pure string/object transformations — no I/O.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  safeParseClaudeJSON,
  validateBatchResponse,
  validateReevalResponse
} from "../bot/safe-parse.js";

// ── safeParseClaudeJSON ────────────────────────────────────────────────────────

test("safeParseClaudeJSON - happy path parses clean JSON", () => {
  const r = safeParseClaudeJSON('{"foo": 1}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { foo: 1 });
  assert.equal(r.error, null);
});

test("safeParseClaudeJSON - null/empty input → ok:false, empty-response", () => {
  assert.equal(safeParseClaudeJSON(null).ok, false);
  assert.equal(safeParseClaudeJSON("").ok, false);
  assert.equal(safeParseClaudeJSON(null).error, "empty-response");
});

test("safeParseClaudeJSON - strips markdown code fences", () => {
  const r = safeParseClaudeJSON('```json\n{"a": 2}\n```');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { a: 2 });
});

test("safeParseClaudeJSON - strips plain code fences", () => {
  const r = safeParseClaudeJSON('```\n{"b": 3}\n```');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { b: 3 });
});

test("safeParseClaudeJSON - extracts JSON from surrounding prose", () => {
  const r = safeParseClaudeJSON('Here is my analysis:\n{"approved": true}\nDone.');
  assert.equal(r.ok, true);
  assert.equal(r.data.approved, true);
});

test("safeParseClaudeJSON - recovers truncated JSON by closing open braces", () => {
  const r = safeParseClaudeJSON('{"key": "value"');
  assert.equal(r.ok, true);
  assert.equal(r.data.key, "value");
  assert.equal(r.error, "recovered-truncated");
});

test("safeParseClaudeJSON - recovers truncated nested JSON", () => {
  const r = safeParseClaudeJSON('{"outer": {"inner": 42}');
  assert.equal(r.ok, true);
  assert.equal(r.data.outer.inner, 42);
});

test("safeParseClaudeJSON - returns unparseable for garbage input", () => {
  const r = safeParseClaudeJSON("this is not json at all");
  assert.equal(r.ok, false);
  assert.equal(r.error, "unparseable");
});

test("safeParseClaudeJSON - non-string input → ok:false", () => {
  assert.equal(safeParseClaudeJSON(42).ok, false);
  assert.equal(safeParseClaudeJSON({}).ok, false);
});

// ── validateBatchResponse ──────────────────────────────────────────────────────

test("validateBatchResponse - null input → safe defaults", () => {
  const r = validateBatchResponse(null);
  assert.deepEqual(r.newsBlocked, []);
  assert.deepEqual(r.newsBoosted, []);
  assert.equal(r.newsSummary, "");
  assert.deepEqual(r.validations, {});
  assert.deepEqual(r.journals, {});
});

test("validateBatchResponse - extracts newsBlocked and newsBoosted", () => {
  const r = validateBatchResponse({
    news: { blocked: ["BTC-USDT-SWAP"], boosted: ["ETH-USDT-SWAP"], summary: "macro risk" }
  });
  assert.deepEqual(r.newsBlocked, ["BTC-USDT-SWAP"]);
  assert.deepEqual(r.newsBoosted, ["ETH-USDT-SWAP"]);
  assert.equal(r.newsSummary, "macro risk");
});

test("validateBatchResponse - filters non-string entries from news arrays", () => {
  const r = validateBatchResponse({
    news: { blocked: ["BTC", 123, null], boosted: [true, "ETH"] }
  });
  assert.deepEqual(r.newsBlocked, ["BTC"]);
  assert.deepEqual(r.newsBoosted, ["ETH"]);
});

test("validateBatchResponse - validates approved strictly as boolean true", () => {
  const r = validateBatchResponse({
    validations: {
      "BTC-USDT-SWAP": { approved: true, reason: "looks good" },
      "ETH-USDT-SWAP": { approved: 1, reason: "truthy but not true" },
      "SOL-USDT-SWAP": { approved: false, reason: "nope" }
    }
  });
  assert.equal(r.validations["BTC-USDT-SWAP"].approved, true);
  assert.equal(r.validations["ETH-USDT-SWAP"].approved, false); // 1 !== true
  assert.equal(r.validations["SOL-USDT-SWAP"].approved, false);
});

test("validateBatchResponse - fills missing symbols with not-in-claude-response", () => {
  const r = validateBatchResponse(
    { validations: { "BTC-USDT-SWAP": { approved: true, reason: "ok" } } },
    ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]
  );
  assert.equal(r.validations["BTC-USDT-SWAP"].approved, true);
  assert.equal(r.validations["ETH-USDT-SWAP"].approved, false);
  assert.equal(r.validations["ETH-USDT-SWAP"].reason, "not-in-claude-response");
});

test("validateBatchResponse - extracts journals section", () => {
  const r = validateBatchResponse({
    journals: { "BTC-USDT-SWAP": "Strong uptrend, high volume." }
  });
  assert.equal(r.journals["BTC-USDT-SWAP"], "Strong uptrend, high volume.");
});

test("validateBatchResponse - skips non-string journal values", () => {
  const r = validateBatchResponse({
    journals: { "BTC-USDT-SWAP": "valid", "ETH-USDT-SWAP": 42 }
  });
  assert.ok("BTC-USDT-SWAP" in r.journals);
  assert.ok(!("ETH-USDT-SWAP" in r.journals));
});

test("validateBatchResponse - missing reason field defaults to no-reason", () => {
  const r = validateBatchResponse({
    validations: { "BTC-USDT-SWAP": { approved: true } }
  });
  assert.equal(r.validations["BTC-USDT-SWAP"].reason, "no-reason");
});

// ── validateReevalResponse ─────────────────────────────────────────────────────

test("validateReevalResponse - null input → empty object", () => {
  assert.deepEqual(validateReevalResponse(null), {});
  assert.deepEqual(validateReevalResponse(undefined), {});
});

test("validateReevalResponse - maps valid hold/tighten/close actions", () => {
  const r = validateReevalResponse({
    "BTC-USDT-SWAP": "hold",
    "ETH-USDT-SWAP": "tighten",
    "SOL-USDT-SWAP": "close"
  });
  assert.equal(r["BTC-USDT-SWAP"], "hold");
  assert.equal(r["ETH-USDT-SWAP"], "tighten");
  assert.equal(r["SOL-USDT-SWAP"], "close");
});

test("validateReevalResponse - lowercases action strings", () => {
  const r = validateReevalResponse({ "BTC-USDT-SWAP": "HOLD" });
  assert.equal(r["BTC-USDT-SWAP"], "hold");
});

test("validateReevalResponse - skips invalid actions", () => {
  const r = validateReevalResponse({ "BTC-USDT-SWAP": "buy", "ETH-USDT-SWAP": "hold" });
  assert.ok(!("BTC-USDT-SWAP" in r));
  assert.equal(r["ETH-USDT-SWAP"], "hold");
});

test("validateReevalResponse - skips non-string values", () => {
  const r = validateReevalResponse({ "BTC-USDT-SWAP": 42, "ETH-USDT-SWAP": "close" });
  assert.ok(!("BTC-USDT-SWAP" in r));
  assert.equal(r["ETH-USDT-SWAP"], "close");
});
