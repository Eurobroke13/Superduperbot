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
export const CLAUDE_MODEL   = "claude-sonnet-4-20250514";

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
  "above-cloud": 1.5, "below-cloud": 1.5,
  "chikou-bull": 0.8, "chikou-bear": 0.8,
  "OBV-bull-div": 2.5, "OBV-bear-div": 2.5,
  "fisher-rising": 0.8, "fisher-falling": 0.8,
  "rsi-bull-div": 2.0, "rsi-bear-div": 2.0,
  "ema-ribbon-bull": 1.5, "ema-ribbon-bear": 1.5,
  "fisher-oversold": 1.2, "fisher-overbought": 1.2,
  "above-VWAP": 1.0, "below-VWAP": 1.0,
  "gauss-up": 0.7, "gauss-down": 0.7,
  "rsi-oversold": 1.3, "rsi-overbought": 1.3,
  "near-support": 1.5, "near-resistance": 1.5,
  "in-HVN": -1.5,
  "macd-cross-up": 1.2, "macd-cross-down": 1.2,
  "adx-strong-bull": 1.0, "adx-strong-bear": 1.0,
  "bb-oversold": 1.0, "bb-overbought": 1.0,
  "stochrsi-oversold": 1.0, "stochrsi-overbought": 1.0,
  "stochrsi-cross-up": 0.8, "stochrsi-cross-down": 0.8,
  "rsi-support-bounce": 1.0, "rsi-resistance-reject": 1.0,
  "ribbon-expansion-bull": 2.0, "ribbon-expansion-bear": 2.0,
  "liquidity-bull": 2.0, "liquidity-bear": 2.0,
  "trap-bull-confirm": 2.0, "trap-bear-confirm": 2.0,
  "trap-vol-bull": 2.0, "trap-vol-bear": 2.0,
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
