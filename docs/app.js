/* 台股策略篩選器 — 前端 */
(function () {
  'use strict';
  const E = window.Engine;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
    return el;
  };
  const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (v, d = 2) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + fmt(v, d) + '%');
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'dn' : '');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('twss.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('twss.' + k, JSON.stringify(v)); } catch { /* 無痕模式等 */ } },
  };
  const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const C = (a, op, b, w, mode) => ({ a, op, b, w: w || 1, mode: mode || 'any' });
  const I = (ind, p) => ({ ind, p: p || {} });
  const V = (v) => I('num', { v });

  // ---------- 內建範本 ----------
  const TEMPLATES = [
    { name: '均線多頭排列', sel: { logic: 'and', conds: [C(I('close'), 'gt', I('sma', { n: 20 })), C(I('sma', { n: 5 }), 'gt', I('sma', { n: 20 })), C(I('sma', { n: 20 }), 'gt', I('sma', { n: 60 }))] },
      entry: { logic: 'and', conds: [C(I('close'), 'xup', I('sma', { n: 5 }), 3)] }, exit: { logic: 'or', conds: [C(I('close'), 'xdn', I('sma', { n: 20 }))] }, risk: { sl: 8, tp: 0, maxHold: 0 } },
    { name: 'KD 低檔黃金交叉', sel: { logic: 'and', conds: [C(I('close'), 'gt', I('sma', { n: 60 }))] },
      entry: { logic: 'and', conds: [C(I('k'), 'xup', I('d')), C(I('k'), 'lt', V(40))] }, exit: { logic: 'or', conds: [C(I('k'), 'xdn', I('d')), C(I('k'), 'gt', V(85))] }, risk: { sl: 7, tp: 15, maxHold: 20 } },
    { name: 'RSI 超賣反彈', sel: { logic: 'and', conds: [C(I('close'), 'gt', I('sma', { n: 120 }))] },
      entry: { logic: 'and', conds: [C(I('rsi', { n: 14 }), 'xup', V(30))] }, exit: { logic: 'or', conds: [C(I('rsi', { n: 14 }), 'gt', V(70))] }, risk: { sl: 8, tp: 0, maxHold: 30 } },
    { name: '布林通道帶量突破', sel: { logic: 'and', conds: [C(I('bbw', { n: 20, k: 2 }), 'lt', V(15), 5, 'any')] },
      entry: { logic: 'and', conds: [C(I('close'), 'xup', I('bbu', { n: 20, k: 2 })), C(I('vratio', { n: 20 }), 'gte', V(1.5))] }, exit: { logic: 'or', conds: [C(I('close'), 'xdn', I('bbm', { n: 20, k: 2 }))] }, risk: { sl: 6, tp: 0, maxHold: 0 } },
    { name: '投信連續買超', sel: { logic: 'and', conds: [C(I('it'), 'gt', V(0), 3, 'all'), C(I('close'), 'gt', I('sma', { n: 20 }))] },
      entry: { logic: 'and', conds: [C(I('redk'), 'gte', V(1))] }, exit: { logic: 'or', conds: [C(I('it', { n: 3 }), 'lt', V(0))] }, risk: { sl: 8, tp: 20, maxHold: 0 } },
    { name: '強勢紅K＋法人買超＋跳空', sel: { logic: 'and', conds: [C(I('redn', { n: 7 }), 'gte', V(3)), C(I('i3', { n: 7 }), 'gt', V(0)), C(I('k', { n: 60, a: 3 }), 'gte', V(55)), C(I('close'), 'gt', I('sma', { n: 60 }))] },
      entry: { logic: 'and', conds: [C(I('gap'), 'gte', V(2))] }, exit: { logic: 'or', conds: [C(I('bias', { n: 20 }), 'gte', V(15))] }, risk: { sl: 8, tp: 0, maxHold: 0 } },
    { name: '營收成長＋低本益比', sel: { logic: 'and', conds: [C(I('yoy'), 'gt', V(20)), C(I('per'), 'gt', V(0)), C(I('per'), 'lt', V(15)), C(I('close'), 'gt', I('sma', { n: 60 }))] },
      entry: { logic: 'and', conds: [] }, exit: { logic: 'or', conds: [C(I('close'), 'xdn', I('sma', { n: 60 }))] }, risk: { sl: 10, tp: 0, maxHold: 0 } },
  ];
  const blankStrat = () => ({ name: '未命名策略', sel: { logic: 'and', conds: [] }, entry: { logic: 'and', conds: [] }, exit: { logic: 'or', conds: [] }, risk: { sl: 8, tp: 0, maxHold: 0, feeDiscount: 1 } });

  // ---------- 狀態 ----------
  const S = {
    data: null, byInd: new Map(),
    f: { mkt: 'all', inds: new Set(), board: null, q: '', minVol: 500, minPx: null, maxPx: null },
    boards: store.get('boards', []),
    strategies: store.get('strategies', []),
    cur: null, curIdx: -1, tab: 'sel',
    results: [], view: 'sel', sort: { k: 'chg', dir: -1 }, page: 0, ran: false,
  };

  // ---------- 資料載入（GitHub Pages → jsDelivr 備援） ----------
  function mirrorUrl() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/);
    const repo = location.pathname.split('/').filter(Boolean)[0];
    return m && repo ? `https://cdn.jsdelivr.net/gh/${m[1]}/${repo}@data/market.json` : null;
  }
  async function loadData() {
    const urls = ['data/market.json', mirrorUrl()].filter(Boolean);
    let lastErr;
    for (const u of urls) {
      for (let i = 0; i < 2; i++) {
        try {
          const r = await fetch(u, { cache: 'no-cache' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return await r.json();
        } catch (e) { lastErr = e; await new Promise((ok) => setTimeout(ok, 800)); }
      }
    }
    throw lastErr;
  }

  // ---------- 股票池 ----------
  function universe() {
    const f = S.f, q = f.q.trim().toLowerCase();
    const board = f.board !== null ? new Set(S.boards[f.board]?.ids || []) : null;
    return S.data.stocks.filter((s) => {
      if (board && !board.has(s.id)) return false;
      if (f.mkt !== 'all' && s.mkt !== f.mkt) return false;
      if (!board && f.inds.size && !f.inds.has(s.ind)) return false;
      if (q && !s.id.includes(q) && !s.name.toLowerCase().includes(q)) return false;
      const L = s.c.length - 1, c = s.c[L], v = s.v[L];
      if (c === null) return false;
      if (f.minVol && (v || 0) < f.minVol) return false;
      if (f.minPx && c < f.minPx) return false;
      if (f.maxPx && c > f.maxPx) return false;
      return true;
    });
  }

  // ---------- 側欄 ----------
  function renderInds() {
    const ul = $('#indList'); ul.innerHTML = '';
    const list = [...S.byInd.entries()].sort((a, b) => (a[0] === 'ETF') - (b[0] === 'ETF') || b[1] - a[1]);
    for (const [ind, n] of list) {
      const cb = h('input', { type: 'checkbox', value: ind, checked: S.f.inds.has(ind), onchange: (e) => { e.target.checked ? S.f.inds.add(ind) : S.f.inds.delete(ind); S.f.board = null; renderBoards(); updateIndCount(); autoRun(); } });
      ul.append(h('li', {}, h('label', {}, cb, h('span', {}, ind), h('span', {}, n))));
    }
    updateIndCount();
  }
  const updateIndCount = () => { $('#indCount').textContent = S.f.inds.size ? `已選 ${S.f.inds.size} / ${S.byInd.size}` : `全部 ${S.byInd.size} 類`; };

  function renderBoards() {
    const ul = $('#boardList'); ul.innerHTML = '';
    if (!S.boards.length) ul.append(h('li', { class: 'empty-note' }, '把自己關注的族群（例如散熱、CPO）存成板塊，一鍵切換。'));
    S.boards.forEach((b, i) => {
      ul.append(h('li', {},
        h('button', { class: 'pick', 'aria-pressed': String(S.f.board === i), onclick: () => { S.f.board = S.f.board === i ? null : i; renderBoards(); autoRun(); } }, b.name, ' ', h('small', {}, `${b.ids.length} 檔`)),
        h('button', { class: 'link', onclick: () => openBoard(i) }, '編輯'),
        h('button', { class: 'link', onclick: () => { if (confirm(`刪除自選板塊「${b.name}」？`)) { S.boards.splice(i, 1); if (S.f.board === i) S.f.board = null; store.set('boards', S.boards); renderBoards(); autoRun(); } } }, '刪除')));
    });
  }
  function openBoard(i) {
    const dlg = $('#boardDlg'), b = i === undefined ? { name: '', ids: [] } : S.boards[i];
    $('#boardDlgTitle').textContent = i === undefined ? '建立自選板塊' : '編輯自選板塊';
    $('#boardName').value = b.name; $('#boardIds').value = b.ids.join(' ');
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      const ids = [...new Set($('#boardIds').value.split(/[\s,，、]+/).map((x) => x.trim()).filter(Boolean))];
      const known = new Set(S.data.stocks.map((s) => s.id)), miss = ids.filter((x) => !known.has(x));
      const nb = { name: $('#boardName').value.trim() || '自選板塊', ids: ids.filter((x) => known.has(x)) };
      if (i === undefined) S.boards.push(nb); else S.boards[i] = nb;
      store.set('boards', S.boards); renderBoards();
      toast(miss.length ? `已儲存板塊；找不到代號：${miss.join('、')}` : '已儲存板塊');
    };
    dlg.showModal();
  }

  // ---------- 策略編輯器 ----------
  const catOrder = ['價格', '均線', '動能', '波動', '成交量', 'K 線型態', '籌碼', '基本面', '數值'];
  function indSelect(value, onchange) {
    const sel = h('select', { 'aria-label': '指標', onchange });
    for (const cat of catOrder) {
      const g = h('optgroup', { label: cat });
      for (const [k, d] of Object.entries(E.IND)) if (d.cat === cat) g.append(h('option', { value: k, selected: k === value }, d.name));
      sel.append(g);
    }
    return sel;
  }
  function operand(op, onchange) {
    const wrap = h('span', { class: 'operand' });
    const draw = () => {
      wrap.innerHTML = '';
      wrap.append(indSelect(op.ind, (e) => { op.ind = e.target.value; op.p = {}; draw(); onchange(); }));
      for (const p of E.IND[op.ind].params) {
        const val = op.p[p.k] ?? p.def;
        wrap.append(h('span', { class: 'pl' }, p.label), h('input', { type: 'number', value: val, min: p.min, max: p.max, step: p.step, 'aria-label': p.label, onchange: (e) => { op.p[p.k] = e.target.value === '' ? p.def : Number(e.target.value); onchange(); } }));
      }
    };
    draw();
    return wrap;
  }
  const TAB_HINT = {
    sel: '選股條件決定哪些股票「值得關注」。條件以最新一個交易日判斷。',
    entry: '進場條件在符合選股條件的前提下觸發買進訊號（收盤判斷、隔日開盤進場）。留空＝符合選股即進場。',
    exit: '任一出場條件成立即賣出（隔日開盤出場）。停損停利請到「風控與成本」設定。',
  };
  function renderTab() {
    const body = $('#tabBody'); body.innerHTML = '';
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
    ['sel', 'entry', 'exit'].forEach((k) => { $('#n' + { sel: 'Sel', entry: 'Entry', exit: 'Exit' }[k]).textContent = S.cur[k].conds.length; });
    if (S.tab === 'risk') return renderRisk(body);
    const g = S.cur[S.tab];
    body.append(h('p', { class: 'tab-hint' }, TAB_HINT[S.tab]));
    const logic = h('select', { onchange: (e) => { g.logic = e.target.value; dirty(); } },
      h('option', { value: 'and', selected: g.logic === 'and' }, '全部符合（AND）'), h('option', { value: 'or', selected: g.logic === 'or' }, '任一符合（OR）'));
    body.append(h('div', { class: 'logic' }, '條件關係', logic));
    g.conds.forEach((c, i) => {
      const opSel = h('select', { class: 'op-sel', 'aria-label': '比較方式', onchange: (e) => { c.op = e.target.value; dirty(); } },
        ...Object.entries(E.OPS).map(([k, v]) => h('option', { value: k, selected: k === c.op }, v)));
      const win = h('span', { class: 'win' }, '最近',
        h('input', { type: 'number', min: 1, max: 60, value: c.w || 1, 'aria-label': '天數', onchange: (e) => { c.w = Math.max(1, +e.target.value || 1); dirty(); } }), '日',
        h('select', { 'aria-label': '成立方式', onchange: (e) => { c.mode = e.target.value; dirty(); } },
          h('option', { value: 'any', selected: c.mode !== 'all' }, '內曾成立'), h('option', { value: 'all', selected: c.mode === 'all' }, '連續成立')));
      body.append(h('div', { class: 'cond' }, operand(c.a, dirty), opSel, operand(c.b, dirty), win,
        h('button', { class: 'del', 'aria-label': '刪除條件', title: '刪除條件', onclick: () => { g.conds.splice(i, 1); dirty(); renderTab(); } }, '×')));
    });
    if (!g.conds.length) body.append(h('p', { class: 'empty-note' }, S.tab === 'sel' ? '尚無選股條件：目前股票池全部列入。' : '尚無條件。'));
    body.append(h('button', { class: 'ghost add', onclick: () => { g.conds.push(C(I('close'), 'gt', I('sma', { n: 20 }))); dirty(); renderTab(); } }, '＋ 新增條件'));
  }
  function renderRisk(body) {
    const r = S.cur.risk;
    const fld = (k, label, hint, step = 1) => h('label', {}, label,
      h('input', { type: 'number', min: 0, step, value: r[k] ?? 0, onchange: (e) => { r[k] = Number(e.target.value) || 0; dirty(); } }), h('small', {}, hint));
    body.append(h('p', { class: 'tab-hint' }, '回測以收盤判斷訊號、隔日開盤成交，已計入手續費 0.1425%（可設折扣）與證交稅 0.3%。填 0 代表不啟用。'),
      h('div', { class: 'risk-grid' },
        fld('sl', '停損 %', '收盤虧損達此幅度，隔日出場'),
        fld('tp', '停利 %', '收盤獲利達此幅度，隔日出場'),
        fld('maxHold', '最長持有天數', '持有滿 N 個交易日出場'),
        h('label', {}, '手續費折扣', h('input', { type: 'number', min: 0.1, max: 1, step: 0.05, value: r.feeDiscount ?? 1, onchange: (e) => { r.feeDiscount = Math.min(1, Math.max(0.1, Number(e.target.value) || 1)); dirty(); } }), h('small', {}, '例如 6 折填 0.6'))));
  }
  function dirty() { renderCounts(); store.set('last', S.cur); }
  const renderCounts = () => ['sel', 'entry', 'exit'].forEach((k) => { $('#n' + { sel: 'Sel', entry: 'Entry', exit: 'Exit' }[k]).textContent = S.cur[k].conds.length; });

  function renderStratPick() {
    const sel = $('#stratPick'); sel.innerHTML = '';
    sel.append(h('option', { value: -1, selected: S.curIdx < 0 }, S.curIdx < 0 ? `（未儲存）${S.cur.name}` : '新策略'));
    S.strategies.forEach((s, i) => sel.append(h('option', { value: i, selected: i === S.curIdx }, s.name)));
  }
  function setStrategy(st, idx = -1) { S.cur = clone(st); S.cur.risk = { ...blankStrat().risk, ...(S.cur.risk || {}) }; S.curIdx = idx; renderStratPick(); renderTab(); store.set('last', S.cur); }

  // ---------- 篩選 ----------
  function run() {
    const t0 = performance.now(), uni = universe(), st = S.cur;
    const L = S.data.dates.length - 1;
    S.results = uni.map((s) => {
      const ev = E.evaluate(s, st), c = s.c[L], pc = s.c[L - 1];
      return { s, id: s.id, name: s.name, ind: s.ind, mkt: s.mkt, close: c, chg: pc ? (c / pc - 1) * 100 : null, vol: s.v[L],
        sel: ev.sel, entry: ev.entry, exit: ev.exit, bt: ev.bt, btTotal: ev.bt.total, btWin: ev.bt.winRate, btN: ev.bt.n };
    });
    S.ran = true; S.page = 0;
    const nSel = S.results.filter((r) => r.sel).length, nIn = S.results.filter((r) => r.entry).length, nOut = S.results.filter((r) => r.exit).length;
    const trades = S.results.flatMap((r) => r.bt.trades);
    const win = trades.filter((t) => t.ret > 0).length, avg = trades.length ? trades.reduce((a, t) => a + t.ret, 0) / trades.length : null;
    const sum = $('#summary'); sum.innerHTML = '';
    sum.append('股票池 ', h('strong', {}, uni.length), ' 檔，符合選股 ', h('strong', {}, nSel), ' 檔，今日進場訊號 ', h('strong', { class: 'sig' }, nIn), ' 檔，出場訊號 ', h('strong', {}, nOut), ' 檔。',
      h('br'), trades.length ? `近 ${S.data.dates.length} 個交易日回測：${trades.length} 筆交易，勝率 ${fmt((win / trades.length) * 100, 1)}%，平均每筆 ${pct(avg * 100)}。` : '回測期間沒有觸發交易。',
      h('span', { class: 'count' }, `（${Math.round(performance.now() - t0)} 毫秒）`));
    renderResults();
  }
  let autoT;
  const autoRun = () => { if (!S.ran) return; clearTimeout(autoT); autoT = setTimeout(run, 250); };

  // ---------- 結果表 ----------
  const COLS = [
    { k: 'id', label: '代號', l: true }, { k: 'name', label: '名稱', l: true }, { k: 'ind', label: '產業', l: true },
    { k: 'close', label: '收盤' }, { k: 'chg', label: '漲跌' }, { k: 'vol', label: '成交量（張）' },
    { k: 'sig', label: '今日訊號', l: true }, { k: 'btN', label: '回測筆數' }, { k: 'btWin', label: '勝率' }, { k: 'btTotal', label: '累計報酬' },
  ];
  function rowsForView() {
    const v = S.view;
    let rows = S.results.filter((r) => (v === 'entry' ? r.entry : v === 'exit' ? r.exit : r.sel));
    const { k, dir } = S.sort;
    const key = k === 'sig' ? (r) => (r.entry ? 2 : 0) + (r.exit ? 1 : 0) : (r) => r[k];
    rows.sort((a, b) => { const x = key(a), y = key(b); if (x === y) return 0; if (x === null || x === undefined) return 1; if (y === null || y === undefined) return -1; return (x > y ? 1 : -1) * dir; });
    return rows;
  }
  function renderResults() {
    const tbl = $('#tbl'); tbl.innerHTML = ''; $('#pager').innerHTML = '';
    $$('#view button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === S.view)));
    if (!S.ran) { tbl.append(h('tbody', {}, h('tr', {}, h('td', { class: 'empty' }, '選好板塊與條件後，按「執行篩選」。')))); return; }
    if (S.view === 'boards') return renderBoardStats(tbl);
    const rows = rowsForView(), per = 100, pages = Math.ceil(rows.length / per);
    S.page = Math.min(S.page, Math.max(0, pages - 1));
    const thead = h('thead', {}, h('tr', {}, ...COLS.map((c) => h('th', { class: c.l ? 'l' : '', scope: 'col', 'aria-sort': S.sort.k === c.k ? (S.sort.dir < 0 ? 'descending' : 'ascending') : null, tabindex: 0,
      onclick: () => { S.sort = { k: c.k, dir: S.sort.k === c.k ? -S.sort.dir : -1 }; renderResults(); },
      onkeydown: (e) => { if (e.key === 'Enter') e.target.click(); } }, c.label))));
    const tb = h('tbody');
    if (!rows.length) tb.append(h('tr', {}, h('td', { class: 'empty', colspan: COLS.length }, S.view === 'sel' ? '沒有股票符合條件。試著放寬條件、降低成交量門檻，或擴大板塊範圍。' : '今天沒有股票出現這類訊號。')));
    for (const r of rows.slice(S.page * per, S.page * per + per)) {
      tb.append(h('tr', { tabindex: 0, onclick: () => openDetail(r), onkeydown: (e) => { if (e.key === 'Enter') openDetail(r); } },
        h('td', { class: 'l code' }, r.id), h('td', { class: 'l' }, r.name), h('td', { class: 'l' }, r.ind),
        h('td', { class: cls(r.chg) }, fmt(r.close)), h('td', { class: cls(r.chg) }, pct(r.chg)), h('td', {}, fmt(r.vol, 0)),
        h('td', { class: 'l' }, r.entry ? h('span', { class: 'tag in' }, '進場') : '', ' ', r.exit ? h('span', { class: 'tag out' }, '出場') : ''),
        h('td', {}, r.btN || '—'), h('td', {}, r.btWin === null ? '—' : fmt(r.btWin * 100, 0) + '%'), h('td', { class: cls(r.btTotal) }, r.btTotal === null ? '—' : pct(r.btTotal * 100, 1))));
    }
    tbl.append(thead, tb);
    if (pages > 1) {
      $('#pager').append(h('button', { class: 'ghost', disabled: S.page === 0, onclick: () => { S.page--; renderResults(); } }, '上一頁'),
        h('span', {}, `第 ${S.page + 1} / ${pages} 頁，共 ${rows.length} 檔`),
        h('button', { class: 'ghost', disabled: S.page >= pages - 1, onclick: () => { S.page++; renderResults(); } }, '下一頁'));
    }
  }
  function renderBoardStats(tbl) {
    const m = new Map();
    for (const r of S.results) {
      const x = m.get(r.ind) || { ind: r.ind, n: 0, sel: 0, entry: 0, chg: 0, cn: 0, up: 0 };
      x.n++; x.sel += r.sel; x.entry += r.entry; if (r.chg !== null) { x.chg += r.chg; x.cn++; x.up += r.chg > 0; } m.set(r.ind, x);
    }
    const rows = [...m.values()].map((x) => ({ ...x, avg: x.cn ? x.chg / x.cn : null, ratio: x.n ? x.sel / x.n : 0 })).sort((a, b) => b.ratio - a.ratio || b.sel - a.sel);
    tbl.append(h('thead', {}, h('tr', {}, ...['產業板塊', '檔數', '符合選股', '符合比例', '今日進場訊號', '上漲家數', '平均漲跌'].map((t, i) => h('th', { class: i ? '' : 'l', scope: 'col' }, t)))),
      h('tbody', {}, ...rows.map((x) => h('tr', { tabindex: 0, title: '只看這個板塊', onclick: () => { S.f.inds = new Set([x.ind]); S.f.board = null; renderInds(); renderBoards(); S.view = 'sel'; run(); } },
        h('td', { class: 'l code' }, x.ind), h('td', {}, x.n), h('td', {}, x.sel), h('td', {}, fmt(x.ratio * 100, 1) + '%'), h('td', {}, x.entry), h('td', {}, `${x.up} / ${x.cn}`), h('td', { class: cls(x.avg) }, pct(x.avg))))));
  }

  // ---------- 個股詳情 ----------
  function openDetail(r) {
    const s = r.s, dlg = $('#detail');
    $('#dTitle').textContent = `${s.id} ${s.name}　${s.mkt}｜${s.ind}`;
    const L = s.c.length - 1, ct = $('#dConds'); ct.innerHTML = '';
    ct.append(h('thead', {}, h('tr', {}, h('th', { class: 'l' }, '條件'), h('th', {}, '左值'), h('th', {}, '右值'), h('th', {}, '結果'))));
    const tb = h('tbody');
    const label = (op) => E.IND[op.ind].name + (E.IND[op.ind].params.length ? `(${E.paramsOf(op).join(',')})` : '');
    for (const [k, t] of [['sel', '選股'], ['entry', '進場'], ['exit', '出場']]) {
      for (const c of S.cur[k].conds) {
        const a = E.series(s, c.a)[L], b = E.series(s, c.b)[L], ok = E.condArray(s, c)[L];
        tb.append(h('tr', {}, h('td', { class: 'l' }, `${t}：${label(c.a)} ${E.OPS[c.op]} ${label(c.b)}${(c.w || 1) > 1 ? `（近 ${c.w} 日${c.mode === 'all' ? '連續' : '內'}）` : ''}`),
          h('td', {}, fmt(a)), h('td', {}, fmt(b)), h('td', { class: ok ? 'up' : 'dn' }, ok ? '成立' : '未成立')));
      }
    }
    if (!tb.children.length) tb.append(h('tr', {}, h('td', { colspan: 4, class: 'empty' }, '目前策略沒有任何條件。')));
    ct.append(tb);
    const bt = r.bt, D = S.data.dates.map((d) => d.replaceAll('-', '/'));
    $('#dStats').textContent = bt.n ? `共 ${bt.n} 筆，勝率 ${fmt(bt.winRate * 100, 0)}%，累計報酬 ${pct(bt.total * 100, 1)}` + (bt.open ? `；持有中 ${pct(bt.open.ret * 100, 1)}` : '') : (bt.open ? `持有中（${D[bt.open.inIdx]} 進場），未實現 ${pct(bt.open.ret * 100, 1)}` : '回測期間沒有交易。');
    const tt = $('#dTrades'); tt.innerHTML = '';
    tt.append(h('thead', {}, h('tr', {}, ...['進場日', '進場價', '出場日', '出場價', '報酬', '原因'].map((x) => h('th', {}, x)))));
    tt.append(h('tbody', {}, ...[...bt.trades, ...(bt.open ? [{ ...bt.open, outIdx: null, reason: '持有中' }] : [])].reverse().map((t) =>
      h('tr', {}, h('td', {}, D[t.inIdx]), h('td', {}, fmt(t.inPx)), h('td', {}, t.outIdx === null ? '—' : D[t.outIdx]), h('td', {}, t.outIdx === null ? '—' : fmt(t.outPx)), h('td', { class: cls(t.ret) }, pct(t.ret * 100, 1)), h('td', {}, t.reason)))));
    dlg.showModal();
    requestAnimationFrame(() => drawChart(s, bt));
  }
  function drawChart(s, bt) {
    const cv = $('#chart'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = 380;
    cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement), col = (v) => css.getPropertyValue(v).trim();
    const n = s.c.length, padL = 8, padR = 56, top = 10, priceH = H * 0.7, volTop = priceH + 24, volH = H - volTop - 18;
    const lo = Math.min(...s.l.filter((x) => x !== null)), hi = Math.max(...s.h.filter((x) => x !== null));
    const x = (i) => padL + ((W - padL - padR) * (i + 0.5)) / n, bw = Math.max(1, ((W - padL - padR) / n) * 0.62);
    const y = (p) => top + (priceH - top) * (1 - (p - lo) / (hi - lo || 1));
    const vmax = Math.max(1, ...s.v.filter((v) => v !== null));
    g.clearRect(0, 0, W, H); g.font = '11px "Noto Sans TC", sans-serif'; g.fillStyle = col('--muted'); g.strokeStyle = col('--line'); g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) { const p = lo + ((hi - lo) * k) / 4, yy = Math.round(y(p)) + 0.5; g.beginPath(); g.moveTo(padL, yy); g.lineTo(W - padR, yy); g.stroke(); g.fillText(fmt(p), W - padR + 6, yy + 4); }
    for (let i = 0; i < n; i++) {
      if (s.c[i] === null) continue;
      const upc = s.c[i] >= s.o[i], c = upc ? col('--up') : col('--down');
      g.strokeStyle = c; g.fillStyle = c;
      g.beginPath(); g.moveTo(x(i), y(s.h[i])); g.lineTo(x(i), y(s.l[i])); g.stroke();
      const y1 = y(Math.max(s.o[i], s.c[i])), y2 = y(Math.min(s.o[i], s.c[i]));
      g.fillRect(x(i) - bw / 2, y1, bw, Math.max(1, y2 - y1));
      const vh = (volH * (s.v[i] || 0)) / vmax; g.globalAlpha = 0.55; g.fillRect(x(i) - bw / 2, volTop + volH - vh, bw, vh); g.globalAlpha = 1;
    }
    const lines = [[5, '#D9A21B'], [20, '#3F7BD8'], [60, '#8B5CC7']];
    lines.forEach(([p, c]) => { const m = E.series(s, { ind: 'sma', p: { n: p } }); g.strokeStyle = c; g.lineWidth = 1.3; g.beginPath(); let st = false; m.forEach((v, i) => { if (v === null) { st = false; return; } st ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)); st = true; }); g.stroke(); });
    g.lineWidth = 1; let lx = padL + 4;
    lines.forEach(([p, c]) => { g.fillStyle = c; g.fillText(`MA${p}`, lx, top + 10); lx += 42; });
    const mark = (i, up) => { g.fillStyle = up ? col('--signal') : col('--ink'); const xx = x(i), yy = up ? y(s.l[i]) + 12 : y(s.h[i]) - 12; g.beginPath(); if (up) { g.moveTo(xx, yy - 6); g.lineTo(xx - 5, yy + 3); g.lineTo(xx + 5, yy + 3); } else { g.moveTo(xx, yy + 6); g.lineTo(xx - 5, yy - 3); g.lineTo(xx + 5, yy - 3); } g.fill(); };
    bt.trades.forEach((t) => { mark(t.inIdx, true); mark(t.outIdx, false); }); if (bt.open) mark(bt.open.inIdx, true);
    g.fillStyle = col('--muted'); const D = S.data.dates; [0, Math.floor(n / 2), n - 1].forEach((i, k) => { g.textAlign = ['left', 'center', 'right'][k]; g.fillText(D[i].replaceAll('-', '/'), x(i), H - 4); }); g.textAlign = 'left';
  }

  // ---------- 匯出 / 分享 ----------
  function csv() {
    if (!S.ran) return toast('請先執行篩選');
    const rows = S.view === 'boards' ? [] : rowsForView();
    const head = ['代號', '名稱', '市場', '產業', '收盤', '漲跌%', '成交量(張)', '進場訊號', '出場訊號', '回測筆數', '勝率%', '累計報酬%'];
    const lines = [head, ...rows.map((r) => [r.id, r.name, r.mkt, r.ind, r.close, r.chg?.toFixed(2), r.vol, r.entry ? 'Y' : '', r.exit ? 'Y' : '', r.btN, r.btWin === null ? '' : (r.btWin * 100).toFixed(0), r.btTotal === null ? '' : (r.btTotal * 100).toFixed(1)])];
    const blob = new Blob(['\uFEFF' + lines.map((l) => l.map((x) => `"${String(x ?? '').replaceAll('"', '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `台股篩選_${S.data.meta.last_trading_day.replaceAll('/', '')}.csv` }); a.click();
  }
  const enc = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const dec = (t) => JSON.parse(decodeURIComponent(escape(atob(t.replaceAll('-', '+').replaceAll('_', '/')))));
  function validStrat(o) {
    if (!o || typeof o !== 'object') return false;
    for (const k of ['sel', 'entry', 'exit']) {
      if (!o[k] || !Array.isArray(o[k].conds)) return false;
      for (const c of o[k].conds) if (!c.a || !c.b || !E.IND[c.a.ind] || !E.IND[c.b.ind] || !E.OPS[c.op]) return false;
    }
    return true;
  }

  // ---------- 事件 ----------
  function bind() {
    $$('#mkt button').forEach((b) => b.addEventListener('click', () => { S.f.mkt = b.dataset.v; $$('#mkt button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); autoRun(); }));
    $('#minVol').addEventListener('change', (e) => { S.f.minVol = +e.target.value || 0; autoRun(); });
    $('#minPx').addEventListener('change', (e) => { S.f.minPx = +e.target.value || null; autoRun(); });
    $('#maxPx').addEventListener('change', (e) => { S.f.maxPx = +e.target.value || null; autoRun(); });
    $('#search').addEventListener('input', (e) => { S.f.q = e.target.value; autoRun(); });
    $('#indAll').addEventListener('click', () => { S.f.inds = new Set(S.byInd.keys()); S.f.board = null; renderInds(); renderBoards(); autoRun(); });
    $('#indNone').addEventListener('click', () => { S.f.inds.clear(); renderInds(); autoRun(); });
    $('#boardNew').addEventListener('click', () => openBoard());
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; renderTab(); }));
    $('#btnRun').addEventListener('click', run);
    $$('#view button').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.v; S.page = 0; renderResults(); }));
    $('#btnCsv').addEventListener('click', csv);
    $('#dClose').addEventListener('click', () => $('#detail').close());
    $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') e.target.close(); });
    $('#stratPick').addEventListener('change', (e) => { const i = +e.target.value; if (i >= 0) { setStrategy(S.strategies[i], i); autoRun(); } });
    TEMPLATES.forEach((t, i) => $('#tplPick').append(h('option', { value: i }, t.name)));
    $('#tplPick').addEventListener('change', (e) => { if (e.target.value === '') return; const t = clone(TEMPLATES[+e.target.value]); t.name = t.name + '（範本）'; setStrategy(t); e.target.value = ''; toast(`已套用「${t.name}」`); autoRun(); });
    $('#stratSave').addEventListener('click', () => {
      if (S.curIdx < 0) return $('#stratSaveAs').click();
      S.strategies[S.curIdx] = clone(S.cur); store.set('strategies', S.strategies); renderStratPick(); toast('已儲存策略');
    });
    $('#stratSaveAs').addEventListener('click', () => {
      const name = prompt('策略名稱', S.cur.name.replace('（範本）', '')); if (!name) return;
      S.cur.name = name.trim(); S.strategies.push(clone(S.cur)); S.curIdx = S.strategies.length - 1; store.set('strategies', S.strategies); renderStratPick(); toast('已另存新策略');
    });
    $('#stratDel').addEventListener('click', () => {
      if (S.curIdx < 0) return toast('這個策略尚未儲存');
      if (!confirm(`刪除策略「${S.cur.name}」？`)) return;
      S.strategies.splice(S.curIdx, 1); store.set('strategies', S.strategies); setStrategy(blankStrat()); toast('已刪除策略');
    });
    $('#stratShare').addEventListener('click', async () => {
      const url = `${location.origin}${location.pathname}#s=${enc(S.cur)}`;
      try { await navigator.clipboard.writeText(url); toast('已複製分享連結，對方打開即套用此策略'); } catch { prompt('複製這個連結分享策略', url); }
    });
    $('#stratExport').addEventListener('click', () => { const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(S.cur, null, 1)], { type: 'application/json' })), download: `${S.cur.name}.json` }); a.click(); });
    $('#stratImport').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const o = JSON.parse(await f.text()); if (!validStrat(o)) throw new Error(); setStrategy(o); toast(`已匯入「${o.name || '策略'}」`); autoRun(); } catch { toast('檔案格式不正確，請匯入本站匯出的策略 JSON'); }
      e.target.value = '';
    });
    $('#btnSources').addEventListener('click', () => $('#srcDlg').showModal());
  }

  // ---------- 啟動 ----------
  async function init() {
    bind();
    if (matchMedia('(max-width: 860px)').matches) $$('.side-block').slice(1).forEach((d) => d.removeAttribute('open'));
    let fromHash = null;
    if (location.hash.startsWith('#s=')) { try { const o = dec(location.hash.slice(3)); if (validStrat(o)) fromHash = o; } catch { /* 忽略 */ } history.replaceState(null, '', location.pathname); }
    setStrategy(fromHash || store.get('last', null) || clone(TEMPLATES[0]));
    if (fromHash) toast('已套用分享的策略');
    renderResults();
    try {
      S.data = await loadData();
    } catch (e) {
      $('#stamp').textContent = '資料暫時無法載入，請稍後重新整理。若持續發生，可能是資料首次建立中。';
      $('#btnRun').disabled = true; return;
    }
    const m = S.data.meta;
    for (const s of S.data.stocks) S.byInd.set(s.ind, (S.byInd.get(s.ind) || 0) + 1);
    const lastDay = new Date(m.last_trading_day.replaceAll('/', '-') + 'T00:00:00+08:00');
    const stale = (Date.now() - lastDay) / 864e5 > 5;
    $('#stamp').innerHTML = '';
    $('#stamp').append(`收盤資料日 ${m.last_trading_day}｜共 ${S.data.stocks.length} 檔、${S.byInd.size} 個產業板塊｜近 ${S.data.dates.length} 個交易日`,
      stale ? h('span', { class: 'demo' }, '　資料超過 5 天未更新，可能為連假或來源暫停') : '');
    const src = $('#srcBody'); const dl = h('dl');
    const names = { universe: '股票清單', snapshot: '當日行情', history: '歷史 K 線', inst: '三大法人', fundamentals: '估值與月營收' };
    for (const [k, v] of Object.entries(m.sources || {})) dl.append(h('dt', {}, names[k] || k), h('dd', {}, v));
    dl.append(h('dt', {}, '更新時間'), h('dd', {}, m.updated), h('dt', {}, '說明'), h('dd', {}, m.note || ''));
    src.append(dl);
    renderInds(); renderBoards();
    run();
  }
  init();
})();
