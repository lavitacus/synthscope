/* SynthScope strategies, combined signal and backtester.
   Depends on Ind (indicators.js). */
(function (root) {
  'use strict';
  const Ind = root.Ind || (typeof require !== 'undefined' ? require('./indicators.js') : null);

  const WARMUP = 210; // enough candles for EMA 200 and ADX to settle

  function compute(candles) {
    const o = candles.map(c => c.open), h = candles.map(c => c.high),
      l = candles.map(c => c.low), c = candles.map(c => c.close);
    return {
      n: c.length, open: o, high: h, low: l, close: c,
      time: candles.map(x => x.epoch),
      ema9: Ind.ema(c, 9), ema21: Ind.ema(c, 21), ema50: Ind.ema(c, 50), ema200: Ind.ema(c, 200),
      rsi: Ind.rsi(c, 14), macd: Ind.macd(c), bb: Ind.bollinger(c, 20, 2),
      stoch: Ind.stochastic(h, l, c), adx: Ind.adx(h, l, c, 14),
      st: Ind.supertrend(h, l, c, 10, 3), atr: Ind.atr(h, l, c, 14)
    };
  }

  const ok = (...v) => v.every(x => x !== null && x !== undefined && !Number.isNaN(x));
  const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;

  // Each strategy: state = current lean (-1 sell, 0 none, 1 buy), event = fresh signal on that candle
  const STRATEGIES = [
    {
      id: 'ema_cross', name: 'EMA 9/21 cross', kind: 'trend',
      about: 'Buy when the fast EMA crosses above the slow EMA, sell on the cross down.',
      state(S, i) { return ok(S.ema9[i], S.ema21[i]) ? sign(S.ema9[i] - S.ema21[i]) : 0; },
      event(S, i) {
        if (i < 1 || !ok(S.ema9[i], S.ema21[i], S.ema9[i - 1], S.ema21[i - 1])) return 0;
        const a = S.ema9[i - 1] - S.ema21[i - 1], b = S.ema9[i] - S.ema21[i];
        return a <= 0 && b > 0 ? 1 : a >= 0 && b < 0 ? -1 : 0;
      },
      reading(S, i) { return ok(S.ema9[i], S.ema21[i]) ? (S.ema9[i] > S.ema21[i] ? 'Fast above slow' : 'Fast below slow') : '-'; }
    },
    {
      id: 'trend_200', name: 'EMA 50/200 trend', kind: 'trend',
      about: 'Long-term trend filter. Buy when price and EMA 50 are above EMA 200.',
      state(S, i) {
        if (!ok(S.ema50[i], S.ema200[i])) return 0;
        const c = S.close[i];
        if (c > S.ema200[i] && S.ema50[i] > S.ema200[i]) return 1;
        if (c < S.ema200[i] && S.ema50[i] < S.ema200[i]) return -1;
        return 0;
      },
      event(S, i) { if (i < 1) return 0; const a = this.state(S, i - 1), b = this.state(S, i); return b !== 0 && a !== b ? b : 0; },
      reading(S, i) { return ok(S.ema200[i]) ? (S.close[i] > S.ema200[i] ? 'Above EMA 200' : 'Below EMA 200') : '-'; }
    },
    {
      id: 'supertrend', name: 'Supertrend 10/3', kind: 'trend',
      about: 'ATR-based trailing line. Signals when price flips across it.',
      state(S, i) { return S.st.dir[i] || 0; },
      event(S, i) { if (i < 1 || !S.st.dir[i] || !S.st.dir[i - 1]) return 0; return S.st.dir[i] !== S.st.dir[i - 1] ? S.st.dir[i] : 0; },
      reading(S, i) { return S.st.dir[i] === 1 ? 'Up' : S.st.dir[i] === -1 ? 'Down' : '-'; }
    },
    {
      id: 'macd_cross', name: 'MACD 12/26/9', kind: 'trend',
      about: 'Buy when the MACD line crosses above its signal line.',
      state(S, i) { return ok(S.macd.hist[i]) ? sign(S.macd.hist[i]) : 0; },
      event(S, i) {
        if (i < 1 || !ok(S.macd.hist[i], S.macd.hist[i - 1])) return 0;
        const a = S.macd.hist[i - 1], b = S.macd.hist[i];
        return a <= 0 && b > 0 ? 1 : a >= 0 && b < 0 ? -1 : 0;
      },
      reading(S, i) { return ok(S.macd.hist[i]) ? 'Hist ' + fmt(S.macd.hist[i]) : '-'; }
    },
    {
      id: 'rsi_rev', name: 'RSI 14 reversal', kind: 'osc',
      about: 'Buy when RSI climbs back above 30, sell when it drops back below 70.',
      state(S, i) { const r = S.rsi[i]; return !ok(r) ? 0 : r < 30 ? 1 : r > 70 ? -1 : 0; },
      event(S, i) {
        if (i < 1 || !ok(S.rsi[i], S.rsi[i - 1])) return 0;
        const a = S.rsi[i - 1], b = S.rsi[i];
        return a < 30 && b >= 30 ? 1 : a > 70 && b <= 70 ? -1 : 0;
      },
      reading(S, i) { return ok(S.rsi[i]) ? S.rsi[i].toFixed(1) : '-'; }
    },
    {
      id: 'bb_rev', name: 'Bollinger 20/2 bounce', kind: 'osc',
      about: 'Buy when price closes back inside the lower band, sell from the upper band.',
      state(S, i) { if (!ok(S.bb.lower[i])) return 0; const c = S.close[i]; return c < S.bb.lower[i] ? 1 : c > S.bb.upper[i] ? -1 : 0; },
      event(S, i) {
        if (i < 1 || !ok(S.bb.lower[i], S.bb.lower[i - 1])) return 0;
        const p = S.close[i - 1], c = S.close[i];
        if (p < S.bb.lower[i - 1] && c >= S.bb.lower[i]) return 1;
        if (p > S.bb.upper[i - 1] && c <= S.bb.upper[i]) return -1;
        return 0;
      },
      reading(S, i) {
        if (!ok(S.bb.lower[i])) return '-';
        const w = S.bb.upper[i] - S.bb.lower[i];
        return w ? '%B ' + ((S.close[i] - S.bb.lower[i]) / w * 100).toFixed(0) : '-';
      }
    },
    {
      id: 'stoch_cross', name: 'Stochastic 14/3/3', kind: 'osc',
      about: 'Buy on a %K/%D cross up below 20, sell on a cross down above 80.',
      state(S, i) { const k = S.stoch.k[i]; return !ok(k) ? 0 : k < 20 ? 1 : k > 80 ? -1 : 0; },
      event(S, i) {
        if (i < 1 || !ok(S.stoch.k[i], S.stoch.d[i], S.stoch.k[i - 1], S.stoch.d[i - 1])) return 0;
        const a = S.stoch.k[i - 1] - S.stoch.d[i - 1], b = S.stoch.k[i] - S.stoch.d[i];
        if (a <= 0 && b > 0 && S.stoch.k[i] < 20) return 1;
        if (a >= 0 && b < 0 && S.stoch.k[i] > 80) return -1;
        return 0;
      },
      reading(S, i) { return ok(S.stoch.k[i]) ? '%K ' + S.stoch.k[i].toFixed(0) : '-'; }
    }
  ];

  // Combined score from -100 to 100. ADX decides whether trend tools or oscillators count more.
  function regime(S, i) {
    const a = S.adx.adx[i];
    if (!ok(a)) return { name: 'Unknown', trendW: 1, oscW: 1 };
    if (a >= 25) return { name: 'Trending', trendW: 1.5, oscW: 0.5, adx: a };
    if (a < 20) return { name: 'Ranging', trendW: 0.5, oscW: 1.5, adx: a };
    return { name: 'Mixed', trendW: 1, oscW: 1, adx: a };
  }

  function score(S, i) {
    const r = regime(S, i);
    let sum = 0, wsum = 0;
    for (const st of STRATEGIES) {
      const w = st.kind === 'trend' ? r.trendW : r.oscW;
      sum += w * st.state(S, i); wsum += w;
    }
    return wsum ? Math.round(100 * sum / wsum) : 0;
  }

  function makeConfluence(threshold) {
    return {
      id: 'confluence', name: 'Combined signal', kind: 'combo',
      about: 'Weighted vote of all seven tools, adjusted for trending or ranging conditions (ADX).',
      state(S, i) { if (i < WARMUP) return 0; const s = score(S, i); return s >= threshold ? 1 : s <= -threshold ? -1 : 0; },
      event(S, i) { if (i < WARMUP + 1) return 0; const a = this.state(S, i - 1), b = this.state(S, i); return b !== 0 && a !== b ? b : 0; },
      reading(S, i) { return String(score(S, i)); }
    };
  }

  function allStrategies(threshold = 50) { return STRATEGIES.concat([makeConfluence(threshold)]); }

  // Snapshot at candle i (normally the last closed candle)
  function snapshot(S, i, threshold = 50) {
    const strats = allStrategies(threshold);
    const combo = strats[strats.length - 1];
    const sc = score(S, i);
    let lastEvent = 0, barsAgo = null;
    for (let k = i; k > Math.max(WARMUP, i - 50); k--) { const e = combo.event(S, k); if (e) { lastEvent = e; barsAgo = i - k; break; } }
    return {
      score: sc, signal: combo.state(S, i), regime: regime(S, i), lastEvent, barsAgo,
      price: S.close[i], atr: S.atr[i],
      parts: STRATEGIES.map(st => ({ id: st.id, name: st.name, kind: st.kind, state: st.state(S, i), reading: st.reading(S, i) }))
    };
  }

  /* Backtest one strategy.
     Entry at the close of the signal candle, exit at the close h candles later.
     Trades never overlap. Chance level is what you would win by taking the same
     direction at random candles, which matters on Boom/Crash where price drifts. */
  function backtest(S, strat, h = 5) {
    const n = S.n, start = WARMUP, end = n - 1 - h;
    if (end <= start) return null;
    let up = 0, down = 0, total = 0;
    for (let i = start; i <= end; i++) {
      const d = S.close[i + h] - S.close[i];
      if (d > 0) up++; else if (d < 0) down++;
      total++;
    }
    const pUp = up / total, pDown = down / total;
    const trades = [];
    for (let i = start; i <= end; i++) {
      const e = strat.event(S, i);
      if (!e) continue;
      const move = (S.close[i + h] - S.close[i]) * e;
      const a = S.atr[i] || 0;
      trades.push({ i, dir: e, win: move > 0, p: e === 1 ? pUp : pDown, atrMove: a ? move / a : 0 });
      i += h - 1; // skip ahead so trades do not overlap
    }
    const mid = start + (end - start) / 2;
    const half = list => {
      if (!list.length) return { n: 0, edge: 0 };
      const w = list.filter(t => t.win).length, ex = list.reduce((s, t) => s + t.p, 0);
      return { n: list.length, edge: (w - ex) / list.length };
    };
    const N = trades.length;
    const W = trades.filter(t => t.win).length;
    const E = trades.reduce((s, t) => s + t.p, 0);
    const V = trades.reduce((s, t) => s + t.p * (1 - t.p), 0);
    const z = V > 0 ? (W - E) / Math.sqrt(V) : 0;
    const avgAtr = N ? trades.reduce((s, t) => s + t.atrMove, 0) / N : 0;
    const h1 = half(trades.filter(t => t.i < mid)), h2 = half(trades.filter(t => t.i >= mid));
    const res = {
      strategy: strat.id, name: strat.name, horizon: h, trades: N, wins: W,
      winRate: N ? W / N : 0, chance: N ? E / N : 0, edge: N ? (W - E) / N : 0,
      z, avgAtr, half1: h1.edge, half2: h2.edge, candles: n
    };
    res.verdict = verdict(res);
    return res;
  }

  function verdict(r) {
    if (r.trades < 30) return { code: 'few', label: 'Too few trades' };
    if (r.z >= 3 && r.avgAtr <= 0) return { code: 'trap', label: 'Wins often, loses big' };
    if (r.z >= 3 && r.half1 > 0 && r.half2 > 0 && r.avgAtr > 0) return { code: 'edge', label: 'Possible edge' };
    if (r.z >= 2) return { code: 'weak', label: 'Weak, likely luck' };
    if (r.z <= -2) return { code: 'worse', label: 'Worse than chance' };
    return { code: 'none', label: 'No edge' };
  }

  function backtestAll(S, h = 5, threshold = 50) {
    return allStrategies(threshold).map(st => backtest(S, st, h)).filter(Boolean);
  }

  function fmt(x) {
    const a = Math.abs(x);
    return a >= 100 ? x.toFixed(1) : a >= 1 ? x.toFixed(3) : x.toPrecision(3);
  }

  const api = { compute, STRATEGIES, allStrategies, score, regime, snapshot, backtest, backtestAll, WARMUP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Strat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
