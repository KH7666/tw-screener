/* 台股策略篩選器 — 指標、條件評估與回測引擎（瀏覽器與 Node 共用） */
(function (root) {
  'use strict';
  const bad = (x) => x === null || x === undefined || Number.isNaN(x);
  const blank = (len) => new Array(len).fill(null);

  // ---------- 基礎運算 ----------
  function sma(a, n) {
    const r = blank(a.length); let s = 0, miss = 0;
    for (let i = 0; i < a.length; i++) {
      if (bad(a[i])) miss++; else s += a[i];
      if (i >= n) { if (bad(a[i - n])) miss--; else s -= a[i - n]; }
      if (i >= n - 1 && miss === 0) r[i] = s / n;
    }
    return r;
  }
  function smooth(a, n, alpha) { // EMA / Wilder RMA，以 SMA 起始
    const r = blank(a.length); let prev = null, cnt = 0, s = 0;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (prev === null) {
        if (bad(v)) { cnt = 0; s = 0; continue; }
        s += v; cnt++;
        if (cnt === n) { prev = s / n; r[i] = prev; }
        continue;
      }
      if (!bad(v)) prev = v * alpha + prev * (1 - alpha);
      r[i] = prev;
    }
    return r;
  }
  const ema = (a, n) => smooth(a, n, 2 / (n + 1));
  const rma = (a, n) => smooth(a, n, 1 / n);
  function rolling(a, n, fn, skipToday) {
    const r = blank(a.length);
    for (let i = 0; i < a.length; i++) {
      const end = skipToday ? i - 1 : i, start = end - n + 1;
      if (start < 0) continue;
      let ok = true; const w = [];
      for (let j = start; j <= end; j++) { if (bad(a[j])) { ok = false; break; } w.push(a[j]); }
      if (ok) r[i] = fn(w);
    }
    return r;
  }
  const highest = (a, n, skip) => rolling(a, n, (w) => Math.max(...w), skip);
  const lowest = (a, n, skip) => rolling(a, n, (w) => Math.min(...w), skip);
  const sum = (a, n) => rolling(a, n, (w) => w.reduce((x, y) => x + y, 0));
  const map2 = (a, b, f) => a.map((v, i) => (bad(v) || bad(b[i]) ? null : f(v, b[i])));
  const prevOf = (a) => a.map((_, i) => (i > 0 ? a[i - 1] : null));

  function rsi(c, n) {
    const g = blank(c.length), l = blank(c.length);
    for (let i = 1; i < c.length; i++) {
      if (bad(c[i]) || bad(c[i - 1])) continue;
      const d = c[i] - c[i - 1]; g[i] = Math.max(d, 0); l[i] = Math.max(-d, 0);
    }
    const ag = rma(g, n), al = rma(l, n);
    return ag.map((v, i) => (bad(v) || bad(al[i]) ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + v / al[i])));
  }
  function kd(h, l, c, n, a) { // 台灣慣用 KD：K = K前*(a-1)/a + RSV/a
    const len = c.length, K = blank(len), D = blank(len);
    const hh = highest(h, n), ll = lowest(l, n); let pk = 50, pd = 50, go = false;
    for (let i = 0; i < len; i++) {
      if (bad(hh[i]) || bad(ll[i]) || bad(c[i])) { if (go) { K[i] = pk; D[i] = pd; } continue; }
      const rng = hh[i] - ll[i], rsv = rng === 0 ? 50 : ((c[i] - ll[i]) / rng) * 100;
      pk = (pk * (a - 1)) / a + rsv / a; pd = (pd * (a - 1)) / a + pk / a; go = true;
      K[i] = pk; D[i] = pd;
    }
    return { K, D };
  }
  function macd(c, f, s, g) {
    const dif = map2(ema(c, f), ema(c, s), (x, y) => x - y);
    const sig = ema(dif, g);
    return { dif, sig, osc: map2(dif, sig, (x, y) => x - y) };
  }
  function boll(c, n, k) {
    const mid = sma(c, n);
    const sd = rolling(c, n, (w) => { const m = w.reduce((x, y) => x + y, 0) / w.length; return Math.sqrt(w.reduce((x, y) => x + (y - m) ** 2, 0) / w.length); });
    const up = map2(mid, sd, (m, d) => m + k * d), lo = map2(mid, sd, (m, d) => m - k * d);
    return { mid, up, lo, width: mid.map((m, i) => (bad(m) || bad(up[i]) || m === 0 ? null : ((up[i] - lo[i]) / m) * 100)) };
  }
  function atr(h, l, c, n) {
    const tr = c.map((_, i) => {
      if (bad(h[i]) || bad(l[i])) return null;
      if (i === 0 || bad(c[i - 1])) return h[i] - l[i];
      return Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    });
    return rma(tr, n);
  }
  function obv(c, v) {
    const r = blank(c.length); let acc = 0;
    for (let i = 0; i < c.length; i++) {
      if (bad(c[i])) continue;
      if (i > 0 && !bad(c[i - 1])) acc += c[i] > c[i - 1] ? v[i] || 0 : c[i] < c[i - 1] ? -(v[i] || 0) : 0;
      r[i] = acc;
    }
    return r;
  }

  // ---------- 指標登錄表（UI 依此產生選單） ----------
  const P = (k, label, def, min = 1, max = 250, step = 1) => ({ k, label, def, min, max, step });
  const N20 = [P('n', 'N', 20)];
  const IND = {
    close: { cat: '價格', name: '收盤價', params: [], fn: (s) => s.c },
    open: { cat: '價格', name: '開盤價', params: [], fn: (s) => s.o },
    high: { cat: '價格', name: '最高價', params: [], fn: (s) => s.h },
    low: { cat: '價格', name: '最低價', params: [], fn: (s) => s.l },
    chg: { cat: '價格', name: '漲跌幅 %', params: [], fn: (s) => map2(s.c, prevOf(s.c), (c, p) => (c / p - 1) * 100) },
    gap: { cat: '價格', name: '開盤跳空 %', params: [], fn: (s) => map2(s.o, prevOf(s.c), (o, p) => (o / p - 1) * 100) },
    roc: { cat: '價格', name: 'N 日漲幅 %', params: [P('n', 'N', 5)], fn: (s, n) => s.c.map((v, i) => (i < n || bad(v) || bad(s.c[i - n]) ? null : (v / s.c[i - n] - 1) * 100)) },
    hhvc: { cat: '價格', name: '前 N 日最高收盤', params: N20, fn: (s, n) => highest(s.c, n, true) },
    llvc: { cat: '價格', name: '前 N 日最低收盤', params: N20, fn: (s, n) => lowest(s.c, n, true) },

    sma: { cat: '均線', name: 'SMA 均線', params: N20, fn: (s, n) => sma(s.c, n) },
    ema: { cat: '均線', name: 'EMA 指數均線', params: N20, fn: (s, n) => ema(s.c, n) },
    bias: { cat: '均線', name: '乖離率 %', params: N20, fn: (s, n) => map2(s.c, sma(s.c, n), (c, m) => (c / m - 1) * 100) },

    k: { cat: '動能', name: 'KD 的 K 值', params: [P('n', 'N', 9), P('a', '平滑', 3, 2, 20)], fn: (s, n, a) => kd(s.h, s.l, s.c, n, a).K },
    d: { cat: '動能', name: 'KD 的 D 值', params: [P('n', 'N', 9), P('a', '平滑', 3, 2, 20)], fn: (s, n, a) => kd(s.h, s.l, s.c, n, a).D },
    rsi: { cat: '動能', name: 'RSI', params: [P('n', 'N', 14)], fn: (s, n) => rsi(s.c, n) },
    dif: { cat: '動能', name: 'MACD 的 DIF', params: [P('f', '快', 12), P('s', '慢', 26), P('g', '訊號', 9)], fn: (s, f, sl, g) => macd(s.c, f, sl, g).dif },
    macd: { cat: '動能', name: 'MACD 訊號線', params: [P('f', '快', 12), P('s', '慢', 26), P('g', '訊號', 9)], fn: (s, f, sl, g) => macd(s.c, f, sl, g).sig },
    osc: { cat: '動能', name: 'MACD 柱狀體', params: [P('f', '快', 12), P('s', '慢', 26), P('g', '訊號', 9)], fn: (s, f, sl, g) => macd(s.c, f, sl, g).osc },
    willr: { cat: '動能', name: '威廉 %R', params: [P('n', 'N', 14)], fn: (s, n) => { const hh = highest(s.h, n), ll = lowest(s.l, n); return s.c.map((c, i) => (bad(hh[i]) || bad(ll[i]) || hh[i] === ll[i] ? null : ((hh[i] - c) / (hh[i] - ll[i])) * -100)); } },

    bbu: { cat: '波動', name: '布林上軌', params: [P('n', 'N', 20), P('k', '倍數', 2, 0.5, 5, 0.1)], fn: (s, n, k) => boll(s.c, n, k).up },
    bbm: { cat: '波動', name: '布林中軌', params: [P('n', 'N', 20), P('k', '倍數', 2, 0.5, 5, 0.1)], fn: (s, n, k) => boll(s.c, n, k).mid },
    bbl: { cat: '波動', name: '布林下軌', params: [P('n', 'N', 20), P('k', '倍數', 2, 0.5, 5, 0.1)], fn: (s, n, k) => boll(s.c, n, k).lo },
    bbw: { cat: '波動', name: '布林帶寬 %', params: [P('n', 'N', 20), P('k', '倍數', 2, 0.5, 5, 0.1)], fn: (s, n, k) => boll(s.c, n, k).width },
    atr: { cat: '波動', name: 'ATR', params: [P('n', 'N', 14)], fn: (s, n) => atr(s.h, s.l, s.c, n) },
    atrp: { cat: '波動', name: 'ATR 佔股價 %', params: [P('n', 'N', 14)], fn: (s, n) => map2(atr(s.h, s.l, s.c, n), s.c, (a, c) => (a / c) * 100) },

    vol: { cat: '成交量', name: '成交量（張）', params: [], fn: (s) => s.v },
    vma: { cat: '成交量', name: 'N 日均量（張）', params: [P('n', 'N', 5)], fn: (s, n) => sma(s.v, n) },
    vratio: { cat: '成交量', name: '量比（今量 / 前 N 日均量）', params: [P('n', 'N', 5)], fn: (s, n) => map2(s.v, prevOf(sma(s.v, n)), (v, m) => (m === 0 ? null : v / m)) },
    obv: { cat: '成交量', name: 'OBV 能量潮', params: [], fn: (s) => obv(s.c, s.v) },

    redk: { cat: 'K 線型態', name: '紅 K（收 > 開 = 1）', params: [], fn: (s) => map2(s.c, s.o, (c, o) => (c > o ? 1 : 0)) },
    redn: { cat: 'K 線型態', name: '近 N 日紅 K 數', params: [P('n', 'N', 7)], fn: (s, n) => sum(map2(s.c, s.o, (c, o) => (c > o ? 1 : 0)), n) },
    body: { cat: 'K 線型態', name: 'K 棒實體 %', params: [], fn: (s) => map2(s.c, s.o, (c, o) => (c / o - 1) * 100) },

    fi: { cat: '籌碼', name: '外資買賣超（張，N 日累計）', params: [P('n', 'N', 1)], fn: (s, n) => sum(s.fi || blank(s.c.length), n) },
    it: { cat: '籌碼', name: '投信買賣超（張，N 日累計）', params: [P('n', 'N', 1)], fn: (s, n) => sum(s.it || blank(s.c.length), n) },
    dl: { cat: '籌碼', name: '自營商買賣超（張，N 日累計）', params: [P('n', 'N', 1)], fn: (s, n) => sum(s.dl || blank(s.c.length), n) },
    i3: { cat: '籌碼', name: '三大法人合計（張，N 日累計）', params: [P('n', 'N', 1)], fn: (s, n) => { const f = s.fi || [], t = s.it || [], d = s.dl || []; return sum(s.c.map((_, i) => (bad(f[i]) && bad(t[i]) && bad(d[i]) ? null : (f[i] || 0) + (t[i] || 0) + (d[i] || 0))), n); } },

    per: { cat: '基本面', name: '本益比', params: [], fn: (s) => s.c.map(() => s.per ?? null) },
    pbr: { cat: '基本面', name: '股價淨值比', params: [], fn: (s) => s.c.map(() => s.pbr ?? null) },
    dy: { cat: '基本面', name: '殖利率 %', params: [], fn: (s) => s.c.map(() => s.dy ?? null) },
    yoy: { cat: '基本面', name: '月營收年增 %', params: [], fn: (s) => s.c.map(() => s.yoy ?? null) },
    mom: { cat: '基本面', name: '月營收月增 %', params: [], fn: (s) => s.c.map(() => s.mom ?? null) },

    num: { cat: '數值', name: '固定數值', params: [P('v', '值', 0, -1e9, 1e9, 0.1)], fn: (s, v) => s.c.map(() => v) },
  };
  const OPS = { gt: '大於', gte: '大於等於', lt: '小於', lte: '小於等於', xup: '向上穿越', xdn: '向下穿越' };

  // ---------- 評估 ----------
  function paramsOf(op) {
    const def = IND[op.ind];
    return def.params.map((p) => { const v = op.p && op.p[p.k]; return v === undefined || v === null || v === '' ? p.def : Number(v); });
  }
  function series(s, op) {
    const def = IND[op.ind]; if (!def) return blank(s.c.length);
    const ps = paramsOf(op), key = op.ind + '|' + ps.join(',');
    if (!s._cache) Object.defineProperty(s, '_cache', { value: new Map(), enumerable: false });
    if (!s._cache.has(key)) s._cache.set(key, def.fn(s, ...ps));
    return s._cache.get(key);
  }
  function condArray(s, c) {
    const A = series(s, c.a), B = series(s, c.b), len = s.c.length, raw = new Array(len).fill(false);
    for (let i = 0; i < len; i++) {
      const a = A[i], b = B[i]; if (bad(a) || bad(b)) continue;
      switch (c.op) {
        case 'gt': raw[i] = a > b; break;
        case 'gte': raw[i] = a >= b; break;
        case 'lt': raw[i] = a < b; break;
        case 'lte': raw[i] = a <= b; break;
        case 'xup': raw[i] = i > 0 && !bad(A[i - 1]) && !bad(B[i - 1]) && A[i - 1] <= B[i - 1] && a > b; break;
        case 'xdn': raw[i] = i > 0 && !bad(A[i - 1]) && !bad(B[i - 1]) && A[i - 1] >= B[i - 1] && a < b; break;
      }
    }
    const w = Math.max(1, Number(c.w) || 1); if (w === 1) return raw;
    return raw.map((_, i) => {
      if (i - w + 1 < 0) return false;
      const win = raw.slice(i - w + 1, i + 1);
      return c.mode === 'all' ? win.every(Boolean) : win.some(Boolean);
    });
  }
  function groupArray(s, g) {
    if (!g || !g.conds || !g.conds.length) return null;
    const arrs = g.conds.map((c) => condArray(s, c));
    return s.c.map((_, i) => (g.logic === 'or' ? arrs.some((a) => a[i]) : arrs.every((a) => a[i])));
  }

  // ---------- 回測：訊號於收盤成立，隔日開盤成交 ----------
  function backtest(s, st) {
    const len = s.c.length, sel = groupArray(s, st.sel), en = groupArray(s, st.entry), ex = groupArray(s, st.exit);
    const r = st.risk || {}, sl = (+r.sl || 0) / 100, tp = (+r.tp || 0) / 100, maxHold = +r.maxHold || 0;
    const fee = 0.001425 * (r.feeDiscount === undefined ? 1 : +r.feeDiscount), tax = 0.003;
    const entrySig = s.c.map((_, i) => (sel || en ? (sel ? sel[i] : true) && (en ? en[i] : true) : false));
    const trades = []; let pos = null, pendIn = false, pendOut = null;
    for (let i = 0; i < len; i++) {
      if (pendOut && pos) {
        const px = s.o[i] ?? s.c[i];
        trades.push({ ...pos, outIdx: i, outPx: px, reason: pendOut, ret: (px * (1 - fee - tax)) / (pos.inPx * (1 + fee)) - 1 });
        pos = null; pendOut = null;
      }
      if (pendIn && !pos) { const px = s.o[i] ?? s.c[i]; if (!bad(px)) pos = { inIdx: i, inPx: px }; pendIn = false; }
      if (bad(s.c[i])) continue;
      if (pos) {
        const ret = s.c[i] / pos.inPx - 1, held = i - pos.inIdx + 1;
        const why = sl && ret <= -sl ? '停損' : tp && ret >= tp ? '停利' : maxHold && held >= maxHold ? '持有到期' : ex && ex[i] ? '出場訊號' : null;
        if (why && i + 1 < len) pendOut = why;
      } else if (entrySig[i] && i + 1 < len) pendIn = true;
    }
    const open = pos ? { ...pos, ret: (s.c[len - 1] * (1 - fee - tax)) / (pos.inPx * (1 + fee)) - 1 } : null;
    const wins = trades.filter((t) => t.ret > 0).length;
    const total = trades.reduce((acc, t) => acc * (1 + t.ret), 1) - 1;
    return { trades, open, n: trades.length, winRate: trades.length ? wins / trades.length : null, total: trades.length ? total : null, entrySig, exitSig: ex, selSig: sel };
  }

  function evaluate(s, st) {
    const bt = backtest(s, st), L = s.c.length - 1;
    const hasSel = !!(st.sel && st.sel.conds && st.sel.conds.length);
    return {
      sel: hasSel ? bt.selSig[L] : true,
      entry: bt.entrySig[L] === true,
      exit: bt.exitSig ? bt.exitSig[L] === true : false,
      bt,
    };
  }

  const api = { IND, OPS, series, condArray, groupArray, backtest, evaluate, paramsOf, ta: { sma, ema, rsi, kd, macd, boll, atr } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
