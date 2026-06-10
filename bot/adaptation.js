import { ENTRY_THRESHOLD, MAX_POSITIONS, SIGNAL_WEIGHTS } from "./config.js";
import { estimateMonthlySpend } from "./stats.js";
import { portfolioValue } from "./execution.js";
import { getWeightRegimeAware } from "./risk-gates.js";

// Exponential time-decay so recent trades dominate the adaptive weights while
// stale ones fade smoothly rather than dropping off a cliff at the window edge.
// Half-life of 10 days: a trade 10 days old counts half as much as a fresh one.
const DECAY_HALFLIFE_DAYS = 10;

function tradeDecayWeight(trade, nowMs) {
  const closedMs = trade.closedAt ? new Date(trade.closedAt).getTime() : NaN;
  if (!Number.isFinite(closedMs)) return 1; // undated legacy trades: full weight
  const ageDays = Math.max(0, (nowMs - closedMs) / 86400000);
  return Math.pow(0.5, ageDays / DECAY_HALFLIFE_DAYS);
}

// Accumulates two parallel tallies per signal:
//   • weighted wins/losses/pnl  → used for WR / EV multiplier decisions (recency-biased)
//   • raw count                 → used ONLY for min-sample gates, so thin recent
//                                 data can never disable or boost a signal on its own
function buildSignalStats(trades, nowMs = Date.now()) {
  const stats = {};
  const bump = (key, won, pnl, w) => {
    if (!stats[key]) stats[key] = { wins: 0, losses: 0, pnl: 0, count: 0, rawWins: 0, rawLosses: 0 };
    const s = stats[key];
    s.wins += won ? w : 0;
    s.losses += won ? 0 : w;
    s.pnl += pnl * w;
    s.count += 1;
    s.rawWins += won ? 1 : 0;
    s.rawLosses += won ? 0 : 1;
  };
  for (const trade of trades) {
    const won = trade.pnl > 0;
    const w = tradeDecayWeight(trade, nowMs);
    const regime = trade.regime || "unknown";
    for (const reason of (trade.reasons || [])) {
      bump(reason, won, trade.pnl, w);
      bump(`${reason}:${regime}`, won, trade.pnl, w);
    }
  }
  return stats;
}

function updateDynamicWeights(state) {
  const recent = state.trades.slice(-80);
  if (recent.length < 10) return;

  const now = Date.now();
  const stats = buildSignalStats(recent, now);

  if (!state.signalStats) state.signalStats = {};
  for (const [key, s] of Object.entries(stats)) {
    state.signalStats[key] = {
      wins: s.rawWins,
      losses: s.rawLosses,
      count: s.rawWins + s.rawLosses,
      totalPnl: parseFloat(s.pnl.toFixed(2))
    };
  }

  const newWeights = { ...(state.dynamicWeights || {}) };
  for (const [signal, s] of Object.entries(stats)) {
    if (signal.includes(":")) continue;
    const rawCount = s.rawWins + s.rawLosses;     // gate on real sample size
    if (rawCount < 20) continue;

    const wMass = s.wins + s.losses;              // decayed mass for WR/EV
    if (wMass <= 0) continue;
    const wr = s.wins / wMass;
    const ev = s.pnl / wMass;
    let mult = 1.0;
    if      (wr >= 0.65 && ev > 0) mult = 1.20;
    else if (wr >= 0.55 && ev > 0) mult = 1.08;
    else if (wr >= 0.50 && ev >= 0) mult = 1.05;
    else if (wr >= 0.47 && ev >= 0) mult = 0.92;
    else if (wr < 0.33 || ev < 0)  mult = 0.65;
    else if (wr < 0.40)            mult = 0.80;
    else if (wr < 0.47)            mult = 0.90;

    newWeights[signal] = parseFloat(mult.toFixed(3));
    if (Math.abs(newWeights[signal] - 1.0) > 0.2) {
      console.log(`[WEIGHTS] ${signal}: 1.0 -> ${newWeights[signal]} (WR:${(wr * 100).toFixed(0)}% n=${rawCount} ev:$${ev.toFixed(2)})`);
    }
  }

  // ── Fast 20-trade window: ±15% multiplier on top of slow weights ─────────────
  // Reacts to market structure changes in 3-5 days vs 2-3 weeks for 80-trade window.
  const fast = state.trades.slice(-20);
  if (fast.length >= 10) {
    const fastStats = buildSignalStats(fast, now);
    let fastDivergences = 0;
    for (const [signal, fs] of Object.entries(fastStats)) {
      if (signal.includes(":")) continue;
      const rawCount = fs.rawWins + fs.rawLosses;
      if (rawCount < 5) continue;
      const fastMass = fs.wins + fs.losses;
      if (fastMass <= 0) continue;
      const fastWr = fs.wins / fastMass;
      const slowEntry = stats[signal];
      if (!slowEntry) continue;
      const slowRaw = slowEntry.rawWins + slowEntry.rawLosses;
      if (slowRaw < 10) continue;
      const slowMass = slowEntry.wins + slowEntry.losses;
      if (slowMass <= 0) continue;
      const slowWr = slowEntry.wins / slowMass;
      const divergence = fastWr - slowWr;
      if (Math.abs(divergence) > 0.15) {
        const fastMult = divergence > 0 ? 1.15 : 0.85;
        const base = newWeights[signal] ?? 1.0;
        newWeights[signal] = parseFloat(Math.max(0.2, Math.min(1.6, base * fastMult)).toFixed(3));
        fastDivergences++;
      }
    }
    if (fastDivergences > 0) {
      console.log(`[WEIGHTS-FAST] Applied fast-window adjustments to ${fastDivergences} signals`);
    }

    // Detect rapid regime drift: if fast-window WR diverges >15% from slow, log warning
    const fastPnl = fast.reduce((s, t) => s + t.pnl, 0);
    const fastWr = fast.filter(t => t.pnl > 0).length / fast.length;
    const slowWr = recent.filter(t => t.pnl > 0).length / recent.length;
    if (Math.abs(fastWr - slowWr) > 0.15) {
      console.warn(
        `[REGIME DRIFT] Fast WR ${(fastWr * 100).toFixed(1)}% vs Slow WR ${(slowWr * 100).toFixed(1)}% ` +
        `| Fast EV $${(fastPnl / fast.length).toFixed(2)} | May indicate market structure change`
      );
    }
  }

  state.dynamicWeights = newWeights;

  const disabled = [];
  for (const [signal, s] of Object.entries(stats)) {
    if (signal.includes(":")) continue;
    const rawCount = s.rawWins + s.rawLosses;
    const wMass = s.wins + s.losses;
    if (rawCount >= 25 && wMass > 0 && s.wins / wMass < 0.30 && s.pnl / wMass < 0) {
      disabled.push(signal);
      console.warn(`[WEIGHTS] DISABLED "${signal}": WR=${((s.wins / wMass) * 100).toFixed(0)}% over ${rawCount} trades`);
    }
  }
  state.disabledSignals = Array.from(new Set([...disabled, "trap-vol-bear"]));
  state.lastWeightUpdate = Date.now();
  console.log(`[WEIGHTS] Updated ${Object.keys(newWeights).length} signal weights from ${recent.length} trades`);
}

function trackSignalPerformance(state) {
  updateDynamicWeights(state);
}

function updateRegimeStats(state, trade) {
  if (!state.regimeStats) {
    state.regimeStats = {
      bull:     { wins: 0, losses: 0, totalPnl: 0, count: 0 },
      bear:     { wins: 0, losses: 0, totalPnl: 0, count: 0 },
      sideways: { wins: 0, losses: 0, totalPnl: 0, count: 0 }
    };
  }

  const regime = state.lastRegime?.label || "sideways";

  if (!state.regimeStats[regime]) {
    state.regimeStats[regime] = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
  }

  const rs = state.regimeStats[regime];
  rs.count++;
  rs.totalPnl += trade.pnl;
  if (trade.pnl > 0) rs.wins++;
  else rs.losses++;
}

function getAdaptiveThreshold(state, currentRegime) {
  if (!state.regimeStats) return ENTRY_THRESHOLD;

  const rs = state.regimeStats[currentRegime];
  if (!rs || rs.count < 15) {
    return currentRegime === "chop"
      ? ENTRY_THRESHOLD + 0.5
      : ENTRY_THRESHOLD;
  }

  const winRate = rs.wins / rs.count;
  const avgPnl  = rs.totalPnl / rs.count;

  let adjustment = 0;
  if (winRate > 0.55 && avgPnl > 0) {
    adjustment = -1;
  } else if (winRate >= 0.45) {
    adjustment = 0;
  } else if (winRate >= 0.38) {
    adjustment = 0.5;
  } else {
    adjustment = 1;
  }

  if (currentRegime === "chop") {
    adjustment += 0.5;
  }

  adjustment = Math.min(adjustment, 1.5);

  const adaptive = Math.max(3, Math.min(6, ENTRY_THRESHOLD + adjustment));

  if (adaptive !== ENTRY_THRESHOLD) {
    console.log(
      `[REGIME ADAPT] ${currentRegime} WR=${(winRate * 100).toFixed(0)}% ` +
      `n=${rs.count} avgPnL=${avgPnl.toFixed(2)} → ${ENTRY_THRESHOLD}→${adaptive}`
    );
  }

  return adaptive;
}

function getWeight(signal, state) {
  const regimeLabel = state.lastRegime?.label || "unknown";
  return getWeightRegimeAware(signal, state, regimeLabel, SIGNAL_WEIGHTS);
}

function getRegimePerformance(state, regimeLabel) {
  const regimeTrades = state.trades.filter(t => {
    const history = (state.coinHistory || {})[t.symbol];
    if (history) {
      const match = history.find(h => h.date === (t.closedAt || "").split("T")[0]);
      if (match) return match.regime === regimeLabel;
    }
    return false;
  });
  const trades = regimeTrades.length >= 5 ? regimeTrades : state.trades.slice(-50);
  const wins   = trades.filter(t => t.pnl > 0).length;
  const total  = trades.length;
  return {
    total,
    wins,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(0) : "N/A",
    avgPnl:  total > 0 ? (trades.reduce((s, t) => s + t.pnl, 0) / total).toFixed(2) : "0"
  };
}

function printPortfolioSummary(state) {
  const open  = Object.keys(state.positions).length;
  const total = state.trades.length;
  const pnl   = state.trades.reduce((s, t) => s + t.pnl, 0);
  const wins  = state.trades.filter(t => t.pnl > 0).length;
  const wr    = total > 0 ? ((wins / total) * 100).toFixed(1) : "N/A";
  const val   = portfolioValue(state);
  const dd    = state.peakValue ? ((state.peakValue - val) / state.peakValue * 100).toFixed(1) : "0.0";
  const cb    = state.circuitBreakerActive ? " ⚠CB" : "";
  const spend = estimateMonthlySpend(state.tokenUsage || { input: 0, output: 0 });
  console.log(`=== $${val.toFixed(2)} | Cash:$${state.cash.toFixed(2)} | ${open}/${MAX_POSITIONS} | ${total}trades PnL:$${pnl.toFixed(2)} WR:${wr}% DD:${dd}% | ${state.lastRegime?.label ?? "?"}${cb} | Claude:$${spend.toFixed(2)} ===`);
}

export {
  updateDynamicWeights,
  trackSignalPerformance,
  updateRegimeStats,
  getAdaptiveThreshold,
  getWeight,
  getRegimePerformance,
  printPortfolioSummary
};
