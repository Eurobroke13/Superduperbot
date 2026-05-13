function mean(arr) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length);
}

export function sma(data, period) {
  return data.map((_, i) =>
    i < period - 1
      ? null
      : data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period
  );
}

export function ema(data, period) {
  if (!data.length) return [];
  const result = [data[0]];
  const multiplier = 2 / (period + 1);
  for (let i = 1; i < data.length; i++) {
    result.push((data[i] - result[i - 1]) * multiplier + result[i - 1]);
  }
  return result;
}

export function atr(highs, lows, closes, period = 14) {
  const trs = highs.map((high, i) =>
    i === 0
      ? high - lows[i]
      : Math.max(
          high - lows[i],
          Math.abs(high - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1])
        )
  );
  const smoothed = sma(trs, period).filter((value) => value !== null);
  return smoothed.length > 0
    ? smoothed[smoothed.length - 1]
    : highs[highs.length - 1] - lows[lows.length - 1];
}

export function rsiSeries(closes, period = 14) {
  const n = closes.length;
  const result = new Array(n).fill(50);
  if (n < period + 1) return result;
  const changes = closes.map((close, i) => (i === 0 ? 0 : close - closes[i - 1]));
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss -= changes[i];
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(changes[i], 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-changes[i], 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

export function gaussianSmooth(data, sigma = 3) {
  const size = Math.ceil(sigma * 3) * 2 + 1;
  const half = Math.floor(size / 2);
  const kernel = [];
  let kernelSum = 0;
  for (let i = 0; i < size; i++) {
    const weight = Math.exp(-((i - half) ** 2) / (2 * sigma * sigma));
    kernel.push(weight);
    kernelSum += weight;
  }
  const normalizedKernel = kernel.map((weight) => weight / kernelSum);
  return data.map((_, i) => {
    let value = 0;
    for (let k = 0; k < size; k++) {
      const dataIndex = Math.max(0, Math.min(data.length - 1, i - half + k));
      value += data[dataIndex] * normalizedKernel[k];
    }
    return value;
  });
}

export function ichimoku(highs, lows, closes) {
  const n = closes.length;
  const midpoint = (period, endIdx) => {
    const start = Math.max(0, endIdx - period + 1);
    const high = Math.max(...highs.slice(start, endIdx + 1));
    const low = Math.min(...lows.slice(start, endIdx + 1));
    return (high + low) / 2;
  };

  const tenkan = midpoint(9, n - 1);
  const kijun = midpoint(26, n - 1);
  const displaced = n - 1 - 26;
  const senkouA = displaced >= 26
    ? (midpoint(9, displaced) + midpoint(26, displaced)) / 2
    : (tenkan + kijun) / 2;
  const senkouB = displaced >= 52
    ? midpoint(52, displaced)
    : midpoint(52, n - 1);
  const chikouCompare = n > 26 ? closes[n - 27] : closes[0];

  return {
    tenkan,
    kijun,
    senkouA,
    senkouB,
    chikou: closes[n - 1],
    chikouCompare,
    cloudThickness: Math.abs(senkouA - senkouB),
    tkCross: tenkan - kijun,
    futureSenkouA: (tenkan + kijun) / 2,
    futureSenkouB: midpoint(52, n - 1)
  };
}

export function obv(closes, volumes) {
  const result = [volumes[0]];
  for (let i = 1; i < closes.length; i++) {
    const prev = result[i - 1];
    if (closes[i] > closes[i - 1]) result.push(prev + volumes[i]);
    else if (closes[i] < closes[i - 1]) result.push(prev - volumes[i]);
    else result.push(prev);
  }
  return result;
}

export function findSwingPoints(data, type, order = 3) {
  const points = [];
  for (let i = order; i < data.length - order; i++) {
    const window = data.slice(i - order, i + order + 1);
    if (type === "low" && data[i] === Math.min(...window)) {
      points.push({ index: i, value: data[i] });
    }
    if (type === "high" && data[i] === Math.max(...window)) {
      points.push({ index: i, value: data[i] });
    }
  }
  return points;
}

export function detectRSIDivergence(closes, rsiArr, lookback = 20) {
  const n = closes.length;
  if (n < lookback) return { type: "none", strength: 0 };

  const priceSlice = closes.slice(n - lookback);
  const rsiSlice = rsiArr.slice(n - lookback);
  const priceLows = findSwingPoints(priceSlice, "low", 3);
  const priceHighs = findSwingPoints(priceSlice, "high", 3);
  const rsiLows = findSwingPoints(rsiSlice, "low", 3);
  const rsiHighs = findSwingPoints(rsiSlice, "high", 3);

  if (priceLows.length >= 2 && rsiLows.length >= 2) {
    const pLL = priceLows[priceLows.length - 1].value < priceLows[priceLows.length - 2].value;
    const rHL = rsiLows[rsiLows.length - 1].value > rsiLows[rsiLows.length - 2].value;
    if (pLL && rHL) {
      return {
        type: "bullish",
        strength: Math.abs(
          rsiLows[rsiLows.length - 1].value - rsiLows[rsiLows.length - 2].value
        )
      };
    }
  }

  if (priceHighs.length >= 2 && rsiHighs.length >= 2) {
    const pHH = priceHighs[priceHighs.length - 1].value > priceHighs[priceHighs.length - 2].value;
    const rLH = rsiHighs[rsiHighs.length - 1].value < rsiHighs[rsiHighs.length - 2].value;
    if (pHH && rLH) {
      return {
        type: "bearish",
        strength: Math.abs(
          rsiHighs[rsiHighs.length - 2].value - rsiHighs[rsiHighs.length - 1].value
        )
      };
    }
  }

  return { type: "none", strength: 0 };
}

export function emaRibbon(closes) {
  const periods = [8, 13, 21, 34, 55];
  const emas = periods.map((period) => ema(closes, period));
  const n = closes.length;
  const last = emas.map((series) => series[n - 1]);

  let bullishOrder = true;
  let bearishOrder = true;
  for (let i = 0; i < last.length - 1; i++) {
    if (last[i] <= last[i + 1]) bullishOrder = false;
    if (last[i] >= last[i + 1]) bearishOrder = false;
  }

  const width = last.length >= 2
    ? Math.abs(last[0] - last[last.length - 1]) / closes[n - 1]
    : 0;

  const prevLast = emas.map((series) => series[n - 2]);
  const prevWidth = prevLast.length >= 2
    ? Math.abs(prevLast[0] - prevLast[prevLast.length - 1]) / closes[n - 2]
    : 0;

  let wasCompressed = false;
  for (let lookback = 2; lookback <= 10; lookback++) {
    const idx = n - lookback;
    if (idx < 0 || closes[idx] === undefined || closes[idx] === 0) continue;
    const histLast = emas.map((series) => series[idx]);
    if (histLast.some((value) => value === undefined)) continue;
    const histWidth = Math.abs(histLast[0] - histLast[histLast.length - 1]) / closes[idx];
    if (histWidth < 0.005) {
      wasCompressed = true;
      break;
    }
  }

  return {
    bullishAligned: bullishOrder,
    bearishAligned: bearishOrder,
    width,
    expanding: width > prevWidth,
    wasCompressed,
    priceAboveAll: closes[n - 1] > Math.max(...last),
    priceBelowAll: closes[n - 1] < Math.min(...last)
  };
}

export function detectOBVDivergence(closes, obvSeries, lookback = 30) {
  const n = closes.length;
  if (n < lookback) return { type: "none", strength: 0 };

  const priceSlice = closes.slice(n - lookback);
  const obvSlice = obvSeries.slice(n - lookback);
  const priceLows = findSwingPoints(priceSlice, "low");
  const priceHighs = findSwingPoints(priceSlice, "high");
  const obvLows = findSwingPoints(obvSlice, "low");
  const obvHighs = findSwingPoints(obvSlice, "high");

  if (priceLows.length >= 2 && obvLows.length >= 2) {
    const pLL = priceLows[priceLows.length - 1].value < priceLows[priceLows.length - 2].value;
    const oHL = obvLows[obvLows.length - 1].value > obvLows[obvLows.length - 2].value;
    if (pLL && oHL) {
      const strength = Math.abs(
        (obvLows[obvLows.length - 1].value - obvLows[obvLows.length - 2].value) /
        (Math.abs(obvLows[obvLows.length - 2].value) + 1)
      );
      return { type: "bullish", strength: Math.min(strength * 100, 10) };
    }
  }

  if (priceHighs.length >= 2 && obvHighs.length >= 2) {
    const pHH = priceHighs[priceHighs.length - 1].value > priceHighs[priceHighs.length - 2].value;
    const oLH = obvHighs[obvHighs.length - 1].value < obvHighs[obvHighs.length - 2].value;
    if (pHH && oLH) {
      const strength = Math.abs(
        (obvHighs[obvHighs.length - 2].value - obvHighs[obvHighs.length - 1].value) /
        (Math.abs(obvHighs[obvHighs.length - 2].value) + 1)
      );
      return { type: "bearish", strength: Math.min(strength * 100, 10) };
    }
  }

  return { type: "none", strength: 0 };
}

export function fisher(highs, lows, period = 10) {
  const n = highs.length;
  const result = new Array(n).fill(0);
  let prevF = 0;
  for (let i = period - 1; i < n; i++) {
    const hh = Math.max(...highs.slice(i - period + 1, i + 1));
    const ll = Math.min(...lows.slice(i - period + 1, i + 1));
    const range = hh - ll;
    let val = range > 0 ? (2 * (((highs[i] + lows[i]) / 2) - ll)) / range - 1 : 0;
    val = Math.max(-0.999, Math.min(0.999, val));
    prevF = 0.5 * Math.log((1 + val) / (1 - val)) + 0.5 * prevF;
    result[i] = prevF;
  }
  return result;
}

export function vwap(highs, lows, closes, volumes, windowSize = 24) {
  const n = closes.length;
  let sumPV = 0;
  let sumV = 0;
  for (let i = Math.max(0, n - windowSize); i < n; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    sumPV += tp * volumes[i];
    sumV += volumes[i];
  }
  return sumV > 0 ? sumPV / sumV : closes[n - 1];
}

export function volumeProfile(closes, volumes, bins = 20) {
  const minP = Math.min(...closes);
  const maxP = Math.max(...closes);
  const step = (maxP - minP) / bins || 1;
  const profile = Array.from({ length: bins }, (_, i) => ({
    low: minP + i * step,
    high: minP + (i + 1) * step,
    volume: 0
  }));
  for (let i = 0; i < closes.length; i++) {
    const bin = Math.min(Math.floor((closes[i] - minP) / step), bins - 1);
    if (bin >= 0) profile[bin].volume += volumes[i];
  }
  const avg = profile.reduce((sum, bucket) => sum + bucket.volume, 0) / bins;
  return { profile, highVolumeNodes: profile.filter((bucket) => bucket.volume >= avg * 1.5) };
}

export function findSupportResistance(highs, lows, lookback = 50) {
  const n = highs.length;
  const supports = [];
  const resistances = [];
  for (let i = 2; i < Math.min(lookback, n - 2); i++) {
    const idx = n - 1 - i;
    if (idx < 2 || idx >= n - 2) continue;
    if (
      lows[idx] < lows[idx - 1] &&
      lows[idx] < lows[idx + 1] &&
      lows[idx] < lows[idx - 2] &&
      lows[idx] < lows[idx + 2]
    ) {
      supports.push(lows[idx]);
    }
    if (
      highs[idx] > highs[idx - 1] &&
      highs[idx] > highs[idx + 1] &&
      highs[idx] > highs[idx - 2] &&
      highs[idx] > highs[idx + 2]
    ) {
      resistances.push(highs[idx]);
    }
  }
  return { supports, resistances };
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) {
    return { macd: 0, signal: 0, histogram: 0, crossUp: false, crossDown: false, diverging: false };
  }
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((fastVal, i) => fastVal - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const histogram = macdLine.map((macdVal, i) => macdVal - signalLine[i]);
  const n = closes.length;
  return {
    macd: macdLine[n - 1],
    signal: signalLine[n - 1],
    histogram: histogram[n - 1],
    crossUp: n >= 2 && histogram[n - 1] > 0 && histogram[n - 2] <= 0,
    crossDown: n >= 2 && histogram[n - 1] < 0 && histogram[n - 2] >= 0,
    diverging: n >= 2 && Math.abs(histogram[n - 1]) > Math.abs(histogram[n - 2])
  };
}

export function bollingerBands(closes, period = 20, stdDev = 2) {
  const n = closes.length;
  const smaVals = sma(closes, period);
  const result = { upper: [], middle: [], lower: [], width: [], pctB: [] };
  for (let i = 0; i < n; i++) {
    if (smaVals[i] === null) {
      result.upper.push(null);
      result.middle.push(null);
      result.lower.push(null);
      result.width.push(null);
      result.pctB.push(null);
      continue;
    }
    const slice = closes.slice(Math.max(0, i - period + 1), i + 1);
    const sd = std(slice);
    const upper = smaVals[i] + stdDev * sd;
    const lower = smaVals[i] - stdDev * sd;
    result.upper.push(upper);
    result.middle.push(smaVals[i]);
    result.lower.push(lower);
    result.width.push(smaVals[i] > 0 ? (upper - lower) / smaVals[i] : 0);
    result.pctB.push(upper !== lower ? (closes[i] - lower) / (upper - lower) : 0.5);
  }
  return result;
}

export function stochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiArr = rsiSeries(closes, rsiPeriod);
  const n = rsiArr.length;
  const stochK = new Array(n).fill(50);

  for (let i = stochPeriod - 1; i < n; i++) {
    const window = rsiArr.slice(i - stochPeriod + 1, i + 1);
    const minRSI = Math.min(...window);
    const maxRSI = Math.max(...window);
    stochK[i] = maxRSI !== minRSI
      ? ((rsiArr[i] - minRSI) / (maxRSI - minRSI)) * 100
      : 50;
  }

  const smoothK = sma(stochK, kSmooth);
  const dLine = sma(smoothK.map((value) => value ?? 50), dSmooth);

  return {
    k: smoothK[n - 1] ?? 50,
    d: dLine[n - 1] ?? 50,
    prevK: smoothK[n - 2] ?? 50,
    prevD: dLine[n - 2] ?? 50,
    crossUp:
      (smoothK[n - 1] ?? 0) > (dLine[n - 1] ?? 0) &&
      (smoothK[n - 2] ?? 0) <= (dLine[n - 2] ?? 0),
    crossDown:
      (smoothK[n - 1] ?? 0) < (dLine[n - 1] ?? 0) &&
      (smoothK[n - 2] ?? 0) >= (dLine[n - 2] ?? 0),
    oversold: (smoothK[n - 1] ?? 50) < 20,
    overbought: (smoothK[n - 1] ?? 50) > 80
  };
}

export function adx(highs, lows, closes, period = 14) {
  const n = highs.length;
  if (n < period * 2 + 1) {
    return { adx: 25, pdi: 0, mdi: 0, trending: false, strongTrend: false };
  }

  const tr = [];
  const plusDM = [];
  const minusDM = [];
  for (let i = 1; i < n; i++) {
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  const smooth = (arr, p) => {
    if (arr.length < p) return [0];
    const result = [arr.slice(0, p).reduce((a, b) => a + b, 0)];
    for (let i = p; i < arr.length; i++) {
      result.push(result[result.length - 1] - result[result.length - 1] / p + arr[i]);
    }
    return result;
  };

  const sTR = smooth(tr, period);
  const sPDM = smooth(plusDM, period);
  const sMDM = smooth(minusDM, period);
  const pdi = sPDM.map((value, i) => (sTR[i] > 0 ? (value / sTR[i]) * 100 : 0));
  const mdi = sMDM.map((value, i) => (sTR[i] > 0 ? (value / sTR[i]) * 100 : 0));
  const dx = pdi.map((p, i) =>
    p + mdi[i] > 0 ? (Math.abs(p - mdi[i]) / (p + mdi[i])) * 100 : 0
  );

  const adxS = smooth(dx, period);
  const last = adxS.length > 0 ? adxS[adxS.length - 1] / period : 25;

  return {
    adx: last,
    pdi: pdi.length > 0 ? pdi[pdi.length - 1] : 0,
    mdi: mdi.length > 0 ? mdi[mdi.length - 1] : 0,
    trending: last > 25,
    strongTrend: last > 40
  };
}

export function volumeConfirmation(volumes, lookback = 20) {
  const n = volumes.length;
  const avg = volumes
    .slice(Math.max(0, n - lookback), n)
    .reduce((a, b) => a + b, 0) / Math.min(lookback, n);
  const cur = volumes[n - 1];
  const ratio = avg > 0 ? cur / avg : 1;
  return {
    ratio,
    isAboveAverage: ratio > 1.0,
    isSignificant: ratio > 1.5,
    isClimax: ratio > 3.0,
    score: ratio > 2.0 ? 2 : ratio > 1.2 ? 1 : 0
  };
}

export function detectLiquidityTrap(price, closes, srLevels, highs = [], lows = []) {
  const recentCloses = closes.slice(-5);
  const recentLows = lows.length ? lows.slice(-5) : recentCloses;
  const recentHighs = highs.length ? highs.slice(-5) : recentCloses;

  const brokeAbove = srLevels.resistances.some((resistance) =>
    recentHighs.some((high) => high > resistance)
  );
  const closedBelow = srLevels.resistances.some((resistance) => price < resistance);

  const brokeBelow = srLevels.supports.some((support) =>
    recentLows.some((low) => low < support)
  );
  const closedAbove = srLevels.supports.some((support) => price > support);

  const significantBreakBelow = srLevels.supports.some((support) =>
    recentLows.some((low) => low < support * 0.997)
  );
  const significantBreakAbove = srLevels.resistances.some((resistance) =>
    recentHighs.some((high) => high > resistance * 1.003)
  );

  if (brokeAbove && closedBelow && significantBreakAbove) return "bull-trap";
  if (brokeBelow && closedAbove && significantBreakBelow) return "bear-trap";
  return "none";
}
