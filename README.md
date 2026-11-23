# 鄰近健康｜行銷社群系統（PRD v0.3 第一版）

供同仁使用的 RWD 私有後台，用來管理日常營運與專案檔期的內容、廣告、合作與成果。視覺沿用鄰近健康色碼表。

## 部署到 Vercel

架構：Vercel（網站＋API＋每日 Cron）＋ Turso（雲端 SQLite 資料庫）。附件存在資料庫內，只能透過有權限檢查的 API 下載。

### 1. 建立資料庫（Turso）
- 在 Vercel 專案的 **Storage → Marketplace → Turso** 新增資料庫，Vercel 會自動填好 `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`
- 區域選 **Tokyo（ap-northeast-1）**，與 `vercel.json` 的函式區域 `hnd1` 一致，台灣連線最快
- 測試環境和正式環境各建一個資料庫（Preview 與 Production 環境變數分開設定）

### 2. 匯入專案
把這個資料夾推到公司的私人 GitHub repo，在 vercel.com/new 匯入。不用設定 Build Command，Vercel 會自動偵測 Express。

### 3. 環境變數（Settings → Environment Variables）

| 變數 | 說明 |
|---|---|
| `APP_SECRET` | **必填**，40 字元以上亂數，加密 LINE／Meta 憑證。遺失後須重新授權 |
| `CRON_SECRET` | **必填**，亂數字串。Vercel Cron 會自動帶上，用來驗證每日同步請求 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | 第一次啟動建立的管理員（登入後會要求改密碼） |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | 由 Turso 整合自動填入 |
| `PUBLIC_URL` | 正式網址，例如 `https://mkt.neartohealth.com`（Meta 授權回呼用） |
| `META_APP_ID` / `META_APP_SECRET` | Meta App；回呼網址設為 `PUBLIC_URL/api/oauth/meta/callback` |

亂數可用 `openssl rand -hex 32` 產生。

### 4. 部署後
1. 開網址，用 `ADMIN_EMAIL` 登入並改密碼
2. 到「帳號與權限」幫同仁建帳號
3. 到「平台串接」設定 LINE Token、Meta 授權

### Vercel 上的注意事項
- **方案**：Vercel 免費的 Hobby 方案限個人、非商業用途；公司內部系統請用 **Pro 方案**
- **每日同步**：`vercel.json` 設定 UTC 22:00 = 台灣時間 06:00。Hobby 方案的 Cron 會在該小時內任一時間觸發；要改時刻需改 `vercel.json` 並重新部署
- **附件上限 3MB**（Vercel 單一請求上限）。設計稿、影片請用 Canva／Google Drive 連結欄位
- 資料庫備份：Turso 有時間點還原；另建議定期從後台各頁「匯出 CSV」留存

## 本機開發

需求：Node.js 20 以上。沒設 `TURSO_DATABASE_URL` 時會自動用本機檔案 `data/app.db`。

```bash
npm install
ADMIN_EMAIL=你的Email ADMIN_PASSWORD=Temp12345a npm start
# 開啟 http://localhost:3000
```

`npm start` 也可以直接部署在一般主機（VPS、Zeabur、Render），這時每日同步由內建排程執行，時刻可在後台調整。

## 角色權限（所有規則都在伺服器端檢查）

| 角色 | 能做什麼 |
|---|---|
| 管理員 | 所有資料、帳號與授權、核准、指派、匯入、平台串接 |
| 老闆級 | 全部唯讀，包含財務與合作資料（寄送地址、私人聯絡除外） |
| 外部投手 | 只讀「指定專案」中已核准的內容，以及該專案的廣告、成效、財務與合作資料 |
| 小編 | 建立草稿、編輯指派給自己的項目、送審、留言、回填被指派的成果；看不到財務欄位 |
| 客服 | FAQ 與話術、Blog／LINE OA 草稿與協作、回填被指派的成果 |

- 寄送地址與私人聯絡方式：只有管理員和該合作的負責人看得到
- 頁面、API、附件下載、CSV 匯出都套用同一套角色、專案與欄位規則
- 停用帳號、改角色、改專案範圍、重設密碼後，該帳號既有的登入會立即失效
- 帳號、權限、核准、匯入、匯出、附件下載都會留紀錄（後台「操作紀錄」）

## 功能對照 PRD

| 工作包 | 狀態 |
|---|---|
| P0-01 基礎架構（RWD、台灣時區、空白啟用） | ✅ 360px 手機可操作表單；平板／桌機有月曆與報表 |
| P0-02 帳密與權限 | ✅ 個人帳號、臨時密碼強制更改、重設、停用、專案範圍、欄位遮蔽 |
| P0-03 內容協作 | ✅ 首頁四區塊、行事曆篩選、專案、指派、版本紀錄、素材交付、送審／退修／核准；核准後改對外欄位自動退回待審 |
| P0-04 渠道與合作 | ✅ FB／IG／Threads、LINE OA、SHOPLINE Blog、廣告三層＋A/B、合作交付、素材使用權（未確認或到期不可選用；UGC 原檔驗收後自動結案） |
| P0-05 成果與報表 | ✅ 成果指派與回填、CSV 預覽／錯誤列／去重、週趨勢、CPC 與成果成本、零分母顯示「—」、日預算不重複加總 |
| P1-01 平台授權與同步 | 🟡 已有 LINE Token 測試與加密保存、Meta 官方授權流程、每日排程、手動補同步、部分失敗隔離、同步紀錄。**需用公司正式資產測試後定案**：執行時刻、重抓天數、可讀欄位、Meta 預算幣別換算 |
| P1-02 擴充資料來源 | ⏳ FB／IG／Threads 自然成效、Search Console、GA4 尚未串接（目前以手動或 CSV 回填） |
| P2 發布自動化 | ⏳ 未開始（第一階段推播、發文沿用原平台） |

## 驗收測試

```bash
rm -rf data   # 用空白的本機資料庫測
ADMIN_EMAIL=admin@nth.tw ADMIN_PASSWORD=Admin12345a PORT=3100 npm start &
BASE=http://localhost:3100 npm test
```

包含 PRD 的三條首輪驗收流程（日常長照文章、展會專案、商品互惠）與權限隔離，共 59 項檢查。

## 程式結構

```
server/schema.js    資料模型與角色權限表（要新增欄位改這裡，重啟後自動補欄位）
server/access.js    列層級、欄位層級權限
index.js            Vercel 進入點
vercel.json         Vercel 區域與每日 Cron
server/db.js        資料庫（Turso／本機 SQLite），啟動時自動建表補欄位
server/server.js    API、內容流程、匯入匯出、附件、帳號、平台串接
server/metrics.js   儀表板統計口徑
server/sync.js      LINE／Meta 每日同步
public/             前端（原生 JS，無建置步驟）
test/acceptance.js  驗收測試
```

## 上線前待辦

1. 升級 Vercel Pro、建立測試與正式兩個 Turso 資料庫、設定環境變數與自訂網域
2. 建立 Meta App、完成商家驗證，取得 `ads_read` 權限
3. 用公司 LINE OA 與廣告帳號實測同步欄位，確認每日執行時刻與重抓天數
4. 匯入既有成果與合作資料（後台「資料匯入」有範本可下載）
