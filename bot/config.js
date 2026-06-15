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
  "OBV-bull-div": 0.5, "OBV-bear-div": 0.3,
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
  "macd-cross-up": 1.2, "macd-cross-down": 1.2,
  "adx-strong-bull": 1.0, "adx-strong-bear": 1.0,
  "bb-oversold": 1.0, "bb-overbought": 1.0,
  "stochrsi-oversold": 0.5, "stochrsi-overbought": 1.0,
  "stochrsi-cross-up": 0.8, "stochrsi-cross-down": 0.8,
  "rsi-support-bounce": 1.0, "rsi-resistance-reject": 1.0,
  "ribbon-expansion-bull": 2.0, "ribbon-expansion-bear": 0.65,
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
