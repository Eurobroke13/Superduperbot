import {
  runBot,
  sendDailyReport,
  sendWeeklyReview,
  premarketScan,
  reevaluatePositions
} from "./bot/deps.js";
import { closeDb, pool } from "./db.js";
import { initDb } from "./db.js";

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
    case "reset-state":
      await resetState();
      break;
    default:
      throw new Error(
        "Unknown task. Use one of: fast-scan, run-bot, daily-report, weekly-review, premarket, reevaluate, reset-state"
      );
  }
}

async function resetState() {
  console.log("[RESET] Clearing bot state...");
  await initDb();
  
  try {
    // Delete the main state record
    await pool.query("DELETE FROM bot_state WHERE state_key = $1", ["bot_state_v1"]);
    console.log("[RESET] ✅ State cleared. Bot will start fresh on next run.");
  } catch (err) {
    console.error("[RESET] Error clearing state:", err.message);
    throw err;
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

