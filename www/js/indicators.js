/* SynthScope indicator library.
   Pure functions over arrays of numbers. Each returns an array the same
   length as the input, with null where there is not enough data yet. */
(function (root) {
  'use strict';

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let prev = 0;
    for (let i = 0; i < period; i++) prev += values[i];
    prev /= period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // EMA over a series that starts with nulls (used for MACD signal line)
  function emaSparse(values, period) {
    const out = new Array(values.length).fill(null);
    const first = values.findIndex(v => v !== null);
    if (first < 0) return out;
    const sub = ema(values.slice(first), period);
    for (let i = 0; i < sub.length; i++) out[first + i] = sub[i];
    return out;
  }

  // Wilder's RSI
  function rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const line = closes.map((_, i) => (ef[i] !== null && es[i] !== null) ? ef[i] - es[i] : null);
    const sig = emaSparse(line, signal);
    const hist = line.map((v, i) => (v !== null && sig[i] !== null) ? v - sig[i] : null);
    return { line, signal: sig, hist };
  }

  function bollinger(closes, period = 20, mult = 2) {
    const mid = sma(closes, period);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / period);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
    }
    return { mid, upper, lower };
  }

  function stochastic(highs, lows, closes, kPeriod = 14, kSmooth = 3, dPeriod = 3) {
    const raw = new Array(closes.length).fill(null);
    for (let i = kPeriod - 1; i < closes.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
      raw[i] = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
    }
    const k = smaSparse(raw, kSmooth);
    const d = smaSparse(k, dPeriod);
    return { k, d };
  }

  function smaSparse(values, period) {
    const out = new Array(values.length).fill(null);
    const first = values.findIndex(v => v !== null);
    if (first < 0) return out;
    const sub = sma(values.slice(first), period);
    for (let i = 0; i < sub.length; i++) out[first + i] = sub[i];
    return out;
  }

  function trueRange(highs, lows, closes) {
    return closes.map((c, i) => i === 0 ? highs[0] - lows[0]
      : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }

  // Wilder smoothing
  function wilder(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let s = 0;
    for (let i = 0; i < period; i++) s += values[i];
    s /= period; out[period - 1] = s;
    for (let i = period; i < values.length; i++) { s = (s * (period - 1) + values[i]) / period; out[i] = s; }
    return out;
  }

  function atr(highs, lows, closes, period = 14) {
    return wilder(trueRange(highs, lows, closes), period);
  }

  function adx(highs, lows, closes, period = 14) {
    const n = closes.length;
    const out = { adx: new Array(n).fill(null), plusDI: new Array(n).fill(null), minusDI: new Array(n).fill(null) };
    if (n < period * 2 + 1) return out;
    const tr = trueRange(highs, lows, closes);
    const pdm = new Array(n).fill(0), mdm = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
      pdm[i] = (up > down && up > 0) ? up : 0;
      mdm[i] = (down > up && down > 0) ? down : 0;
    }
    // Wilder sums starting at index 1
    let trS = 0, pS = 0, mS = 0;
    for (let i = 1; i <= period; i++) { trS += tr[i]; pS += pdm[i]; mS += mdm[i]; }
    const dx = new Array(n).fill(null);
    for (let i = period; i < n; i++) {
      if (i > period) { trS = trS - trS / period + tr[i]; pS = pS - pS / period + pdm[i]; mS = mS - mS / period + mdm[i]; }
      const p = trS ? 100 * pS / trS : 0, m = trS ? 100 * mS / trS : 0;
      out.plusDI[i] = p; out.minusDI[i] = m;
      dx[i] = (p + m) ? 100 * Math.abs(p - m) / (p + m) : 0;
    }
    let a = 0;
    for (let i = period; i < period * 2; i++) a += dx[i];
    a /= period; out.adx[period * 2 - 1] = a;
    for (let i = period * 2; i < n; i++) { a = (a * (period - 1) + dx[i]) / period; out.adx[i] = a; }
    return out;
  }

  function supertrend(highs, lows, closes, period = 10, mult = 3) {
    const n = closes.length;
    const a = atr(highs, lows, closes, period);
    const line = new Array(n).fill(null), dir = new Array(n).fill(null);
    let fu = null, fl = null, d = 1;
    for (let i = 0; i < n; i++) {
      if (a[i] === null) continue;
      const hl2 = (highs[i] + lows[i]) / 2;
      const bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
      if (fu === null) { fu = bu; fl = bl; d = closes[i] >= hl2 ? 1 : -1; }
      else {
        fu = (bu < fu || closes[i - 1] > fu) ? bu : fu;
        fl = (bl > fl || closes[i - 1] < fl) ? bl : fl;
        if (d === -1 && closes[i] > fu) d = 1;
        else if (d === 1 && closes[i] < fl) d = -1;
      }
      dir[i] = d;
      line[i] = d === 1 ? fl : fu;
    }
    return { line, dir };
  }

  const api = { sma, ema, rsi, macd, bollinger, stochastic, atr, adx, supertrend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Ind = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
