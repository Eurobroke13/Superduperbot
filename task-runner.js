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
  console.log("[RESET] Performing surgical reset (preserving cash & positions)...");
  await initDb();
  
  try {
    // Load current state
    const result = await pool.query(
      "SELECT state FROM bot_state WHERE state_key = $1",
      ["bot_state_v1"]
    );

    if (result.rows.length === 0) {
      console.log("[RESET] No state found to reset.");
      return;
    }

    const currentState = result.rows[0].state;

    // Preserve these fields
    const preserved = {
      cash: currentState.cash,
      positions: currentState.positions,
      trades: currentState.trades,
      peakValue: currentState.peakValue,
      startedAt: currentState.startedAt
    };

    // Clear these tracking fields
    const resetState = {
      ...preserved,
      lastRegime: null,
      hmmParams: null,
      markovChain: null,
      circuitBreakerActive: false,
      lastPhase: 0,
      lastHeadlineIds: null,
      newsBlocked: [],
      newsBoosted: [],
      newsHeadlines: [],
      newsNeedsClaude: false,
      decisionLog: [],
      tokenUsage: null,
      signalStats: {},
      disabledSignals: [],
      dynamicWeights: {},
      lastWeightUpdate: 0,
      coinHistory: {},
      dailyBias: null,
      weeklyReviews: [],
      lunarCache: null,
      lastPeriodicReportAt: null,
      lastRunAt: null,
      runCount: 0,
      regimeStats: {
        bull: { wins: 0, losses: 0, totalPnl: 0, count: 0 },
        bear: { wins: 0, losses: 0, totalPnl: 0, count: 0 },
        sideways: { wins: 0, losses: 0, totalPnl: 0, count: 0 }
      },
      pendingLimits: {},
      decayingLimits: {},
      pendingRetests: {},
      cooldowns: {}
    };

    // Update state with reset values
    await pool.query(
      `
        UPDATE bot_state
        SET state = $1::jsonb, updated_at = NOW()
        WHERE state_key = $2
      `,
      [JSON.stringify(resetState), "bot_state_v1"]
    );

    console.log("[RESET] ✅ Surgical reset complete!");
    console.log(`[RESET] Preserved: Cash=$${preserved.cash.toFixed(2)}, Positions=${Object.keys(preserved.positions).length}, Trades=${preserved.trades.length}`);
    console.log("[RESET] Cleared: regime, signals, news, decision logs, token usage, cooldowns");
  } catch (err) {
    console.error("[RESET] Error during reset:", err.message);
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
