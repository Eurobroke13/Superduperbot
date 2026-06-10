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

### How main bot and fast-scan runner coordinate
- Main bot (15 min): loads state → refreshes regime → fetches news → scores 50 contracts → Claude approval → saves state
- Fast-scan runner (2 min): loads state → uses **cached regime** → scores batch → **auto-approves only** (no Claude) → saves state
- **Postgres advisory lock** (`withBotLock` in `db.js`) prevents them running simultaneously — if the main bot is mid-run when the cron fires, the fast-scan skips that cycle with `[LOCK] Another bot run is active — skipping this run`

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
  adaptation.js        — Dynamic signal weight updates, regime stats tracking
  risk-gates.js        — Daily loss limit, min R:R gate, mid-run drawdown halt
  runner-utils.js      — Pure helpers: buildRegimeConsensus, checkMidRunDrawdown, applySyncFilters, etc.
db.js                  — Postgres pool, withTransaction, withBotLock (advisory lock)
state-store.js         — loadState / saveState; atomic trade + blob writes
trade-store.js         — Separate trades table (loadRecentTrades, insertTrade)
```

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

**As of June 2026:** Claude spend shows $0.09 of $40 budget used, but the API was consistently returning errors. Root cause not yet confirmed — deploy the error logging fix and check Railway logs for `[CLAUDE] API error` to see the real error message.

---

## Known Issues & History

### Fixed
- **Daily Telegram summary spam** — `maybeSendDailySummary` used an in-memory date variable that reset on every Railway restart, sending a new summary each time. Fixed by removing the daily summary entirely (user only wants weekly report). `server.js`.
- **Stop-loss same-run re-entry churn** — After a stop-loss, the symbol was immediately re-eligible for entry in the same 15-min cycle. Fixed by building `slThisRun` set from `_pendingTrades` and excluding those symbols from `tradeable` filter. `bot/runner.js`.
- **Claude error detection swallowing real errors** — `invalid_request_error` was being caught as a budget-limit signal, causing silent fallback to auto-mode for ANY 400 error (wrong model, bad request format, etc.). Now only actual spend-limit messages trigger `CLAUDE_LIMIT_FALLBACK`. `bot/claude.js`.
- **Duplicate bot instances** — `superduperbot-runner` was running `npm start` (full server) instead of `npm run task:fast-scan`, causing two complete bot instances scanning and trading simultaneously. Fixed by changing the runner's start command in Railway.
- **Race condition between services** — Main bot and fast-scan runner shared Postgres state with no coordination. Fixed by adding `withBotLock` (Postgres advisory lock) in `db.js`, wrapping every `runBot` call. `db.js`, `bot/deps.js`.

### Active / Ongoing
- **DRIFT WARNING** — Last 100 trades: WR 42%, EV $1.64, PF 1.09, DD 8.6% — all below baseline (WR 43.6%, EV $4.03, PF 1.52, DD 3.5%). Bot is underperforming. Thresholds may need tightening in bear regime.
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
