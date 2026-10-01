# HBR 廣告版位 Media Kit

給業務／客戶看的 hbrtaiwan.com 廣告版位展示。

## 結構
- `index.dc.html` — 展示介面（頁面切換、桌機／手機、版位尺寸切換、素材上傳、規格總表）
- `support.js` — `index.dc.html` 的執行環境，需與其放在同一層
- `hbr/*.html` — 各頁靜態快照（首頁、最新、文章頁、雜誌、影音、Podcast）
- `hbr/hbr_assets/ad-slots.json` — 版位與可用尺寸設定（改尺寸改這裡）
- `hbr/hbr_assets/css|fonts|media` — 快照用的樣式、字型、圖片
- `hbr/hbr_assets/capture.mjs` — 原始快照擷取腳本

## 執行
需透過本機 HTTP server 開啟（直接雙擊檔案會擋 fetch / iframe）：

```
npx serve .
# 或
python3 -m http.server
```

再開啟 `http://localhost:<port>/index.dc.html`。

## 待後端確認
- 文章內廣告 GAM Ad Unit、250 字門檻與則數上限
- 假文章／假影片需由 API 回傳
- 頂部區塊 `.nav-outside` 固定高度（280px／146px）需改為依廣告實際高度計算
