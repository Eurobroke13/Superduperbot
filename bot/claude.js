import { ANTHROPIC_API, CLAUDE_MODEL, MONTHLY_BUDGET_USD } from "./config.js";
import { estimateMonthlySpend } from "./stats.js";

// A stalled request with no timeout can park the whole run forever (this
// wedged the fast-scan cron for 8+ hours on 2026-07-02). 120s covers the
// slowest legitimate batch call (4000 max_tokens); on abort the throw lands
// in claudeBatchAnalysis's error path, which fail-safes to rejecting all
// candidates rather than hanging or auto-approving.
const CLAUDE_TIMEOUT_MS = 120_000;

function initTokenUsage(state) {
  const now = new Date();
  const key = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
  if (!state.tokenUsage || state.tokenUsage.month !== key) {
    state.tokenUsage = { month: key, input: 0, output: 0, calls: 0 };
  }
}

function checkBudget(state) {
  const spend = estimateMonthlySpend(state.tokenUsage);
  if (spend >= 38) {
    console.warn(`[CLAUDE] BUDGET LIMIT $${spend.toFixed(2)} >= $38`);
    return false;
  }
  const now  = new Date();
  const day  = now.getUTCDate();
  const days = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const pace = (MONTHLY_BUDGET_USD / days) * day;
  if (spend > pace * 1.3) {
    console.warn(`[CLAUDE] Overpacing: $${spend.toFixed(2)} vs expected $${pace.toFixed(2)}`);
  }
  return true;
}

function trackUsage(state, data) {
  const u = data.usage || {};
  state.tokenUsage.input  += u.input_tokens  || 0;
  state.tokenUsage.output += u.output_tokens || 0;
  state.tokenUsage.calls  += 1;
  const spend = estimateMonthlySpend(state.tokenUsage);
  console.log(`[CLAUDE] #${state.tokenUsage.calls} +${u.input_tokens || 0}in +${u.output_tokens || 0}out | $${spend.toFixed(2)}/$${MONTHLY_BUDGET_USD}`);
}

async function callClaudeBudgeted(prompt, env, state, maxTokens = 500) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("No ANTHROPIC_API_KEY");
  initTokenUsage(state);
  if (!checkBudget(state)) throw new Error("Claude budget exhausted");

  const spend = estimateMonthlySpend(state.tokenUsage);
  const now   = new Date();
  const pace  = (MONTHLY_BUDGET_USD / new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate()) * now.getUTCDate();
  if (spend > pace * 1.2) maxTokens = Math.min(maxTokens, 300);

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      // NOTE: do NOT use an assistant-message prefill (`{ role: "assistant", content: "{" }`)
      // to force JSON — newer models reject it ("does not support assistant message prefill;
      // the conversation must end with a user message"), which silently broke all approvals.
      // Steer output to clean JSON via the system prompt instead, then extract defensively.
      system: "Respond with only a single valid JSON object. No markdown, no code fences, no commentary before or after.",
      messages: [
        { role: "user", content: prompt }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    if (errText.includes("You have reached your specified API")) {
      console.warn("[CLAUDE] Spend limit hit, falling back to non-Claude mode");
      throw new Error("CLAUDE_LIMIT_FALLBACK");
    }
    console.error(`[CLAUDE] API error ${res.status}: ${errText}`);
    throw new Error(`Claude ${res.status}: ${errText}`);
  }
  const data = await res.json();
  trackUsage(state, data);
  return extractJsonObject(data.content.map(b => b.text || "").join(""));
}

// Pull the outermost {...} JSON object out of a model response, tolerating
// stray prose or ```json fences. Returns "{}" if nothing parseable is found.
function extractJsonObject(raw) {
  let text = (raw || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return "{}";
}

async function callClaudePlaintext(prompt, env, state, maxTokens = 500) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("No ANTHROPIC_API_KEY");
  initTokenUsage(state);
  if (!checkBudget(state)) throw new Error("Claude budget exhausted");

  const spend = estimateMonthlySpend(state.tokenUsage);
  const now   = new Date();
  const pace  = (MONTHLY_BUDGET_USD / new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate()) * now.getUTCDate();
  if (spend > pace * 1.2) maxTokens = Math.min(maxTokens, 200);

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    if (errText.includes("You have reached your specified API")) {
      console.warn("[CLAUDE] Spend limit hit, falling back to non-Claude mode");
      throw new Error("CLAUDE_LIMIT_FALLBACK");
    }
    console.error(`[CLAUDE] API error ${res.status}: ${errText}`);
    throw new Error(`Claude ${res.status}: ${errText}`);
  }
  const data = await res.json();
  trackUsage(state, data);
  return data.content.map(b => b.text || "").join("").trim();
}

export { callClaudeBudgeted, callClaudePlaintext };
