"""
台股即時行情中繼伺服器（部署在 Oracle Cloud 永久免費主機）

資料來源：證交所「基本市況報導」mis.twse.com.tw（上市、上櫃皆可查，約 5 秒更新一次快照）
運作方式：
  - 熱門通道：網頁上正在看的個股（K 線圖、自選清單、結果目前這一頁）每 5 秒查一次
  - 背景通道：全市場輪流查，約 1 分鐘一輪，用來組出每一檔的 1 分 K 與篩選跟價
  - 全部請求共用同一個節流器（預設每 1.25 秒 1 次、每次 100 檔），遇錯自動放慢
  - 1 分 K 由連續快照組成，同時參考當日最高/最低價修正影線
對外提供：
  GET /api/status          伺服器狀態
  GET /api/snapshot        全市場最新報價（精簡格式）
  GET /api/bars/{代號}     當日 1 分 K
  WS  /ws                  訂閱即時報價與 1 分 K 推播
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

TZ = timezone(timedelta(hours=8))
UNIVERSE_URL = os.getenv("UNIVERSE_URL", "https://kh7666.github.io/tw-screener/data/market.json")
ALLOW = [o.strip() for o in os.getenv("ALLOW_ORIGINS", "https://kh7666.github.io,http://localhost:8765").split(",") if o.strip()]
DATA_DIR = Path(os.getenv("DATA_DIR", "/var/lib/twss"))
BATCH = int(os.getenv("BATCH", "100"))          # 每次請求查幾檔
SLOT = float(os.getenv("SLOT", "1.25"))         # 請求間隔（秒）
HOT_EVERY = float(os.getenv("HOT_EVERY", "5"))  # 熱門通道更新週期（秒）
HOT_CAP = int(os.getenv("HOT_CAP", "200"))      # 熱門通道最多幾檔
SUB_CAP = int(os.getenv("SUB_CAP", "60"))       # 每個網頁最多訂閱幾檔
WS_PER_IP = int(os.getenv("WS_PER_IP", "6"))
MIS = os.getenv("MIS_URL", "https://mis.twse.com.tw/stock/api/getStockInfo.jsp")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "Referer": "https://mis.twse.com.tw/stock/index.jsp", "Accept": "application/json"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("relay")
logging.getLogger("httpx").setLevel(logging.WARNING)


def now() -> datetime:
    return datetime.now(TZ)


def f(x):
    try:
        v = float(str(x).replace(",", ""))
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


class State:
    def __init__(self):
        self.universe: dict[str, dict] = {}      # 代號 -> {m: tse/otc, n: 名稱, y: 前收}
        self.order: list[str] = []
        self.day = ""
        self.quotes: dict[str, dict] = {}         # 代號 -> 最新報價
        self.bars: dict[str, list] = {}           # 代號 -> [[分鐘秒數, 開, 高, 低, 收, 量]]
        self.cumv: dict[str, float] = {}
        self.dayhl: dict[str, tuple] = {}
        self.clients: dict[WebSocket, dict] = {}
        self.ok = 0
        self.err = 0
        self.last_ok = 0.0
        self.interval = SLOT
        self.cycle_started = time.time()
        self.cycle_seconds = None
        self.holiday = False
        self.stale = 0
        self.last_error = ""
        self.last_sync = 0.0  # 盤後同步時間

    def hot(self) -> list[str]:
        cnt: dict[str, int] = defaultdict(int)
        for c in self.clients.values():
            for i in c["ids"]:
                cnt[i] += 1
            if c.get("chart"):
                cnt[c["chart"]] += 5  # 正在看 K 線圖的優先
        ids = [i for i, _ in sorted(cnt.items(), key=lambda kv: -kv[1]) if i in self.universe]
        return ids[:HOT_CAP]


S = State()


# ───────────── 股票清單（沿用網站每日盤後資料） ─────────────
async def load_universe():
    for attempt in range(10):
        try:
            async with httpx.AsyncClient(timeout=60, follow_redirects=True) as cli:
                j = (await cli.get(UNIVERSE_URL)).json()
            uni = {}
            for s in j["stocks"]:
                y = next((c for c in reversed(s["c"]) if c is not None), None)
                uni[s["id"]] = {"m": "tse" if s["mkt"] == "上市" else "otc", "n": s["name"], "y": y}
            S.universe = uni
            S.order = sorted(uni)
            log.info("股票清單 %d 檔（資料日 %s）", len(uni), j["meta"]["last_trading_day"])
            return
        except Exception as e:  # noqa: BLE001
            log.warning("載入股票清單失敗（%d）：%s", attempt + 1, e)
            await asyncio.sleep(min(300, 10 * 2 ** attempt))


# ───────────── 當日狀態保存（重啟不遺失已組好的 K 棒） ─────────────
def state_file(day: str) -> Path:
    return DATA_DIR / f"state-{day}.json"


def save_state():
    if not S.day:
        return
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = state_file(S.day).with_suffix(".tmp")
        tmp.write_text(json.dumps({"day": S.day, "quotes": S.quotes, "bars": S.bars, "cumv": S.cumv,
                                   "dayhl": S.dayhl}, separators=(",", ":")), "utf-8")
        tmp.replace(state_file(S.day))
        for p in DATA_DIR.glob("state-*.json"):  # 只保留最近 3 天
            if p.stem < f"state-{(now() - timedelta(days=3)):%Y%m%d}":
                p.unlink(missing_ok=True)
    except Exception as e:  # noqa: BLE001
        log.warning("保存狀態失敗：%s", e)


def load_state(day: str):
    p = state_file(day)
    if not p.exists():
        return
    try:
        j = json.loads(p.read_text("utf-8"))
        S.quotes, S.bars, S.cumv = j["quotes"], j["bars"], j["cumv"]
        S.dayhl = {k: tuple(v) for k, v in j["dayhl"].items()}
        log.info("載入今日已記錄的資料：%d 檔", len(S.bars))
    except Exception as e:  # noqa: BLE001
        log.warning("讀取狀態失敗：%s", e)


def new_day(day: str):
    save_state()
    S.day, S.quotes, S.bars, S.cumv, S.dayhl, S.holiday = day, {}, {}, {}, {}, False
    load_state(day)


# ───────────── 解析證交所快照 ─────────────
def ingest(r: dict) -> str | None:
    sid = str(r.get("c", "")).strip()
    if sid not in S.universe:
        return None
    d = str(r.get("d", ""))
    if d and d != S.day:
        S.stale += 1  # 回傳的不是今天的資料
        return None
    tl = int(r.get("tlong") or 0)
    z, y = f(r.get("z")), f(r.get("y"))
    o, h, l, v = f(r.get("o")), f(r.get("h")), f(r.get("l")), f(r.get("v")) or 0.0
    bid = f(str(r.get("b", "")).split("_")[0])
    ask = f(str(r.get("a", "")).split("_")[0])
    q = S.quotes.get(sid, {})
    price = z or q.get("z")
    q.update({"z": price, "y": y or q.get("y") or S.universe[sid]["y"], "o": o, "h": h, "l": l,
              "v": v, "t": tl or q.get("t"), "b": bid, "a": ask})
    S.quotes[sid] = q
    if z and tl:
        m = tl // 60000 * 60
        bars = S.bars.setdefault(sid, [])
        prev_v = S.cumv.get(sid)
        dv = v if prev_v is None else max(0.0, v - prev_v)
        S.cumv[sid] = v
        hi = lo = z
        ph, pl = S.dayhl.get(sid, (None, None))
        if h and ph and h > ph:
            hi = max(hi, h)  # 兩次快照之間創新高：把影線補進這根
        if l and pl and l < pl:
            lo = min(lo, l)
        S.dayhl[sid] = (h, l)
        if bars and bars[-1][0] == m:
            b = bars[-1]
            b[2], b[3], b[4], b[5] = max(b[2], hi), min(b[3], lo), z, b[5] + dv
        elif not bars or bars[-1][0] < m:
            op = bars[-1][4] if bars else (o or z)
            bars.append([m, op, max(op, hi), min(op, lo), z, dv])
    return sid


async def query(cli: httpx.AsyncClient, ids: list[str]) -> list[str]:
    ex = "|".join(f"{S.universe[i]['m']}_{i}.tw" for i in ids)
    # 以原始字串帶「|」，與證交所網頁本身的請求格式一致（不做 %7C 編碼）
    r = await cli.get(f"{MIS}?ex_ch={ex}&json=1&delay=0&_={int(time.time() * 1000)}")
    r.raise_for_status()
    j = r.json()
    rows = j.get("msgArray")
    if rows is None:
        raise RuntimeError(f"回應缺少 msgArray：{str(j)[:120]}")
    S.stale = 0
    got = [sid for sid in (ingest(x) for x in rows) if sid]
    t = now()
    if rows and not got and S.stale == len(rows) and (t.hour, t.minute) >= (9, 5):
        S.holiday = True  # 開盤 5 分鐘後整批仍是舊日期 → 今天休市
        log.info("今日休市（證交所回傳 %s 的資料）", rows[0].get("d"))
    return got


FORCE_OPEN = os.getenv("FORCE_OPEN") == "1"  # 測試用


def trading_window(t: datetime) -> bool:
    if FORCE_OPEN:
        return True
    return t.weekday() < 5 and (9, 0) <= (t.hour, t.minute) <= (13, 36)


# ───────────── 主輪詢迴圈 ─────────────
async def poller():
    bg = 0
    hot_q: deque[list[str]] = deque()
    last_hot = 0.0
    last_save = time.time()
    async with httpx.AsyncClient(timeout=10, headers=UA, follow_redirects=True, http2=False) as cli:
        while True:
            t = now()
            if t.strftime("%Y%m%d") != S.day:
                new_day(t.strftime("%Y%m%d"))
                if t.hour < 9:
                    await load_universe()  # 每天開盤前更新清單與前收價
            if not trading_window(t) or not S.universe or S.holiday:
                if S.universe and t.weekday() < 5 and (t.hour, t.minute) >= (13, 36) and time.time() - S.last_sync > 1800:
                    await offhours_sync(cli)  # 收盤後同步當日收盤報價，網站盤後也看得到最後價
                if time.time() - last_save > 60:
                    save_state(); last_save = time.time()
                await asyncio.sleep(15)
                continue
            if not hot_q and time.monotonic() - last_hot >= HOT_EVERY:
                hot = S.hot()
                hot_q.extend(hot[i:i + BATCH] for i in range(0, len(hot), BATCH))
                last_hot = time.monotonic()
            if hot_q:
                ids = hot_q.popleft()
            else:
                ids = S.order[bg:bg + BATCH]
                bg += BATCH
                if bg >= len(S.order):
                    bg = 0
                    S.cycle_seconds = round(time.time() - S.cycle_started)
                    S.cycle_started = time.time()
            try:
                changed = await query(cli, ids)
                S.ok += 1; S.last_ok = time.time()
                S.interval = max(SLOT, S.interval * 0.9)
                if changed:
                    await broadcast(changed)
            except Exception as e:  # noqa: BLE001
                S.err += 1
                S.last_error = f"{now():%H:%M:%S} {e}"[:200]
                S.interval = min(10.0, S.interval * 2)
                log.warning("證交所查詢失敗（間隔調為 %.1f 秒）：%s", S.interval, e)
                try:
                    await cli.get("https://mis.twse.com.tw/stock/index.jsp")  # 重新取得 session
                except Exception:  # noqa: BLE001
                    pass
            if time.time() - last_save > 60:
                save_state(); last_save = time.time()
            await asyncio.sleep(S.interval)


async def offhours_sync(cli: httpx.AsyncClient):
    """盤後全市場同步一輪；只接受今天日期的資料（週末、假日會自動略過）"""
    S.last_sync = time.time()
    got = 0
    for i in range(0, len(S.order), BATCH):
        try:
            got += len(await query(cli, S.order[i:i + BATCH]))
            S.ok += 1; S.last_ok = time.time()
        except Exception as e:  # noqa: BLE001
            S.err += 1
            S.last_error = f"{now():%H:%M:%S} {e}"[:200]
            log.warning("盤後同步失敗：%s", e)
            await asyncio.sleep(10)
        await asyncio.sleep(SLOT)
    S.holiday = False  # 盤後同步不影響隔日判斷
    log.info("盤後同步完成：%d 檔有今日報價", got)
    save_state()


def pack(sid: str) -> list:
    q = S.quotes.get(sid, {})
    return [q.get("z"), q.get("y"), q.get("v"), q.get("o"), q.get("h"), q.get("l"), q.get("t"), q.get("b"), q.get("a")]


async def broadcast(changed: list[str]):
    ch = set(changed)
    dead = []
    for ws, c in list(S.clients.items()):
        mine = [i for i in c["ids"] if i in ch]
        msg = {}
        if mine:
            msg["q"] = {i: pack(i) for i in mine}
        if c.get("chart") in ch and S.bars.get(c["chart"]):
            msg["bar"] = {"id": c["chart"], "b": S.bars[c["chart"]][-1]}
        if msg:
            try:
                await asyncio.wait_for(ws.send_json({"type": "tick", **msg}), 3)
            except Exception:  # noqa: BLE001
                dead.append(ws)
    for ws in dead:
        S.clients.pop(ws, None)


# ───────────── Web API ─────────────
app = FastAPI(title="台股即時行情中繼", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=ALLOW, allow_methods=["GET"], allow_headers=["*"])
hits: dict[str, deque] = defaultdict(deque)


def client_ip(req) -> str:
    fwd = req.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() if fwd else (req.client.host if req.client else "?")


@app.middleware("http")
async def limit(request: Request, call_next):
    ip, t = client_ip(request), time.time()
    dq = hits[ip]
    while dq and t - dq[0] > 60:
        dq.popleft()
    if len(dq) >= 120:
        return JSONResponse({"error": "請求太頻繁，請稍後再試"}, status_code=429)
    dq.append(t)
    return await call_next(request)


@app.on_event("startup")
async def startup():
    await load_universe()
    new_day(now().strftime("%Y%m%d"))
    asyncio.create_task(poller())


@app.on_event("shutdown")
async def shutdown():
    save_state()


def status_dict():
    t = now()
    return {"day": S.day, "trading": trading_window(t) and not S.holiday, "holiday": S.holiday,
            "universe": len(S.universe), "quotes": len(S.quotes), "bars": len(S.bars),
            "hot": len(S.hot()), "clients": len(S.clients), "ok": S.ok, "err": S.err,
            "last_ok": S.last_ok, "last_error": S.last_error, "last_sync": S.last_sync,
            "interval": round(S.interval, 2), "cycle_seconds": S.cycle_seconds,
            "server_time": t.isoformat()}


@app.get("/api/status")
async def api_status():
    return status_dict()


@app.get("/api/snapshot")
async def api_snapshot():
    return {"day": S.day, "t": S.last_ok, "q": {i: pack(i) for i in S.quotes}}


@app.get("/api/bars/{sid}")
async def api_bars(sid: str):
    return {"id": sid, "day": S.day, "bars": S.bars.get(sid, []), "q": pack(sid) if sid in S.quotes else None}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    origin = ws.headers.get("origin", "")
    if ALLOW and origin and origin not in ALLOW:
        await ws.close(code=1008); return
    ip = client_ip(ws)
    if sum(1 for c in S.clients.values() if c["ip"] == ip) >= WS_PER_IP:
        await ws.close(code=1013); return
    await ws.accept()
    S.clients[ws] = {"ids": set(), "chart": None, "ip": ip}
    try:
        await ws.send_json({"type": "hello", "status": status_dict()})
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("op") == "sub":
                ids = [str(i) for i in (msg.get("ids") or []) if str(i) in S.universe][:SUB_CAP]
                chart = str(msg.get("chart") or "") or None
                S.clients[ws].update({"ids": set(ids), "chart": chart if chart in S.universe else None})
                await ws.send_json({"type": "tick", "q": {i: pack(i) for i in ids if i in S.quotes}})
            elif msg.get("op") == "ping":
                await ws.send_json({"type": "pong", "status": status_dict()})
    except (WebSocketDisconnect, json.JSONDecodeError, RuntimeError):
        pass
    finally:
        S.clients.pop(ws, None)
