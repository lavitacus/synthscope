/* Deriv WebSocket client: one shared socket, request/response by req_id,
   subscriptions, keepalive, reconnect, and two server options. */
(function (root) {
  'use strict';

  const ENDPOINTS = {
    new: () => 'wss://api.derivws.com/trading/v1/options/ws/public',
    legacy: appId => 'wss://ws.derivws.com/websockets/v3?app_id=' + (appId || '1089')
  };

  class DerivClient {
    constructor() {
      this.ws = null;
      this.reqId = 0;
      this.pending = new Map();     // req_id -> {resolve, reject, timer, onStream}
      this.streams = new Map();     // subscription id -> handler
      this.streamByReq = new Map(); // req_id -> handler (for servers that echo req_id on stream messages)
      this.listeners = { status: [], reconnect: [] };
      this.mode = 'auto';
      this.appId = '';
      this.active = null;           // which endpoint key is in use
      this.wanted = false;
      this.retry = 0;
      this.pingTimer = null;
      this.queue = Promise.resolve();
      this.lastSend = 0;
    }

    on(ev, fn) { this.listeners[ev].push(fn); }
    emit(ev, ...a) { for (const fn of this.listeners[ev]) { try { fn(...a); } catch (e) { console.error(e); } } }

    configure(mode, appId) { this.mode = mode || 'auto'; this.appId = appId || ''; }

    order() {
      if (this.mode === 'new') return ['new'];
      if (this.mode === 'legacy') return ['legacy'];
      // Remember what worked last time
      return this.active === 'legacy' ? ['legacy', 'new'] : ['new', 'legacy'];
    }

    async connect() {
      this.wanted = true;
      this.emit('status', 'connecting');
      for (const key of this.order()) {
        try {
          await this.open(key);
          // Prove the server answers market data requests before we commit to it
          await this.send({ time: 1 }, 8000);
          this.active = key;
          this.retry = 0;
          this.emit('status', 'online', key);
          this.startPing();
          return key;
        } catch (e) {
          console.warn('Endpoint failed', key, e && e.message);
          this.closeSocket();
        }
      }
      this.emit('status', 'offline');
      this.scheduleReconnect();
      throw new Error('Could not reach Deriv');
    }

    open(key) {
      return new Promise((resolve, reject) => {
        const url = ENDPOINTS[key](this.appId);
        let ws;
        try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
        const t = setTimeout(() => { reject(new Error('timeout')); try { ws.close(); } catch (_) {} }, 8000);
        ws.onopen = () => { clearTimeout(t); this.ws = ws; resolve(); };
        ws.onerror = () => { clearTimeout(t); reject(new Error('socket error')); };
        ws.onmessage = ev => this.handle(ev.data);
        ws.onclose = () => {
          clearTimeout(t);
          if (this.ws !== ws) return;
          this.ws = null;
          this.stopPing();
          this.failPending(new Error('Connection closed'));
          this.streams.clear(); this.streamByReq.clear();
          if (this.wanted) { this.emit('status', 'offline'); this.scheduleReconnect(); }
        };
      });
    }

    closeSocket() {
      const ws = this.ws; this.ws = null;
      if (ws) { ws.onclose = null; try { ws.close(); } catch (_) {} }
      this.stopPing();
      this.failPending(new Error('Connection closed'));
      this.streams.clear(); this.streamByReq.clear();
    }

    async reconnectNow() {
      this.closeSocket();
      this.retry = 0;
      await this.connect();
      this.emit('reconnect');
    }

    scheduleReconnect() {
      if (this.reconnectTimer) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, this.retry++));
      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = null;
        if (!this.wanted || this.ws) return;
        try { await this.connect(); this.emit('reconnect'); } catch (_) { /* connect schedules again */ }
      }, delay);
    }

    startPing() {
      this.stopPing();
      this.pingTimer = setInterval(() => { this.send({ ping: 1 }, 10000).catch(() => {}); }, 30000);
    }
    stopPing() { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = null; }

    failPending(err) {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    }

    handle(raw) {
      let d;
      try { d = JSON.parse(raw); } catch (_) { return; }
      const id = d.req_id;
      const subId = d.subscription && d.subscription.id;
      const p = id !== undefined ? this.pending.get(id) : null;
      if (p) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (d.error) { p.reject(Object.assign(new Error(d.error.message || 'Deriv error'), { code: d.error.code })); return; }
        if (p.onStream) {
          if (subId) this.streams.set(subId, p.onStream);
          this.streamByReq.set(id, p.onStream);
        }
        p.resolve(d);
        return;
      }
      const h = (subId && this.streams.get(subId)) || (id !== undefined && this.streamByReq.get(id));
      if (h) h(d);
    }

    // Light throttle so bursts of requests stay inside rate limits
    // Sends are spaced 150ms apart, but replies never block the queue.
    send(req, timeout = 30000, onStream = null) {
      return new Promise((resolve, reject) => {
        const dispatch = () => {
          if (!this.ws || this.ws.readyState !== 1) { reject(new Error('Not connected')); return; }
          const id = ++this.reqId;
          const msg = Object.assign({}, req, { req_id: id });
          const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Request timed out')); }, timeout);
          this.pending.set(id, { resolve, reject, timer, onStream });
          try { this.ws.send(JSON.stringify(msg)); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); return; }
          this.lastSend = Date.now();
        };
        if (req.ping || req.forget || req.time) { dispatch(); return; }
        this.queue = this.queue.then(async () => {
          const wait = 150 - (Date.now() - this.lastSend);
          if (wait > 0) await new Promise(r => setTimeout(r, wait));
          dispatch();
        });
      });
    }

    forget(subId) {
      if (!subId) return;
      this.streams.delete(subId);
      for (const [k, v] of this.streamByReq) { if (v && v.__sub === subId) this.streamByReq.delete(k); }
      this.send({ forget: subId }, 10000).catch(() => {});
    }

    // ---- market data helpers ----

    async symbols() {
      const d = await this.send({ active_symbols: 'brief' });
      const list = (d.active_symbols || []).map(s => ({
        symbol: s.symbol || s.underlying_symbol,
        name: s.display_name || s.underlying_symbol_name || s.symbol || s.underlying_symbol,
        market: s.market || '',
        group: s.submarket_display_name || s.subgroup_display_name || s.submarket || 'Other',
        open: s.exchange_is_open === undefined ? true : !!s.exchange_is_open,
        pip: Number(s.pip || s.pip_size || 0.01)
      })).filter(s => s.symbol);
      const synth = list.filter(s => /synthetic/i.test(s.market));
      return synth.length ? synth : list;
    }

    static parseCandles(arr) {
      const n = v => typeof v === 'string' ? parseFloat(v) : v;
      return (arr || []).map(c => ({ epoch: n(c.epoch), open: n(c.open), high: n(c.high), low: n(c.low), close: n(c.close) }))
        .filter(c => Number.isFinite(c.close)).sort((a, b) => a.epoch - b.epoch);
    }

    async candles(symbol, granularity, count) {
      const d = await this.send({ ticks_history: symbol, end: 'latest', count, style: 'candles', granularity, adjust_start_time: 1 }, 45000);
      return DerivClient.parseCandles(d.candles);
    }

    // Returns {candles, subId}; onBar(bar) is called for every live update of the forming candle
    async subscribeCandles(symbol, granularity, count, onBar) {
      const n = v => typeof v === 'string' ? parseFloat(v) : v;
      const handler = d => {
        const o = d.ohlc;
        if (!o) return;
        onBar({ epoch: n(o.open_time), open: n(o.open), high: n(o.high), low: n(o.low), close: n(o.close) });
      };
      const d = await this.send({ ticks_history: symbol, end: 'latest', count, style: 'candles', granularity, adjust_start_time: 1, subscribe: 1 }, 45000, handler);
      const subId = d.subscription && d.subscription.id;
      handler.__sub = subId;
      return { candles: DerivClient.parseCandles(d.candles), subId };
    }
  }

  root.DerivClient = DerivClient;
})(typeof globalThis !== 'undefined' ? globalThis : this);
