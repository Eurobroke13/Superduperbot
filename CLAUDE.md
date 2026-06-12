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
| **apply-seed-job** | One-off | Manual | `node backtest.js --seed-safe` | Seeds regime/signal stats from backtest data |

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
  config.js            — All constants: CLAUDE_MODEL, MONTHLY_BUDGET_USD, thresholds, signal weights
  exits.js             — closePosition, partial closes, cooldown registration
  cooldown.js          — Post-TP cooldown (4h); overbought-SL cooldown (6h); same-run SL block
  scoring.js           — scoreSymbol, signal detection, autoApproveSignal
  reports.js           — sendDailyReport (unused), sendWeeklyReview, premarketScan, sendTradeAnalysis
  adaptation.js        — Dynamic signal weight updates (time-decayed), regime stats tracking
  execution.js         — Position sizing, tranche scale-ins (checkTranches), DCA (checkDCA)
  telegram.js          — sendTelegram, notifyTrade (OPEN/CLOSE/PARTIAL/TRANCHE/DCA)
  risk-gates.js        — Daily loss limit, min R:R gate, mid-run drawdown halt
  runner-utils.js      — Pure helpers: buildRegimeConsensus, checkMidRunDrawdown, applySyncFilters, etc.
db.js                  — Postgres pool, withTransaction, withBotLock (advisory lock)
state-store.js         — loadState / saveState; atomic trade + blob writes
trade-store.js         — Separate trades table (loadRecentTrades, insertTrade)
railway.json           — Shared Railway config (npm start) — used by main server
railway-runner.json    — Runner-only Railway config (npm run task:fast-scan)
```

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
3. **Minimum score raised 3.5 → 5.0** (`bot/entry-improvements.js` lines 312/349, both long and short branches). A single trigger like `mr-at-support` scores 2.0 — nowhere near 5.0. Real setups need 3+ confirming signals.
4. **Position size capped at 0.70** — already set by `entry-improvements.js` (`positionSizeMultiplier: 0.70`). The execution.js fallback (used when the MR gate path isn't taken) was 0.85 — lowered to 0.70 to match (`bot/execution.js` line 145).

**Expected effect:** MR entry frequency drops significantly (only genuine multi-confirmation setups pass). Quality over quantity — fewer but higher-conviction entries.

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
3. Seeding writes to **production Postgres**, so run it where `DATABASE_URL` is set — the **`apply-seed-job`** Railway one-off service runs `node backtest.js --seed-safe`. Do NOT run it from a dev sandbox (no `DATABASE_URL`).
4. Confirm job logs: `✓ regimeStats: N seeded`, `✓ signalStats: N seeded`, `safe-seed mode: leaving dynamicWeights unchanged`.

**June 2026 dry run (15 coins, 3251 trades, 12m):** WR 44.7%, PF 1.52, EV $6.22, DD 9.43% — believable, matched baseline. Approval route: auto WR 45.9%/EV $7.27 vs claude-routed WR 41.4%/EV $3.40 (confirms Claude-gate candidates are genuinely weaker — running with Claude broken hurt).

---

## Known Issues & History

### Fixed
- **Daily Telegram summary spam** — `maybeSendDailySummary` used an in-memory date variable that reset on every Railway restart, sending a new summary each time. Fixed by removing the daily summary entirely (user only wants weekly report). `server.js`.
- **Stop-loss same-run re-entry churn** — After a stop-loss, the symbol was immediately re-eligible for entry in the same 15-min cycle. Fixed by building `slThisRun` set from `_pendingTrades` and excluding those symbols from `tradeable` filter. `bot/runner.js`.
- **Claude error detection swallowing real errors** — `invalid_request_error` was being caught as a budget-limit signal, causing silent fallback to auto-mode for ANY 400 error (wrong model, bad request format, etc.). Now only actual spend-limit messages trigger `CLAUDE_LIMIT_FALLBACK`. `bot/claude.js`.
- **Duplicate bot instances** — `superduperbot-runner` was running `npm start` (full server) instead of `npm run task:fast-scan`, causing two complete bot instances scanning and trading simultaneously. **Root cause:** the shared root `railway.json` hardcodes `startCommand: "npm start"`, which overrode the runner's dashboard setting. **Final fix:** dedicated `railway-runner.json` + point the runner's Railway config-file path at it (see Railway Services Architecture above). Earlier dashboard-only changes kept getting overridden by `railway.json`.
- **Symbol rotation dead — always scanning same top-60** — After the 3-phase rotation was removed, `phaseScan` was always called with `(startFrac=0, endFrac=1.0)`, making `effectiveStart=0` every run. In sideways regime where all top-60 symbols are in BB compression, this produced zero candidates indefinitely. Fixed by tracking `state.scanBatchOffset` in Postgres and advancing it by `maxSymbolsPerRun` each call. Both services share the offset and interleave coverage. `bot/runner.js`.
- **Race condition between services** — Main bot and fast-scan runner shared Postgres state with no coordination. Fixed by adding `withBotLock` (Postgres advisory lock) in `db.js`, wrapping every `runBot` call. `db.js`, `bot/deps.js`.
- **Tranche fills not notified** — T2/T3 scale-ins were only console-logged, never sent to Telegram. Fixed by threading `notifyTrade` into `checkTranches` and adding a `TRANCHE` message type. `bot/execution.js`, `bot/telegram.js`, `bot/runner.js`.
- **Claude approval outage (assistant-message prefill)** — `callClaudeBudgeted` ended requests with an assistant prefill to force JSON; the current model rejects prefill, so every approval call 400'd and the bot ran on auto-approval only. Fixed by removing the prefill, steering JSON via the system prompt, and parsing with `extractJsonObject`. `bot/claude.js`. (See Claude API Configuration above.)

### Active / Ongoing
- **DRIFT WARNING** — Last 100 trades: WR 42%, EV $1.64, PF 1.09, DD 8.6% — all below baseline (WR 43.6%, EV $4.03, PF 1.52, DD 3.5%). Likely contaminated by the duplicate-instance period (two bots racing on shared state). Expected to recover as clean single-instance trades roll the bad ones out of the 100-trade window. The June 2026 strategy-hardening pass (see above) also targets the underlying edge. Re-evaluate after ~150 clean trades; if still drifting, it's a real bear-regime strategy issue.
- **Claude API errors** — See above. Deploy error logging fix and check Railway logs.
- **SLX-USDT-SWAP / IRYS-USDT-SWAP partial candles** — These symbols consistently return fewer candles than requested (SLX: 56/200 on 4H, IRYS: 85/200 on 4H). New listings with limited history. Bot skips them correctly but they appear as noise in logs.
- **`superduperbot-premarket` service** — Still running on schedule but does nothing (disabled in code). Wastes a Railway service slot — consider deleting it.

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
