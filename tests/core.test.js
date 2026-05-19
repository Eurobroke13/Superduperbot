// =============================================================================
// UNIT TESTS — core indicators, execution, exits
//
// Run: node --test tests/core.test.js
// Requires: Node 18+ (built-in test runner)
// =============================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// INDICATOR TESTS
// We import the indicator functions and test them against known values.
// If your indicators.js uses export, adjust the import path.
// ---------------------------------------------------------------------------
import {
  sma, ema, atr, rsiSeries, bollingerBands,
  emaRibbon, obv, adx, stochRSI, macd,
  findSwingPoints, detectRSIDivergence
} from "../bot/indicators.js";

describe("sma", () => {
  it("returns correct simple moving average", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = sma(data, 3);
    assert.equal(result[0], null);
    assert.equal(result[1], null);
    assert.equal(result[2], 2);   // (1+2+3)/3
    assert.equal(result[3], 3);   // (2+3+4)/3
    assert.equal(result[9], 9);   // (8+9+10)/3
  });

  it("handles single-element period", () => {
    const data = [5, 10, 15];
    const result = sma(data, 1);
    assert.deepEqual(result, [5, 10, 15]);
  });

  it("returns all null for period > data length", () => {
    const result = sma([1, 2], 5);
    assert.equal(result[0], null);
    assert.equal(result[1], null);
  });
});

describe("ema", () => {
  it("first value equals first data point", () => {
    const data = [10, 11, 12, 13, 14];
    const result = ema(data, 3);
    assert.equal(result[0], 10);
  });

  it("converges toward data in uptrend", () => {
    const data = [10, 12, 14, 16, 18, 20];
    const result = ema(data, 3);
    // EMA should be rising but lagging behind price
    for (let i = 1; i < result.length; i++) {
      assert.ok(result[i] > result[i - 1], `EMA should rise at index ${i}`);
      assert.ok(result[i] <= data[i], `EMA should lag price at index ${i}`);
    }
  });

  it("returns empty for empty input", () => {
    assert.deepEqual(ema([], 5), []);
  });
});

describe("rsiSeries", () => {
  it("returns 50 for insufficient data", () => {
    const result = rsiSeries([100, 101, 102], 14);
    assert.equal(result[0], 50);
    assert.equal(result[2], 50);
  });

  it("returns high RSI for consistent uptrend", () => {
    // 20 consecutive up-closes
    const data = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = rsiSeries(data, 14);
    const lastRsi = result[result.length - 1];
    assert.ok(lastRsi > 80, `Expected RSI > 80 for pure uptrend, got ${lastRsi}`);
  });

  it("returns low RSI for consistent downtrend", () => {
    const data = Array.from({ length: 20 }, (_, i) => 100 - i);
    const result = rsiSeries(data, 14);
    const lastRsi = result[result.length - 1];
    assert.ok(lastRsi < 20, `Expected RSI < 20 for pure downtrend, got ${lastRsi}`);
  });

  it("RSI stays between 0 and 100", () => {
    const data = [100, 105, 95, 110, 90, 115, 85, 120, 80, 125, 75, 130, 70, 135, 65, 140];
    const result = rsiSeries(data, 14);
    for (const val of result) {
      assert.ok(val >= 0 && val <= 100, `RSI out of range: ${val}`);
    }
  });
});

describe("atr", () => {
  it("returns positive value for any price data", () => {
    const highs  = [105, 110, 108, 112, 107, 115, 109, 113, 111, 116, 108, 114, 110, 117, 112];
    const lows   = [100, 104, 102, 106, 101, 108, 103, 107, 105, 110, 102, 108, 104, 111, 106];
    const closes = [103, 108, 105, 110, 104, 112, 106, 110, 108, 113, 105, 111, 107, 114, 109];
    const result = atr(highs, lows, closes, 14);
    assert.ok(result > 0, `ATR should be positive, got ${result}`);
  });

  it("ATR is higher for volatile data", () => {
    const stable = { h: [101,102,101,102,101], l: [99,98,99,98,99], c: [100,100,100,100,100] };
    const wild   = { h: [120,130,120,130,120], l: [80,70,80,70,80], c: [100,100,100,100,100] };
    const atrStable = atr(stable.h, stable.l, stable.c, 3);
    const atrWild   = atr(wild.h, wild.l, wild.c, 3);
    assert.ok(atrWild > atrStable, `Volatile ATR (${atrWild}) should exceed stable ATR (${atrStable})`);
  });
});

describe("bollingerBands", () => {
  it("middle band equals SMA", () => {
    const data = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5);
    const bb = bollingerBands(data, 20, 2);
    const smaVals = sma(data, 20);
    for (let i = 19; i < data.length; i++) {
      assert.ok(
        Math.abs(bb.middle[i] - smaVals[i]) < 0.001,
        `Middle band should equal SMA at index ${i}`
      );
    }
  });

  it("upper > middle > lower always", () => {
    const data = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5 + Math.random() * 3);
    const bb = bollingerBands(data, 20, 2);
    for (let i = 19; i < data.length; i++) {
      assert.ok(bb.upper[i] > bb.middle[i], `Upper > middle at ${i}`);
      assert.ok(bb.middle[i] > bb.lower[i], `Middle > lower at ${i}`);
    }
  });

  it("pctB is between 0 and 1 when price is within bands", () => {
    const data = [100, 101, 99, 100, 102, 98, 101, 100, 99, 101,
                  100, 102, 98, 100, 101, 99, 100, 102, 98, 100, 101];
    const bb = bollingerBands(data, 20, 2);
    const lastPctB = bb.pctB[bb.pctB.length - 1];
    assert.ok(lastPctB >= -0.5 && lastPctB <= 1.5, `%B should be near 0-1, got ${lastPctB}`);
  });
});

describe("adx", () => {
  it("returns trending=true for strong directional move", () => {
    const n = 40;
    const highs  = Array.from({ length: n }, (_, i) => 100 + i * 2 + 1);
    const lows   = Array.from({ length: n }, (_, i) => 100 + i * 2 - 1);
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 2);
    const result = adx(highs, lows, closes, 14);
    assert.ok(result.adx > 20, `ADX should indicate trend, got ${result.adx}`);
    assert.ok(result.pdi > result.mdi, `+DI should exceed -DI in uptrend`);
  });

  it("returns low ADX for flat range", () => {
    const n = 40;
    const closes = Array.from({ length: n }, () => 100 + (Math.random() - 0.5) * 0.5);
    const highs  = closes.map(c => c + 0.3);
    const lows   = closes.map(c => c - 0.3);
    const result = adx(highs, lows, closes, 14);
    assert.ok(result.adx < 30, `ADX should be low for range, got ${result.adx}`);
  });
});

// ---------------------------------------------------------------------------
// EXECUTION TESTS
// ---------------------------------------------------------------------------
import { portfolioValue } from "../bot/execution.js";

describe("portfolioValue", () => {
  it("returns cash when no positions", () => {
    const state = { cash: 10000, positions: {} };
    assert.equal(portfolioValue(state), 10000);
  });

  it("includes reserved margin in portfolio value", () => {
    const state = {
      cash: 8000,
      positions: {
        "BTC-USDT-SWAP": {
          symbol: "BTC-USDT-SWAP",
          direction: "long",
          entryPrice: 50000,
          size: 0.01,
          notional: 200
        }
      }
    };
    // Without live prices: unrealizedPnl = 0, value = cash + reserved
    assert.equal(portfolioValue(state), 8200);
  });

  it("calculates unrealized PnL with live prices", () => {
    const state = {
      cash: 8000,
      positions: {
        "BTC-USDT-SWAP": {
          symbol: "BTC-USDT-SWAP",
          direction: "long",
          entryPrice: 50000,
          size: 0.01,
          notional: 200
        }
      }
    };
    const livePrices = { "BTC-USDT-SWAP": 55000 };
    // unrealized = (55000 - 50000) * 0.01 = 50
    // value = 8000 + 200 + 50 = 8250
    assert.equal(portfolioValue(state, livePrices), 8250);
  });

  it("clamps unrealized loss to -notional", () => {
    const state = {
      cash: 8000,
      positions: {
        "BTC-USDT-SWAP": {
          symbol: "BTC-USDT-SWAP",
          direction: "long",
          entryPrice: 50000,
          size: 0.01,
          notional: 200
        }
      }
    };
    // Price crashes: rawPnl = (10000 - 50000) * 0.01 = -400, clamped to -200
    const livePrices = { "BTC-USDT-SWAP": 10000 };
    assert.equal(portfolioValue(state, livePrices), 8000); // 8000 + 200 + (-200)
  });
});

// ---------------------------------------------------------------------------
// FRICTION MODEL TESTS
// ---------------------------------------------------------------------------
import {
  estimateSlippage,
  applyEntryFriction,
  applyExitFriction,
  estimateFundingCost,
  applyRoundTripFriction
} from "../bot/friction.js";

describe("friction model", () => {
  it("slippage is positive", () => {
    const slip = estimateSlippage(100, 500);
    assert.ok(slip > 0, `Slippage should be positive, got ${slip}`);
  });

  it("BTC gets less slippage than unknown altcoin", () => {
    const btcSlip = estimateSlippage(100, 500, "BTC-USDT-SWAP");
    const altSlip = estimateSlippage(100, 500, "MEME-USDT-SWAP");
    assert.ok(btcSlip < altSlip, `BTC slip (${btcSlip}) should be less than alt slip (${altSlip})`);
  });

  it("entry friction worsens fill price for longs", () => {
    const result = applyEntryFriction(100, "long", 500);
    assert.ok(result.adjustedPrice > 100, `Long entry should fill higher`);
    assert.ok(result.feeCost > 0, `Fee should be positive`);
  });

  it("entry friction worsens fill price for shorts", () => {
    const result = applyEntryFriction(100, "short", 500);
    assert.ok(result.adjustedPrice < 100, `Short entry should fill lower`);
  });

  it("funding cost is positive for longs with positive rate", () => {
    const cost = estimateFundingCost(24, 1000, "long", 0.0001);
    assert.ok(cost > 0, `Longs should pay positive funding`);
    assert.equal(cost, 3 * 1000 * 0.0001); // 3 settlements in 24h
  });

  it("funding cost is negative (income) for shorts with positive rate", () => {
    const cost = estimateFundingCost(24, 1000, "short", 0.0001);
    assert.ok(cost < 0, `Shorts should receive positive funding`);
  });

  it("round-trip friction reduces PnL", () => {
    const result = applyRoundTripFriction({
      entryPrice: 100, exitPrice: 105, direction: "long",
      size: 10, notional: 1000, pnl: 50, hoursHeld: 24
    });
    assert.ok(result.adjustedPnl < result.rawPnl, `Adjusted PnL should be less than raw`);
    assert.ok(result.friction.total > 0, `Total friction should be positive`);
  });
});

// ---------------------------------------------------------------------------
// SCORING SANITY TESTS
// ---------------------------------------------------------------------------
import { autoApproveSignal, fundingRateSignal } from "../bot/scoring.js";

describe("fundingRateSignal", () => {
  it("extreme positive rate signals short", () => {
    const result = fundingRateSignal(0.005);
    assert.equal(result.signal, "short");
    assert.equal(result.score, 2);
  });

  it("extreme negative rate signals long", () => {
    const result = fundingRateSignal(-0.005);
    assert.equal(result.signal, "long");
    assert.equal(result.score, 2);
  });

  it("near-zero rate is neutral", () => {
    const result = fundingRateSignal(0.0001);
    assert.equal(result.signal, "neutral");
    assert.equal(result.score, 0);
  });

  it("null/undefined rate is neutral", () => {
    assert.equal(fundingRateSignal(null).signal, "neutral");
    assert.equal(fundingRateSignal(undefined).signal, "neutral");
  });
});

describe("autoApproveSignal", () => {
  it("rejects candidate with zero confidence signals", () => {
    const candidate = {
      signal: "long", obvDiv: "bearish", fisherVal: -2,
      price: 100, vwapVal: 110, adxResult: { trending: false, pdi: 10, mdi: 20 },
      h4Trend: "bearish", setupType: "trend", reasons: []
    };
    assert.equal(autoApproveSignal(candidate), false);
  });

  it("approves strong confluence long", () => {
    const candidate = {
      signal: "long", obvDiv: "bullish", fisherVal: 0.5,
      price: 110, vwapVal: 100, adxResult: { trending: true, pdi: 30, mdi: 10 },
      h4Trend: "bullish", setupType: "trend", reasons: []
    };
    assert.equal(autoApproveSignal(candidate), true);
  });
});
