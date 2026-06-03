/**
 * Tests for rankTradeable — the pure scan-ordering transform extracted from
 * phaseScan. runner-utils.js is DB-free so a plain import works.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rankTradeable } from "../bot/runner-utils.js";

test("rankTradeable - empty / nullish input returns empty array", () => {
  assert.deepEqual(rankTradeable([], {}), []);
  assert.deepEqual(rankTradeable(undefined, {}), []);
});

test("rankTradeable - orders by volume when no move data", () => {
  const tradeable = ["A", "B", "C"];
  const volumeMap = { A: 1_000_000, B: 5_000_000, C: 2_000_000 };
  const ranked = rankTradeable(tradeable, { volumeMap, regimeLabel: "bull" });
  assert.deepEqual(ranked, ["B", "C", "A"]);
});

test("rankTradeable - sideways weights 24h movement heavily", () => {
  const tradeable = ["BIGVOL", "BIGMOVE"];
  const volumeMap = { BIGVOL: 5_000_000, BIGMOVE: 1_000_000 };
  const tickerMap = {
    BIGVOL:  { last: 100, open24h: 100 },     // 0% move -> rankScore = 5
    BIGMOVE: { last: 110, open24h: 100 }       // 10% move -> 1 + (10*1.5)=16
  };
  const ranked = rankTradeable(tradeable, { tickerMap, volumeMap, regimeLabel: "sideways" });
  assert.deepEqual(ranked, ["BIGMOVE", "BIGVOL"]);
});

test("rankTradeable - non-sideways down-weights movement (volume wins)", () => {
  const tradeable = ["BIGVOL", "BIGMOVE"];
  const volumeMap = { BIGVOL: 5_000_000, BIGMOVE: 1_000_000 };
  const tickerMap = {
    BIGVOL:  { last: 100, open24h: 100 },      // rankScore = 5
    BIGMOVE: { last: 110, open24h: 100 }        // 1 + (10*0.3)=4
  };
  const ranked = rankTradeable(tradeable, { tickerMap, volumeMap, regimeLabel: "bull" });
  assert.deepEqual(ranked, ["BIGVOL", "BIGMOVE"]);
});

test("rankTradeable - handles alternate open-24h field names", () => {
  const tradeable = ["X", "Y"];
  const volumeMap = { X: 1_000_000, Y: 1_000_000 };
  const tickerMap = {
    X: { last: 120, open_24h: 100 },       // snake_case
    Y: { last: 100, open24hPrice: 100 }     // camelPrice
  };
  const ranked = rankTradeable(tradeable, { tickerMap, volumeMap, regimeLabel: "sideways" });
  // X has 20% move -> ranks above Y (0% move)
  assert.deepEqual(ranked, ["X", "Y"]);
});

test("rankTradeable - missing ticker/volume entries default to zero, no crash", () => {
  const ranked = rankTradeable(["A", "B"], { regimeLabel: "bull" });
  assert.equal(ranked.length, 2);
  assert.ok(ranked.includes("A") && ranked.includes("B"));
});

test("rankTradeable - guards against zero/negative open price (no divide-by-zero)", () => {
  const tradeable = ["Z"];
  const tickerMap = { Z: { last: 100, open24h: 0 } };
  const volumeMap = { Z: 3_000_000 };
  const ranked = rankTradeable(tradeable, { tickerMap, volumeMap, regimeLabel: "sideways" });
  // movePct treated as 0 -> rankScore finite, symbol still present
  assert.deepEqual(ranked, ["Z"]);
});
