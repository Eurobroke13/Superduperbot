/**
 * Canonical scored trade candidate produced by scoring and passed through entry,
 * risk, and execution modules.
 *
 * @typedef {Object} ScoredCandidate
 * @property {string} symbol - OKX instrument id, e.g. "BTC-USDT-SWAP".
 * @property {"long"|"short"} signal - Canonical trade direction field.
 * @property {"long"|"short"} direction - Alias for signal; both are set on the return object.
 * @property {number} score - Raw composite score from the scoring pipeline.
 * @property {number} [rawScore] - Original score before entry-policy filters.
 * @property {number} [adjustedScore] - Score after entry-policy penalties.
 * @property {string} setupType - trend, momentum, breakout, liquidity-trap, mean-reversion, etc.
 * @property {number} price - Intended entry price or signal-time market price.
 * @property {number} atrVal - Current ATR value used for stops and entry policy.
 * @property {number} [atrPct] - ATR as a fraction of price.
 * @property {number} [ema21] - Midline EMA used by EMA distance gate.
 * @property {number} [signalCandleHigh] - High of the candle that produced the signal.
 * @property {number} [signalCandleLow] - Low of the candle that produced the signal.
 * @property {number} [signalCandleClose] - Close of the candle that produced the signal.
 * @property {number} [rsiVal]
 * @property {number} [fisherVal]
 * @property {string|null} [obvDiv]
 * @property {number} [vwapVal]
 * @property {Object} [adxResult]
 * @property {number|null} [fundingRate]
 * @property {number} sl - Stop-loss price.
 * @property {number} tp - Take-profit price.
 * @property {number} riskReward - Reward-to-risk ratio.
 * @property {string[]} reasons - Signals and modifiers that explain the score.
 * @property {string[]} [signalSet] - Deduplicated signal set used by entry policy.
 * @property {"bullish"|"bearish"|"neutral"|"unknown"} [h4Trend]
 * @property {string} [approvalType] - auto, claude, claude-cached, auto-fast.
 * @property {string} [entryType] - market, limit, decaying-limit, decaying-market.
 * @property {number|null} [lunarSentiment]
 * @property {number|null} [lunarGalaxyScore]
 * @property {number|null} [lunarSocialVolume]
 * @property {number|null} [lunarAltRank]
 */

export {};
