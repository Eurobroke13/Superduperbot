import {
  runBot,
  sendDailyReport,
  sendWeeklyReview,
  premarketScan,
  reevaluatePositions
} from "./bot/deps.js";
import { closeDb } from "./db.js";
import { loadState, saveState } from "./state-store.js";

const task = process.argv[2];
const env = process.env;

async function main() {
  switch (task) {
    case "fast-scan":
      process.env.FAST_SCAN_MODE = "true";
      await runBot(env);
      break;
    case "run-bot":
      delete process.env.FAST_SCAN_MODE;
      await runBot(env);
      break;
    case "daily-report":
      await sendDailyReport(env);
      break;
    case "weekly-review":
      await sendWeeklyReview(env);
      break;
    case "premarket":
      await premarketScan(env);
      break;
    case "reevaluate":
      await reevaluatePositions(env);
      break;
    case "reset-state": {
      const state = await loadState();
      state.regimeStats = {
        bull:     { wins: 0, losses: 0, totalPnl: 0, count: 0 },
        bear:     { wins: 0, losses: 0, totalPnl: 0, count: 0 },
        sideways: { wins: 0, losses: 0, totalPnl: 0, count: 0 }
      };
      state.driftStatus         = null;
      state.cooldowns           = {};
      state.disabledSignals     = [];
      state.circuitBreakerActive = false;
      state.coinHistory         = {};
      state.lastRunSummary      = null;
      state.drawdown            = 0;
      await saveState(state);
      console.log("[reset-state] Done — regimeStats, driftStatus, cooldowns, disabledSignals, circuitBreaker, coinHistory, lastRunSummary, drawdown cleared.");
      break;
    }
    default:
      throw new Error(
        "Unknown task. Use one of: fast-scan, run-bot, daily-report, weekly-review, premarket, reevaluate, reset-state"
      );
  }
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[task-runner]", error.message || error);
    try {
      await closeDb();
    } catch (_) {}
    process.exit(1);
  });
