import { PAPER_CASH } from "./config.js";

const REQUIRED_POSITION_FIELDS = [
  "symbol",
  "entryPrice",
  "direction",
  "size",
  "notional",
  "sl",
  "openedAt"
];

export function computeStateChecksum(state) {
  const positions = state.positions || {};
  const tradeCount = Array.isArray(state.trades) ? state.trades.length : 0;
  const positionCount = Object.keys(positions).length;
  const cash = Number.isFinite(state.cash) ? state.cash : 0;
  return `${positionCount}:${cash.toFixed(2)}:${tradeCount}`;
}

export function stampStateChecksum(state) {
  state.stateChecksum = computeStateChecksum(state);
  state.stateChecksumUpdatedAt = new Date().toISOString();
  return state.stateChecksum;
}

export function validateState(state) {
  const warnings = [];
  const fixed = [];

  if (!state || typeof state !== "object") {
    return { valid: false, warnings: ["state is not an object"], fixed };
  }

  if (!state.positions || typeof state.positions !== "object" || Array.isArray(state.positions)) {
    state.positions = {};
    fixed.push("reset invalid positions object");
  }

  if (!Number.isFinite(state.cash)) {
    state.cash = PAPER_CASH;
    fixed.push("reset invalid cash balance");
  }

  for (const [key, pos] of Object.entries(state.positions)) {
    const missing = REQUIRED_POSITION_FIELDS.filter((field) => pos?.[field] === undefined || pos?.[field] === null);
    const invalidDirection = pos?.direction !== "long" && pos?.direction !== "short";
    const invalidNumbers = ["entryPrice", "size", "notional", "sl"].some((field) => !Number.isFinite(Number(pos?.[field])));

    if (missing.length > 0 || invalidDirection || invalidNumbers) {
      delete state.positions[key];
      fixed.push(`removed malformed position ${key}`);
      warnings.push(
        `position ${key} failed sanity check` +
        (missing.length ? ` missing=${missing.join(",")}` : "")
      );
      continue;
    }

    if (pos.symbol !== key) {
      warnings.push(`position key ${key} does not match symbol ${pos.symbol}`);
    }
  }

  const totalNotional = Object.values(state.positions)
    .reduce((sum, pos) => sum + Number(pos.notional || 0), 0);
  const realizedPnl = (state.trades || [])
    .reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const expectedEquity = PAPER_CASH + realizedPnl;
  const trackedEquity = Number(state.cash || 0) + totalNotional;
  const tolerance = Math.max(100, Math.abs(expectedEquity) * 0.25);

  if (Number.isFinite(expectedEquity) && Math.abs(trackedEquity - expectedEquity) > tolerance) {
    warnings.push(
      `cash/notional sanity drift tracked=$${trackedEquity.toFixed(2)} expected~$${expectedEquity.toFixed(2)}`
    );
  }

  if (state.stateChecksum) {
    const currentChecksum = computeStateChecksum(state);
    if (state.stateChecksum !== currentChecksum) {
      warnings.push(`state checksum mismatch saved=${state.stateChecksum} current=${currentChecksum}`);
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
    fixed
  };
}
