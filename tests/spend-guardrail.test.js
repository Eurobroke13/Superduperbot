import assert from "node:assert/strict";
import test from "node:test";
import { claudeSpendMode } from "../bot/runner-utils.js";

test("claudeSpendMode - normal when well under budget", () => {
  assert.equal(claudeSpendMode(10, 100), "normal");
});

test("claudeSpendMode - normal at exactly 89%", () => {
  assert.equal(claudeSpendMode(89, 100), "normal");
});

test("claudeSpendMode - warning at exactly 90%", () => {
  assert.equal(claudeSpendMode(90, 100), "warning");
});

test("claudeSpendMode - warning at 95%", () => {
  assert.equal(claudeSpendMode(95, 100), "warning");
});

test("claudeSpendMode - warning at 99%", () => {
  assert.equal(claudeSpendMode(99, 100), "warning");
});

test("claudeSpendMode - exceeded at exactly 100%", () => {
  assert.equal(claudeSpendMode(100, 100), "exceeded");
});

test("claudeSpendMode - exceeded when over budget", () => {
  assert.equal(claudeSpendMode(150, 100), "exceeded");
});

test("claudeSpendMode - normal when budget is 0 (disabled)", () => {
  assert.equal(claudeSpendMode(999, 0), "normal");
});

test("claudeSpendMode - zero spend is always normal", () => {
  assert.equal(claudeSpendMode(0, 100), "normal");
});

test("claudeSpendMode - fractional boundaries are handled correctly", () => {
  // 0.9 * budget exactly
  assert.equal(claudeSpendMode(45, 50), "warning");
  // Just under 0.9
  assert.equal(claudeSpendMode(44.9, 50), "normal");
  // Just at 1.0
  assert.equal(claudeSpendMode(50, 50), "exceeded");
});
