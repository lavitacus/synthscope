/* SynthScope strategy engine v2.
   Strategy library (5 researched setups + 7 classic tools + combined score),
   trade plans with entry, stop loss and take profit, a backtester that uses
   those plans, and live recommendations of the best strategy per market.
   Depends on Ind (indicators.js). */
(function (root) {
  'use strict';
  const Ind = root.Ind || (typeof require !== 'undefined' ? require('./indicators.js') : null);

  const WARMUP = 210;        // candles needed before EMA 200 and ADX settle
  const MIN_TRADES = 20;     // fewer trades than this is not enough to judge
  const TP1_R = 1.5, TP2_R = 3; // take profits as multiples of the risk

  // ---------- market families ----------
  function family(sym, name) {
    const s = String(name || '').toLowerCase(), y = String(sym || '');
    if (/boom/.test(s) || /^BOOM/i.test(y)) return 'boom';
    if (/crash/.test(s) || /^CRASH/i.test(y)) return 'crash';
    if (/jump/.test(s) || /^JD/i.test(y)) return 'jump';
    if (/step/.test(s) || /^stp/i.test(y)) return 'step';
    if (/range break/.test(s) || /^RDB/i.test(y)) return 'range';
    if (/drift/.test(s) || /^DSI/i.test(y)) return 'drift';
    if (/volatility/.test(s) || /^R_|^1HZ/i.test(y)) return 'volatility';
    return 'other';
  }
  const FAMILY_LABEL = { boom: 'Boom', crash: 'Crash', jump: 'Jump', step: 'Step', range: 'Range Break', drift: 'Drift Switch', volatility: 'Volatility', other: 'Other' };

  // Boom only spikes up and Crash only spikes down, so trade with the spike
  function allowed(fam, dir, spikeOnly) {
    if (!spikeOnly) return true;
    if (fam === 'boom') return dir === 1;
    if (fam === 'crash') return dir === -1;
    return true;
  }

  // ---------- indicator bundle ----------
  function compute(candles) {
    const o = candles.map(c => c.open), h = candles.map(c => c.high),
      l = candles.map(c => c.low), c = candles.map(c => c.close);
    return {
      n: c.length, open: o, high: h, low: l, close: c, time: candles.map(x => x.epoch),
      ema5: Ind.ema(c, 5), ema9: Ind.ema(c, 9), ema15: Ind.ema(c, 15), ema21: Ind.ema(c, 21),
      ema50: Ind.ema(c, 50), ema55: Ind.ema(c, 55), ema89: Ind.ema(c, 89), ema200: Ind.ema(c, 200),
      rsi: Ind.rsi(c, 14), macd: Ind.macd(c), bb: Ind.bollinger(c, 20, 2),
      stoch: Ind.stochastic(h, l, c), adx: Ind.adx(h, l, c, 14),
      st: Ind.supertrend(h, l, c, 10, 3), atr: Ind.atr(h, l, c, 14)
    };
  }

  const ok = (...v) => v.every(x => x !== null && x !== undefined && !Number.isNaN(x));
  const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;
  const bull = (S, i) => S.close[i] > S.open[i];
  const bear = (S, i) => S.close[i] < S.open[i];
  // event fires on the candle where a two-sided condition first becomes true
  const edgeOf = (cond, S, i) => {
    if (i < 1) return 0;
    const b = cond(S, i); if (!b) return 0;
    return cond(S, i - 1) === b ? 0 : b;
  };
  const fmt = x => { const a = Math.abs(x); return a >= 100 ? x.toFixed(1) : a >= 1 ? x.toFixed(3) : x.toPrecision(3); };

  // ---------- the 5 researched strategies ----------
  const PRESETS = [
    {
      id: 'rsi50_ma21', rank: 1, name: 'RSI 50 + MA 21 Momentum', kind: 'trend', group: 'preset',
      bestFor: ['volatility', 'jump', 'step', 'drift'],
      source: 'Most shared Volatility 75 setup (YouTube strategy guides)',
      rules: 'BUY when RSI 14 is above 50 and price closes above the 21 EMA. SELL when RSI is below 50 and price closes below it.',
      cond(S, i) {
        if (!ok(S.rsi[i], S.ema21[i])) return 0;
        if (S.rsi[i] > 50 && S.close[i] > S.ema21[i]) return 1;
        if (S.rsi[i] < 50 && S.close[i] < S.ema21[i]) return -1;
        return 0;
      },
      state(S, i) { return this.cond(S, i); },
      event(S, i) { return edgeOf(this.cond.bind(this), S, i); },
      reading(S, i) { return ok(S.rsi[i]) ? 'RSI ' + S.rsi[i].toFixed(0) + (S.close[i] > S.ema21[i] ? ', above MA 21' : ', below MA 21') : '-'; }
    },
    {
      id: 'spike_rider', rank: 2, name: 'Spike Rider (EMA 200 + RSI 14)', kind: 'osc', group: 'preset',
      bestFor: ['boom', 'crash'],
      source: 'Most cited Boom/Crash setup (Deriv community, Boom/Crash guides)',
      rules: 'BUY when price is above the 200 EMA, RSI is below 30 and two red candles in a row print. SELL is the mirror: below the 200 EMA, RSI above 70, two green candles.',
      cond(S, i) {
        if (i < 1 || !ok(S.rsi[i], S.ema200[i])) return 0;
        if (S.close[i] > S.ema200[i] && S.rsi[i] < 30 && bear(S, i) && bear(S, i - 1)) return 1;
        if (S.close[i] < S.ema200[i] && S.rsi[i] > 70 && bull(S, i) && bull(S, i - 1)) return -1;
        return 0;
      },
      state(S, i) {
        if (!ok(S.rsi[i], S.ema200[i])) return 0;
        if (S.close[i] > S.ema200[i] && S.rsi[i] < 35) return 1;
        if (S.close[i] < S.ema200[i] && S.rsi[i] > 65) return -1;
        return 0;
      },
      event(S, i) { return edgeOf(this.cond.bind(this), S, i); },
      reading(S, i) { return ok(S.rsi[i], S.ema200[i]) ? 'RSI ' + S.rsi[i].toFixed(0) + (S.close[i] > S.ema200[i] ? ', above EMA 200' : ', below EMA 200') : '-'; }
    },
    {
      id: 'spike_catcher', rank: 3, name: 'Spike Catcher (EMA 5/15 + Stochastic)', kind: 'osc', group: 'preset',
      bestFor: ['boom', 'crash', 'volatility'],
      source: 'Deriv community spike catcher and 1 minute scalping guides',
      rules: 'BUY when EMA 5 crosses above EMA 15 while Stochastic %K was below 20 in the last 3 candles. SELL when EMA 5 crosses below EMA 15 with %K above 80.',
      event(S, i) {
        if (i < 3 || !ok(S.ema5[i], S.ema15[i], S.ema5[i - 1], S.ema15[i - 1])) return 0;
        const a = S.ema5[i - 1] - S.ema15[i - 1], b = S.ema5[i] - S.ema15[i];
        const ks = [S.stoch.k[i], S.stoch.k[i - 1], S.stoch.k[i - 2]].filter(v => v !== null);
        if (!ks.length) return 0;
        if (a <= 0 && b > 0 && Math.min(...ks) < 20) return 1;
        if (a >= 0 && b < 0 && Math.max(...ks) > 80) return -1;
        return 0;
      },
      state(S, i) {
        if (!ok(S.ema5[i], S.ema15[i], S.stoch.k[i])) return 0;
        const d = sign(S.ema5[i] - S.ema15[i]);
        if (d === 1 && S.stoch.k[i] < 50) return 1;
        if (d === -1 && S.stoch.k[i] > 50) return -1;
        return 0;
      },
      reading(S, i) { return ok(S.stoch.k[i]) ? '%K ' + S.stoch.k[i].toFixed(0) + (S.ema5[i] > S.ema15[i] ? ', fast above slow' : ', fast below slow') : '-'; }
    },
    {
      id: 'triple_ema_macd', rank: 4, name: 'Triple EMA 21/55/89 + MACD', kind: 'trend', group: 'preset',
      bestFor: ['volatility', 'drift', 'step', 'jump'],
      source: 'EMA 21/55/89 trend stack (Boom/Crash guides) with the MACD trigger from the V75 scalper',
      rules: 'BUY when EMA 21 > 55 > 89, ADX is above 20 and MACD crosses above its signal line. SELL is the mirror with the EMAs stacked downward.',
      stack(S, i) {
        if (!ok(S.ema21[i], S.ema55[i], S.ema89[i])) return 0;
        if (S.ema21[i] > S.ema55[i] && S.ema55[i] > S.ema89[i]) return 1;
        if (S.ema21[i] < S.ema55[i] && S.ema55[i] < S.ema89[i]) return -1;
        return 0;
      },
      event(S, i) {
        if (i < 1 || !ok(S.macd.hist[i], S.macd.hist[i - 1], S.adx.adx[i])) return 0;
        if (S.adx.adx[i] < 20) return 0;
        const st = this.stack(S, i), a = S.macd.hist[i - 1], b = S.macd.hist[i];
        if (st === 1 && a <= 0 && b > 0) return 1;
        if (st === -1 && a >= 0 && b < 0) return -1;
        return 0;
      },
      state(S, i) { const st = this.stack(S, i); return st && ok(S.macd.hist[i]) && sign(S.macd.hist[i]) === st ? st : 0; },
      reading(S, i) { const st = this.stack(S, i); return st === 1 ? 'EMAs stacked up' : st === -1 ? 'EMAs stacked down' : 'EMAs mixed'; }
    },
    {
      id: 'ema50_pullback', rank: 5, name: 'EMA 50 Pullback', kind: 'trend', group: 'preset',
      bestFor: ['volatility', 'step', 'boom', 'crash'],
      source: 'Moving-average pullback with a rejection candle (Boom/Crash and V75 guides)',
      rules: 'BUY when the 50 EMA is rising, price dips to touch it and a green rejection candle closes back above it with a lower wick at least as long as its body. SELL is the mirror.',
      event(S, i) {
        if (i < 5 || !ok(S.ema50[i], S.ema50[i - 5], S.atr[i])) return 0;
        const e = S.ema50[i], a = S.atr[i], o = S.open[i], c = S.close[i], hi = S.high[i], lo = S.low[i];
        const body = Math.abs(c - o);
        const rising = e > S.ema50[i - 5], falling = e < S.ema50[i - 5];
        if (rising && lo <= e + 0.25 * a && c > e && c > o && (Math.min(o, c) - lo) >= body) return 1;
        if (falling && hi >= e - 0.25 * a && c < e && c < o && (hi - Math.max(o, c)) >= body) return -1;
        return 0;
      },
      state(S, i) {
        if (i < 5 || !ok(S.ema50[i], S.ema50[i - 5])) return 0;
        if (S.ema50[i] > S.ema50[i - 5] && S.close[i] > S.ema50[i]) return 1;
        if (S.ema50[i] < S.ema50[i - 5] && S.close[i] < S.ema50[i]) return -1;
        return 0;
      },
      reading(S, i) { return ok(S.ema50[i]) ? (S.close[i] > S.ema50[i] ? 'Above EMA 50' : 'Below EMA 50') : '-'; }
    }
  ];

  // ---------- the 7 classic tools ----------
  const CLASSIC = [
    {
      id: 'ema_cross', name: 'EMA 9/21 cross', kind: 'trend', group: 'classic', bestFor: ['volatility', 'step'],
      rules: 'BUY when EMA 9 crosses above EMA 21, SELL on the cross down.',
      state(S, i) { return ok(S.ema9[i], S.ema21[i]) ? sign(S.ema9[i] - S.ema21[i]) : 0; },
      event(S, i) {
        if (i < 1 || !ok(S.ema9[i], S.ema21[i], S.ema9[i - 1], S.ema21[i - 1])) return 0;
        const a = S.ema9[i - 1] - S.ema21[i - 1], b = S.ema9[i] - S.ema21[i];
        return a <= 0 && b > 0 ? 1 : a >= 0 && b < 0 ? -1 : 0;
      },
      reading(S, i) { return ok(S.ema9[i], S.ema21[i]) ? (S.ema9[i] > S.ema21[i] ? 'Fast above slow' : 'Fast below slow') : '-'; }
    },
    {
      id: 'trend_200', name: 'EMA 50/200 trend', kind: 'trend', group: 'classic', bestFor: ['volatility', 'drift'],
      rules: 'BUY when price and EMA 50 move above EMA 200, SELL when both move below.',
      state(S, i) {
        if (!ok(S.ema50[i], S.ema200[i])) return 0;
        const c = S.close[i];
        if (c > S.ema200[i] && S.ema50[i] > S.ema200[i]) return 1;
        if (c < S.ema200[i] && S.ema50[i] < S.ema200[i]) return -1;
        return 0;
      },
      event(S, i) { return edgeOf(this.state.bind(this), S, i); },
      reading(S, i) { return ok(S.ema200[i]) ? (S.close[i] > S.ema200[i] ? 'Above EMA 200' : 'Below EMA 200') : '-'; }
    },
    {
      id: 'supertrend', name: 'Supertrend 10/3', kind: 'trend', group: 'classic', bestFor: ['volatility', 'jump'],
      rules: 'Signals when price flips across the ATR trailing line.',
      state(S, i) { return S.st.dir[i] || 0; },
      event(S, i) { if (i < 1 || !S.st.dir[i] || !S.st.dir[i - 1]) return 0; return S.st.dir[i] !== S.st.dir[i - 1] ? S.st.dir[i] : 0; },
      reading(S, i) { return S.st.dir[i] === 1 ? 'Up' : S.st.dir[i] === -1 ? 'Down' : '-'; }
    },
    {
      id: 'macd_cross', name: 'MACD 12/26/9', kind: 'trend', group: 'classic', bestFor: ['volatility'],
      rules: 'BUY when the MACD line crosses above its signal line, SELL on the cross down.',
      state(S, i) { return ok(S.macd.hist[i]) ? sign(S.macd.hist[i]) : 0; },
      event(S, i) {
        if (i < 1 || !ok(S.macd.hist[i], S.macd.hist[i - 1])) return 0;
        const a = S.macd.hist[i - 1], b = S.macd.hist[i];
        return a <= 0 && b > 0 ? 1 : a >= 0 && b < 0 ? -1 : 0;
      },
      reading(S, i) { return ok(S.macd.hist[i]) ? 'Hist ' + fmt(S.macd.hist[i]) : '-'; }
    },
    {
      id: 'rsi_rev', name: 'RSI 14 reversal', kind: 'osc', group: 'classic', bestFor: ['volatility', 'step'],
      rules: 'BUY when RSI climbs back above 30, SELL when it drops back below 70.',
      state(S, i) { const r = S.rsi[i]; return !ok(r) ? 0 : r < 30 ? 1 : r > 70 ? -1 : 0; },
      event(S, i) {
        if (i < 1 || !ok(S.rsi[i], S.rsi[i - 1])) return 0;
        const a = S.rsi[i - 1], b = S.rsi[i];
        return a < 30 && b >= 30 ? 1 : a > 70 && b <= 70 ? -1 : 0;
      },
      reading(S, i) { return ok(S.rsi[i]) ? S.rsi[i].toFixed(1) : '-'; }
    },
    {
      id: 'bb_rev', name: 'Bollinger 20/2 bounce', kind: 'osc', group: 'classic', bestFor: ['step', 'range'],
      rules: 'BUY when price closes back inside the lower band, SELL from the upper band.',
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
      id: 'stoch_cross', name: 'Stochastic 14/3/3', kind: 'osc', group: 'classic', bestFor: ['step', 'range'],
      rules: 'BUY on a %K/%D cross up below 20, SELL on a cross down above 80.',
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

  // ---------- combined score of the classic tools ----------
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
    for (const st of CLASSIC) { const w = st.kind === 'trend' ? r.trendW : r.oscW; sum += w * st.state(S, i); wsum += w; }
    return wsum ? Math.round(100 * sum / wsum) : 0;
  }
  function makeCombined(threshold) {
    return {
      id: 'combined', name: 'Combined score', kind: 'combo', group: 'combo', bestFor: [],
      rules: 'Weighted vote of the 7 classic tools. ADX gives trend tools more weight in trends and oscillators more weight in ranges.',
      state(S, i) { if (i < WARMUP) return 0; const s = score(S, i); return s >= threshold ? 1 : s <= -threshold ? -1 : 0; },
      event(S, i) { if (i < WARMUP + 1) return 0; return edgeOf(this.state.bind(this), S, i); },
      reading(S, i) { return 'Score ' + score(S, i); }
    };
  }

  function library(threshold = 50) { return PRESETS.concat(CLASSIC, [makeCombined(threshold)]); }
  function byId(id, threshold = 50) { return library(threshold).find(s => s.id === id); }

  // ---------- trade plan ----------
  /* Smart mix stop: the nearest swing low/high of the last 10 candles when it sits
     between 0.8 and 3 ATR away, otherwise 1.5 ATR. TP1 = 1.5x risk, TP2 = 3x risk. */
  function plan(S, i, dir, entry) {
    const a = S.atr[i];
    if (!ok(a) || !a || !dir) return null;
    const e = entry === undefined ? S.close[i] : entry;
    let lo = Infinity, hi = -Infinity;
    for (let k = Math.max(0, i - 9); k <= i; k++) { if (S.low[k] < lo) lo = S.low[k]; if (S.high[k] > hi) hi = S.high[k]; }
    const swing = dir === 1 ? e - (lo - 0.2 * a) : (hi + 0.2 * a) - e;
    let dist, method;
    if (swing >= 0.8 * a && swing <= 3 * a) { dist = swing; method = 'swing'; }
    else { dist = 1.5 * a; method = 'atr'; }
    return { dir, entry: e, sl: e - dir * dist, tp1: e + dir * TP1_R * dist, tp2: e + dir * TP2_R * dist, dist, method, atr: a };
  }

  // Position size for a given balance and risk percent. MT5 lots assume contract size 1.
  function sizing(p, balance, riskPct) {
    if (!p || !(balance > 0) || !(riskPct > 0)) return null;
    const risk = balance * riskPct / 100;
    return { risk, lots: risk / p.dist };
  }

  // Simulate one trade from candle i: exits at stop, TP1, or after maxHold candles
  function simulate(S, i, p, maxHold) {
    const last = Math.min(S.n - 1, i + maxHold);
    for (let j = i + 1; j <= last; j++) {
      const o = S.open[j], hi = S.high[j], lo = S.low[j];
      if (p.dir === 1) {
        if (o <= p.sl) return { j, exit: o, how: 'gap' };      // price jumped past the stop
        if (lo <= p.sl) return { j, exit: p.sl, how: 'sl' };  // stop first if both are touched
        if (hi >= p.tp1) return { j, exit: p.tp1, how: 'tp' };
      } else {
        if (o >= p.sl) return { j, exit: o, how: 'gap' };
        if (hi >= p.sl) return { j, exit: p.sl, how: 'sl' };
        if (lo <= p.tp1) return { j, exit: p.tp1, how: 'tp' };
      }
    }
    return { j: last, exit: S.close[last], how: 'time' };
  }

  /* What random entries earn with the same stops and targets. This is the chance
     level each strategy has to beat, and it captures drift on Boom and Crash. */
  function baseline(S, maxHold) {
    const key = 'base' + maxHold;
    if (S[key]) return S[key];
    const out = {};
    for (const dir of [1, -1]) {
      let sum = 0, n = 0, wins = 0;
      for (let i = WARMUP; i < S.n - 2; i += 3) {
        const p = plan(S, i, dir); if (!p) continue;
        const r = simulate(S, i, p, maxHold);
        const R = dir * (r.exit - p.entry) / p.dist;
        sum += R; n++; if (R > 0) wins++;
      }
      out[dir] = n ? { R: sum / n, win: wins / n, n } : { R: 0, win: 0, n: 0 };
    }
    S[key] = out;
    return out;
  }

  function backtest(S, strat, opts = {}) {
    const fam = opts.family || 'other', spikeOnly = opts.spikeOnly !== false, maxHold = opts.maxHold || 50;
    if (S.n < WARMUP + 30) return null;
    const base = baseline(S, maxHold);
    // Chance = a coin-flip trader allowed the same directions (only buys on Boom, only sells on Crash)
    const dirs = [1, -1].filter(d => allowed(fam, d, spikeOnly));
    const chance = { R: dirs.reduce((s, d) => s + base[d].R, 0) / dirs.length, win: dirs.reduce((s, d) => s + base[d].win, 0) / dirs.length };
    const trades = [];
    for (let i = WARMUP; i < S.n - 2; i++) {
      const d = strat.event(S, i);
      if (!d || !allowed(fam, d, spikeOnly)) continue;
      const p = plan(S, i, d); if (!p) continue;
      const r = simulate(S, i, p, maxHold);
      const R = d * (r.exit - p.entry) / p.dist;
      trades.push({ i, j: r.j, dir: d, R, how: r.how, base: chance.R });
      i = r.j; // no overlapping trades
    }
    const N = trades.length;
    const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    const Rs = trades.map(t => t.R);
    const avgR = mean(Rs), baseR = mean(trades.map(t => t.base));
    const sd = N > 1 ? Math.sqrt(Rs.reduce((s, x) => s + (x - avgR) ** 2, 0) / (N - 1)) : 0;
    const edge = avgR - baseR;
    const z = N > 1 ? edge / (Math.max(sd, 0.5) / Math.sqrt(N)) : 0; // floor stops tiny samples looking certain
    const mid = WARMUP + (S.n - WARMUP) / 2;
    const half = list => list.length ? mean(list.map(t => t.R - t.base)) : 0;
    const wins = trades.filter(t => t.R > 0).length;
    const baseWin = chance.win;
    const res = {
      strategy: strat.id, name: strat.name, group: strat.group, trades: N, wins,
      winRate: N ? wins / N : 0, baseWin, avgR, baseR, edge, z, totalR: Rs.reduce((s, x) => s + x, 0),
      half1: half(trades.filter(t => t.i < mid)), half2: half(trades.filter(t => t.i >= mid)),
      gaps: trades.filter(t => t.how === 'gap').length, candles: S.n
    };
    res.verdict = verdict(res);
    res.score = edgeScore(res);
    return res;
  }

  // zAdj (set by recommend) is z corrected for picking among strategies; it only shrinks good results
  function verdict(r) {
    const zg = r.zAdj === undefined ? r.z : r.zAdj;
    if (r.trades < MIN_TRADES) return { code: 'few', label: 'Too few trades' };
    if (r.winRate > r.baseWin + 0.1 && r.avgR <= 0) return { code: 'trap', label: 'Wins often, loses big' };
    if (zg >= 3 && r.half1 > 0 && r.half2 > 0 && r.avgR > 0) return { code: 'edge', label: 'Possible edge' };
    if (zg >= 2 && r.avgR > 0) return { code: 'weak', label: 'Promising, unproven' };
    if (r.z <= -2) return { code: 'worse', label: 'Worse than chance' };
    return { code: 'none', label: 'No edge' };
  }

  // 0 to 100. About 27 means chance level, 50 is a slight lean, 88+ needs z of 3.
  function edgeScore(r) {
    if (r.trades < MIN_TRADES) return 0;
    const zg = r.zAdj === undefined ? r.z : r.zAdj;
    let s = 100 / (1 + Math.exp(-(zg - 1)));
    if (!(r.half1 > 0 && r.half2 > 0)) s *= 0.7;
    if (r.avgR <= 0) s = Math.min(s, 30);
    return Math.round(s);
  }

  const scoreLabel = s => s >= 85 ? 'Strong' : s >= 65 ? 'Promising' : s >= 40 ? 'Weak' : 'No edge';

  // ---------- correction for picking the best of many ----------
  function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989422804 * Math.exp(-z * z / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z > 0 ? 1 - p : p;
  }
  function normInv(p) { // Acklam's approximation
    if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425, hi = 1 - lo;
    if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  /* Testing m strategies and keeping the best makes luck look like skill. This turns
     a z score into the z it would have been as a single test (Sidak correction). */
  function adjustZ(z, m) {
    if (m <= 1 || !Number.isFinite(z)) return z;
    const p = 1 - normCdf(z);
    if (p < 1e-12) return z - Math.sqrt(2 * Math.log(m));
    const pa = -Math.expm1(m * Math.log1p(-p));
    return -normInv(pa);
  }

  // Rank every strategy for this market, best first. Scores are corrected for
  // choosing among all strategies, so a lucky winner on random data stays low.
  function recommend(S, opts = {}) {
    const lib = library(opts.threshold || 50);
    const famBoost = st => (st.bestFor || []).includes(opts.family) ? 1 : 0;
    return lib.map(st => backtest(S, st, opts)).filter(Boolean).map(r => {
      r.zAdj = Math.max(-10, Math.min(50, adjustZ(r.z, lib.length)));
      r.verdict = verdict(r); r.score = edgeScore(r);
      return r;
    }).sort((a, b) => b.score - a.score || b.zAdj - a.zAdj || famBoost(byId(b.strategy)) - famBoost(byId(a.strategy)));
  }

  // Live read of one strategy at the last closed candle i
  function live(S, strat, i, opts = {}) {
    const fam = opts.family || 'other', spikeOnly = opts.spikeOnly !== false, fresh = opts.fresh === undefined ? 2 : opts.fresh;
    let lastDir = 0, barsAgo = null;
    for (let k = i; k > Math.max(WARMUP, i - 60); k--) {
      const d = strat.event(S, k);
      if (d && allowed(fam, d, spikeOnly)) { lastDir = d; barsAgo = i - k; break; }
    }
    const st = strat.state(S, i);
    const active = lastDir && barsAgo !== null && barsAgo <= fresh ? lastDir : 0;
    return {
      state: allowed(fam, st, spikeOnly) ? st : 0, active, lastDir, barsAgo,
      plan: active ? plan(S, i, active, S.close[S.n - 1]) : null,
      reading: strat.reading(S, i)
    };
  }

  function snapshot(S, i, threshold = 50) {
    return {
      score: score(S, i), regime: regime(S, i), price: S.close[i], atr: S.atr[i],
      parts: CLASSIC.map(st => ({ id: st.id, name: st.name, kind: st.kind, state: st.state(S, i), reading: st.reading(S, i) }))
    };
  }

  // Every strategy event in the window, for chart markers
  function events(S, strat, opts = {}) {
    const fam = opts.family || 'other', spikeOnly = opts.spikeOnly !== false, out = [];
    for (let i = WARMUP; i <= S.n - 2; i++) { const d = strat.event(S, i); if (d && allowed(fam, d, spikeOnly)) out.push({ i, dir: d }); }
    return out;
  }

  const api = {
    WARMUP, MIN_TRADES, TP1_R, TP2_R, PRESETS, CLASSIC, FAMILY_LABEL,
    family, allowed, compute, library, byId, regime, score, plan, sizing, simulate, baseline,
    backtest, recommend, live, snapshot, events, edgeScore, scoreLabel, adjustZ, normCdf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Strat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
