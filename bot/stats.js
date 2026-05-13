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
  const stats = getSetupStats(state.trades || [], setupType);

  if (!stats) {
    return {
      allow: true,
      sizeMult: 1.0,
      reason: "no-stats"
    };
  }

  const { count, expectancy, winRate } = stats;

  if (count < 10) {
    return {
      allow: true,
      sizeMult: 1.0,
      reason: "low-sample"
    };
  }

  if (count < 20) {
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

  if (expectancy < -5 && winRate < 0.45) {
    return {
      allow: false,
      sizeMult: 0.0,
      reason: `blocked n=${count} ev=${expectancy.toFixed(2)} wr=${(winRate * 100).toFixed(1)}%`
    };
  }

  if (expectancy < 0) {
    return {
      allow: true,
      sizeMult: 0.75,
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

export { MONTHLY_BUDGET_USD };
