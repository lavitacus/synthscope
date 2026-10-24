/* SynthScope 2: Smart Scan, live trade plans, strategy library, backtests and alerts. */
(function () {
  'use strict';
  const VERSION = '2.1.0';
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
    chartSym: 'R_75', chartTf: 300, chartStrategy: 'auto', testSym: '', testTf: 300, testCount: 2500, testHold: 50
  };
  const settings = Object.assign({}, DEFAULTS, store.get('settings2', {}));
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
  const engineOpts = sym => ({ family: famOf(sym), spikeOnly: settings.spikeOnly, threshold: settings.threshold, maxHold: settings.maxHold });
  const stratName = id => { const s = Strat.byId(id, settings.threshold); return s ? s.name : id; };

  function toast(msg, ms = 2800) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function ring(score) {
    const s = Math.max(0, Math.min(100, score || 0));
    const color = s >= 85 ? 'var(--buy)' : s >= 65 ? 'var(--cyan)' : s >= 40 ? 'var(--amber)' : 'var(--wait)';
    return `<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="rb" cx="18" cy="18" r="15.9"/><circle class="rf" cx="18" cy="18" r="15.9" stroke="${color}" stroke-dasharray="${s} 100"/></svg><span class="rv">${s}</span><span class="rl">${Strat.scoreLabel(s)}</span>`;
  }

  function planHTML(sym, p) {
    if (!p) return '';
    const sz = Strat.sizing(p, settings.balance, settings.riskPct);
    return `<div class="en"><div class="k">Entry</div><div class="v">${price(sym, p.entry)}</div></div>
      <div class="sl"><div class="k">Stop loss</div><div class="v">${price(sym, p.sl)}</div></div>
      <div class="tp"><div class="k">TP1 1.5R</div><div class="v">${price(sym, p.tp1)}</div></div>
      <div class="tp"><div class="k">TP2 3R</div><div class="v">${price(sym, p.tp2)}</div></div>
      <div><div class="k">Risk ${settings.riskPct}%</div><div class="v">${sz ? money(sz.risk) : '-'}</div></div>
      <div><div class="k">MT5 lots</div><div class="v">${sz ? lots(sz.lots) : '-'}</div></div>`;
  }

  function stratOptions(withAuto) {
    const lib = Strat.library(settings.threshold);
    const opt = s => `<option value="${s.id}">${esc(s.name)}</option>`;
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
    if (c && c.candles.length >= Math.min(count, c.want) * 0.9 && Date.now() - c.ts < g * 1000 * 40) {
      const fresh = await client.candles(sym, g, Math.min(120, count));
      if (fresh.length) {
        const first = fresh[0].epoch;
        c.candles = c.candles.filter(x => x.epoch < first).concat(fresh).slice(-count);
      }
      c.ts = Date.now();
      return c.candles;
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
    $('scanTfChips').innerHTML = TF.map(([g]) => `<button type="button" class="chip${settings.scanTfs.includes(g) ? ' on' : ''}" data-tf="${g}" aria-pressed="${settings.scanTfs.includes(g)}">${tfShort(g)}</button>`).join('');
  }
  $('scanTfChips').addEventListener('click', e => {
    const b = e.target.closest('[data-tf]'); if (!b) return;
    const g = +b.dataset.tf, i = settings.scanTfs.indexOf(g);
    if (i >= 0) { if (settings.scanTfs.length > 1) settings.scanTfs.splice(i, 1); } else settings.scanTfs.push(g);
    settings.scanTfs.sort((a, c) => a - c); saveSettings(); renderTfChips();
  });

  function evaluateMarket(sym, g, candles) {
    const S = Strat.compute(candles), opts = engineOpts(sym);
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
    return { sym, g, best, bestLive, proposal, top: ranked.slice(0, 3), regime: Strat.regime(S, i), price: S.close[S.n - 1], at: Date.now() };
  }

  async function runScan(isLive) {
    if (scanning) return;
    if (!client.ws) { if (!isLive) toast('Not connected to Deriv yet'); return; }
    scanning = true;
    const tfs = settings.scanTfs.slice(), list = symbols.filter(s => !settings.scanGroup || s.fam === settings.scanGroup);
    const jobs = [];
    for (const s of list) for (const g of tfs) jobs.push([s.symbol, g]);
    $('scanBtn').disabled = true; $('scanProgress').hidden = false;
    const t0 = Date.now(); let done = 0, failed = 0;
    // forget results that are no longer in scope
    for (const k of [...scanResults.keys()]) { const [s, g] = k.split('|'); if (!tfs.includes(+g) || !list.some(x => x.symbol === s)) scanResults.delete(k); }
    for (const [sym, g] of jobs) {
      $('scanProgText').textContent = `${isLive ? 'Live update' : 'Scanning'} ${nameOf(sym)} · ${tfShort(g)} (${done + 1}/${jobs.length})`;
      try {
        const candles = await history(sym, g, settings.history);
        if (candles.length >= Strat.WARMUP + 40) scanResults.set(sym + '|' + g, evaluateMarket(sym, g, candles));
      } catch (e) { failed++; console.warn(sym, g, e.message); }
      done++;
      $('scanBar').style.width = (done / jobs.length * 100) + '%';
      if (done % 6 === 0 || done === jobs.length) { renderScan(); await sleep(0); }
    }
    scanning = false; scanAt = new Date();
    $('scanBtn').disabled = false; $('scanProgress').hidden = true;
    const secs = Math.round((Date.now() - t0) / 1000);
    $('scanMeta').textContent = `Scanned ${list.length} Vixed indices on ${tfs.map(tfShort).join(', ')} at ${scanAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} in ${secs}s` + (failed ? `. ${failed} could not load.` : '.');
    renderScan(); renderTicker();
    scheduleScan();
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    $('liveChip').hidden = !settings.scanLive || !scanResults.size;
    if (!settings.scanLive || !scanResults.size) return;
    const ms = Math.min(...settings.scanTfs) * 1000;
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

    $('proposals').innerHTML = props.map(r => {
      const { r: res, L } = r.proposal, p = L.plan, dir = L.active, fam = famOf(r.sym);
      return `<article class="glass card ${sigClass(dir)}">
        <div class="card-top">
          <span class="pill big ${sigClass(dir)}">${sigWord(dir)}</span>
          <div class="card-id"><div class="card-name">${esc(nameOf(r.sym))}</div>
            <div class="card-sub"><span class="tag cyan">${tfShort(r.g)}</span> ${esc(res.name)}</div></div>
          <div class="ring-wrap">${ring(res.score)}</div>
        </div>
        <div class="plan">${planHTML(r.sym, p)}</div>
        ${(fam === 'boom' || fam === 'crash') ? '<p class="warn-line">Spikes can jump straight past a stop loss. Size small.</p>' : ''}
        <div class="card-foot">
          <div class="card-stats"><span>Signal <b>${L.barsAgo === 0 ? 'this candle' : L.barsAgo + ' candle' + (L.barsAgo > 1 ? 's' : '') + ' ago'}</b></span>
            <span>Win <b>${(res.winRate * 100).toFixed(0)}%</b></span><span>Avg <b>${res.avgR >= 0 ? '+' : ''}${res.avgR.toFixed(2)}R</b></span><span>Trades <b>${res.trades}</b></span></div>
          <div class="r-right">
            <button class="btn small" type="button" data-open="${esc(r.sym)}" data-g="${r.g}" data-strat="${res.strategy}">Chart</button>
            <button class="btn small" type="button" data-watch="${esc(r.sym)}" data-g="${r.g}">${watched.has(r.sym + '|' + r.g) ? 'Watching' : 'Watch'}</button>
          </div>
        </div>
      </article>`;
    }).join('') || `<div class="glass empty">${scanResults.size ? 'No fresh signals right now. The scan keeps checking on every new candle.' : 'Run Smart Scan to see live signals.'}</div>`;

    $('board').innerHTML = board.map(r => {
      const st = r.bestLive ? r.bestLive.state : 0;
      return `<li class="row-btn" data-open="${esc(r.sym)}" data-g="${r.g}" data-strat="${r.best.strategy}"><div>
        <div class="r-name">${esc(nameOf(r.sym))}</div>
        <div class="r-sub">${tfShort(r.g)} · ${esc(r.best.name)} · ${esc(r.regime.name)}</div></div>
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
      layout: { background: { color: 'rgba(0,0,0,0)' }, textColor: cssVar('--muted'), fontFamily: 'JetBrains Mono, ui-monospace, monospace' },
      grid: { vertLines: { color: cssVar('--chart-grid') }, horzLines: { color: cssVar('--chart-grid') } },
      rightPriceScale: { borderColor: cssVar('--stroke') },
      timeScale: { borderColor: cssVar('--stroke'), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 }
    });
    chartState.chart = c;
    chartState.series.candles = c.addCandlestickSeries({ upColor: cssVar('--buy'), downColor: cssVar('--sell'), wickUpColor: cssVar('--buy'), wickDownColor: cssVar('--sell'), borderVisible: false });
    const line = color => c.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    chartState.series.ema21 = line(cssVar('--cyan'));
    chartState.series.ema200 = line(cssVar('--violet'));
    chartState.series.st = line(cssVar('--amber'));
  }

  async function openChart(sym, g) {
    if (!sym || !client.ws) return;
    const token = ++chartState.token;
    if (chartState.subId) { client.forget(chartState.subId); chartState.subId = null; }
    chartState.sym = sym; chartState.g = g;
    buildChart();
    $('sigPill').textContent = '...'; $('sigPill').className = 'pill big'; $('sigSub').textContent = 'Loading ' + nameOf(sym);
    try {
      const { candles, subId } = await client.subscribeCandles(sym, g, settings.history, bar => onChartBar(token, bar));
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
    if (!last || bar.epoch > last.epoch) { cs.push(bar); if (cs.length > settings.history + 50) cs.shift(); renderChartFull(); }
    else if (bar.epoch === last.epoch) { cs[cs.length - 1] = bar; chartState.series.candles.update(toBar(bar)); }
  }
  const toBar = c => ({ time: c.epoch + tzShift, open: c.open, high: c.high, low: c.low, close: c.close });

  function renderChartFull() {
    const cs = chartState.candles, sym = chartState.sym;
    if (cs.length < 3) return;
    const S = Strat.compute(cs), t = i => cs[i].epoch + tzShift, opts = engineOpts(sym);
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
    const chosenId = settings.chartStrategy === 'auto' ? rec[0].strategy : settings.chartStrategy;
    const strat = Strat.byId(chosenId, settings.threshold), res = rec.find(r => r.strategy === chosenId);
    const L = Strat.live(S, strat, S.n - 2, Object.assign({ fresh: 2 }, opts));
    chartState.live = { L, res, strat };

    chartState.series.candles.setMarkers(Strat.events(S, strat, opts).slice(-150).map(e => e.dir === 1
      ? { time: t(e.i), position: 'belowBar', color: cssVar('--buy'), shape: 'arrowUp', text: 'BUY' }
      : { time: t(e.i), position: 'aboveBar', color: cssVar('--sell'), shape: 'arrowDown', text: 'SELL' }));

    $('recStrip').innerHTML = '<span class="label">Best here</span>' + rec.slice(0, 3).map(r =>
      `<button type="button" class="chip${r.strategy === chosenId ? ' on' : ''}" data-pick="${r.strategy}">${esc(r.name.replace(/ \(.*\)/, ''))} · ${r.score}</button>`).join('');
    const dir = L.active;
    $('sigPill').textContent = sigWord(dir); $('sigPill').className = 'pill big ' + sigClass(dir);
    $('sigStrat').textContent = strat.name + (settings.chartStrategy === 'auto' ? ' (auto)' : '');
    $('sigSub').textContent = dir
      ? `Signal ${L.barsAgo === 0 ? 'on the last closed candle' : L.barsAgo + ' candles ago'} · ${Strat.regime(S, S.n - 2).name} market`
      : (L.lastDir ? `No fresh signal. Last ${sigWord(L.lastDir)} ${L.barsAgo} candles ago.` : 'No signal in the last 60 candles.');
    $('sigRing').innerHTML = res ? ring(res.score) : '';
    $('sigPlan').innerHTML = dir ? planHTML(sym, L.plan) : '';
    const fam = famOf(sym);
    $('sigWarn').hidden = !(dir && (fam === 'boom' || fam === 'crash'));
    $('sigWarn').textContent = 'Spikes can jump straight past a stop loss. Size small.';
    if (dir && L.plan) {
      const P = L.plan, mk = (p, color, title) => chartState.series.candles.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
      chartState.lines = [mk(P.entry, cssVar('--cyan'), 'Entry'), mk(P.sl, cssVar('--sell'), 'SL'), mk(P.tp1, cssVar('--buy'), 'TP1'), mk(P.tp2, cssVar('--buy'), 'TP2')];
    }
    // every strategy's live read
    $('partsList').innerHTML = rec.map(r => {
      const st = Strat.byId(r.strategy, settings.threshold), l = Strat.live(S, st, S.n - 2, opts);
      return `<li class="row-btn" data-pick="${r.strategy}"><div><div class="r-name">${esc(r.name)}</div>
        <div class="r-sub">${esc(l.reading)} · ${r.trades} trades, ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(2)}R avg</div></div>
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
    $('mtfList').innerHTML = '<li class="r-sub">Checking 12 timeframes...</li>';
    const out = [];
    for (const [g] of TF) {
      try {
        const cs = await history(sym, g, settings.history);
        if (cs.length >= Strat.WARMUP + 40) {
          const S = Strat.compute(cs), opts = engineOpts(sym), rec = Strat.recommend(S, opts), best = rec[0];
          out.push({ g, best, L: Strat.live(S, Strat.byId(best.strategy, settings.threshold), S.n - 2, Object.assign({ fresh: 2 }, opts)) });
        } else out.push({ g });
      } catch (e) { out.push({ g }); }
      $('mtfList').innerHTML = out.map(r => r.best
        ? `<li class="row-btn" data-g="${r.g}"><div><div class="r-name">${tfLabel(r.g)}</div><div class="r-sub">${esc(r.best.name)} · ${r.L.active ? 'fresh signal' : 'no fresh signal'}</div></div>
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
  $('chartTestBtn').addEventListener('click', () => {
    $('testSym').value = chartState.sym; $('testTf').value = chartState.g;
    settings.testSym = chartState.sym; settings.testTf = chartState.g; saveSettings();
    showTab('test'); $('testPanel').scrollIntoView({ behavior: 'smooth' }); runTest();
  });
  function updateWatchBtn() {
    const on = watch.some(w => w.sym === chartState.sym && w.g === chartState.g);
    $('watchBtn').textContent = on ? 'Remove from alerts' : 'Add to alerts';
  }

  // ---------- STRATEGY LIBRARY + BACKTEST ----------
  function renderLibrary() {
    const famChips = list => list.map(f => `<span class="tag">${esc(Strat.FAMILY_LABEL[f] || f)}</span>`).join(' ');
    $('libCards').innerHTML = Strat.PRESETS.map(s => `<article class="glass lib">
      <div class="lib-head"><span class="lib-rank">${s.rank}</span><div><div class="lib-name">${esc(s.name)}</div><div>${famChips(s.bestFor)}</div></div></div>
      <p>${esc(s.rules)}</p><p class="src">${esc(s.source)}</p></article>`).join('');
    $('classicList').innerHTML = Strat.library(settings.threshold).filter(s => s.group !== 'preset').map(s =>
      `<li><div><div class="r-name">${esc(s.name)}</div><div class="r-sub">${esc(s.rules)}</div></div></li>`).join('');
  }

  let testing = false;
  async function runTest() {
    if (testing) return;
    if (!client.ws) { toast('Not connected to Deriv yet'); return; }
    testing = true;
    const sym = $('testSym').value, g = +$('testTf').value, count = +$('testCount').value, hold = +$('testHold').value;
    const list = sym === '__all__' ? symbols.map(s => s.symbol) : [sym];
    $('testBtn').disabled = true; $('testProgress').hidden = false; $('testWrap').hidden = true; $('testNote').hidden = true;
    const results = []; let done = 0;
    for (const s of list) {
      $('testProgText').textContent = `Testing ${nameOf(s)} (${done + 1}/${list.length})`;
      try {
        const cs = await client.candles(s, g, count);
        const S = Strat.compute(cs), opts = Object.assign(engineOpts(s), { maxHold: hold });
        for (const r of Strat.recommend(S, opts)) results.push(Object.assign(r, { sym: s }));
      } catch (e) { console.warn(s, e.message); }
      done++; $('testBar').style.width = (done / list.length * 100) + '%';
      await sleep(0);
    }
    testing = false; $('testBtn').disabled = false; $('testProgress').hidden = true;
    renderTest(results, list.length > 1, g, hold);
  }

  function renderTest(results, multi, g, hold) {
    if (!results.length) { $('testMeta').textContent = 'No results. The market may not have enough history on this timeframe.'; return; }
    const rows = (multi ? results.filter(r => r.trades >= Strat.MIN_TRADES) : results).sort((a, b) => b.score - a.score || (b.zAdj || b.z) - (a.zAdj || a.z)).slice(0, multi ? 25 : 99);
    const sgn = v => (v > 0 ? '+' : '') + v.toFixed(2);
    $('testTable').querySelector('tbody').innerHTML = rows.map(r => `<tr>
      <td><div class="r-name">${esc(r.name)}</div>${multi ? `<div class="r-sub">${esc(nameOf(r.sym))}</div>` : ''}</td>
      <td class="num">${r.trades}</td><td class="num">${(r.winRate * 100).toFixed(0)}%</td>
      <td class="num ${r.avgR > 0 ? 'pos' : r.avgR < 0 ? 'neg' : ''}">${sgn(r.avgR)}</td><td class="num">${sgn(r.baseR)}</td>
      <td class="num ${r.edge > 0 ? 'pos' : r.edge < 0 ? 'neg' : ''}">${sgn(r.edge)}</td><td class="num">${r.z.toFixed(1)}</td>
      <td class="num">${r.score}</td><td><span class="verdict v-${r.verdict.code}">${esc(r.verdict.label)}</span></td></tr>`).join('');
    $('testWrap').hidden = false;
    const tests = results.filter(r => r.trades >= Strat.MIN_TRADES).length;
    const edges = results.filter(r => r.verdict.code === 'edge').length, luck = (tests / 13) * 0.00135; // scores are already corrected within each market
    $('testMeta').textContent = multi
      ? `Tested ${tests} strategy and market pairs on ${tfLabel(g)} candles with a ${hold}-candle max hold. Showing the top 25.`
      : `${nameOf(results[0].sym)}, ${results[0].candles.toLocaleString()} candles of ${tfLabel(g)}, ${hold}-candle max hold.`;
    $('testNote').innerHTML = `<b>${edges}</b> result${edges === 1 ? '' : 's'} passed the Possible edge test. With ${Math.max(1, Math.round(tests / 13))} market${tests > 13 ? 's' : ''} tested, about <b>${luck < 0.1 ? luck.toFixed(2) : luck.toFixed(1)}</b> would pass by pure luck. ` +
      (edges === 0 ? 'Nothing here beats chance, which is what a random market should show.' : edges <= Math.max(1, luck * 3) ? 'That is close to what luck alone produces. Recheck it on another timeframe or later data before trusting it.' : 'That is more than luck would explain. Recheck it on fresh data, then forward test it with alerts before trading it.');
    $('testNote').hidden = false;
  }
  $('testBtn').addEventListener('click', runTest);
  $('testSym').addEventListener('change', e => { settings.testSym = e.target.value; saveSettings(); });
  $('testTf').addEventListener('change', e => { settings.testTf = +e.target.value; saveSettings(); });
  $('testCount').addEventListener('change', e => { settings.testCount = +e.target.value; saveSettings(); });
  $('testHold').addEventListener('change', e => { settings.testHold = +e.target.value; saveSettings(); });

  // ---------- ALERTS ----------
  const watchers = new Map();
  let unread = 0;
  const wkey = (sym, g) => sym + '|' + g;

  function toggleWatch(sym, g, strategy) {
    const i = watch.findIndex(w => w.sym === sym && w.g === g);
    if (i >= 0) { watch.splice(i, 1); stopWatcher(wkey(sym, g)); toast('Stopped watching ' + nameOf(sym) + ' ' + tfShort(g)); }
    else {
      if (watch.length >= 20) { toast('You can watch up to 20 market and timeframe pairs'); return; }
      const item = { sym, g, strategy: strategy || 'auto' };
      watch.push(item); startWatcher(item);
      toast('Watching ' + nameOf(sym) + ' on ' + tfLabel(g) + (item.strategy === 'auto' ? ' with the best strategy' : ' with ' + stratName(item.strategy)));
    }
    store.set('watch2', watch); renderWatch();
  }

  async function startWatcher(item) {
    const key = wkey(item.sym, item.g);
    if (watchers.has(key) || !client.ws) return;
    const w = Object.assign({ candles: [], subId: null, snap: null, lastAlert: null }, item);
    watchers.set(key, w);
    try {
      const { candles, subId } = await client.subscribeCandles(item.sym, item.g, settings.history, bar => onWatchBar(w, bar));
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
    if (isNew) { cs.push(bar); if (cs.length > settings.history + 50) cs.shift(); }
    else if (bar.epoch === last.epoch) cs[cs.length - 1] = bar;
    trackOutcomes(w, bar, isNew);
    if (isNew) evaluateWatch(w, true);
  }

  function evaluateWatch(w, canAlert) {
    if (w.candles.length < Strat.WARMUP + 40) return;
    const S = Strat.compute(w.candles), opts = engineOpts(w.sym);
    const rec = Strat.recommend(S, opts);
    const id = w.strategy === 'auto' ? rec[0].strategy : w.strategy;
    const strat = Strat.byId(id, settings.threshold), res = rec.find(r => r.strategy === id);
    const L = Strat.live(S, strat, S.n - 2, Object.assign({ fresh: 0 }, opts));
    w.snap = { id, name: strat.name, score: res ? res.score : 0, state: L.state, active: L.active };
    const candleTime = S.time[S.n - 2];
    if (canAlert && L.active && L.plan && (res ? res.score : 0) >= settings.minAlertScore && w.lastAlert !== candleTime) {
      w.lastAlert = candleTime;
      fireAlert(w, strat, res, L);
    }
    renderWatch();
  }

  function fireAlert(w, strat, res, L) {
    const p = L.plan, sz = Strat.sizing(p, settings.balance, settings.riskPct);
    const entry = { id: Date.now() + Math.random(), t: Date.now(), sym: w.sym, g: w.g, strategy: strat.id, name: strat.name, dir: L.active,
      entry: p.entry, sl: p.sl, tp1: p.tp1, tp2: p.tp2, dist: p.dist, score: res ? res.score : 0, risk: sz ? sz.risk : 0, status: 'open', bars: 0 };
    log.unshift(entry); if (log.length > 200) log.length = 200;
    store.set('log2', log); renderLog();
    const title = `${sigWord(L.active)} ${nameOf(w.sym)} (${tfShort(w.g)})`;
    const body = `Entry ${price(w.sym, p.entry)} · SL ${price(w.sym, p.sl)} · TP1 ${price(w.sym, p.tp1)} · ${strat.name}, edge ${entry.score}`;
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
      else if (hitTP) { a.status = 'tp'; a.R = Strat.TP1_R; }
      else if (a.bars >= settings.maxHold) { a.status = 'time'; a.R = a.dir * (bar.close - a.entry) / a.dist; }
      if (a.status !== 'open') { a.closedAt = Date.now(); changed = true; }
    }
    if (changed) { store.set('log2', log); renderLog(); }
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
      return `<li><div><div class="r-name">${esc(nameOf(it.sym))} · ${tfShort(it.g)}</div>
        <div class="r-sub">${s ? `${mode}: ${esc(s.name)} · edge ${s.score}` : (client.ws ? 'Loading...' : 'Waiting for connection')}</div></div>
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
    const status = a => a.status === 'open' ? 'Open' : a.status === 'tp' ? `Hit TP1, +${Strat.TP1_R}R` : a.status === 'sl' ? 'Hit stop, -1R' : `Closed after ${a.bars} candles, ${a.R >= 0 ? '+' : ''}${a.R.toFixed(2)}R`;
    $('alertLog').innerHTML = log.slice(0, 60).map(a => `<li><div>
      <div class="r-name"><span class="pill ${sigClass(a.dir)}">${sigWord(a.dir)}</span> ${esc(nameOf(a.sym))} · ${tfShort(a.g)}</div>
      <div class="r-sub">${new Date(a.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${esc(a.name)} · edge ${a.score}</div>
      <div class="r-sub mono">Entry ${price(a.sym, a.entry)} · SL ${price(a.sym, a.sl)} · TP1 ${price(a.sym, a.tp1)}</div>
      <div class="r-sub">${status(a)}</div></div></li>`).join('') || '<li class="r-sub">No alerts yet.</li>';
  }
  $('clearLog').addEventListener('click', () => { log = []; store.set('log2', log); renderLog(); });

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
  $('scanStrategy').innerHTML = stratOptions(true); $('scanStrategy').value = settings.scanStrategy;
  $('chartStrategy').innerHTML = stratOptions(true); $('chartStrategy').value = settings.chartStrategy;
  renderTfChips(); renderLibrary(); renderWatch(); renderLog(); updateNotifBtn(); setScanView(settings.scanView);

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
