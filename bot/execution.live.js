// =============================================================================
// EXECUTION.JS - LIVE WIRING PATCH
//
// This is a guide file, not an active module in production.
// These are the only changes needed in bot/execution.js / bot/runner.js
// when you decide to wire live OKX execution.
// Paper trading path should remain unchanged.
// =============================================================================

// STEP 1: Add this import at the top of execution.js
import {
  placeOrder as exchangeOpen,
  closePosition as exchangeClose,
  amendStopLoss as exchangeAmendSL,
  reconcilePositions,
  checkConnectivity,
  LIVE_MODE,
  LIVE_RISK_PCT
} from "./exchange.js";

// STEP 2: In openPositionGradual() - after the paper state update, add the live call.
async function openPositionLive(state, candidate, pos, trancheNotional) {
  if (!LIVE_MODE) return;

  try {
    const result = await exchangeOpen({
      instId: candidate.symbol,
      direction: candidate.signal,
      notional: trancheNotional * LIVE_RISK_PCT / 0.03,
      price: candidate.price,
      sl: candidate.sl,
      tp: candidate.tp,
      tag: "t1"
    });

    pos.liveOrdId = result.ordId;
    pos.contracts = result.sz;
    pos.liveMode = true;
    console.log(`[LIVE] Opened ${candidate.signal} ${candidate.symbol} ordId=${result.ordId}`);
  } catch (err) {
    console.error(`[LIVE] openPosition failed for ${candidate.symbol}: ${err.message}`);
  }
}

// STEP 3: In closePosition() - after the paper state update, add live close.
async function closePositionLive(pos, exitPrice, reason) {
  if (!LIVE_MODE || !pos.liveMode) return;

  try {
    await exchangeClose({
      instId: pos.symbol,
      direction: pos.direction,
      sz: pos.contracts || 0,
      reason
    });
  } catch (err) {
    console.error(`[LIVE] closePosition failed for ${pos.symbol}: ${err.message}`);
  }
}

// STEP 4: In the trailing-stop path, amend the live stop loss too.
async function trailStopLive(pos, newSl) {
  if (!LIVE_MODE || !pos.liveMode) return;

  try {
    await exchangeAmendSL({
      instId: pos.symbol,
      direction: pos.direction,
      sz: pos.contracts || 0,
      newSl,
      newTp: pos.tp
    });
    console.log(`[LIVE] SL trailed -> ${newSl} for ${pos.symbol}`);
  } catch (err) {
    console.error(`[LIVE] trailStop failed for ${pos.symbol}: ${err.message}`);
  }
}

// STEP 5: In runner.js - add startup connectivity / reconciliation.
async function startupChecks(state) {
  await checkConnectivity();
  await reconcilePositions(state);
}

// Call inside runBot(), before the main scan loop:
// await startupChecks(state);

/*
Required Railway env vars for live mode:

OKX_API_KEY=...
OKX_SECRET=...
OKX_PASSPHRASE=...
LIVE_MODE=false
LIVE_RISK_PCT=0.001
OKX_POS_MODE=net

Suggested rollout:
1. Keep LIVE_MODE=false and deploy.
2. Run reconcile to verify connectivity.
3. Set LIVE_RISK_PCT=0.001 and LIVE_MODE=true.
4. Watch one full trade cycle in Railway logs.
5. Increase LIVE_RISK_PCT gradually only after a clean live cycle.

OKX API key permissions:
- Read
- Trade
- never Withdrawal
*/
