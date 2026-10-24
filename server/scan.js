/* SynthScope 24/7 scanner for GitHub Actions.
   Each run: loads every Vixed index on the chosen timeframes from Deriv's public feed,
   ranks all 13 strategies per market with the same engine as the app, sends an ntfy
   alert for each fresh signal from a strategy that clears MIN_SCORE, and follows every
   alert until it hits the stop, TP1 or the max hold. State is kept between runs in
   scan-state.json (saved by the workflow's cache step). No packages needed. */
'use strict';
const fs = require('fs');
const path = require('path');
globalThis.Ind = require('../www/js/indicators.js');
const Strat = require('../www/js/strategies.js');
require('../www/js/deriv.js');

const TF_LABEL = { 60: '1m', 120: '2m', 180: '3m', 300: '5m', 600: '10m', 900: '15m', 1800: '30m', 3600: '1h', 7200: '2h', 14400: '4h', 28800: '8h', 86400: '1d' };

function config(env) {
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  return {
    topic: (env.NTFY_TOPIC || '').trim(),
    ntfy: (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''),
    tfs: (env.SCAN_TIMEFRAMES || '300,900,1800,3600').split(',').map(Number).filter(g => TF_LABEL[g]),
    markets: (env.MARKETS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    minScore: num(env.MIN_SCORE, 70),
    maxAlerts: num(env.MAX_ALERTS, 6),
    history: num(env.HISTORY, 1000),
    balance: num(env.BALANCE, 100),
    riskPct: num(env.RISK_PCT, 2),
    maxHold: num(env.MAX_HOLD, 50),
    spikeOnly: String(env.SPIKE_ONLY || 'true').toLowerCase() !== 'false',
    freshMinutes: num(env.FRESH_MINUTES, 20),
    endpoint: env.DERIV_ENDPOINT || 'auto',
    appId: env.DERIV_APP_ID || '',
    stateFile: env.STATE_FILE || path.join(process.cwd(), 'scan-state.json'),
    summaryFile: env.GITHUB_STEP_SUMMARY || ''
  };
}

const decimals = pip => Math.min(6, Math.max(0, Math.round(-Math.log10(pip || 0.01))));
const fmtPrice = (v, pip) => Number.isFinite(v) ? v.toFixed(decimals(pip)) : '-';
const word = d => d === 1 ? 'BUY' : 'SELL';

function loadState(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { seen: s.seen || {}, open: s.open || [], closed: s.closed || [], runs: s.runs || 0 }; }
  catch (_) { return { seen: {}, open: [], closed: [], runs: 0 }; }
}
function saveState(file, st) {
  // keep the file small: forget signals older than 3 days, keep the last 300 results
  const cutoff = Date.now() - 3 * 86400e3;
  for (const k of Object.keys(st.seen)) if (st.seen[k] < cutoff) delete st.seen[k];
  st.closed = st.closed.slice(-300);
  fs.writeFileSync(file, JSON.stringify(st));
}

async function push(cfg, fetchFn, { title, body, priority = 4, tags = [] }) {
  if (!cfg.topic) { console.log('[no NTFY_TOPIC, not sent] ' + title + ' | ' + body); return false; }
  try {
    const res = await fetchFn(`${cfg.ntfy}/${encodeURIComponent(cfg.topic)}`, {
      method: 'POST', body,
      headers: { Title: title, Priority: String(priority), Tags: tags.join(',') }
    });
    if (!res.ok) console.warn('ntfy answered', res.status);
    return res.ok;
  } catch (e) { console.warn('ntfy failed', e.message); return false; }
}

// Follow an open alert through the candles that came after it
function followTrade(t, candles, maxHold) {
  // start at the candle the alert was sent in, so moves before the alert do not count
  const start = Math.max(t.signalClose, Math.floor(t.t / 1000 / t.g) * t.g);
  const after = candles.filter(c => c.epoch >= start);
  let bars = 0;
  for (const c of after) {
    bars++;
    const hitSL = t.dir === 1 ? c.low <= t.sl : c.high >= t.sl;
    const hitTP = t.dir === 1 ? c.high >= t.tp1 : c.low <= t.tp1;
    if (hitSL) return { status: 'sl', R: -1, bars };
    if (hitTP) return { status: 'tp', R: Strat.TP1_R, bars };
    if (bars >= maxHold) return { status: 'time', R: t.dir * (c.close - t.entry) / t.dist, bars };
  }
  return null;
}

async function main(env = process.env, deps = {}) {
  const cfg = config(env);
  const fetchFn = deps.fetch || globalThis.fetch;
  const now = deps.now ? deps.now() : Date.now();
  const st = loadState(cfg.stateFile);
  st.runs++;
  const client = new globalThis.DerivClient();
  client.configure(cfg.endpoint, cfg.appId);
  client.wanted = false;
  await client.connect();
  client.wanted = false; // a dropped socket should end the run, not reconnect forever

  let symbols = await client.symbols();
  for (const s of symbols) s.fam = Strat.family(s.symbol, s.name);
  if (cfg.markets.length) symbols = symbols.filter(s => cfg.markets.includes(s.fam));
  const bySym = Object.fromEntries(symbols.map(s => [s.symbol, s]));
  console.log(`Run ${st.runs}: ${symbols.length} Vixed indices x ${cfg.tfs.map(g => TF_LABEL[g]).join(', ')}, min score ${cfg.minScore}`);

  const candlesByKey = new Map(), results = [], fresh = [];
  let failed = 0;
  for (const s of symbols) {
    for (const g of cfg.tfs) {
      let cs;
      try { cs = await client.candles(s.symbol, g, cfg.history); } catch (e) { failed++; console.warn(s.symbol, g, e.message); continue; }
      candlesByKey.set(s.symbol + '|' + g, cs);
      if (cs.length < Strat.WARMUP + 40) continue;
      const S = Strat.compute(cs);
      const opts = { family: s.fam, spikeOnly: cfg.spikeOnly, maxHold: cfg.maxHold };
      const rec = Strat.recommend(S, opts);
      const best = rec[0];
      results.push({ sym: s.symbol, g, best });
      // fresh = signal on one of the last few closed candles, within FRESH_MINUTES
      const freshBars = Math.max(1, Math.ceil(cfg.freshMinutes * 60 / g));
      for (const r of rec.slice(0, 3)) {
        if (r.score < cfg.minScore) break;
        const L = Strat.live(S, Strat.byId(r.strategy), S.n - 2, Object.assign({ fresh: freshBars - 1 }, opts));
        if (!L.active || !L.plan) continue;
        const k = S.n - 2 - L.barsAgo, signalClose = S.time[k] + g;
        if (now / 1000 - signalClose > cfg.freshMinutes * 60 + g) continue;
        const key = `${s.symbol}|${g}|${r.strategy}|${S.time[k]}`;
        if (st.seen[key]) break;
        fresh.push({ key, s, g, r, L, signalClose });
        break;
      }
    }
  }

  // follow open alerts
  const outcomes = [];
  for (const t of st.open.slice()) {
    const cs = candlesByKey.get(t.sym + '|' + t.g);
    if (!cs) continue;
    const res = followTrade(t, cs, cfg.maxHold);
    if (!res) continue;
    Object.assign(t, res, { closedAt: now });
    st.open.splice(st.open.indexOf(t), 1);
    st.closed.push(t);
    outcomes.push(t);
  }

  // send alerts, strongest first
  fresh.sort((a, b) => b.r.score - a.r.score);
  const sent = [];
  for (const f of fresh.slice(0, cfg.maxAlerts)) {
    const { s, g, r, L } = f, p = L.plan, sz = Strat.sizing(p, cfg.balance, cfg.riskPct);
    const title = `${word(L.active)} ${s.name} (${TF_LABEL[g]}) edge ${r.score}`;
    const body = [
      `Entry ${fmtPrice(p.entry, s.pip)}`,
      `Stop loss ${fmtPrice(p.sl, s.pip)}`,
      `TP1 ${fmtPrice(p.tp1, s.pip)}  |  TP2 ${fmtPrice(p.tp2, s.pip)}`,
      sz ? `Risk $${sz.risk.toFixed(2)} (${cfg.riskPct}% of $${cfg.balance})  |  ${sz.lots < 0.01 ? sz.lots.toPrecision(2) : sz.lots.toFixed(3)} MT5 lots` : '',
      `${r.name}: ${r.trades} past trades, ${(r.winRate * 100).toFixed(0)}% win, ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(2)}R avg`,
      (s.fam === 'boom' || s.fam === 'crash') ? 'Spikes can jump past a stop loss. Size small.' : '',
      `Signal ${Math.max(0, Math.round((now / 1000 - f.signalClose) / 60))} min ago. Check the live price before entering.`
    ].filter(Boolean).join('\n');
    await push(cfg, fetchFn, { title, body, priority: r.score >= 85 ? 5 : 4, tags: [L.active === 1 ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'] });
    st.seen[f.key] = now;
    st.open.push({ key: f.key, sym: s.symbol, name: s.name, pip: s.pip, g, dir: L.active, strategy: r.strategy, stratName: r.name, score: r.score,
      entry: p.entry, sl: p.sl, tp1: p.tp1, dist: p.dist, t: now, signalClose: f.signalClose });
    sent.push(f);
  }
  for (const f of fresh.slice(cfg.maxAlerts)) st.seen[f.key] = now; // over the limit: skip, do not resend later

  // outcome messages
  for (const t of outcomes) {
    const how = t.status === 'tp' ? `hit TP1, +${Strat.TP1_R}R` : t.status === 'sl' ? 'hit the stop, -1R' : `closed after ${t.bars} candles, ${t.R >= 0 ? '+' : ''}${t.R.toFixed(2)}R`;
    const recent = st.closed.slice(-50), net = recent.reduce((a, x) => a + (x.R || 0), 0), wins = recent.filter(x => x.R > 0).length;
    await push(cfg, fetchFn, {
      title: `Result: ${word(t.dir)} ${t.name} (${TF_LABEL[t.g]}) ${how}`,
      body: `${t.stratName}, entry ${fmtPrice(t.entry, t.pip)}.\nLast ${recent.length} alerts: ${wins} won, net ${net >= 0 ? '+' : ''}${net.toFixed(1)}R.`,
      priority: 2, tags: [t.R > 0 ? 'white_check_mark' : 'x']
    });
  }
  // stop following alerts that are far too old (the market was not rescanned)
  st.open = st.open.filter(t => now - t.t < 2 * 86400e3);

  client.closeSocket();
  saveState(cfg.stateFile, st);

  // run summary for the Actions page
  results.sort((a, b) => b.best.score - a.best.score);
  const recent = st.closed.slice(-50), net = recent.reduce((a, x) => a + (x.R || 0), 0);
  const lines = [
    `## SynthScope scan ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `${results.length} market and timeframe pairs scanned${failed ? `, ${failed} failed` : ''}. ${sent.length} alert${sent.length === 1 ? '' : 's'} sent, ${outcomes.length} result${outcomes.length === 1 ? '' : 's'}, ${st.open.length} open.`,
    recent.length ? `Forward record (last ${recent.length}): ${recent.filter(x => x.R > 0).length} won, net ${net >= 0 ? '+' : ''}${net.toFixed(1)}R.` : 'No closed alerts yet.',
    '', '| Market | TF | Best strategy | Score | Trades | Avg R |', '|---|---|---|---|---|---|',
    ...results.slice(0, 15).map(r => `| ${bySym[r.sym].name} | ${TF_LABEL[r.g]} | ${r.best.name} | ${r.best.score} | ${r.best.trades} | ${r.best.avgR.toFixed(2)} |`)
  ];
  if (cfg.summaryFile) { try { fs.appendFileSync(cfg.summaryFile, lines.join('\n') + '\n'); } catch (_) {} }
  console.log(lines.slice(0, 3).join('\n'));
  return { scanned: results.length, sent: sent.length, outcomes: outcomes.length, open: st.open.length, failed };
}

module.exports = { main, config, followTrade };
if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('Scan failed:', e.message); process.exit(1); });
}
