// =============================================================================
// SAFE CLAUDE PARSER — resilient JSON extraction from Claude responses
//
// Problem: Claude sometimes returns malformed JSON, extra prose before/after
// the JSON, or truncated output when token-limited. The current code does
// a bare JSON.parse() which throws and falls back to auto-approve score>=9.
//
// This module:
//   1. Extracts JSON from Claude's response even if surrounded by prose
//   2. Validates the shape matches what we expect
//   3. Provides per-field fallbacks instead of all-or-nothing failure
//   4. Logs parse failures for debugging
// =============================================================================

/**
 * Extract and parse JSON from a Claude response string.
 * Handles common failure modes:
 *   - JSON wrapped in markdown code fences
 *   - Prose text before/after the JSON
 *   - Truncated JSON (attempts recovery)
 *   - Multiple JSON objects (takes the first valid one)
 */
export function safeParseClaudeJSON(raw) {
  if (!raw || typeof raw !== "string") {
    return { ok: false, data: null, error: "empty-response" };
  }

  let text = raw.trim();

  // Strip markdown code fences
  text = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
  text = text.replace(/^```\s*/i, "").replace(/```\s*$/i, "");

  // Try direct parse first (happy path)
  try {
    const data = JSON.parse(text);
    return { ok: true, data, error: null };
  } catch (_) {
    // Continue to recovery strategies
  }

  // Strategy 1: Find the outermost { } pair
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const data = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      return { ok: true, data, error: null };
    } catch (_) {
      // Continue
    }
  }

  // Strategy 2: Truncated JSON recovery — close open braces/brackets
  if (firstBrace !== -1) {
    let candidate = text.slice(firstBrace);
    // Count unclosed braces and brackets
    let braces = 0, brackets = 0;
    let inString = false, escaped = false;
    for (const ch of candidate) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") braces++;
      if (ch === "}") braces--;
      if (ch === "[") brackets++;
      if (ch === "]") brackets--;
    }

    // Close any unclosed strings, arrays, objects
    if (inString) candidate += '"';
    while (brackets > 0) { candidate += "]"; brackets--; }
    while (braces > 0) { candidate += "}"; braces--; }

    try {
      const data = JSON.parse(candidate);
      return { ok: true, data, error: "recovered-truncated" };
    } catch (_) {
      // Give up
    }
  }

  return { ok: false, data: null, error: "unparseable" };
}

/**
 * Validate and normalize a Claude batch analysis response.
 * Ensures every expected field exists with correct types.
 * Missing fields get safe defaults instead of crashing the caller.
 */
export function validateBatchResponse(parsed, candidateSymbols = []) {
  const result = {
    newsBlocked: [],
    newsBoosted: [],
    newsSummary: "",
    validations: {},
    journals: {}
  };

  if (!parsed || typeof parsed !== "object") return result;

  // News section
  if (parsed.news && typeof parsed.news === "object") {
    result.newsBlocked = Array.isArray(parsed.news.blocked)
      ? parsed.news.blocked.filter(s => typeof s === "string")
      : [];
    result.newsBoosted = Array.isArray(parsed.news.boosted)
      ? parsed.news.boosted.filter(s => typeof s === "string")
      : [];
    result.newsSummary = typeof parsed.news.summary === "string"
      ? parsed.news.summary
      : "";
  }

  // Validations section
  if (parsed.validations && typeof parsed.validations === "object") {
    for (const [symbol, val] of Object.entries(parsed.validations)) {
      if (!val || typeof val !== "object") continue;
      result.validations[symbol] = {
        approved: val.approved === true, // strict boolean check
        reason: typeof val.reason === "string" ? val.reason : "no-reason"
      };
    }
  }

  // Journals section
  if (parsed.journals && typeof parsed.journals === "object") {
    for (const [symbol, journal] of Object.entries(parsed.journals)) {
      if (typeof journal === "string") {
        result.journals[symbol] = journal;
      }
    }
  }

  // Fill in missing validations with "not-evaluated" rather than auto-approve
  for (const symbol of candidateSymbols) {
    if (!result.validations[symbol]) {
      result.validations[symbol] = {
        approved: false,
        reason: "not-in-claude-response"
      };
    }
  }

  return result;
}

/**
 * Validate reevaluation response (simpler: { "SYM": "hold"|"tighten"|"close" })
 */
export function validateReevalResponse(parsed) {
  const result = {};
  if (!parsed || typeof parsed !== "object") return result;

  const validActions = new Set(["hold", "tighten", "close"]);
  for (const [symbol, action] of Object.entries(parsed)) {
    if (typeof action === "string" && validActions.has(action.toLowerCase())) {
      result[symbol] = action.toLowerCase();
    }
  }
  return result;
}

/**
 * Drop-in replacement for the claudeBatchAnalysis JSON parsing block.
 *
 * Before (fragile):
 *   const parsed = JSON.parse(raw);
 *
 * After (resilient):
 *   const { ok, data, error } = safeParseClaudeJSON(raw);
 *   if (!ok) {
 *     console.warn("[CLAUDE] Parse failed:", error, "raw:", raw.slice(0, 200));
 *     return fallbackResult(candidatesToValidate);
 *   }
 *   const result = validateBatchResponse(data, candidateSymbols);
 */
