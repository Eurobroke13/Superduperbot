import {
  runBot,
  sendDailyReport,
  sendWeeklyReview,
  premarketScan,
  reevaluatePositions
} from "./bot.js";
import { closeDb } from "./db.js";

const task = process.argv[2];
const env = process.env;

async function main() {
  switch (task) {
    case "run-bot":
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
    default:
      throw new Error(
        "Unknown task. Use one of: run-bot, daily-report, weekly-review, premarket, reevaluate"
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
