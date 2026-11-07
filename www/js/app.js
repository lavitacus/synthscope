/* SynthScope 2.2: Smart Scan in Regular and Scalper modes, live trade plans, strategy library,
   backtests, the Under $10 tab, daily guardrails and alerts. */
(function () {
  'use strict';
  const VERSION = '2.2.0';
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const TF = [
    [60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min'], [600, '10 min'], [900, '15 min'],
    [1800, '30 min'], [3600, '1 hour'], [7200, '2 hours'], [14400, '4 hours'], [28800, '8 hours'], [86400, '1 day']
  ];
  const tfLabel = g => (TF.find(t => t[0] === g) || [g, g + 's'])[1];
  const tfShort = g => g < 3600 ? (g / 60) + 'm' : g < 86400 ? (g / 3600) + 'h' : '1d';

  // ---------- storage ----------
  const store = {
    get(k, def) { try { const v = localStorage.getItem('ss.' + k); return v === null ? def : JSON.parse(v); } catch (_) { return def; } },
    set(k, v) { try { localStorage.setItem('ss.' + k, JSON.stringify(v)); } catch (_) { /* storage blocked */ } }
  };
  const DEFAULTS = {
    balance: 100, riskPct: 2, spikeOnly: true, threshold: 50, minAlertScore: 0, history: 1000, maxHold: 50,
    endpoint: 'auto', appId: '', sound: true, vibrate: true, awake: false,
    scanTfs: [60, 300, 900, 3600], scanGroup: '', scanStrategy: 'auto', scanLive: true, scanView: 'signals',
    chartSym: 'R_75', chartTf: 300, chartStrategy: 'auto', testSym: '', testTf: 300, testCount: 2500, testHold: 0, testMode: 'swing',
    mode: 'swing', scalpTfs: [60, 120, 180, 300], scalpHistory: 2000, specs: {},
    guard: { on: true, lossPct: 6, maxTrades: 10, profitPct: 4 },
    small: { balance: 10, platform: 'mt5', plan: 'safe', style: 'scalp', target: 50 }
  };
  const saved = store.get('settings2', {});
  const settings = Object.assign({}, DEFAULTS, saved);
  settings.guard = Object.assign({}, DEFAULTS.guard, saved.guard || {});
  settings.small = Object.assign({}, DEFAULTS.small, saved.small || {});
  settings.specs = Object.assign({}, saved.specs || {});
  const saveSettings = () => store.set('settings2', settings);
  let watch = store.get('watch2', []);
  let log = store.get('log2', []);

  const client = new DerivClient();
  let symbols = [];
  const bySym = {};
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // ---------- helpers ----------
  function decimals(sym) {
    const p = (bySym[sym] && bySym[sym].pip) || 0.01;
    return Math.min(6, Math.max(0, Math.round(-Math.log10(p))));
  }
  const price = (sym, v) => (v === null || v === undefined || !Number.isFinite(v)) ? '-' : v.toFixed(decimals(sym));
  const nameOf = sym => (bySym[sym] && bySym[sym].name) || sym;
  const famOf = sym => (bySym[sym] && bySym[sym].fam) || Strat.family(sym, nameOf(sym));
  const sigWord = s => s === 1 ? 'BUY' : s === -1 ? 'SELL' : 'WAIT';
  const sigClass = s => s === 1 ? 'buy' : s === -1 ? 'sell' : 'wait';
  const money = v => '$' + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
  const lots = v => v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toPrecision(2);
  const tzShift = -new Date().getTimezoneOffset() * 60;
  const specOf = (sym, px) => Strat.spec(sym, nameOf(sym), px, settings.specs);
  const lastPx = S => S.close[S.n - 1];
  // engine options for one market: family rules, mode (regular or scalper) and the spread it pays
  const engineOpts = (sym, S, mode) => {
    const m = mode || settings.mode;
    return { family: famOf(sym), spikeOnly: settings.spikeOnly, threshold: settings.threshold, mode: m,
      maxHold: m === 'swing' ? settings.maxHold : Strat.MODES.scalp.maxHold, spread: S ? specOf(sym, lastPx(S)).spread : 0 };
  };
  const tfsFor = mode => (mode || settings.mode) === 'scalp' ? settings.scalpTfs : settings.scanTfs;
  const histFor = mode => (mode || settings.mode) === 'scalp' ? Math.max(settings.history, settings.scalpHistory) : settings.history;
  const modeLabel = m => m === 'scalp' ? 'Scalper' : 'Regular';
  const stratName = id => { const s = Strat.byId(id, settings.threshold); return s ? s.name : id; };
  const pct = v => (v * 100).toFixed(0) + '%';

  function toast(msg, ms = 2800) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function ring(score) {
    const s = Math.max(0, Math.min(100, score || 0));
    const color = s >= 85 ? 'var(--champ)' : s >= 65 ? 'var(--label)' : s >= 40 ? 'var(--label-2)' : 'var(--label-3)';
    return `<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="rb" cx="18" cy="18" r="15.9"/><circle class="rf" cx="18" cy="18" r="15.9" stroke="${color}" stroke-dasharray="${s} 100"/></svg><span class="rv">${s}</span><span class="rl">${Strat.scoreLabel(s)}</span>`;
  }

  // MT5 plan grid. Flags when the account is too small for the market's minimum lot.
  function planHTML(sym, p, balance, riskPct) {
    if (!p) return '';
    const bal = balance || settings.balance, rp = riskPct || settings.riskPct;
    const sp = specOf(sym, p.entry), sz = Strat.sizing(p, bal, rp, sp);
    const lotTxt = !sz ? '-' : sz.fits ? lots(sz.lots) : `<span class="neg">min ${lots(sz.minLot)}</span>`;
    return `<div class="en"><div class="k">Entry</div><div class="v">${price(sym, p.entry)}</div></div>
      <div class="sl"><div class="k">Stop loss</div><div class="v">${price(sym, p.sl)}</div></div>
      <div class="tp"><div class="k">TP1 ${p.tp1R}R</div><div class="v">${price(sym, p.tp1)}</div></div>
      <div class="tp"><div class="k">TP2 ${p.tp2R}R</div><div class="v">${price(sym, p.tp2)}</div></div>
      <div><div class="k">Risk ${rp}%</div><div class="v">${sz ? money(sz.risk) : '-'}</div></div>
      <div><div class="k">MT5 lots</div><div class="v">${lotTxt}</div></div>`;
  }
  const lotWarn = (sym, p, balance, riskPct) => {
    const sz = p && Strat.sizing(p, balance || settings.balance, riskPct || settings.riskPct, specOf(sym, p.entry));
    return sz && !sz.fits ? `<p class="warn-line">The minimum lot (${lots(sz.minLot)}) risks ${money(sz.minRisk)} on this stop, ${(sz.minRisk / (balance || settings.balance) * 100).toFixed(1)}% of the balance. Skip it or use the Under $10 tab.</p>` : '';
  };

  // Deriv Trader Multipliers plan grid
  function multHTML(sym, p, riskUsd) {
    const m = Strat.multiplierPlan(p, riskUsd, specOf(sym, p.entry));
    if (!m) return '';
    return `<div class="en"><div class="k">${p.dir === 1 ? 'Up' : 'Down'} stake</div><div class="v">${money(m.stake)}</div></div>
      <div><div class="k">Multiplier</div><div class="v">x${m.mult >= 10 ? Math.floor(m.mult) : m.mult.toFixed(1)}</div></div>
      <div class="sl"><div class="k">Stop loss</div><div class="v">${money(m.slUsd)}</div></div>
      <div class="tp"><div class="k">Take profit</div><div class="v">${money(m.tp1Usd)}</div></div>
      <div><div class="k">Commission</div><div class="v">${money(m.commission)}</div></div>
      <div><div class="k">Cost of risk</div><div class="v ${m.costR > 0.25 ? 'neg' : ''}">${pct(m.costR)}</div></div>`;
  }

  // Win rate next to the win rate this strategy needs to break even, after costs
  function statsHTML(res, L) {
    const ago = L ? `<span>Signal <b>${L.barsAgo === 0 ? 'this candle' : L.barsAgo + ' candle' + (L.barsAgo > 1 ? 's' : '') + ' ago'}</b></span>` : '';
    return ago + `<span>Win <b>${pct(res.winRate)}</b>${res.breakevenWin ? ` (needs ${pct(res.breakevenWin)})` : ''}</span>
      <span>Avg <b>${res.avgR >= 0 ? '+' : ''}${res.avgR.toFixed(2)}R</b> after costs</span><span>Trades <b>${res.trades}</b></span>
      <span>Hold <b>${Math.max(1, Math.round(res.avgHold || 0))}</b> candles</span>`;
  }

  function tradeFrom(sym, g, res, L, bal, riskPct, mode, riskUsd) {
    const p = L.plan, sz = Strat.sizing(p, bal, riskPct, specOf(sym, p.entry));
    return { sym, g, strategy: res.strategy, name: res.name, dir: L.active, mode: mode || Strat.modeOf(res.strategy),
      entry: p.entry, sl: p.sl, tp1: p.tp1, tp2: p.tp2, tp1R: p.tp1R, dist: p.dist, score: res.score,
      risk: riskUsd || (sz ? sz.risk : 0), bal, maxHold: res.maxHold || (mode === 'scalp' ? Strat.MODES.scalp.maxHold : settings.maxHold) };
  }

  // ---------- daily guardrails (count trades you marked as taken) ----------
  function guardState() {
    const g = settings.guard, start = new Date(); start.setHours(0, 0, 0, 0);
    const today = log.filter(a => a.taken && (a.takenAt || a.t) >= start.getTime());
    const closedT = today.filter(a => a.status !== 'open');
    // profit and loss as % of the balance each trade was sized from
    const pnlPct = closedT.reduce((s, a) => s + (a.R || 0) * (a.risk || 0) / (a.bal || settings.balance) * 100, 0);
    const losses = closedT.filter(a => a.R <= 0).length;
    const lossHit = pnlPct <= -g.lossPct, tradesHit = today.length >= g.maxTrades, profitHit = pnlPct >= g.profitPct;
    const reason = lossHit ? `Daily loss stop reached (${pnlPct.toFixed(1)}%). Signals are paused until tomorrow.`
      : profitHit ? `Daily target reached (+${pnlPct.toFixed(1)}%). Lock it in and stop for today.`
      : tradesHit ? `${today.length} trades taken today, your limit is ${g.maxTrades}. Signals are paused until tomorrow.` : '';
    return { on: g.on, trades: today.length, pnlPct, losses, lossHit, tradesHit, profitHit, paused: g.on && !!reason, reason };
  }
  function guardHTML() {
    const s = guardState();
    if (!s.on) return '';
    if (s.paused) return `<div class="glass note warn guard"><b>${esc(s.reason)}</b></div>`;
    return `<div class="guard-line">Today: ${s.trades}/${settings.guard.maxTrades} trades, ${s.pnlPct >= 0 ? '+' : ''}${s.pnlPct.toFixed(1)}%, stop at -${settings.guard.lossPct}%, target +${settings.guard.profitPct}%</div>`;
  }

  // Record a trade you took, then follow it to its stop or target
  function takeTrade(t) {
    if (log.some(a => a.taken && a.sym === t.sym && a.g === t.g && a.status === 'open' && a.dir === t.dir)) { toast('Already tracking that trade'); return; }
    const g = guardState();
    if (g.paused) toast(g.reason, 5000);
    log.unshift(Object.assign({ id: Date.now() + Math.random(), t: Date.now(), status: 'open', bars: 0, taken: true, takenAt: Date.now() }, t));
    if (log.length > 300) log.length = 300;
    store.set('log2', log);
    if (!watch.some(w => w.sym === t.sym && w.g === t.g)) toggleWatch(t.sym, t.g, t.strategy, t.mode, true);
    renderLog(); renderGuards();
    toast(`Tracking your ${sigWord(t.dir)} on ${nameOf(t.sym)}. It counts toward today's limits.`);
  }
  function renderGuards() { document.querySelectorAll('[data-guard]').forEach(el => { el.innerHTML = guardHTML(); }); }

  function stratOptions(withAuto, mode) {
    const lib = Strat.library(settings.threshold, mode || settings.mode);
    const opt = s => `<option value="${s.id}">${esc(s.name)}</option>`;
    if ((mode || settings.mode) === 'scalp') return (withAuto ? '<option value="auto">Best for each market (auto)</option>' : '') +
      '<optgroup label="Scalper library">' + lib.map(opt).join('') + '</optgroup>';
    return (withAuto ? '<option value="auto">Best for each market (auto)</option>' : '') +
      '<optgroup label="Researched top 5">' + lib.filter(s => s.group === 'preset').map(opt).join('') + '</optgroup>' +
      '<optgroup label="Classic tools">' + lib.filter(s => s.group === 'classic').map(opt).join('') + '</optgroup>' +
      '<optgroup label="Combined">' + lib.filter(s => s.group === 'combo').map(opt).join('') + '</optgroup>';
  }

  function fillTfSelect(el, value) {
    el.innerHTML = TF.map(([g, l]) => `<option value="${g}"${g === value ? ' selected' : ''}>${l}</option>`).join('');
  }
  function fillSymSelect(el, value, withAll) {
    const groups = {};
    for (const s of symbols) (groups[s.group] = groups[s.group] || []).push(s);
    let html = withAll ? '<option value="__all__">All Vixed indices (slower)</option>' : '';
    for (const g of Object.keys(groups).sort()) {
      html += `<optgroup label="${esc(g)}">` + groups[g].map(s => `<option value="${esc(s.symbol)}">${esc(s.name)}</option>`).join('') + '</optgroup>';
    }
    el.innerHTML = html;
    if (value && [...el.options].some(o => o.value === value)) el.value = value;
  }

  // ---------- live price board and ticker ----------
  const prices = new Map(); // sym -> {p, prev}
  function notePrice(sym, p) {
    if (!Number.isFinite(p)) return;
    const cur = prices.get(sym);
    prices.set(sym, { p, prev: cur ? cur.p : p });
  }
  function renderTicker() {
    const items = [...prices.entries()].slice(0, 24);
    if (!items.length) return;
    const html = items.map(([sym, v]) => {
      const d = v.p > v.prev ? 'up' : v.p < v.prev ? 'down' : '';
      return `<span class="tick"><b>${esc(nameOf(sym).replace(/ Index$/, ''))}</b><span class="${d}">${price(sym, v.p)}</span></span>`;
    }).join('');
    $('tickerTrack').innerHTML = html + html; // doubled for a seamless loop
    $('tickerTrack').classList.toggle('static', items.length < 3);
    for (const [, v] of prices) v.prev = v.p;
  }
  setInterval(renderTicker, 4000);

  // ---------- candle cache: full load once, then only the newest candles ----------
  const cache = new Map();
  async function history(sym, g, count) {
    const key = sym + '|' + g, c = cache.get(key);
    if (c && count <= c.want && Date.now() - c.ts < g * 1000 * 40) {
      const fresh = await client.candles(sym, g, Math.min(120, count));
      if (fresh.length) {
        const first = fresh[0].epoch;
        c.candles = c.candles.filter(x => x.epoch < first).concat(fresh).slice(-c.want);
      }
      c.ts = Date.now();
      return c.candles.slice(-count);
    }
    const candles = await client.candles(sym, g, count);
    cache.set(key, { candles, ts: Date.now(), want: count });
    return candles;
  }

  // ---------- tabs ----------
  let currentTab = 'scan';
  function showTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== tab; });
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'alerts') { unread = 0; renderBadge(); }
    if (tab === 'chart' && !chartState.sym && symbols.length) openChart(settings.chartSym, settings.chartTf);
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- connection ----------
  client.on('status', (st, key) => {
    $('connDot').className = 'dot ' + st;
    $('connText').textContent = st === 'online' ? 'Live' : st === 'connecting' ? 'Connecting' : 'Offline';
    $('connDetail').textContent = st === 'online'
      ? 'Connected to ' + (key === 'legacy' ? 'Deriv API v3' : 'Deriv API public feed') + '.'
      : st === 'offline' ? 'Cannot reach Deriv. Check your internet. SynthScope keeps retrying.' : 'Connecting...';
  });
  client.on('reconnect', () => { restartWatchers(); if (chartState.sym) openChart(chartState.sym, chartState.g); });
  $('connBtn').addEventListener('click', () => showTab('settings'));

  async function loadSymbols() {
    const cached = store.get('symbols', null);
    try { symbols = await client.symbols(); store.set('symbols', symbols); }
    catch (e) { if (cached) symbols = cached; else throw e; }
    symbols.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const s of symbols) { s.fam = Strat.family(s.symbol, s.name); bySym[s.symbol] = s; }
    if (!bySym[settings.chartSym]) settings.chartSym = bySym.R_75 ? 'R_75' : symbols[0] && symbols[0].symbol;
    fillSymSelect($('chartSym'), settings.chartSym);
    fillSymSelect($('testSym'), settings.testSym || settings.chartSym, true);
    fillSymSelect($('specSym'), settings.chartSym); renderSpecs();
    const fams = [...new Set(symbols.map(s => s.fam))];
    $('scanGroup').innerHTML = '<option value="">All Vixed indices</option>' +
      fams.map(f => `<option value="${f}">${esc(Strat.FAMILY_LABEL[f] || f)} indices</option>`).join('');
    $('scanGroup').value = settings.scanGroup;
    $('scanMeta').textContent = `${symbols.length} Vixed indices available. Pick timeframes and run Smart Scan.`;
  }

  // ---------- SMART SCAN ----------
  let scanning = false, scanTimer = null, scanAt = null;
  const scanResults = new Map(); // sym|g -> result

  function renderTfChips() {
    const tfs = tfsFor(), list = settings.mode === 'scalp' ? TF.filter(([g]) => g <= 900) : TF;
    $('scanTfChips').innerHTML = list.map(([g]) => `<button type="button" class="chip${tfs.includes(g) ? ' on' : ''}" data-tf="${g}" aria-pressed="${tfs.includes(g)}">${tfShort(g)}</button>`).join('');
  }
  $('scanTfChips').addEventListener('click', e => {
    const b = e.target.closest('[data-tf]'); if (!b) return;
    const tfs = tfsFor(), g = +b.dataset.tf, i = tfs.indexOf(g);
    if (i >= 0) { if (tfs.length > 1) tfs.splice(i, 1); } else tfs.push(g);
    tfs.sort((a, c) => a - c); saveSettings(); renderTfChips();
  });

  // Regular or Scalper, shared by Smart Scan and the Chart
  function setMode(m) {
    if (m === settings.mode) return;
    settings.mode = m;
    if (Strat.modeOf(settings.scanStrategy) !== m) settings.scanStrategy = 'auto';
    if (Strat.modeOf(settings.chartStrategy) !== m) settings.chartStrategy = 'auto';
    saveSettings();
    clearTimeout(scanTimer); scanResults.clear();
    renderModeUI(); renderScan();
    $('scanMeta').textContent = m === 'scalp'
      ? 'Scalper mode: 1 minute setups with tight stops, TP1 at 1R and a 15 candle limit. Every backtest pays the spread. Run Smart Scan.'
      : 'Regular mode: the researched top 5, classic tools and combined score on 5 minute and slower charts. Run Smart Scan.';
    if (chartState.sym) { if (m === 'scalp' && chartState.g > 900) { settings.chartTf = 60; $('chartTf').value = 60; openChart(chartState.sym, 60); } else renderChartFull(); }
  }
  function renderModeUI() {
    document.querySelectorAll('[data-mode]').forEach(b => { const on = b.dataset.mode === settings.mode; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
    $('scanStrategy').innerHTML = stratOptions(true); $('scanStrategy').value = settings.scanStrategy;
    $('chartStrategy').innerHTML = stratOptions(true); $('chartStrategy').value = settings.chartStrategy;
    document.body.classList.toggle('scalp', settings.mode === 'scalp');
    renderTfChips();
  }
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  function evaluateMarket(sym, g, candles) {
    const S = Strat.compute(candles), opts = engineOpts(sym, S);
    const i = S.n - 2;
    notePrice(sym, S.close[S.n - 1]);
    let ranked;
    if (settings.scanStrategy === 'auto') ranked = Strat.recommend(S, opts);
    else { const r = Strat.backtest(S, Strat.byId(settings.scanStrategy, settings.threshold), opts); ranked = r ? [r] : []; }
    const best = ranked[0];
    let proposal = null;
    for (const r of ranked.slice(0, 3)) {
      const L = Strat.live(S, Strat.byId(r.strategy, settings.threshold), i, Object.assign({ fresh: 2 }, opts));
      if (L.active) { proposal = { r, L }; break; }
    }
    const bestLive = best ? Strat.live(S, Strat.byId(best.strategy, settings.threshold), i, opts) : null;
    return { sym, g, mode: opts.mode, best, bestLive, proposal, top: ranked.slice(0, 3), regime: Strat.regime(S, i), price: S.close[S.n - 1], at: Date.now() };
  }

  async function runScan(isLive) {
    if (scanning) return;
    if (!client.ws) { if (!isLive) toast('Not connected to Deriv yet'); return; }
    scanning = true;
    const tfs = tfsFor().slice(), list = symbols.filter(s => !settings.scanGroup || s.fam === settings.scanGroup), mode = settings.mode;
    const jobs = [];
    for (const s of list) for (const g of tfs) jobs.push([s.symbol, g]);
    $('scanBtn').disabled = true; $('scanProgress').hidden = false;
    const t0 = Date.now(); let done = 0, failed = 0;
    // forget results that are no longer in scope
    for (const k of [...scanResults.keys()]) { const [s, g] = k.split('|'); if (!tfs.includes(+g) || !list.some(x => x.symbol === s)) scanResults.delete(k); }
    for (const [sym, g] of jobs) {
      $('scanProgText').textContent = `${isLive ? 'Live update' : 'Scanning'} ${nameOf(sym)}, ${tfShort(g)} (${done + 1}/${jobs.length})`;
      try {
        const candles = await history(sym, g, histFor(mode));
        if (mode !== settings.mode) break; // mode changed mid-scan
        if (candles.length >= Strat.WARMUP + 40) scanResults.set(sym + '|' + g, evaluateMarket(sym, g, candles));
      } catch (e) { failed++; console.warn(sym, g, e.message); }
      done++;
      $('scanBar').style.width = (done / jobs.length * 100) + '%';
      if (done % 6 === 0 || done === jobs.length) { renderScan(); await sleep(0); }
    }
    scanning = false; scanAt = new Date();
    $('scanBtn').disabled = false; $('scanProgress').hidden = true;
    const secs = Math.round((Date.now() - t0) / 1000);
    $('scanMeta').textContent = `${modeLabel(mode)}: scanned ${list.length} Vixed indices on ${tfs.map(tfShort).join(', ')} at ${scanAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} in ${secs}s` + (failed ? `. ${failed} could not load.` : '.');
    renderScan(); renderTicker();
    scheduleScan();
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    $('liveChip').hidden = !settings.scanLive || !scanResults.size;
    if (!settings.scanLive || !scanResults.size) return;
    const ms = Math.min(...tfsFor()) * 1000;
    const wait = Math.max(20000, ms - (Date.now() % ms) + 3000); // just after the next candle closes
    scanTimer = setTimeout(() => runScan(true), wait);
  }

  function renderScan() {
    const all = [...scanResults.values()];
    const props = all.filter(r => r.proposal).sort((a, b) => b.proposal.r.score - a.proposal.r.score || a.proposal.L.barsAgo - b.proposal.L.barsAgo);
    $('countSignals').textContent = props.length;
    // market board: best timeframe per index
    const bestBySym = new Map();
    for (const r of all) { if (!r.best) continue; const cur = bestBySym.get(r.sym); if (!cur || r.best.score > cur.best.score) bestBySym.set(r.sym, r); }
    const board = [...bestBySym.values()].sort((a, b) => b.best.score - a.best.score);
    $('countBoard').textContent = board.length;
    const watched = new Set(watch.map(w => w.sym + '|' + w.g));

    const gs = guardState();
    const lead = props[0] && props[0].proposal.L.active;
    document.documentElement.dataset.ambient = lead === 1 ? 'buy' : lead === -1 ? 'sell' : settings.mode === 'scalp' ? 'scalp' : '';
    $('proposals').innerHTML = props.map(r => {
      const { r: res, L } = r.proposal, p = L.plan, dir = L.active, fam = famOf(r.sym);
      return `<article class="glass card ${sigClass(dir)}${gs.paused ? ' paused' : ''}">
        <div class="card-top">
          <span class="pill big ${sigClass(dir)}">${sigWord(dir)}</span>
          <div class="card-id"><div class="card-name">${esc(nameOf(r.sym))}</div>
            <div class="card-sub"><span class="tag cyan">${tfShort(r.g)}</span>${r.mode === 'scalp' ? ' <span class="tag violet">Scalp</span>' : ''} ${esc(res.name)}</div></div>
          <div class="ring-wrap">${ring(res.score)}</div>
        </div>
        <div class="plan">${planHTML(r.sym, p)}</div>
        ${lotWarn(r.sym, p)}
        ${(fam === 'boom' || fam === 'crash') ? '<p class="warn-line">Spikes can jump straight past a stop loss. Size small.</p>' : ''}
        <div class="card-foot">
          <div class="card-stats">${statsHTML(res, L)}</div>
          <div class="r-right">
            <button class="btn small" type="button" data-open="${esc(r.sym)}" data-g="${r.g}" data-strat="${res.strategy}">Chart</button>
            <button class="btn small" type="button" data-watch="${esc(r.sym)}" data-g="${r.g}">${watched.has(r.sym + '|' + r.g) ? 'Watching' : 'Watch'}</button>
            <button class="btn small primary" type="button" data-take="${esc(r.sym)}" data-g="${r.g}">Took it</button>
          </div>
        </div>
      </article>`;
    }).join('') || `<div class="glass empty">${scanResults.size ? 'No fresh signals right now. The scan keeps checking on every new candle.' : 'Run Smart Scan to see live signals.'}</div>`;
    renderGuards();

    $('board').innerHTML = board.map(r => {
      const st = r.bestLive ? r.bestLive.state : 0;
      return `<li class="row-btn" data-open="${esc(r.sym)}" data-g="${r.g}" data-strat="${r.best.strategy}"><div>
        <div class="r-name">${esc(nameOf(r.sym))}</div>
        <div class="r-sub">${tfShort(r.g)}, ${esc(r.best.name)}, ${esc(r.regime.name)}</div></div>
        <span class="r-right"><span class="pill ${sigClass(st)}">${sigWord(st)}</span><span class="mini-score">${r.best.score}</span></span></li>`;
    }).join('');
    setScanView(settings.scanView);
  }

  function setScanView(v) {
    settings.scanView = v;
    $('segSignals').classList.toggle('active', v === 'signals'); $('segBoard').classList.toggle('active', v === 'board');
    $('proposals').hidden = v !== 'signals'; $('board').hidden = v !== 'board' || !$('board').children.length;
  }
  $('segSignals').addEventListener('click', () => { setScanView('signals'); saveSettings(); });
  $('segBoard').addEventListener('click', () => { setScanView('board'); saveSettings(); });

  function onScanClick(e) {
    const tk = e.target.closest('[data-take]');
    if (tk) {
      const r = scanResults.get(tk.dataset.take + '|' + tk.dataset.g);
      if (r && r.proposal) takeTrade(tradeFrom(r.sym, r.g, r.proposal.r, r.proposal.L, settings.balance, settings.riskPct, r.mode));
      renderScan(); return;
    }
    const w = e.target.closest('[data-watch]');
    if (w) { toggleWatch(w.dataset.watch, +w.dataset.g, 'auto'); renderScan(); return; }
    const o = e.target.closest('[data-open]');
    if (o) {
      settings.chartSym = o.dataset.open; settings.chartTf = +o.dataset.g; settings.chartStrategy = o.dataset.strat || 'auto'; saveSettings();
      $('chartSym').value = settings.chartSym; $('chartTf').value = settings.chartTf; $('chartStrategy').value = settings.chartStrategy;
      showTab('chart'); openChart(settings.chartSym, settings.chartTf);
    }
  }
  $('proposals').addEventListener('click', onScanClick);
  $('board').addEventListener('click', onScanClick);
  $('scanBtn').addEventListener('click', () => runScan(false));
  $('scanLive').addEventListener('change', e => { settings.scanLive = e.target.checked; saveSettings(); scheduleScan(); });
  $('scanGroup').addEventListener('change', e => { settings.scanGroup = e.target.value; saveSettings(); });
  $('scanStrategy').addEventListener('change', e => { settings.scanStrategy = e.target.value; saveSettings(); });

  // ---------- CHART ----------
  const chartState = { sym: null, g: null, candles: [], subId: null, chart: null, series: {}, lines: [], token: 0, rec: [], live: null };
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  function buildChart() {
    if (chartState.chart) return;
    const c = LightweightCharts.createChart($('chart'), {
      autoSize: true,
      layout: { background: { color: 'rgba(0,0,0,0)' }, textColor: cssVar('--muted'), fontFamily: 'Geist, -apple-system, system-ui, sans-serif' },
      grid: { vertLines: { color: cssVar('--chart-grid') }, horzLines: { color: cssVar('--chart-grid') } },
      rightPriceScale: { borderColor: cssVar('--stroke') },
      timeScale: { borderColor: cssVar('--stroke'), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 }
    });
    chartState.chart = c;
    chartState.series.candles = c.addCandlestickSeries({ upColor: cssVar('--buy'), downColor: cssVar('--sell'), wickUpColor: cssVar('--buy'), wickDownColor: cssVar('--sell'), borderVisible: false });
    const line = color => c.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    chartState.series.ema21 = line(cssVar('--line-a'));
    chartState.series.ema200 = line(cssVar('--line-b'));
    chartState.series.st = line(cssVar('--line-c'));
  }

  async function openChart(sym, g) {
    if (!sym || !client.ws) return;
    const token = ++chartState.token;
    if (chartState.subId) { client.forget(chartState.subId); chartState.subId = null; }
    chartState.sym = sym; chartState.g = g;
    buildChart();
    $('sigPill').textContent = '...'; $('sigPill').className = 'pill big'; $('sigSub').textContent = 'Loading ' + nameOf(sym);
    try {
      const { candles, subId } = await client.subscribeCandles(sym, g, histFor(), bar => onChartBar(token, bar));
      if (token !== chartState.token) { client.forget(subId); return; }
      chartState.subId = subId; chartState.candles = candles;
      renderChartFull();
      chartState.chart.timeScale().scrollToRealTime();
    } catch (e) { if (token === chartState.token) toast('Could not load ' + nameOf(sym) + ': ' + e.message); }
    $('mtfBox').hidden = true;
    updateWatchBtn();
  }

  function onChartBar(token, bar) {
    if (token !== chartState.token) return;
    const cs = chartState.candles, last = cs[cs.length - 1];
    notePrice(chartState.sym, bar.close);
    if (!last || bar.epoch > last.epoch) { cs.push(bar); if (cs.length > histFor() + 50) cs.shift(); renderChartFull(); }
    else if (bar.epoch === last.epoch) { cs[cs.length - 1] = bar; chartState.series.candles.update(toBar(bar)); }
  }
  const toBar = c => ({ time: c.epoch + tzShift, open: c.open, high: c.high, low: c.low, close: c.close });

  function renderChartFull() {
    const cs = chartState.candles, sym = chartState.sym;
    if (cs.length < 3) return;
    const S = Strat.compute(cs), t = i => cs[i].epoch + tzShift, opts = engineOpts(sym, S);
    chartState.series.candles.setData(cs.map(toBar));
    const lineData = arr => arr.map((v, i) => v === null ? null : { time: t(i), value: v }).filter(Boolean);
    chartState.series.ema21.setData(lineData(S.ema21));
    chartState.series.ema200.setData(lineData(S.ema200));
    chartState.series.st.setData(lineData(S.st.line));
    for (const l of chartState.lines) chartState.series.candles.removePriceLine(l);
    chartState.lines = [];

    if (S.n < Strat.WARMUP + 40) {
      $('sigPill').textContent = 'WAIT'; $('sigStrat').textContent = 'Not enough history';
      $('sigSub').textContent = 'This timeframe needs more candles before strategies can be judged.';
      $('sigPlan').innerHTML = ''; $('sigRing').innerHTML = ''; $('recStrip').innerHTML = ''; $('partsList').innerHTML = '';
      chartState.series.candles.setMarkers([]); return;
    }
    const rec = Strat.recommend(S, opts);
    chartState.rec = rec;
    const chosenId = settings.chartStrategy === 'auto' || !rec.some(r => r.strategy === settings.chartStrategy) ? rec[0].strategy : settings.chartStrategy;
    const strat = Strat.byId(chosenId, settings.threshold), res = rec.find(r => r.strategy === chosenId);
    const L = Strat.live(S, strat, S.n - 2, Object.assign({ fresh: 2 }, opts));
    chartState.live = { L, res, strat };

    chartState.series.candles.setMarkers(Strat.events(S, strat, opts).slice(-150).map(e => e.dir === 1
      ? { time: t(e.i), position: 'belowBar', color: cssVar('--buy'), shape: 'arrowUp', text: 'BUY' }
      : { time: t(e.i), position: 'aboveBar', color: cssVar('--sell'), shape: 'arrowDown', text: 'SELL' }));

    $('recStrip').innerHTML = '<span class="label">Best here</span>' + rec.slice(0, 3).map(r =>
      `<button type="button" class="chip${r.strategy === chosenId ? ' on' : ''}" data-pick="${r.strategy}">${esc(r.name.replace(/ \(.*\)/, ''))}, ${r.score}</button>`).join('');
    const dir = L.active;
    $('sigPill').textContent = sigWord(dir); $('sigPill').className = 'pill big ' + sigClass(dir);
    $('sigStrat').textContent = strat.name + (settings.chartStrategy === 'auto' ? ' (auto)' : '');
    $('sigSub').textContent = dir
      ? `Signal ${L.barsAgo === 0 ? 'on the last closed candle' : L.barsAgo + ' candles ago'}, ${Strat.regime(S, S.n - 2).name} market`
      : (L.lastDir ? `No fresh signal. Last ${sigWord(L.lastDir)} ${L.barsAgo} candles ago.` : 'No signal in the last 60 candles.');
    $('sigRing').innerHTML = res ? ring(res.score) : '';
    $('sigPlan').innerHTML = dir ? planHTML(sym, L.plan) : '';
    const fam = famOf(sym), lw = dir ? lotWarn(sym, L.plan).replace(/<[^>]+>/g, '') : '';
    $('sigWarn').hidden = !(dir && (fam === 'boom' || fam === 'crash' || lw));
    $('sigWarn').textContent = [lw, (fam === 'boom' || fam === 'crash') ? 'Spikes can jump straight past a stop loss. Size small.' : ''].filter(Boolean).join(' ');
    $('sigStats').innerHTML = res ? statsHTML(res) + `<span>Mode <b>${modeLabel(opts.mode)}</b></span>` : '';
    if (dir && L.plan) {
      const P = L.plan, mk = (p, color, title) => chartState.series.candles.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
      chartState.lines = [mk(P.entry, cssVar('--label'), 'Entry'), mk(P.sl, cssVar('--sell'), 'SL'), mk(P.tp1, cssVar('--buy'), 'TP1'), mk(P.tp2, cssVar('--buy'), 'TP2')];
    }
    // every strategy's live read
    $('partsList').innerHTML = rec.map(r => {
      const st = Strat.byId(r.strategy, settings.threshold), l = Strat.live(S, st, S.n - 2, opts);
      return `<li class="row-btn" data-pick="${r.strategy}"><div><div class="r-name">${esc(r.name)}</div>
        <div class="r-sub">${esc(l.reading)}, ${r.trades} trades, ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(2)}R avg</div></div>
        <span class="r-right"><span class="pill ${sigClass(l.state)}">${sigWord(l.state)}</span><span class="mini-score">${r.score}</span></span></li>`;
    }).join('');
  }

  function pickStrategy(id) {
    settings.chartStrategy = id; saveSettings(); $('chartStrategy').value = id; renderChartFull(); updateWatchBtn();
  }
  $('recStrip').addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) pickStrategy(b.dataset.pick); });
  $('partsList').addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) { pickStrategy(b.dataset.pick); window.scrollTo({ top: 0, behavior: 'smooth' }); } });

  async function runMtf() {
    const sym = chartState.sym; if (!sym) return;
    $('mtfBox').hidden = false; $('mtfBtn').disabled = true;
    const out = [];
    const tfList = settings.mode === 'scalp' ? TF.filter(([g]) => g <= 900) : TF;
    $('mtfList').innerHTML = `<li class="r-sub">Checking ${tfList.length} timeframes...</li>`;
    for (const [g] of tfList) {
      try {
        const cs = await history(sym, g, histFor());
        if (cs.length >= Strat.WARMUP + 40) {
          const S = Strat.compute(cs), opts = engineOpts(sym, S), rec = Strat.recommend(S, opts), best = rec[0];
          out.push({ g, best, L: Strat.live(S, Strat.byId(best.strategy, settings.threshold), S.n - 2, Object.assign({ fresh: 2 }, opts)) });
        } else out.push({ g });
      } catch (e) { out.push({ g }); }
      $('mtfList').innerHTML = out.map(r => r.best
        ? `<li class="row-btn" data-g="${r.g}"><div><div class="r-name">${tfLabel(r.g)}</div><div class="r-sub">${esc(r.best.name)}, ${r.L.active ? 'fresh signal' : 'no fresh signal'}</div></div>
           <span class="r-right"><span class="pill ${sigClass(r.L.active)}">${sigWord(r.L.active)}</span><span class="mini-score">${r.best.score}</span></span></li>`
        : `<li><div><div class="r-name">${tfLabel(r.g)}</div><div class="r-sub">Not enough history</div></div><span class="pill">-</span></li>`).join('');
    }
    $('mtfBtn').disabled = false;
  }
  $('mtfList').addEventListener('click', e => {
    const b = e.target.closest('[data-g]'); if (!b) return;
    settings.chartTf = +b.dataset.g; saveSettings(); $('chartTf').value = settings.chartTf; openChart(settings.chartSym, settings.chartTf); window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('chartSym').addEventListener('change', e => { settings.chartSym = e.target.value; saveSettings(); openChart(settings.chartSym, settings.chartTf); });
  $('chartTf').addEventListener('change', e => { settings.chartTf = +e.target.value; saveSettings(); openChart(settings.chartSym, settings.chartTf); });
  $('chartStrategy').addEventListener('change', e => pickStrategy(e.target.value));
  $('mtfBtn').addEventListener('click', runMtf);
  $('watchBtn').addEventListener('click', () => { if (chartState.sym) { toggleWatch(chartState.sym, chartState.g, settings.chartStrategy); updateWatchBtn(); } });
  $('chartTakeBtn').addEventListener('click', () => {
    const lv = chartState.live;
    if (!lv || !lv.L.active || !lv.res) { toast('No fresh signal to take on this chart'); return; }
    takeTrade(tradeFrom(chartState.sym, chartState.g, lv.res, lv.L, settings.balance, settings.riskPct, settings.mode));
  });
  $('chartTestBtn').addEventListener('click', () => {
    $('testSym').value = chartState.sym; $('testTf').value = chartState.g; $('testMode').value = settings.mode;
    settings.testSym = chartState.sym; settings.testTf = chartState.g; settings.testMode = settings.mode; saveSettings();
    showTab('test'); $('testPanel').scrollIntoView({ behavior: 'smooth' }); runTest();
  });
  function updateWatchBtn() {
    const on = watch.some(w => w.sym === chartState.sym && w.g === chartState.g);
    $('watchBtn').textContent = on ? 'Remove from alerts' : 'Add to alerts';
  }

  // ---------- STRATEGY LIBRARY + BACKTEST ----------
  function renderLibrary() {
    const famChips = list => list.map(f => `<span class="tag">${esc(Strat.FAMILY_LABEL[f] || f)}</span>`).join(' ');
    const card = s => `<article class="glass lib">
      <div class="lib-head"><span class="lib-rank">${s.rank}</span><div><div class="lib-name">${esc(s.name)}</div><div>${famChips(s.bestFor)}</div></div></div>
      <p>${esc(s.rules)}</p><p class="src">${esc(s.source)}</p></article>`;
    $('libCards').innerHTML = Strat.PRESETS.map(card).join('');
    $('scalpCards').innerHTML = Strat.SCALP.map(card).join('');
    $('classicList').innerHTML = Strat.library(settings.threshold).filter(s => s.group !== 'preset').map(s =>
      `<li><div><div class="r-name">${esc(s.name)}</div><div class="r-sub">${esc(s.rules)}</div></div></li>`).join('');
  }

  let testing = false;
  async function runTest() {
    if (testing) return;
    if (!client.ws) { toast('Not connected to Deriv yet'); return; }
    testing = true;
    const sym = $('testSym').value, g = +$('testTf').value, count = +$('testCount').value, mode = $('testMode').value;
    const hold = +$('testHold').value || Strat.MODES[mode].maxHold;
    const list = sym === '__all__' ? symbols.map(s => s.symbol) : [sym];
    $('testBtn').disabled = true; $('testProgress').hidden = false; $('testWrap').hidden = true; $('testNote').hidden = true;
    const results = []; let done = 0;
    for (const s of list) {
      $('testProgText').textContent = `Testing ${nameOf(s)} (${done + 1}/${list.length})`;
      try {
        const cs = await client.candles(s, g, count);
        const S = Strat.compute(cs), opts = Object.assign(engineOpts(s, S, mode), { maxHold: hold });
        for (const r of Strat.recommend(S, opts)) results.push(Object.assign(r, { sym: s }));
      } catch (e) { console.warn(s, e.message); }
      done++; $('testBar').style.width = (done / list.length * 100) + '%';
      await sleep(0);
    }
    testing = false; $('testBtn').disabled = false; $('testProgress').hidden = true;
    renderTest(results, list.length > 1, g, hold, mode);
  }

  function renderTest(results, multi, g, hold, mode) {
    const m = Strat.library(settings.threshold, mode).length;
    if (!results.length) { $('testMeta').textContent = 'No results. The market may not have enough history on this timeframe.'; return; }
    const rows = (multi ? results.filter(r => r.trades >= Strat.MIN_TRADES) : results).sort((a, b) => b.score - a.score || (b.zAdj || b.z) - (a.zAdj || a.z)).slice(0, multi ? 25 : 99);
    const sgn = v => (v > 0 ? '+' : '') + v.toFixed(2);
    $('testTable').querySelector('tbody').innerHTML = rows.map(r => `<tr>
      <td><div class="r-name">${esc(r.name)}</div>${multi ? `<div class="r-sub">${esc(nameOf(r.sym))}</div>` : ''}</td>
      <td class="num">${r.trades}</td><td class="num">${(r.winRate * 100).toFixed(0)}%</td><td class="num">${r.breakevenWin ? pct(r.breakevenWin) : '-'}</td>
      <td class="num ${r.avgR > 0 ? 'pos' : r.avgR < 0 ? 'neg' : ''}">${sgn(r.avgR)}</td><td class="num">${sgn(r.baseR)}</td>
      <td class="num ${r.edge > 0 ? 'pos' : r.edge < 0 ? 'neg' : ''}">${sgn(r.edge)}</td><td class="num">${r.z.toFixed(1)}</td>
      <td class="num">${r.score}</td><td><span class="verdict v-${r.verdict.code}">${esc(r.verdict.label)}</span></td></tr>`).join('');
    $('testWrap').hidden = false;
    const tests = results.filter(r => r.trades >= Strat.MIN_TRADES).length;
    const edges = results.filter(r => r.verdict.code === 'edge').length, luck = (tests / m) * 0.00135; // scores are already corrected within each market
    $('testMeta').textContent = multi
      ? `${modeLabel(mode)}: tested ${tests} strategy and market pairs on ${tfLabel(g)} candles with a ${hold}-candle max hold, spread included. Showing the top 25.`
      : `${modeLabel(mode)}: ${nameOf(results[0].sym)}, ${results[0].candles.toLocaleString()} candles of ${tfLabel(g)}, ${hold}-candle max hold, spread included.`;
    $('testNote').innerHTML = `<b>${edges}</b> result${edges === 1 ? '' : 's'} passed the Possible edge test. With ${Math.max(1, Math.round(tests / m))} market${tests > m ? 's' : ''} tested, about <b>${luck < 0.1 ? luck.toFixed(2) : luck.toFixed(1)}</b> would pass by pure luck. ` +
      (edges === 0 ? 'Nothing here beats chance, which is what a random market should show.' : edges <= Math.max(1, luck * 3) ? 'That is close to what luck alone produces. Recheck it on another timeframe or later data before trusting it.' : 'That is more than luck would explain. Recheck it on fresh data, then forward test it with alerts before trading it.');
    $('testNote').hidden = false;
  }
  $('testBtn').addEventListener('click', runTest);
  $('testSym').addEventListener('change', e => { settings.testSym = e.target.value; saveSettings(); });
  $('testTf').addEventListener('change', e => { settings.testTf = +e.target.value; saveSettings(); });
  $('testCount').addEventListener('change', e => { settings.testCount = +e.target.value; saveSettings(); });
  $('testHold').addEventListener('change', e => { settings.testHold = +e.target.value; saveSettings(); });
  $('testMode').addEventListener('change', e => { settings.testMode = e.target.value; saveSettings(); });

  // ---------- ALERTS ----------
  const watchers = new Map();
  let unread = 0;
  const wkey = (sym, g) => sym + '|' + g;

  function toggleWatch(sym, g, strategy, mode, silent) {
    const i = watch.findIndex(w => w.sym === sym && w.g === g);
    if (i >= 0) { watch.splice(i, 1); stopWatcher(wkey(sym, g)); toast('Stopped watching ' + nameOf(sym) + ' ' + tfShort(g)); }
    else {
      if (watch.length >= 20) { toast('You can watch up to 20 market and timeframe pairs'); return; }
      const st = strategy || 'auto', m = st === 'auto' ? (mode || settings.mode) : Strat.modeOf(st);
      const item = { sym, g, strategy: st, mode: m };
      watch.push(item); startWatcher(item);
      if (!silent) toast('Watching ' + nameOf(sym) + ' on ' + tfLabel(g) + (st === 'auto' ? ` with the best ${modeLabel(m).toLowerCase()} strategy` : ' with ' + stratName(st)));
    }
    store.set('watch2', watch); renderWatch();
  }

  async function startWatcher(item) {
    const key = wkey(item.sym, item.g);
    if (watchers.has(key) || !client.ws) return;
    const w = Object.assign({ candles: [], subId: null, snap: null, lastAlert: null }, item);
    watchers.set(key, w);
    try {
      const { candles, subId } = await client.subscribeCandles(item.sym, item.g, histFor(item.mode || 'swing'), bar => onWatchBar(w, bar));
      if (watchers.get(key) !== w) { client.forget(subId); return; }
      w.subId = subId; w.candles = candles;
      evaluateWatch(w, false);
    } catch (e) {
      watchers.delete(key);
      console.warn('watch failed', item.sym, e.message);
      setTimeout(() => { if (watch.some(x => x.sym === item.sym && x.g === item.g) && client.ws) startWatcher(item); }, 10000);
    }
    renderWatch();
  }
  function stopWatcher(key) { const w = watchers.get(key); if (!w) return; if (w.subId) client.forget(w.subId); watchers.delete(key); }
  function restartWatchers() { watchers.clear(); for (const it of watch) startWatcher(it); }

  function onWatchBar(w, bar) {
    const cs = w.candles, last = cs[cs.length - 1];
    notePrice(w.sym, bar.close);
    const isNew = !last || bar.epoch > last.epoch;
    if (isNew) { cs.push(bar); if (cs.length > histFor(w.mode || 'swing') + 50) cs.shift(); }
    else if (bar.epoch === last.epoch) cs[cs.length - 1] = bar;
    trackOutcomes(w, bar, isNew);
    if (isNew) evaluateWatch(w, true);
  }

  function evaluateWatch(w, canAlert) {
    if (w.candles.length < Strat.WARMUP + 40) return;
    const mode = w.strategy === 'auto' ? (w.mode || 'swing') : Strat.modeOf(w.strategy);
    const S = Strat.compute(w.candles), opts = engineOpts(w.sym, S, mode);
    const rec = Strat.recommend(S, opts);
    const id = w.strategy === 'auto' ? rec[0].strategy : w.strategy;
    const strat = Strat.byId(id, settings.threshold), res = rec.find(r => r.strategy === id);
    const L = Strat.live(S, strat, S.n - 2, Object.assign({ fresh: 0 }, opts));
    w.snap = { id, name: strat.name, score: res ? res.score : 0, state: L.state, active: L.active, mode };
    const candleTime = S.time[S.n - 2];
    if (canAlert && L.active && L.plan && (res ? res.score : 0) >= settings.minAlertScore && w.lastAlert !== candleTime) {
      w.lastAlert = candleTime;
      fireAlert(w, strat, res, L, mode);
    }
    renderWatch();
  }

  function fireAlert(w, strat, res, L, mode) {
    const p = L.plan;
    const entry = Object.assign({ id: Date.now() + Math.random(), t: Date.now(), status: 'open', bars: 0 },
      tradeFrom(w.sym, w.g, res || { strategy: strat.id, name: strat.name, score: 0 }, L, settings.balance, settings.riskPct, mode));
    log.unshift(entry); if (log.length > 300) log.length = 300;
    store.set('log2', log); renderLog();
    const title = `${sigWord(L.active)} ${nameOf(w.sym)} (${tfShort(w.g)})${mode === 'scalp' ? ' scalp' : ''}`;
    const body = `Entry ${price(w.sym, p.entry)}, SL ${price(w.sym, p.sl)}, TP1 ${price(w.sym, p.tp1)}, ${strat.name}, edge ${entry.score}`;
    const gs = guardState();
    if (gs.paused) { toast('Signal skipped. ' + gs.reason, 5000); return; } // stays in the log, no sound or notification
    toast(title + '. ' + body, 6000);
    if (settings.sound) beep(L.active);
    if (settings.vibrate && navigator.vibrate) { try { navigator.vibrate(L.active === 1 ? [120, 60, 120] : [300]); } catch (_) {} }
    notify(title, body);
    if (currentTab !== 'alerts') { unread++; renderBadge(); }
  }

  // Virtual forward test: follow each alert until it hits the stop, TP1 or the max hold
  function trackOutcomes(w, bar, isNew) {
    let changed = false;
    for (const a of log) {
      if (a.status !== 'open' || a.sym !== w.sym || a.g !== w.g) continue;
      if (bar.epoch * 1000 < a.t - a.g * 1000) continue;
      if (isNew) a.bars++;
      const hitSL = a.dir === 1 ? bar.low <= a.sl : bar.high >= a.sl;
      const hitTP = a.dir === 1 ? bar.high >= a.tp1 : bar.low <= a.tp1;
      if (hitSL) { a.status = 'sl'; a.R = -1; }
      else if (hitTP) { a.status = 'tp'; a.R = a.tp1R || Strat.TP1_R; }
      else if (a.bars >= (a.maxHold || settings.maxHold)) { a.status = 'time'; a.R = a.dir * (bar.close - a.entry) / a.dist; }
      if (a.status !== 'open') { a.closedAt = Date.now(); changed = true; }
    }
    if (changed) { store.set('log2', log); renderLog(); renderGuards(); renderScan(); }
  }

  function renderBadge() { const b = $('alertBadge'); b.hidden = unread === 0; b.textContent = unread > 9 ? '9+' : unread; }

  let audioCtx = null;
  function beep(dir) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime, notes = dir === 1 ? [660, 990] : [560, 370];
      notes.forEach((f, k) => {
        const o = audioCtx.createOscillator(), gn = audioCtx.createGain();
        o.frequency.value = f; o.type = 'triangle';
        gn.gain.setValueAtTime(0.0001, now + k * 0.16);
        gn.gain.exponentialRampToValueAtTime(0.25, now + k * 0.16 + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, now + k * 0.16 + 0.15);
        o.connect(gn).connect(audioCtx.destination);
        o.start(now + k * 0.16); o.stop(now + k * 0.16 + 0.16);
      });
    } catch (_) { /* audio unavailable */ }
  }
  document.addEventListener('click', () => { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (_) {} }, { once: true });

  const LN = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  let notifId = 1;
  async function notify(title, body) {
    try {
      if (isNative() && LN()) { await LN().schedule({ notifications: [{ id: notifId++, title, body }] }); return; }
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'ss-' + Date.now() });
      } else new Notification(title, { body, icon: 'icons/icon-192.png' });
    } catch (e) { console.warn('notify failed', e); }
  }
  async function askNotify() {
    try {
      if (isNative() && LN()) { const r = await LN().requestPermissions(); toast(r.display === 'granted' ? 'Notifications on' : 'Notifications blocked. Turn them on in Android settings.'); }
      else if ('Notification' in window) { const p = await Notification.requestPermission(); toast(p === 'granted' ? 'Notifications on' : 'Notifications blocked in browser settings'); }
      else toast('This browser does not support notifications');
    } catch (e) { toast('Could not ask for notifications'); }
    updateNotifBtn();
  }
  function updateNotifBtn() {
    const granted = !isNative() && 'Notification' in window && Notification.permission === 'granted';
    $('notifBtn').textContent = granted ? 'Notifications on' : 'Allow notifications';
  }
  $('notifBtn').addEventListener('click', askNotify);

  function renderWatch() {
    $('watchEmpty').hidden = watch.length > 0;
    $('watchList').innerHTML = watch.map(it => {
      const w = watchers.get(wkey(it.sym, it.g)), s = w && w.snap;
      const mode = it.strategy === 'auto' ? 'Auto' : 'Fixed';
      return `<li><div><div class="r-name">${esc(nameOf(it.sym))}, ${tfShort(it.g)}</div>
        <div class="r-sub">${s ? `${mode} ${modeLabel(it.mode || 'swing').toLowerCase()}: ${esc(s.name)}, edge ${s.score}` : (client.ws ? 'Loading...' : 'Waiting for connection')}</div></div>
        <span class="r-right"><span class="pill ${s ? sigClass(s.state) : ''}">${s ? sigWord(s.state) : '-'}</span>
        <button class="btn ghost small" type="button" data-unwatch="${esc(it.sym)}" data-g="${it.g}">Remove</button></span></li>`;
    }).join('');
  }
  $('watchList').addEventListener('click', e => { const b = e.target.closest('[data-unwatch]'); if (b) { toggleWatch(b.dataset.unwatch, +b.dataset.g); updateWatchBtn(); } });

  function renderLog() {
    const closed = log.filter(a => a.status !== 'open');
    const wins = closed.filter(a => a.R > 0).length, net = closed.reduce((s, a) => s + (a.R || 0), 0);
    $('fwdStats').innerHTML = `<div><div class="k">Signals</div><div class="v">${log.length}</div></div>
      <div><div class="k">Closed</div><div class="v">${closed.length}</div></div>
      <div><div class="k">Win rate</div><div class="v">${closed.length ? Math.round(wins / closed.length * 100) + '%' : '-'}</div></div>
      <div><div class="k">Net R</div><div class="v" style="color:${net > 0 ? 'var(--buy)' : net < 0 ? 'var(--sell)' : 'inherit'}">${closed.length ? (net > 0 ? '+' : '') + net.toFixed(1) : '-'}</div></div>`;
    const status = a => a.status === 'open' ? 'Open' : a.status === 'tp' ? `Hit TP1, +${a.tp1R || Strat.TP1_R}R` : a.status === 'sl' ? 'Hit stop, -1R' : `Closed after ${a.bars} candles, ${a.R >= 0 ? '+' : ''}${a.R.toFixed(2)}R`;
    $('alertLog').innerHTML = log.slice(0, 60).map(a => `<li><div>
      <div class="r-name"><span class="pill ${sigClass(a.dir)}">${sigWord(a.dir)}</span> ${esc(nameOf(a.sym))}, ${tfShort(a.g)}${a.mode === 'scalp' ? ' <span class="tag violet">Scalp</span>' : ''}${a.taken ? ' <span class="tag cyan">Taken</span>' : ''}</div>
      <div class="r-sub">${new Date(a.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}, ${esc(a.name)}, edge ${a.score}</div>
      <div class="r-sub mono">Entry ${price(a.sym, a.entry)}, SL ${price(a.sym, a.sl)}, TP1 ${price(a.sym, a.tp1)}${a.risk ? ', risk ' + money(a.risk) : ''}</div>
      <div class="r-sub">${status(a)}</div></div>${a.status === 'open' && !a.taken ? `<button class="btn small" type="button" data-took="${a.id}">Took it</button>` : ''}</li>`).join('') || '<li class="r-sub">No alerts yet.</li>';
  }
  $('alertLog').addEventListener('click', e => {
    const b = e.target.closest('[data-took]'); if (!b) return;
    const a = log.find(x => String(x.id) === b.dataset.took); if (!a) return;
    a.taken = true; a.takenAt = Date.now(); store.set('log2', log); renderLog(); renderGuards();
    const gs = guardState(); toast(gs.paused ? gs.reason : 'Marked as taken. It counts toward today\'s limits.');
  });
  $('clearLog').addEventListener('click', () => { log = []; store.set('log2', log); renderLog(); renderGuards(); });

  // ---------- UNDER $10 ----------
  const LADDER = [5, 7.5, 10, 15, 20, 30, 40, 50, 75, 100];
  const small = settings.small;
  const smallRiskPct = () => small.plan === 'challenge' ? 5 : 2;
  const smallTarget = () => small.plan === 'challenge' ? Math.max(small.target, small.balance * 1.5) : small.balance * 2;
  const smallStyle = () => small.style === 'scalp' ? { mode: 'scalp', tfs: [60] } : { mode: 'swing', tfs: [300, 900] };
  // the risk in dollars for the next trade under the chosen plan
  const smallRisk = bal => {
    const b = small.plan === 'challenge' ? (LADDER.filter(s => s <= bal).pop() || bal) : bal;
    return b * smallRiskPct() / 100;
  };
  let smallRunning = false, smallRows = [];

  function renderSmallPlan() {
    const bal = small.balance, rp = smallRiskPct(), risk = smallRisk(bal), mt5 = small.platform === 'mt5';
    $('smallPlanBox').innerHTML = small.plan === 'challenge'
      ? `<p><b>Growth challenge:</b> risk 5% of the ladder step you have reached, so risk only steps up after the balance grows, and steps back down after losses. Goal ${money(smallTarget())}. This is high risk: a run of bad trades can end the account.</p>
         <div class="ladder">${LADDER.filter(s => s <= Math.max(smallTarget(), bal)).map(s => `<span class="${s <= bal && (LADDER.filter(x => x <= bal).pop() === s) ? 'on' : ''}"><b>${money(s)}</b> risk ${money(s * 0.05)}</span>`).join('')}</div>`
      : `<p><b>Safe plan:</b> risk 2% per trade, ${money(risk)} on ${money(bal)}, only on markets where the smallest trade fits. Goal ${money(smallTarget())}, doubling the account. Daily limits from Settings apply.</p>`;
    $('smallPlanBox').innerHTML += mt5
      ? `<p class="meta">MT5: each trade must be at least the market's minimum lot, so on a small balance many markets are too big. The list below shows which ones fit.</p>`
      : `<p class="meta">Multipliers: stake from $1 and the most you can lose is the stake. Deriv charges at least $0.10 commission per trade, which is a big share of a ${money(risk)} risk, so the backtests below include it.</p>`;
  }

  async function runSmall() {
    if (smallRunning) return;
    if (!client.ws) { toast('Not connected to Deriv yet'); return; }
    smallRunning = true;
    const { mode, tfs } = smallStyle(), bal = small.balance, mt5 = small.platform === 'mt5';
    const risk = smallRisk(bal), list = symbols.slice(), jobs = [];
    for (const s of list) for (const g of tfs) jobs.push([s.symbol, g]);
    $('smallBtn').disabled = true; $('smallProgress').hidden = false;
    smallRows = []; let done = 0;
    for (const [sym, g] of jobs) {
      $('smallProgText').textContent = `Checking ${nameOf(sym)} ${tfShort(g)} (${done + 1}/${jobs.length})`;
      try {
        const cs = await history(sym, g, histFor(mode));
        if (cs.length >= Strat.WARMUP + 40) smallRows.push(evaluateSmall(sym, g, cs, mode, bal, risk, mt5));
      } catch (e) { console.warn(sym, g, e.message); }
      done++; $('smallBar').style.width = (done / jobs.length * 100) + '%';
      if (done % 8 === 0) { renderSmall(); await sleep(0); }
    }
    smallRunning = false; $('smallBtn').disabled = false; $('smallProgress').hidden = true;
    renderSmall();
  }

  function evaluateSmall(sym, g, cs, mode, bal, risk, mt5) {
    const S = Strat.compute(cs), px = lastPx(S), sp = specOf(sym, px), i = S.n - 2;
    const typDist = Strat.MODES[mode].atrStop * (S.atr[i] || 0);
    const minRisk = mt5 ? sp.minLot * sp.contract * typDist : 0; // dollars at risk with the smallest MT5 trade
    // Multipliers: no spread, but a fixed commission per trade, in R of this account's risk
    const multCost = r => Math.max(0.1 / r, sp.multRate * px / (typDist || 1));
    const opts = Object.assign(engineOpts(sym, S, mode), mt5 ? {} : { spread: 0, costR: multCost(risk) });
    const rec = Strat.recommend(S, opts), best = rec[0];
    let proposal = null;
    // small accounts only get signals from strategies that made money after every cost
    for (const r of rec.slice(0, 3)) {
      if (!(r.avgR > 0) || r.trades < Strat.MIN_TRADES) continue;
      const L = Strat.live(S, Strat.byId(r.strategy, settings.threshold), i, Object.assign({ fresh: 2 }, opts));
      if (L.active) { proposal = { r, L }; break; }
    }
    const fits = mt5 ? minRisk <= risk * 1.05 : bal >= 1 && risk >= 0.1;
    let sim = null;
    if (best && best.trades >= Strat.MIN_TRADES) {
      const gross = Strat.honestRs(best).map(x => x + (opts.costR || 0));
      sim = Strat.growthSim({ Rs: gross, start: bal, riskPct: smallRiskPct(), target: smallTarget(),
        ladder: small.plan === 'challenge' ? LADDER : null, floor: mt5 ? 0 : 1, trials: 1500,
        minRisk: () => minRisk, cost: mt5 ? null : r => multCost(r) });
    }
    notePrice(sym, px);
    return { sym, g, mode, best, proposal, fits, minRisk, sim, sp };
  }

  function renderSmall() {
    const bal = small.balance, risk = smallRisk(bal), mt5 = small.platform === 'mt5';
    const ok = smallRows.filter(r => r.fits);
    const props = ok.filter(r => r.proposal).sort((a, b) => b.proposal.r.score - a.proposal.r.score);
    $('smallSignals').innerHTML = props.slice(0, 12).map(r => {
      const { r: res, L } = r.proposal, dir = L.active, fam = famOf(r.sym);
      return `<article class="glass card ${sigClass(dir)}">
        <div class="card-top">
          <span class="pill big ${sigClass(dir)}">${mt5 ? sigWord(dir) : dir === 1 ? 'UP' : 'DOWN'}</span>
          <div class="card-id"><div class="card-name">${esc(nameOf(r.sym))}</div>
            <div class="card-sub"><span class="tag cyan">${tfShort(r.g)}</span>${r.mode === 'scalp' ? ' <span class="tag violet">Scalp</span>' : ''} ${esc(res.name)}</div></div>
          <div class="ring-wrap">${ring(res.score)}</div>
        </div>
        <div class="plan">${mt5 ? planHTML(r.sym, L.plan, bal, smallRiskPct()) : multHTML(r.sym, L.plan, risk)}</div>
        ${!mt5 ? `<p class="meta">On Deriv Trader pick Multipliers ${dir === 1 ? 'Up' : 'Down'}, the stake and the multiplier shown (or the nearest one offered below it), then set the stop loss and take profit amounts. A lower multiplier keeps the same dollar stop but gives price more room.</p>` : ''}
        ${(fam === 'boom' || fam === 'crash') ? '<p class="warn-line">Spikes can jump straight past a stop loss.</p>' : ''}
        <div class="card-foot"><div class="card-stats">${statsHTML(res, L)}</div>
          <button class="btn small primary" type="button" data-small-take="${esc(r.sym)}" data-g="${r.g}">Took it</button></div>
      </article>`;
    }).join('') || `<div class="glass empty">${smallRows.length ? 'No fresh signals from a strategy that made money after costs on a market that fits this balance. Try again on the next candle.' : 'Tap Find small account trades.'}</div>`;

    const ranked = ok.filter(r => r.best && r.best.avgR > 0 && r.best.trades >= Strat.MIN_TRADES).sort((a, b) => b.best.score - a.best.score || (b.sim ? b.sim.pTarget : 0) - (a.sim ? a.sim.pTarget : 0));
    $('smallBest').innerHTML = ranked.slice(0, 15).map(r => `<li class="row-btn" data-small-open="${esc(r.sym)}" data-g="${r.g}" data-strat="${r.best.strategy}"><div>
      <div class="r-name">${esc(nameOf(r.sym))}, ${tfShort(r.g)}</div>
      <div class="r-sub">${esc(r.best.name)}, win ${pct(r.best.winRate)}${r.best.breakevenWin ? ', needs ' + pct(r.best.breakevenWin) : ''}, ${r.best.avgR >= 0 ? '+' : ''}${r.best.avgR.toFixed(2)}R</div>
      ${r.sim ? `<div class="r-sub">Simulated: <b class="${r.sim.pTarget >= r.sim.pBust ? 'pos' : 'neg'}">${pct(r.sim.pTarget)}</b> reach ${money(smallTarget())}, <b>${pct(r.sim.pBust)}</b> blow up, about ${r.sim.medianTrades} trades</div>` : ''}
      </div><span class="r-right"><span class="mini-score">${r.best.score}</span></span></li>`).join('') ||
      `<li class="r-sub">${smallRows.length ? 'No strategy made money after costs on the markets that fit this balance. On random markets that is the normal result, especially once Multiplier commission is counted.' : 'Nothing yet.'}</li>`;

    const rows = smallRows.filter((r, k, a) => a.findIndex(x => x.sym === r.sym) === k).sort((a, b) => (b.fits - a.fits) || a.minRisk - b.minRisk);
    $('smallMarkets').innerHTML = mt5 ? rows.map(r => `<li><div><div class="r-name">${esc(nameOf(r.sym))}</div>
      <div class="r-sub">Min lot ${lots(r.sp.minLot)}, smallest trade risks about ${money(r.minRisk)} (${(r.minRisk / bal * 100).toFixed(0)}% of ${money(bal)})${r.sp.custom ? ', your values' : ''}</div></div>
      <span class="pill ${r.fits ? 'buy' : 'sell'}">${r.fits ? 'Fits' : 'Too big'}</span></li>`).join('')
      : `<li class="r-sub">On Multipliers every market fits from a $1 stake. Commission is at least $0.10 a trade, ${pct(0.1 / risk)} of your ${money(risk)} risk.</li>`;
    $('smallCount').textContent = mt5 && rows.length ? `${rows.filter(r => r.fits).length} of ${rows.length} fit` : '';
    $('smallCount').hidden = !$('smallCount').textContent;
    renderGuards();
  }

  function bindSmall() {
    $('smallBalance').value = small.balance; $('smallTarget').value = small.target; $('smallStyle').value = small.style;
    const segs = () => {
      document.querySelectorAll('[data-plat]').forEach(b => b.classList.toggle('active', b.dataset.plat === small.platform));
      document.querySelectorAll('[data-plan]').forEach(b => b.classList.toggle('active', b.dataset.plan === small.plan));
      $('smallTargetWrap').hidden = small.plan !== 'challenge';
    };
    const changed = () => { saveSettings(); segs(); renderSmallPlan(); if (smallRows.length) $('smallMeta').textContent = 'Settings changed. Run the search again to update the results.'; };
    document.querySelectorAll('[data-plat]').forEach(b => b.addEventListener('click', () => { small.platform = b.dataset.plat; changed(); }));
    document.querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', () => { small.plan = b.dataset.plan; changed(); }));
    $('smallBalance').addEventListener('change', e => { const v = parseFloat(e.target.value); if (v >= 1 && v <= 1e6) { small.balance = v; changed(); } else { e.target.value = small.balance; toast('Enter a balance of at least $1'); } });
    $('smallTarget').addEventListener('change', e => { const v = parseFloat(e.target.value); if (v > small.balance) { small.target = v; changed(); } else { e.target.value = small.target; toast('The goal must be above the balance'); } });
    $('smallStyle').addEventListener('change', e => { small.style = e.target.value; changed(); });
    $('smallBtn').addEventListener('click', () => { $('smallMeta').textContent = ''; runSmall(); });
    $('smallSignals').addEventListener('click', e => {
      const b = e.target.closest('[data-small-take]'); if (!b) return;
      const r = smallRows.find(x => x.sym === b.dataset.smallTake && x.g === +b.dataset.g); if (!r || !r.proposal) return;
      const mt5 = small.platform === 'mt5', risk = smallRisk(small.balance);
      takeTrade(tradeFrom(r.sym, r.g, r.proposal.r, r.proposal.L, small.balance, smallRiskPct(), r.mode, mt5 ? null : risk));
    });
    $('smallBest').addEventListener('click', e => {
      const o = e.target.closest('[data-small-open]'); if (!o) return;
      const r = smallRows.find(x => x.sym === o.dataset.smallOpen && x.g === +o.dataset.g);
      if (r && r.mode !== settings.mode) setMode(r.mode);
      settings.chartSym = o.dataset.smallOpen; settings.chartTf = +o.dataset.g; settings.chartStrategy = o.dataset.strat; saveSettings();
      $('chartSym').value = settings.chartSym; $('chartTf').value = settings.chartTf; $('chartStrategy').value = settings.chartStrategy;
      showTab('chart'); openChart(settings.chartSym, settings.chartTf);
    });
    segs(); renderSmallPlan();
  }

  // ---------- costs and contract specs (Settings) ----------
  function renderSpecs() {
    const sym = $('specSym').value; if (!sym) return;
    const px = (prices.get(sym) || {}).p, est = Strat.spec(sym, nameOf(sym), px, null), o = settings.specs[sym] || {};
    $('specMinLot').placeholder = est.minLot; $('specContract').placeholder = est.contract;
    $('specSpread').placeholder = px ? +est.spread.toPrecision(3) : 'run a scan first';
    $('specMinLot').value = o.minLot || ''; $('specContract').value = o.contract || ''; $('specSpread').value = o.spread ?? '';
    $('specNote').textContent = (settings.specs[sym] ? 'Using your values. ' : 'Using estimates (shown faded). ') +
      'Find the real numbers in MT5: Market Watch, right click the symbol, Specification. Spread is in price points.';
  }
  function saveSpec() {
    const sym = $('specSym').value; if (!sym) return;
    const num = id => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : undefined; };
    const o = { minLot: num('specMinLot'), contract: num('specContract'), spread: num('specSpread') };
    if (o.minLot === undefined && o.contract === undefined && o.spread === undefined) delete settings.specs[sym];
    else settings.specs[sym] = o;
    saveSettings(); renderSpecs(); toast('Saved. Rescan to use the new costs.');
  }

  // ---------- SETTINGS ----------
  function bindCheck(id, key, after) {
    const el = $(id); el.checked = !!settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); if (after) after(); });
  }
  bindCheck('optSound', 'sound');
  bindCheck('optVibrate', 'vibrate');
  bindCheck('optAwake', 'awake', applyWakeLock);
  bindCheck('optSpike', 'spikeOnly', refreshAll);
  bindCheck('scanLive', 'scanLive');

  function bindNumber(id, key, min, max) {
    const el = $(id); el.value = settings[key];
    el.addEventListener('change', () => {
      const v = parseFloat(el.value);
      if (Number.isFinite(v) && v >= min && v <= max) { settings[key] = v; saveSettings(); refreshAll(); }
      else { el.value = settings[key]; toast('Enter a number between ' + min + ' and ' + max); }
    });
  }
  bindNumber('optBalance', 'balance', 1, 1e9);
  bindNumber('optRisk', 'riskPct', 0.1, 10);

  $('optThreshold').value = settings.threshold; $('thrVal').textContent = settings.threshold;
  $('optThreshold').addEventListener('input', e => { $('thrVal').textContent = e.target.value; });
  $('optThreshold').addEventListener('change', e => { settings.threshold = +e.target.value; saveSettings(); refreshAll(); });
  $('optMinScore').value = settings.minAlertScore; $('minScoreVal').textContent = settings.minAlertScore;
  $('optMinScore').addEventListener('input', e => { $('minScoreVal').textContent = e.target.value; });
  $('optMinScore').addEventListener('change', e => { settings.minAlertScore = +e.target.value; saveSettings(); });
  $('optHistory').value = settings.history;
  $('optHistory').addEventListener('change', e => { settings.history = +e.target.value; saveSettings(); cache.clear(); toast('History changes apply to the next scan and chart'); });
  $('optEndpoint').value = settings.endpoint; $('optAppId').value = settings.appId;
  $('optEndpoint').addEventListener('change', e => { settings.endpoint = e.target.value; saveSettings(); reconnect(); });
  $('optAppId').addEventListener('change', e => { settings.appId = e.target.value.replace(/\D/g, ''); e.target.value = settings.appId; saveSettings(); });
  $('reconnectBtn').addEventListener('click', reconnect);
  $('appVersion').textContent = VERSION;

  // daily guardrails
  $('optGuard').checked = settings.guard.on;
  $('optGuard').addEventListener('change', e => { settings.guard.on = e.target.checked; saveSettings(); renderGuards(); renderScan(); });
  [['optLossPct', 'lossPct', 1, 50], ['optMaxTrades', 'maxTrades', 1, 200], ['optProfitPct', 'profitPct', 1, 100]].forEach(([id, key, min, max]) => {
    const el = $(id); el.value = settings.guard[key];
    el.addEventListener('change', () => {
      const v = parseFloat(el.value);
      if (Number.isFinite(v) && v >= min && v <= max) { settings.guard[key] = v; saveSettings(); renderGuards(); renderScan(); }
      else { el.value = settings.guard[key]; toast('Enter a number between ' + min + ' and ' + max); }
    });
  });
  // costs
  $('specSym').addEventListener('change', renderSpecs);
  $('specSave').addEventListener('click', saveSpec);
  $('specReset').addEventListener('click', () => { delete settings.specs[$('specSym').value]; saveSettings(); renderSpecs(); toast('Back to the estimate'); });

  function refreshAll() {
    if (chartState.candles.length) renderChartFull();
    for (const w of watchers.values()) evaluateWatch(w, false);
    for (const [k, r] of scanResults) { const c = cache.get(k); if (c) scanResults.set(k, evaluateMarket(r.sym, r.g, c.candles)); }
    renderScan();
  }

  let wakeLock = null;
  async function applyWakeLock() {
    try {
      if (settings.awake && 'wakeLock' in navigator && document.visibilityState === 'visible') { if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } }
      else if (!settings.awake && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (_) { if (settings.awake) toast('This device would not keep the screen on. Change it in display settings.'); }
  }

  async function reconnect() {
    client.configure(settings.endpoint, settings.appId);
    try { await client.reconnectNow(); if (!symbols.length) await loadSymbols(); toast('Connected'); } catch (e) { toast('Could not reach Deriv'); }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    applyWakeLock();
    if (!client.ws) reconnect();
    else if (settings.scanLive && scanResults.size && !scanning) runScan(true);
  });

  // ---------- disclaimer ----------
  if (!store.get('agreed2', false)) $('disclaimer').hidden = false;
  $('disclaimerOk').addEventListener('click', () => { store.set('agreed2', true); $('disclaimer').hidden = true; });

  // ---------- start ----------
  fillTfSelect($('chartTf'), settings.chartTf);
  fillTfSelect($('testTf'), settings.testTf);
  $('testCount').value = settings.testCount; $('testHold').value = settings.testHold;
  $('testMode').value = settings.testMode;
  renderModeUI(); renderLibrary(); renderWatch(); renderLog(); updateNotifBtn(); setScanView(settings.scanView);
  bindSmall(); renderSmall(); renderGuards();

  (async function start() {
    client.configure(settings.endpoint, settings.appId);
    try {
      await client.connect();
      await loadSymbols();
      for (const it of watch) startWatcher(it);
      if (currentTab === 'chart') openChart(settings.chartSym, settings.chartTf);
    } catch (e) {
      const cached = store.get('symbols', null);
      if (cached && !symbols.length) { symbols = cached; for (const s of symbols) { s.fam = Strat.family(s.symbol, s.name); bySym[s.symbol] = s; } }
      $('scanMeta').textContent = 'Cannot reach Deriv right now. SynthScope will keep trying.';
      client.on('reconnect', async () => { if (!$('chartSym').options.length) await loadSymbols().catch(() => {}); });
    }
  })();

  if ('serviceWorker' in navigator && location.protocol === 'https:' && !isNative()) navigator.serviceWorker.register('sw.js').catch(() => {});
  applyWakeLock();
})();
