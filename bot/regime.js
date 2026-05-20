import { sma } from "./indicators.js";
import { detectSideways } from "./enhanced-regime.js";

/**
 * Detect bear regime signals across multiple timeframes
 * Returns bearStrength score (0-5) for early entry opportunities
 */
export function detectBearSignals(closes, highs, lows, atrVal, adxResult, rsiVal, candles4h) {
  let bearStrength = 0;
  const signals = [];

  // Signal 1: 4H Lower Highs (2 points) — PRIMARY, EARLIEST SIGNAL
  if (candles4h && candles4h.length >= 10) {
    const h4 = candles4h.map(c => c.high);
    const n = h4.length;
    // Last 5 candles: max(h4[n-1]...h4[n-4]) < max(h4[n-5]...h4[n-9])
    const recentHigh = Math.max(...h4.slice(Math.max(0, n - 5), n));
    const prevHigh = Math.max(...h4.slice(Math.max(0, n - 10), Math.max(0, n - 5)));
    if (prevHigh > 0 && recentHigh < prevHigh) {
      bearStrength += 2;
      signals.push("4h-lower-highs");
    }
  }

  // Signal 2: ADX Downtrend on 1H (1 point)
  if (adxResult?.trending && adxResult?.mdi > adxResult?.pdi) {
    bearStrength += 1;
    signals.push("adx-downtrend");
  }

  // Signal 3: Death Cross on Daily (1 point)
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const n = closes.length;
  if (ma50[n - 1] != null && ma200[n - 1] != null && ma50[n - 1] < ma200[n - 1]) {
    bearStrength += 1;
    signals.push("death-cross");
  }

  // Signal 4: RSI Compression (1 point)
  // RSI < 40 suggests bears have lower highs + lower rally capacity
  if (rsiVal != null && rsiVal < 40) {
    bearStrength += 1;
    signals.push("rsi-compression");
  }

  return { bearStrength: Math.min(bearStrength, 5), signals };
}

export function detectRegime(dailyCandles, state) {
  const closes = dailyCandles.map(c => c.close);
  const highs = dailyCandles.map(c => c.high);
  const lows = dailyCandles.map(c => c.low);
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
    if (r >= 0.75) return "bull";
    if (r >= 0.55) return "late_bear";
    return "bear";
  })();

  const returns = [];
  for (let i = 1; i < n; i++) returns.push(Math.log(closes[i] / closes[i - 1]));

  const hmmParams = state.hmmParams || initHMMParams(returns);
  const { hmmState, updatedParams } = viterbiHMM(returns, hmmParams);
  state.hmmParams = updatedParams;
  const hmmLabel = hmmState === 0 ? "bull" : "bear";

  const mc = state.markovChain || { transitions: [[0.65, 0.35], [0.35, 0.65]] };
  updateMarkovChain(mc, returns);
  state.markovChain = mc;
  const markovProb = mc.transitions[hmmState === 0 ? 0 : 1][0];

  const sidewaysResult = detectSideways(closes, highs, lows);
  const { sideways, confidence: sidewaysConfidence, signals: sidewaysSignals } = sidewaysResult;
  if (sidewaysConfidence > 0.6 && state.logRegimeDetails !== false) {
    console.log(
      `[REGIME] Sideways confidence: ${(sidewaysConfidence * 100).toFixed(0)}%`,
      Object.entries(sidewaysSignals).map(([k, v]) => `${k}:${v.signal}`).join(" ")
    );
  }

  let bull = 0, bear = 0;
  if (hmmLabel === "bull") bull++; else bear++;
  if (piCycle === "bull" || piCycle === "late_bull") bull++;
  else if (piCycle === "bear" || piCycle === "late_bear") bear++;
  if (markovProb > 0.5) bull++; else bear++;

  let label;
  if (sideways) label = "sideways";
  else if (bear >= 2) label = "bear";      // Bear needs >= 2 votes, same as bull
  else if (bull >= 2) label = "bull";
  else label = "sideways";  // Fallback: prefer sideways over ambiguous

  return { label, hmmState, hmmLabel, markovProb, piCycle, sidewaysConfidence, sidewaysSignals };
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
