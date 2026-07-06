# Superduperbot — Claude Session Context

## What this project is
A crypto futures paper-trading bot running on OKX perpetual swaps. It detects market regime (bull/bear/sideways), scores trade candidates using technical indicators, gets Claude AI approval for higher-conviction entries, and manages exits via graduated stop-loss/take-profit logic.

---

## Railway Services Architecture

There are 6 services in the `patient-analysis` Railway project (`production` environment):

| Service | Type | Schedule | Command | Purpose |
|---|---|---|---|---|
| **Superduperbot** | Always-on server | Every 15 min (internal) | `npm start` → `node server.js` | Main bot: full regime refresh, scoring, Claude approval, exits |
| **superduperbot-runner** | Cron | Every 2 min | `npm run task:fast-scan` | Fast scan: exit checks + auto-only entries between main runs, NO Claude calls, NO regime refresh |
| **superduperbot-weekly** | Cron | Sundays 08:00 UTC | `npm run task:weekly-review` | Weekly performance report to Telegram |
| **superduperbot-trade-a...** | Cron | Sundays 08:00 UTC | `npm run task:trade-analysis` | Trade breakdown report (setup/approval/signal stats) |
| **superduperbot-premarket** | Cron | Daily | `npm run task:premarket` | **DISABLED in code** — premarket case is a no-op in task-runner.js |
| ~~**apply-seed-job**~~ | One-off | Manual | `node backtest.js --seed-safe` | **DELETED** — was seeding regime/signal stats from backtest. Recreate a one-off (point config at a dedicated `railway-*.json`) if seeding/pruning/analysis is needed. |

**Important:** `superduperbot-premarket` still fires on schedule but does nothing — the `premarket` case in `task-runner.js` is commented out. Consider removing this service.

**Railway config-as-code (June 2026):** The root `railway.json` hardcodes `startCommand: "npm start"`, and every service that deploys from this repo inherits it — which silently overrides each service's dashboard start command. This is why the runner kept launching the full server. The fix is a **separate `railway-runner.json`** (runs `npm run task:fast-scan`, no `/health` healthcheck since it's a cron worker, not a web server). The runner service must point its config-file path at `railway-runner.json` in Railway Settings → Config-as-code. The main **Superduperbot** server keeps using `railway.json` (`npm start`). Do NOT change the `startCommand` value in the shared `railway.json` — it would break the main server.

### How main bot and fast-scan runner coordinate
- Main bot (15 min): loads state → refreshes regime → fetches news → scores 60 contracts → Claude approval → saves state
- Fast-scan runner (2 min): loads state → uses **cached regime** → scores batch → **auto-approves only** (no Claude) → saves state
- **Postgres advisory lock** (`withBotLock` in `db.js`) prevents them running simultaneously — if the main bot is mid-run when the cron fires, the fast-scan skips that cycle with `[LOCK] Another bot run is active — skipping this run`
- **Symbol rotation** — both services share `state.scanBatchOffset` (persisted in Postgres). Each run advances the offset by `maxSymbolsPerRun` (60 in sideways, 50 otherwise). They naturally interleave: main bot scans 0-60, runner picks up at 60-120, etc. — full ~250-symbol universe covered in ~10 min combined.

---

## Key Files

```
server.js              — Express server, internal 15-min scheduler, /health /pnl /run endpoints
task-runner.js         — CLI entry point for all cron jobs (fast-scan, weekly-review, etc.)
bot/
  runner.js            — Core bot logic: checkAllExits → phaseRegimeAndExits → phaseScan
  deps.js              — Dependency injection wiring; wraps runBot with withBotLock
  claude.js            — Anthropic API calls; budget tracking; CLAUDE_LIMIT_FALLBACK detection
  config.js            — All constants: CLAUDE_MODEL, MONTHLY_BUDGET_USD, thresholds, signal weights, REGIME_SIGNAL_MULTIPLIERS
  exits.js             — closePosition, partial closes, cooldown registration
  cooldown.js          — Post-TP cooldown (4h); overbought-SL cooldown (6h); same-run SL block
  indicators.js        — Pure indicator functions: atrPercentile, weeklyPivots, volumeDelta, anchoredVWAP
  scoring.js           — scoreSymbol, signal detection, autoApproveSignal, confirm15mBullTrend
  reports.js           — sendDailyReport (unused), sendWeeklyReview, premarketScan, sendTradeAnalysis
  adaptation.js        — Dynamic signal weight updates (time-decayed), regime stats tracking
  execution.js         — Position sizing, tranche scale-ins (checkTranches), DCA (checkDCA)
  telegram.js          — sendTelegram, notifyTrade (OPEN/CLOSE/PARTIAL/TRANCHE/DCA)
  risk-gates.js        — Daily loss limit (4%), min R:R gate, mid-run drawdown halt (4%)
  runner-utils.js      — Pure helpers: buildRegimeConsensus, checkMidRunDrawdown, routeToApprovalLists, applySyncFilters, applyBullTrend15m, etc.
db.js                  — Postgres pool, withTransaction, withBotLock (advisory lock)
state-store.js         — loadState / saveState; atomic trade + blob writes
trade-store.js         — Separate trades table (loadRecentTrades, insertTrade)
prune-trades.js        — Diagnostic/maintenance: per-day breakdown + scoped transactional delete of contaminated trades (dry-run by default)
analyze-trades.js      — Diagnostic: post-fix breakdown by setup/regime/approval/direction/exit-reason/score, per-signal lift overall + per-regime, daily equity curve
railway.json           — Shared Railway config (npm start) — used by main server
railway-runner.json    — Runner-only Railway config (npm run task:fast-scan)
railway-prune.json     — One-off config for prune-trades.js (node prune-trades.js, no healthcheck)
railway-analyze.json   — One-off config for analyze-trades.js (node analyze-trades.js, no healthcheck)
```

**Diagnostic one-offs (`prune-trades.js`, `analyze-trades.js`):** run via a Railway one-off
service that **must** point its config-as-code path at `railway-prune.json` / `railway-analyze.json`
— otherwise the root `railway.json` `npm start` override launches a full bot instance instead of
the script (this actually happened — a third bot ran on shared state). Give the service
`DATABASE_URL` (reference `${{Postgres.DATABASE_URL}}`). Both accept env-var args so the window
can be set without editing the start command: `PRUNE_FROM`/`PRUNE_TO`/`PRUNE_APPLY` and
`ANALYZE_FROM`(`=all`)/`ANALYZE_TO`/`ANALYZE_MIN_SIGNAL`. (The old `apply-seed-job` service was deleted.)

---

## Telegram Notifications (`bot/telegram.js` → `notifyTrade`)

Every position event pushes a Telegram message. Action types:
- **OPEN** — new entry (direction, entry, SL, TP, score, reasons)
- **CLOSE** — full exit (exit price, reason, PnL)
- **PARTIAL** — TP1/TP2 partial close (% closed, exit price, PnL)
- **TRANCHE** — T2/T3 scale-in fill (added margin, fill price, total, new avg, SL) — *added June 2026; previously only console-logged*
- **DCA** — averaging into a drawdown position (fill price, new avg, margin)

---

## State Management

All bot state lives in a single JSONB blob in Postgres (`bot_state` table, key `bot_state_v1`). Every `saveState` call rewrites the entire blob. Trades are also written to a separate `trades` table atomically in the same transaction.

**Key state fields:**
- `positions` — open positions map (symbol → position object)
- `trades` — last 500 closed trades (loaded from trades table on startup)
- `cash` — available paper cash
- `lastRegime` — cached regime (label, hmmLabel, piCycle, markovProb, refreshedAt)
- `cooldowns` — post-TP and overbought-SL cooldown expiries per symbol
- `_pendingTrades` — trades closed this run, flushed atomically on saveState
- `tokenUsage` — Anthropic API token counts for budget tracking
- `regimeStats` / `signalStats` — adaptive threshold inputs

---

## Claude API Configuration

- **Model:** `claude-sonnet-4-6` (set in `bot/config.js` → `CLAUDE_MODEL`)
- **Budget:** $40/month soft cap (`MONTHLY_BUDGET_USD`); hard stop at $38 (`checkBudget` in `claude.js`)
- **Fallback:** `CLAUDE_LIMIT_FALLBACK` — thrown when Anthropic returns a spend-limit error; bot falls back to auto-approval mode (score ≥ 5 threshold)
- **Error detection:** Only actual spend-limit messages trigger fallback. Other API errors (400, model errors, etc.) now log the full error text as `[CLAUDE] API error 400: ...` instead of silently falling back — check Railway logs if Claude stops working
- **JSON output:** `callClaudeBudgeted` steers JSON-only output via the **system prompt** (not an assistant-message prefill — newer models reject prefill) and parses defensively with `extractJsonObject` (strips ```json fences / prose, extracts outermost `{...}`, returns `"{}"` on failure).

**RESOLVED (June 2026) — the Claude approval outage:** Spend was stuck at $0.09 because **every** batch-approval call was 400ing. Root cause: `callClaudeBudgeted` forced JSON via an assistant-message prefill (`{ role: "assistant", content: "{" }`); the model rejects it — *"This model does not support assistant message prefill. The conversation must end with a user message."* So the bot silently fell back to auto-approving any score≥5 entry with **no AI gate** — exactly the marginal bear shorts that kept getting stopped out. Fixed by removing the prefill (`bot/claude.js`). After deploy, confirm: `[CLAUDE BATCH]` succeeds (no 400), and Claude spend ticks up from $0.09.

---

## Strategy Tuning (June 2026 — "strategy hardening" pass)

Six deliberate changes to improve edge. Each was sanity-checked; watch scan logs
after deploy to confirm they fire at sane rates.

1. **Signal weight de-bias** (`config.js`) — `liquidity-bear` 0.0→0.5, `OBV-bear-div` 0.0→0.3 to cut structural long bias. **`trap-vol-bear` deliberately left at 0.0** — `adaptation.js` force-disables it every run, so changing it is a no-op.
2. **DCA confirmation** (`execution.js` → `checkDCA`) — loss-scaled: requires **4/5** confirmations normally, **5/5** once >2 ATR underwater. Plus a hard veto: never average in when both MACD momentum AND VWAP value oppose the position. Log tells: `(X/4 confirmations, loss Y.Y ATR)` and `Vetoed: core trend (MACD+VWAP) against position`.
3. **Explicit TP3 target** (`exits.js` → `checkGraduatedExit`) — final 40% books at **5.5× ATR** (`tp3-target`) instead of trailing out for minimal gain. Structured `pos.tp` takes precedence when nearer; trailing SL still updates every call as the floor. Legacy in-flight positions without `tp3.price` gracefully fall back to trailing.
4. **Mean-reversion concurrency cap** (`runner.js` → `phaseScan`) — max **2** concurrent MR positions (open + this run's picks). Excess rejected with `mr-concurrency-cap`.
5. **Correlation cluster gate** (`scoring.js` → `checkCorrelationExposure`) — max **2** same-direction positions per cluster (majors/L1/L2/memes/AI/DeFi). Additive to the existing 7-per-side and 60%-exposure caps. Reason: `cluster <name> already has 2 longs/shorts`.
6. **Time-decayed adaptive learning** (`adaptation.js` → `buildSignalStats`/`updateDynamicWeights`) — exponential **10-day half-life** on each trade's contribution to WR/EV, so recent structure dominates stale history. **Raw sample counts** still gate the min-sample thresholds (count<20 skip, ≥25 disable), so thin recent data can't disable/boost a signal alone.

---

## MR Signal Hardening (June 2026)

Backtest analysis revealed three weak MR signals dragging mean-reversion WR below 30%:
`mr-at-support` (29% WR, +2.0 score), `mr-below-bb` (27% WR, +0.5), `mr-rsi-extreme-low` (26% WR, +2.0).

**Four improvements applied:**

1. **Bear-regime guard** — already enforced; MR cannot fire outside sideways (`scoring.js` → `applyMRGates` bails with `mr-not-sideways` for any non-sideways regime).
2. **Confirmation required** — enforced implicitly by the score threshold below: no single weak signal (max 2.0) can reach 5.0 alone. Genuine reversals need RSI extreme + Stoch + OBV divergence or volume exhaustion stacking.
3. **Minimum score raised 3.5 → 4.5** (`bot/entry-improvements.js` lines 312/349, both long and short branches). A single trigger like `mr-at-support` scores 2.0 — nowhere near 4.5. Two weak signals alone (`mr-at-support` + `mr-rsi-extreme-low` = 4.0) still don't qualify. The threshold aligns with the regime-adapted global entry threshold (also 4.5 in sideways), so MR setups are held to the same bar as every other setup type. Originally set to 5.0 but lowered after observing zero MR candidates in sideways — 5.0 was blocking legitimate medium-quality setups (RSI extreme + Stoch + volume exhaustion = 4.5).
4. **Position size capped at 0.70** — already set by `entry-improvements.js` (`positionSizeMultiplier: 0.70`). The execution.js fallback (used when the MR gate path isn't taken) was 0.85 — lowered to 0.70 to match (`bot/execution.js` line 145).

**Expected effect:** MR entry frequency drops significantly (only genuine multi-confirmation setups pass). Quality over quantity — fewer but higher-conviction entries.

### MR minimum stop-distance gate (June 2026 — the RLS lesson)

Live post-mortem (RLS-USDT-SWAP, 2026-06-19): an MR long opened @ $0.002400 and stopped out @ $0.002392 — a **−0.33% price move** (−$5.80, −1.3% on margin) in 3 hours. The bot's own sizing had already flagged it (`Kelly:-0.130 mult:0.50`, setup `ev=-6.52`) but only *halved* size rather than skipping. (The memory system then worked correctly — next day Claude *rejected* RLS re-entry citing the 0% WR / fee-dominated loss + journal flag.)

**Important — it was NOT a liquidity problem.** The first instinct was an illiquid-micro-cap / spread gate, but live OKX data killed that thesis: **RLS does $272M/24h**, while ATOM (the other, sensible MR entry that day) does only **$1.68M**. A quote-volume floor would have *blocked ATOM and let RLS through* — exactly backwards. RLS is a low-*priced* coin ($0.0024), not a low-*liquidity* one. The real cause: its 1h ATR was so compressed that the **2×ATR stop sat at only −0.33%**, inside ordinary noise.

**Why a stop-distance floor, not a wider stop, a Kelly hard-skip, or a volume gate:**
- *Wider stop* on a −EV name just turns small losses into bigger ones — skip the entry instead.
- *Negative-Kelly hard-skip* is too blunt: `computeKellySizing` (`stats.js`) is **setup-wide** (one number for all MR, currently negative from the edge-collapse) and clamped to `[0.5, 1.5]` — gating on it would block **essentially all** MR entries → back to the zero-trades problem. Kelly stays a *size* dial, which is its correct role.
- *Quote-volume gate* — rejected: the metric doesn't separate the bad trade (RLS, $272M) from the good one (ATOM, $1.68M).

**The gate** (`scoring.js` → `applyMRGates`, `MR_MIN_STOP_DISTANCE_PCT = 0.008` in `config.js`): compute the projected MR stop distance `ATR_SL_MULT × atrPct` (mirrors the ATR-based stop the bot places — RLS = 2.0 × 0.165% = 0.33%); if it's below **0.8% of entry**, bail with `mr-stop-too-tight`. Liquidity-agnostic, so it catches RLS without touching ATOM. Non-MR setups are unaffected. (`atrPct` is already computed in `computeIndicatorContext` and destructured into `scoreFromData` — **no extra plumbing and no `state` mutation**, so the main bot and the fast-scan runner apply it identically.) Tunable: raise to demand more room (skips more compressed-tape MR), lower to allow tighter stops. **Watch after deploy:** `mr-stop-too-tight` rejections should appear for ultra-compressed coins in scan-null logs while normally-volatile MR setups still pass.

---

## Scoring Symmetry Audit (June 2026)

A directional-symmetry pass on `scoring.js` / `applyMRGates` identified four items. Three are **intentional by design** — do not "fix" them:

**A. `mr-funding-longs-crowded` penalty is asymmetric (INTENTIONAL)**
`if (signal === "long" && fr > 0.0003) { score *= 0.90; }` has no mirror for shorts (`fr < -0.0003`). This was deliberately added (commit `dbeb6c7`) as a bias-correction tool — the bot has a structural long bias, and positive funding with longs crowded is a genuine warning that a mean-reversion long is not yet ready. Negative funding crowding shorts is rarer and shorter-lived in practice. Do not add a symmetric short-side penalty.

**B. `mr-funding-bear-crowded` / `mr-funding-bull-crowded` naming looks backwards (INTENTIONAL)**
`fr < -0.0001` (shorts crowded/paying) is labeled `"mr-funding-bear-crowded"` but bonuses a long signal. The name describes *which side is crowded*, not *which side gets the bonus*. Logic is correct (contrarian tailwind). Renaming would break signal stats history keyed on these strings — leave it.

**C. `h4-misaligned` hard-blocks trend/breakout setups but only soft-penalises momentum (INTENTIONAL)**
Trend and breakout setups require H4 alignment (`return null`); momentum gets a 0.80 multiplier. Deliberate by setup type — trend/breakout are directional bets where H4 misalignment is a genuine disqualifier, not just a headwind.

**D. `trap-bear-confirm` has a post-score re-check gate; `trap-bull-confirm` does not (LEAVE AS-IS)**
After scoring, short liquidity-trap setups with `trap-bear-confirm` are re-validated against H4/VWAP/ADX/RSI and can be nulled. Long setups have no equivalent gate. However, `trap-bull-confirm` weight is 0.35 vs `trap-bear-confirm` at 2.0 — the bull signal barely moves score anyway, so adding a re-check gate would make an already-marginal signal even harder to fire. Low impact, leave alone.

**Sweep confirmation gate (`bot/sweep-confirmation.js`) — hard zero is correct**
When a `liquidity-trap` setup has no confirmed sweep (`isConfirmedSweep` returns false), `c.score = 0` zeros the entire score. This is intentional — the old liquidity-trap fired on generic trend signals with no sweep verification, causing 6-8 correlated small-loss trades per cycle. The hard zero is the right call.

---

## 15m MR Confirmation Improvements (June 2026)

`confirmMeanReversionEntry` gates MR entries with a 15m timeframe check after the 1h score passes. Original patterns (hammer, engulfing, 3-bar reversal) require visible candle structure — they don't fire in low-volatility flat sideways markets, blocking all MR entries even when the 1h signal is valid.

**Two additions to `check15mReversal` (`bot/entry-improvements.js`):**

1. **RSI divergence** — price makes lower low but 15m RSI makes higher low (bullish), or price makes higher high but RSI makes lower high (bearish). Confidence +2.0. Works in flat markets where price moves are small but momentum is shifting. Alone sufficient to set `confirmed = true` (threshold 1.5).

2. **StochRSI crossover as independent confirmation path** (`confirmMeanReversionEntry`) — the StochRSI was already computed and used as a score bonus (+0.5-1.0) but did not affect `confirmed`. Now a K-crosses-D in the right direction (crossUp for longs, crossDown for shorts) acts as an independent confirmation path alongside candle patterns. Enters at 0.65-0.80 size same as pattern-confirmed entries.

**What's still blocked:** entries where neither RSI divergence, candle patterns, nor StochRSI crossover confirms. The 5.5 score fallback (enter at half size with no 15m confirmation) is unchanged.

---

## Zero-Trades Unblock + Claude Recalibration Mode (June 2026)

The bot was opening **zero trades**. Investigation found two real blockers (plus a
non-issue) and one operational change:

1. **`zero-range-bar` hard bail killed all 15m MR confirmation** (`bot/entry-improvements.js` → `check15mReversal`). When the last 15m candle was a doji (`high === low`, common in flat sideways), the function returned early with `["zero-range-bar"]` — before any of the flat-market-friendly checks (RSI divergence, momentum divergence, exhaustion, volume reversal) could run. Since the only escape was `candidate.score >= 5.5` (nothing was hitting it), every MR candidate died at `mr-entry-gate:mr-15m-rejected(conf=0.0, patterns=zero-range-bar)`. **Fix:** replaced the hard `return` with a `skipWickPatterns` flag that suppresses ONLY the wick-ratio patterns (hammer/engulfing/shooting-star, which divide by `lastRange`). RSI/momentum divergence, exhaustion, and volume reversal now still run on a doji last bar.

2. **Claude rejecting on stale system EV/WR** (`coin-memory.js` → `buildValidationSection`). The validation prompt fed Claude system-wide EV (`avg $-6/trade`) and regime/approval WR (~35%) from pre-pivot contaminated history, and the decision framework treated negative EV as a rejection reason — so anything that squeaked through got rejected. **Fix:** a **recalibration mode** keyed on combined system WR. When `combinedWR < RECALIBRATION_WR_FLOOR` (0.42, needs n≥10): the regime line drops its per-trade EV (keeps WR/n), and the prompt swaps in a slimmed framework that tells Claude the system/regime EV+WR figures are stale and **NOT valid rejection criteria** — judge each candidate on **signal-level WR only** (the per-signal `[..%WR..]` data on each candidate line), not coin-specific history. **Auto-reverts** to the full framework once WR recovers to ≥42% — no code change needed.

3. **Adaptive threshold 4.0→4.5 in sideways — NOT actually a blocker** (kept as-is). MR setups already require score ≥4.5 (`entry-improvements.js:312/349`) and non-MR need ≥5.0 (`MEAN_REVERSION_PRIMARY`), so the 4→4.5 bump excludes nothing live. It shows in logs but is a no-op for current config. Don't "fix" it.

**Operational:** the `superduperbot-runner` cron was changed **2 min → 5 min** (it was staling/locking out constantly against the main bot's advisory lock).

**Watch after deploy:** scan logs should show `mr-15m-confirmed(...)` firing on flat tape (via RSI div / exhaustion, not just wicks), and `[CLAUDE BATCH]` approvals ticking up. The recalibration notice only appears in the prompt while system WR < 42%.

### Recalibration v2 — thin per-signal WR is no longer a reject basis (June 2026)

The original recalibration mode (above) insulated Claude from stale *system/regime* EV+WR but then pointed it at **per-signal WR** as the primary criterion — which is the **same poisoned well one level down**. Live (2026-06-21) Claude was rejecting every MR short citing `mr-stoch-overbought[sideways:33%]` / `mr-at-resistance[sideways:33%]`. Those numbers come from `state.signalStats[sig:regime]`, built in `adaptation.js` from `state.trades.slice(-80)` using **raw, un-decayed** win/loss counts (the 10-day decay only feeds `dynamicWeights`, not the WR string Claude sees), and shown at **n as low as 3**.

**The deadlock:** the MR pivot throttled volume to ~1 trade / couple days, so the 80-trade window **doesn't refresh** — it's still full of pre-2026-06-10 contaminated trades. Stale 33%-WR (n=3) → Claude rejects → no new trades open → window never rolls the old trades out → WR frozen at 33% forever. The "windowed stats self-heal in ~30 days" assumption breaks precisely *because* the pivot cut volume.

**Fix A (`coin-memory.js` → `buildValidationSection`, prompt/display-only — no state mutation, main bot only since the runner makes no Claude calls):**
1. **Surface sample size + a `thin` tag.** Per-signal lines now show `[sideways:33% n=3 thin]` instead of bare `[sideways:33%]` (global stats get a `thin` tag too). `RELIABLE_SIGNAL_N = 15`; below it = small-sample/stale noise. Previously Claude couldn't tell a 33% from n=3 (noise) from a 33% from n=30 (real). (Set to 15, not 10: a WR's 95% CI is ±25% at n=15 vs ±31% at n=10 — 10 was too few to auto-reject on; 15 sits just under the adaptive-weights system's own 20-trade sample gate.)
2. **Recalibration framework rewritten:** thin (n<15) signal WR is explicitly **NOT a valid rejection basis**; only n≥15 WR is trustworthy. Approve path is now `(a)` reliable signals ≥48% WR **OR** `(b)` thin/insufficient WR but 3+ aligned signals (confluence) at a meaningful score. AUTO-REJECT only fires when signals with **reliable** data (n≥15) are all <45% — thin signals are ignored for that test. The non-recalibration framework also gained "ignore signals marked thin".

This breaks the deadlock: Claude stops auto-rejecting on stale n=3 poison, takes confluence-backed trades, fresh data accrues, real WR emerges. Auto-reverts with the rest of recalibration once system WR ≥42%. Tests: `tests/recalibration-thin-wr.test.js`. **Watch after deploy:** candidate lines show `n=… thin` tags; in recalibration, MR candidates with thin WR but strong confluence start getting approved instead of the blanket 33%-WR rejection.

### Recalibration v3 — effN signal reliability + bear-regime re-enable (June 2026)

v2 had a hole: it only neutralized signals with raw **n<15**. A poisoned signal with **n≥15** (e.g. `ema-ribbon-bear` at 21% WR, n=24) still drove Claude's auto-reject — even though at near-zero trade volume that n=24 is entirely stale pre-pivot trades the last-80 window hasn't rolled out. This blocked **all bear trades** (every bear short leans on `ema-ribbon-bear`), leaving the bot idle whenever the regime turned bear.

**Root insight:** raw count is the wrong reliability metric at low volume. A signal is only trustworthy when it has real *recent* evidence.

**Changes:**
1. **effN signal reliability** (`adaptation.js` → stores `effN`/`decWinRate` per signal; `coin-memory.js` → `buildValidationSection` gates `thin` on `effN`, not raw count). `effN` = decay-weighted effective sample (10-day half-life, same decay already used for `dynamicWeights`). A signal with raw n=24 but all-stale trades has a tiny `effN` → tagged `thin` → ignored for auto-reject. Candidate lines now show `n=24 eff=3 thin`. This finishes the de-poisoning thread (signal WR was the last raw-un-decayed consumer Claude saw). Fallback to raw count for legacy state with no `effN`.
2. **Trend/breakout threshold 6 → 5** in the Claude framework (both recalibration and normal). Aligns with the code gate `MR_PRIMARY_THRESHOLD = 5.0`, so the whole pipeline gates at 5. Bear shorts scoring 5.5–5.9 (previously rejected on "<6") now qualify.
3. **Bear stays bidirectional** — no shorts-only restriction added; bear already permits longs and shorts (shorts naturally dominate via `REGIME_SIGNAL_MULTIPLIERS`, left as-is).

**Why this isn't just "re-enable the losers":** the bear-signal WRs that flagged them as losers are themselves poisoned (pre-#58–#61 buggy-era trades), so they're not a trustworthy verdict. effN stops trusting *stale* data without blindly trusting anything — fresh bear-era data now decides. **Risk:** no WR safety net on bear shorts until fresh data accrues; treat as a **monitored experiment**, watch the first ~20–30 bear trades and let real WR emerge. Tests: `tests/recalibration-thin-wr.test.js` (stale high-n→thin), `tests/adaptation.test.js`. **Watch after deploy:** bear candidates show `eff=N` tags; `ema-ribbon-bear`-only setups stop blocking on poisoned 21% WR; bear trades (both directions, mostly shorts) start flowing at score ≥5.

### Recalibration v4 — the displayed WR/EV must be the DECAYED number, not raw lifetime (June 2026)

v3 computed `effN`/`decWinRate` per signal but `buildValidationSection` (`coin-memory.js`) only used `effN` for the `thin` *tag* — the **headline WR it showed Claude was still raw lifetime `wins/count`**. So a signal with a non-thin `eff` (genuine recent sample) still displayed its poisoned *lifetime* WR (e.g. `trap-clean-sweep-bear 39%WR n=852 eff=24` → not thin → Claude auto-rejects on the dead engine's 39%). The thin-gate fired on the right metric; the *displayed number* was the wrong one. Three display paths were leaking raw WR into the prompt: per-signal global, per-regime-signal, and `setupPerf` (raw `getSetupStats`). **Fix:** per-signal lines now show `decWinRate` (decayed) when present, falling back to raw only for legacy state; `setupPerf` uses the de-poisoned `getSetupStatsRecent` (wired into the approval deps in `deps.js`, which previously only got the raw `getSetupStats` — sizing had the recent variant, approval didn't). Now the WR Claude judges on matches the thin/reliable flag and self-heals via the 10-day decay. Tests: `tests/recalibration-thin-wr.test.js` (displayed WR = decWinRate, not raw). **NOTE — sweep gate left intact:** the `liquidity-trap` no-confirmed-sweep `score=0` (`runner.js`) is *not* part of this — it is LT-only (doesn't touch bear/trend shorts) and is documented-intentional (see Scoring Symmetry Audit). De-poisoning the WR is what unblocks bear shorts; the sweep gate is a separate, validated protection and was deliberately NOT converted to a penalty.

### Recalibration v5 — the confluence approve-rule made BINDING (July 2026, deadlock #4)

With the infrastructure healthy (post timeout/watchdog fix) and v1–v4 deployed, the bot was *still* at zero trades — and the logs finally showed why cleanly: **31 qualified candidates, 15 fresh Claude reviews, 0 approvals** (2026-07-02→03). Every rejection followed the same template: *"all signals thin → falling back to confluence → only 3 aligned signals — marginal → reject."* But rule (b) of the recalibration framework literally said approve on "3+ aligned signals (strong confluence)" + score met. Claude was treating the approve rules as necessary-but-not-sufficient — anchored by the framework's opening "DEFAULT = REJECT", it read "3" as "bare minimum = marginal" and kept rejecting candidates that met (b) to the letter (CL: exactly 3 aligned MR signals + score ≥4.5 → rejected as "only 3"; PNUT: 5 signals + score met → rejected circling back to thinness, which the prompt explicitly forbids). Same self-sustaining deadlock as v2/v3, one level up: no approvals → no fresh trades → everything stays thin → confluence is the only approve path → rejected as marginal.

**Fix (`coin-memory.js` → `buildValidationSection`, recalibration branch only, prompt-only):** the framework now states the rules are **BINDING** — if (b) is satisfied, APPROVE; "exactly 3 aligned signals IS sufficient confluence — do NOT call 3 'marginal', 'only 3', or 'the bare minimum' and reject"; no rejecting candidates that meet (a)/(b) for thinness, small samples, stale stats, or any criterion not listed. "DEFAULT = REJECT" replaced with the precise "REJECT only when neither (a) nor (b) is met, or AUTO-REJECT fires." Two tightenings so binding-approve stays honest: `time(±x)` hour-nudges are excluded from the aligned-signal count, and every verdict must **name the rule it applied** — (a), (b), no-rule-met, or auto-reject — so log review is unambiguous. Also switched (a)/auto-reject wording from `n≥15` to `eff≥15` for consistency with the thin tag (which gates on effN since v3). Auto-reverts with the rest of recalibration at system WR ≥42%. Tests: `tests/recalibration-thin-wr.test.js` (binding language, time-nudge exclusion, rule-naming). **Watch after deploy:** rejection reasons should start citing the rule applied; candidates with 3+ real aligned signals + score met should APPROVE instead of dying as "marginal"; if approvals overshoot (low-quality 3-signal setups flooding in), the knob is the aligned-signal count in rule (b) — raise 3→4 rather than reintroducing soft language.

### Recalibration v6 — rule (b) enforced in CODE, prompt-lawyering abandoned (July 2026, deadlock #5)

v5's binding language deployed and worked *as written* — verdicts named their rule, time-nudges were excluded — and the bot **still** approved nothing: **65 qualified → 34 fresh Claude reviews → 0 approvals** (07-04→06, regime now bull, trend candidates). The new escape (24/34 rejections, 71%): Claude read rule (b) — "WR data is thin/insufficient but 3+ aligned signals fired" — as requiring the aligned signals to **not be thin**, several verdicts literally restating it as "Rule (b) requires 3+ aligned signals **with eff≥15**". That's the rule's exact opposite, and unsatisfiable: after weeks of no trades every signal is thin by definition (TRIA: 5 aligned signals named, score confirmed ≥5, rejected "because all fired signals are thin"). 6 more invented an RSI/overbought veto that isn't in the framework; ~4 were legitimate. Lesson after five prompt iterations: **an anchored-to-reject LLM will always find another escape — stop patching prose, enforce the rule mechanically.**

**Fix (code, not prompt):**
1. **`applyConfluenceOverride`** (`bot/runner-utils.js`, pure; wired in `runner.js` after `resolveClaudeValidations`) — during recalibration, a Claude **rejection** is overridden to a stage when rule (b) holds mechanically: **3+ non-time signals** (score threshold does the alignment work — contra signals carry no positive weight), **score ≥ setup threshold** (LT 7 / MR 4.5 / else 5), and **zero fired signals with reliable recent data** (effN≥15 globally or in-regime — if reliable data exists, Claude's WR judgment is legitimate and stands; raw-count fallback for legacy stats). Caps: **max 2 overrides/run**, **0.5× size** (`candidate.overrideSizeMult`, applied in `execution.js`). Trades carry `approvalType: "confluence-override"` so `analyze-trades.js` can judge the route once ~20-30 trades accrue. Claude's prose verdict is preserved inside the override reason as a risk note (`Claude said: …`). `fallback-rejected` (Claude never reviewed) is NOT overridden. Log tell: `[CONFLUENCE OVERRIDE] N Claude rejection(s) overridden…`.
2. **`getRecalibrationState`** (`coin-memory.js`, exported) — single source of truth for the recalibration flag, shared by the prompt and the override. **Fixed a latent bug found during extraction:** the old inline code summed `autoStats.wins + claudeStats.wins`, but `getApprovalStats` never returned a `wins` field — so `combinedWR` was permanently 0 and **recalibration mode could never auto-revert**. Now computed correctly (`winRate × count`), and `confluence-override` trades count toward the recovery WR so the trades the override opens can lift the system out of recalibration (WR ≥42% → override + recalibration prompt both self-disable).

**Risk bounds:** the override narrows the Claude gate for thin-data candidates only, bounded by: 0.5× size, 2/run cap, reliable-data escape hatch, and every downstream hard gate still applies (risk gates, min-RR, correlation/cluster caps, MR gates, sweep confirmation, LT batch cap). Claude retains full veto power the moment any fired signal has eff≥15. Tests: `tests/confluence-override.test.js` (override conditions, caps, thresholds, reliability escapes, recalibration-state math incl. the wins-bug regression). **Watch after deploy:** `[CONFLUENCE OVERRIDE]` lines and `confluence-override` OPENs at half size; if the route's WR is poor after ~20-30 trades, tighten via the aligned-count (3→4) or drop `maxOverrides` to 1 — in `applyConfluenceOverride`'s defaults.

### Poisoned-stats audit + sizing de-contamination (June 2026)

A full audit of every learned-stat store (prompted by "is anything else poisoned?") found the most *material silent* drag wasn't in the Claude prompt at all — it was **position sizing**. Two sizing consumers read `getSetupStats(state.trades, setupType)`, which filters the **whole last-500-trade window with NO recency/decay** (`stats.js`), so pre-2026-06-10 contaminated trades count at full weight:
1. **`computeKellySizing`** (`execution.js`) — drove MR to `kelly:-0.130 mult:0.50` (half size).
2. **`getAdaptiveSetupDecision`** (`stats.js`) — drove the `Setup decision … sizeMult=0.85 ev=-6.52` cut, *and at `count≥30` with negative EV returns `allow:false` — a hard block*. MR's window count (~24) was just under 30; once it crossed, **all MR entries would have been blocked** on stale EV. A latent landmine, not just a size cut. (Both stack: 0.50 × 0.85 ≈ MR sized to ~42%.)

**Fix (`stats.js` `getSetupStatsRecent` + `MIN_EFF_RECENT_SETUP = 6`; permanent, not a recalibration toggle):** a decay-weighted (`10-day half-life`, mirroring `adaptation.js`) setup-stats variant returning `count` (raw, for min-sample gates) + `effN` (decayed effective sample) + decayed WR/EV. Both sizing consumers now use it; when `effN < 6` (recent evidence too thin) they **stay neutral (`sizeMult/mult 1.0`, `allow:true`)** instead of acting on stale data — so stale EV can neither shrink size nor block. Self-heals continuously via decay; no future revert. Tests: `tests/setup-stats-recency.test.js`. **Note:** `getSetupAdjustedThreshold` and `regimeStats` (cumulative, n>1000 so contamination is diluted) and `dynamicWeights` (windowed-80 + decay + 0.6–1.4 cap) were judged low-impact and left as-is.

**Also (Fix 2, recalibration-gated, auto-reverts):** the **setup-performance EV line** shown to Claude (`buildValidationSection`) was the one poisoned input recalibration *didn't* suppress — it now drops EV (keeps WR/n) while recalibrating, and the preamble's "stale, not a reject basis" clause now explicitly names **setup-level** alongside system/regime. Reverts to full EV at WR ≥42%.

---

## Seeding Playbook (resetting contaminated learned stats)

The bot's learned state is part windowed/decayed (self-heals) and part **cumulative**
(needs explicit reset). When a bad stretch of trades — e.g. the duplicate-instance +
broken-Claude period — drags the bot, reseed the cumulative stats from a clean backtest.

**What needs resetting vs what self-heals:**
- `regimeStats` — CUMULATIVE, never forgets → reseed (though n is large, so a bad month is a small fraction)
- Setup/approval stats (`stats.js`) — scan last 500 `state.trades` → only clears if you prune the `trades` table
- `dynamicWeights` / `signalStats` — WINDOWED last-80 + 10-day decay → self-heals in ~30 days
- `coinHistory` — last-20 per coin → self-heals
- Drift warning / live health — last-100, display-only → self-heals

**Backtest commands (`backtest.js`):**
- `node backtest.js --no-db` — dry run, prints metrics (setup/regime/cap/**approval-route**/signals), writes nothing. **Always do this first.**
- `node backtest.js --seed-safe` — overwrites `regimeStats` + `signalStats` only, leaves `dynamicWeights`. **Preferred.**
- `node backtest.js --seed` — also overwrites `dynamicWeights` (risk: imports backtest-fitted weights). Avoid unless intentional.
- `--months N` sets the window; `--seed`/`--seed-safe` default to 12m.
- The backtest's `simulatePosition` is its OWN copy of exit logic — keep it in sync with `bot/exits.js` (e.g. the 5.5×ATR TP3 target). Weights/scoring/correlation flow in via imports automatically.

**Recommended sequence:**
1. Merge all strategy fixes to `main` (the seed must reflect deployed code).
2. `node backtest.js --no-db` → judge realism. Healthy = WR/PF near live baseline (≈43.6% / 1.52), EV modestly higher. **Reject if it looks too good** (WR 60%+/PF 3 = overfit).
3. Seeding writes to **production Postgres**, so run it where `DATABASE_URL` is set. The `apply-seed-job` one-off was **deleted** — recreate a Railway one-off (config-as-code → a dedicated `railway-*.json` running `node backtest.js --seed-safe`, `DATABASE_URL` referenced from `${{Postgres.DATABASE_URL}}`). Do NOT run it from a dev sandbox (no `DATABASE_URL`).
4. Confirm job logs: `✓ regimeStats: N seeded`, `✓ signalStats: N seeded`, `safe-seed mode: leaving dynamicWeights unchanged`.

**Seeding caveat (learned this session):** `--seed-safe` only meaningfully sticks for `regimeStats` (cumulative). `signalStats`/`dynamicWeights` are **recomputed from `state.trades.slice(-80)` every run** (`adaptation.js` → `updateDynamicWeights`), so a seed of those is overwritten on the next cycle. To actually change windowed stats you must change the underlying `trades` table (e.g. `prune-trades.js`), not seed. A full `--seed` is near-useless for fixing live performance for the same reason.

**June 2026 dry run (15 coins, 3251 trades, 12m):** WR 44.7%, PF 1.52, EV $6.22, DD 9.43% — believable, matched baseline. Approval route: auto WR 45.9%/EV $7.27 vs claude-routed WR 41.4%/EV $3.40 (confirms Claude-gate candidates are genuinely weaker — running with Claude broken hurt).

---

## Edge-Recovery Gates (June 2026 — backtest-vs-live reckoning)

**The reckoning:** the 12m backtest projected **+$6.22 EV/trade** (~+€20k). The first
clean post-fix live sample (50 trades, system healthy since 2026-06-10, after the
duplicate-instance + broken-Claude fixes) delivered **−$6.81 EV/trade**. A ~$13/trade
in-sample→out-of-sample collapse = textbook **overfitting**. The tell: live, the score
no longer separates winners from losers (**winners avg 5.33, losers 5.27**). The weights
were fit to the backtest window and memorized it; they don't generalize.

**Why the backtest overstates (don't trust its profit number as a forward expectation):**
1. Weights (`dynamicWeights`/`signalStats`) are fit on the same history the backtest replays — in-sample score separation is circular.
2. `backtest.js` `simulatePosition` is an optimistic, separate exit sim — no slippage, funding, partial-candle gaps, or missed fills.
3. 12m averaging blends favorable trending months (April carried it — strip the one +$2,092 day and the other 59 days are −$1,400) with the current chop. A long-biased trend system bleeds in non-trending/bear regimes.

**The post-fix breakdown (where edge actually lives — use `analyze-trades.js`):**
- Profitable pockets only: **mean-reversion** (+$99, n=5), **sideways regime** (PF 4.32, +$75, n=5), **Claude-gated** (PF 1.70, +$42, n=7).
- Bleeders: **blind auto-approval** (−$383, 43 trades, 33% WR), **momentum** (−$294, 22% WR — worst setup), **trend/momentum shorts** (−$184, 25% WR). Almost everything dies by stop-loss.

**Three gates added to shrink the bot to its demonstrated live edge (`bot/config.js`):**
1. **`REQUIRE_CLAUDE_APPROVAL = true`** — no blind auto-approval; every survivor routes through Claude (or a cached Claude verdict). Wired via `autoApproveFn` in `runner.js` (`REQUIRE_CLAUDE_APPROVAL ? () => false : autoApproveSignal`), so `autoApproveSignal`/`routeToApprovalLists` stay pure. **Side effect:** the fast-scan runner now only opens `claude-cached` entries (it makes no Claude calls), and when Claude budget hits ≥90% the bot stops opening new entries (fail-safe — `applyClaudeSpendGuardrail` dumps to autoList which `autoApproveFn` then rejects).
2. **`DISABLE_MOMENTUM_SETUPS = true`** — blocks `setupType === "momentum"` at qualification (`runner.js` phaseScan, reason `momentum-disabled`). Note: momentum in bull regime is remapped to `bull-continuation` upstream (`scoring.js:826`) and is NOT blocked — only raw non-bull momentum.
3. **`SHORTS_BEAR_ONLY = true`** — blocks shorts when `regime !== "bear"` AND `setupType !== "mean-reversion"` (reason `shorts-bear-only`). **MR shorts are deliberately exempt** — they're contrarian fades that only fire in sideways and were net-profitable.
4. **`MEAN_REVERSION_PRIMARY = true`** (the MR pivot) — non-MR setups must clear `MR_PRIMARY_THRESHOLD` (5.0) to even be considered; below that they're rejected `mr-primary-mode`. MR setups always pass this gate. Net effect: the bot trades mean-reversion freely and lets decent-quality (score ≥ 5.0) trend/breakout setups reach Claude. Originally the bar was `claudeThreshold` (6) — lowered to 5.0 (June 2026) to avoid over-filtering now that regime multipliers, kill-list, and new indicators improve upstream score quality.

**Per-signal out-of-sample lift (the evidence behind the MR pivot — `analyze-trades.js` "By Signal"):**
Every mean-reversion/fade signal showed positive lift, every trend/momentum signal negative — a clean split:
- **KEEP (positive lift):** `mr-stoch-overbought` (+$21.76), `mr-at-resistance` (+$21.76), `stochrsi-cross-down` (+$20.62, n=13), `above-VWAP` (+$18.02), `15m-shooting-star` (+$14.79).
- **PRUNE (negative lift):** `4h-macd-cross-up` (−$20.07, n=18 — worst high-sample), `4h-obv-div-bull` (−$17.70, n=13), `mild-trend`/momentum (−$10.77, n=23), `4h-bb-expansion-*`, `ema-ribbon-bear`/`h4-bear` stack, `bear-adx-confirmed`, `h4-bull`/`ribbon-h4-align-bull`.
- Caveats: trust the big samples (n≥13), ignore n=4-5 rows; co-firing signals (identical n/lift) can't be separated; `time(±x)` rows are hour nudges, not signals. Sample was ~51 trades — directional at the family level, confirmed by setup/regime/direction breakdowns and theory.
- **`lift` = EV(trades with signal) − EV(trades without)**; computed from live post-fix trades, so genuinely out-of-sample. The score itself had no separating power live (winners 5.33 vs losers 5.27), which is *why* signal-level (not score-level) pruning was the right lever.

**Diagnostic tools (run via a Railway one-off with a dedicated config file so `railway.json`'s `npm start` doesn't override the start command):**
- `prune-trades.js` + `railway-prune.json` — per-day WR/PF/EV breakdown; scoped transactional delete (dry-run by default; `PRUNE_FROM`/`PRUNE_TO`/`PRUNE_APPLY` env vars). **Note:** pruning was investigated and rejected — the cleanest post-fix data is still net-negative, so contamination was not the cause.
- `analyze-trades.js` + `railway-analyze.json` — post-fix breakdown by setup/regime/approval/direction/exit-reason/score (`ANALYZE_FROM`/`ANALYZE_TO`).

**Root-cause read (overfitting):** the design *is* overfit — too many indicators + adaptive weights (`dynamicWeights`/`signalStats`) that continuously re-fit the last-80 trades, so the model perpetually chases recent noise. The backtest fits and tests on the same data (weights flow in via imports; `simulatePosition` is an optimistic separate exit sim), which is why it projected +$6.22 EV/trade while live delivered −$6.81. **The MR pivot above is the first response.** Still pending: (1) **walk-forward validation** — judge any future change out-of-sample, never on the in-sample backtest; (2) larger-sample re-run of the signal-lift analysis once ~100-150 clean MR-era trades accumulate; (3) possible regime-conditional re-enabling of trend signals if the early $10k→$12k run turns out to be trend-in-a-trending-market (trace with `analyze-trades.js --from all`). Treat the backtest profit figure as unreliable going forward.

---

## Robustness / anti-overfit pass (June 2026)

After the de-poisoning work, structural improvements that add edge *without* adding fitted parameters (the bot's core disease is too many history-fitted knobs chasing the last-80-trade noise).

**1. Walk-forward / holdout validation (`backtest.js` → `walkForwardReport`/`foldMetrics`).** `node backtest.js --no-db --walk-forward [--folds N]` splits trades into N time-ordered folds and reports per-fold metrics + an explicit in-sample (folds 1..N-1) vs out-of-sample (final fold) comparison with an **IS→OOS EV-gap overfit flag**. The strategy params are static (hand-tuned on history) and `scoreFromCandles` runs with empty `dynamicWeights`/`signalStats`, so the overfitting lives in the static config — a large IS→OOS gap is the tell. **Rule going forward: judge every change on the OOS fold, never the blended/in-sample number.** Purely additive (reads `allTrades` by `entryTs`). Tests: `tests/walk-forward.test.js`. **Note:** the backtest is *ungated* (uses `scoreFromCandles` + score≥8 auto-approve, not the live Claude/MR-pivot/bear gates) and runs exits on 1h, so absolute EV isn't a live forecast — trust the *relative* A/B and the IS→OOS gap, not the headline number. It also uses its OWN sizing (`backtestSymbol`), so `execution.js` sizing changes aren't exercised by it.

**2. Volatility-targeted sizing (`execution.js`).** The base was *already* vol-targeted — `size = riskAmount / slDist` where `riskAmount = equity × risk%` and `slDist` is the ATR-based stop distance (constant dollar risk per trade; tight-vol coins sized up, wild coins down). What corrupted it was the multiplier stack: `getSetupRiskMultiplier` and `getApprovalRiskMultiplier` both read the **full 500-trade window with NO decay** (poisoned). **Removed both.** Conviction now comes only from de-poisoned recency-weighted dials (effN-gated Kelly + setup decision) + structural cuts (drawdown, MR confirmation quality). Removing fitted distortions from a correct structural base = robust, zero new overfit surface.

> **A trailing-exit experiment (15m chandelier + S/R) was tried and REVERTED — it is NOT in the code.** The walk-forward A/B rejected it out-of-sample (it clipped the TP2/TP3 fat tail), so it was removed entirely; the existing post-TP2 graduated trail is what runs. Full write-up in "Known Issues & History → Reverted" below. (Mentioned here only so nobody rebuilds it.)

---

## Known Issues & History

### Reverted (tried, validated as harmful, removed — do NOT rebuild)
- **Structure-aware chandelier trailing exit (June 2026).** A 15m chandelier + swing-S/R trail (engage at +1 ATR; trail to `peak − 2.5×ATR` or just beyond nearest swing S/R) to lock profit earlier and cut losers on structure breaks. The walk-forward A/B (trail OFF vs ON, 6mo, 5 folds) **rejected it** out-of-sample: OFF beat ON on every metric and all 5 folds — OOS EV **$8.64 vs $4.36**, PF **1.80 vs 1.47**, WR 50.9% vs 47.9%. It clips the TP2/TP3 fat tail and churns into more low-quality re-entries (1661→1918 trades); live would be worse (live trails on 15m, even more active). **Removed entirely** from `exits.js`/`runner.js`/`backtest.js`/`config.js` (PR #64); the existing post-TP2 graduated trail is what runs. The harness working as designed. If revisited, start a fresh hypothesis and judge it OOS — don't tune this one to rescue it.

### Fixed
- **Runner wedged forever mid-run — no timeout on ANY external call (July 2026).** At 2026-07-02 06:05 UTC the fast-scan runner printed `=== BOT RUN ===` and then produced no output for 8+ hours; every subsequent 5-min cron tick logged only `Starting Container` (Railway emailed a crash alert). Root cause: **no HTTP call anywhere in the codebase had a timeout/AbortSignal** — a single stalled request (most likely one of the dozens of OKX `fetch`es per run) never settled its `await`, so the process never logged, never exited, and Railway's `ON_FAILURE` restart never fired (the process didn't fail — it just sat there). The `try/catch` wrappers don't help: a hang never throws. The main server had the same latent bug worse: `scheduler.running` stays `true` forever after one hung run, every tick skips with "previous bot run still active," and `/health` keeps passing so Railway never restarts it. **Fix (three layers):** (1) `AbortSignal.timeout()` on every external fetch — OKX/market-data (15s), CryptoPanic + LunarCrush (15s), Telegram (15s), Anthropic (120s, lands in the existing fail-safe reject-all path), okxGet/okxPost (15s); (2) Postgres `Pool` timeouts in `db.js` (`connectionTimeoutMillis` 15s, `statement_timeout` 60s, `keepAlive`) — `pool.connect()` was also infinite; (3) hard watchdogs: `task-runner.js` force-exits code 2 after 10 min (`TASK_WATCHDOG_MINUTES`), `server.js` exits after a 12-min run (`RUN_WATCHDOG_MINUTES`) with a Telegram alert so Railway's ON_FAILURE restart releases the pool connections and advisory lock. `bot/market-data.js`, `bot/claude.js`, `bot/telegram.js`, `bot/exchange.js`, `db.js`, `task-runner.js`, `server.js`.
- **Decay fallback immortalized poisoned stats → bot frozen risk-off for days (the BIG one)** — every de-poison this session (signal-WR effN, Kelly, setup decision) relies on a 10-day time-decay (`tradeDecayWeight` in `adaptation.js`, `setupDecayWeight` in `stats.js`) that down-weights old trades by `closedAt`. But both had `if (!Number.isFinite(closedMs)) return 1; // undated legacy trades: full weight` — and the **old contaminated trades carry no `closedAt` in their stored `raw`**, so they hit that fallback and got **full weight forever**. Since the bot had opened ~0 trades for weeks, the whole windowed sample *was* those undated trades → **`eff == raw n` for every signal** (the smoking gun: `ema-ribbon-bear 21%WR n=24 eff=24`, `mild-trend 22% n=32 eff=32`…). So "thin" never fired, Claude trusted the stale 21% bear-WRs and **AUTO-REJECTED every bear short** (106 rejections / 0 trades over ~4 days), and the deadlock was self-sustaining (can't refresh stats without trading, can't trade until stats refresh). **Fix:** fall back to `openedAt`, and treat a truly undated trade as **stale (weight 0.05 ≈ 43 days old), NOT fresh** — undated = legacy = old = should fade. Now the poison decays → signals go `thin` → Claude judges bear shorts on confluence → trades flow → stats self-heal. `bot/adaptation.js`, `bot/stats.js`. Tests: `tests/setup-stats-recency.test.js`. **CRITICAL FOLLOW-ON (the reason deploying the decay fix alone didn't unfreeze the bot):** `signalStats` (the per-signal `effN`/`decWinRate` Claude reads) is **stored in the Postgres blob and was recomputed ONLY inside `closePosition`/`executePartialClose`** (`updateDynamicWeights` was called nowhere else). So in a no-trade deadlock *nothing closed* → `signalStats.effN` never recomputed → it stayed frozen at the stale pre-fix value (`eff==n`) even after the decay fix deployed, so Claude kept auto-rejecting and the freeze persisted (constant `eff=24` across days = the tell — a live recompute would drift down with wall-time). **Fix:** call `updateDynamicWeights(state)` once **per run** at the end of `checkAllExits` (`bot/runner.js`) so `effN`/`decWinRate` (and `dynamicWeights`) refresh every cycle with current time — the decay progresses even while idle, stale signals fade to `thin`, and the freeze self-breaks. Verified: `signalStats` was the *only* approval-gating stat that was stored-and-only-refreshed-on-close; `getApprovalStats`/`getSetupStatsRecent`/Kelly/setup-decision all recompute live from `state.trades` each prompt/entry. Test: `tests/adaptation.test.js` (undated trades → `effN`<15 through `updateDynamicWeights`). **NOTE:** the `[DRIFT WARNING]` line (PF/WR/Expectancy/Drawdown) is **display-only** — it does NOT gate entries; the only drawdown gates are the 15% hard cap and the 4% mid-run/daily halts (which only fire on actual recent SL losses). The freeze was this decay bug, not drawdown.
- **Daily Telegram summary spam** — `maybeSendDailySummary` used an in-memory date variable that reset on every Railway restart, sending a new summary each time. Fixed by removing the daily summary entirely (user only wants weekly report). `server.js`.
- **Stop-loss same-run re-entry churn** — After a stop-loss, the symbol was immediately re-eligible for entry in the same 15-min cycle. Fixed by building `slThisRun` set from `_pendingTrades` and excluding those symbols from `tradeable` filter. `bot/runner.js`.
- **Claude error detection swallowing real errors** — `invalid_request_error` was being caught as a budget-limit signal, causing silent fallback to auto-mode for ANY 400 error (wrong model, bad request format, etc.). Now only actual spend-limit messages trigger `CLAUDE_LIMIT_FALLBACK`. `bot/claude.js`.
- **Duplicate bot instances** — `superduperbot-runner` was running `npm start` (full server) instead of `npm run task:fast-scan`, causing two complete bot instances scanning and trading simultaneously. **Root cause:** the shared root `railway.json` hardcodes `startCommand: "npm start"`, which overrode the runner's dashboard setting. **Final fix:** dedicated `railway-runner.json` + point the runner's Railway config-file path at it (see Railway Services Architecture above). Earlier dashboard-only changes kept getting overridden by `railway.json`.
- **Symbol rotation dead — always scanning same top-60** — After the 3-phase rotation was removed, `phaseScan` was always called with `(startFrac=0, endFrac=1.0)`, making `effectiveStart=0` every run. In sideways regime where all top-60 symbols are in BB compression, this produced zero candidates indefinitely. Fixed by tracking `state.scanBatchOffset` in Postgres and advancing it by `maxSymbolsPerRun` each call. Both services share the offset and interleave coverage. `bot/runner.js`.
- **Race condition between services** — Main bot and fast-scan runner shared Postgres state with no coordination. Fixed by adding `withBotLock` (Postgres advisory lock) in `db.js`, wrapping every `runBot` call. `db.js`, `bot/deps.js`.
- **Tranche fills not notified** — T2/T3 scale-ins were only console-logged, never sent to Telegram. Fixed by threading `notifyTrade` into `checkTranches` and adding a `TRANCHE` message type. `bot/execution.js`, `bot/telegram.js`, `bot/runner.js`.
- **Claude approval outage (assistant-message prefill)** — `callClaudeBudgeted` ended requests with an assistant prefill to force JSON; the current model rejects prefill, so every approval call 400'd and the bot ran on auto-approval only. Fixed by removing the prefill, steering JSON via the system prompt, and parsing with `extractJsonObject`. `bot/claude.js`. (See Claude API Configuration above.)
- **MR candidates reached Claude with indicators blanked → "missing data" rejections** — `scoreSidewaysMeanReversion` (`bot/entry-improvements.js`) *receives* `rsiVal`/`fisherVal`/`adxResult`/`obvDiv` but **omitted them from its return object** (the main `scoreFromData` path includes them — this gap was MR-specific). So every MR candidate hit `buildValidationSection` showing `RSI: ? | Fisher: ? | ADX: ?`, and Claude rejected citing *"critical technical indicators are missing (RSI, Fisher, ADX all undefined)"* — even on an 8.1-score candidate where `mr-rsi-extreme-low` had obviously fired. **This became the dominant approval bottleneck once recalibration v2 stopped the WR-based rejections** — live (06-22→24) it was **39 of 83 rejections (47%)**. Fixed by adding `rsiVal, fisherVal, adxResult, obvDiv` to both MR return objects (the indicators are already function params). Test: `tests/entry-improvements.test.js` ("carries indicator fields for the Claude prompt"). **Watch after deploy:** MR rejections citing "indicators missing/undefined" should disappear; Claude judges MR setups on real RSI/Fisher/ADX values.
- **Claude batch fail-open on truncated JSON** — `claudeBatchAnalysis` (`coin-memory.js`) capped the approval call at **1200 `max_tokens`**. The batch response carries news + one validation (with a prose reason) per candidate + per-symbol journals, which **truncated mid-JSON** on busy runs (`[CLAUDE BATCH] JSON parse failed: unparseable {...`). The parse failure fell through to `fallbackResult`, which **auto-approves any score≥5 candidate** — silently bypassing the Claude gate despite `REQUIRE_CLAUDE_APPROVAL` (observed live: STABLE score 7.55 opened via `Claude approved: auto-fallback`). **Fix (two parts):** (1) raised batch `max_tokens` 1200 → **4000** so the response isn't truncated; (2) on parse failure **or** any API/budget error mid-run, **reject all candidates** (`rejectAllResult`, reasons `claude-parse-failed` / `claude-error`) instead of auto-approving — an unparseable response is not a verdict and must not open positions. The no-API-key degraded mode (`fallbackResult`, auto-approve ≥5) is unchanged. `coin-memory.js`. **Caveat:** the pace-throttle in `callClaudeBudgeted` still caps `maxTokens` to 300 when spend >1.2× pace — harmless now (spend ~$4/$40) but would force batch rejection (fail-safe, no entries) if overpacing ever triggers.

### Active / Ongoing
- **Edge collapse is real, not contamination (RESOLVED diagnosis → MR pivot).** The drift warning turned out to be genuine overfitting, not just the duplicate-instance period. The first clean post-fix sample (50 trades, healthy since 2026-06-10) was **WR 34% / PF 0.59 / −$340**, with the score showing no separating power (winners 5.33 vs losers 5.27). Pruning old contaminated trades was investigated and **rejected** — the cleanest data is still net-negative. Response: the four Edge-Recovery gates + MR pivot (see "Edge-Recovery Gates" above). **Watch:** trade frequency drops hard (MR is rare); re-run `analyze-trades.js` after ~100-150 clean MR-era trades to confirm the MR edge holds and re-do the signal-lift kill-list on firmer ground.
- **Monitoring after MR-pivot deploy** — confirm scan logs show `mr-primary-mode` rejections (non-MR setups held back), `momentum-disabled`, `shorts-bear-only`, and that surviving entries are MR or Claude-approved. Note: with `REQUIRE_CLAUDE_APPROVAL`, the **fast-scan runner only opens `claude-cached` entries** and the bot stops opening new entries when Claude budget ≥90% (fail-safe).
- **Monitoring after PR #58 deploy (merged 2026-06-20)** — two fixes to confirm in logs:
  1. **Claude batch fail-open fix** (`coin-memory.js`): `[CLAUDE BATCH] JSON parse failed` should disappear, and there should be **no more `Claude approved: auto-fallback`** on parseable runs. If parse failures *do* recur, candidates now reject with `claude-parse-failed` / `claude-error` (fail-safe, no silent auto-approval) — investigate the batch size / response length rather than letting it ride.
  2. **MR stop-distance gate** (`scoring.js`, `MR_MIN_STOP_DISTANCE_PCT = 0.008`): `mr-stop-too-tight` rejections should appear for ultra-compressed-ATR coins (the RLS failure mode) while normally-volatile MR setups (ATOM-class) still pass. **Risk:** if MR frequency drops too hard (back toward zero-trades), the 0.8% floor is the single knob to lower in `config.js`. Re-check after ~20-30 MR-era runs; the loss that motivated it (RLS) was a low-*priced* coin, NOT illiquid ($272M/24h) — the gate is liquidity-agnostic by design.
- **SLX-USDT-SWAP / IRYS-USDT-SWAP partial candles** — These symbols consistently return fewer candles than requested (SLX: 56/200 on 4H, IRYS: 85/200 on 4H). New listings with limited history. Bot skips them correctly but they appear as noise in logs.
- **`superduperbot-premarket` service** — Still running on schedule but does nothing (disabled in code). Wastes a Railway service slot — consider deleting it.

### Recently Fixed (June 2026 session)
- **Mid-run drawdown halt froze the bot** — the −1.5% net-PnL threshold halted all entries after one or two stop-losses (~$165 on $11k), firing 78+ consecutive runs. Raised to −4.0% and aligned the daily gross-loss gate (`risk-gates.js`) from 3% → 4%. Added a **high-conviction override** (`HIGH_CONVICTION_OVERRIDE = 6`): on a halt day, score ≥ 6 setups still get through. Both halts reset at 00:00 UTC. `runner-utils.js`, `runner.js`, `risk-gates.js`.
- **Claude API errors / prefill outage** — resolved (see Claude API Configuration). Post-fix Claude spend ticks up and `[CLAUDE BATCH]` succeeds.
- **Rotation wrap-around double-scan** — when the symbol universe was smaller than one scan window the wrap-around double-scored symbols (test-only impact at ~245 live symbols). Fixed to scan the whole universe once when `total <= maxSymbolsPerRun`. `runner.js`.
- **Signal overfitting pass (June 2026 — PR #54)** — four improvements to reduce in-sample bias and per-regime quality:
  1. **Kill-list zeroed** (`bot/config.js` → `SIGNAL_WEIGHTS`) — 6 signals with confirmed negative live lift set to 0.0: `macd-cross-up` / `macd-cross-down` (lift −$62.58, dominant bleeder), `OBV-bull-div` / `OBV-bear-div` (negative lift n=22/36), `stochrsi-oversold` (0% WR), `ribbon-expansion-bear` (0% WR). Zeroing is permanent (not adapted away) because `adaptation.js` only modifies positive-weight signals.
  2. **Regime-conditional signal multipliers** (`bot/config.js` → `REGIME_SIGNAL_MULTIPLIERS`) — applied multiplicatively on top of dynamic weights in `getSignalMultiplier()`. Bull boosts trend signals and dampens bear signals; bear regime the reverse; sideways boosts MR/oscillator signals and dampens trend. Derived from out-of-sample lift analysis.
  3. **Dynamic weight drift cap** (`bot/scoring.js` → `getSignalMultiplier`) — combined multiplier (dynamic × regime) capped at 0.6–1.4× base weight. Prevents `adaptation.js` from amplifying any signal beyond 40% above or below its calibrated baseline, limiting adaptive overfitting.
  4. **Four new indicators** (`bot/indicators.js`) integrated into `scoring.js`:
     - `atrPercentile` — where current ATR sits in its 120-period distribution; gates trend entries when market is compressed (<20th pct): `atr-compressed` reduces score ×0.75.
     - `weeklyPivots` — classic floor-trader P/R1/S1/R2/S2 from prior week; adds `near-weekly-S1`/`near-weekly-R1`/`weekly-PP-support`/`weekly-PP-resistance` signals.
     - `volumeDelta` — net buy-vs-sell pressure; adds `vol-delta-bull`/`vol-delta-bear` when strong directional pressure aligns with regime.
     - `anchoredVWAP` — VWAP anchored to range extremes (lowest low = bullAVWAP, highest high = bearAVWAP); adds `anchored-vwap-support`/`anchored-vwap-resistance` signals.
  5. **15m bull trend gate** (`bot/scoring.js` → `confirm15mBullTrend`, `bot/runner-utils.js` → `applyBullTrend15m`, `bot/runner.js` → phaseScan) — mirrors the existing `confirm15mBearShort` gate for bear shorts. For bull-regime non-MR longs, fetches 15m candles and checks EMA21 hold, bull engulfing, green cascade, volume expansion. Unconfirmed entries score ×0.85; confirmed entries get size boost to 0.80–1.0 and score bonus `+confidence × 0.25`.
  6. **Per-regime signal lift in `analyze-trades.js`** — after the overall lift table, breaks down lift for each regime independently. Signals marked ⚠ in ALL regimes are true kill candidates; signals bad only in some regimes are handled by `REGIME_SIGNAL_MULTIPLIERS` instead.

---

## Environment Variables (Railway)

Set on the **Superduperbot** service; shared to cron services via Railway variable references:
- `DATABASE_URL` — Postgres connection string
- `ANTHROPIC_API_KEY` — Claude API key (Anthropic console: `sk-ant-api03-pAM...2wAA`)
- `TELEGRAM_BOT_TOKEN` — Telegram bot token
- `TELEGRAM_CHAT_ID` — Telegram chat ID
- `BOT_INTERVAL_MINUTES` — Main bot scan interval (default: 15)
- `DISABLE_BOT_SCHEDULER` — Set `true` to pause the main bot without undeploying
- `PAPER_CASH` — Starting paper balance (default: $10,000)

---

## Useful Endpoints

- `GET /health` — DB connectivity + scheduler status
- `GET /pnl` — Full portfolio snapshot (plain text)
- `GET /run` — Trigger a manual bot run (auth required)
