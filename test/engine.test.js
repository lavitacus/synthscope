// SynthScope engine tests: indicator maths against a reference library, trade plans,
// the plan-based backtester, scalper mode, costs, lot and Multiplier sizing and the account simulator.
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

// ---- picking the best of 13 must not make noise look strong ----
let promising = 0, strong = 0; const M = 120;
for (let k = 0; k < M; k++) { const s = Strat.recommend(Strat.compute(walk(1000)), { family: 'volatility' })[0].score; if (s >= 65) promising++; if (s >= 85) strong++; }
check(promising / M <= 0.08 && strong / M <= 0.02, `best-of-13 on random data: ${(promising / M * 100).toFixed(1)}% Promising, ${(strong / M * 100).toFixed(1)}% Strong`);
check(Strat.adjustZ(4, 13) < 4 && Strat.adjustZ(4, 13) > 3, 'correction shrinks z=4 to ' + Strat.adjustZ(4, 13).toFixed(2));

// ---- scalper mode ----
check(Strat.library(50, 'scalp').length === 6 && Strat.SCALP.every(s => Strat.modeOf(s.id) === 'scalp'), 'scalper library has 6 strategies');
const sp = Strat.plan(S0, 400, 1, undefined, 'scalp');
check(near(sp.tp1 - sp.entry, sp.entry - sp.sl) && near(sp.tp2 - sp.entry, 2 * (sp.entry - sp.sl)) && sp.dist <= 2 * sp.atr + 1e-9, 'scalp plan: TP1 1R, TP2 2R, stop within 2 ATR');
let sProm = 0, sStrong = 0; const SM = 120;
for (let k = 0; k < SM; k++) { const s = Strat.recommend(Strat.compute(walk(2000)), { family: 'volatility', mode: 'scalp' })[0].score; if (s >= 65) sProm++; if (s >= 85) sStrong++; }
check(sProm / SM <= 0.09 && sStrong / SM <= 0.03, `best-of-6 scalper on random data: ${(sProm / SM * 100).toFixed(1)}% Promising, ${(sStrong / SM * 100).toFixed(1)}% Strong`);
const sTrend = Strat.recommend(Strat.compute(walk(2000, 1000, 1, null, 0.25)), { family: 'volatility', mode: 'scalp' })[0];
check(sTrend.score >= 65 && sTrend.avgR > 0, 'scalper finds a planted trend: ' + sTrend.name + ' scores ' + sTrend.score);

// ---- costs ----
const Sc = Strat.compute(walk(2000)), st0 = Strat.byId('ema_cross');
const free = Strat.backtest(Sc, st0, { family: 'volatility' }), paid = Strat.backtest(Sc, st0, { family: 'volatility', spread: 0.5 });
check(paid.avgR < free.avgR && paid.baseR < free.baseR, 'spread lowers both the strategy and the chance level');
const rs = Strat.recommend(Sc, { family: 'volatility', mode: 'scalp', spread: 0.5 });
check(rs.every(r => r.verdict.code !== 'edge'), 'random walk with spread: no scalper edge');

// ---- lots, minimum lot and Multipliers ----
const v75 = Strat.spec('R_75', 'Volatility 75 Index', 400000), stp = Strat.spec('stpRNG', 'Step Index', 8000);
check(v75.minLot === 0.01 && v75.contract === 1 && v75.spread > 0 && stp.contract === 10 && stp.spread === 0.1, 'spec estimates for V75 and Step');
check(Strat.spec('R_75', 'Volatility 75 Index', 400000, { R_75: { minLot: 0.001, spread: 30 } }).minLot === 0.001, 'spec overrides win');
const pz = { dist: 500, entry: 400000, dir: 1, tp1R: 1, tp2R: 2 }, z10 = Strat.sizing(pz, 10, 2, v75);
check(near(z10.risk, 0.2) && !z10.fits && near(z10.minRisk, 5), '$10 at 2% cannot afford 0.01 lots of a 500 point stop');
const mp = Strat.multiplierPlan(pz, 0.5, v75);
check(mp.stake === 1 && near(mp.notional, 400) && near(mp.mult, 400) && near(mp.commission, 0.144) && near(mp.slUsd, 0.5), 'multiplier plan: $1 stake, x400, $0.14 commission');
const mp2 = Strat.multiplierPlan(Object.assign({}, pz, { dist: 5000 }), 0.2, v75);
check(near(mp2.commission, 0.1) && near(mp2.costR, 0.5), 'multiplier commission floor of $0.10 is half of a $0.20 risk');

// ---- account simulation ----
const allWin = Strat.growthSim({ Rs: [1], start: 10, riskPct: 5, target: 20, trials: 50 }), allLose = Strat.growthSim({ Rs: [-1], start: 10, riskPct: 5, target: 20, trials: 50, floor: 1 });
check(allWin.pTarget === 1 && allLose.pBust === 1, 'growth sim: always winning reaches the goal, always losing busts');
const coin = Strat.growthSim({ Rs: [1, -1], start: 10, riskPct: 5, target: 20, trials: 3000, maxTrades: 2000, floor: 2, cost: () => 0.1 });
check(coin.pTarget < 0.5, 'growth sim: a coin flip with costs reaches double less than half the time (' + (coin.pTarget * 100).toFixed(0) + '%)');

if (failed) { console.log('\n' + failed + ' check(s) failed'); process.exit(1); }
console.log('\nAll checks passed');
