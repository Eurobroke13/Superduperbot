import { API_BASE, LUNARCRUSH_API } from "./config.js";

const apiHealth = {
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  totalFailures: 0,
  tripped: false,
  tripThreshold: 5,
  resetAfterMs: 3 * 60_000
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordApiSuccess() {
  apiHealth.consecutiveFailures = 0;
  apiHealth.lastSuccessAt = new Date().toISOString();
  apiHealth.tripped = false;
}

function recordApiFailure() {
  apiHealth.consecutiveFailures += 1;
  apiHealth.totalFailures += 1;
  apiHealth.lastFailureAt = new Date().toISOString();
  if (apiHealth.consecutiveFailures >= apiHealth.tripThreshold) {
    apiHealth.tripped = true;
  }
}

export function getApiHealth() {
  if (apiHealth.tripped && apiHealth.lastFailureAt) {
    const lastFailureMs = new Date(apiHealth.lastFailureAt).getTime();
    if (Date.now() - lastFailureMs >= apiHealth.resetAfterMs) {
      apiHealth.tripped = false;
      apiHealth.consecutiveFailures = 0;
    }
  }
  return { ...apiHealth };
}

export async function fetchWithRetry(url, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.status === 429) {
        await sleep(Math.pow(2, attempt) * 500);
        continue;
      }
      if (!res.ok) {
        if (attempt < retries) {
          await sleep(500 * attempt);
          continue;
        }
        recordApiFailure();
        return null;
      }
      recordApiSuccess();
      return await res.json();
    } catch (_) {
      if (attempt === retries) {
        recordApiFailure();
        return null;
      }
      await sleep(500 * attempt);
    }
  }
  recordApiFailure();
  return null;
}

export async function fetchAllContracts() {
  try {
    const data = await fetchWithRetry(`${API_BASE}/api/v5/public/instruments?instType=SWAP`);
    if (!data?.data) return null;
    return data.data
      .filter((contract) => contract.state === "live" && contract.settleCcy === "USDT" && contract.ctType === "linear")
      .map((contract) => contract.instId);
  } catch (err) {
    console.error("[API] contracts:", err.message);
    return null;
  }
}

export async function fetchAllTickers() {
  try {
    const data = await fetchWithRetry(`${API_BASE}/api/v5/market/tickers?instType=SWAP`);
    if (!data?.data) return null;
    return data.data
      .filter((ticker) => ticker.instId.endsWith("-USDT-SWAP"))
      .map((ticker) => ({
        contract: ticker.instId,
        volume_24h_quote: parseFloat(ticker.volCcy24h || 0),
        last: parseFloat(ticker.last || 0)
      }));
  } catch (err) {
    console.error("[API] tickers:", err.message);
    return null;
  }
}

export async function fetchCandles(symbol, interval, limit = 200) {
  try {
    const intervalMap = { "1h": "1H", "4h": "4H", "1d": "1D", "15m": "15m" };
    const okxInterval = intervalMap[interval] || "1H";
    const raw = await fetchWithRetry(
      `${API_BASE}/api/v5/market/candles?instId=${symbol}&bar=${okxInterval}&limit=${limit}`
    );
    if (!raw?.data || raw.data.length === 0) return null;
    if (raw.data.length < limit * 0.5) {
      console.warn(`[API] Partial candles for ${symbol} ${okxInterval}: ${raw.data.length}/${limit}`);
      return null;
    }
    return raw.data
      .map((candle) => ({
        time: parseInt(candle[0]),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5])
      }))
      .sort((a, b) => a.time - b.time);
  } catch (_) {
    return null;
  }
}

export async function fetchFundingRate(symbol) {
  try {
    const data = await fetchWithRetry(
      `${API_BASE}/api/v5/public/funding-rate-history?instId=${symbol}&limit=1`
    );
    if (!data?.data?.[0]) return null;
    return parseFloat(data.data[0].fundingRate);
  } catch (_) {
    return null;
  }
}

export async function fetchCryptoPanicNews(state) {
  const result = { blockedCoins: [], boostedCoins: [], headlines: [], needsClaude: false };

  try {
    const url = "https://cryptopanic.com/api/v1/posts/?auth_token=anonymous&public=true&kind=news&filter=hot";
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      result.blockedCoins = state.newsBlocked || [];
      result.boostedCoins = state.newsBoosted || [];
      return result;
    }
    const data = await res.json();
    if (!data.results) return result;

    const headlines = data.results.slice(0, 15).map((post) => ({
      title: post.title || "",
      coins: (post.currencies || []).map((currency) => currency.code?.toUpperCase()).filter(Boolean),
      sentiment: post.votes?.negative > post.votes?.positive
        ? "negative"
        : post.votes?.positive > post.votes?.negative
          ? "positive"
          : "neutral",
      id: post.id
    }));
    result.headlines = headlines;

    const ids = headlines.map((headline) => headline.id).sort().join(",");
    if (ids === state.lastHeadlineIds) {
      result.blockedCoins = state.newsBlocked || [];
      result.boostedCoins = state.newsBoosted || [];
      result.needsClaude = false;
      return result;
    }
    state.lastHeadlineIds = ids;

    const neg = ["hack", "exploit", "breach", "lawsuit", "ban", "delist", "bankrupt", "freeze", "suspend", "scam", "rug", "sec", "charged", "fraud", "investigation", "stolen"];
    const pos = ["etf", "approval", "partnership", "listing", "upgrade", "launch", "integration", "institutional", "adoption", "bullish", "milestone", "record", "rally"];

    for (const headline of headlines) {
      const lower = headline.title.toLowerCase();
      for (const coin of headline.coins) {
        if (neg.some((keyword) => lower.includes(keyword))) result.blockedCoins.push(coin);
        if (pos.some((keyword) => lower.includes(keyword))) result.boostedCoins.push(coin);
      }
    }
    result.blockedCoins = [...new Set(result.blockedCoins)];
    result.boostedCoins = [...new Set(result.boostedCoins)];

    const notable = headlines.filter((headline) => headline.sentiment !== "neutral" || headline.coins.length > 0).length;
    result.needsClaude = notable >= 3;
  } catch (err) {
    console.error("[NEWS]", err.message);
    result.blockedCoins = state.newsBlocked || [];
    result.boostedCoins = state.newsBoosted || [];
  }

  return result;
}

export async function fetchLunarCrush(symbols, env, state) {
  const result = {};
  if (!env.LUNARCRUSH_API_KEY || symbols.length === 0) return result;
  const now = Date.now();
  const ttlMs = 30 * 60 * 1000;

  if (
    state.lunarCache &&
    state.lunarCache.ts &&
    now - state.lunarCache.ts < ttlMs &&
    state.lunarCache.data
  ) {
    for (const symbol of symbols) {
      if (state.lunarCache.data[symbol]) {
        result[symbol] = state.lunarCache.data[symbol];
      }
    }
    if (Object.keys(result).length > 0) return result;
  }

  try {
    const url = `${LUNARCRUSH_API}/list/v1?symbols=${symbols.join(",")}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.LUNARCRUSH_API_KEY}`, Accept: "application/json" }
    });
    if (!res.ok) return result;
    const data = await res.json();
    if (!data.data) return result;

    const fetched = {};
    for (const coin of data.data) {
      const sym = coin.symbol?.toUpperCase();
      if (!sym) continue;
      const lunarPoint = {
        galaxyScore: coin.galaxy_score ?? 50,
        sentiment: coin.sentiment ?? 50,
        socialVolume: coin.social_volume_24h ?? 0,
        altRank: coin.alt_rank ?? 999
      };
      fetched[sym] = lunarPoint;
      if (symbols.includes(sym)) result[sym] = lunarPoint;
    }
    state.lunarCache = {
      ts: now,
      data: {
        ...(state.lunarCache?.data || {}),
        ...fetched
      }
    };
  } catch (err) {
    console.error("[LUNAR]", err.message);
    if (
      state.lunarCache &&
      state.lunarCache.data &&
      state.lunarCache.ts &&
      now - state.lunarCache.ts < ttlMs
    ) {
      for (const symbol of symbols) {
        if (state.lunarCache.data[symbol]) {
          result[symbol] = state.lunarCache.data[symbol];
        }
      }
    }
  }

  return result;
}

export async function fetchLivePrices(state) {
  const prices = {};
  const symbols = Object.keys(state.positions);
  if (symbols.length === 0) return prices;
  const tickers = await fetchAllTickers();
  if (!tickers) return prices;
  for (const ticker of tickers) {
    if (state.positions[ticker.contract]) {
      prices[ticker.contract] = parseFloat(ticker.last);
    }
  }
  return prices;
}
