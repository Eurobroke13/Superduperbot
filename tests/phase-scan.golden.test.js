/**
 * Golden-master harness for phaseScan.
 *
 * All network/IO seams are injected via deps so no real OKX/DB/Claude calls
 * are made. The test pins the scanSummary shape and key counters that
 * represent phaseScan's observable output — enabling safe structural
 * refactoring one extract at a time.
 *
 * Architecture note: phaseScan is invoked by importing runBot's deps path.
 * We access it via the runner.js module which exports the pure helpers; the
 * function itself is internal, so we drive it through a thin state machine:
 * set state.lastPhase=1, call runBot with fully mocked deps, then inspect
 * state.lastScanSummary.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:1/test";

const { runBot } = await import("../bot/runner.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeTicker(contract, vol = 2_000_000, last = 100, open24h = 95) {
  return { contract, volume_24h_quote: String(vol), last: String(last), open24h: String(open24h) };
}

function makeCandle(close, high, low, open, volume) {
  return { close, high, low, open, volume };
}

// Minimal candle set: 50 candles with a gentle uptrend so regime → bull.
// close > open (green candles) so the 15m bull trend gate reaches confidence >= 2.0.
function makeBullCandles(n = 60) {
  return Array.from({ length: n }, (_, i) => ({
    close:  100 + i * 0.1,
    high:   101 + i * 0.1,
    low:    99  + i * 0.1,
    open:   99.9 + i * 0.1,
    volume: 1000
  }));
}

// A minimal "scored" candidate object.
function makeCandidate(symbol, signal = "long", score = 5.5) {
  return {
    symbol, signal, score,
    setupType: "trend-following",
    reasons: ["ema-ribbon-bull"],
    price: 100,
    stopLoss: 95,
    takeProfit: 110,
    atrVal: 2,
    atrPct: 0.02,
    h4Trend: "bullish",
    obvDiv: "none",
    _candles1h: makeBullCandles(50),
    _srLevels: { supports: [], resistances: [] }
  };
}

// Minimal bot state that passes all early gates.
function makeState(overrides = {}) {
  return {
    cash: 10000,
    positions: {},
    pendingLimits: {},
    decayingLimits: {},
    newsBlocked: [],
    newsBoosted: [],
    trades: [],
    _pendingTrades: [],
    lastPhase: 0,
    lastRegime: { label: "bull", strength: 0.7, refreshedAt: new Date().toISOString() },
    lastScanSummary: null,
    runCount: 0,
    tokenUsage: { input: 0, output: 0 },
    ...overrides
  };
}

// Minimal env object (not used by the mocked seams, but required by runBot).
const ENV = { TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: "" };

// Build a complete deps object for runBot. Every IO seam is mocked.
function makeDeps(overrides = {}) {
  const {
    tickers     = [makeTicker("BTC-USDT-SWAP"), makeTicker("ETH-USDT-SWAP")],
    contracts   = ["BTC-USDT-SWAP", "ETH-USDT-SWAP"],
    scored      = [makeCandidate("BTC-USDT-SWAP")],
    lunarData   = {},
    fundingRate = 0.001,
    todayTrades = [],
    apiHealth   = { tripped: false, consecutiveFailures: 0 },
    timeFilter  = { shouldAvoidEntry: false, scoreAdjustment: 0, utcHour: 10, utcMin: 0 }
  } = overrides;

  return {
    // runBot-level deps
    loadState:            async () => makeState(),
    saveState:            async () => {},
    printPortfolioSummary: () => {},

    // phaseScan pass-through deps
    claudeBatchAnalysis:   async () => ({ validations: {}, newsBlocked: [], newsBoosted: [] }),
    getAdaptiveThreshold:  () => 4,
    getWeight:             (name) => ({ "lunar-bull": 0.7, "lunar-bear": 0.7, "lunar-sentiment-warning": -1.0, "news-boost": 0.8 }[name] ?? 0),
    notifyTrade:           async () => {},
    sendTelegram:          async () => {},
    sleep:                 async () => {},

    // IO seams
    _fetchAllTickers:    async () => tickers,
    _fetchAllContracts:  async () => contracts,
    _fetchCandles:       async () => makeBullCandles(60),
    _fetchFundingRate:   async () => fundingRate,
    _fetchLunarCrush:    async () => lunarData,
    _loadTodayTrades:    async () => todayTrades,
    _scoreSymbol:        async (symbol) => scored.find(c => c.symbol === symbol) ?? null,
    _getApiHealth:       () => apiHealth,
    _getTimeFilter:      () => timeFilter,
    _stageCandidateEntry: async () => false,  // no actual entry in golden master
    ...overrides.depOverrides
  };
}

// ── Golden-master tests ─────────────────────────────────────────────────────

test("phaseScan golden - produces lastScanSummary with required shape", async () => {
  const state = makeState();
  const deps = makeDeps({ depOverrides: { loadState: async () => state } });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  assert.ok(s, "lastScanSummary must be set");
  assert.equal(typeof s.ranAt, "string");
  assert.equal(typeof s.candidatesScored, "number");
  assert.equal(typeof s.candidatesQualified, "number");
  assert.equal(typeof s.openedCount, "number");
  assert.equal(typeof s.blockedByReason, "object");
  assert.equal(typeof s.openedBySetup, "object");
  assert.equal(typeof s.skippedByReason, "object");
  assert.equal(typeof s.regime, "string");
});

test("phaseScan golden - regime label is passed through", async () => {
  const state = makeState({ lastRegime: { label: "sideways", strength: 0.5, refreshedAt: new Date().toISOString() } });
  const deps = makeDeps({ depOverrides: { loadState: async () => state } });
  await runBot(ENV, deps);
  assert.equal(state.lastScanSummary?.regime, "sideways");
});

test("phaseScan golden - api circuit-open skips scoring and sets skippedByReason", async () => {
  const state = makeState();
  const deps = makeDeps({
    apiHealth: { tripped: true, consecutiveFailures: 5 },
    depOverrides: { loadState: async () => state }
  });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  assert.ok(s, "summary set even on circuit-open");
  assert.equal(s.candidatesScored, 0);
  assert.ok(s.skippedByReason["api-circuit-open"] >= 1);
});

test("phaseScan golden - funding-settlement window skips scoring", async () => {
  const state = makeState();
  const deps = makeDeps({
    timeFilter: { shouldAvoidEntry: true, scoreAdjustment: 0, utcHour: 0, utcMin: 5 },
    depOverrides: { loadState: async () => state }
  });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  assert.ok(s?.skippedByReason["funding-settlement-window"] >= 1);
});

test("phaseScan golden - no contracts returns without crash", async () => {
  const state = makeState();
  const deps = makeDeps({
    contracts: [],
    depOverrides: { loadState: async () => state }
  });
  await runBot(ENV, deps);
  // No summary set when contracts are empty (function returns early).
  // Just verify no throw.
});

test("phaseScan golden - zero scored candidates sets candidatesScored=0", async () => {
  const state = makeState();
  const deps = makeDeps({
    scored: [],
    depOverrides: { loadState: async () => state }
  });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  if (s) assert.equal(s.candidatesScored, 0);
});

test("phaseScan golden - below-threshold candidate appears in skippedByReason or rejectedByReason", async () => {
  const state = makeState();
  const lowScore = { ...makeCandidate("BTC-USDT-SWAP"), score: 1.0 };
  const deps = makeDeps({
    scored: [lowScore],
    depOverrides: {
      loadState: async () => state,
      getAdaptiveThreshold: () => 4
    }
  });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  if (!s) return; // early return guard
  const totalRejected = Object.values(s.rejectedByReason).reduce((a, b) => a + b, 0);
  const totalSkipped  = Object.values(s.skippedByReason).reduce((a, b) => a + b, 0);
  assert.ok(totalRejected + totalSkipped >= 1, "low-score candidate must be tracked");
});

test("phaseScan golden - mid-run drawdown halt restricts to high-conviction when PnL is -4.1%", async () => {
  // checkMidRunDrawdown reads state.trades (already-committed) not _pendingTrades.
  // The default candidate scores 5.5 (< 6 override), so nothing opens — but the
  // halt now records in blockedByReason and continues scanning rather than bailing.
  const state = makeState({
    trades: [{ pnl: -410, closedAt: new Date().toISOString() }],
    cash: 10000,
    positions: {}
  });
  const deps = makeDeps({ depOverrides: { loadState: async () => state } });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  assert.ok(s?.blockedByReason?.["mid-run-drawdown-halt"] >= 1, "halt must be recorded");
  assert.equal(s?.openedCount || 0, 0, "marginal (score<6) candidate must not open on a halt day");
});

test("phaseScan golden - high-conviction candidate (score 6.5) bypasses the halt", async () => {
  const state = makeState({
    trades: [{ pnl: -410, closedAt: new Date().toISOString() }],
    cash: 10000,
    positions: {}
  });
  const deps = makeDeps({
    scored: [makeCandidate("BTC-USDT-SWAP", "long", 6.5)],
    depOverrides: { loadState: async () => state }
  });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  assert.ok(s?.blockedByReason?.["mid-run-drawdown-halt"] >= 1, "halt must still be recorded");
  assert.ok((s?.candidatesQualified || 0) >= 1, "score>=6 candidate must qualify even on a halt day");
});

test("phaseScan golden - momentum setups are blocked (edge-recovery)", async () => {
  const state = makeState();
  const mom = { ...makeCandidate("MOM-USDT-SWAP"), setupType: "momentum", score: 7 };
  const deps = makeDeps({
    tickers: [makeTicker("MOM-USDT-SWAP")],
    contracts: ["MOM-USDT-SWAP"],
    scored: [mom],
    depOverrides: { loadState: async () => state }
  });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  assert.ok(s?.blockedByReason?.["momentum-disabled"] >= 1, "momentum must be blocked");
  assert.equal(s?.candidatesQualified || 0, 0, "momentum must not qualify");
});

test("phaseScan golden - non-bear trend shorts are blocked (edge-recovery)", async () => {
  const state = makeState(); // default regime is bull
  const sht = { ...makeCandidate("SHT-USDT-SWAP", "short"), setupType: "trend", h4Trend: "bearish", score: 7 };
  const deps = makeDeps({
    tickers: [makeTicker("SHT-USDT-SWAP")],
    contracts: ["SHT-USDT-SWAP"],
    scored: [sht],
    depOverrides: { loadState: async () => state }
  });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  assert.ok(s?.blockedByReason?.["shorts-bear-only"] >= 1, "trend short outside bear must be blocked");
});

test("phaseScan golden - non-MR setups below Claude threshold are blocked (MR-primary)", async () => {
  const state = makeState(); // bull, no regimeStats → MR_PRIMARY_THRESHOLD = 5.0
  const trd = { ...makeCandidate("TRD-USDT-SWAP", "long", 4.5), setupType: "trend" };
  const deps = makeDeps({
    tickers: [makeTicker("TRD-USDT-SWAP")],
    contracts: ["TRD-USDT-SWAP"],
    scored: [trd],
    depOverrides: { loadState: async () => state }
  });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  assert.ok(s?.blockedByReason?.["mr-primary-mode"] >= 1, "non-MR below MR_PRIMARY_THRESHOLD must be blocked");
  assert.equal(s?.candidatesQualified || 0, 0, "blocked non-MR must not qualify");
});

test("phaseScan golden - high-conviction non-MR setups pass the MR-primary gate", async () => {
  const state = makeState(); // claudeThreshold = 6
  const trd = { ...makeCandidate("TRD2-USDT-SWAP", "long", 6.5), setupType: "trend" };
  const deps = makeDeps({
    tickers: [makeTicker("TRD2-USDT-SWAP")],
    contracts: ["TRD2-USDT-SWAP"],
    scored: [trd],
    depOverrides: { loadState: async () => state }
  });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  assert.ok((s?.candidatesQualified || 0) >= 1, "score>=claudeThreshold non-MR must still qualify (routes to Claude)");
  assert.ok(!(s?.blockedByReason?.["mr-primary-mode"] >= 1), "must not be MR-primary-blocked");
});

test("phaseScan golden - all-slots-full guard skips scan", async () => {
  const positions = {};
  for (let i = 0; i < 10; i++) positions[`COIN${i}-USDT-SWAP`] = { size: 1, notional: 1000 };
  const state = makeState({ positions });
  const deps = makeDeps({ depOverrides: { loadState: async () => state } });
  await runBot(ENV, deps);

  const s = state.lastScanSummary;
  // phaseScan returns before setting summary when slotsAvailable <= 0
  // (matches existing inline guard). Either null or openedCount=0.
  if (s) assert.equal(s.openedCount, 0);
});

test("phaseScan golden - no regime skips the scan silently", async () => {
  // _phaseRegimeAndExits is a no-op seam so the test doesn't hit real OKX APIs.
  // With no lastRegime set, phaseScan should return early without setting lastScanSummary.
  const state = makeState({ lastRegime: null });
  const deps = makeDeps({ depOverrides: {
    loadState: async () => state,
    _phaseRegimeAndExits: async () => {} // leaves state.lastRegime = null
  } });
  await runBot(ENV, deps);
  // No summary, no crash.
  assert.equal(state.lastScanSummary, null);
});

test("phaseScan golden - scoreSymbol called once per symbol in batch", async () => {
  // Full scan (0, 1.0): all 4 symbols should be scored exactly once.
  const called = [];
  const state = makeState();
  const symbols = ["A-USDT-SWAP", "B-USDT-SWAP", "C-USDT-SWAP", "D-USDT-SWAP"];
  const deps = makeDeps({
    contracts: symbols,
    tickers: symbols.map(s => makeTicker(s, 2_000_000)),
    depOverrides: {
      loadState: async () => state,
      _scoreSymbol: async (sym) => { called.push(sym); return null; }
    }
  });
  await runBot(ENV, deps);
  // All 4 symbols scored (full pass, no half-window).
  assert.equal(called.length, 4, "scored full list");
  // Each symbol scored at most once (no duplicate calls).
  assert.equal(new Set(called).size, called.length, "no duplicate scoring");
});
