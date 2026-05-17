// =============================================================================
// bot/exchange.js - OKX Live Order Execution Layer
//
// This file is the ONLY place that touches real money.
// Everything else in the bot is unchanged - paper trading continues to work
// exactly as before when LIVE_MODE is false or missing.
//
// HOW IT WORKS:
//   LIVE_MODE=false (default) -> all functions are no-ops, returns paper values
//   LIVE_MODE=true            -> real orders sent to OKX perpetual swap API
//
// DEPLOYMENT SEQUENCE (do not skip steps):
//   1. Add env vars to Railway (OKX_API_KEY, OKX_SECRET, OKX_PASSPHRASE)
//   2. Keep LIVE_MODE unset or false
//   3. Run reconcilePositions() to verify API connectivity
//   4. Set LIVE_MODE=true with tiny position sizes (LIVE_RISK_PCT=0.001)
//   5. Monitor one full trade cycle before increasing size
// =============================================================================

import crypto from "crypto";

const OKX_BASE = "https://www.okx.com";
const LIVE_MODE = process.env.LIVE_MODE === "true";
const API_KEY = process.env.OKX_API_KEY || "";
const API_SECRET = process.env.OKX_SECRET || "";
const PASSPHRASE = process.env.OKX_PASSPHRASE || "";

// Position mode - "net" (one-way) is simpler and recommended to start.
// Switch to "hedge" only after confirming one-way works end-to-end.
const POS_MODE = process.env.OKX_POS_MODE || "net";

// Risk override for live - start tiny, e.g. 0.001 = 0.1% of capital per trade.
const LIVE_RISK_PCT = parseFloat(process.env.LIVE_RISK_PCT || "0.002");

// In-memory contract spec cache (ctVal = contract size in base currency).
const contractCache = new Map();

// =============================================================================
// SIGNING - OKX HMAC-SHA256
// =============================================================================
function sign(timestamp, method, path, body = "") {
  const message = timestamp + method.toUpperCase() + path + body;
  return crypto
    .createHmac("sha256", API_SECRET)
    .update(message)
    .digest("base64");
}

function authHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": API_KEY,
    "OK-ACCESS-SIGN": sign(timestamp, method, path, body),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": PASSPHRASE,
    "x-simulated-trading": "0" // set to "1" for OKX paper trading env
  };
}

// =============================================================================
// HTTP HELPERS
// =============================================================================
async function okxGet(path) {
  const res = await fetch(OKX_BASE + path, {
    method: "GET",
    headers: authHeaders("GET", path)
  });
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX GET ${path}: ${data.msg} (${data.code})`);
  return data.data;
}

async function okxPost(path, body) {
  const bodyStr = JSON.stringify(body);
  const res = await fetch(OKX_BASE + path, {
    method: "POST",
    headers: authHeaders("POST", path, bodyStr),
    body: bodyStr
  });
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX POST ${path}: ${data.msg} (${data.code})`);
  return data.data;
}

// =============================================================================
// CONTRACT SPECS - fetch ctVal (contract size) once per symbol per session
// ctVal: how much base currency 1 contract represents
// e.g. BTC-USDT-SWAP: ctVal=0.01 -> 1 contract = 0.01 BTC
// =============================================================================
async function getContractSpec(instId) {
  if (contractCache.has(instId)) return contractCache.get(instId);

  const data = await okxGet(`/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
  if (!data?.[0]) throw new Error(`No contract spec for ${instId}`);

  const spec = {
    instId,
    ctVal: parseFloat(data[0].ctVal),
    tickSz: parseFloat(data[0].tickSz),
    lotSz: parseFloat(data[0].lotSz),
    minSz: parseFloat(data[0].minSz),
    maxLever: parseFloat(data[0].lever || "10")
  };
  contractCache.set(instId, spec);
  return spec;
}

// =============================================================================
// SIZE CALCULATION
// Convert USDT notional to number of contracts, rounded to lotSz.
// =============================================================================
async function calcContractSize(instId, notional, price) {
  const spec = await getContractSpec(instId);
  const rawSize = notional / (price * spec.ctVal);
  const rounded = Math.floor(rawSize / spec.lotSz) * spec.lotSz;
  return Math.max(spec.minSz, parseFloat(rounded.toFixed(8)));
}

async function roundPrice(instId, price) {
  const spec = await getContractSpec(instId);
  const ticks = Math.round(price / spec.tickSz);
  return parseFloat((ticks * spec.tickSz).toFixed(8));
}

// =============================================================================
// ACCOUNT - balance and positions
// =============================================================================
export async function getLiveBalance() {
  if (!LIVE_MODE) return null;
  const data = await okxGet("/api/v5/account/balance?ccy=USDT");
  const usdt = data?.[0]?.details?.find((detail) => detail.ccy === "USDT");
  return usdt ? parseFloat(usdt.availBal) : 0;
}

export async function getLivePositions() {
  if (!LIVE_MODE) return [];
  const data = await okxGet("/api/v5/account/positions?instType=SWAP");
  return (data || [])
    .filter((position) => parseFloat(position.pos) !== 0)
    .map((position) => ({
      instId: position.instId,
      direction: parseFloat(position.pos) > 0 ? "long" : "short",
      size: Math.abs(parseFloat(position.pos)),
      entryPrice: parseFloat(position.avgPx),
      unrealPnl: parseFloat(position.upl),
      margin: parseFloat(position.margin || 0)
    }));
}

// =============================================================================
// PLACE ORDER
// =============================================================================
export async function placeOrder({ instId, direction, notional, price, sl, tp, tag = "t1" }) {
  if (!LIVE_MODE) {
    console.log(`[EXCHANGE] PAPER: would open ${direction} ${instId} notional=$${notional.toFixed(2)}`);
    return { ordId: `paper-${Date.now()}`, clOrdId: null, sz: 0, paper: true };
  }

  if (!API_KEY || !API_SECRET || !PASSPHRASE) {
    throw new Error("[EXCHANGE] OKX credentials not set. Cannot place live order.");
  }

  const sz = await calcContractSize(instId, notional, price);
  const slRounded = await roundPrice(instId, sl);
  const tpRounded = await roundPrice(instId, tp);
  const clOrdId = `sdb-${tag}-${Date.now()}`;

  const side = direction === "long" ? "buy" : "sell";
  const posSide = POS_MODE === "hedge" ? direction : undefined;

  const body = {
    instId,
    tdMode: "cross",
    side,
    ordType: "market",
    sz: String(sz),
    clOrdId,
    ...(posSide && { posSide }),
    attachAlgoOrds: [{
      attachAlgoClOrdId: `algo-${clOrdId}`,
      tpTriggerPx: String(tpRounded),
      tpOrdPx: "-1",
      slTriggerPx: String(slRounded),
      slOrdPx: "-1",
      tpTriggerPxType: "last",
      slTriggerPxType: "last"
    }]
  };

  const result = await okxPost("/api/v5/trade/order", body);
  const order = result?.[0];
  if (!order || order.sCode !== "0") {
    throw new Error(`[EXCHANGE] Order failed: ${order?.sMsg || "unknown"} (${order?.sCode})`);
  }

  console.log(`[EXCHANGE] LIVE ${direction.toUpperCase()} ${instId} sz=${sz} ordId=${order.ordId}`);
  return { ordId: order.ordId, clOrdId, sz };
}

// =============================================================================
// CLOSE POSITION (market)
// =============================================================================
export async function closePosition({ instId, direction, sz, reason = "exit" }) {
  if (!LIVE_MODE) {
    console.log(`[EXCHANGE] PAPER: would close ${direction} ${instId} sz=${sz} reason=${reason}`);
    return { ordId: `paper-close-${Date.now()}`, paper: true };
  }

  const side = direction === "long" ? "sell" : "buy";
  const posSide = POS_MODE === "hedge" ? direction : undefined;
  const clOrdId = `close-${reason}-${Date.now()}`;

  const body = {
    instId,
    tdMode: "cross",
    side,
    ordType: "market",
    sz: String(sz),
    clOrdId,
    reduceOnly: "true",
    ...(posSide && { posSide })
  };

  const result = await okxPost("/api/v5/trade/order", body);
  const order = result?.[0];
  if (!order || order.sCode !== "0") {
    throw new Error(`[EXCHANGE] Close failed: ${order?.sMsg || "unknown"}`);
  }

  console.log(`[EXCHANGE] CLOSED ${direction.toUpperCase()} ${instId} sz=${sz} reason=${reason} ordId=${order.ordId}`);
  return { ordId: order.ordId, clOrdId };
}

// =============================================================================
// CANCEL ALGO ORDER (SL/TP)
// =============================================================================
export async function cancelAlgoOrder({ instId, algoId }) {
  if (!LIVE_MODE) return { cancelled: true, paper: true };

  const body = [{ instId, algoId }];
  try {
    await okxPost("/api/v5/trade/cancel-algos", body);
    console.log(`[EXCHANGE] Algo cancelled: ${algoId}`);
    return { cancelled: true };
  } catch (err) {
    console.warn(`[EXCHANGE] Could not cancel algo ${algoId}: ${err.message}`);
    return { cancelled: false };
  }
}

// =============================================================================
// AMEND SL/TP ALGO ORDER
// =============================================================================
export async function amendStopLoss({ instId, direction, sz, newSl, newTp }) {
  if (!LIVE_MODE) return { amended: true, paper: true };

  const side = direction === "long" ? "sell" : "buy";
  const posSide = POS_MODE === "hedge" ? direction : undefined;
  const slRounded = await roundPrice(instId, newSl);
  const tpRounded = newTp ? await roundPrice(instId, newTp) : null;

  const body = {
    instId,
    tdMode: "cross",
    side,
    ordType: "oco",
    sz: String(sz),
    tpTriggerPx: tpRounded ? String(tpRounded) : undefined,
    tpOrdPx: tpRounded ? "-1" : undefined,
    slTriggerPx: String(slRounded),
    slOrdPx: "-1",
    reduceOnly: "true",
    ...(posSide && { posSide })
  };

  try {
    const result = await okxPost("/api/v5/trade/order-algo", body);
    const order = result?.[0];
    console.log(`[EXCHANGE] SL amended -> ${newSl} for ${instId}`);
    return { algoId: order?.algoId };
  } catch (err) {
    console.error(`[EXCHANGE] amendStopLoss failed: ${err.message}`);
    return { amended: false };
  }
}

// =============================================================================
// RECONCILE - compare bot state.positions vs live OKX positions
// =============================================================================
export async function reconcilePositions(state) {
  if (!LIVE_MODE) {
    console.log("[EXCHANGE] PAPER MODE - reconcile skipped");
    return { ok: true, drifted: [] };
  }

  console.log("[EXCHANGE] Reconciling positions...");
  const livePositions = await getLivePositions();
  const botPositions = Object.values(state.positions || {});

  const drifted = [];

  for (const pos of botPositions) {
    const live = livePositions.find((livePos) =>
      livePos.instId === pos.symbol && livePos.direction === pos.direction
    );
    if (!live) {
      console.warn(`[EXCHANGE] DRIFT: bot has ${pos.direction} ${pos.symbol} but OKX has none`);
      drifted.push({ type: "ghost", symbol: pos.symbol, direction: pos.direction });
    } else {
      const sizeDiff = Math.abs(live.size - (pos.contracts || 0));
      if (sizeDiff > 0.01) {
        console.warn(`[EXCHANGE] SIZE DRIFT: ${pos.symbol} bot=${pos.contracts} okx=${live.size}`);
        drifted.push({ type: "size-drift", symbol: pos.symbol, botSz: pos.contracts, liveSz: live.size });
      }
    }
  }

  for (const live of livePositions) {
    const botHas = botPositions.find((pos) =>
      pos.symbol === live.instId && pos.direction === live.direction
    );
    if (!botHas) {
      console.warn(`[EXCHANGE] ORPHAN: OKX has ${live.direction} ${live.instId} but bot state doesn't`);
      drifted.push({ type: "orphan", instId: live.instId, direction: live.direction, size: live.size });
    }
  }

  const ok = drifted.length === 0;
  console.log(`[EXCHANGE] Reconcile: ${ok ? "clean" : `${drifted.length} issues`}`);
  return { ok, drifted };
}

// =============================================================================
// GET LIVE PRICE
// =============================================================================
export async function getLivePrice(instId) {
  if (!LIVE_MODE) return null;
  try {
    const data = await okxGet(`/api/v5/market/ticker?instId=${instId}`);
    return data?.[0] ? parseFloat(data[0].last) : null;
  } catch (_) {
    return null;
  }
}

// =============================================================================
// LIVE MODE STATUS
// =============================================================================
export async function checkConnectivity() {
  console.log(`[EXCHANGE] Live mode: ${LIVE_MODE ? "ON" : "OFF (paper)"}`);
  if (!LIVE_MODE) return { live: false };

  if (!API_KEY || !API_SECRET || !PASSPHRASE) {
    throw new Error("[EXCHANGE] LIVE_MODE=true but OKX credentials missing in env vars");
  }

  try {
    const balance = await getLiveBalance();
    console.log(`[EXCHANGE] Connected. USDT balance: $${balance?.toFixed(2)}`);
    return { live: true, balance };
  } catch (err) {
    throw new Error(`[EXCHANGE] Connectivity check failed: ${err.message}`);
  }
}

export { LIVE_MODE, LIVE_RISK_PCT };
