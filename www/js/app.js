/* SynthScope app: screens, scanner, chart, backtests and alerts. */
(function () {
  'use strict';
  const VERSION = '1.0.0';
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  const settings = Object.assign({ threshold: 50, endpoint: 'auto', appId: '', sound: true, vibrate: true, awake: false, scanTf: 300, chartTf: 300, testTf: 300, chartSym: 'R_75', group: '' }, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);
  let watch = store.get('watch', []);
  let log = store.get('log', []);

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
  const sigWord = s => s === 1 ? 'BUY' : s === -1 ? 'SELL' : 'WAIT';
  const sigClass = s => s === 1 ? 'buy' : s === -1 ? 'sell' : 'wait';
  const lastText = snap => snap.lastEvent ? sigWord(snap.lastEvent) + (snap.barsAgo === 0 ? ', this candle' : ', ' + snap.barsAgo + ' candle' + (snap.barsAgo === 1 ? '' : 's') + ' ago') : 'None in 50 candles';
  const tzShift = -new Date().getTimezoneOffset() * 60;

  function toast(msg, ms = 2600) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function fillTfSelect(el, value) {
    el.innerHTML = TF.map(([g, l]) => `<option value="${g}"${g === value ? ' selected' : ''}>${l}</option>`).join('');
  }

  function fillSymSelect(el, value, withAll) {
    const groups = {};
    for (const s of symbols) (groups[s.group] = groups[s.group] || []).push(s);
    let html = withAll ? '<option value="__all__">All synthetic markets (slower)</option>' : '';
    for (const g of Object.keys(groups).sort()) {
      html += `<optgroup label="${esc(g)}">` + groups[g].map(s => `<option value="${esc(s.symbol)}"${s.symbol === value ? ' selected' : ''}>${esc(s.name)}</option>`).join('') + '</optgroup>';
    }
    el.innerHTML = html;
    if (value && [...el.options].some(o => o.value === value)) el.value = value;
  }

  function scoreFill(el, score) {
    const w = Math.min(50, Math.abs(score) / 2);
    el.style.left = score >= 0 ? '50%' : (50 - w) + '%';
    el.style.width = w + '%';
    el.className = 'fill ' + (score >= 0 ? 'pos' : 'neg');
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
    const dot = $('connDot'), txt = $('connText');
    dot.className = 'dot ' + st;
    txt.textContent = st === 'online' ? 'Live' : st === 'connecting' ? 'Connecting' : 'Offline';
    $('connDetail').textContent = st === 'online'
      ? 'Connected to ' + (key === 'legacy' ? 'Deriv API v3' : 'Deriv API public feed') + '.'
      : st === 'offline' ? 'Cannot reach Deriv. Check your internet. SynthScope keeps retrying.' : 'Connecting...';
  });
  client.on('reconnect', () => { restartWatchers(); if (chartState.sym) openChart(chartState.sym, chartState.g); });
  $('connBtn').addEventListener('click', () => showTab('settings'));

  async function loadSymbols() {
    const cached = store.get('symbols', null);
    try {
      symbols = await client.symbols();
      store.set('symbols', symbols);
    } catch (e) {
      if (cached) symbols = cached; else throw e;
    }
    symbols.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const s of symbols) bySym[s.symbol] = s;
    if (!bySym[settings.chartSym]) settings.chartSym = (bySym.R_75 ? 'R_75' : symbols[0] && symbols[0].symbol);
    fillSymSelect($('chartSym'), settings.chartSym);
    fillSymSelect($('testSym'), settings.testSym || settings.chartSym, true);
    const groups = [...new Set(symbols.map(s => s.group))].sort();
    $('scanGroup').innerHTML = '<option value="">All synthetic markets</option>' + groups.map(g => `<option${g === settings.group ? ' selected' : ''}>${esc(g)}</option>`).join('');
    $('scanMeta').textContent = symbols.length + ' synthetic markets available. Tap Scan to rank them by combined signal.';
  }

  // ---------- scanner ----------
  let scanning = false, scanResults = [], scanTimer = null;

  async function runScan() {
    if (scanning) return;
    if (!client.ws) { toast('Not connected to Deriv yet'); return; }
    scanning = true;
    const g = settings.scanTf, group = settings.group;
    const list = symbols.filter(s => !group || s.group === group);
    $('scanBtn').disabled = true;
    $('scanProgress').hidden = false;
    scanResults = [];
    let done = 0, failed = 0;
    for (const s of list) {
      $('scanProgText').textContent = `${done + 1} of ${list.length}: ${s.name}`;
      try {
        const candles = await client.candles(s.symbol, g, 300);
        if (candles.length >= Strat.WARMUP + 2) {
          const S = Strat.compute(candles);
          scanResults.push({ sym: s.symbol, snap: Strat.snapshot(S, S.n - 2, settings.threshold), live: S.close[S.n - 1] });
        }
      } catch (e) { failed++; console.warn(s.symbol, e.message); }
      done++;
      $('scanBar').style.width = (done / list.length * 100) + '%';
      if (done % 5 === 0 || done === list.length) renderScan();
    }
    scanning = false;
    $('scanBtn').disabled = false;
    $('scanProgress').hidden = true;
    const t = new Date();
    $('scanMeta').textContent = `Scanned ${scanResults.length} markets on ${tfLabel(g)} candles at ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` + (failed ? `. ${failed} could not load.` : '.');
    renderScan();
    scheduleScan();
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    if (!$('scanAuto').checked) return;
    const ms = settings.scanTf * 1000;
    const wait = Math.max(30000, ms - (Date.now() % ms) + 2500);
    scanTimer = setTimeout(runScan, wait);
  }

  function renderScan() {
    const only = $('scanOnlySignals').checked;
    const rows = scanResults
      .filter(r => !only || r.snap.signal !== 0)
      .sort((a, b) => Math.abs(b.snap.score) - Math.abs(a.snap.score));
    const watched = new Set(watch.map(w => w.sym + '|' + w.g));
    $('scanList').innerHTML = rows.map(r => {
      const s = r.snap, isW = watched.has(r.sym + '|' + settings.scanTf);
      const fresh = s.lastEvent && s.barsAgo !== null && s.barsAgo <= 3 ? `<span class="fresh">New ${sigWord(s.lastEvent)} ${s.barsAgo === 0 ? 'now' : s.barsAgo + 'c ago'}</span>` : '';
      return `<li class="row" data-sym="${esc(r.sym)}">
        <button class="star${isW ? ' on' : ''}" type="button" data-star="${esc(r.sym)}" aria-label="Watch ${esc(nameOf(r.sym))}">${isW ? '&#9733;' : '&#9734;'}</button>
        <div class="row-main"><div class="row-name">${esc(nameOf(r.sym))}</div>
          <div class="row-sub">${esc(s.regime.name)}${s.regime.adx ? ' (ADX ' + s.regime.adx.toFixed(0) + ')' : ''} ${fresh}</div></div>
        <div class="row-right"><span class="pill ${sigClass(s.signal)}">${sigWord(s.signal)}</span>
          <div class="minibar"><span class="zero"></span><span class="fill ${s.score >= 0 ? 'pos' : 'neg'}" style="left:${s.score >= 0 ? 50 : 50 - Math.min(50, Math.abs(s.score) / 2)}%;width:${Math.min(50, Math.abs(s.score) / 2)}%"></span></div>
          <span class="num small">${s.score > 0 ? '+' : ''}${s.score}</span></div>
      </li>`;
    }).join('') || (scanResults.length ? '<li class="meta">No market meets the signal threshold right now.</li>' : '');
  }

  $('scanList').addEventListener('click', e => {
    const star = e.target.closest('[data-star]');
    if (star) { toggleWatch(star.dataset.star, settings.scanTf); renderScan(); return; }
    const row = e.target.closest('.row');
    if (row) { settings.chartSym = row.dataset.sym; settings.chartTf = settings.scanTf; saveSettings(); $('chartSym').value = row.dataset.sym; $('chartTf').value = settings.scanTf; showTab('chart'); openChart(row.dataset.sym, settings.scanTf); }
  });
  $('scanBtn').addEventListener('click', runScan);
  $('scanAuto').addEventListener('change', scheduleScan);
  $('scanOnlySignals').addEventListener('change', renderScan);
  $('scanTf').addEventListener('change', e => { settings.scanTf = +e.target.value; saveSettings(); });
  $('scanGroup').addEventListener('change', e => { settings.group = e.target.value; saveSettings(); });

  // ---------- chart ----------
  const chartState = { sym: null, g: null, candles: [], subId: null, chart: null, series: {}, token: 0 };

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function buildChart() {
    if (chartState.chart) return;
    const el = $('chart');
    const c = LightweightCharts.createChart(el, {
      autoSize: true,
      layout: { background: { color: cssVar('--panel') }, textColor: cssVar('--muted'), fontFamily: 'IBM Plex Mono, ui-monospace, monospace' },
      grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
      rightPriceScale: { borderColor: cssVar('--line') },
      timeScale: { borderColor: cssVar('--line'), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 }
    });
    chartState.chart = c;
    chartState.series.candles = c.addCandlestickSeries({ upColor: cssVar('--buy'), downColor: cssVar('--sell'), wickUpColor: cssVar('--buy'), wickDownColor: cssVar('--sell'), borderVisible: false });
    const line = color => c.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    chartState.series.ema21 = line(cssVar('--accent'));
    chartState.series.ema200 = line(cssVar('--ema200'));
    chartState.series.st = line(cssVar('--st'));
  }

  async function openChart(sym, g) {
    if (!sym || !client.ws) return;
    const token = ++chartState.token;
    if (chartState.subId) { client.forget(chartState.subId); chartState.subId = null; }
    chartState.sym = sym; chartState.g = g;
    buildChart();
    $('sigPill').textContent = '...';
    try {
      const { candles, subId } = await client.subscribeCandles(sym, g, 500, bar => onChartBar(token, bar));
      if (token !== chartState.token) { client.forget(subId); return; }
      chartState.subId = subId;
      chartState.candles = candles;
      renderChartFull();
      chartState.chart.timeScale().scrollToRealTime();
    } catch (e) {
      if (token === chartState.token) toast('Could not load ' + nameOf(sym) + ': ' + e.message);
    }
    $('mtfBox').hidden = true;
    updateWatchBtn();
  }

  function onChartBar(token, bar) {
    if (token !== chartState.token) return;
    const cs = chartState.candles, last = cs[cs.length - 1];
    if (!last || bar.epoch > last.epoch) {
      cs.push(bar);
      if (cs.length > 800) cs.shift();
      renderChartFull(); // a candle just closed
    } else if (bar.epoch === last.epoch) {
      cs[cs.length - 1] = bar;
      chartState.series.candles.update(toBar(bar));
      $('sigPrice').textContent = price(chartState.sym, bar.close);
    }
  }

  const toBar = c => ({ time: c.epoch + tzShift, open: c.open, high: c.high, low: c.low, close: c.close });

  function renderChartFull() {
    const cs = chartState.candles, sym = chartState.sym;
    if (cs.length < 3) return;
    const S = Strat.compute(cs);
    const t = i => cs[i].epoch + tzShift;
    chartState.series.candles.setData(cs.map(toBar));
    const lineData = arr => arr.map((v, i) => v === null ? null : { time: t(i), value: v }).filter(Boolean);
    chartState.series.ema21.setData(lineData(S.ema21));
    chartState.series.ema200.setData(lineData(S.ema200));
    chartState.series.st.setData(lineData(S.st.line));
    // markers for combined signals on closed candles
    const combo = Strat.allStrategies(settings.threshold).slice(-1)[0];
    const markers = [];
    for (let i = Strat.WARMUP + 1; i <= S.n - 2; i++) {
      const e = combo.event(S, i);
      if (e === 1) markers.push({ time: t(i), position: 'belowBar', color: cssVar('--buy'), shape: 'arrowUp', text: 'BUY' });
      if (e === -1) markers.push({ time: t(i), position: 'aboveBar', color: cssVar('--sell'), shape: 'arrowDown', text: 'SELL' });
    }
    chartState.series.candles.setMarkers(markers);
    if (S.n < Strat.WARMUP + 2) { $('sigPill').textContent = 'WAIT'; $('partsList').innerHTML = '<li class="meta">Not enough history on this timeframe yet.</li>'; return; }
    const snap = Strat.snapshot(S, S.n - 2, settings.threshold);
    $('sigPill').textContent = sigWord(snap.signal);
    $('sigPill').className = 'pill big ' + sigClass(snap.signal);
    $('sigScore').textContent = (snap.score > 0 ? '+' : '') + snap.score;
    scoreFill($('sigFill'), snap.score);
    $('sigPrice').textContent = price(sym, S.close[S.n - 1]);
    $('sigRegime').textContent = snap.regime.name + (snap.regime.adx ? ', ADX ' + snap.regime.adx.toFixed(0) : '');
    $('sigAtr').textContent = price(sym, snap.atr);
    $('sigLast').textContent = lastText(snap);
    $('partsList').innerHTML = snap.parts.map(p => `<li><div><div class="part-name">${esc(p.name)}</div><div class="part-sub">${p.kind === 'trend' ? 'Trend tool' : 'Oscillator'} · ${esc(p.reading)}</div></div><span class="pill ${sigClass(p.state)}">${sigWord(p.state)}</span></li>`).join('');
  }

  async function runMtf() {
    const sym = chartState.sym; if (!sym) return;
    $('mtfBox').hidden = false;
    $('mtfList').innerHTML = '<li class="meta">Checking 12 timeframes...</li>';
    $('mtfBtn').disabled = true;
    const out = [];
    for (const [g] of TF) {
      try {
        const cs = await client.candles(sym, g, 300);
        if (cs.length >= Strat.WARMUP + 2) { const S = Strat.compute(cs); out.push({ g, snap: Strat.snapshot(S, S.n - 2, settings.threshold) }); }
        else out.push({ g, snap: null });
      } catch (e) { out.push({ g, snap: null }); }
      $('mtfList').innerHTML = out.map(r => r.snap
        ? `<li><div><div class="part-name">${tfLabel(r.g)}</div><div class="part-sub">${esc(r.snap.regime.name)} · score ${r.snap.score > 0 ? '+' : ''}${r.snap.score}</div></div><span class="pill ${sigClass(r.snap.signal)}">${sigWord(r.snap.signal)}</span></li>`
        : `<li><div><div class="part-name">${tfLabel(r.g)}</div><div class="part-sub">Not enough history</div></div><span class="pill wait">-</span></li>`).join('');
    }
    const valid = out.filter(r => r.snap);
    const buys = valid.filter(r => r.snap.signal === 1).length, sells = valid.filter(r => r.snap.signal === -1).length;
    $('mtfList').insertAdjacentHTML('afterbegin', `<li class="summary"><div><div class="part-name">Agreement</div><div class="part-sub">${buys} BUY, ${sells} SELL, ${valid.length - buys - sells} WAIT across ${valid.length} timeframes</div></div></li>`);
    $('mtfBtn').disabled = false;
  }

  $('chartSym').addEventListener('change', e => { settings.chartSym = e.target.value; saveSettings(); openChart(settings.chartSym, settings.chartTf); });
  $('chartTf').addEventListener('change', e => { settings.chartTf = +e.target.value; saveSettings(); openChart(settings.chartSym, settings.chartTf); });
  $('mtfBtn').addEventListener('click', runMtf);
  $('watchBtn').addEventListener('click', () => { if (chartState.sym) { toggleWatch(chartState.sym, chartState.g); updateWatchBtn(); } });
  $('chartTestBtn').addEventListener('click', () => {
    $('testSym').value = chartState.sym; $('testTf').value = chartState.g;
    settings.testSym = chartState.sym; settings.testTf = chartState.g; saveSettings();
    showTab('test'); runTest();
  });
  function updateWatchBtn() {
    const on = watch.some(w => w.sym === chartState.sym && w.g === chartState.g);
    $('watchBtn').textContent = on ? 'Remove from alerts' : 'Add to alerts';
  }

  // ---------- backtest ----------
  let testing = false;
  async function runTest() {
    if (testing) return;
    if (!client.ws) { toast('Not connected to Deriv yet'); return; }
    testing = true;
    const sym = $('testSym').value, g = +$('testTf').value, count = +$('testCount').value, h = +$('testHorizon').value;
    const list = sym === '__all__' ? symbols.map(s => s.symbol) : [sym];
    $('testBtn').disabled = true; $('testProgress').hidden = false; $('testTable').hidden = true; $('testNote').hidden = true;
    const results = [];
    let done = 0;
    for (const s of list) {
      $('testProgText').textContent = `Loading ${nameOf(s)} (${done + 1} of ${list.length})`;
      try {
        const cs = await client.candles(s, g, count);
        const S = Strat.compute(cs);
        for (const r of Strat.backtestAll(S, h, settings.threshold)) results.push(Object.assign(r, { sym: s }));
      } catch (e) { console.warn(s, e.message); }
      done++; $('testBar').style.width = (done / list.length * 100) + '%';
      await new Promise(r => setTimeout(r, 0));
    }
    testing = false; $('testBtn').disabled = false; $('testProgress').hidden = true;
    renderTest(results, list.length > 1, g, h);
  }

  function pct(x) { return (x * 100).toFixed(1) + '%'; }
  function renderTest(results, multi, g, h) {
    if (!results.length) { $('testMeta').textContent = 'No results. The market may not have enough history on this timeframe.'; return; }
    const rows = multi ? results.filter(r => r.trades >= 30).sort((a, b) => b.z - a.z).slice(0, 25) : results;
    const tb = $('testTable').querySelector('tbody');
    tb.innerHTML = rows.map(r => `<tr class="${r.strategy === 'confluence' ? 'combo' : ''}">
      <td><div class="part-name">${esc(r.name)}</div>${multi ? `<div class="part-sub">${esc(nameOf(r.sym))}</div>` : ''}</td>
      <td class="num">${r.trades}</td><td class="num">${pct(r.winRate)}</td><td class="num">${pct(r.chance)}</td>
      <td class="num ${r.edge > 0 ? 'pos' : r.edge < 0 ? 'neg' : ''}">${r.edge > 0 ? '+' : ''}${(r.edge * 100).toFixed(1)}</td>
      <td class="num ${r.avgAtr > 0 ? 'pos' : r.avgAtr < 0 ? 'neg' : ''}">${r.avgAtr > 0 ? '+' : ''}${r.avgAtr.toFixed(2)}</td>
      <td class="num">${r.z.toFixed(1)}</td>
      <td><span class="verdict v-${r.verdict.code}">${esc(r.verdict.label)}</span></td></tr>`).join('');
    $('testTable').hidden = false;
    const tests = results.filter(r => r.trades >= 30).length;
    const edges = results.filter(r => r.verdict.code === 'edge').length;
    const luck = tests * 0.00135;
    const candles = results[0].candles;
    $('testMeta').textContent = multi
      ? `Tested ${tests} strategy and market pairs on ${tfLabel(g)} candles, holding ${h} candle${h > 1 ? 's' : ''}. Showing the top 25 by z.`
      : `${nameOf(results[0].sym)}, ${candles.toLocaleString()} candles of ${tfLabel(g)}, holding ${h} candle${h > 1 ? 's' : ''}.`;
    $('testNote').innerHTML = `<b>${edges}</b> result${edges === 1 ? '' : 's'} passed the Possible edge test. With ${tests} tests, about <b>${luck < 0.1 ? luck.toFixed(2) : luck.toFixed(1)}</b> would pass by pure luck. ` +
      (edges === 0 ? 'Nothing here beats chance, which is what a random market should show.' : edges <= Math.max(1, luck * 3) ? 'That is close to what luck alone produces, so treat it with suspicion and recheck on a different timeframe or later data.' : 'That is more than luck would explain. Recheck it on fresh data, then forward test on a demo account before trusting it.');
    $('testNote').hidden = false;
  }
  $('testBtn').addEventListener('click', runTest);
  $('testSym').addEventListener('change', e => { settings.testSym = e.target.value; saveSettings(); });
  $('testTf').addEventListener('change', e => { settings.testTf = +e.target.value; saveSettings(); });

  // ---------- alerts ----------
  const watchers = new Map(); // key -> {sym, g, candles, subId, lastSignal, snap}
  let unread = 0;
  const wkey = (sym, g) => sym + '|' + g;

  function toggleWatch(sym, g) {
    const i = watch.findIndex(w => w.sym === sym && w.g === g);
    if (i >= 0) { watch.splice(i, 1); stopWatcher(wkey(sym, g)); toast('Stopped watching ' + nameOf(sym) + ' ' + tfShort(g)); }
    else {
      if (watch.length >= 20) { toast('You can watch up to 20 market and timeframe pairs'); return; }
      watch.push({ sym, g }); startWatcher(sym, g); toast('Watching ' + nameOf(sym) + ' on ' + tfLabel(g));
    }
    store.set('watch', watch);
    renderWatch();
  }

  async function startWatcher(sym, g) {
    const key = wkey(sym, g);
    if (watchers.has(key) || !client.ws) return;
    const w = { sym, g, candles: [], subId: null, lastSignal: null, snap: null };
    watchers.set(key, w);
    try {
      const { candles, subId } = await client.subscribeCandles(sym, g, 400, bar => onWatchBar(w, bar));
      if (watchers.get(key) !== w) { client.forget(subId); return; }
      w.subId = subId; w.candles = candles;
      evaluate(w, false);
    } catch (e) {
      watchers.delete(key);
      console.warn('watch failed', sym, e.message);
      // Try again later if it is still on the list; a reconnect also restarts it
      setTimeout(() => { if (watch.some(x => x.sym === sym && x.g === g) && client.ws) startWatcher(sym, g); }, 10000);
    }
    renderWatch();
  }

  function stopWatcher(key) {
    const w = watchers.get(key); if (!w) return;
    if (w.subId) client.forget(w.subId);
    watchers.delete(key);
  }

  function restartWatchers() {
    for (const k of [...watchers.keys()]) watchers.delete(k); // sockets already closed on reconnect
    for (const it of watch) startWatcher(it.sym, it.g);
  }

  function onWatchBar(w, bar) {
    const cs = w.candles, last = cs[cs.length - 1];
    if (!last || bar.epoch > last.epoch) { cs.push(bar); if (cs.length > 600) cs.shift(); evaluate(w, true); }
    else if (bar.epoch === last.epoch) cs[cs.length - 1] = bar;
  }

  function evaluate(w, canAlert) {
    if (w.candles.length < Strat.WARMUP + 2) return;
    const S = Strat.compute(w.candles);
    const snap = Strat.snapshot(S, S.n - 2, settings.threshold);
    if (canAlert && snap.signal !== 0 && snap.signal !== w.lastSignal) fireAlert(w, snap);
    w.lastSignal = snap.signal; w.snap = snap;
    renderWatch();
  }

  function fireAlert(w, snap) {
    const entry = { t: Date.now(), sym: w.sym, g: w.g, dir: snap.signal, price: snap.price, score: snap.score };
    log.unshift(entry); if (log.length > 100) log.length = 100;
    store.set('log', log);
    renderLog();
    const title = `${sigWord(snap.signal)} ${nameOf(w.sym)} (${tfShort(w.g)})`;
    const body = `Score ${snap.score > 0 ? '+' : ''}${snap.score}, price ${price(w.sym, snap.price)}, ${snap.regime.name.toLowerCase()} market`;
    toast(title + '. ' + body, 5000);
    if (settings.sound) beep(snap.signal);
    if (settings.vibrate && navigator.vibrate) { try { navigator.vibrate(snap.signal === 1 ? [120, 60, 120] : [300]); } catch (_) {} }
    notify(title, body);
    if (currentTab !== 'alerts') { unread++; renderBadge(); }
  }

  function renderBadge() { const b = $('alertBadge'); b.hidden = unread === 0; b.textContent = unread > 9 ? '9+' : unread; }

  let audioCtx = null;
  function beep(dir) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const now = audioCtx.currentTime;
      const notes = dir === 1 ? [660, 880] : [520, 390];
      notes.forEach((f, k) => {
        const o = audioCtx.createOscillator(), gn = audioCtx.createGain();
        o.frequency.value = f; o.type = 'sine';
        gn.gain.setValueAtTime(0.0001, now + k * 0.18);
        gn.gain.exponentialRampToValueAtTime(0.25, now + k * 0.18 + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, now + k * 0.18 + 0.16);
        o.connect(gn).connect(audioCtx.destination);
        o.start(now + k * 0.18); o.stop(now + k * 0.18 + 0.17);
      });
    } catch (_) { /* audio unavailable */ }
  }
  // Unlock audio on the first tap so later alerts can play
  document.addEventListener('click', () => { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (_) {} }, { once: true });

  const LN = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  let notifId = 1;
  async function notify(title, body) {
    try {
      if (isNative() && LN()) {
        await LN().schedule({ notifications: [{ id: notifId++, title, body }] });
        return;
      }
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'ss-' + Date.now() });
      } else {
        new Notification(title, { body, icon: 'icons/icon-192.png' });
      }
    } catch (e) { console.warn('notify failed', e); }
  }

  async function askNotify() {
    try {
      if (isNative() && LN()) {
        const r = await LN().requestPermissions();
        toast(r.display === 'granted' ? 'Notifications on' : 'Notifications blocked. Turn them on in Android settings.');
      } else if ('Notification' in window) {
        const p = await Notification.requestPermission();
        toast(p === 'granted' ? 'Notifications on' : 'Notifications blocked in browser settings');
      } else toast('This browser does not support notifications');
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
      return `<li><div><div class="part-name">${esc(nameOf(it.sym))} · ${tfShort(it.g)}</div>
        <div class="part-sub">${s ? 'Score ' + (s.score > 0 ? '+' : '') + s.score + ' · ' + esc(s.regime.name) : (client.ws ? 'Loading...' : 'Waiting for connection')}</div></div>
        <span class="row-right"><span class="pill ${s ? sigClass(s.signal) : 'wait'}">${s ? sigWord(s.signal) : '-'}</span>
        <button class="btn ghost small" type="button" data-unwatch="${esc(it.sym)}" data-g="${it.g}">Remove</button></span></li>`;
    }).join('');
  }
  $('watchList').addEventListener('click', e => {
    const b = e.target.closest('[data-unwatch]');
    if (b) { toggleWatch(b.dataset.unwatch, +b.dataset.g); updateWatchBtn(); }
  });

  function renderLog() {
    $('alertLog').innerHTML = log.map(a => `<li><span class="pill ${sigClass(a.dir)}">${sigWord(a.dir)}</span>
      <div><div class="part-name">${esc(nameOf(a.sym))} · ${tfShort(a.g)}</div>
      <div class="part-sub">${new Date(a.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · price ${price(a.sym, a.price)} · score ${a.score > 0 ? '+' : ''}${a.score}</div></div></li>`).join('') || '<li class="meta">No alerts yet.</li>';
  }
  $('clearLog').addEventListener('click', () => { log = []; store.set('log', log); renderLog(); });

  // ---------- settings and options ----------
  function bindCheck(id, key, after) {
    const el = $(id); el.checked = !!settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); if (after) after(); });
  }
  bindCheck('optSound', 'sound');
  bindCheck('optVibrate', 'vibrate');
  bindCheck('optAwake', 'awake', applyWakeLock);

  let wakeLock = null;
  async function applyWakeLock() {
    try {
      if (settings.awake && 'wakeLock' in navigator && document.visibilityState === 'visible') { if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } }
      else if (!settings.awake && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (_) { if (settings.awake) toast('This device would not keep the screen on. Change it in display settings.'); }
  }

  $('optThreshold').value = settings.threshold; $('thrVal').textContent = settings.threshold;
  $('optThreshold').addEventListener('input', e => { $('thrVal').textContent = e.target.value; });
  $('optThreshold').addEventListener('change', e => {
    settings.threshold = +e.target.value; saveSettings();
    if (chartState.candles.length) renderChartFull();
    for (const w of watchers.values()) { if (w.candles.length) { const S = Strat.compute(w.candles); w.snap = Strat.snapshot(S, S.n - 2, settings.threshold); w.lastSignal = w.snap.signal; } }
    renderWatch();
  });
  $('optEndpoint').value = settings.endpoint;
  $('optAppId').value = settings.appId;
  $('optEndpoint').addEventListener('change', e => { settings.endpoint = e.target.value; saveSettings(); reconnect(); });
  $('optAppId').addEventListener('change', e => { settings.appId = e.target.value.replace(/\D/g, ''); e.target.value = settings.appId; saveSettings(); });
  $('reconnectBtn').addEventListener('click', reconnect);
  $('appVersion').textContent = VERSION;

  async function reconnect() {
    client.configure(settings.endpoint, settings.appId);
    try { await client.reconnectNow(); if (!symbols.length) await loadSymbols(); toast('Connected'); } catch (e) { toast('Could not reach Deriv'); }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    applyWakeLock();
    if (!client.ws) reconnect();
  });

  // ---------- disclaimer ----------
  if (!store.get('agreed', false)) $('disclaimer').hidden = false;
  $('disclaimerOk').addEventListener('click', () => { store.set('agreed', true); $('disclaimer').hidden = true; });

  // ---------- start ----------
  fillTfSelect($('scanTf'), settings.scanTf);
  fillTfSelect($('chartTf'), settings.chartTf);
  fillTfSelect($('testTf'), settings.testTf);
  renderWatch(); renderLog(); updateNotifBtn();

  (async function start() {
    client.configure(settings.endpoint, settings.appId);
    try {
      await client.connect();
      await loadSymbols();
      for (const it of watch) startWatcher(it.sym, it.g);
      if (currentTab === 'chart') openChart(settings.chartSym, settings.chartTf);
    } catch (e) {
      const cached = store.get('symbols', null);
      if (cached && !symbols.length) { symbols = cached; for (const s of symbols) bySym[s.symbol] = s; }
      $('scanMeta').textContent = 'Cannot reach Deriv right now. SynthScope will keep trying.';
      client.on('reconnect', async function once() { if (!symbols.length || !$('chartSym').options.length) await loadSymbols().catch(() => {}); });
    }
  })();

  if ('serviceWorker' in navigator && location.protocol === 'https:' && !isNative()) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  applyWakeLock();
})();
