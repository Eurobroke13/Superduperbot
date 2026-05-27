# Signal Weights Notes

Last reviewed: 2026-05-17 after the live-aligned 6-month seed.

This file documents asymmetric or disabled weights so future backtest seeds do
not accidentally overwrite deliberate choices. In sideways regimes,
`getWeightRegimeAware()` averages paired bull/bear weights; these raw weights
still apply in bull and bear regimes.

| Signal pair | Current weights | What it detects | Why asymmetric | Source / sample |
| --- | ---: | --- | --- | --- |
| `ribbon-expansion-bull` / `ribbon-expansion-bear` | `2.0` / `0.65` | EMA ribbon expansion after compression. | Backtest-favored long continuation more than short continuation, but this is partially neutralized in sideways regimes. | Seeded/tuned from 6m backtests; recheck whenever setup mix changes by more than 20%. |
| `liquidity-bull` / `liquidity-bear` | `0.75` / `0.0` | Wick-and-reclaim style liquidity trap context. | Bear side is disabled because prior runs treated it as noisy context rather than a reliable short entry. | Manual override plus backtest evidence; keep disabled until bear traps show positive EV over at least 30 trades. |
| `trap-bull-confirm` / `trap-bear-confirm` | `0.35` / `2.0` | Confirmation after a detected trap. | Bear confirmations were far more profitable in the seeded sample; bull confirmations remain low to avoid overpaying for weak reversals. | Backtest-derived; suspicious enough to review after the next 30 live trap-confirm trades. |
| `trap-vol-bull` / `trap-vol-bear` | `0.05` / `0.0` | Volume confirmation around trap signals. | Both are effectively disabled because trap volume alone was too noisy. `trap-vol-bear` is also added to `disabledSignals` on state load. | Manual safety override; re-enable only after isolated fixture/backtest proof. |
| `OBV-bull-div` / `OBV-bear-div` | `0.5` / `0.35` | OBV divergence against price. | Mild long bias from historical follow-through. | Backtest-derived, low asymmetry; safe to revisit during regular weight reviews. |
| `above-cloud` / `below-cloud` | `0.5` / `1.5` | Ichimoku cloud position. | Short-side cloud breaks carried more informational value in the seeded period. | Backtest-derived; watch for regime drift. |
| `lunar-galaxy-gradient` | `0.7` | Continuous galaxy score (0–100 → −1 to +1, ×weight). Replaces binary `lunar-bull`/`lunar-bear`. Dead zone ±15% filters noise. | Gradient preserves information lost at binary cutoffs — Galaxy 58 was invisible before, now contributes proportionally. | New signal; review after 50+ lunar-tagged trades. |
| `lunar-alt-rank` | `0.5` | Top-20 altRank: full boost. Top-50: 40%. 200+: −0.3 penalty. | Top-ranked coins correlate social momentum with price action; low-ranked coins are riskier on social signals. | Conservative start; increase if top-rank WR exceeds baseline by 5%+. |
| `lunar-social-volume-spike` / `lunar-social-volume-warn` | `0.8` / `−0.6` | 2x+ social volume vs 10-sample rolling avg. Boost if sentiment aligns, warn if opposing. | Sudden social attention often front-runs moves; opposing attention = crowd disagrees with your direction. | Needs ~5h warmup per coin. Review 2x threshold after 30 spike-tagged trades. |

## Retired Signals

- `lunar-bull: 0.7`: replaced by `lunar-galaxy-gradient`. Binary >60 cutoff discarded information in the 30–60 and 60–80 ranges.
- `lunar-bear: 0.7`: replaced by `lunar-galaxy-gradient`. Same reason as above; direction sign is now handled internally by the gradient.

## Disabled Signals

- `liquidity-bear: 0.0`: intentionally disabled as a standalone bearish
  liquidity context signal. Re-enable only if a focused backtest shows positive
  EV over at least 30 trades and it is not simply duplicating `trap-bear-confirm`.
- `trap-vol-bear: 0.0`: disabled both in config and state load. Treat as noise
  until volume trap logic is split by regime and direction.
- `trap-vol-bull: 0.05`: left near zero so it can appear in diagnostics without
  materially moving the score.

## Hardcoded disable in adaptation.js

`trap-vol-bear` is unconditionally appended to `state.disabledSignals` at the
end of every `updateDynamicWeights()` call:

```js
state.disabledSignals = Array.from(new Set([...disabled, "trap-vol-bear"]));
```

This means the adaptive system can never re-enable it on its own. To re-enable
it, you must remove this hardcoded entry **and** raise the config weight above
0.0.

## Sample-size thresholds (updated 2026-05-17)

Adaptive logic now requires higher sample counts before adjusting weights or
sizing:

| Location | Old threshold | New threshold |
|---|---|---|
| `getSignalMultiplier` regime branch (scoring.js) | 8 | 20 |
| `getSignalMultiplier` overall branch (scoring.js) | 10 | 15 |
| `updateDynamicWeights` (adaptation.js) | 8 | 20 |
| `getAdaptiveSetupDecision` low-sample gate (stats.js) | 10 | 15 |
| `getAdaptiveSetupDecision` early-adjust gate (stats.js) | 20 | 25 |

Multiplier ranges were also compressed (max boost 1.35→1.20, max penalty
0.55→0.65) to reduce volatility from small samples.

## Review Rule

When changing these weights, record the date, sample size, and reason here.
For seeded dynamic weights, compare bull/bear paired samples before accepting a
large ratio. A ratio above 3:1 should be treated as a hypothesis to verify, not
as a permanent truth.
