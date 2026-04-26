import {
  ENTRY_THRESHOLD,
  FUNDING_SETTLEMENT_HOURS,
  HOUR_PERFORMANCE,
  MAX_POSITIONS,
  SETTLEMENT_AVOID_MINUTES
} from "./config.js";
import { getAdaptiveClaudeThreshold } from "./stats.js";
import {
  fetchAllContracts,
  fetchAllTickers,
  fetchCandles,
  fetchCryptoPanicNews,
  fetchFundingRate,
  fetchLunarCrush
} from "./market-data.js";
import { atr, sma } from "./indicators.js";
import {
  checkGraduatedExit,
  closePosition,
  executePartialClose
} from "./exits.js";
import {
  checkDCA,
  checkTranches,
  openPositionGradual
} from "./execution.js";
import {
  autoApproveSignal,
  checkCorrelationExposure,
  fundingRateSignal,
  scoreSymbol
} from "./scoring.js";

export async function runBot(env, deps) {
  const {
    loadState,
    saveState,
    printPortfolioSummary
  } = deps;

  console.log("=== BOT RUN ===", new Date().toISOString());
  let state;
  try {
    state = await loadState(env);
  } catch (err) {
    console.error("[BOT] Cannot load state, aborting run:", err.message);
    return;
  }

  state.runCount = (state.runCount || 0) + 1;
  state.lastRunAt = new Date().toISOString();

  await checkAllExits(env, state, deps);

  const phase = state.lastPhase || 0;
  console.log(`[PHASE ${phase}]`);

  try {
    switch (phase) {
      case 0:
        await phaseRegimeAndExits(env, state, deps);
        state.lastPhase = 1;
        break;
      case 1:
        await phaseScan(env, state, 0, 0.5, deps);
        state.lastPhase = 2;
        break;
      case 2:
        await phaseScan(env, state, 0.5, 1.0, deps);
        state.lastPhase = 0;
        break;
      default:
        state.lastPhase = 0;
    }
  } catch (err) {
    console.error(`[PHASE ${phase}] Error:`, err.message || err);
    state.lastPhase = (phase + 1) % 3;
  }

  await saveState(env, state);
  printPortfolioSummary(state);
}

async function checkAllExits(env, state, deps) {
  const {
    claudeBatchAnalysis,
    notifyTrade,
    updateCoinHistory,
    updateDynamicWeights,
    updateRegimeStats
  } = deps;

  const tickers = await fetchAllTickers();
  const livePrices = {};

  if (tickers) {
    for (const t of tickers) {
      if (t.last) livePrices[t.contract] = t.last;
    }
  }

  const positionsToClose = [];
  for (const symbol of Object.keys(state.positions)) {
    try {
      const candles = await fetchCandles(symbol, "15m", 100);
      if (!candles || candles.length < 50) continue;
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const last = candles[candles.length - 1];
      const price = livePrices[symbol] || last.close;
      const high = last.high;
      const low = last.low;
      const atrVal = atr(highs, lows, closes, 14);
      const pos = state.positions[symbol];

      const hoursOpen = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
      if (hoursOpen > 168) {
        const pnl = pos.direction === "long" ? price - pos.entryPrice : pos.entryPrice - price;
        if (pnl <= 0) {
          positionsToClose.push({ ...pos, exitPrice: price, exitReason: "max-age-expired" });
          continue;
        }
      }

      if (pos.forceClose) {
        positionsToClose.push({ ...pos, exitPrice: price, exitReason: "claude-reeval" });
        continue;
      }

      checkTranches(pos, price, state);
      await checkDCA(pos, price, atrVal, state, env, { notifyTrade });

      const exit = checkGraduatedExit(pos, price, high, low, atrVal);
      if (exit.exit) {
        positionsToClose.push({ ...pos, exitPrice: price, exitReason: exit.reason });
      } else if (exit.partial && exit.partialCloses) {
        for (const pc of exit.partialCloses) {
          executePartialClose(symbol, price, pc.pct, pc.reason, pos, state, {
            updateCoinHistory,
            updateDynamicWeights,
            updateRegimeStats
          });
          await notifyTrade("PARTIAL", {
            symbol,
            direction: pos.direction,
            exitPrice: price,
            reason: pc.reason,
            pct: pc.pct,
            pnl: pos.direction === "long"
              ? (price - pos.entryPrice) * pos.size * pc.pct
              : (pos.entryPrice - price) * pos.size * pc.pct
          }, state, env);
        }
        if (pos.size < 0.0001 || pos.notional < 1) {
          positionsToClose.push({ ...pos, exitPrice: price, exitReason: "fully-partialed" });
        }
      }
    } catch (err) {
      console.error(`[EXIT ${symbol}]`, err.message);
    }
  }

  state.lastExitCount = positionsToClose.length;
  if (positionsToClose.length === 0) return;

  const regime = state.lastRegime || { label: "unknown", hmmLabel: "?", piCycle: "?", markovProb: 0 };

  try {
    const claudeResult = await claudeBatchAnalysis({
      headlines: [],
      candidatesToValidate: [],
      positionsToClose,
      regime,
      env,
      state
    });

    for (const p of positionsToClose) {
      if (state.positions[p.symbol]) {
        const journal = claudeResult.journals[p.symbol] || null;
        closePosition(p.symbol, p.exitPrice, p.exitReason, state.positions[p.symbol], state, journal, {
          updateCoinHistory,
          updateDynamicWeights,
          updateRegimeStats
        });
        await notifyTrade("CLOSE", p, state, env);
      }
    }
  } catch (err) {
    console.error("[BATCH CLOSE]", err.message);
    for (const p of positionsToClose) {
      if (state.positions[p.symbol]) {
        closePosition(p.symbol, p.exitPrice, p.exitReason, state.positions[p.symbol], state, null, {
          updateCoinHistory,
          updateDynamicWeights,
          updateRegimeStats
        });
      }
    }
  }
}

async function phaseRegimeAndExits(env, state, deps) {
  const { claudeBatchAnalysis, sendRegimeChangeAlert } = deps;

  const btcDaily = await fetchCandles("BTC-USDT-SWAP", "1d", 500);
  if (!btcDaily || btcDaily.length < 200) {
    console.warn("[REGIME] Insufficient BTC data.");
    return;
  }

  const prevLabel = state.lastRegime?.label;
  const regime = detectRegime(btcDaily, state);
  state.lastRegime = regime;
  console.log(`[REGIME] ${regime.label} | HMM:${regime.hmmLabel} | PI:${regime.piCycle} | Markov:${regime.markovProb.toFixed(3)}`);

  for (const pos of Object.values(state.positions)) {
    if (!pos.tpLevels && pos.atrVal) {
      const entryAtr = pos.atrVal;
      pos.tpLevels = {
        tp1: {
          atrMult: 2.0, pct: 0.30, hit: false,
          price: pos.direction === "long"
            ? pos.entryPrice + entryAtr * 2.0
            : pos.entryPrice - entryAtr * 2.0
        },
        tp2: {
          atrMult: 3.5, pct: 0.30, hit: false,
          price: pos.direction === "long"
            ? pos.entryPrice + entryAtr * 3.5
            : pos.entryPrice - entryAtr * 3.5
        },
        tp3: { pct: 0.40, hit: false }
      };
      console.log(`[MIGRATE] ${pos.symbol} tpLevels: TP1@$${pos.tpLevels.tp1.price.toFixed(6)} TP2@$${pos.tpLevels.tp2.price.toFixed(6)}`);
    }
    if (pos.dcaApplied === undefined) pos.dcaApplied = false;
    if (pos.maxFavorable === undefined) pos.maxFavorable = pos.entryPrice;
  }

  if (prevLabel && prevLabel !== regime.label) {
    await sendRegimeChangeAlert(env, state, prevLabel, regime);
  }

  const newsResult = await fetchCryptoPanicNews(state);
  state.newsBlocked = newsResult.blockedCoins;
  state.newsBoosted = newsResult.boostedCoins;
  state.newsHeadlines = newsResult.headlines;
  state.newsNeedsClaude = newsResult.needsClaude;

  if (newsResult.needsClaude) {
    try {
      const claudeResult = await claudeBatchAnalysis({
        headlines: newsResult.headlines,
        candidatesToValidate: [],
        positionsToClose: [],
        regime,
        env,
        state
      });

      if (claudeResult.newsBlocked.length > 0) {
        state.newsBlocked = [...new Set([...state.newsBlocked, ...claudeResult.newsBlocked])];
      }
      if (claudeResult.newsBoosted.length > 0) {
        state.newsBoosted = [...new Set([...state.newsBoosted, ...claudeResult.newsBoosted])];
      }
    } catch (err) {
      console.error("[NEWS BATCH]", err.message);
    }
  }

  console.log(`[PHASE 0] Regime:${regime.label} | Exits:${state.lastExitCount || 0} | News blocked:${state.newsBlocked.length} boosted:${state.newsBoosted.length}`);
}

async function phaseScan(env, state, startFrac, endFrac, deps) {
  const {
    claudeBatchAnalysis,
    getAdaptiveThreshold,
    getWeight,
    notifyTrade,
    sendTelegram,
    sleep
  } = deps;

  const regime = state.lastRegime;
  if (!regime) {
    console.warn("[SCAN] No regime, skip.");
    return;
  }

  const timeFilter = getTimeFilter();
  if (timeFilter.shouldAvoidEntry) {
    console.log(`[SCAN] Avoiding entries - near funding settlement (${timeFilter.utcHour}:${String(timeFilter.utcMin).padStart(2, "0")} UTC)`);
    return;
  }

  const entryThreshold = getAdaptiveThreshold(state, regime.label);
  const claudeThreshold = getAdaptiveClaudeThreshold(state, regime.label);

  console.log(`[SCAN] Regime:${regime.label} Entry:${entryThreshold} Claude:${claudeThreshold} TimeAdj:${timeFilter.scoreAdjustment.toFixed(1)}`);
  const slotsAvailable = MAX_POSITIONS - Object.keys(state.positions).length;
  if (slotsAvailable <= 0) {
    console.log("[SCAN] All slots full.");
    return;
  }

  const allContracts = await fetchAllContracts();
  if (!allContracts || allContracts.length === 0) return;

  const tickers = await fetchAllTickers();
  const volumeMap = {};
  const livePrices = {};
  if (tickers) for (const t of tickers) {
    volumeMap[t.contract] = parseFloat(t.volume_24h_quote || t.volume_24h_usd || t.volume_24h || 0);
    if (t.last) livePrices[t.contract] = t.last;
  }
  const blocked = state.newsBlocked || [];
  const boosted = state.newsBoosted || [];

  const tradeable = allContracts
    .filter(c => (volumeMap[c] || 0) > 450_000)
    .filter(c => !state.positions[c])
    .filter(c => !blocked.includes(c.replace("-USDT-SWAP", "")));

  const tickerMap = {};
  if (tickers) {
    for (const t of tickers) {
      tickerMap[t.contract] = t;
    }
  }

  const rankedTradeable = tradeable
    .map(symbol => {
      const t = tickerMap[symbol] || {};
      const vol = volumeMap[symbol] || 0;
      const last = parseFloat(t.last || 0);
      const open24h = parseFloat(t.open24h || t.open_24h || t.open24hPrice || 0);
      const movePct =
        open24h > 0 && last > 0
          ? Math.abs((last - open24h) / open24h)
          : 0;

      const rankScore =
        (vol / 1_000_000) +
        (movePct * 100 * 0.3);

      return { symbol, vol, movePct, rankScore };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .map(x => x.symbol);

  const startIdx = Math.floor(rankedTradeable.length * startFrac);
  const endIdx = Math.floor(rankedTradeable.length * endFrac);
  const maxSymbolsPerRun = 20;
  const batch = rankedTradeable.slice(
    startIdx,
    Math.min(endIdx, startIdx + maxSymbolsPerRun)
  );

  console.log(
    `[SCAN] Scoring ${batch.length} contracts ` +
    `(${startIdx}-${Math.min(endIdx, startIdx + maxSymbolsPerRun)} of ${rankedTradeable.length})`
  );

  const candidates = [];
  const chunkSize = 10;
  for (let i = 0; i < batch.length; i += chunkSize) {
    const chunk = batch.slice(i, i + chunkSize);
    const results = await Promise.allSettled(chunk.map(s => scoreSymbol(s, regime, state)));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) candidates.push(r.value);
    }
    if (i + chunkSize < batch.length) await sleep(100);
  }

  for (const c of candidates) {
    const base = c.symbol.replace("-USDT-SWAP", "");
    if (boosted.includes(base)) {
      c.score += getWeight("news-boost", state);
      c.reasons.push("news-boost");
    }
  }

  if (timeFilter.scoreAdjustment !== 0) {
    for (const c of candidates) {
      c.score += timeFilter.scoreAdjustment;
      c.reasons.push(`time(${timeFilter.scoreAdjustment > 0 ? "+" : ""}${timeFilter.scoreAdjustment.toFixed(1)})`);
    }
  }

  const lunarSymbols = [...new Set([
    ...candidates.filter(c => c.score >= ENTRY_THRESHOLD).slice(0, 25).map(c => c.symbol.replace("-USDT-SWAP", "")),
    ...Object.keys(state.positions).map(s => s.replace("-USDT-SWAP", ""))
  ])].slice(0, 15);

  const lunarData = await fetchLunarCrush(lunarSymbols, env, state);

  for (const c of candidates) {
    const base = c.symbol.replace("-USDT-SWAP", "");
    const lunar = lunarData[base];
    if (!lunar) continue;
    c.lunarSentiment = lunar.sentiment;
    c.lunarGalaxyScore = lunar.galaxyScore;

    if (lunar.galaxyScore > 60 && c.signal === "long") {
      c.score += getWeight("lunar-bull", state);
      c.reasons.push(`lunar-bull(${lunar.galaxyScore})`);
    }
    if (lunar.galaxyScore < 30 && c.signal === "short") {
      c.score += getWeight("lunar-bear", state);
      c.reasons.push(`lunar-bear(${lunar.galaxyScore})`);
    }
    if (c.signal === "long" && lunar.sentiment < 30) {
      c.score += getWeight("lunar-sentiment-warning", state);
      c.reasons.push("lunar-sentiment-warning");
    }
    if (c.signal === "short" && lunar.sentiment > 70) {
      c.score += getWeight("lunar-sentiment-warning", state);
      c.reasons.push("lunar-sentiment-warning");
    }
  }

  const scores = candidates.map(c => c.score).sort((a, b) => b - a);
  const cutoff = scores[Math.floor(scores.length * 0.2)] ?? -Infinity;
  const topSignals = candidates.filter(c => c.score >= cutoff);

  if (topSignals.length > 0) {
    const fundingResults = await Promise.allSettled(
      topSignals.map(c => fetchFundingRate(c.symbol))
    );

    for (let i = 0; i < topSignals.length; i++) {
      const c = topSignals[i];
      const fundRate = fundingResults[i].status === "fulfilled"
        ? fundingResults[i].value
        : null;
      const fundSigRaw = fundingRateSignal(fundRate) || {};
      const fundSig = {
        signal: fundSigRaw.signal || "none",
        reason: fundSigRaw.reason || null
      };

      c.fundingRate = fundRate;

      if (fundSig.signal === "short" && c.h4Trend === "bullish") {
        c.score += 1.5;
        c.reasons.push("funding-squeeze");
      }

      if (fundSig.signal === "long" && c.h4Trend === "bearish") {
        c.score += 1.5;
        c.reasons.push("funding-squeeze");
      }

      if (fundSig.reason === "funding-extreme-long") {
        c.score += c.signal === "short" ? 2.0 : -0.5;
        c.reasons.push("funding-extreme-long");
      }

      if (fundSig.reason === "funding-extreme-short") {
        c.score += c.signal === "long" ? 2.0 : -0.5;
        c.reasons.push("funding-extreme-short");
      }

      if (fundSig.reason === "funding-crowded-long" && fundRate > 0.0015) {
        if (c.signal === "short") c.score += 1.0;
        c.reasons.push("funding-skew-short");
      }

      if (fundSig.reason === "funding-crowded-short" && fundRate < -0.0015) {
        if (c.signal === "long") c.score += 1.0;
        c.reasons.push("funding-skew-long");
      }
    }
  }

  const qualified = topSignals.filter(c => c.score >= entryThreshold);
  const longs = qualified.filter(c => c.signal === "long").sort((a, b) => b.score - a.score);
  const shorts = qualified.filter(c => c.signal === "short").sort((a, b) => b.score - a.score);

  const toConsider = [];
  let li = 0, si = 0;
  while (toConsider.length < slotsAvailable && (li < longs.length || si < shorts.length)) {
    if (li < longs.length) toConsider.push(longs[li++]);
    if (toConsider.length < slotsAvailable && si < shorts.length) toConsider.push(shorts[si++]);
  }

  const autoList = [];
  const claudeList = [];

  for (const c of toConsider) {
    const exposure = checkCorrelationExposure(c, state);
    if (!exposure.allowed) {
      console.log(`[${c.symbol}] Blocked: ${exposure.reason}`);
      continue;
    }

    if (c.score >= claudeThreshold) claudeList.push(c);
    else autoList.push(c);
  }

  for (const c of autoList) {
    if (autoApproveSignal(c, regime)) {
      const opened = openPositionGradual({ ...c, approvalType: "auto" }, state, livePrices, env, {
        sendTelegram
      });
      if (opened) await notifyTrade("OPEN", c, state, env);
    }
  }

  if (claudeList.length > 0) {
    try {
      const claudeResult = await claudeBatchAnalysis({
        headlines: [],
        candidatesToValidate: claudeList.slice(0, 5),
        positionsToClose: [],
        regime,
        env,
        state
      });

      for (const c of claudeList) {
        const v = claudeResult.validations[c.symbol];
        if (v?.approved === true) {
          const opened = openPositionGradual({ ...c, approvalType: "claude" }, state, livePrices, env, {
            sendTelegram
          });
          if (opened) {
            await notifyTrade("OPEN", c, state, env);
            console.log(`[${c.symbol}] Claude approved: ${v.reason}`);
          }
        } else {
          if (v?.reason === "auto-fallback") {
            console.log(`[${c.symbol}] Claude unavailable, fallback decision: ${v.reason}`);
          } else {
            console.log(`[${c.symbol}] Claude rejected: ${v?.reason || "no response"}`);
          }
        }
      }
    } catch (err) {
      console.error("[CLAUDE VALIDATE]", err.message);
      for (const c of claudeList) {
        if (c.score >= 9 && autoApproveSignal(c, regime)) {
          const opened = openPositionGradual({ ...c, approvalType: "claude" }, state, livePrices, env, {
            sendTelegram
          });
          if (opened) {
            await notifyTrade("OPEN", c, state, env);
            console.log(`[${c.symbol}] Claude unavailable, fallback decision: auto-fallback`);
          }
        } else {
          console.log(`[${c.symbol}] Not opened: Claude unavailable and fallback did not approve`);
        }
      }
    }
  }

  if (qualified.length === 0 && candidates.length > 0) {
    const topScores = candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(c => `${c.symbol}:${c.score.toFixed(1)}(${c.signal})`);
    console.log(`[SCAN] No qualified candidates. Top unqualified: ${topScores.join(", ")} | Threshold:${entryThreshold}`);
  }
  if (candidates.length === 0) {
    console.log(`[SCAN] Zero candidates passed indicator filters. ${batch.length} contracts scanned.`);
  }
  console.log(`[SCAN] Qualified:${qualified.length} Auto:${autoList.length} Claude:${claudeList.length}`);
}

function getTimeFilter() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();

  let nearSettlement = false;
  for (const settleHour of FUNDING_SETTLEMENT_HOURS) {
    const minutesToSettle = ((settleHour - utcHour + 24) % 24) * 60 - utcMin;
    const minutesAfter = ((utcHour - settleHour + 24) % 24) * 60 + utcMin;
    if (minutesToSettle >= 0 && minutesToSettle <= SETTLEMENT_AVOID_MINUTES) { nearSettlement = true; break; }
    if (minutesAfter >= 0 && minutesAfter <= SETTLEMENT_AVOID_MINUTES) { nearSettlement = true; break; }
  }

  const utcDay = now.getUTCDay();
  const isWeekend = utcDay === 0 || utcDay === 6;
  const hourModifier = HOUR_PERFORMANCE[utcHour] || 0;

  return {
    utcHour,
    utcMin,
    nearSettlement,
    isWeekend,
    hourModifier,
    shouldAvoidEntry: nearSettlement,
    scoreAdjustment: nearSettlement ? -1.0 : hourModifier + (isWeekend ? -0.15 : 0)
  };
}

function detectRegime(dailyCandles, state) {
  const closes = dailyCandles.map(c => c.close);
  const n = closes.length;

  const ma111 = sma(closes, 111);
  const ma350 = sma(closes, 350);
  const piCycle = (() => {
    const m111 = ma111[n - 1];
    const m350x2 = ma350[n - 1] != null ? ma350[n - 1] * 2 : null;
    if (!m111 || !m350x2) return "unknown";
    const r = m111 / m350x2;
    if (r >= 0.98) return "top";
    if (r >= 0.90) return "late_bull";
    return "bull";
  })();

  const returns = [];
  for (let i = 1; i < n; i++) returns.push(Math.log(closes[i] / closes[i - 1]));

  const hmmParams = state.hmmParams || initHMMParams(returns);
  const { hmmState, updatedParams } = viterbiHMM(returns, hmmParams);
  state.hmmParams = updatedParams;
  const hmmLabel = hmmState === 0 ? "bull" : "bear";

  const mc = state.markovChain || { transitions: [[0.8, 0.2], [0.2, 0.8]] };
  updateMarkovChain(mc, returns);
  state.markovChain = mc;
  const markovProb = mc.transitions[hmmState === 0 ? 0 : 1][0];

  const recent = closes.slice(-14);
  const rangeR = (Math.max(...recent) - Math.min(...recent)) / Math.min(...recent);
  const sideways = rangeR < 0.10;

  let bull = 0, bear = 0;
  if (hmmLabel === "bull") bull++; else bear++;
  if (piCycle === "bull" || piCycle === "late_bull") bull++; else bear++;
  if (markovProb > 0.5) bull++; else bear++;

  let label;
  if (sideways) label = "sideways";
  else if (bull >= 2) label = "bull";
  else label = "bear";

  return { label, hmmState, hmmLabel, markovProb, piCycle };
}

function initHMMParams(returns) {
  const sorted = [...returns].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    means: [mean(sorted.slice(mid)), mean(sorted.slice(0, mid))],
    stds: [Math.max(std(sorted.slice(mid)), 0.001), Math.max(std(sorted.slice(0, mid)), 0.001)],
    trans: [[0.95, 0.05], [0.10, 0.90]],
    pi: [0.7, 0.3]
  };
}

function viterbiHMM(observations, params) {
  const T = observations.length, K = 2;
  const vit = Array.from({ length: T }, () => new Array(K).fill(-Infinity));
  const back = Array.from({ length: T }, () => new Array(K).fill(0));

  for (let s = 0; s < K; s++) {
    vit[0][s] = Math.log(params.pi[s] + 1e-300) + logGaussian(observations[0], params.means[s], params.stds[s]);
  }
  for (let t = 1; t < T; t++) {
    for (let s = 0; s < K; s++) {
      let best = -Infinity, bp = 0;
      for (let p = 0; p < K; p++) {
        const v = vit[t - 1][p] + Math.log(params.trans[p][s] + 1e-300);
        if (v > best) { best = v; bp = p; }
      }
      vit[t][s] = best + logGaussian(observations[t], params.means[s], params.stds[s]);
      back[t][s] = bp;
    }
  }

  let last = vit[T - 1][0] > vit[T - 1][1] ? 0 : 1;
  const path = [last];
  for (let t = T - 1; t > 0; t--) {
    last = back[t][last];
    path.unshift(last);
  }

  const up = { ...params, means: [...params.means], stds: [...params.stds] };
  for (let s = 0; s < K; s++) {
    const obs = observations.filter((_, i) => path[i] === s);
    if (obs.length > 5) {
      up.means[s] = mean(obs);
      up.stds[s] = Math.max(std(obs), 0.001);
    }
  }
  return { hmmState: path[T - 1], updatedParams: up };
}

function updateMarkovChain(mc, returns) {
  const win = returns.slice(-90);
  const cnt = [[0, 0], [0, 0]];
  for (let i = 1; i < win.length; i++) {
    const p = win[i - 1] >= 0 ? 0 : 1;
    const c = win[i] >= 0 ? 0 : 1;
    cnt[p][c]++;
  }
  for (let s = 0; s < 2; s++) {
    const t = cnt[s][0] + cnt[s][1];
    if (t > 0) {
      mc.transitions[s][0] = cnt[s][0] / t;
      mc.transitions[s][1] = cnt[s][1] / t;
    }
  }
}

function mean(arr) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function logGaussian(x, mu, sigma) {
  if (sigma <= 0) sigma = 1e-6;
  return -0.5 * Math.log(2 * Math.PI * sigma * sigma) - (x - mu) ** 2 / (2 * sigma * sigma);
}
