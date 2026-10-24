const Ind = require('../www/js/indicators.js');
global.Ind = Ind;
const Strat = require('../www/js/strategies.js');
const TI = require(process.env.TI_PATH || 'technicalindicators');

let seed = 42; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };

// Random walk candles, 4 ticks per candle
function walk(n, start=1000, vol=1, spike=null) {
  const out = []; let p = start;
  for (let i=0;i<n;i++){ const o=p; let hi=p, lo=p;
    for (let t=0;t<4;t++){ let d = gauss()*vol;
      if (spike){ d = -spike.drift; if (rnd()<spike.prob) d = spike.size; }
      p+=d; hi=Math.max(hi,p); lo=Math.min(lo,p); }
    out.push({epoch:i*60, open:o, high:hi, low:lo, close:p}); }
  return out;
}
const c = walk(1500); const cl=c.map(x=>x.close), hi=c.map(x=>x.high), lo=c.map(x=>x.low);
const last = (a)=>a[a.length-1];
let failed = 0;
const cmp = (name, mine, ref, tol=1e-6) => { const d=Math.abs(mine-ref); const ok = d < tol*Math.max(1,Math.abs(ref)); if(!ok) failed++; console.log(name.padEnd(12), mine.toFixed(5), ref.toFixed(5), ok?'OK':'DIFF '+d); };
cmp('SMA20', last(Ind.sma(cl,20)), last(TI.SMA.calculate({period:20,values:cl})));
cmp('EMA21', last(Ind.ema(cl,21)), last(TI.EMA.calculate({period:21,values:cl})));
cmp('RSI14', last(Ind.rsi(cl,14)), last(TI.RSI.calculate({period:14,values:cl})), 1e-4); // reference rounds RSI to 2 decimals
const m = Ind.macd(cl), mr = last(TI.MACD.calculate({values:cl,fastPeriod:12,slowPeriod:26,signalPeriod:9,SimpleMAOscillator:false,SimpleMASignal:false}));
cmp('MACD', last(m.line), mr.MACD); cmp('MACDsig', last(m.signal), mr.signal);
const bb = Ind.bollinger(cl), br = last(TI.BollingerBands.calculate({period:20,stdDev:2,values:cl}));
cmp('BBupper', last(bb.upper), br.upper);
const at = Ind.atr(hi,lo,cl,14), ar = last(TI.ATR.calculate({high:hi,low:lo,close:cl,period:14}));
cmp('ATR14', last(at), ar);
const ad = Ind.adx(hi,lo,cl,14), adr = last(TI.ADX.calculate({high:hi,low:lo,close:cl,period:14}));
cmp('ADX14', last(ad.adx), adr.adx); cmp('+DI', last(ad.plusDI), adr.pdi);
const s = Ind.stochastic(hi,lo,cl,14,3,3);
console.log('Stoch K/D', last(s.k).toFixed(2), last(s.d).toFixed(2));

function report(label, candles){
  const S = Strat.compute(candles);
  console.log('\n== '+label+' ('+candles.length+' candles), horizon 5');
  for (const r of Strat.backtestAll(S,5)) console.log(r.name.padEnd(22), String(r.trades).padStart(4), 'win', (r.winRate*100).toFixed(1).padStart(5), 'chance', (r.chance*100).toFixed(1).padStart(5), 'z', r.z.toFixed(2).padStart(6), 'atr', r.avgAtr.toFixed(2).padStart(6), r.verdict.label);
  const snap = Strat.snapshot(S, S.n-2);
  console.log('snapshot score', snap.score, 'signal', snap.signal, snap.regime.name, 'last', snap.lastEvent, snap.barsAgo);
}
report('Random walk', walk(5000));
report('Boom-style (drift down, rare up spikes)', walk(5000, 1000, 0, {drift:0.05, prob:0.002, size:60}));
// trending series: a planted edge should be detected
const tr = walk(5000).map((x,i)=>({...x, open:x.open+i*0.6, high:x.high+i*0.6, low:x.low+i*0.6, close:x.close+i*0.6}));
report('Planted uptrend', tr);

// The backtester must not invent an edge on pure random data
const rw = Strat.backtestAll(Strat.compute(walk(5000)),5).filter(r=>r.verdict.code==='edge');
if (rw.length) { console.log('FAIL: edge reported on random data'); failed++; }
if (failed) { console.log(failed+' check(s) failed'); process.exit(1); } else console.log('\nAll checks passed');
