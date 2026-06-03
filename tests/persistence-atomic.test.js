/**
 * Tests for atomic state + trades persistence (state-store.saveState).
 *
 * Verifies the transactional contract that prevents phantom positions:
 *   - no pending trades  -> single blob upsert, no transaction
 *   - pending trades     -> BEGIN, one insert per trade, blob upsert, COMMIT
 *   - buffer cleared only AFTER a successful commit
 *   - transaction failure -> buffer retained, blob NOT committed
 *   - buildTradeInsert is a pure 26-parameter builder
 *
 * Uses an injected mock db layer so no real Postgres is needed.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";
const { saveState } = await import("../state-store.js");
const { buildTradeInsert } = await import("../trade-store.js");

function trade(pnl, symbol = "TEST-USDT-SWAP") {
  return {
    symbol, direction: "long", entryPrice: 100, exitPrice: 110,
    size: 1, pnl, reason: "tp", closedAt: new Date().toISOString()
  };
}

// Mock db layer: records the call sequence so we can assert ordering.
function makeMockDb({ failOnUpsert = false, failOnInsert = false } = {}) {
  const calls = [];
  const client = {
    query: async (text) => {
      const op = /^BEGIN/.test(text) ? "BEGIN"
        : /^COMMIT/.test(text) ? "COMMIT"
        : /^ROLLBACK/.test(text) ? "ROLLBACK"
        : /INSERT INTO bot_state/.test(text) ? "UPSERT"
        : "OTHER";
      calls.push(op);
      if (op === "UPSERT" && failOnUpsert) throw new Error("upsert failed");
      return { rows: [] };
    }
  };
  const deps = {
    ensureSchema: async () => {},
    query: async (text) => {
      calls.push(/INSERT INTO bot_state/.test(text) ? "UPSERT-DIRECT" : "QUERY");
      return { rows: [] };
    },
    runTransaction: async (fn) => {
      calls.push("BEGIN");
      try {
        const r = await fn(client);
        calls.push("COMMIT");
        return r;
      } catch (err) {
        calls.push("ROLLBACK");
        throw err;
      }
    },
    insertTradeTx: async (_client, t) => {
      calls.push(`INSERT:${t.symbol}:${t.pnl}`);
      if (failOnInsert) throw new Error("insert failed");
      return 1;
    }
  };
  return { deps, calls };
}

test("saveState - no pending trades: direct upsert, no transaction", async () => {
  const { deps, calls } = makeMockDb();
  const state = { cash: 100, positions: {} };
  await saveState(state, deps);
  assert.deepEqual(calls, ["UPSERT-DIRECT"]);
});

test("saveState - pending trades: BEGIN, inserts, upsert, COMMIT in order", async () => {
  const { deps, calls } = makeMockDb();
  const state = {
    cash: 100, positions: {},
    _pendingTrades: [trade(50, "A"), trade(-20, "B")]
  };
  await saveState(state, deps);
  assert.deepEqual(calls, [
    "BEGIN",
    "INSERT:A:50",
    "INSERT:B:-20",
    "UPSERT",
    "COMMIT"
  ]);
});

test("saveState - clears the buffer only after successful commit", async () => {
  const { deps } = makeMockDb();
  const state = { cash: 100, positions: {}, _pendingTrades: [trade(10)] };
  await saveState(state, deps);
  assert.deepEqual(state._pendingTrades, [], "buffer should be empty after commit");
});

test("saveState - transaction failure retains buffer and does not commit", async () => {
  const { deps, calls } = makeMockDb({ failOnUpsert: true });
  const pending = [trade(10), trade(20)];
  const state = { cash: 100, positions: {}, _pendingTrades: pending };
  await assert.rejects(() => saveState(state, deps), /upsert failed/);
  // Buffer must be intact for retry on the next run
  assert.equal(state._pendingTrades.length, 2);
  assert.ok(calls.includes("ROLLBACK"), "should have rolled back");
  assert.ok(!calls.includes("COMMIT"), "must not commit on failure");
});

test("saveState - insert failure rolls back before the blob upsert", async () => {
  const { deps, calls } = makeMockDb({ failOnInsert: true });
  const state = { cash: 100, positions: {}, _pendingTrades: [trade(10)] };
  await assert.rejects(() => saveState(state, deps), /insert failed/);
  assert.ok(calls.includes("ROLLBACK"));
  assert.ok(!calls.includes("UPSERT"), "blob must not be upserted if a trade insert fails");
  assert.equal(state._pendingTrades.length, 1, "buffer retained");
});

test("saveState - strips trades/decisionLog/_pendingTrades from the blob", async () => {
  let capturedBlob = null;
  const deps = {
    ensureSchema: async () => {},
    query: async (_text, values) => { capturedBlob = JSON.parse(values[1]); return { rows: [] }; },
    runTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    insertTradeTx: async () => 1
  };
  const state = {
    cash: 100, positions: {},
    trades: [trade(1)], decisionLog: [{ x: 1 }], _pendingTrades: []
  };
  await saveState(state, deps);
  assert.equal(capturedBlob.trades, undefined);
  assert.equal(capturedBlob.decisionLog, undefined);
  assert.equal(capturedBlob._pendingTrades, undefined);
  assert.equal(capturedBlob.cash, 100);
});

test("buildTradeInsert - produces 26 positional values and a RETURNING clause", () => {
  const { text, values } = buildTradeInsert(trade(42));
  assert.equal(values.length, 26);
  assert.match(text, /INSERT INTO trades/);
  assert.match(text, /RETURNING id/);
  assert.match(text, /\$26/);
});

test("buildTradeInsert - applies sensible defaults for missing fields", () => {
  const { values } = buildTradeInsert({ symbol: "X", direction: "long", entryPrice: 1, exitPrice: 2, size: 1, pnl: 0 });
  // setup_type (index 10) and approval_type (index 11) default to "unknown"
  assert.equal(values[10], "unknown");
  assert.equal(values[11], "unknown");
  // regime (index 19) defaults to "unknown"
  assert.equal(values[19], "unknown");
});
