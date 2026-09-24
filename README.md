# 台股策略篩選器

全市場台股（上市、上櫃、ETF）× 全產業板塊 × 自訂技術／籌碼／基本面條件，篩選標的並回測進出場規則。
全程在雲端運作：**GitHub Actions 每個交易日自動抓官方盤後資料 → GitHub Pages 發布網站**，任何人打開網址即可使用，不需安裝、不需本機伺服器。

## 架構

```
證交所 / 櫃買中心 官方 OpenAPI ──┐
                                 ├─► GitHub Actions（每日 18:00、21:30）──► data 分支（資料庫）
Yahoo Finance（僅補歷史缺口）────┘                │
                                                  └─► GitHub Pages 網站（CDN）──► 使用者瀏覽器
                                                        備援：jsDelivr CDN 讀 data 分支
```

- 使用者瀏覽網站時**不會直接連資料來源**，只讀取 CDN 上的靜態檔，不受來源限流影響。
- 每天只增量抓最新一日（官方一次請求涵蓋全市場），連線負擔極小。
- 發布前驗證檔數與日期，不合格就不覆蓋，網站維持上一版正確資料，下個排程自動重試。

## 部署（全部在 GitHub 網頁上完成）

1. 登入 GitHub → 右上角「+」→ **New repository**，名稱例如 `tw-screener`，設為 **Public**，建立。
2. 在 repo 頁面點 **Add file → Upload files**，把解壓縮後的所有檔案與資料夾拖進去，按 **Commit changes**。
   - 若 `.github/workflows/update.yml` 沒被上傳（部分系統會隱藏以 `.` 開頭的資料夾）：點 **Add file → Create new file**，檔名輸入 `.github/workflows/update.yml`，貼上該檔內容後 Commit。
3. **Settings → Pages**：Source 選 **GitHub Actions**。
4. **Settings → Actions → General**：最下方 Workflow permissions 選 **Read and write permissions**，儲存。
5. **Actions** 分頁 → 左側「每日更新台股資料並發布網站」→ **Run workflow**。首次建庫約 20–40 分鐘。
6. 完成後網址為 `https://你的帳號.github.io/tw-screener/`。

之後每個交易日 18:00 與 21:30（台灣時間）自動更新，無需任何操作。

## 資料來源

| 項目 | 來源 | 頻率 |
|---|---|---|
| 股票清單、產業別 | 證交所 ISIN 公開資料（上市、上櫃、ETF） | 每日 |
| 日 K（開高低收量） | 證交所 `STOCK_DAY_ALL`、櫃買中心 `tpex_mainboard_daily_close_quotes` | 每日增量 |
| 歷史 K 線補齊 | Yahoo Finance（只在首次建庫或漏抓時使用） | 需要時 |
| 三大法人 | 證交所 `rwd/zh/fund/T86`（可回補歷史）、櫃買中心 `tpex_3insti_daily_trading` | 每日 |
| 本益比、淨值比、殖利率 | 證交所 `BWIBBU_ALL`、櫃買中心 `tpex_mainboard_peratio_analysis` | 每日 |
| 月營收 | 證交所 `t187ap05_L`、櫃買中心 `mopsfin_t187ap05_O` | 每日檢查 |

## 網站功能

- 板塊篩選：市場、產業（證交所分類）、自選板塊（自訂族群，例如散熱、CPO）、成交量與股價門檻、代號搜尋
- 策略編輯：選股／進場／出場三組條件，AND／OR，支援「近 N 日內曾成立」「連續 N 日成立」
- 指標：價格、均線、動能（KD、RSI、MACD、威廉）、波動（布林、ATR、乖離）、成交量（量比、OBV）、K 線型態、三大法人、估值與月營收
- 回測：訊號收盤成立、隔日開盤成交，含手續費與證交稅、停損停利、最長持有天數
- 板塊統計、個股 K 線圖與買賣點、今日條件逐項檢查、CSV 下載
- 策略存在瀏覽器；可匯出／匯入 JSON，或複製分享連結給別人一鍵套用

## 已知限制

- 股價為官方未還原價，除權息當日指標可能出現跳空。
- 上櫃三大法人的歷史回補使用櫃買中心舊版日報，若該端點停用，會改為從部署日起每日累積。
- GitHub 會在公開 repo 連續 60 天沒有活動時暫停排程，並寄信通知；到 Actions 頁面按一下 Enable 即可恢復。
- 目前為盤後資料；盤中即時報價列為下一階段。

本站為技術研究工具，不構成任何投資建議。
