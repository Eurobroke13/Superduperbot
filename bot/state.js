import {
  loadState as loadPersistedState,
  saveState as savePersistedState
} from "../state-store.js";
import {
  stampStateChecksum,
  validateState
} from "./reconciliation.js";

async function loadBotState(env) {
  try {
    const state = await loadPersistedState();
    state._loadedVersion = state._version ?? 0;
    state.disabledSignals = Array.from(new Set([...(state.disabledSignals || []), "trap-vol-bear"]));
    const reconciliation = validateState(state);
    if (reconciliation.warnings.length > 0) {
      console.warn(`[RECONCILE] ${reconciliation.warnings.join(" | ")}`);
    }
    if (reconciliation.fixed.length > 0) {
      console.warn(`[RECONCILE] Fixed: ${reconciliation.fixed.join(" | ")}`);
    }
    return state;
  } catch (err) {
    console.error("[DB] CRITICAL: Failed to load state:", err.message);
    throw new Error("State load failed - aborting: " + err.message);
  }
}

async function saveBotState(env, state) {
  try {
    if (state.weeklyReviews && state.weeklyReviews.length > 12) state.weeklyReviews = state.weeklyReviews.slice(-12);
    if (state.claudeValidations) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [symbol, entry] of Object.entries(state.claudeValidations)) {
        if (!entry?.ts || entry.ts < cutoff) delete state.claudeValidations[symbol];
      }
    }
    if (state.volatilityFlags) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const [symbol, flag] of Object.entries(state.volatilityFlags)) {
        if (!flag?.ts || flag.ts < cutoff) delete state.volatilityFlags[symbol];
      }
    }
    if (state.coinHistory) {
      const coins = Object.keys(state.coinHistory);
      if (coins.length > 100) {
        const active = new Set([
          ...Object.keys(state.positions),
          ...(state.trades || []).slice(-50).map(t => t.symbol)
        ]);
        for (const coin of coins) {
          if (!active.has(coin)) delete state.coinHistory[coin];
        }
      }
    }
    state._version = (state._loadedVersion ?? 0) + 1;
    stampStateChecksum(state);
    await savePersistedState(state);
  } catch (err) {
    console.error("[DB]", err.message);
  }
}

export { loadBotState, saveBotState };
