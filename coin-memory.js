// =============================================================================
// COIN MEMORY — ENHANCED PATTERN MATCHING SYSTEM
// Drop-in replacement for the three functions in bot.js:
//   - updateCoinHistory()
//   - getCoinMemory()
//   - formatCoinMemoryForClaude()
// And the full claudeBatchAnalysis() rewrite.
//
// WHAT CHANGED AND WHY:
//
// BEFORE: coin history stored 10 bare trade records.
//   Claude saw: "5 trades, 60% WR, recent: long WIN $34 (sideways) [TK-bull,chikou-bull]"
//   Claude had no way to know: which signal combos failed, what the entry score was,
//   how long the position was held, what the journal said, or what patterns repeat.
//
// AFTER: coin history stores rich structured data per trade, plus a pre-computed
//   failure pattern index that Claude reads directly.
//   Claude sees: specific signal overlap with current setup, regime-conditional
//   performance, hold-time patterns, exit reason breakdown, and its own prior
//   journal text for this coin. Claude can then do real pattern matching.
// =============================================================================

import { safeParseClaudeJSON, validateBatchResponse } from "./bot/safe-parse.js";

// =============================================================================
// LAYER 1 — updateCoinHistory (replaces existing function in bot.js)
// Called from closePosition() in runner.js
// Stores 20 trades instead of 10, with richer fields
// =============================================================================
export function updateCoinHistory(state, symbol, trade) {
  if (!state.coinHistory) state.coinHistory = {};
  if (!state.coinHistory[symbol]) state.coinHistory[symbol] = [];

  const entry = {
    direction:  trade.direction,
    pnl:        parseFloat((trade.pnl || 0).toFixed(2)),
    pnlPct:     parseFloat((trade.pnlPct || 0).toFixed(2)),
    regime:     state.lastRegime?.label || "unknown",
    setupType:  trade.setupType || "unknown",
    reasons:    (trade.reasons || []).slice(0, 8),   // was 6, now 8
    score:      trade.score || 0,                     // NEW: entry score
    h4Trend:    trade.h4Trend || "unknown",           // NEW: 4H trend at entry
    holdHours:  parseFloat((trade.holdHours || 0).toFixed(1)), // NEW: hold duration
    exitReason: trade.reason || trade.exitReason || "unknown",
    date:       new Date().toISOString().split("T")[0],
    result:     (trade.pnl || 0) > 0 ? "win" : "loss",
    journal:    trade.journal || null                  // NEW: Claude's own post-mortem
  };

  state.coinHistory[symbol].push(entry);

  // Keep last 20 trades per coin (was 10)
  if (state.coinHistory[symbol].length > 20) {
    state.coinHistory[symbol] = state.coinHistory[symbol].slice(-20);
  }
}

// =============================================================================
// LAYER 2 — Pattern analysis (new helper)
// Pre-computes failure and success patterns so Claude gets structured insight,
// not raw data it has to reason through from scratch
// =============================================================================
function analyzePatterns(history) {
  if (!history || history.length < 3) return null;

  // Signal overlap analysis: which signal combos appear in wins vs losses
  const signalWins   = {};
  const signalLosses = {};
  for (const t of history) {
    for (const sig of (t.reasons || [])) {
      if (t.result === "win") {
        signalWins[sig]   = (signalWins[sig]   || 0) + 1;
      } else {
        signalLosses[sig] = (signalLosses[sig] || 0) + 1;
      }
    }
  }

  // Signals that appear more in losses than wins = warning signals for this coin
  const warningSignals = Object.keys(signalLosses)
    .filter(sig => (signalLosses[sig] || 0) > (signalWins[sig] || 0))
    .sort((a, b) => (signalLosses[b] - (signalWins[b] || 0)) - (signalLosses[a] - (signalWins[a] || 0)))
    .slice(0, 4);

  // Signals that appear more in wins = good signals for this coin
  const strongSignals = Object.keys(signalWins)
    .filter(sig => (signalWins[sig] || 0) > (signalLosses[sig] || 0) + 1)
    .sort((a, b) => (signalWins[b] - (signalLosses[b] || 0)) - (signalWins[a] - (signalLosses[a] || 0)))
    .slice(0, 4);

  // Setup type performance for this coin
  const setupPerf = {};
  for (const t of history) {
    const st = t.setupType || "unknown";
    if (!setupPerf[st]) setupPerf[st] = { wins: 0, total: 0, pnl: 0 };
    setupPerf[st].total++;
    setupPerf[st].pnl += t.pnl;
    if (t.result === "win") setupPerf[st].wins++;
  }

  // Exit reason breakdown — does this coin stop-loss a lot?
  const exitBreakdown = {};
  for (const t of history) {
    const ex = t.exitReason || "unknown";
    exitBreakdown[ex] = (exitBreakdown[ex] || 0) + 1;
  }

  // Hold time: do wins hold longer or shorter than losses?
  const winHours  = history.filter(t => t.result === "win" && t.holdHours)
    .map(t => t.holdHours);
  const lossHours = history.filter(t => t.result === "loss" && t.holdHours)
    .map(t => t.holdHours);
  const avgWinHold  = winHours.length  ? (winHours.reduce((a,b)=>a+b,0)  / winHours.length).toFixed(1)  : null;
  const avgLossHold = lossHours.length ? (lossHours.reduce((a,b)=>a+b,0) / lossHours.length).toFixed(1) : null;

  // Streak: current consecutive wins or losses
  let streak = 0;
  let streakType = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (streakType === null) { streakType = history[i].result; streak = 1; }
    else if (history[i].result === streakType) streak++;
    else break;
  }

  // Score distribution: do higher-score entries do better on this coin?
  const highScore = history.filter(t => t.score >= 7);
  const lowScore  = history.filter(t => t.score < 7);
  const highScoreWR = highScore.length
    ? ((highScore.filter(t=>t.result==="win").length / highScore.length)*100).toFixed(0)
    : null;
  const lowScoreWR  = lowScore.length
    ? ((lowScore.filter(t=>t.result==="win").length / lowScore.length)*100).toFixed(0)
    : null;

  return {
    warningSignals,
    strongSignals,
    setupPerf,
    exitBreakdown,
    avgWinHold,
    avgLossHold,
    streak: { count: streak, type: streakType },
    scoreWR: { high: highScoreWR, low: lowScoreWR }
  };
}

// =============================================================================
// LAYER 3 — getCoinMemory (replaces existing function in bot.js)
// =============================================================================
export function getCoinMemory(state, symbol) {
  const history = (state.coinHistory || {})[symbol];
  if (!history || history.length === 0) return null;

  const wins    = history.filter(h => h.result === "win").length;
  const total   = history.length;
  const avgPnl  = history.reduce((s, h) => s + h.pnl, 0) / total;
  const avgHold = history.filter(h=>h.holdHours).reduce((s,h)=>s+h.holdHours,0) /
                  (history.filter(h=>h.holdHours).length || 1);

  const regimeStats = {};
  for (const h of history) {
    if (!regimeStats[h.regime]) regimeStats[h.regime] = { wins: 0, total: 0, pnl: 0 };
    regimeStats[h.regime].total++;
    regimeStats[h.regime].pnl += h.pnl;
    if (h.result === "win") regimeStats[h.regime].wins++;
  }

  const patterns = analyzePatterns(history);

  return {
    trades:   history,
    patterns,
    summary: {
      total,
      wins,
      winRate:    ((wins / total) * 100).toFixed(0),
      avgPnl:     avgPnl.toFixed(2),
      avgHold:    avgHold.toFixed(1),
      regimeStats
    }
  };
}

// =============================================================================
// LAYER 4 — formatCoinMemoryForClaude (replaces existing function in bot.js)
// Produces a structured briefing Claude can use for real pattern matching
// =============================================================================
export function formatCoinMemoryForClaude(memory, currentRegime, currentReasons) {
  if (!memory) return "No prior trades on this coin.";

  const s = memory.summary;
  const p = memory.patterns;

  let text = `COIN HISTORY (${s.total} trades, ${s.winRate}% WR, avg $${s.avgPnl}/trade, avg hold ${s.avgHold}h)\n`;

  // Regime-specific performance
  const regimeStat = s.regimeStats[currentRegime];
  if (regimeStat && regimeStat.total >= 2) {
    const rwr  = ((regimeStat.wins / regimeStat.total) * 100).toFixed(0);
    const revp = (regimeStat.pnl / regimeStat.total).toFixed(2);
    text += `In ${currentRegime}: ${regimeStat.total} trades, ${rwr}% WR, avg $${revp}\n`;
  }

  if (p) {
    // Signal overlap: does the current candidate share signals with historical losers?
    if (p.warningSignals.length > 0) {
      const overlap = currentReasons
        ? p.warningSignals.filter(s => currentReasons.includes(s))
        : [];
      text += `⚠ Warning signals for this coin (more losses than wins): ${p.warningSignals.join(", ")}\n`;
      if (overlap.length > 0) {
        text += `🔴 CURRENT SETUP OVERLAPS WITH ${overlap.length} WARNING SIGNAL(S): ${overlap.join(", ")}\n`;
      }
    }

    if (p.strongSignals.length > 0) {
      const overlap = currentReasons
        ? p.strongSignals.filter(s => currentReasons.includes(s))
        : [];
      text += `✅ Strong signals for this coin: ${p.strongSignals.join(", ")}`;
      if (overlap.length > 0) text += ` ← CURRENT SETUP HAS ${overlap.length} OF THESE`;
      text += "\n";
    }

    // Setup type performance for this coin
    const setupLines = Object.entries(p.setupPerf)
      .filter(([, v]) => v.total >= 2)
      .map(([st, v]) => `${st}:${v.wins}W/${v.total-v.wins}L $${(v.pnl/v.total).toFixed(1)}/trade`)
      .join(" | ");
    if (setupLines) text += `Setup history: ${setupLines}\n`;

    // Hold time insight
    if (p.avgWinHold && p.avgLossHold) {
      text += `Hold time: wins avg ${p.avgWinHold}h, losses avg ${p.avgLossHold}h\n`;
    }

    // Current streak
    if (p.streak.count >= 2) {
      text += `Current streak: ${p.streak.count}x ${p.streak.type.toUpperCase()}\n`;
    }

    // Score-based WR
    if (p.scoreWR.high && p.scoreWR.low) {
      text += `Score WR: score≥7 → ${p.scoreWR.high}% WR | score<7 → ${p.scoreWR.low}% WR\n`;
    }

    // Exit pattern
    const slCount = p.exitBreakdown["stop-loss"] || 0;
    if (slCount >= 3) {
      text += `⚠ SL exits: ${slCount}/${s.total} trades — this coin stops out frequently\n`;
    }
  }

  // Last 5 trades with journals
  text += "Recent trades:\n";
  for (const t of memory.trades.slice(-5)) {
    const icon = t.result === "win" ? "✅" : "❌";
    text += `  ${icon} ${t.date} ${t.direction} $${t.pnl} ${t.regime}/${t.setupType} ` +
            `score:${t.score} hold:${t.holdHours}h exit:${t.exitReason} ` +
            `[${(t.reasons||[]).slice(0,5).join(",")}]\n`;
    if (t.journal) text += `     Journal: ${t.journal}\n`;
  }

  return text;
}

// =============================================================================
// LAYER 5 — buildClaudeValidationPrompt (new helper, used inside claudeBatchAnalysis)
// Replaces the inline sections.push(VALIDATE) block
// =============================================================================
export function buildValidationSection(candidatesToValidate, regime, state, deps) {
  const { getCoinMemory, formatCoinMemoryForClaude, getApprovalStats,
          getSetupStats, getWeight } = deps;

  // System-level context Claude needs to make good decisions
  const autoStats   = getApprovalStats(state.trades || [], "auto");
  const claudeStats = getApprovalStats(state.trades || [], "claude");
  const autoWR      = autoStats?.count >= 5
    ? `${(autoStats.winRate * 100).toFixed(0)}% (n=${autoStats.count})`
    : "insufficient data";
  const claudeWR    = claudeStats?.count >= 5
    ? `${(claudeStats.winRate * 100).toFixed(0)}% (n=${claudeStats.count})`
    : "insufficient data";

  // Setup type performance system-wide
  const setupPerf = ["trend","breakout","liquidity-trap","mean-reversion","bull-pullback"].map(t => {
    const s = getSetupStats(state.trades || [], t);
    if (!s || s.count < 5) return `${t}:no data`;
    return `${t}:${(s.winRate*100).toFixed(0)}%WR EV=$${s.expectancy.toFixed(1)} n=${s.count}`;
  }).join(" | ");

  // Regime performance
  const regimeStats = state.regimeStats?.[regime.label];
  const regimePerf  = regimeStats && regimeStats.count >= 5
    ? `${regime.label}: ${((regimeStats.wins/regimeStats.count)*100).toFixed(0)}% WR, ` +
      `avg $${(regimeStats.totalPnl/regimeStats.count).toFixed(2)}/trade, n=${regimeStats.count}`
    : `${regime.label}: insufficient data`;

  // Build candidate lines with full context
  const candidateLines = candidatesToValidate.map((c, i) => {
    const memory  = getCoinMemory(state, c.symbol);
    const memText = formatCoinMemoryForClaude(memory, regime.label, c.reasons);

    // Signal performance data — the key missing piece
    const signalPerf = (c.reasons || []).slice(0, 8).map(sig => {
      const global  = state.signalStats?.[sig];
      const regKey  = `${sig}:${regime.label}`;
      const regStat = state.signalStats?.[regKey];

      let perfStr = sig;
      if (global && global.count >= 5) {
        const wr = ((global.wins / global.count) * 100).toFixed(0);
        const ev = (global.totalPnl / global.count).toFixed(1);
        perfStr += `(${wr}%WR,$${ev}EV,n=${global.count})`;
      }
      if (regStat && regStat.count >= 3) {
        const rwr = ((regStat.wins / regStat.count) * 100).toFixed(0);
        perfStr += `[${regime.label}:${rwr}%]`;
      }
      return perfStr;
    }).join(", ");

    // Dynamic weight for this signal set
    const avgWeight = (c.reasons || []).slice(0, 6)
      .reduce((sum, sig) => sum + (getWeight(sig, state) || 1.0), 0) /
      Math.max((c.reasons || []).slice(0, 6).length, 1);

    return (
      `--- CANDIDATE ${i + 1}: ${c.symbol} ---\n` +
      `Direction: ${c.signal.toUpperCase()} | Score: ${c.score} | Setup: ${c.setupType}\n` +
      `Price: $${c.price.toFixed(4)} | RSI: ${c.rsiVal.toFixed(0)} | ` +
      `Fisher: ${c.fisherVal.toFixed(2)} | ADX: ${c.adxResult?.adx?.toFixed(0)||"?"} | ` +
      `4H: ${c.h4Trend} | OBV: ${c.obvDiv}\n` +
      `Galaxy: ${c.lunarGalaxyScore||"?"} | AltRank: ${c.lunarAltRank||"?"} | SocVol: ${c.lunarSocialVolume||"?"} | Funding: ${c.fundingRate!=null?(c.fundingRate*100).toFixed(3)+"%":"?"}\n` +
      `Signals: [${signalPerf}]\n` +
      `Avg signal weight: ${avgWeight.toFixed(2)}x\n` +
      `${memText}`
    );
  }).join("\n");

  return (
    `=== VALIDATE ===\n` +
    `Regime: ${regime.label} | HMM: ${regime.hmmLabel} | PI: ${regime.piCycle} | ` +
    `Markov: ${regime.markovProb?.toFixed(3)||"?"}\n\n` +

    `SYSTEM PERFORMANCE CONTEXT:\n` +
    `Auto-approval WR: ${autoWR}\n` +
    `Claude-approval WR: ${claudeWR}\n` +
    `Setup performance: ${setupPerf}\n` +
    `Regime performance: ${regimePerf}\n\n` +

    `YOUR DECISION FRAMEWORK:\n` +
    `DEFAULT = REJECT. Approve ONLY if ALL of the following:\n` +
    `1. Signal performance: most signals shown have ≥48% WR in this regime\n` +
    `2. Coin history: no repeating failure pattern matching current signals\n` +
    `3. Setup type: this coin's history for this setupType shows positive EV\n` +
    `4. No current-setup overlap with this coin's warning signals\n` +
    `5. Score is meaningful: ≥7 for liquidity-trap, ≥6 for trend/breakout\n\n` +

    `AUTO-REJECT if ANY of:\n` +
    `- Current signals overlap with 2+ of this coin's warning signals\n` +
    `- This setupType has negative EV on this coin (≥3 prior trades)\n` +
    `- Coin has 3+ consecutive losses (current losing streak)\n` +
    `- Signal WRs are all below 45% with no strong regime-specific exception\n` +
    `- Coin stops out frequently (SL exits >50% of trades)\n\n` +

    `CANDIDATES:\n${candidateLines}`
  );
}

// =============================================================================
// LAYER 6 — claudeBatchAnalysis rewrite
// Drop-in replacement for the existing function in bot.js
// The VALIDATE section is now built by buildValidationSection()
// Everything else (NEWS, JOURNALS) is unchanged
// =============================================================================
export async function claudeBatchAnalysis({
  headlines, candidatesToValidate, positionsToClose,
  regime, env, state,
  // deps injected from bot.js so this stays testable
  deps = {}
}) {
  const {
    callClaudeBudgeted,
    getCoinMemory:       getCoinMemoryFn,
    formatCoinMemory:    formatCoinMemoryFn,
    getApprovalStats,
    getSetupStats,
    getWeight,
    fallbackResult:      fallback
  } = deps;

  if (!env.ANTHROPIC_API_KEY) return fallback(candidatesToValidate);
  if (!headlines.length && !candidatesToValidate.length && !positionsToClose.length) {
    return { newsBlocked: [], newsBoosted: [], newsSummary: "", validations: {}, journals: {} };
  }

  const sections = [];

  // NEWS section — unchanged
  if (headlines.length > 0) {
    sections.push(
      `=== NEWS ===\nIdentify coins to BLOCK or BOOST:\n` +
      headlines.slice(0, 10).map(h =>
        `- [${h.sentiment}] ${h.title} (${h.coins.join(",") || "general"})`
      ).join("\n")
    );
  }

  // VALIDATE section — rebuilt with full pattern context
  if (candidatesToValidate.length > 0) {
    const validateSection = buildValidationSection(
      candidatesToValidate, regime, state,
      {
        getCoinMemory:          getCoinMemoryFn,
        formatCoinMemoryForClaude: formatCoinMemoryFn,
        getApprovalStats,
        getSetupStats,
        getWeight
      }
    );
    sections.push(validateSection);
  }

  // JOURNALS section — unchanged but now includes setup type
  if (positionsToClose.length > 0) {
    sections.push(
      `=== JOURNALS ===\n` +
      `2-sentence journal per trade. Include: what signal drove entry, ` +
      `why it won/lost, what to watch for next time on this coin.\n` +
      positionsToClose.slice(0, 5).map((p, i) => {
        const pnl = p.direction === "long"
          ? (p.exitPrice - p.entryPrice) * p.size
          : (p.entryPrice - p.exitPrice) * p.size;
        return (
          `${i + 1}. ${p.symbol} ${p.direction.toUpperCase()} ` +
          `entry:$${p.entryPrice.toFixed(4)} exit:$${p.exitPrice.toFixed(4)} ` +
          `PnL:$${pnl.toFixed(2)} setup:${p.setupType||"?"} ` +
          `hold:${p.holdHours?.toFixed(1)||"?"}h exit:${p.exitReason} ` +
          `[${(p.reasons || []).slice(0, 5).join(",")}]`
        );
      }).join("\n")
    );
  }

  const prompt =
    `You are a quant trading analyst with memory of this system's performance.\n` +
    `Respond in JSON covering all sections present. Be precise and data-driven.\n\n` +
    sections.join("\n\n") +
    `\n\nJSON only:\n` +
    `{"news":{"blocked":[],"boosted":[],"summary":""},` +
    `"validations":{"SYM-USDT-SWAP":{"approved":false,"reason":"specific pattern match or rejection reason"}},` +
    `"journals":{"SYM-USDT-SWAP":"2 sentence journal"}}`;

  try {
    const expectedSymbols = candidatesToValidate.map(c => c.symbol);
    const raw = await callClaudeBudgeted(prompt, env, state, 1200);
    const { ok, data, error } = safeParseClaudeJSON(raw);
    if (!ok) {
      console.warn("[CLAUDE BATCH] JSON parse failed:", error, raw.slice(0, 300));
      return fallback(candidatesToValidate);
    }
    return validateBatchResponse(data, expectedSymbols);
  } catch (err) {
    console.error("[CLAUDE BATCH]", err.message);
    return fallback(candidatesToValidate);
  }
}

function validateClaudeResponse(parsed, expectedSymbols) {
  const warnings = [];

  if (typeof parsed !== "object" || parsed === null) {
    console.warn("[CLAUDE VALIDATE] Response is not an object");
    return { fixed: parsed ?? {} };
  }

  if (parsed.validations && typeof parsed.validations === "object") {
    for (const [sym, v] of Object.entries(parsed.validations)) {
      if (typeof v !== "object" || v === null) {
        warnings.push(`${sym}: validation is not an object`);
        continue;
      }
      if (typeof v.approved !== "boolean") {
        if (v.approved === "true")       { v.approved = true; }
        else if (v.approved === "false") { v.approved = false; }
        else if (v.approve !== undefined) {
          v.approved = !!v.approve;
          delete v.approve;
          warnings.push(`${sym}: had "approve" instead of "approved" — fixed`);
        } else {
          warnings.push(`${sym}: missing or invalid "approved" field — defaulting to reject`);
          v.approved = false;
        }
      }
      if (!v.reason || typeof v.reason !== "string") {
        warnings.push(`${sym}: missing reason`);
        v.reason = "no-reason-given";
      }
    }
  }

  for (const sym of expectedSymbols) {
    if (!parsed.validations?.[sym]) {
      warnings.push(`${sym}: no validation returned by Claude`);
    }
  }

  if (warnings.length > 0) {
    console.warn(`[CLAUDE VALIDATE] ${warnings.length} issue(s): ${warnings.join(" | ")}`);
  }

  return { fixed: parsed, warnings };
}
