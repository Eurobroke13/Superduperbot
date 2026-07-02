import {
  runBot,
  sendDailyReport,
  sendWeeklyReview,
  premarketScan,
  reevaluatePositions,
  sendTradeAnalysis
} from "./bot/deps.js";
import { closeDb } from "./db.js";

const task = process.argv[2];
const env = process.env;

// Hard watchdog: if the task is still running after this long, force-exit
// non-zero so Railway's ON_FAILURE policy surfaces it and the cron slot is
// freed. Without this, a single hung await (e.g. a stalled fetch) parked the
// fast-scan runner forever with zero output (2026-07-02, 8+ hours wedged).
// Fast-scan normally completes in <1 min; 10 min is generous for every task.
const WATCHDOG_MINUTES = Number(env.TASK_WATCHDOG_MINUTES || 10);
setTimeout(() => {
  console.error(
    `[task-runner] WATCHDOG: task '${task}' still running after ${WATCHDOG_MINUTES} minutes — force-exiting`
  );
  process.exit(2);
}, WATCHDOG_MINUTES * 60_000);

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
      // disabled — too frequent for Telegram
      break;
    case "weekly-review":
      await sendWeeklyReview(env);
      break;
    case "premarket":
      // disabled — sends Telegram daily summaries the user doesn't want
      break;
    case "reevaluate":
      await reevaluatePositions(env);
      break;
    case "trade-analysis":
      await sendTradeAnalysis(env);
      break;
    default:
      throw new Error(
        "Unknown task. Use one of: fast-scan, run-bot, daily-report, weekly-review, premarket, reevaluate, trade-analysis"
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
