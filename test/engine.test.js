// SynthScope engine tests: indicator maths against a reference library,
// trade plans, the plan-based backtester and live recommendations.
const Ind = require('../www/js/indicators.js');
global.Ind = Ind;
const Strat = require('../www/js/strategies.js');
const TI = require(process.env.TI_PATH || 'technicalindicators');

let failed = 0;
const check = (cond, label) => { console.log((cond ? 'OK   ' : 'FAIL ') + label); if (!cond) failed++; };

let seed = 42; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// Random walk candles, 4 ticks per candle. spike = Boom-style drift with rare jumps.
function walk(n, start = 1000, vol = 1, spike = null, drift = 0) {
  const out = []; let p = start;
  for (let i = 0; i < n; i++) {
    const o = p; let hi = p, lo = p;
    for (let t = 0; t < 4; t++) {
      let d = gauss() * vol + drift;
      if (spike) { d = -spike.drift + gauss() * 0.02; if (rnd() < spike.prob) d = spike.size; }
      p += d; hi = Math.max(hi, p); lo = Math.min(lo, p);
    }
    out.push({ epoch: i * 60, open: o, high: hi, low: lo, close: p });
  }
  return out;
}

// ---- indicators vs reference ----
const c = walk(1500), cl = c.map(x => x.close), hi = c.map(x => x.high), lo = c.map(x => x.low);
const last = a => a[a.length - 1];
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol * Math.max(1, Math.abs(b));
check(near(last(Ind.sma(cl, 20)), last(TI.SMA.calculate({ period: 20, values: cl }))), 'SMA 20 matches reference');
check(near(last(Ind.ema(cl, 21)), last(TI.EMA.calculate({ period: 21, values: cl }))), 'EMA 21 matches reference');
check(near(last(Ind.rsi(cl, 14)), last(TI.RSI.calculate({ period: 14, values: cl })), 1e-4), 'RSI 14 matches reference');
const m = Ind.macd(cl), mr = last(TI.MACD.calculate({ values: cl, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }));
check(near(last(m.line), mr.MACD) && near(last(m.signal), mr.signal), 'MACD matches reference');
check(near(last(Ind.bollinger(cl).upper), last(TI.BollingerBands.calculate({ period: 20, stdDev: 2, values: cl })).upper), 'Bollinger matches reference');
check(near(last(Ind.atr(hi, lo, cl, 14)), last(TI.ATR.calculate({ high: hi, low: lo, close: cl, period: 14 }))), 'ATR 14 matches reference');
check(near(last(Ind.adx(hi, lo, cl, 14).adx), last(TI.ADX.calculate({ high: hi, low: lo, close: cl, period: 14 })).adx), 'ADX 14 matches reference');

// ---- families ----
check(Strat.family('BOOM1000', 'Boom 1000 Index') === 'boom', 'Boom family detected');
check(Strat.family('CRASH500', 'Crash 500 Index') === 'crash', 'Crash family detected');
check(Strat.family('R_75', 'Volatility 75 Index') === 'volatility', 'Volatility family detected');
check(Strat.family('stpRNG', 'Step Index') === 'step', 'Step family detected');
check(!Strat.allowed('boom', -1, true) && Strat.allowed('boom', 1, true) && Strat.allowed('crash', -1, true), 'spike-direction filter');

// ---- trade plan ----
const S0 = Strat.compute(walk(600));
const pb = Strat.plan(S0, 400, 1), ps = Strat.plan(S0, 400, -1);
check(pb.sl < pb.entry && pb.tp1 > pb.entry && pb.tp2 > pb.tp1, 'BUY plan: stop below, targets above');
check(ps.sl > ps.entry && ps.tp1 < ps.entry && ps.tp2 < ps.tp1, 'SELL plan: stop above, targets below');
check(near(pb.tp1 - pb.entry, 1.5 * (pb.entry - pb.sl)) && near(pb.tp2 - pb.entry, 3 * (pb.entry - pb.sl)), 'TP1 is 1.5R and TP2 is 3R');
check(pb.dist >= 0.8 * pb.atr - 1e-9 && pb.dist <= 3 * pb.atr + 1e-9, 'stop distance stays between 0.8 and 3 ATR');
const sz = Strat.sizing(pb, 500, 2);
check(near(sz.risk, 10) && near(sz.lots * pb.dist, 10), '2% of $500 risks $10');

// ---- library ----
const lib = Strat.library();
check(lib.length === 13 && Strat.PRESETS.length === 5, 'library has 5 researched + 7 classic + combined');

function table(label, candles, fam) {
  const S = Strat.compute(candles);
  const t0 = Date.now();
  const rec = Strat.recommend(S, { family: fam });
  const ms = Date.now() - t0;
  console.log('\n== ' + label + ' (' + candles.length + ' candles, ' + ms + ' ms)');
  for (const r of rec) console.log('  ' + r.name.padEnd(38) + String(r.trades).padStart(4) + ' win ' + (r.winRate * 100).toFixed(0).padStart(3) + '% avgR ' + r.avgR.toFixed(2).padStart(6) + ' base ' + r.baseR.toFixed(2).padStart(6) + ' z ' + r.z.toFixed(1).padStart(5) + ' score ' + String(r.score).padStart(3) + '  ' + r.verdict.label);
  return { S, rec, ms };
}

// ---- random data must show no edge ----
let falseEdges = 0, runs = 0;
for (let k = 0; k < 6; k++) {
  const { rec } = table('Random walk #' + (k + 1), walk(1000), 'volatility');
  falseEdges += rec.filter(r => r.verdict.code === 'edge').length; runs += rec.length;
}
check(falseEdges <= 1, 'random walks: ' + falseEdges + ' false "Possible edge" out of ' + runs + ' tests');

// ---- Boom-style: sells win often but spikes wreck them ----
const boom = table('Boom-style', walk(2000, 1000, 0, { drift: 0.05, prob: 0.002, size: 60 }), 'boom');
const boomSells = Strat.backtest(boom.S, Strat.byId('rsi_rev'), { family: 'boom', spikeOnly: false });
check(boom.rec.every(r => r.verdict.code !== 'edge'), 'Boom-style random series shows no edge');
check(boomSells && boomSells.trades >= 0, 'Boom backtest without spike filter runs');
const filtered = Strat.events(boom.S, Strat.byId('ema_cross'), { family: 'boom' });
check(filtered.every(e => e.dir === 1), 'Boom events are buys only with spike filter');

// ---- a real trend must be detected ----
const trend = table('Planted trend (drift up)', walk(2000, 1000, 1, null, 0.25), 'volatility');
const best = trend.rec[0];
check(best.score >= 65 && best.avgR > 0, 'planted trend: best strategy scores ' + best.score + ' (' + best.name + ')');
check(trend.ms < 3000, 'recommend on 2000 candles takes ' + trend.ms + ' ms');

// ---- live read ----
const L = Strat.live(trend.S, Strat.byId('macd_cross'), trend.S.n - 2, { family: 'volatility', fresh: 60 });
check(L.lastDir !== 0 && (L.active === 0 || L.plan), 'live read returns last signal and a plan when active');

if (failed) { console.log('\n' + failed + ' check(s) failed'); process.exit(1); }
console.log('\nAll checks passed');
