import fs from "fs/promises";
import { initDb } from "./db.js";
import { saveState } from "./state-store.js";

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    throw new Error("Usage: node import-state.js <path-to-exported-state-file>");
  }

  const raw = await fs.readFile(filePath, "utf8");
  const importedState = JSON.parse(raw);

  await initDb();
  await saveState(importedState);

  const summary = {
    cash: importedState.cash,
    positions: Object.keys(importedState.positions || {}).length,
    trades: Array.isArray(importedState.trades) ? importedState.trades.length : 0,
    disabledSignals: Array.isArray(importedState.disabledSignals) ? importedState.disabledSignals.length : 0,
    weeklyReviews: Array.isArray(importedState.weeklyReviews) ? importedState.weeklyReviews.length : 0
  };

  console.log("Imported Cloudflare state into Postgres:");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("[import-state]", error.message);
  process.exit(1);
});
