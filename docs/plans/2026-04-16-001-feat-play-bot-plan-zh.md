---
title: Play Bot — 伺服器控制的 NPC 玩家（中文版）
type: feat
status: active
date: 2026-04-16
origin: docs/brainstorms/2026-04-16-play-bot-requirements.md
mirrors: docs/plans/2026-04-16-001-feat-play-bot-plan.md
deepened: 2026-04-16
---

# Play Bot — 伺服器控制的 NPC 玩家

> 這份是英文 plan 的中文摘要版。完整技術細節以英文版為準（檔案路徑在 frontmatter `mirrors`）；本文保留所有關鍵決策、實作單元結構、風險與驗收標準。

## 概覽

引入伺服器控制的 bot 帳戶，在真人少時填補板面活動。Bot 和真人共用 schema（以 `role='bot'` 區分），不使用道具與 megaspeaker，由後端內嵌的 goroutine scheduler 依當前真人 WS 連線數動態調整活躍 bot 數量。

不另建貨幣、不做 sweep — bot 餘額靠 play-first 扣款 + house edge 自然流失。完整營運控制透過 `admin bot` CLI 與 `.agents/skills/play-bot-admin/` 提供，讓 AI agent 可用自然語言操作。

## 問題定義

真人少時共享板面停滯：coin 密度低 → pusher amplitude 降低 → cascade 罕見 → 無 heat 競爭 → 5% 保底成為主要 reward 來源 → 側出口門檻（10 coin）達不到。新玩家進入時體驗接近單機，影響首 session 留存與長期轉換。

## 目標驗收標準對應

（14 項來自 origin requirements doc）

| # | 成功標準 | 對應單元 |
|---|---|---|
| R1 | 0 真人時板面仍有 bot 投幣活動 | Unit 5 |
| R2 | 真人看到的 player list / heat 廣播含 bot 身份 | Units 3, 5 |
| R3 | Client 側所有 API/WS shape 無 bot 專屬欄位 | 所有 unit 共同維護 |
| R4 | RTP 報表自動排除 `role='bot'` | Unit 7 |
| R5 | House liability 報表自動排除 `role='bot'` | Unit 7 |
| R6 | Bot 投幣/獎勵寫入 `accounting_logs` | Unit 5 |
| R7 | 補幣走 `ActionBotRefill` action type | Unit 2 |
| R8 | Admin CLI 功能完整 | Unit 6 |
| R9 | Kill switch 傳播 ≤ 30s | Unit 5 |
| R10 | 每日 cap 達到停止補幣 + error log | Unit 5 |
| R11 | Bot 排除在 5% 保底之外 | Unit 3 |
| R12 | `provider_type='bot'` 登入被拒 | Unit 4 |
| R13 | Prometheus metrics 齊全 | Unit 5 |
| R14 | `.agents/skills/play-bot-admin/SKILL.md` 存在可用 | Unit 8 |

## 範圍界線

**刻意不做（v1 non-goals）：**
- 向用戶揭露 bot（不做 disclosure UI；真錢模式上線前重新評估）
- Bot 不用道具 / 不消耗 scroll
- Bot 不發 megaspeaker 訊息
- Bot 不讀板面狀態 / heat 池做「聰明」決策
- 不做 ML / adaptive 行為
- 不引入獨立 bot 貨幣（shadow balance）
- 不做 sweep job（play-first + house edge 自然解決）
- 不做 HTTP admin 端點（CLI 夠用）
- 不做 `bot_sessions` 表（需要時從 ledger 推算）

## 參照現有 Patterns

- **Core module 結構** → 鏡射 `backend/business/core/accounting/`（bot.go / model.go / storer.go / bot_test.go + stores/botdb/botdb.go），tx-capable core 模式
- **投幣權威路徑** → `game.Core.ProcessBatchInsert`（非 `accounting.ProcessGameInsert` 直接調用），包含零值檢查與結果包裝
- **OutboxWriter 組法** → 鏡射 `backend/business/web/ws/handler.go:694-705` 的 closure（`EncodeBatchInsertPayload(userID.String(), slotID, accepted, refKey)` + `TopicBatchInsert(room)`），room 硬編碼 `"main"`
- **Heat engine** → `backend/business/core/heat/heat.go`，5% 保底在 `GetShares`（~行 103）與 `GetShareForUser`（~行 139）。Heat 由 handler 在 `ProcessGameInsert` 後另外加（`handler.go:721`），scheduler 需比照：成功投幣後呼叫 `heatEngine.AddHeatForBot(accountID, amount)`
- **Goroutine lifecycle** → 鏡射 outbox drainer pattern（`api/main.go:281-295, 1077-1079`）：ctx+WaitGroup，shutdown 順序 cancel → Wait → DB close
- **Admin CLI 子指令** → 鏡射 `backend/app/tooling/admin/dlq.go:22-53` 的 switch 分派
- **Metrics** → `backend/foundation/metrics/metrics.go` 用 `promauto` + 套裝 WorkerRuns/WorkerDuration/WorkerErrors 標記 `"bot_scheduler"`
- **Schema** → 單一 `backend/zarf/docker/database/schema.sql`（冪等 `CREATE TABLE IF NOT EXISTS`），沒有版本化 migration

## 機構學習

主要來自 `docs/solutions/integration-issues/batch-insert-outbox-2026-04-14.md`（交易式 outbox 回顧）：

- **Outbox 對 game-facing insert 是強制的** — bypass 就是扣餘額但不噴幣。Bot scheduler **必須**用 OutboxWriter
- **Graceful shutdown 是 payment-critical** — ctx+WaitGroup；順序 cancel → Wait → DB close
- **Always-on workers，flag 只擋新工作** — kill switch 不停 scheduler goroutine，只阻止新動作
- **Reference-ID dedup 是 per-instance in-memory 的 10k FIFO** — bot refKey 前綴 `bot:` 必須獨特、非空
- **Integration test 隱形** — `//go:build integration` 預設不跑，要補 CI
- **Admin CLI 同 PR 交付**（P1 教訓，不可延後）

## 關鍵技術決策（跨 unit 總覽）

1. **Goroutine pattern**：ctx + WaitGroup（非 channel-only）。Bot 寫 ledger + outbox；mid-tick 取消要乾淨。
2. **Single-instance 守護**：scheduler 啟動時 `pg_try_advisory_lock(bot_scheduler_lock_id)`；拿不到鎖就跳過 scheduler（API 仍運行）。防止雙 replica 同時投幣。DB 連線關閉時鎖自動釋放。
3. **Tick 週期**：5s。在 kill-switch 響應性與 CPU 負擔之間取平衡。
4. **Config hot-reload**：記憶體快取 5s TTL + DB 為真相來源。Admin CLI 寫入 `bot_config` 表，scheduler 下一個 tick 讀取。無需 SIGHUP。
5. **真人數計算**：`hub.Count() - hub.SpectatorCount()`。Bot 永遠不走 WS（Unit 4 擋下），不需在 Connection 加 role 欄位。
6. **Hysteresis**：EMA（alpha=0.1）追 realPlayerCount，`target = floor(ema)` 經 `crowd_scale` 對照。避免「12 次連續觀察」的卡死問題。
7. **Session 模型**：每隻 bot in-memory 狀態 `{online, sessionEndsAt, nextActionAt}`。
8. **重啟暖機**：開機時 bot 的 `offlineUntil` 均勻散布在 5-15min 窗口，避免冷啟動一瞬間全上線。
9. **Reference ID 格式**：投幣 `bot:<account_id>:<unix_nano>`；補幣 `bot-refill:<account_id>:<yyyymmddUTC>`（UTC 日桶保證冪等）。相同 tick 內若有碰撞則追加 `:<bot_index>`。
10. **OutboxWriter 跨 package 引用**：`bot` → `ws` 的引用若在 `go list -deps` 顯示 cycle，則將 `EncodeBatchInsertPayload` + `TopicBatchInsert` 搬到 `backend/business/web/wsproto/`（約 30 行 refactor）。預設直接引用，遇到 cycle 再 refactor。
11. **Heat `IsBot` 語意 last-write-wins**：`AddHeat` 每次 reset false；`AddHeatForBot` 每次 reset true。**不** sticky — 避免 (a) Prune 後 flag 遺失、(b) 真人被誤標後永久失去 5% 保底。
12. **Login 拒絕兩層**：
    - `user.FindOrCreate` / `FindOrCreateWithMeta` 拒絕 `provider_type='bot'`（create 與 lookup 兩條路徑都擋）
    - `VerifyWalletLogin` 在 `QueryByProvider` 回傳後檢查 `role='bot'` 就拒絕（擋掉「bot 的 hex provider_uid 剛好等於某真人錢包地址」攻擊）
    - HTTP `Login` handler 早期拒絕（縱深防禦）
13. **JWT middleware 擋 `role='bot'` token**：`Authenticate` 拒絕任何 `claims.Role == "bot"` 的 JWT。一行防線，擋掉所有 bot JWT 濫用。
14. **`setRole` CLI 不接受 `"bot"`**：bot 帳戶只能透過 `admin bot seed` 建立，不走泛用 role 提升指令。
15. **Admin CLI 與 AI skill 同 PR ship**，不延後。

## 已解決的規劃問題

- Tick 週期：5 秒
- Hysteresis：EMA alpha=0.1
- Config reload：per-tick 重讀 + 5s 記憶體 TTL
- 20 隻 bot display_name 唯一性：8 隻從命名池分配、12 隻 `display_name=NULL` 配合 `provider_type='bot'` + 不同隨機 `provider_uid`
- Insert 失敗處理：silent skip + `bot_insert_failure_total` 計數；下 tick 重試；recover() 的 panic 不推進 `nextActionAt` 避免 metric drift
- 測試注入：Scheduler 接 `Clock`, `*rand.Rand`（stdlib，測試時 seed 固定）, `PlayerCounter`, `BotStorer`, `GameCore`, `HeatEngine`。不自訂 `RandSource` 介面
- 真人數定義：加入中（非 spectator）的 WS 連線
- 每日 cap 達到後：(1) 停止補幣；(2) 一小時內只 log 一次錯誤；(3) 任何餘額低於門檻的 bot 下線到 UTC 隔日，避免 `bot_insert_failure_total` 洗版

## 已接受的產品風險

Document-review 時 product-lens reviewer 提出三個策略關切，Rick 做出明確決定保留以追溯：

| 關切 | 決定 | 接受的 trade-off |
|---|---|---|
| 「空板面 = 流失」前提無資料支持 | 不做 v0 驗證，直接 ship 完整 v1 | 若真正的流失驅動在別處，8-unit 工程+永久維護成本=零可測 lift。Ship 後仍應定義一個留存指標觀察，N 週無 lift 則考慮 roll-back / sunset |
| 覆蓋式 bot 作為產品身份（無揭露） | 維持覆蓋式 | 接受兩項風險：(a) 被 crypto-native 用戶反推出來後貼 Reddit 的聲譽懸崖；(b) 真錢模式上線多轄區合規暴露。緩解：已指定「真錢模式啟動時 scheduler 拒絕啟動」的 fail-closed gate |
| Scheduler 只解 4 項新玩家痛點中的 2 項（coin 密度 + heat 競爭），不解側出口觸發 + 無道具視覺事件 | 接受 v1 gap | v1 交付板面活動與 heat 競爭感。若 ship 後用戶回饋這個 gap 重要，後續再加 `onRealPlayerJoin` 協調性投幣波，瞄準側牆觸發。不在 v1 範圍 |

---

## 實作單元

### Unit 1 — Schema & 常數基礎
**目標**：加 `bot_config` 表、延伸 role / provider_type / action_type 常數，讓後續 unit 有東西可用。

**檔案**：
- 修改 `backend/zarf/docker/database/schema.sql`：加 `CREATE TABLE IF NOT EXISTS bot_config (config_key TEXT PRIMARY KEY, config_value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`。可選加 `CHECK (role IN ('user','admin','bot'))`
- 修改 `backend/business/core/user/model.go`：加 `RoleUser/RoleAdmin/RoleBot`、`ProviderTypeWallet/Email/Google/Bot` 常數
- 修改 `backend/business/core/accounting/model.go`：加 `ActionBotRefill = "BOT_REFILL"`
- **`backend/app/tooling/admin/main.go:111-114`：不加 `"bot"` 到 allowlist**（bot 只能靠 `admin bot seed` 建立）

**驗收**：`admin migrate` 冪等通過、`go build ./...` 過、常數被 export。

---

### Unit 2 — Bot Core 模組
**目標**：建 `backend/business/core/bot/`，提供 config CRUD、bot 帳戶查詢、`RefillBalance` helper。

**檔案**：
- 新建 `backend/business/core/bot/{bot.go, model.go, storer.go, bot_test.go}`
- 新建 `backend/business/core/bot/stores/botdb/botdb.go` + `botdb_integration_test.go`（`//go:build integration`）
- 修改 `backend/business/core/accounting/accounting.go`：新增 `ProcessBotRefill(ctx, accountID, amount, referenceID)` — 在 `execTx` 內寫 `ActionBotRefill` ledger + 加 `balance_play`，用 `QueryByReference` 冪等保護（鏡射 `ProcessDeposit`）

**`bot.Core` 方法**：
- `GetConfig` / `SetConfig`
- `ListAllBots` / `GetBot`
- `DailyRefillTotal` — 薄層 wrap `Storer.SumRefillsSince(startOfDayUTC)`
- `RefillBalance` — 呼叫 `accounting.ProcessBotRefill`，不重複 tx 邏輯

**`bot.Core.Storer` 介面**：`QueryConfigAll`, `UpsertConfig`, `QueryBotAccounts`, `QueryBotAccountByID`, `SumRefillsSince`

**`ConfigKey*` 常數只 5 個**（runtime-configurable 的部分）：`KillSwitch`, `RefillAmount`, `RefillThreshold`, `DailyCap`, `CrowdScale`。投幣間隔、單次投幣量、session 長度都是 package-level Go 常數，不進 DB。

**測試**：happy path + refill idempotency + 非 bot 帳戶拒絕 + 餘額 ≤ 0 拒絕 + integration（ledger 持久化、跨日 sum 正確）

---

### Unit 3 — Heat 系統：bot 排除 5% 保底
**目標**：修改 heat 演算法，bot 不享 5% 保底但仍進分母。

**檔案**：
- 修改 `backend/business/core/heat/heat.go`：`PlayerHeat` 加 `IsBot bool`；新增 `AddHeatForBot(userID, amount)` 方法（與 `AddHeat` 並行，不改 `AddHeat` 簽章）；`GetShares`（~行 103）與 `GetShareForUser`（~行 139）根據 `IsBot` 跳過 floor
- 修改 `backend/business/core/heat/heat_test.go`：加場景含「bot heat pruned 後重新 add」
- 修改 `docs/heat-system.md`：補 bot 排除規則

**公式**：
```
floorTotal = guaranteed * (count of non-bot players)
for each user i:
  if user_i.IsBot: share_i = (1 - floorTotal) * effectiveHeat_i / totalEff
  else:            share_i = guaranteed + (1 - floorTotal) * effectiveHeat_i / totalEff
```

**Last-write-wins**：`AddHeat` 每次設 `IsBot=false`，`AddHeatForBot` 每次設 `IsBot=true`。現有 RWMutex 保護並發。

**測試**：1 真 + 1 bot 同 heat、2 真 + 3 bot、0 真 + 2 bot（無 floor）、1 真 + 0 bot（現有行為不變）、旗標正確性（AddHeat 後 AddHeatForBot 反之）、prune 恢復、現有 test regression。

---

### Unit 4 — 登入拒絕 `provider_type='bot'`
**目標**：關閉以 bot 身份登入的所有攻擊面。

**檔案**：
- 修改 `backend/business/core/user/user.go`：
  - `FindOrCreate` 與 `FindOrCreateWithMeta` 的 create 與 lookup 兩條路徑都早期拒絕 `provider_type='bot'`
  - `VerifyWalletLogin`：`QueryByProvider` 回傳後檢查 `role='bot'`，是則 `ErrAuthFailed`（縱深防禦錢包 hex 碰撞攻擊）
- 修改 `backend/app/services/api/handlers/v1/usergrp/usergrp.go:41-70`：Login handler 早期拒絕
- 修改 `backend/business/web/mid/auth.go`：`Authenticate` 中介層 JWT 驗證後檢查 `claims.Role == "bot"` 就 401
- 對應 `_test.go`：補 create/lookup/wallet-bypass/JWT/HTTP 5 類測試

**攻擊情境測試**：預先種一隻 bot（`provider_type='bot'` + 某個 hex UID），攻擊者簽該 hex 的 wallet challenge → `QueryByProvider(ctx, "wallet", hex)` 找不到（因為 bot 在 `provider_type='bot'` 命名空間）→ 自然失敗。另外手動塞一筆 `provider_type='wallet'` 綁 bot account，驗證 `VerifyWalletLogin` 會被 role 檢查擋下。

---

### Unit 5 — Bot Scheduler Goroutine（核心行為）
**目標**：實作 scheduler — session 管理、jittered 投幣、kill-switch、daily cap、metrics、API main.go wiring。

**檔案**：
- 新建 `backend/business/core/bot/scheduler.go` — `Scheduler struct{botCore, gameCore, accountingCore, heatEngine, playerCounter, clock, rng, log, db}`；`Run(ctx)` 5s tick
- 新建 `backend/business/core/bot/scheduler_test.go`（stub 注入的單元測試）
- 新建 `backend/business/core/bot/scheduler_integration_test.go`（`//go:build integration`，**必須**，不是 optional — outbox retro 教訓）
- 修改 `backend/foundation/metrics/metrics.go`：加 `BotActiveCount`、`BotInsertTotalPlay`、`BotRewardTotalCash`、`BotRefillTotalPlay`、`BotRefillDailyCapRemaining`、`BotInsertFailureTotal`、`BotInsertPanicTotal`、`BotOutboxStalled`
- 修改 `backend/business/web/ws/hub.go`：export `Count()` 與 `SpectatorCount()`
- 修改 `backend/app/services/api/main.go`：啟動時試拿 advisory lock → 拿到才 spawn scheduler（ctx + WaitGroup）；shutdown 順序 cancel → Wait → DB close（鎖隨連線釋放）→ NATS drain
- 修改 reward 發放 callsite：bot 帳戶收到 reward 時順便 `metrics.BotRewardTotalCash.Inc()`

**每 tick 流程**：
1. 讀 config（5s 快取）
2. `kill_switch='on'` → 全 bot 下線、return
3. Outbox 預檢：`nats_outbox` > 100 row 或最舊 > 60s → 本 tick 不投幣、設 `BotOutboxStalled=1`
4. Daily cap 檢查：達到 → log 一次（每小時節流）、把餘額不足的 bot 下線到 UTC 隔日
5. 未達 cap → 每隻 bot 若 `balance_play + balance_cash < threshold` 呼叫 `botCore.RefillBalance(id, amount, "bot-refill:<id>:<yyyymmddUTC>")`
6. 計算 `realPlayerCount` → 更新 `targetEMA = 0.9*targetEMA + 0.1*realPlayerCount` → `target = crowd_scale[floor(targetEMA)]`
7. 線上 < target：挑一隻 offline（過 offlineUntil）且餘額充足的，設 `online=true`、`sessionEndsAt=now+random(10..40min)`、`nextActionAt=now+random(10..50s)`
8. 線上 > target：挑最接近 `sessionEndsAt` 的下線、`offlineUntil=now+random(2..8min)`
9. `sessionEndsAt` 到期的 bot 下線
10. `nextActionAt` 到期的 bot 投幣：
    - 隨機 slot (0..4)，隨機 amount [3, 15]
    - `refKey = fmt.Sprintf("bot:%s:%d", accountID.String(), clock.Now().UnixNano())`，碰撞則追加 `:<bot_index>`
    - 組 outboxWriter = `InsertOutboxRow(ctx, TopicBatchInsert("main"), EncodeBatchInsertPayload(accountID.String(), slotID, amount, refKey), refKey)`
    - 呼叫 `gameCore.ProcessBatchInsert(ctx, accountID, amount, refKey, outboxWriter)`
    - 成功：`heatEngine.AddHeatForBot(accountID, amount)`；`BotInsertTotalPlay += amount`；`nextActionAt = now + clamp(normal(30,10), 10, 90)` 秒
    - 失敗：`BotInsertFailureTotal++`、log warn、`nextActionAt = now + interval`
    - recover 的 panic：`BotInsertPanicTotal++`、**不推進 nextActionAt**；`context.Canceled` 不視為 panic
11. 更新所有 gauge + worker histograms

**Scheduler 啟動時**：拿 `pg_try_advisory_lock`；對每隻 bot 設 `offlineUntil = now + rand(5..15min)`（錯開冷啟動）。

**測試**：0/1/多真人情境的 target 計算、session 結束、refill 冪等、hysteresis 不 flap、kill-switch 傳播、daily cap 靜默、insert 失敗 retry、graceful shutdown、**多 instance 鎖**、outbox stalled 跳過、restart 暖機、wallet 碰撞防禦、integration（真 Postgres）。

---

### Unit 6 — Admin CLI `bot` 子指令
**目標**：提供完整營運控制。

**檔案**：
- 新建 `backend/app/tooling/admin/bot.go` — `botCmd(db)` 分派 + 每個動詞一個 helper
- 修改 `backend/app/tooling/admin/main.go`：註冊 `"bot"` switch case + 更新 usage help
- 新建 `backend/app/tooling/admin/bot_test.go`
- 新建 `backend/zarf/docker/database/schema.sql` 加 `bot_paused_accounts` 表（`account_id UUID PRIMARY KEY`）

**指令**：

| 指令 | 說明 |
|---|---|
| `seed` | 建立 20 隻 bot（`role='bot'` + `auth_providers.provider_type='bot'` + display_name 池 8 + 空 12），冪等；建初始 `bot_config` rows；預檢 display_name 不撞現有真人 |
| `list` | 列表（account_id、display_name、last_insert_at、balance、今日 P/L）；online/offline 推斷自 `last_insert_at < 2min`，不讀 scheduler 記憶體 |
| `stats --since 24h` | 投幣/獎勵/淨流/補幣彙總（SQL 含 role filter） |
| `pause <account_id>` | 寫 `bot_paused_accounts`（重啟仍在） |
| `resume <account_id>` | 從 `bot_paused_accounts` 刪除 |
| `kill-switch on/off` | `SetConfig("kill_switch", ...)` |
| `refill <account_id> <amount>` | 手動補幣，refKey 用 `bot-refill-manual:<id>:<unix_nano>` |
| `config show` | 列印所有 `bot_config` rows |
| `config set <key> <value>` | 驗證 key 合法（5 個已知）+ value 格式 |

**命名池**（8 個）：`CoinDropMaster`, `0xPusher`, `jackpot_hunter`, `VitalikFan`, `SatoshiFTW`, `CascadeKing`, `RektLord`, `diamond_hands`

---

### Unit 7 — RTP / Liability 報表 role filter
**目標**：補所有既有報表，避免 bot 活動污染真人 RTP 數字與 house liability。

**檔案**：
- 修改 `backend/app/services/api/main.go:912-920`（全域 RTP monitor、`SumByActionSince`）：加 `JOIN accounts a ON a.account_id = l.account_id WHERE a.role != 'bot'`
- 修改 `backend/app/services/api/main.go:948-1025`（per-player anomaly worker、`SumByPlayerSince`）：同上 filter。不加就會把 bot 當成高異常 RTP 玩家誤報
- 修改 `backend/business/core/accounting/stores/ledgerdb/ledgerdb.go:138`：`SumByPlayerSince` 加 `excludeRole` 參數**或**新增 `SumByPlayerSinceExcludingRole` 方法（推薦後者、不破壞既有 mock）。牽動 5 個 mock storer 測試檔（accounting_test.go、game_test.go、gamegrp_test.go、inventory_test.go、deposit_test.go）
- 修改 `backend/app/tooling/admin/` 中任何 RTP / balance 報表指令：加 role filter
- 修改 `docs/monitoring.md` / `docs/heat-system.md`：註明規則

**不做 `ExcludeBotSQL()` helper** — 只有 2 個 callsite，inline JOIN 片段即可。未來 ≥3 sites 再抽。

**測試**：插 10 真人 + 10 bot `GAME_INSERT` → 全域 RTP sum 回 10；極端 RTP 的 bot 不進異常列表；mock 回傳正確過濾值。

---

### Unit 8 — AI Agent 操作 Skill
**目標**：建 `.agents/skills/play-bot-admin/SKILL.md`，讓 AI agent（Claude、其他工具）用自然語言操作 bot 系統。

**檔案**：
- 新建 `.agents/skills/play-bot-admin/SKILL.md`
- 可選 `.agents/skills/play-bot-admin/references/command-reference.md`

**內容**：
1. Frontmatter：skill 名稱、描述、觸發範例
2. 觸發詞：「bot 狀況 / 暫停 bot / 補幣 / 關掉 bot / 調 crowd scale / bot 今天賺多少」
3. 必須 / 不可：
   - 破壞性動作（kill-switch、大額 refill、影響經濟的 config set）必須先與用戶確認
   - 不可發明不存在的 CLI flag
   - 改 config 前必須先 `admin bot config show` 確認當前狀態
   - 彙總 stats 必須回報 SQL + 原始結果
4. 自然語言 → CLI 指令對照表
5. 安全守則（daily cap、kill switch 語意、意外 kill 後如何復原）
6. 找東西的地方：`backend/business/core/bot/`、`docs/brainstorms/2026-04-16-play-bot-requirements.md`、`docs/plans/2026-04-16-001-feat-play-bot-plan.md`

**測試**（手動）：agent 收到「暫停 bot 第 3 隻」→ 能正確 `list` → 挑 3rd id → `pause`；收「過去 24 小時 bot 表現」→ `stats --since 24h`；收「全部關掉」→ 要求確認才執行 `kill-switch on`。

---

## 系統層影響

- **互動圖**：scheduler → `gameCore.ProcessBatchInsert`（→ `accounting.ProcessGameInsert` + OutboxWriter）→ `nats_outbox` → outbox drainer → NATS → game server。成功後 scheduler 呼叫 `heatEngine.AddHeatForBot`（鏡射 `ws/handler.go:721` 對真人的 `AddHeat`）。
- **錯誤傳播**：insert 失敗 silent skip + metric + 下 tick 重試。Refill 失敗 throttled log + 日上限熔斷。Panic recover 在每 bot tick 包住，一隻 bug 不會拖垮全部。
- **State lifecycle**：bot 記憶體 session 狀態重啟會丟（可接受、短期狀態）；`bot_config` 與 `bot_paused_accounts` 是持久的。
- **API surface parity**：無外部 API 變化。WS / HTTP / JSON shape 全部不變。Bot 在 heat 廣播中與真人同樣以 `user_id + display_name` 形式呈現。
- **Integration 覆蓋**：Scheduler → ledger → outbox → NATS → game server 全鏈路 integration test 為必須。
- **不變的不變量**：`ProcessGameInsert` tx 語意、refund idempotency；真人 heat floor 數學（只有非 bot 吃 floor）；Withdraw flow（bot 不可能提款，因為 login 被擋）；Deposit flow（bot 從不觸碰，`balance_usdc` 永遠 0）。

## 風險與緩解

| 風險 | 緩解 |
|---|---|
| OutboxWriter 沒傳給 ProcessBatchInsert → 扣錢但不噴幣 | Unit 5 integration test 必檢 `nats_outbox` 有寫；payment-adjacent review 強制 |
| Config bug 造成補幣失速 | `daily_global_refill_cap` 硬停 + Prometheus 可警報 |
| Outbox drainer 死了 → 靜默掏空 house | Scheduler 預檢 outbox depth/age，stall 時停止新投幣（`BotOutboxStalled`）；refill 也會因既有 daily cap + 每 bot 餘額 gate 慢下來 |
| Scheduler goroutine panic cascade | 每 bot tick recover 包住 + panic metric；panic 不推進 `nextActionAt`（避免 metric drift） |
| Config 更新的 race | 記憶體 5s TTL 容忍最多 5s 延遲 — 運維用途可接受 |
| Heat 公式 regression 影響真人份額 | Unit 3 regression 場景逐一比對現有行為 |
| 真人被誤 flag 成 bot | Last-write-wins：下一次合法 `AddHeat` 會恢復 `IsBot=false`，無永久污染 |
| `provider_type='bot'` 登入繞道 | **四層防禦**：(a) seeder 用 `provider_type='bot'` 不用 `'wallet'`；(b) `VerifyWalletLogin` role 檢查；(c) `FindOrCreate*` 雙路拒絕；(d) `Authenticate` 擋 JWT。`setRole` CLI **禁止**設 `'bot'` |
| 報表漏 role filter → bot 活動污染數字 | Unit 7 修所有已知 site（含 per-player anomaly worker）；`docs/monitoring.md` 留規則備忘 |
| 20 隻 bot 命名撞到真人 | Seeder 預檢現有 `display_name`；備用命名池 |
| Shutdown race DB close | ctx+WaitGroup → `Wait()` 在 DB close 前；advisory lock 隨連線關閉釋放 |
| 多 replica 雙投幣 | `pg_try_advisory_lock` 啟動時搶鎖；輸的 replica log WARN 跳過 scheduler 啟動（API 繼續跑） |
| 冷啟動 bot 集體上線 burst | 啟動時 `offlineUntil` 均勻分散 5-15min 窗口 |
| 未來真錢模式忘了關 bot | Scheduler 啟動時若 `BACKEND_REAL_MONEY_ENABLED=true` → FATAL 拒絕啟動（fail-closed）；CI test 斷言此不變量 |
| 與真人同 slot 的 round-robin 碰撞 | Game server 既有 round-robin 處理；bot refKey 唯一，dedup 正常 |
| Reference ID 同 tick `unix_nano` 碰撞 | 碰撞時追加 `:<bot_index>` 消歧 |

## 維運 / 部署備忘

- **Runbook 要寫**：第一次部署如何跑 `admin bot seed`；緊急如何切 kill switch；如何解讀 `bot_*` metrics
- **部署協調**：Schema migration（Unit 1）必須先於引用 `bot_config` 的 code；首次部署 bot code 時先 migrate → 再 `admin bot seed` → 再 restart API（scheduler 啟動後抓到 config）
- **監控告警**：`bot_refill_daily_cap_remaining < 5000` 告警；`bot_active_count == 0 while real_player_count == 0` 長期為 0 可能是 scheduler 掛了
- **真錢模式護欄**：scheduler 啟動檢查 `BACKEND_REAL_MONEY_ENABLED`；為 true → FATAL 退出 scheduler。CI 加斷言

## 資料來源

- **Origin 文件**：[docs/brainstorms/2026-04-16-play-bot-requirements.md](../brainstorms/2026-04-16-play-bot-requirements.md)
- **相關程式碼**：
  - `backend/business/core/accounting/accounting.go`（ProcessGameInsert + OutboxWriter 契約）
  - `backend/business/core/game/game.go:98-115`（ProcessBatchInsert — 權威投幣入口）
  - `backend/business/web/ws/handler.go:694-705`（OutboxWriter pattern）
  - `backend/business/core/heat/heat.go`（5% floor 公式）
  - `backend/app/services/api/main.go:281-295, 1077-1079`（ctx+WaitGroup shutdown）
  - `backend/app/tooling/admin/dlq.go`（子指令模板）
  - `backend/foundation/metrics/metrics.go`（metrics 註冊 pattern）
- **機構學習**：[docs/solutions/integration-issues/batch-insert-outbox-2026-04-14.md](../solutions/integration-issues/batch-insert-outbox-2026-04-14.md)
- **Spec**：[docs/spec.md](../spec.md)
