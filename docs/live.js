/* 台股策略篩選器 — 盤中即時行情用戶端（連線到自架中繼伺服器） */
(function () {
  'use strict';
  const cfg = window.TWSS_CONFIG || {};
  let override = null;
  try { override = new URLSearchParams(location.search).get('relay') || localStorage.getItem('twss.relay'); } catch { /* 無痕模式 */ }
  const BASE = (override || cfg.relay || '').replace(/\/+$/, '');
  const handlers = {};
  const emit = (ev, data) => (handlers[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

  // 台灣時間與盤中判斷（09:00–13:35，週一至週五）
  const twNow = () => new Date(Date.now() + (new Date().getTimezoneOffset() + 480) * 60000);
  const inSession = () => { const t = twNow(), d = t.getDay(), m = t.getHours() * 60 + t.getMinutes(); return d >= 1 && d <= 5 && m >= 540 && m <= 815; };

  // 報價格式：[成交價, 昨收, 累積量(張), 開, 高, 低, 時間ms, 買一, 賣一]
  const unpack = (a) => a && ({ z: a[0], y: a[1], v: a[2], o: a[3], h: a[4], l: a[5], t: a[6], b: a[7], a: a[8], chg: a[0] && a[1] ? (a[0] / a[1] - 1) * 100 : null });

  const L = {
    enabled: !!BASE, base: BASE, quotes: new Map(), day: null, status: BASE ? 'connecting' : 'off', server: null,
    watch: new Set(), page: new Set(), chart: null,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    inSession,
    quote(id) { return this.quotes.get(id) || null; },
    setWatch(ids) { this.watch = new Set(ids); sendSub(); },
    setPage(ids) { this.page = new Set(ids); sendSub(); },
    setChart(id) { this.chart = id; sendSub(); },
    async bars(id) {
      const r = await fetch(`${BASE}/api/bars/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.q) this.quotes.set(id, unpack(j.q));
      return j;
    },
    async snapshot() {
      if (!BASE) return;
      try {
        const r = await fetch(`${BASE}/api/snapshot`, { cache: 'no-store' });
        const j = await r.json();
        this.day = j.day;
        for (const [id, a] of Object.entries(j.q || {})) this.quotes.set(id, unpack(a));
        emit('snapshot', { day: j.day, t: j.t });
      } catch (e) { setStatus('error'); }
    },
  };

  let ws = null, backoff = 1000, subTimer = null, pingTimer = null;
  function setStatus(s) { if (L.status !== s) { L.status = s; emit('status', s); } }
  function sendSub() {
    clearTimeout(subTimer);
    subTimer = setTimeout(() => {
      if (!ws || ws.readyState !== 1) return;
      const ids = [...new Set([...L.watch, ...L.page, ...(L.chart ? [L.chart] : [])])].slice(0, 60);
      ws.send(JSON.stringify({ op: 'sub', ids, chart: L.chart }));
    }, 150);
  }
  function connect() {
    if (!BASE) return;
    setStatus('connecting');
    try { ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws'); } catch { return retry(); }
    ws.onopen = () => { backoff = 1000; sendSub(); clearInterval(pingTimer); pingTimer = setInterval(() => ws.readyState === 1 && ws.send('{"op":"ping"}'), 25000); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.status) { L.server = m.status; L.day = m.status.day; setStatus(m.status.trading ? 'live' : 'closed'); }
      if (m.q) {
        const ids = Object.keys(m.q);
        for (const id of ids) L.quotes.set(id, unpack(m.q[id]));
        if (ids.length) emit('quotes', ids);
      }
      if (m.bar) emit('bar', m.bar);
    };
    ws.onclose = () => { clearInterval(pingTimer); retry(); };
    ws.onerror = () => { try { ws.close(); } catch { /* 已關閉 */ } };
  }
  function retry() { setStatus('error'); setTimeout(connect, backoff); backoff = Math.min(30000, backoff * 2); }

  // 全市場快照：盤中每 60 秒一次，其餘時間只在載入時抓一次
  if (BASE) {
    connect();
    L.snapshot();
    setInterval(() => { if (inSession()) L.snapshot(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && inSession()) L.snapshot(); });
  }
  window.Live = L;
})();
