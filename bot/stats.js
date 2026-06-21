import {
  CLAUDE_THRESHOLD,
  INPUT_COST_PER_MTOK,
  MONTHLY_BUDGET_USD,
  OUTPUT_COST_PER_MTOK
} from "./config.js";

export const LIVE_BASELINE = {
  winRate: 0.436,
  expectancy: 4.034,
  profitFactor: 1.525,
  maxDrawdown: 0.0346
};

// Recency-weighting for SIZING stats (Kelly + adaptive setup decision). Plain
// getSetupStats averages over the whole last-500-trade window with no decay, so
// pre-pivot contaminated trades drag setup EV/WR down at full weight — which both
// shrinks position size (Kelly, adaptive sizeMult) AND can hard-block a setup
// (allow:false on negative full-window EV). These constants make sizing reflect
// RECENT structure instead. Mirrors adaptation.js's 10-day half-life. Permanent
// improvement (not a recalibration toggle): self-heals continuously via decay.
const SETUP_DECAY_HALFLIFE_DAYS = 10;
// Below this decay-weighted effective sample, recent evidence is too thin to
// trust — sizing/blocking stays neutral rather than acting on stale data.
export const MIN_EFF_RECENT_SETUP = 6;

function setupDecayWeight(trade, nowMs) {
  const closedMs = trade.closedAt ? new Date(trade.closedAt).getTime() : NaN;
  if (!Number.isFinite(closedMs)) return 1; // undated legacy trades: full weight
  const ageDays = Math.max(0, (nowMs - closedMs) / 86400000);
  return Math.pow(0.5, ageDays / SETUP_DECAY_HALFLIFE_DAYS);
}

// Like getSetupStats, but WR/avgWin/avgLoss/expectancy are decay-weighted toward
// recent trades. Returns `count` (raw, for min-sample gates) and `effN` (decayed
// effective sample, for "is recent evidence trustworthy?" gates), so callers keep
// the raw-count sample logic while the decision math reflects current structure.
export function getSetupStatsRecent(trades, setupType, nowMs = Date.now()) {
  const rows = (trades || []).filter((t) => t.setupType === setupType);
  if (rows.length === 0) return null;

  let mass = 0, winMass = 0, winPnl = 0, winN = 0, lossPnl = 0, lossN = 0;
  for (const t of rows) {
    const w = setupDecayWeight(t, nowMs);
    mass += w;
    if (t.pnl > 0) { winMass += w; winPnl += t.pnl * w; winN += w; }
    else           { lossPnl += t.pnl * w; lossN += w; }
  }
  if (mass <= 0) return null;

  const winRate = winMass / mass;
  const avgWin  = winN  > 0 ? winPnl  / winN  : 0;
  const avgLoss = lossN > 0 ? Math.abs(lossPnl / lossN) : 0;
  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  return { count: rows.length, effN: mass, winRate, avgWin, avgLoss, expectancy };
}

export function getSetupStats(trades, setupType) {
  const rows = (trades || []).filter((t) => t.setupType === setupType);
  if (rows.length === 0) return null;

  const wins = rows.filter((t) => t.pnl > 0);
  const losses = rows.filter((t) => t.pnl <= 0);

  const winRate = wins.length / rows.length;
  const avgWin = wins.length
    ? wins.reduce((sum, trade) => sum + trade.pnl, 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0) / losses.length)
    : 0;

  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  return {
    count: rows.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy
  };
}

export function getApprovalStats(trades, approvalType) {
  const rows = (trades || []).filter((t) => t.approvalType === approvalType);
  if (rows.length === 0) return null;

  const wins = rows.filter((t) => t.pnl > 0);
  const losses = rows.filter((t) => t.pnl <= 0);

  const winRate = wins.length / rows.length;
  const avgWin = wins.length
    ? wins.reduce((sum, trade) => sum + trade.pnl, 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0) / losses.length)
    : 0;

  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  return {
    count: rows.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy
  };
}

export function getSymbolStats(trades, symbol) {
  const rows = (trades || []).filter((t) => t.symbol === symbol);
  if (rows.length === 0) return null;

  const wins = rows.filter((t) => t.pnl > 0);
  const losses = rows.filter((t) => t.pnl <= 0);

  const winRate = wins.length / rows.length;
  const avgWin = wins.length
    ? wins.reduce((sum, trade) => sum + trade.pnl, 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0) / losses.length)
    : 0;

  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
  const totalPnl = rows.reduce((sum, trade) => sum + trade.pnl, 0);

  return {
    count: rows.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    totalPnl
  };
}

export function getSymbolRiskDecision(state, symbol) {
  const stats = getSymbolStats(state.trades || [], symbol);
  if (!stats) {
    return {
      allow: true,
      sizeMult: 1.0,
      reason: "no-symbol-stats"
    };
  }

  if (stats.count >= 80 && stats.expectancy < -2) {
    return {
      allow: false,
      sizeMult: 0,
      reason: `symbol-blocked n=${stats.count} ev=${stats.expectancy.toFixed(2)}`
    };
  }

  if (stats.count >= 80 && stats.expectancy < 0 && stats.winRate < 0.40) {
    return {
      allow: false,
      sizeMult: 0,
      reason: `symbol-persistently-weak n=${stats.count} wr=${(stats.winRate * 100).toFixed(1)}% ev=${stats.expectancy.toFixed(2)}`
    };
  }

  if (stats.count >= 50 && stats.expectancy < 0) {
    return {
      allow: true,
      sizeMult: 0.6,
      reason: `symbol-weak n=${stats.count} ev=${stats.expectancy.toFixed(2)}`
    };
  }

  if (stats.count >= 50 && stats.expectancy > 5 && stats.winRate > 0.5) {
    return {
      allow: true,
      sizeMult: 1.05,
      reason: `symbol-strong n=${stats.count} ev=${stats.expectancy.toFixed(2)}`
    };
  }

  return {
    allow: true,
    sizeMult: 1.0,
    reason: `symbol-neutral n=${stats.count} ev=${stats.expectancy.toFixed(2)}`
  };
}

export function getApprovalRiskMultiplier(state, approvalType) {
  const stats = getApprovalStats(state.trades || [], approvalType);
  if (!stats || stats.count < 15) return 1.0;
  if (stats.expectancy > 8 && stats.winRate > 0.52) return 1.10;
  if (stats.expectancy < -5 && stats.winRate < 0.45) return 0.85;
  if (stats.expectancy < 0) return 0.93;
  return 1.0;
}

export function getAdaptiveSetupDecision(state, setupType) {
  // Recency-weighted so stale pre-pivot trades can't shrink size or hard-block
  // a setup on a negative full-window EV that no longer reflects current structure.
  const stats = getSetupStatsRecent(state.trades || [], setupType);

  if (!stats) {
    return {
      allow: true,
      sizeMult: 1.0,
      reason: "no-stats"
    };
  }

  const { count, effN, expectancy, winRate } = stats;

  if (count < 15) {
    return {
      allow: true,
      sizeMult: 1.0,
      reason: "low-sample"
    };
  }

  // Enough total history, but recent (decayed) evidence is too thin to trust —
  // don't let stale EV/WR reduce size or block. Stays neutral until fresh trades
  // accumulate, then the branches below engage on recency-weighted stats.
  if (effN < MIN_EFF_RECENT_SETUP) {
    return {
      allow: true,
      sizeMult: 1.0,
      reason: `thin-recent n=${count} effN=${effN.toFixed(1)}`
    };
  }

  if (count < 25) {
    if (expectancy > 5 && winRate > 0.5) {
      return {
        allow: true,
        sizeMult: 1.10,
        reason: `early-good n=${count} ev=${expectancy.toFixed(2)}`
      };
    }

    if (expectancy < 0) {
      return {
        allow: true,
        sizeMult: 0.85,
        reason: `early-weak n=${count} ev=${expectancy.toFixed(2)}`
      };
    }

    return {
      allow: true,
      sizeMult: 1.0,
      reason: `early-neutral n=${count} ev=${expectancy.toFixed(2)}`
    };
  }

  if (count < 30) {
    if (expectancy > 8 && winRate > 0.52) {
      return {
        allow: true,
        sizeMult: 1.15,
        reason: `good n=${count} ev=${expectancy.toFixed(2)}`
      };
    }

    if (expectancy < -5) {
      return {
        allow: true,
        sizeMult: 0.70,
        reason: `bad-but-not-blocked n=${count} ev=${expectancy.toFixed(2)}`
      };
    }

    if (expectancy < 0) {
      return {
        allow: true,
        sizeMult: 0.85,
        reason: `weak n=${count} ev=${expectancy.toFixed(2)}`
      };
    }

    return {
      allow: true,
      sizeMult: 1.0,
      reason: `neutral n=${count} ev=${expectancy.toFixed(2)}`
    };
  }

  // Block on negative EV OR combined weak stats — don't let setups bleed slowly
  if (expectancy < -5 || (expectancy < 0 && winRate < 0.45)) {
    return {
      allow: false,
      sizeMult: 0.0,
      reason: `blocked n=${count} ev=${expectancy.toFixed(2)} wr=${(winRate * 100).toFixed(1)}%`
    };
  }

  // Persistent negative EV with large sample: hard block regardless of win rate
  if (expectancy < 0 && count >= 80) {
    return {
      allow: false,
      sizeMult: 0.0,
      reason: `blocked-persistent n=${count} ev=${expectancy.toFixed(2)} wr=${(winRate * 100).toFixed(1)}%`
    };
  }

  if (expectancy < 0) {
    return {
      allow: true,
      sizeMult: 0.60,  // was 0.75 — more aggressive reduction while still allowing
      reason: `established-weak n=${count} ev=${expectancy.toFixed(2)}`
    };
  }

  if (expectancy > 8 && winRate > 0.52) {
    return {
      allow: true,
      sizeMult: 1.20,
      reason: `established-strong n=${count} ev=${expectancy.toFixed(2)}`
    };
  }

  return {
    allow: true,
    sizeMult: 1.0,
    reason: `established-neutral n=${count} ev=${expectancy.toFixed(2)}`
  };
}

export function getSetupRiskMultiplier(state, setupType) {
  const stats = getSetupStats(state.trades || [], setupType);

  if (!stats || stats.count < 20) return 1.0;
  if (stats.expectancy > 8) return 1.25;
  if (stats.expectancy > 3) return 1.10;
  if (stats.expectancy < 0) return 0.75;
  return 1.0;
}

export function getAdaptiveClaudeThreshold(state, currentRegime) {
  if (!state.regimeStats) return CLAUDE_THRESHOLD;

  const rs = state.regimeStats[currentRegime];
  if (!rs || rs.count < 15) return CLAUDE_THRESHOLD;

  const winRate = rs.wins / rs.count;
  const claudeStats = getApprovalStats(state.trades || [], "claude");
  const autoStats = getApprovalStats(state.trades || [], "auto");
  let adaptive = CLAUDE_THRESHOLD;

  if (winRate < 0.40) adaptive -= 1;
  if (winRate > 0.55) adaptive += 1;

  if (claudeStats && claudeStats.count >= 8) {
    if (claudeStats.expectancy < 0) adaptive += 1;
    else if (
      claudeStats.expectancy > 0 &&
      (!autoStats || autoStats.count < 15 || claudeStats.expectancy > autoStats.expectancy)
    ) {
      adaptive -= 1;
    }
  }

  return Math.max(CLAUDE_THRESHOLD - 2, Math.min(CLAUDE_THRESHOLD + 2, adaptive));
}

export function calculatePerformanceMetrics(trades) {
  if (trades.length < 5) return null;

  const returns = trades.map((trade) => (trade.pnl / (trade.notional || 500)) * 100);
  const avg = mean(returns);
  const sd = std(returns);

  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(365) : 0;
  const negRet = returns.filter((r) => r < 0);
  const downDev = negRet.length > 0 ? std(negRet) : 0.001;
  const sortino = (avg / downDev) * Math.sqrt(365);

  let peak = 0;
  let maxDD = 0;
  let eq = 0;
  for (const r of returns) {
    eq += r;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }

  const gp = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(returns.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const pf = gl > 0 ? gp / gl : gp > 0 ? 999 : 0;

  return {
    totalTrades: trades.length,
    winRate: ((trades.filter((trade) => trade.pnl > 0).length / trades.length) * 100).toFixed(1),
    sharpe: sharpe.toFixed(2),
    sortino: sortino.toFixed(2),
    maxDrawdown: maxDD.toFixed(2),
    profitFactor: pf.toFixed(2)
  };
}

export function estimateMonthlySpend(usage) {
  if (!usage) return 0;
  return ((usage.input || 0) / 1_000_000) * INPUT_COST_PER_MTOK +
         ((usage.output || 0) / 1_000_000) * OUTPUT_COST_PER_MTOK;
}

export function calculateRecentLiveHealth(state, lookback = 100) {
  const trades = (state?.trades || []).slice(-lookback);
  if (trades.length < 30) {
    return {
      enoughData: false,
      count: trades.length
    };
  }

  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const winRate = wins.length / trades.length;
  const totalPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const expectancy = totalPnl / trades.length;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : 999;

  return {
    enoughData: true,
    count: trades.length,
    winRate,
    expectancy,
    profitFactor,
    totalPnl
  };
}

export function checkPerformanceDrift(state) {
  const health = calculateRecentLiveHealth(state, 100);
  if (!health.enoughData) return null;

  const alerts = [];

  if (health.profitFactor < 1.30) {
    alerts.push(`PF low: ${health.profitFactor.toFixed(2)} < 1.30`);
  }

  if (health.winRate < 0.40) {
    alerts.push(`WR low: ${(health.winRate * 100).toFixed(1)}% < 40%`);
  }

  if (health.expectancy < 2.0) {
    alerts.push(`Expectancy low: $${health.expectancy.toFixed(2)} < $2.00`);
  }

  if ((state.drawdown || 0) > 0.08) {
    alerts.push(`Drawdown high: ${((state.drawdown || 0) * 100).toFixed(1)}% > 8%`);
  }

  const driftStatus = {
    status: alerts.length === 0 ? "healthy" : "warning",
    checkedAt: new Date().toISOString(),
    baseline: LIVE_BASELINE,
    alerts,
    ...health
  };

  state.driftStatus = driftStatus;
  return alerts.length === 0 ? null : driftStatus;
}

function mean(arr) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length);
}

/**
 * Kelly-criterion sizing with volatility (ATR) scaling.
 *
 * Half-Kelly fraction: f = 0.5 × (b×p − q) / b
 *   where b = avgWin/avgLoss, p = winRate, q = 1−p
 *
 * The Kelly multiplier is normalized against RISK_PCT so the caller gets a
 * direct scaling factor on top of the existing risk budget.
 * Clamped to [0.5, 1.5] to prevent extreme position sizes.
 *
 * ATR volatility scaling:
 *   - current ATR > 1.5× median historical → scale down (high vol environment)
 *   - current ATR < 0.7× median historical → scale up slightly (compression phase)
 *
 * @param {object|null} stats  output of getSetupStats / getApprovalStats
 * @param {number} currentAtr  ATR at entry
 * @param {number[]} atrHistory  rolling ATR values for this symbol (last 30)
 * @returns {{ mult:number, reason:string }}
 */
export function computeKellySizing(stats, currentAtr, atrHistory = []) {
  if (!stats || stats.count < 20 || stats.avgLoss === 0) {
    return { mult: 1.0, reason: "kelly:no-data" };
  }

  const { winRate, avgWin, avgLoss } = stats;
  const b = avgWin / avgLoss;
  const rawKelly = (b * winRate - (1 - winRate)) / b;
  const halfKelly = rawKelly / 2;

  // Normalize: our baseline risk is RISK_PCT. Kelly says bet halfKelly of capital.
  // We translate: kellyMult = halfKelly / RISK_PCT, but clamp hard.
  const { RISK_PCT } = { RISK_PCT: 0.03 };
  const kellyMult = Math.max(0.5, Math.min(1.5, halfKelly / RISK_PCT));

  let atrMult = 1.0;
  let atrNote = "atr:neutral";
  if (atrHistory.length >= 10 && currentAtr > 0) {
    const sorted = [...atrHistory].sort((a, b) => a - b);
    const medianAtr = sorted[Math.floor(sorted.length / 2)];
    if (medianAtr > 0) {
      const ratio = currentAtr / medianAtr;
      if (ratio > 1.5)      { atrMult = 0.75; atrNote = `atr:high(${ratio.toFixed(2)}x)`; }
      else if (ratio > 1.2) { atrMult = 0.90; atrNote = `atr:elevated(${ratio.toFixed(2)}x)`; }
      else if (ratio < 0.7) { atrMult = 1.10; atrNote = `atr:compressed(${ratio.toFixed(2)}x)`; }
    }
  }

  return {
    mult: Math.max(0.5, Math.min(1.5, kellyMult * atrMult)),
    reason: `kelly:${halfKelly.toFixed(3)} mult:${kellyMult.toFixed(2)} ${atrNote}`
  };
}

/**
 * Tracks ATR values per symbol for volatility-adjusted sizing.
 * Keeps a rolling window of the last 30 ATR values.
 * Call this each time a position is opened.
 *
 * @param {object} state
 * @param {string} symbol
 * @param {number} atrVal
 */
export function trackAtrHistory(state, symbol, atrVal) {
  if (!Number.isFinite(atrVal) || atrVal <= 0) return;
  if (!state.atrHistory) state.atrHistory = {};
  if (!state.atrHistory[symbol]) state.atrHistory[symbol] = [];
  state.atrHistory[symbol].push(atrVal);
  if (state.atrHistory[symbol].length > 30) {
    state.atrHistory[symbol] = state.atrHistory[symbol].slice(-30);
  }
}

/**
 * Checks each signal in state.signalStats for degradation.
 * Returns an array of alert strings for signals where WR has dropped below
 * threshold over the last N trades.
 *
 * @param {object} state
 * @param {{ minCount:number, wrThreshold:number }} opts
 * @returns {string[]}
 */
export function getSignalDegradationAlerts(state, { minCount = 20, wrThreshold = 0.35 } = {}) {
  const alerts = [];
  const signalStats = state.signalStats || {};
  for (const [signal, s] of Object.entries(signalStats)) {
    if (!s || s.count < minCount) continue;
    const wr = s.wins / s.count;
    if (wr < wrThreshold) {
      alerts.push(`${signal}: ${s.count} trades WR=${(wr * 100).toFixed(1)}% (below ${(wrThreshold * 100).toFixed(0)}%)`);
    }
  }
  return alerts;
}

export { MONTHLY_BUDGET_USD };
