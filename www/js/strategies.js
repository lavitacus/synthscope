/* SynthScope strategy engine v2.2.
   Regular library (5 researched setups + 7 classic tools + combined score) and a
   Scalper library (6 one minute setups), trade plans with entry, stop loss and take
   profit, a backtester that uses those plans and pays the spread, live recommendations
   of the best strategy per market, lot and Multiplier sizing, and an account simulator.
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
    const ema20 = Ind.ema(c, 20), atr10 = Ind.atr(h, l, c, 10);
    return {
      n: c.length, open: o, high: h, low: l, close: c, time: candles.map(x => x.epoch),
      ema5: Ind.ema(c, 5), ema9: Ind.ema(c, 9), ema15: Ind.ema(c, 15), ema20, ema21: Ind.ema(c, 21),
      ema50: Ind.ema(c, 50), ema55: Ind.ema(c, 55), ema89: Ind.ema(c, 89), ema200: Ind.ema(c, 200),
      rsi: Ind.rsi(c, 14), rsi2: Ind.rsi(c, 2), rsi4: Ind.rsi(c, 4), rsi7: Ind.rsi(c, 7),
      macd: Ind.macd(c), bb: Ind.bollinger(c, 20, 2),
      stoch: Ind.stochastic(h, l, c), stoch5: Ind.stochastic(h, l, c, 5, 3, 3), adx: Ind.adx(h, l, c, 14),
      st: Ind.supertrend(h, l, c, 10, 3), atr: Ind.atr(h, l, c, 14),
      kelt: {
        upper: ema20.map((e, i) => e === null || atr10[i] === null ? null : e + 2 * atr10[i]),
        lower: ema20.map((e, i) => e === null || atr10[i] === null ? null : e - 2 * atr10[i])
      }
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

  // ---------- scalper library (1 minute candles, short holds) ----------
  // exit(S, j, dir) is an optional early exit checked at each candle close after entry.
  const SCALP = [
    {
      id: 'sc_ema_rsi', rank: 1, name: 'EMA 9/21 + RSI 7 Scalp', kind: 'trend', group: 'scalp',
      bestFor: ['volatility', 'jump', 'step'],
      source: 'The most common 1 minute scalp in Deriv V75 and DTrader scalping guides: moving average trigger with an RSI filter',
      rules: 'BUY when EMA 9 crosses above EMA 21 while price is above the 50 EMA and RSI 7 is above 50. SELL is the mirror.',
      event(S, i) {
        if (i < 1 || !ok(S.ema9[i], S.ema21[i], S.ema9[i - 1], S.ema21[i - 1], S.ema50[i], S.rsi7[i])) return 0;
        const a = S.ema9[i - 1] - S.ema21[i - 1], b = S.ema9[i] - S.ema21[i], c = S.close[i];
        if (a <= 0 && b > 0 && c > S.ema50[i] && S.rsi7[i] > 50) return 1;
        if (a >= 0 && b < 0 && c < S.ema50[i] && S.rsi7[i] < 50) return -1;
        return 0;
      },
      state(S, i) {
        if (!ok(S.ema9[i], S.ema21[i], S.ema50[i])) return 0;
        if (S.ema9[i] > S.ema21[i] && S.close[i] > S.ema50[i]) return 1;
        if (S.ema9[i] < S.ema21[i] && S.close[i] < S.ema50[i]) return -1;
        return 0;
      },
      reading(S, i) { return ok(S.rsi7[i]) ? 'RSI 7 ' + S.rsi7[i].toFixed(0) + (S.ema9[i] > S.ema21[i] ? ', 9 above 21' : ', 9 below 21') : '-'; }
    },
    {
      id: 'sc_rsi2', rank: 2, name: 'RSI 2 Snapback (Connors)', kind: 'osc', group: 'scalp',
      bestFor: ['volatility', 'step', 'range'],
      source: "Larry Connors' RSI 2 system, the best known high win rate mean reversion rule, sized down to 1 minute",
      rules: 'BUY when price is above the 200 EMA and RSI 2 drops below 10. SELL when price is below the 200 EMA and RSI 2 rises above 90. Exit when price closes back across the 5 EMA, or at the stop or target.',
      cond(S, i) {
        if (!ok(S.rsi2[i], S.ema200[i])) return 0;
        if (S.close[i] > S.ema200[i] && S.rsi2[i] < 10) return 1;
        if (S.close[i] < S.ema200[i] && S.rsi2[i] > 90) return -1;
        return 0;
      },
      event(S, i) { return edgeOf(this.cond.bind(this), S, i); },
      state(S, i) { return this.cond(S, i); },
      exit(S, j, dir) { return ok(S.ema5[j]) && (dir === 1 ? S.close[j] > S.ema5[j] : S.close[j] < S.ema5[j]); },
      reading(S, i) { return ok(S.rsi2[i]) ? 'RSI 2 ' + S.rsi2[i].toFixed(0) + (S.close[i] > S.ema200[i] ? ', above EMA 200' : ', below EMA 200') : '-'; }
    },
    {
      id: 'sc_bb_rsi4', rank: 3, name: 'Bollinger 20/2 + RSI 4 Reversal', kind: 'osc', group: 'scalp',
      bestFor: ['volatility', 'step', 'range'],
      source: 'FXOpen 1 minute scalping strategies (RSI 4 at 80/20 with Bollinger Bands)',
      rules: 'BUY when RSI 4 climbs back above 20 and price touched the lower band on this or the last candle. SELL when RSI 4 drops back below 80 after touching the upper band. Exit at the middle band.',
      event(S, i) {
        if (i < 1 || !ok(S.rsi4[i], S.rsi4[i - 1], S.bb.lower[i], S.bb.lower[i - 1])) return 0;
        const touchLo = S.low[i] <= S.bb.lower[i] || S.low[i - 1] <= S.bb.lower[i - 1];
        const touchHi = S.high[i] >= S.bb.upper[i] || S.high[i - 1] >= S.bb.upper[i - 1];
        if (S.rsi4[i - 1] < 20 && S.rsi4[i] >= 20 && touchLo) return 1;
        if (S.rsi4[i - 1] > 80 && S.rsi4[i] <= 80 && touchHi) return -1;
        return 0;
      },
      state(S, i) { const r = S.rsi4[i]; return !ok(r) ? 0 : r < 20 ? 1 : r > 80 ? -1 : 0; },
      exit(S, j, dir) { return ok(S.bb.mid[j]) && (dir === 1 ? S.close[j] >= S.bb.mid[j] : S.close[j] <= S.bb.mid[j]); },
      reading(S, i) { return ok(S.rsi4[i]) ? 'RSI 4 ' + S.rsi4[i].toFixed(0) : '-'; }
    },
    {
      id: 'sc_keltner', rank: 4, name: 'Keltner Breakout + RSI 50', kind: 'trend', group: 'scalp',
      bestFor: ['volatility', 'jump', 'drift'],
      source: 'FXOpen 1 minute scalping strategies (Keltner Channel, EMA 20 with 2 ATR bands, RSI 50 filter)',
      rules: 'BUY on the second close in a row above the upper Keltner band (EMA 20 + 2 ATR) with RSI 14 above 50. SELL on two closes below the lower band with RSI below 50. Exit when price closes back through the 20 EMA.',
      event(S, i) {
        if (i < 2 || !ok(S.kelt.upper[i], S.kelt.upper[i - 1], S.kelt.upper[i - 2], S.rsi[i])) return 0;
        const up = k => S.close[k] > S.kelt.upper[k], dn = k => S.close[k] < S.kelt.lower[k];
        if (up(i) && up(i - 1) && !up(i - 2) && S.rsi[i] > 50) return 1;
        if (dn(i) && dn(i - 1) && !dn(i - 2) && S.rsi[i] < 50) return -1;
        return 0;
      },
      state(S, i) { if (!ok(S.kelt.upper[i])) return 0; return S.close[i] > S.kelt.upper[i] ? 1 : S.close[i] < S.kelt.lower[i] ? -1 : 0; },
      exit(S, j, dir) { return ok(S.ema20[j]) && (dir === 1 ? S.close[j] < S.ema20[j] : S.close[j] > S.ema20[j]); },
      reading(S, i) { return !ok(S.kelt.upper[i]) ? '-' : S.close[i] > S.kelt.upper[i] ? 'Above the channel' : S.close[i] < S.kelt.lower[i] ? 'Below the channel' : 'Inside the channel'; }
    },
    {
      id: 'sc_stoch_pull', rank: 5, name: 'Stochastic 5/3/3 Pullback', kind: 'osc', group: 'scalp',
      bestFor: ['volatility', 'step', 'jump'],
      source: 'Fast stochastic scalping settings (5, 3, 3) used with a 50 EMA trend filter in 1 minute EMA and Stochastic scalpers',
      rules: 'BUY when the 50 EMA is rising, price is above it and Stochastic 5/3/3 %K crosses above %D from below 20. SELL is the mirror from above 80.',
      event(S, i) {
        const K = S.stoch5.k, D = S.stoch5.d;
        if (i < 5 || !ok(K[i], D[i], K[i - 1], D[i - 1], S.ema50[i], S.ema50[i - 5])) return 0;
        const a = K[i - 1] - D[i - 1], b = K[i] - D[i];
        const rising = S.ema50[i] > S.ema50[i - 5], falling = S.ema50[i] < S.ema50[i - 5];
        if (rising && S.close[i] > S.ema50[i] && a <= 0 && b > 0 && K[i - 1] < 20) return 1;
        if (falling && S.close[i] < S.ema50[i] && a >= 0 && b < 0 && K[i - 1] > 80) return -1;
        return 0;
      },
      state(S, i) {
        if (i < 5 || !ok(S.ema50[i], S.ema50[i - 5], S.stoch5.k[i])) return 0;
        if (S.ema50[i] > S.ema50[i - 5] && S.close[i] > S.ema50[i] && S.stoch5.k[i] < 50) return 1;
        if (S.ema50[i] < S.ema50[i - 5] && S.close[i] < S.ema50[i] && S.stoch5.k[i] > 50) return -1;
        return 0;
      },
      reading(S, i) { return ok(S.stoch5.k[i]) ? '%K ' + S.stoch5.k[i].toFixed(0) : '-'; }
    },
    {
      id: 'sc_spike', rank: 6, name: 'Spike Scalp (EMA 200 + RSI 14)', kind: 'osc', group: 'scalp',
      bestFor: ['boom', 'crash'],
      source: 'Deriv community Boom and Crash 1 minute scalping post: EMA 200 trend, RSI 30/70, a small pullback, out after the first spike',
      rules: 'BUY when price is above the 200 EMA, RSI 14 dips below 30 and a red candle prints. SELL is the mirror below the 200 EMA with RSI above 70 and a green candle. On Boom and Crash, exit on the first spike candle.',
      cond(S, i) {
        if (!ok(S.rsi[i], S.ema200[i])) return 0;
        if (S.close[i] > S.ema200[i] && S.rsi[i] < 30 && bear(S, i)) return 1;
        if (S.close[i] < S.ema200[i] && S.rsi[i] > 70 && bull(S, i)) return -1;
        return 0;
      },
      event(S, i) { return edgeOf(this.cond.bind(this), S, i); },
      state(S, i) {
        if (!ok(S.rsi[i], S.ema200[i])) return 0;
        if (S.close[i] > S.ema200[i] && S.rsi[i] < 40) return 1;
        if (S.close[i] < S.ema200[i] && S.rsi[i] > 60) return -1;
        return 0;
      },
      exit(S, j, dir) { // a spike = a candle body over 3 ATR in the trade direction
        const a = S.atr[j - 1] || S.atr[j]; if (!ok(a)) return false;
        return dir * (S.close[j] - S.open[j]) > 3 * a;
      },
      reading(S, i) { return ok(S.rsi[i], S.ema200[i]) ? 'RSI ' + S.rsi[i].toFixed(0) + (S.close[i] > S.ema200[i] ? ', above EMA 200' : ', below EMA 200') : '-'; }
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

  const SCALP_IDS = new Set(SCALP.map(s => s.id));
  function library(threshold = 50, mode = 'swing') {
    return mode === 'scalp' ? SCALP.slice() : PRESETS.concat(CLASSIC, [makeCombined(threshold)]);
  }
  function byId(id, threshold = 50) { return library(threshold).concat(SCALP).find(s => s.id === id); }
  const modeOf = id => SCALP_IDS.has(id) ? 'scalp' : 'swing';

  // ---------- trading modes ----------
  /* Regular: smart mix stop from the last 10 candles (0.8 to 3 ATR, else 1.5 ATR), TP1 1.5R, TP2 3R, 50 candle hold.
     Scalper: tighter stop from the last 5 candles (0.5 to 2 ATR, else 1 ATR), TP1 1R, TP2 2R, 15 candle hold. */
  const MODES = {
    swing: { id: 'swing', label: 'Regular', look: 10, minA: 0.8, maxA: 3, atrStop: 1.5, tp1: TP1_R, tp2: TP2_R, maxHold: 50 },
    scalp: { id: 'scalp', label: 'Scalper', look: 5, minA: 0.5, maxA: 2, atrStop: 1, tp1: 1, tp2: 2, maxHold: 15 }
  };
  const modeCfg = m => MODES[m] || MODES.swing;

  // ---------- trade plan ----------
  function plan(S, i, dir, entry, mode) {
    const M = modeCfg(mode), a = S.atr[i];
    if (!ok(a) || !a || !dir) return null;
    const e = entry === undefined ? S.close[i] : entry;
    let lo = Infinity, hi = -Infinity;
    for (let k = Math.max(0, i - M.look + 1); k <= i; k++) { if (S.low[k] < lo) lo = S.low[k]; if (S.high[k] > hi) hi = S.high[k]; }
    const swing = dir === 1 ? e - (lo - 0.2 * a) : (hi + 0.2 * a) - e;
    let dist, method;
    if (swing >= M.minA * a && swing <= M.maxA * a) { dist = swing; method = 'swing'; }
    else { dist = M.atrStop * a; method = 'atr'; }
    return { dir, entry: e, sl: e - dir * dist, tp1: e + dir * M.tp1 * dist, tp2: e + dir * M.tp2 * dist, tp1R: M.tp1, tp2R: M.tp2, dist, method, atr: a, mode: M.id };
  }

  // ---------- market costs and contract specs ----------
  /* Estimates for Deriv MT5, from published minimum lot tables (Oct 2026) and measured
     spreads. Spread is a fraction of price unless pts is given. Every value can be
     overridden in the app because Deriv changes them; check MT5's Specification window. */
  const SPECS = [
    [/volatility 10 \(1s\)/, { minLot: 0.5 }], [/volatility 15 \(1s\)/, { minLot: 0.2 }], [/volatility 25 \(1s\)/, { minLot: 0.005 }],
    [/volatility 30 \(1s\)/, { minLot: 0.2 }], [/volatility 50 \(1s\)/, { minLot: 0.005 }], [/volatility 75 \(1s\)/, { minLot: 0.05 }],
    [/volatility 90 \(1s\)/, { minLot: 0.1 }], [/volatility 100 \(1s\)/, { minLot: 1 }], [/volatility 150 \(1s\)/, { minLot: 1 }],
    [/volatility 200 \(1s\)/, { minLot: 0.02 }], [/volatility 250 \(1s\)/, { minLot: 10 }], [/volatility 5 \(1s\)/, { minLot: 0.05 }],
    [/volatility 10 index/, { minLot: 0.5 }], [/volatility 15 index/, { minLot: 0.1 }], [/volatility 25 index/, { minLot: 0.5 }],
    [/volatility 30 index/, { minLot: 0.05 }], [/volatility 50 index/, { minLot: 4 }], [/volatility 75 index/, { minLot: 0.01 }],
    [/volatility 90 index/, { minLot: 0.05 }], [/volatility 100 index/, { minLot: 1 }], [/volatility 5 index/, { minLot: 0.05 }],
    [/boom 300/, { minLot: 1 }], [/crash 300/, { minLot: 0.5 }], [/boom|crash/, { minLot: 0.2 }],
    [/step/, { minLot: 0.1, contract: 10, pts: 0.1 }], [/jump|range break|drift|dex/, { minLot: 0.01 }]
  ];
  const SPREAD_PCT = { volatility: 0.0001, boom: 0.0003, crash: 0.0003, jump: 0.0001, step: 0, range: 0.0001, drift: 0.0001, other: 0.0002 };
  // Multipliers on Deriv Trader: $1 minimum stake, commission = rate x stake x multiplier, at least $0.10
  const MULT_RATE = { boom: 0.0002, crash: 0.0002, other: 0.00036 };

  function spec(sym, name, price, over) {
    const n = String(name || '').toLowerCase(), fam = family(sym, name);
    const hit = (SPECS.find(([re]) => re.test(n)) || [null, {}])[1];
    const o = (over && over[sym]) || {};
    const minLot = o.minLot > 0 ? o.minLot : hit.minLot || 0.01;
    const contract = o.contract > 0 ? o.contract : hit.contract || 1;
    const spreadPts = o.spread >= 0 && o.spread !== '' && o.spread !== null && o.spread !== undefined ? +o.spread
      : hit.pts !== undefined ? hit.pts : (price || 0) * (SPREAD_PCT[fam] ?? SPREAD_PCT.other);
    return { minLot, contract, spread: spreadPts, multRate: MULT_RATE[fam] || MULT_RATE.other, custom: !!(over && over[sym]) };
  }

  // Position size for a balance and risk percent. Lots = risk / (stop distance x contract size).
  function sizing(p, balance, riskPct, sp) {
    if (!p || !(balance > 0) || !(riskPct > 0)) return null;
    const risk = balance * riskPct / 100, contract = (sp && sp.contract) || 1;
    const lots = risk / (p.dist * contract);
    const minLot = sp && sp.minLot, minRisk = minLot ? minLot * contract * p.dist : null;
    return { risk, lots, minLot, minRisk, fits: !minLot || lots >= minLot };
  }

  // Deriv Trader Multipliers plan for one trade: stake, multiplier and dollar stop and targets.
  function multiplierPlan(p, riskUsd, sp, minStake = 1) {
    if (!p || !(riskUsd > 0)) return null;
    const stake = Math.max(minStake, Math.ceil(riskUsd * 100) / 100);
    const notional = riskUsd * p.entry / p.dist; // stake x multiplier that makes the price stop cost riskUsd
    const mult = notional / stake;
    const commission = Math.max(0.1, ((sp && sp.multRate) || MULT_RATE.other) * notional);
    return { stake, mult, notional, slUsd: riskUsd, tp1Usd: riskUsd * p.tp1R, tp2Usd: riskUsd * p.tp2R, commission, costR: commission / riskUsd };
  }

  // Simulate one trade from candle i: exits at stop, TP1, the strategy's exit rule, or after maxHold candles
  function simulate(S, i, p, maxHold, exitFn) {
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
      if (exitFn && exitFn(S, j, p.dir)) return { j, exit: S.close[j], how: 'rule' };
    }
    return { j: last, exit: S.close[last], how: 'time' };
  }

  // R of a trade after costs: the spread is paid once per round trip, costR is any fixed fee in R
  const netR = (dir, exit, p, cost) => dir * (exit - p.entry) / p.dist - (cost.spread || 0) / p.dist - (cost.costR || 0);

  /* What random entries earn with the same stops, targets, exit rule and costs. This is the
     chance level each strategy has to beat, and it captures drift on Boom and Crash. */
  function baseline(S, maxHold, mode, cost = {}, strat) {
    const exitFn = strat && strat.exit ? strat.exit.bind(strat) : null;
    const key = ['base', maxHold, mode || 'swing', cost.spread || 0, cost.costR || 0, exitFn ? strat.id : ''].join('|');
    S.bases = S.bases || {};
    if (S.bases[key]) return S.bases[key];
    const out = {};
    for (const dir of [1, -1]) {
      let sum = 0, n = 0, wins = 0;
      for (let i = WARMUP; i < S.n - 2; i += 3) {
        const p = plan(S, i, dir, undefined, mode); if (!p) continue;
        const r = simulate(S, i, p, maxHold, exitFn);
        const R = netR(dir, r.exit, p, cost);
        sum += R; n++; if (R > 0) wins++;
      }
      out[dir] = n ? { R: sum / n, win: wins / n, n } : { R: 0, win: 0, n: 0 };
    }
    S.bases[key] = out;
    return out;
  }

  function backtest(S, strat, opts = {}) {
    const fam = opts.family || 'other', spikeOnly = opts.spikeOnly !== false;
    const mode = opts.mode || modeOf(strat.id), maxHold = opts.maxHold || modeCfg(mode).maxHold;
    const cost = { spread: opts.spread || 0, costR: opts.costR || 0 };
    if (S.n < WARMUP + 30) return null;
    const exitFn = strat.exit ? strat.exit.bind(strat) : null;
    const base = baseline(S, maxHold, mode, cost, strat);
    // Chance = a coin-flip trader allowed the same directions (only buys on Boom, only sells on Crash)
    const dirs = [1, -1].filter(d => allowed(fam, d, spikeOnly));
    const chance = { R: dirs.reduce((s, d) => s + base[d].R, 0) / dirs.length, win: dirs.reduce((s, d) => s + base[d].win, 0) / dirs.length };
    const trades = [];
    for (let i = WARMUP; i < S.n - 2; i++) {
      const d = strat.event(S, i);
      if (!d || !allowed(fam, d, spikeOnly)) continue;
      const p = plan(S, i, d, undefined, mode); if (!p) continue;
      const r = simulate(S, i, p, maxHold, exitFn);
      const R = netR(d, r.exit, p, cost);
      trades.push({ i, j: r.j, dir: d, R, how: r.how, base: chance.R, hold: r.j - i });
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
      gaps: trades.filter(t => t.how === 'gap').length, candles: S.n, mode, maxHold,
      Rs, avgHold: mean(trades.map(t => t.hold)),
      avgWin: wins ? mean(Rs.filter(x => x > 0)) : 0, avgLoss: N - wins ? mean(Rs.filter(x => x <= 0)) : 0
    };
    // win rate needed to break even with this strategy's average win and loss
    res.breakevenWin = res.avgWin > 0 && res.avgLoss < 0 ? -res.avgLoss / (res.avgWin - res.avgLoss) : null;
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
    const lib = library(opts.threshold || 50, opts.mode || 'swing');
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
      plan: active ? plan(S, i, active, S.close[S.n - 1], opts.mode || modeOf(strat.id)) : null,
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

  /* Backtest trade results with the luck of picking the winner taken out: the edge over
     chance is shrunk by the same share the best-of-many correction took off z. */
  function honestRs(r) {
    if (!r || !r.Rs || !r.Rs.length) return [];
    let shift = 0;
    if (r.z > 0 && r.zAdj !== undefined && r.zAdj < r.z) shift = r.edge * (1 - Math.max(0, r.zAdj) / r.z);
    return r.Rs.map(x => x - Math.max(0, shift));
  }

  /* Monte Carlo of an account trading one strategy. Each trade risks riskPct of the balance
     (or of the ladder step reached), never less than minRisk(balance), and pays cost(risk) in R.
     The run ends at the target, when the balance can no longer cover the smallest trade, or after maxTrades. */
  function growthSim(o) {
    const Rs = o.Rs || [], trials = o.trials || 2000, maxTrades = o.maxTrades || 300;
    if (!Rs.length) return null;
    const steps = (o.ladder || []).slice().sort((a, b) => a - b);
    const minRisk = o.minRisk || (() => 0);
    let seed = o.seed || 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    let hit = 0, bust = 0; const lens = [], ends = [];
    for (let t = 0; t < trials; t++) {
      let bal = o.start, n = 0, done = false;
      while (n < maxTrades) {
        const base = steps.length ? (steps.filter(s => s <= bal).pop() || bal) : bal;
        const risk = Math.max(base * o.riskPct / 100, minRisk(bal));
        if (!(risk > 0) || risk > bal || bal < (o.floor || 0)) { bust++; done = true; break; }
        bal += risk * (Rs[Math.floor(rnd() * Rs.length)] - (o.cost ? o.cost(risk) : 0));
        n++;
        if (bal >= o.target) { hit++; done = true; break; }
      }
      if (!done && bal <= 0) bust++;
      lens.push(n); ends.push(bal);
    }
    const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    return { pTarget: hit / trials, pBust: bust / trials, pNeither: 1 - (hit + bust) / trials, medianTrades: med(lens), medianEnd: med(ends) };
  }

  const api = {
    WARMUP, MIN_TRADES, TP1_R, TP2_R, PRESETS, CLASSIC, SCALP, MODES, FAMILY_LABEL,
    family, allowed, compute, library, byId, modeOf, regime, score, plan, spec, sizing, multiplierPlan, simulate, baseline,
    backtest, recommend, live, snapshot, events, edgeScore, scoreLabel, adjustZ, normCdf, honestRs, growthSim
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Strat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
