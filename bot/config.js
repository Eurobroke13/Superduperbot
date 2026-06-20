// =============================================================================
// BOT CONFIGURATION — pure constants, no logic
// Import this module wherever you need tunable parameters.
// =============================================================================

// -----------------------------------------------------------------------------
// API endpoints & model
// -----------------------------------------------------------------------------
export const API_BASE       = "https://www.okx.com";
export const ANTHROPIC_API  = "https://api.anthropic.com/v1/messages";
export const LUNARCRUSH_API = "https://lunarcrush.com/api4/public/coins";
export const CLAUDE_MODEL   = "claude-sonnet-4-6";

// -----------------------------------------------------------------------------
// Trading parameters
// -----------------------------------------------------------------------------
export const PAPER_CASH         = 10000;
export const RISK_PCT           = 0.03;
export const MAX_LEVERAGE       = 6;
export const MAX_POSITION_SHARE = 1 / 10;
export const ATR_SL_MULT        = 2.0;
export const ATR_TP_MULT        = 4.0;
export const MAX_POSITIONS      = 10;
export const ENTRY_THRESHOLD    = 4;
export const CLAUDE_THRESHOLD   = 6;
// Minimum score for an entry to bypass a daily-loss / mid-run drawdown halt.
// On a halt day only A+ setups at or above this score are allowed through.
export const HIGH_CONVICTION_OVERRIDE = 6;

// ── Edge-recovery gates (June 2026) ──────────────────────────────────────────
// Post-fix live analysis (50 trades, system clean since 2026-06-10) showed the
// bot only earns in three pockets — mean-reversion, sideways regime, and
// Claude-gated entries — and bleeds everywhere else:
//   • blind auto-approval  -$383 (43 trades, 33% WR)
//   • momentum setups      -$294 (22% WR — the single worst bucket)
//   • trend/momentum shorts -$184 (25% WR)
// The score itself lost predictive power live (winners avg 5.33 vs losers 5.27),
// so these gates shrink the bot to its demonstrated edge rather than re-tuning
// thresholds. Flip any flag to false to restore the prior behavior.
export const REQUIRE_CLAUDE_APPROVAL = true;  // no blind auto-approval; route entries through Claude
export const DISABLE_MOMENTUM_SETUPS = true;  // block "momentum" setupType entries
export const SHORTS_BEAR_ONLY        = true;  // block trend/momentum shorts outside bear (MR shorts exempt)

// Mean-reversion pivot (June 2026): the signal-lift analysis showed every
// MR/fade signal has positive out-of-sample edge while every trend/momentum
// signal is negative. This makes MR the primary strategy — non-MR setups are
// blocked unless they reach MR_PRIMARY_THRESHOLD, so only mean-reversion and
// reasonably-scored, Claude-vetted trend setups can enter.
export const MEAN_REVERSION_PRIMARY  = true;
// Score floor for non-MR setups to pass the MR-primary gate (then Claude still vets them).
// Set below CLAUDE_THRESHOLD (6) so medium-quality trend/breakout setups can reach Claude.
export const MR_PRIMARY_THRESHOLD    = 5.0;

// MR minimum stop-distance floor (June 2026 — the RLS lesson): a mean-reversion
// fade needs the stop placed beyond ordinary noise, or it gets wicked out before
// price reverts. Live, RLS stopped out on a −0.33% move (−$5.80) — its 1h ATR
// was so compressed that the 2×ATR stop sat inside the noise. (Quote volume was
// NOT the issue: RLS does $272M/24h. The stop was simply too tight.) If the
// projected MR stop (ATR_SL_MULT × ATR/price) is closer than this floor, the
// entry is skipped with reason `mr-stop-too-tight`. Tunable — raise to demand
// more room (skips more compressed-tape MR), lower to allow tighter stops.
export const MR_MIN_STOP_DISTANCE_PCT = 0.008;  // 0.8% of entry price

export const CANDLE_LIMIT       = 500;
export const DRAWDOWN_LIMIT     = 0.15;

// -----------------------------------------------------------------------------
// Budget / cost constants
// -----------------------------------------------------------------------------
export const MONTHLY_BUDGET_USD   = 40.00;
export const INPUT_COST_PER_MTOK  = 3.00;
export const OUTPUT_COST_PER_MTOK = 15.00;

// -----------------------------------------------------------------------------
// Signal weights
// -----------------------------------------------------------------------------
export const SIGNAL_WEIGHTS = {
  "TK-bull": 1.0, "TK-bear": 1.0,
  "above-cloud": 0.5, "below-cloud": 1.5,
  "chikou-bull": 0.8, "chikou-bear": 0.8,
  "OBV-bull-div": 0.0, "OBV-bear-div": 0.0,  // zeroed: negative lift across all history (n=22/36)
  "fisher-rising": 0.0, "fisher-falling": 0.5,
  "rsi-bull-div": 0.5, "rsi-bear-div": 0.35,
  "ema-ribbon-bull": 1.5, "ema-ribbon-bear": 1.5,
  "ribbon-h4-align-bull": 1.0, "ribbon-h4-align-bear": 1.0,
  "fisher-oversold": 0.5, "fisher-overbought": 1.2,
  "above-VWAP": 1.0, "below-VWAP": 1.0,
  "gauss-up": 0.7, "gauss-down": 0.7,
  "rsi-oversold": 1.3, "rsi-overbought": 1.3,
  "near-support": 1.5, "near-resistance": 1.5,
  "in-HVN": -1.5,
  "macd-cross-up": 0.0, "macd-cross-down": 0.0,  // zeroed: worst EV in dataset (macd-cross-up lift -$62.58)
  "adx-strong-bull": 1.0, "adx-strong-bear": 1.0,
  "bb-oversold": 1.0, "bb-overbought": 1.0,
  "stochrsi-oversold": 0.0, "stochrsi-overbought": 1.0,  // stochrsi-oversold zeroed: 0% WR, lift -$33.30
  "stochrsi-cross-up": 0.8, "stochrsi-cross-down": 0.8,
  "rsi-support-bounce": 1.0, "rsi-resistance-reject": 1.0,
  "ribbon-expansion-bull": 2.0, "ribbon-expansion-bear": 0.0,  // ribbon-expansion-bear zeroed: 0% WR, lift -$24.84
  "liquidity-bull": 0.75, "liquidity-bear": 0.5,
  "trap-bull-confirm": 0.35, "trap-bear-confirm": 2.0,
  "trap-vol-bull": 0.05, "trap-vol-bear": 0.0,
  "volume-confirm": 1.5, "volume-climax": -0.5,
  "funding-crowded-long": 1.0, "funding-crowded-short": 1.0,
  "funding-extreme-long": 1.5, "funding-extreme-short": 1.5,
  "h4-bull": 2.0, "h4-bear": 2.0,
  "news-boost": 0.8,
  "lunar-bull": 0.7, "lunar-bear": 0.7,
  "lunar-sentiment-warning": -1.0,
};

// Snapshot of the original weights — used to reset dynamic adjustments
export const BASE_WEIGHTS = { ...SIGNAL_WEIGHTS };

// ── Per-regime signal weight multipliers ──────────────────────────────────────
// Applied multiplicatively on top of dynamic weights in getSignalMultiplier().
// Values > 1 boost, < 1 dampen. Signals not listed here inherit 1.0 (no change).
// Derived from out-of-sample lift analysis on 509 live trades (June 2026).
export const REGIME_SIGNAL_MULTIPLIERS = {
  bull: {
    "fisher-rising":        1.5,
    "TK-bull":              1.5,
    "above-cloud":          1.4,
    "chikou-bull":          1.4,
    "adx-strong-bull":      1.5,
    "h4-bull":              1.4,
    "above-VWAP":           1.3,
    "ema-ribbon-bull":      1.3,
    "gauss-up":             1.2,
    "ribbon-h4-align-bull": 1.2,
    "TK-bear":              0.5,
    "below-cloud":          0.5,
    "chikou-bear":          0.5,
    "ema-ribbon-bear":      0.5,
    "h4-bear":              0.5,
    "below-VWAP":           0.6,
    "gauss-down":           0.5,
  },
  bear: {
    "TK-bear":              1.4,
    "below-cloud":          1.4,
    "chikou-bear":          1.4,
    "fisher-falling":       1.4,
    "h4-bear":              1.3,
    "below-VWAP":           1.3,
    "ema-ribbon-bear":      1.3,
    "gauss-down":           1.2,
    "TK-bull":              0.5,
    "above-cloud":          0.5,
    "chikou-bull":          0.5,
    "ema-ribbon-bull":      0.5,
    "h4-bull":              0.5,
    "above-VWAP":           0.6,
    "fisher-rising":        0.5,
  },
  sideways: {
    "near-support":          1.5,
    "near-resistance":       1.5,
    "rsi-oversold":          1.4,
    "rsi-overbought":        1.4,
    "fisher-oversold":       1.3,
    "fisher-overbought":     1.3,
    "bb-oversold":           1.3,
    "bb-overbought":         1.3,
    "rsi-support-bounce":    1.4,
    "rsi-resistance-reject": 1.4,
    "TK-bull":               0.6,
    "TK-bear":               0.6,
    "above-cloud":           0.6,
    "below-cloud":           0.6,
    "ema-ribbon-bull":       0.6,
    "ema-ribbon-bear":       0.6,
    "h4-bull":               0.6,
    "h4-bear":               0.6,
    "adx-strong-bull":       0.5,
    "adx-strong-bear":       0.5,
  },
};

// -----------------------------------------------------------------------------
// Funding / settlement constants
// -----------------------------------------------------------------------------
export const FUNDING_SETTLEMENT_HOURS = [0, 8, 16];
export const SETTLEMENT_AVOID_MINUTES = 10;

// Historical hour-of-day performance modifiers (UTC)
export const HOUR_PERFORMANCE = {
  0: -0.3, 1: 0.0, 2: 0.0, 3: 0.0, 4: 0.1, 5: 0.2, 6: 0.2, 7: 0.0,
  8: -0.3, 9: 0.1, 10: 0.2, 11: 0.2, 12: 0.1, 13: 0.2, 14: 0.3,
  15: 0.2, 16: -0.3, 17: 0.1, 18: 0.1, 19: 0.1, 20: 0.0,
  21: -0.1, 22: -0.1, 23: 0.0,
};
