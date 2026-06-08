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
