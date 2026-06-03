/**
 * Tests for the second batch of phaseScan helpers extracted into runner-utils:
 *   applyMrGate, applyBearShort15m, routeToApprovalLists,
 *   applyClaudeSpendGuardrail, resolveClaudeValidations,
 *   resolveClaudeFallback, buildTopUnqualified
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBearShort15m,
  applyClaudeSpendGuardrail,
  applyMrGate,
  buildTopUnqualified,
  resolveClaudeFallback,
  resolveClaudeValidations,
  routeToApprovalLists
} from "../bot/runner-utils.js";

// ── applyMrGate ───────────────────────────────────────────────────────────────

test("applyMrGate - non-MR setup is a no-op", () => {
  const r = applyMrGate({ score: 6, setupType: "trend-following" }, () => {});
  assert.equal(r.blocked, false);
  assert.equal(r.blockReason, null);
});

test("applyMrGate - score=0 is a no-op regardless of setup", () => {
  const r = applyMrGate({ score: 0, setupType: "mean-reversion" }, () => assert.fail("should not call"));
  assert.equal(r.blocked, false);
});

test("applyMrGate - MR that fails gate returns blocked + blockReason", () => {
  const r = applyMrGate(
    { score: 5, setupType: "mean-reversion", _candles15m: null },
    () => ({ enter: false, reason: "no-bb-edge" })
  );
  assert.equal(r.blocked, true);
  assert.equal(r.blockReason, "mr-entry-gate:no-bb-edge");
});

test("applyMrGate - MR that passes returns adjustedScore + sizing", () => {
  const r = applyMrGate(
    { score: 5, setupType: "mean-reversion" },
    () => ({ enter: true, adjustedScore: 5.5, positionSizeMultiplier: 0.7, patterns: ["bb-oversold"] })
  );
  assert.equal(r.blocked, false);
  assert.equal(r.adjustedScore, 5.5);
  assert.equal(r.positionSizeMultiplier, 0.7);
  assert.deepEqual(r.patterns, ["bb-oversold"]);
});

// ── applyBearShort15m ─────────────────────────────────────────────────────────

test("applyBearShort15m - unconfirmed returns scoreFactor 0.85, no adjustedScore", () => {
  const r = applyBearShort15m({ score: 6 }, { enter: false, confidence: 0, positionSizeMultiplier: 1, patterns: [] });
  assert.equal(r.scoreFactor, 0.85);
  assert.equal(r.adjustedScore, undefined);
});

test("applyBearShort15m - confirmed returns factor 1 + score boost + sizing", () => {
  const r = applyBearShort15m(
    { score: 6 },
    { enter: true, confidence: 2, positionSizeMultiplier: 1.2, patterns: ["lower-high"] }
  );
  assert.equal(r.scoreFactor, 1);
  assert.equal(r.adjustedScore, 6.6);  // 6 + 2*0.3
  assert.equal(r.positionSizeMultiplier, 1.2);
  assert.deepEqual(r.patterns, ["lower-high"]);
});

// ── routeToApprovalLists ──────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    regime: { label: "bull" },
    state: { claudeValidations: {} },
    autoApproveSignalFn: () => false,
    checkCorrelationExposureFn: () => ({ allowed: true }),
    checkMinRRFn: () => ({ allowed: true }),
    shouldSkipClaudeFn: () => false,
    ...overrides
  };
}

test("routeToApprovalLists - auto-approvable goes to autoList", () => {
  const c = { symbol: "A", score: 7, signal: "long" };
  const { autoList, claudeList } = routeToApprovalLists([c], makeCtx({
    autoApproveSignalFn: () => true
  }));
  assert.deepEqual(autoList, [c]);
  assert.equal(claudeList.length, 0);
});

test("routeToApprovalLists - non-auto goes to claudeList", () => {
  const c = { symbol: "A", score: 6, signal: "long" };
  const { claudeList } = routeToApprovalLists([c], makeCtx());
  assert.deepEqual(claudeList, [c]);
});

test("routeToApprovalLists - correlation block produces skipped decision", () => {
  const c = { symbol: "A", score: 6 };
  const { decisions } = routeToApprovalLists([c], makeCtx({
    checkCorrelationExposureFn: () => ({ allowed: false, reason: "max-alts" })
  }));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "skipped");
  assert.equal(decisions[0].reason, "correlation-limit");
  assert.equal(decisions[0].extra.correlationBlocked, true);
});

test("routeToApprovalLists - RR block produces skipped decision", () => {
  const c = { symbol: "A", score: 6 };
  const { decisions } = routeToApprovalLists([c], makeCtx({
    checkMinRRFn: () => ({ allowed: false, reason: "rr-too-low" })
  }));
  assert.equal(decisions[0].reason, "min-rr");
});

test("routeToApprovalLists - cached-approved goes to autoList with approvalType", () => {
  const c = { symbol: "A", score: 6, signal: "long" };
  const { autoList } = routeToApprovalLists([c], makeCtx({
    shouldSkipClaudeFn: () => true,
    state: { claudeValidations: { A: { approved: true, ts: Date.now(), reason: "looks good" } } }
  }));
  assert.equal(autoList.length, 1);
  assert.equal(autoList[0].approvalType, "claude-cached");
});

test("routeToApprovalLists - cached-rejected produces rejected decision", () => {
  const c = { symbol: "A", score: 6 };
  const { decisions } = routeToApprovalLists([c], makeCtx({
    shouldSkipClaudeFn: () => true,
    state: { claudeValidations: { A: { approved: false, ts: Date.now(), reason: "risky" } } }
  }));
  assert.equal(decisions[0].outcome, "rejected");
  assert.equal(decisions[0].reason, "claude-cached-rejected");
});

// ── applyClaudeSpendGuardrail ─────────────────────────────────────────────────

test("applyClaudeSpendGuardrail - normal spend returns 'normal', no mutation", () => {
  const cl = [{ symbol: "A" }], auto = [];
  const mode = applyClaudeSpendGuardrail(cl, auto, { spend: 10, budget: 40 });
  assert.equal(mode, "normal");
  assert.equal(cl.length, 1);
  assert.equal(auto.length, 0);
});

test("applyClaudeSpendGuardrail - 90%+ returns 'warning', moves claudeList to auto", () => {
  const cl = [{ symbol: "A" }], auto = [];
  const mode = applyClaudeSpendGuardrail(cl, auto, { spend: 36, budget: 40 });
  assert.equal(mode, "warning");
  assert.equal(cl.length, 0);
  assert.equal(auto.length, 1);
  assert.equal(auto[0].approvalType, "auto-budget-warning");
});

test("applyClaudeSpendGuardrail - 100%+ returns 'exceeded'", () => {
  const cl = [{ symbol: "A" }], auto = [];
  const mode = applyClaudeSpendGuardrail(cl, auto, { spend: 40, budget: 40 });
  assert.equal(mode, "exceeded");
  assert.equal(cl.length, 0);
  assert.equal(auto[0].approvalType, "auto-budget-exceeded");
});

test("applyClaudeSpendGuardrail - zero budget is always normal", () => {
  const cl = [{ symbol: "A" }], auto = [];
  const mode = applyClaudeSpendGuardrail(cl, auto, { spend: 999, budget: 0 });
  assert.equal(mode, "normal");
});

// ── resolveClaudeValidations ──────────────────────────────────────────────────

test("resolveClaudeValidations - approved candidate has action=stage", () => {
  const cl = [{ symbol: "A", signal: "long", score: 6, setupType: "t", reasons: [] }];
  const result = { validations: { A: { approved: true, reason: "bullish breakout" } } };
  const { cacheEntries, routing } = resolveClaudeValidations(cl, result, {
    getSetupFingerprintFn: c => `fp:${c.symbol}`
  });
  assert.equal(cacheEntries.A.approved, true);
  assert.equal(routing[0].action, "stage");
  assert.equal(routing[0].claudeReason, "bullish breakout");
});

test("resolveClaudeValidations - rejected candidate has action=rejected", () => {
  const cl = [{ symbol: "B", signal: "short", score: 5, setupType: "t", reasons: [] }];
  const result = { validations: { B: { approved: false, reason: "weak signal" } } };
  const { routing } = resolveClaudeValidations(cl, result, {
    getSetupFingerprintFn: () => "fp"
  });
  assert.equal(routing[0].action, "rejected");
  assert.equal(routing[0].claudeReason, "weak signal");
});

test("resolveClaudeValidations - auto-fallback reason produces fallback-rejected action", () => {
  const cl = [{ symbol: "C", signal: "long", score: 5, setupType: "t", reasons: [] }];
  const result = { validations: { C: { approved: false, reason: "auto-fallback" } } };
  const { routing } = resolveClaudeValidations(cl, result, {
    getSetupFingerprintFn: () => "fp"
  });
  assert.equal(routing[0].action, "fallback-rejected");
});

// ── resolveClaudeFallback ─────────────────────────────────────────────────────

test("resolveClaudeFallback - high-score auto-approvable gets action=stage", () => {
  const cl = [{ symbol: "A", score: 10, signal: "long" }];
  const routing = resolveClaudeFallback(cl, {
    regime: { label: "bull" },
    autoApproveSignalFn: () => true,
    scoreThreshold: 9
  });
  assert.equal(routing[0].action, "stage");
});

test("resolveClaudeFallback - low-score gets fallback-rejected", () => {
  const cl = [{ symbol: "A", score: 5, signal: "long" }];
  const routing = resolveClaudeFallback(cl, {
    regime: { label: "bull" },
    autoApproveSignalFn: () => false,
    scoreThreshold: 9
  });
  assert.equal(routing[0].action, "fallback-rejected");
  assert.equal(routing[0].claudeReason, "auto-fallback-rejected");
});

// ── buildTopUnqualified ───────────────────────────────────────────────────────

test("buildTopUnqualified - returns top 5 non-qualified by score desc", () => {
  const candidates = [5, 3, 7, 1, 9, 6, 4].map((score, i) => ({
    symbol: `S${i}`, signal: "long", score
  }));
  const qualifiedSet = new Set(["S4"]); // score=9 is "qualified", skip it
  const result = buildTopUnqualified(candidates, qualifiedSet, (v) => v);
  assert.equal(result.length, 5);
  assert.equal(result[0].score, 7);   // highest unqualified
  assert.ok(!result.find(r => r.symbol === "S4"), "qualified symbol excluded");
});

test("buildTopUnqualified - fewer than 5 unqualified returns all", () => {
  const candidates = [{ symbol: "A", signal: "long", score: 5 }];
  const result = buildTopUnqualified(candidates, new Set(), v => v);
  assert.equal(result.length, 1);
});
