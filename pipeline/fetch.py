"""
台股策略篩選器 — 雲端資料管線（GitHub Actions 每個交易日自動執行）

資料來源優先順序（全部免 API Key、真實數據）：
  日 K       ① 證交所 OpenAPI STOCK_DAY_ALL（上市全市場，一次請求）
             ① 櫃買中心 OpenAPI tpex_mainboard_daily_close_quotes（上櫃全市場，一次請求）
             ② Yahoo Finance：只在「第一次建庫」或「中間漏抓交易日」時補歷史
  三大法人   證交所 rwd T86（可指定日期）、櫃買中心 OpenAPI tpex_3insti_daily_trading
  估值       證交所 BWIBBU_ALL、櫃買中心 tpex_mainboard_peratio_analysis
  月營收     證交所 t187ap05_L、櫃買中心 mopsfin_t187ap05_O
  產業別     證交所 ISIN 公開資料（上市、上櫃、ETF）

穩定性設計：
  - 歷史資料存在 repo 的 data 分支，每天只增量抓最新一日（官方一次請求涵蓋全市場）
  - 每個請求有重試與退避；任一輔助來源失敗只讓該欄位留空
  - 發布前驗證（檔數、日期），不合格就不覆蓋，網站維持上一版正確資料
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.getenv("DATA_FILE", ROOT / "docs" / "data" / "market.json"))
N_DAYS = int(os.getenv("N_DAYS", "140"))      # 網站保留交易日數（足夠 MA120）
MIN_STOCKS = int(os.getenv("MIN_STOCKS", "1500"))
TZ = timezone(timedelta(hours=8))
TWSE_OA = "https://openapi.twse.com.tw/v1"
TPEX_OA = "https://www.tpex.org.tw/openapi/v1"

S = requests.Session()
S.headers.update({"User-Agent": "Mozilla/5.0 (tw-strategy-screener; GitHub Actions)", "Accept": "application/json,text/html"})
status: dict[str, str] = {}


def log(*a):
    print(datetime.now(TZ).strftime("%H:%M:%S"), *a, flush=True)


def fetch(url, *, params=None, as_json=True, tries=4, wait=3.0):
    """帶重試與指數退避的 GET。"""
    for i in range(tries):
        try:
            r = S.get(url, params=params, timeout=40)
            r.raise_for_status()
            return r.json() if as_json else r
        except Exception as e:  # noqa: BLE001
            log(f"  重試 {i + 1}/{tries} {url.split('?')[0]}：{e}")
            time.sleep(wait * (2 ** i))
    return None


def num(x):
    if x is None:
        return None
    s = str(x).replace(",", "").replace("+", "").replace("X", "").strip()
    if s in ("", "--", "---", "----", "-", "N/A"):
        return None
    try:
        v = float(s)
        return None if pd.isna(v) else v
    except ValueError:
        return None


def roc(d: str) -> str:
    d = str(d).strip().replace("/", "")
    return f"{int(d[:-4]) + 1911:04d}-{d[-4:-2]}-{d[-2:]}"


# ───────────────────────── 1. 股票清單與產業別 ─────────────────────────
def universe() -> dict[str, dict]:
    uni: dict[str, dict] = {}
    for mode, mkt in ((2, "上市"), (4, "上櫃")):
        r = fetch(f"https://isin.twse.com.tw/isin/C_public.jsp?strMode={mode}", as_json=False)
        if r is None:
            continue
        r.encoding = "cp950"
        try:
            df = pd.read_html(io.StringIO(r.text), header=0)[0]
        except Exception as e:  # noqa: BLE001
            log(f"ISIN {mkt} 解析失敗：{e}"); continue
        df.columns = [str(c).strip() for c in df.columns]
        first = df.columns[0]
        for _, x in df.iterrows():
            cfi = str(x.get("CFICode", ""))
            is_stock, is_etf = cfi.startswith("ES"), cfi.startswith("CE")
            if not (is_stock or is_etf):
                continue
            parts = str(x[first]).replace("\u3000", " ").split()
            if len(parts) < 2:
                continue
            ind = str(x.get("產業別", "") or "").strip()
            if is_etf:
                ind = "ETF"
            elif not ind or ind == "nan":
                ind = "其他"
            uni[parts[0]] = {"id": parts[0], "name": parts[1], "mkt": mkt, "ind": ind}
    if len(uni) >= 1500:
        status["universe"] = f"證交所 ISIN 產業分類（{len(uni)} 檔，含 ETF）"
    else:
        status["universe"] = "ISIN 無法取得，改用 twstock 內建產業表"
        uni = {}
    return uni


def twstock_industry(code: str) -> str:
    try:
        import twstock
        info = twstock.codes.get(code)
        if info and info.group:
            return info.group
    except Exception:  # noqa: BLE001
        pass
    return "ETF" if code.startswith("00") else "其他"


# ───────────────────────── 2. 官方全市場當日行情 ─────────────────────────
def official_snapshot() -> tuple[dict, dict, dict]:
    """回傳 (bars: id -> (date, [o,h,l,c,v張]), names: id -> (name, mkt), 各市場資料日期)"""
    bars, names, mdates = {}, {}, {}
    rows = fetch(f"{TWSE_OA}/exchangeReport/STOCK_DAY_ALL") or []
    for r in rows:
        c = num(r.get("ClosingPrice"))
        code = str(r.get("Code", "")).strip()
        names[code] = (str(r.get("Name", "")).strip(), "上市")
        if not c:
            continue
        v = num(r.get("TradeVolume")) or 0
        bars[code] = (roc(r["Date"]), [num(r.get("OpeningPrice")) or c, num(r.get("HighestPrice")) or c,
                                       num(r.get("LowestPrice")) or c, c, round(v / 1000)])
        mdates["上市"] = max(mdates.get("上市", ""), bars[code][0])
    n1 = len(bars)
    rows = fetch(f"{TPEX_OA}/tpex_mainboard_daily_close_quotes") or []
    for r in rows:
        code = str(r.get("SecuritiesCompanyCode", "")).strip()
        c = num(r.get("Close"))
        names.setdefault(code, (str(r.get("CompanyName", "")).strip(), "上櫃"))
        if not c:
            continue
        v = num(r.get("TradingShares")) or 0
        bars[code] = (roc(r["Date"]), [num(r.get("Open")) or c, num(r.get("High")) or c,
                                       num(r.get("Low")) or c, c, round(v / 1000)])
        mdates["上櫃"] = max(mdates.get("上櫃", ""), bars[code][0])
    status["snapshot"] = (f"官方當日行情：上市 {n1} 檔（{mdates.get('上市', '無')}）、"
                          f"上櫃 {len(bars) - n1} 檔（{mdates.get('上櫃', '無')}）")
    log(status["snapshot"])
    return bars, names, mdates


def twse_day(day: str) -> dict:
    """證交所 rwd MI_INDEX：指定日期的上市全市場收盤行情（OpenAPI 尚未更新時補當日）。
    欄位：0 代號、2 成交股數、5 開、6 高、7 低、8 收。"""
    j = fetch("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX",
              params={"response": "json", "date": day.replace("-", ""), "type": "ALLBUT0999"}, tries=3)
    if not j or j.get("stat") != "OK":
        return {}
    table = next((t for t in j.get("tables") or [] if "每日收盤行情" in (t.get("title") or "")), None)
    out = {}
    for r in (table or {}).get("data") or []:
        if len(r) < 9:
            continue
        c = num(r[8])
        if not c:
            continue
        out[str(r[0]).strip()] = [num(r[5]) or c, num(r[6]) or c, num(r[7]) or c, c, round((num(r[2]) or 0) / 1000)]
    return out


# ───────────────────────── 3. 歷史補齊（Yahoo，只在需要時） ─────────────────────────
def yahoo_history(uni: dict, period: str) -> dict[str, dict[str, list]]:
    import yfinance as yf
    tick = {sid: sid + (".TW" if u["mkt"] == "上市" else ".TWO") for sid, u in uni.items()}
    ids, out = list(tick), {}
    for i in range(0, len(ids), 100):
        for attempt in range(3):  # 第 2、3 次只重抓缺漏的代號（Yahoo 偶發 401 Invalid Crumb）
            chunk = [x for x in ids[i:i + 100] if x not in out]
            if not chunk:
                break
            if attempt:
                time.sleep(10 * attempt)
            try:
                df = yf.download([tick[x] for x in chunk], period=period, interval="1d", group_by="ticker",
                                 auto_adjust=False, threads=True, progress=False, timeout=30)
            except Exception as e:  # noqa: BLE001
                log(f"  Yahoo 重試 {attempt + 1}：{e}"); continue
            if df is None or df.empty:
                continue
            _collect(df, chunk, tick, out)
        log(f"  Yahoo 歷史 {min(i + 100, len(ids))}/{len(ids)}（已取得 {len(out)}）")
        time.sleep(2)
    return out


def _collect(df, chunk, tick, out):
    """把 yf.download 結果整理成 {代號: {日期: [開, 高, 低, 收, 張]}}"""
    for sid in chunk:
        try:
            sub = df[tick[sid]] if isinstance(df.columns, pd.MultiIndex) else df
            sub = sub[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])
        except KeyError:
            continue
        rec = {}
        for ts, x in sub.iterrows():
            if not x["Volume"] or x["Volume"] <= 0:
                continue  # 排除 Yahoo 在休市日產生的空白列
            rec[pd.Timestamp(ts).strftime("%Y-%m-%d")] = [round(float(x["Open"]), 2), round(float(x["High"]), 2),
                                                          round(float(x["Low"]), 2), round(float(x["Close"]), 2),
                                                          round(float(x["Volume"]) / 1000)]
        if rec:
            out[sid] = rec


# ───────────────────────── 4. 三大法人 ─────────────────────────
def t86(day: str) -> dict:
    """證交所 T86（上市），可指定日期。欄位：0 代號、4 外陸資買賣超、7 外資自營商買賣超、10 投信、11 自營商。"""
    j = fetch("https://www.twse.com.tw/rwd/zh/fund/T86",
              params={"date": day.replace("-", ""), "selectType": "ALL", "response": "json"}, tries=3)
    if not j or j.get("stat") != "OK":
        return {}
    out, ok = {}, 0
    for r in j.get("data") or []:
        if len(r) < 19:
            continue
        fi = (num(r[4]) or 0) + (num(r[7]) or 0)
        it, dl, tot = (num(r[k]) or 0 for k in (10, 11, 18))
        ok += abs(fi + it + dl - tot) <= max(1000, abs(tot) * 0.01)  # 欄位位置自我檢查
        out[str(r[0]).strip()] = [round(fi / 1000), round(it / 1000), round(dl / 1000)]
    if not out or ok < len(out) * 0.9:
        log(f"  T86 {day} 欄位檢查未通過，捨棄")
        return {}
    return out


def tpex_inst_latest() -> tuple[str | None, dict]:
    rows = fetch(f"{TPEX_OA}/tpex_3insti_daily_trading") or []
    out, d = {}, None
    for r in rows:
        code = str(r.get("SecuritiesCompanyCode", "")).strip()
        if r.get("Date") and not d:
            d = roc(r["Date"])
        out[code] = [round((num(r.get("ForeignInvestorsInclude MainlandAreaInvestors-Difference")) or 0) / 1000),
                     round((num(r.get("SecuritiesInvestmentTrustCompanies-Difference")) or 0) / 1000),
                     round((num(r.get("Dealers-Difference")) or 0) / 1000)]
    return d, out


def tpex_inst_history(day: str) -> dict:
    """櫃買中心舊版日報（可指定日期），僅用於首次建庫的歷史回補；失敗不影響主流程。"""
    y, m, d = day.split("-")
    j = fetch("https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php",
              params={"l": "zh-tw", "se": "EW", "t": "D", "d": f"{int(y) - 1911}/{m}/{d}", "o": "json"}, tries=2, wait=2)
    rows = (j or {}).get("aaData") or ((j or {}).get("tables") or [{}])[0].get("data") or []
    out, ok = {}, 0
    for r in rows:
        if len(r) < 24:
            continue
        fi, it, dl, tot = (num(r[k]) or 0 for k in (10, 13, 22, 23))
        ok += abs(fi + it + dl - tot) <= max(1000, abs(tot) * 0.01)  # 欄位位置自我檢查
        out[str(r[0]).strip()] = [round(fi / 1000), round(it / 1000), round(dl / 1000)]
    if not out or ok < len(out) * 0.9:
        return {}  # 欄位對不上就整日捨棄，寧缺勿錯
    return out


# ───────────────────────── 5. 估值與月營收（最新一期） ─────────────────────────
def fundamentals() -> dict:
    out: dict[str, dict] = {}
    val1 = fetch(f"{TWSE_OA}/exchangeReport/BWIBBU_ALL") or []
    for r in val1:
        out.setdefault(str(r.get("Code", "")).strip(), {}).update(
            {"per": num(r.get("PEratio")), "pbr": num(r.get("PBratio")), "dy": num(r.get("DividendYield"))})
    val2 = fetch(f"{TPEX_OA}/tpex_mainboard_peratio_analysis") or []
    for r in val2:
        out.setdefault(str(r.get("SecuritiesCompanyCode", "")).strip(), {}).update(
            {"per": num(r.get("PriceEarningRatio")), "pbr": num(r.get("PriceBookRatio")),
             "dy": num(r.get("YieldRatio", r.get("DividendYield")))})
    rev = (fetch(f"{TWSE_OA}/opendata/t187ap05_L") or []) + (fetch(f"{TPEX_OA}/mopsfin_t187ap05_O", tries=2) or [])
    for r in rev:
        kc = next((k for k in r if "公司代號" in k), None)
        ky = next((k for k in r if "去年同月增減" in k), None)
        km = next((k for k in r if "上月比較增減" in k), None)
        if kc:
            out.setdefault(str(r[kc]).strip(), {}).update({"yoy": num(r.get(ky)), "mom": num(r.get(km))})
    status["fundamentals"] = f"估值：上市 {len(val1)}、上櫃 {len(val2)} 筆；月營收 {len(rev)} 筆"
    return out


# ───────────────────────── 6. 讀寫資料庫 ─────────────────────────
def load_store():
    bars: dict[str, dict[str, list]] = {}
    inst: dict[str, dict[str, list]] = {}
    if not DATA.exists():
        return bars, inst
    try:
        j = json.loads(DATA.read_text("utf-8"))
        dates = j["dates"]
        for s in j["stocks"]:
            b = bars.setdefault(s["id"], {})
            for k, d in enumerate(dates):
                if s["c"][k] is not None and s.get("v", [None] * len(dates))[k] is not None:
                    b[d] = [s["o"][k], s["h"][k], s["l"][k], s["c"][k], s["v"][k]]
                if any(s.get(x) and s[x][k] is not None for x in ("fi", "it", "dl")):
                    inst.setdefault(s["id"], {})[d] = [(s.get(x) or [None] * len(dates))[k] for x in ("fi", "it", "dl")]
        log(f"讀取既有資料庫：{len(bars)} 檔、{len(dates)} 日（最後 {dates[-1]}）")
    except Exception as e:  # noqa: BLE001
        log(f"既有資料庫無法讀取，將重建：{e}")
    return bars, inst


def coverage(bars, uni) -> dict[str, dict[str, float]]:
    """各市場每日有真實 K 棒的比例：{市場: {日期: 比例}}"""
    cnt: dict[str, dict[str, int]] = {}
    for sid, b in bars.items():
        m = uni.get(sid, {}).get("mkt")
        if not m:
            continue
        c = cnt.setdefault(m, {})
        for d in b:
            c[d] = c.get(d, 0) + 1
    out = {}
    for m, c in cnt.items():
        top = max(c.values())
        out[m] = {d: n / top for d, n in c.items()}
    return out


def trading_days(bars, uni) -> list[str]:
    days = set()
    for c in coverage(bars, uni).values():
        days |= {d for d, r in c.items() if r >= 0.5}
    return sorted(days)


def complete_day(bars, uni) -> str | None:
    """上市、上櫃都有 ≥80% 股票具真實 K 棒的最新一日"""
    cov = coverage(bars, uni)
    if len(cov) < 2:
        return None
    common = set.intersection(*[{d for d, r in c.items() if r >= 0.8} for c in cov.values()])
    return max(common) if common else None


def main() -> int:
    uni = universe()
    bars, inst = load_store()
    snap, names, mdates = official_snapshot()
    if len(snap) < 1500:
        log("官方當日行情不完整，稍後重試；本次不更新。")
        return 1

    # 若 ISIN 失敗：以官方行情清單建立股票池（4 碼普通股 + 00 開頭 ETF）
    if not uni:
        for code, (nm, mkt) in names.items():
            if (len(code) == 4 and code.isdigit()) or (code.startswith("00") and len(code) <= 6):
                uni[code] = {"id": code, "name": nm, "mkt": mkt, "ind": twstock_industry(code)}
    for code, (nm, _) in names.items():  # 名稱以官方行情為準
        if code in uni and nm:
            uni[code]["name"] = nm
    ub = lambda: {k: v for k, v in bars.items() if k in uni}  # noqa: E731

    target = max(mdates.values())  # 官方已公布的最新交易日（兩市場可能不同步）
    known = trading_days(ub(), uni)
    need = None
    if len(known) < 60:
        need = "1y"
    else:
        last = date.fromisoformat(known[-1])
        biz = sum(1 for i in range(1, (date.fromisoformat(target) - last).days) if (last + timedelta(i)).weekday() < 5)
        if biz > 0:
            need = "6mo" if biz > 40 else "3mo"
    if need:
        log(f"補抓歷史（Yahoo, {need}）…")
        yh = yahoo_history(uni, need)
        added = 0
        for sid, rec in yh.items():
            b = bars.setdefault(sid, {})
            for d, bar in rec.items():
                if d not in b and d <= target:
                    b[d] = bar; added += 1
        status["history"] = f"Yahoo 補歷史 {len(yh)} 檔、{added} 筆（{need}）"
    else:
        status["history"] = "無缺漏，僅增量更新"

    for sid, (d, bar) in snap.items():  # 官方當日行情覆蓋
        if sid in uni:
            bars.setdefault(sid, {})[d] = bar

    # 某市場 OpenAPI 尚未更新到最新交易日：上市用證交所指定日期端點補，上櫃用 Yahoo 補
    def pending(m):
        start = date.fromisoformat(mdates.get(m) or (known[-1] if known else target))
        end = date.fromisoformat(target)
        return [(start + timedelta(i)).isoformat() for i in range(1, (end - start).days + 1)
                if (start + timedelta(i)).weekday() < 5]
    fill = []
    for d in pending("上市"):
        got = twse_day(d); time.sleep(2.2)
        for sid, bar in got.items():
            if sid in uni:
                bars.setdefault(sid, {})[d] = bar
        fill.append(f"上市 {d}：MI_INDEX {len(got)} 檔")
    otc_days = pending("上櫃")
    if otc_days:
        yh = yahoo_history({k: v for k, v in uni.items() if v["mkt"] == "上櫃"}, "1mo")
        n = 0
        for sid, rec in yh.items():
            for d in otc_days:
                if d in rec and d not in bars.setdefault(sid, {}):
                    bars[sid][d] = rec[d]; n += 1
        fill.append(f"上櫃 {','.join(otc_days)}：Yahoo 補 {n} 筆")
    if fill:
        status["lag_fill"] = "；".join(fill)
        log("補齊落後市場：" + status["lag_fill"])

    pub = complete_day(ub(), uni)  # 兩市場都完整的最新一日
    if not pub:
        log("找不到上市、上櫃皆完整的交易日；本次不更新。")
        return 1
    if pub < target:
        status["lag"] = f"{target} 尚有市場資料不完整，本次發布至 {pub}"
        log(status["lag"])
    days = [d for d in trading_days(ub(), uni) if d <= pub][-N_DAYS:]
    log(f"交易日 {days[0]} ～ {days[-1]}（{len(days)} 日）")

    # 三大法人：上市逐日補 T86；上櫃用 OpenAPI 最新一日，缺的歷史嘗試舊版日報
    n_t = n_o = 0; tpex_ok = True
    d_o, latest_o = tpex_inst_latest()
    if latest_o:
        for sid, v in latest_o.items():
            inst.setdefault(sid, {})[d_o or mdates.get("上櫃", target)] = v
    listed = [s for s, u in uni.items() if u["mkt"] == "上市"]
    otc = [s for s, u in uni.items() if u["mkt"] == "上櫃"]
    for d in days:
        if sum(1 for s in listed[:300] if d in inst.get(s, {})) < 150:
            got = t86(d); time.sleep(2.2)
            for sid, v in got.items():
                inst.setdefault(sid, {})[d] = v
            n_t += bool(got)
        if tpex_ok and sum(1 for s in otc[:300] if d in inst.get(s, {})) < 150:
            got = tpex_inst_history(d); time.sleep(2.2)
            if not got and n_o == 0 and d == days[0]:
                tpex_ok = False  # 舊版端點不可用就停止嘗試，改由每日 OpenAPI 累積
            for sid, v in got.items():
                inst.setdefault(sid, {})[d] = v
            n_o += bool(got)
    status["inst"] = f"上市 T86 本次補 {n_t} 日；上櫃 OpenAPI 最新日 {len(latest_o)} 檔、歷史補 {n_o} 日"

    fund = fundamentals()

    # 組合輸出
    out = []
    for sid, u in uni.items():
        b = bars.get(sid, {})
        if days[-1] not in b and sum(1 for d in days[-5:] if d in b) == 0:
            continue  # 近 5 日無成交（下市、長期停牌）
        o, h, l, c, v = [], [], [], [], []
        prev = None
        for d in days:
            bar = b.get(d)
            if bar:
                prev = bar[3]
                o.append(bar[0]); h.append(bar[1]); l.append(bar[2]); c.append(bar[3]); v.append(bar[4])
            else:  # 未交易日：沿用前收、量 0；上市前為 null
                o.append(prev); h.append(prev); l.append(prev); c.append(prev); v.append(0 if prev else None)
        if sum(x is not None for x in c) < 5:
            continue
        rec = {**u, "o": o, "h": h, "l": l, "c": c, "v": v}
        ins = inst.get(sid, {})
        if ins:
            for j, k in enumerate(("fi", "it", "dl")):
                rec[k] = [ins[d][j] if d in ins else None for d in days]
        rec.update({k: val for k, val in fund.get(sid, {}).items() if val is not None})
        out.append(rec)

    # 發布前驗證
    fresh = sum(1 for s in out if s["c"][-1] is not None and s["v"][-1])
    if len(out) < MIN_STOCKS or (date.fromisoformat(target) - date.fromisoformat(days[-1])).days > 7:
        log(f"驗證失敗：{len(out)} 檔、最後日 {days[-1]} vs 官方 {target}；不覆蓋舊資料。")
        return 1
    meta = {
        "updated": datetime.now(TZ).strftime("%Y/%m/%d %H:%M"),
        "last_trading_day": days[-1].replace("-", "/"),
        "count": len(out), "traded_today": fresh,
        "industries": len({s["ind"] for s in out}),
        "sources": status,
        "note": "日 K 為官方未還原股價；成交量與法人買賣超單位為張。",
    }
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps({"meta": meta, "dates": days, "stocks": out}, ensure_ascii=False, separators=(",", ":")), "utf-8")
    (DATA.parent / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
    log(f"完成：{len(out)} 檔 × {len(days)} 日，{DATA.stat().st_size / 1e6:.1f} MB")
    log(json.dumps(status, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
