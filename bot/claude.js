import { ANTHROPIC_API, CLAUDE_MODEL, MONTHLY_BUDGET_USD } from "./config.js";
import { estimateMonthlySpend } from "./stats.js";

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
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "{" }
      ]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    if (
      errText.includes("You have reached your specified API") ||
      errText.includes("invalid_request_error")
    ) {
      console.warn("[CLAUDE] Budget/account limit hit, falling back to non-Claude mode");
      throw new Error("CLAUDE_LIMIT_FALLBACK");
    }
    throw new Error(`Claude ${res.status}: ${errText}`);
  }
  const data = await res.json();
  trackUsage(state, data);
  const text = data.content.map(b => b.text || "").join("").trim();
  return "{" + text;
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
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    if (
      errText.includes("You have reached your specified API") ||
      errText.includes("invalid_request_error")
    ) {
      console.warn("[CLAUDE] Budget/account limit hit, falling back to non-Claude mode");
      throw new Error("CLAUDE_LIMIT_FALLBACK");
    }
    throw new Error(`Claude ${res.status}: ${errText}`);
  }
  const data = await res.json();
  trackUsage(state, data);
  return data.content.map(b => b.text || "").join("").trim();
}

export { callClaudeBudgeted, callClaudePlaintext };
