/**
 * Tests for bot/exits.js — the position-exit critical path.
 *
 * Focus areas:
 *  - SL NEVER LOOSENS invariant (the single most important stop-loss property)
 *  - zero-ATR guard (no NaN poisoning exit logic)
 *  - stop-loss / liquidation / take-profit triggers
 *  - partial-close and full-close PnL math + cash accounting + liquidation clamp
 *
 * exits.js statically imports state-store -> db.js, which throws without
 * DATABASE_URL. We set a dummy value and dynamic-import so the module loads,
 * then inject a no-op insertTrade so no real DB query is ever attempted.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";
const { checkGraduatedExit, executePartialClose, closePosition, checkBearShortExit } =
  await import("../bot/exits.js");

const noopDeps = {
  updateCoinHistory: () => {},
  updateDynamicWeights: () => {},
  updateRegimeStats: () => {}
};

function makeLong(overrides = {}) {
  return {
    symbol: "TEST-USDT-SWAP",
    direction: "long",
    entryPrice: 100,
    size: 10,
    notional: 1000,
    leverage: 3,
    sl: 95,
    tp: 130,
    atrVal: 2,
    score: 6,
    reasons: ["ema-ribbon-bull"],
    signalSet: ["ema-ribbon-bull"],
    setupType: "trend",
    approvalType: "auto",
    openedAt: new Date().toISOString(),
    maxFavorable: 100,
    liquidationPrice: 80,
    ...overrides
  };
}

function makeShort(overrides = {}) {
  return makeLong({
    direction: "short",
    entryPrice: 100,
    sl: 105,
    tp: 70,
    liquidationPrice: 120,
    ...overrides
  });
}

// ───────────────────────── SL NEVER LOOSENS ─────────────────────────

test("checkGraduatedExit - long SL never moves down across a price walk", () => {
  const pos = makeLong();
  let prevSl = pos.sl;
  // Simulate price marching up then chopping — every call must keep SL >= prev
  const walk = [101, 103, 104, 106, 105, 108, 107, 110, 109, 112, 111, 115];
  for (const price of walk) {
    checkGraduatedExit(pos, price, price + 0.5, price - 0.5, 2);
    assert.ok(pos.sl >= prevSl - 1e-9,
      `long SL loosened: ${pos.sl} < ${prevSl} at price ${price}`);
    prevSl = pos.sl;
  }
});

test("checkGraduatedExit - short SL never moves up across a price walk", () => {
  const pos = makeShort();
  let prevSl = pos.sl;
  const walk = [99, 97, 96, 94, 95, 92, 93, 90, 91, 88, 89, 85];
  for (const price of walk) {
    checkGraduatedExit(pos, price, price + 0.5, price - 0.5, 2);
    assert.ok(pos.sl <= prevSl + 1e-9,
      `short SL loosened: ${pos.sl} > ${prevSl} at price ${price}`);
    prevSl = pos.sl;
  }
});

test("checkGraduatedExit - long SL holds when price reverses after a run-up", () => {
  const pos = makeLong();
  // Drive price way up to ratchet SL, then crash price back near entry
  checkGraduatedExit(pos, 110, 111, 109, 2);
  const ratcheted = pos.sl;
  checkGraduatedExit(pos, 100, 100.5, 99.5, 2);
  assert.ok(pos.sl >= ratcheted - 1e-9, "SL must not loosen on reversal");
});

// ───────────────────────── ZERO-ATR GUARD ─────────────────────────

test("checkGraduatedExit - zero ATR does not produce NaN SL (long)", () => {
  const pos = makeLong();
  const res = checkGraduatedExit(pos, 105, 106, 104, 0);
  assert.ok(Number.isFinite(pos.sl), `SL became non-finite: ${pos.sl}`);
  assert.ok(typeof res.exit === "boolean");
});

test("checkGraduatedExit - zero ATR does not produce NaN SL (short)", () => {
  const pos = makeShort();
  const res = checkGraduatedExit(pos, 95, 96, 94, 0);
  assert.ok(Number.isFinite(pos.sl), `SL became non-finite: ${pos.sl}`);
  assert.ok(typeof res.exit === "boolean");
});

// ───────────────────────── EXIT TRIGGERS ─────────────────────────

test("checkGraduatedExit - long exits at stop-loss when low breaches SL", () => {
  const pos = makeLong({ sl: 95 });
  const res = checkGraduatedExit(pos, 96, 97, 94, 2);
  assert.equal(res.exit, true);
  assert.equal(res.reason, "stop-loss");
});

test("checkGraduatedExit - short exits at stop-loss when high breaches SL", () => {
  const pos = makeShort({ sl: 105 });
  const res = checkGraduatedExit(pos, 104, 106, 103, 2);
  assert.equal(res.exit, true);
  assert.equal(res.reason, "stop-loss");
});

test("checkGraduatedExit - long exits at liquidation", () => {
  const pos = makeLong({ sl: 70, liquidationPrice: 80 });
  const res = checkGraduatedExit(pos, 81, 82, 79, 2);
  assert.equal(res.exit, true);
  assert.equal(res.reason, "liquidation");
});

test("checkGraduatedExit - long takes full take-profit at tp", () => {
  // Avoid SL/TP1/TP2 logic interfering: tp below tp-level math is fine, just hit tp
  const pos = makeLong({ tp: 130, sl: 95 });
  const res = checkGraduatedExit(pos, 131, 131, 130, 2);
  assert.equal(res.exit, true);
  assert.equal(res.reason, "take-profit-full");
});

test("checkGraduatedExit - long fires TP1 partial close at 2xATR", () => {
  const pos = makeLong({ entryPrice: 100, atrVal: 2, sl: 95, tp: 200 });
  // tp1 price = 100 + 2*2 = 104
  const res = checkGraduatedExit(pos, 104, 104.5, 103.5, 2);
  assert.equal(res.partial, true);
  assert.ok(res.partialCloses.some(p => p.reason === "tp1-2xATR"));
  assert.equal(pos.tpLevels.tp1.hit, true);
});

test("checkGraduatedExit - mean-reversion times out after 8h with little profit", () => {
  const pos = makeLong({
    setupType: "mean-reversion",
    openedAt: new Date(Date.now() - 9 * 3600000).toISOString(),
    sl: 90, tp: 200, atrVal: 2
  });
  // profit < 0.5 ATR: price barely above entry
  const res = checkGraduatedExit(pos, 100.5, 100.6, 100.4, 2);
  assert.equal(res.exit, true);
  assert.equal(res.reason, "mr-time-expired");
});

// ───────────────────────── PARTIAL CLOSE ─────────────────────────

test("executePartialClose - reduces size/notional and credits cash with PnL", () => {
  const pos = makeLong({ entryPrice: 100, size: 10, notional: 1000 });
  const state = { cash: 5000, trades: [], lastRegime: { label: "bull" }, cooldowns: {} };
  executePartialClose("TEST-USDT-SWAP", 110, 0.5, "tp1", pos, state, noopDeps);
  // closed 50%: size 5, notional 500, pnl = (110-100)*5 = 50
  assert.equal(pos.size, 5);
  assert.equal(pos.notional, 500);
  assert.equal(state.cash, 5000 + 500 + 50);
  assert.equal(state.trades.length, 1);
  assert.equal(state.trades[0].isPartial, true);
  assert.equal(state.trades[0].pnl, 50);
});

test("executePartialClose - records regime label on the trade", () => {
  const pos = makeShort({ entryPrice: 100, size: 10, notional: 1000 });
  const state = { cash: 5000, trades: [], lastRegime: { label: "bear" }, cooldowns: {} };
  executePartialClose("TEST-USDT-SWAP", 90, 0.3, "tp1", pos, state, noopDeps);
  // short profit: (100-90)*3 = 30
  assert.equal(state.trades[0].regime, "bear");
  assert.equal(state.trades[0].pnl, 30);
});

// ───────────────────────── FULL CLOSE ─────────────────────────

test("closePosition - books PnL, deletes position, credits cash", () => {
  const pos = makeLong({ entryPrice: 100, size: 10, notional: 1000 });
  const state = { cash: 5000, trades: [], positions: { "TEST-USDT-SWAP": pos }, lastRegime: { label: "bull" }, cooldowns: {} };
  closePosition("TEST-USDT-SWAP", 120, "take-profit-full", pos, state, null, noopDeps);
  // pnl = (120-100)*10 = 200
  assert.equal(state.trades.length, 1);
  assert.equal(state.trades[0].pnl, 200);
  assert.equal(state.cash, 5000 + 1000 + 200);
  assert.equal(state.positions["TEST-USDT-SWAP"], undefined);
  assert.equal(state.trades[0].wasLiquidated, false);
});

test("closePosition - clamps loss at -notional and flags liquidation", () => {
  const pos = makeLong({ entryPrice: 100, size: 10, notional: 1000 });
  const state = { cash: 5000, trades: [], positions: { "TEST-USDT-SWAP": pos }, lastRegime: { label: "bull" }, cooldowns: {} };
  // Price crash to 10: raw pnl = (10-100)*10 = -900, within notional, not liquidated
  // Price crash to 0 would be -1000. Use price that produces > notional loss:
  closePosition("TEST-USDT-SWAP", -50, "stop-loss", pos, state, null, noopDeps);
  // raw pnl = (-50-100)*10 = -1500, clamped to -1000
  assert.equal(state.trades[0].pnl, -1000);
  assert.equal(state.trades[0].wasLiquidated, true);
  // cash = 5000 + 1000 + (-1000) = 5000
  assert.equal(state.cash, 5000);
});

test("closePosition - short profit math is correct", () => {
  const pos = makeShort({ entryPrice: 100, size: 10, notional: 1000 });
  const state = { cash: 5000, trades: [], positions: { "TEST-USDT-SWAP": pos }, lastRegime: { label: "bear" }, cooldowns: {} };
  closePosition("TEST-USDT-SWAP", 80, "take-profit-full", pos, state, null, noopDeps);
  // short pnl = (100-80)*10 = 200
  assert.equal(state.trades[0].pnl, 200);
  assert.equal(state.cash, 5000 + 1000 + 200);
});

test("closePosition - buffers the trade into _pendingTrades for atomic persist", () => {
  const pos = makeLong({ entryPrice: 100, size: 10, notional: 1000 });
  const state = { cash: 5000, trades: [], positions: { "TEST-USDT-SWAP": pos }, lastRegime: { label: "bull" }, cooldowns: {} };
  closePosition("TEST-USDT-SWAP", 120, "take-profit-full", pos, state, null, noopDeps);
  assert.ok(Array.isArray(state._pendingTrades));
  assert.equal(state._pendingTrades.length, 1);
  assert.equal(state._pendingTrades[0].pnl, 200);
  // the buffered record is the same one pushed to state.trades
  assert.equal(state._pendingTrades[0], state.trades[0]);
});

test("executePartialClose - buffers the partial trade into _pendingTrades", () => {
  const pos = makeLong({ entryPrice: 100, size: 10, notional: 1000 });
  const state = { cash: 5000, trades: [], lastRegime: { label: "bull" }, cooldowns: {} };
  executePartialClose("TEST-USDT-SWAP", 110, 0.5, "tp1", pos, state, noopDeps);
  assert.equal(state._pendingTrades.length, 1);
  assert.equal(state._pendingTrades[0].isPartial, true);
});

// ───────────────────────── BEAR SHORT EXIT ─────────────────────────

test("checkBearShortExit - no-op for non-bear-regime positions", () => {
  const pos = makeShort({ _bearRegime: false });
  const res = checkBearShortExit(pos, 95, 2, 20);
  assert.equal(res.exit, false);
});

test("checkBearShortExit - time-expires after 16h with little profit", () => {
  const pos = makeShort({ _bearRegime: true, entryPrice: 100 });
  const res = checkBearShortExit(pos, 99.5, 2, 17);
  assert.equal(res.exit, true);
  assert.equal(res.reason, "bear-short-time-expired");
});

test("checkBearShortExit - exits when underwater past 10h", () => {
  const pos = makeShort({ _bearRegime: true, entryPrice: 100 });
  // price above entry = underwater for a short
  const res = checkBearShortExit(pos, 102, 2, 11);
  assert.equal(res.exit, true);
  assert.equal(res.reason, "bear-short-underwater-10h");
});

test("checkBearShortExit - tightens SL but never loosens it on profit", () => {
  const pos = makeShort({ _bearRegime: true, entryPrice: 100, sl: 105 });
  // 0.5+ ATR profit (price well below entry) → trail SL down toward price
  checkBearShortExit(pos, 98, 2, 5);
  assert.ok(pos.sl <= 105, "short SL should only tighten downward");
});
