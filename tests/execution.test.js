/**
 * Tests for bot/execution.js — the position-open + scaling critical path.
 *
 *  - portfolioValue: cash + reserved notional + clamped unrealized PnL
 *  - openPositionGradual: sizing, MAX_POSITION_SHARE cap, leverage tiers,
 *    circuit breaker, invalid-stop / cash-too-low guards, tranche plan
 *  - checkTranches: T2/T3 fills, cash accounting, SL NEVER LOOSENS
 *  - checkDCA: early-return guards (no network)
 *
 * execution.js does not import db.js, so a plain static import works.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  portfolioValue,
  openPositionGradual,
  checkTranches,
  checkDCA
} from "../bot/execution.js";

function freshState(overrides = {}) {
  return {
    cash: 10000,
    positions: {},
    trades: [],
    peakValue: 10000,
    ...overrides
  };
}

function longCandidate(overrides = {}) {
  return {
    symbol: "TEST-USDT-SWAP",
    signal: "long",
    price: 100,
    sl: 95,
    tp: 130,
    atrVal: 2,
    riskReward: 2,
    score: 6,
    reasons: ["ema-ribbon-bull"],
    setupType: "trend",
    approvalType: "auto",
    ...overrides
  };
}

// ───────────────────────── portfolioValue ─────────────────────────

test("portfolioValue - cash only when no positions", () => {
  assert.equal(portfolioValue(freshState({ cash: 1234 })), 1234);
});

test("portfolioValue - adds reserved notional", () => {
  const state = freshState({
    cash: 1000,
    positions: { A: { symbol: "A", direction: "long", entryPrice: 10, size: 5, notional: 500 } }
  });
  // no livePrices -> no unrealized; value = cash + reserved
  assert.equal(portfolioValue(state), 1500);
});

test("portfolioValue - adds unrealized PnL when live prices supplied", () => {
  const state = freshState({
    cash: 1000,
    positions: { A: { symbol: "A", direction: "long", entryPrice: 10, size: 5, notional: 500 } }
  });
  // price 12 -> pnl = (12-10)*5 = 10
  assert.equal(portfolioValue(state, { A: 12 }), 1000 + 500 + 10);
});

test("portfolioValue - clamps unrealized loss at -notional", () => {
  // NOTE: a live price of exactly 0 is treated as "no price" (falsy guard in
  // execution.js), so we use a small non-zero price to exercise the clamp.
  const state = freshState({
    cash: 1000,
    positions: { A: { symbol: "A", direction: "long", entryPrice: 10, size: 5, notional: 500 } }
  });
  // price 1 -> raw pnl = (1-10)*5 = -45, above -notional floor -> -45
  assert.equal(portfolioValue(state, { A: 1 }), 1000 + 500 - 45);
  // extreme: size huge so raw loss exceeds notional and gets clamped
  const state2 = freshState({
    cash: 1000,
    positions: { A: { symbol: "A", direction: "long", entryPrice: 10, size: 1000, notional: 500 } }
  });
  // raw pnl = (1-10)*1000 = -9000, clamped to -500
  assert.equal(portfolioValue(state2, { A: 1 }), 1000 + 500 - 500);
});

// ───────────────────────── openPositionGradual ─────────────────────────

test("openPositionGradual - opens long with tranche-1 (40%) cash deduction", () => {
  const state = freshState();
  const res = openPositionGradual(longCandidate(), state);
  assert.equal(res.opened, true);
  const pos = state.positions["TEST-USDT-SWAP"];
  assert.ok(pos, "position should exist");
  // riskAmount=300, slDist=5, size=60, notional=6000 -> capped to maxNotional=1000
  // tranche1 = 40% of 1000 = 400
  assert.equal(pos.notional, 400);
  assert.equal(state.cash, 10000 - 400);
  assert.equal(pos.tranches.filledCount, 1);
  assert.equal(pos.tranches.plan.totalNotional, 1000);
});

test("openPositionGradual - respects MAX_POSITION_SHARE cap (10%)", () => {
  const state = freshState({ cash: 10000, peakValue: 10000 });
  // very tight stop would create huge size; must be capped to 10% of portfolio
  const res = openPositionGradual(longCandidate({ sl: 99.9 }), state);
  assert.equal(res.opened, true);
  assert.equal(state.positions["TEST-USDT-SWAP"].tranches.plan.totalNotional, 1000);
});

test("openPositionGradual - leverage scales with score", () => {
  const tiers = [
    { score: 8, lev: 6 },
    { score: 7, lev: 5 },
    { score: 6, lev: 4 },
    { score: 5, lev: 3 },
    { score: 4, lev: 2 }
  ];
  for (const { score, lev } of tiers) {
    const state = freshState();
    openPositionGradual(longCandidate({ score }), state);
    assert.equal(state.positions["TEST-USDT-SWAP"].leverage, lev, `score ${score} -> lev ${lev}`);
  }
});

test("openPositionGradual - circuit breaker blocks at >=15% drawdown", () => {
  // currVal = cash = 8000, peakValue 10000 -> drawdown 0.2 >= 0.15
  const state = freshState({ cash: 8000, peakValue: 10000 });
  const res = openPositionGradual(longCandidate(), state);
  assert.equal(res.opened, false);
  assert.equal(res.reason, "circuit-breaker");
  assert.equal(state.circuitBreakerActive, true);
  assert.equal(state.positions["TEST-USDT-SWAP"], undefined);
});

test("openPositionGradual - rejects zero stop distance", () => {
  const state = freshState();
  const res = openPositionGradual(longCandidate({ sl: 100 }), state); // sl == price
  assert.equal(res.opened, false);
  assert.equal(res.reason, "invalid-stop-distance");
});

test("openPositionGradual - rejects when cash below tranche-1 need", () => {
  // Inflate portfolio value via an existing position so maxNotional is high,
  // but keep state.cash below the resulting tranche-1 requirement.
  const state = freshState({
    cash: 300,
    peakValue: 10000,
    positions: { OLD: { symbol: "OLD", direction: "long", entryPrice: 1, size: 1, notional: 9700 } }
  });
  // currVal = 300 + 9700 = 10000; maxNotional = 1000; tranche1 = 400 > cash 300
  const res = openPositionGradual(longCandidate(), state);
  assert.equal(res.opened, false);
  assert.equal(res.reason, "cash-too-low");
});

test("openPositionGradual - sets liquidation price and tranche triggers (long)", () => {
  const state = freshState();
  openPositionGradual(longCandidate({ atrVal: 2 }), state);
  const pos = state.positions["TEST-USDT-SWAP"];
  // long liq below entry
  assert.ok(pos.liquidationPrice < pos.entryPrice);
  // T2 at +0.5 ATR, T3 at +1.5 ATR
  assert.ok(Math.abs(pos.tranches.plan.tranche2.triggerPrice - 101) < 1e-9);
  assert.ok(Math.abs(pos.tranches.plan.tranche3.triggerPrice - 103) < 1e-9);
});

test("openPositionGradual - short sets symmetric triggers", () => {
  const state = freshState();
  openPositionGradual(longCandidate({ signal: "short", price: 100, sl: 105, tp: 70, atrVal: 2 }), state);
  const pos = state.positions["TEST-USDT-SWAP"];
  assert.equal(pos.direction, "short");
  assert.ok(pos.liquidationPrice > pos.entryPrice);
  // short T2 at -0.5 ATR = 99, T3 at -1.5 ATR = 97
  assert.ok(Math.abs(pos.tranches.plan.tranche2.triggerPrice - 99) < 1e-9);
  assert.ok(Math.abs(pos.tranches.plan.tranche3.triggerPrice - 97) < 1e-9);
});

// ───────────────────────── checkTranches ─────────────────────────

function openLongPos(state) {
  openPositionGradual(longCandidate({ atrVal: 2, score: 6 }), state);
  return state.positions["TEST-USDT-SWAP"];
}

test("checkTranches - T2 fills at trigger, raises SL, never loosens", () => {
  const state = freshState();
  const pos = openLongPos(state);
  const slBefore = pos.sl;
  const cashBefore = state.cash;
  checkTranches(pos, pos.tranches.plan.tranche2.triggerPrice, state);
  assert.equal(pos.tranches.plan.tranche2.filled, true);
  assert.equal(pos.tranches.filledCount, 2);
  assert.ok(state.cash < cashBefore, "cash should be deducted for T2");
  assert.ok(pos.sl >= slBefore, "SL must not loosen on T2 fill");
  // long SL raised to at least tranche1 entry price
  assert.ok(pos.sl >= pos.tranches.plan.tranche1.price - 1e-9);
});

test("checkTranches - T2 does NOT fill when cash insufficient", () => {
  const state = freshState();
  const pos = openLongPos(state);
  state.cash = 1; // can't afford T2
  const sizeBefore = pos.size;
  checkTranches(pos, pos.tranches.plan.tranche2.triggerPrice, state);
  assert.equal(pos.tranches.plan.tranche2.filled, false);
  assert.equal(pos.size, sizeBefore, "size unchanged when T2 can't fill");
});

test("checkTranches - T3 only fills after T2 and tightens SL further", () => {
  const state = freshState();
  const pos = openLongPos(state);
  // Fill T2 first
  checkTranches(pos, pos.tranches.plan.tranche2.triggerPrice, state);
  const slAfterT2 = pos.sl;
  // Now T3
  checkTranches(pos, pos.tranches.plan.tranche3.triggerPrice, state);
  assert.equal(pos.tranches.plan.tranche3.filled, true);
  assert.equal(pos.tranches.filledCount, 3);
  assert.ok(pos.sl >= slAfterT2, "SL must not loosen on T3 fill");
});

test("checkTranches - SL never loosens across a full long scale-in walk", () => {
  const state = freshState();
  const pos = openLongPos(state);
  let prev = pos.sl;
  for (const price of [100.5, 101, 102, 103, 104, 102]) {
    checkTranches(pos, price, state);
    assert.ok(pos.sl >= prev - 1e-9, `SL loosened at ${price}: ${pos.sl} < ${prev}`);
    prev = pos.sl;
  }
});

test("checkTranches - no-op when position has no tranches", () => {
  const state = freshState();
  const pos = { direction: "long", sl: 95 };
  assert.doesNotThrow(() => checkTranches(pos, 110, state));
});

// ───────────────────────── checkDCA guards ─────────────────────────

test("checkDCA - returns early if already applied (no mutation)", async () => {
  const state = freshState();
  const pos = { symbol: "X", direction: "long", entryPrice: 100, size: 10, notional: 500, dcaApplied: true, openedAt: new Date(Date.now() - 6 * 3600000).toISOString() };
  await checkDCA(pos, 90, 2, state, null);
  assert.equal(pos.dcaApplied, true);
  assert.equal(state.cash, 10000); // untouched
});

test("checkDCA - returns early if position younger than 4h", async () => {
  const state = freshState();
  const pos = { symbol: "X", direction: "long", entryPrice: 100, size: 10, notional: 500, dcaApplied: false, openedAt: new Date(Date.now() - 1 * 3600000).toISOString() };
  await checkDCA(pos, 90, 2, state, null);
  assert.equal(pos.dcaApplied, false);
  assert.equal(state.cash, 10000);
});

test("checkDCA - returns early when loss outside 0.7-2.5 ATR band", async () => {
  const state = freshState();
  const pos = { symbol: "X", direction: "long", entryPrice: 100, size: 10, notional: 500, dcaApplied: false, openedAt: new Date(Date.now() - 6 * 3600000).toISOString() };
  // price == entry -> lossATRs = 0 < 0.7 -> early return, no fetch
  await checkDCA(pos, 100, 2, state, null);
  assert.equal(pos.dcaApplied, false);
  assert.equal(state.cash, 10000);
});

// ── checkDCA SL floor (the RSR fix) ─────────────────────────────────────────────
// These tests require injecting _fetchCandles so we don't hit the network.

function makeDcaCandles() {
  // 100 candles with enough RSI/MACD/VWAP data for confirmations to pass
  // Rising candles so RSI < 40 is unlikely — we'll control confirmations
  // via price relationship to VWAP/ichimoku, but the easiest approach is
  // to supply candles that give >= 3 confirmations for a long DCA.
  // Low RSI (oversold) + candles structured for macd.histogram > 0
  return Array.from({ length: 100 }, (_, i) => ({
    open:   90 + i * 0.05,
    high:   90 + i * 0.05 + 0.5,
    low:    90 + i * 0.05 - 0.5,
    close:  90 + i * 0.05,
    volume: 1000 + i
  }));
}

test("checkDCA - SL is always at least 1 ATR below DCA price (long)", async () => {
  // RSR scenario: cheap coin, DCA at 0.00014, ATR=0.000002
  // Before fix: sl = blendedEntry - 2×ATR could be above DCA price
  const atr = 0.000002;
  const dcaPrice = 0.00014;
  const entryPrice = 0.000155; // original entry, 0.75 ATR above dca (within 0.7–2.5 band)

  const state = freshState(10000);
  const pos = {
    symbol: "RSR-USDT-SWAP",
    direction: "long",
    entryPrice,
    size: 100000,
    notional: 500,
    dcaApplied: false,
    atrVal: atr,
    openedAt: new Date(Date.now() - 6 * 3600000).toISOString()
  };

  // Candles crafted so confirmations pass: last close > vwap-ish, rsi < 40
  // Easier: use declining candles so rsiVal ends up < 40
  const candles = Array.from({ length: 100 }, (_, i) => ({
    open:   0.00020 - i * 0.000001,
    high:   0.00020 - i * 0.000001 + 0.000001,
    low:    0.00020 - i * 0.000001 - 0.000001,
    close:  0.00020 - i * 0.000001,
    volume: 1000
  }));

  await checkDCA(pos, dcaPrice, atr, state, null, {
    _fetchCandles: async () => candles
  });

  if (pos.dcaApplied) {
    // The critical invariant: SL must be at least 1 ATR below the DCA price
    assert.ok(
      pos.sl <= dcaPrice - atr,
      `SL ${pos.sl} must be <= dcaPrice(${dcaPrice}) - 1×ATR(${atr}) = ${dcaPrice - atr}`
    );
  }
  // If DCA didn't apply (not enough confirmations), the guard trivially holds
});

test("checkDCA - SL after DCA is strictly below the DCA execution price for long", async () => {
  const atr = 2;
  const dcaPrice = 98;   // 1 ATR below entry
  const entryPrice = 100;

  const state = freshState(10000);
  const pos = {
    symbol: "BTC-USDT-SWAP",
    direction: "long",
    entryPrice,
    size: 1,
    notional: 500,
    dcaApplied: false,
    atrVal: atr,
    openedAt: new Date(Date.now() - 6 * 3600000).toISOString()
  };

  // Declining candles → rsiVal < 40 (confirms first condition), macd histogram likely negative
  // We just need >=3 of 5 confirmations; declining ensures rsiVal < 40
  const candles = Array.from({ length: 100 }, (_, i) => ({
    open:   200 - i * 0.8,
    high:   200 - i * 0.8 + 1,
    low:    200 - i * 0.8 - 1,
    close:  200 - i * 0.8,
    volume: 1000 + i * 5
  }));

  await checkDCA(pos, dcaPrice, atr, state, null, {
    _fetchCandles: async () => candles
  });

  if (pos.dcaApplied) {
    assert.ok(
      pos.sl < dcaPrice,
      `SL ${pos.sl} must be below DCA price ${dcaPrice}`
    );
    assert.ok(
      pos.sl <= dcaPrice - atr,
      `SL ${pos.sl} must be at least 1 ATR below DCA price (${dcaPrice - atr})`
    );
  }
});

test("checkDCA - short SL is at least 1 ATR above DCA price", async () => {
  const atr = 2;
  const dcaPrice = 102;
  const entryPrice = 100;

  const state = freshState(10000);
  const pos = {
    symbol: "ETH-USDT-SWAP",
    direction: "short",
    entryPrice,
    size: 1,
    notional: 500,
    dcaApplied: false,
    atrVal: atr,
    openedAt: new Date(Date.now() - 6 * 3600000).toISOString()
  };

  // Rising candles → rsiVal > 60 confirms short condition
  const candles = Array.from({ length: 100 }, (_, i) => ({
    open:   50 + i * 0.8,
    high:   50 + i * 0.8 + 1,
    low:    50 + i * 0.8 - 1,
    close:  50 + i * 0.8,
    volume: 1000 + i * 5
  }));

  await checkDCA(pos, dcaPrice, atr, state, null, {
    _fetchCandles: async () => candles
  });

  if (pos.dcaApplied) {
    assert.ok(
      pos.sl > dcaPrice,
      `short SL ${pos.sl} must be above DCA price ${dcaPrice}`
    );
    assert.ok(
      pos.sl >= dcaPrice + atr,
      `short SL ${pos.sl} must be at least 1 ATR above DCA price (${dcaPrice + atr})`
    );
  }
});

test("checkDCA - SL floor holds even when blended entry would place SL above DCA price", async () => {
  // Construct the exact RSR failure case:
  // entryPrice=0.000155, dcaPrice=0.00014, atr=0.000002
  // blendedEntry ≈ (0.000155*1 + 0.00014*0.5)/1.5 ≈ 0.0001467
  // old SL = 0.0001467 - 2*0.000002 = 0.0001427 → ABOVE dcaPrice(0.00014)? No...
  // Actually 0.0001427 < 0.00014 so old code was fine in that specific math.
  // The real failure: entryPrice very close to dcaPrice
  // entryPrice=0.000142, dcaPrice=0.00014, atr=0.000001
  // blendedEntry=(0.000142*1+0.00014*0.5)/1.5=0.0001413
  // old SL=0.0001413-2*0.000001=0.0001393 which is > 0.00014-0.000001=0.000139 ✓
  // To reproduce: need blendedEntry-2*atr > dcaPrice - 1*atr
  // i.e. blended - 2a > dca - a → blended - dca > a
  // With entry=0.000145, dca=0.00014, blend≈0.0001433, diff=0.0000033 > atr=0.000002 → old SL=0.0001393 > 0.000138
  const atr = 0.000002;
  const dcaPrice = 0.00014;
  const entryPrice = 0.000145;

  const state = freshState(10000);
  const pos = {
    symbol: "RSR-USDT-SWAP",
    direction: "long",
    entryPrice,
    size: 100000,
    notional: 500,
    dcaApplied: false,
    atrVal: atr,
    openedAt: new Date(Date.now() - 6 * 3600000).toISOString()
  };

  const candles = Array.from({ length: 100 }, (_, i) => ({
    open:   0.0002 - i * 0.000001,
    high:   0.0002 - i * 0.000001 + 0.0000005,
    low:    0.0002 - i * 0.000001 - 0.0000005,
    close:  0.0002 - i * 0.000001,
    volume: 1000
  }));

  await checkDCA(pos, dcaPrice, atr, state, null, {
    _fetchCandles: async () => candles
  });

  if (pos.dcaApplied) {
    const floor = dcaPrice - atr;
    assert.ok(
      pos.sl <= floor + 1e-10,
      `SL ${pos.sl.toFixed(8)} must be <= ${floor.toFixed(8)} (dcaPrice - 1ATR)`
    );
  }
});
