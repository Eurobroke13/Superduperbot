import {
  runBot,
  sendDailyReport,
  sendWeeklyReview,
  premarketScan,
  reevaluatePositions,
  sendTradeAnalysis
} from "./bot/deps.js";
import { closeDb, isTransientDbError } from "./db.js";

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

// Surface anything that escapes the promise chain instead of dying silently.
process.on("unhandledRejection", (reason) => {
  console.error("[task-runner] UNHANDLED REJECTION:", reason?.stack || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[task-runner] UNCAUGHT EXCEPTION:", err?.stack || err);
  process.exit(1);
});

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    const transient = isTransientDbError(error);
    console.error("[task-runner]", error.message || error);
    try {
      await closeDb();
    } catch (_) {}

    if (transient) {
      // Postgres was unreachable even after db.js exhausted its retries. This
      // is infrastructure, not a bug in this run. Exiting 1 made Railway burn
      // restartPolicyMaxRetries and flag the whole cron deployment as CRASHED
      // — which is the "deployment crash" noise on superduperbot-runner. The
      // next cron tick is only minutes away and will pick up cleanly, so exit
      // clean and let the scheduler do its job.
      console.warn(
        `[task-runner] Postgres unavailable for task '${task}' — skipping this tick (exit 0). ` +
        "Next scheduled run will retry."
      );
      process.exit(0);
    }
    process.exit(1);
  });
