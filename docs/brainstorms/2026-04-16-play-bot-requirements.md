# Play Bot — Requirements

**Date:** 2026-04-16
**Status:** Ready for planning

## Problem

當線上真人玩家少時，板面空蕩，heat 池沒有競爭，真人玩家進入後會覺得像在玩單機遊戲：

1. 沒有其他玩家的投幣，板面 coin 密度低，pusher amplitude 不會升上來，cascade 頻率低
2. 沒有 heat 競爭 → reward 分配沒有「搶到」的爽感，5% 保底佔比過高
3. 沒有 slot machine / jackpot wheel 觸發（side wall exits 門檻 10 枚未達）
4. 沒有其他玩家用道具的視覺事件
5. 新玩家首 session 體驗差，難 convert 成長期用戶

## Goal

引入由後端控制的 bot 帳戶，在真人少時填補活動量，讓真人玩家進入時感受到「有人在玩」，而不汙染真人經濟、不暴露 bot 身份。

## Non-goals (v1)

- 不讓用戶知道 bot 存在（不做揭露 UI；真錢模式上線前重新評估合規需求）
- Bot 不使用道具 / 不消耗 scroll（避免稀釋真人 scroll 期望值）
- Bot 不發 megaspeaker（訊息內容太難擬真，爆雷風險高）
- Bot 不讀板面狀態 / heat 池做「聰明」決策（YAGNI）
- 不做 ML / adaptive 行為
- 不引入獨立 bot 貨幣（shadow balance）— 用 role flag 走現有 schema
- 不做 sweep job — play-first draw + house edge 會自然讓 bot 餘額緩慢流失
- 不做 HTTP admin 端點（CLI 夠用，未來需要 dashboard 再加）
- 不做 `bot_sessions` 表（需要時從 ledger + session log 推算）

## Chosen Approach

### D1. 帳戶模型 — role flag + 共用 schema

Bot 用與真人相同的 `accounts` / `auth_providers` / `accounting_logs` 表，只靠欄位差異化：

| 欄位 | Bot 值 | 用途 |
|---|---|---|
| `accounts.role` | `'bot'` | 業務邏輯主要判斷依據 |
| `auth_providers.provider_type` | `'bot'` | 防止外部登入（handler 早期 reject） |
| `auth_providers.provider_uid` | UUID 佔位字串 | 非真實 wallet/email |
| `accounts.display_name` | 見 D5 | 擬真 |
| `accounts.balance_play` | 1000（初始） | 投幣預算 |
| `accounts.balance_cash` | 0（初始） | 逐步累積 reward |

**為什麼不用獨立貨幣（shadow balance）：**
- 用 role flag 改動面最小（現成欄位）
- 外部（client、DB row、API response）完全看不出差別
- 真人 RTP 污染問題用「報表查詢加 `WHERE role != 'bot'`」解決即可

### D2. 經濟流 — play-first draw 自然消耗，不做 sweep

依靠現有 unified wallet 的 play-first 規則自然達成經濟中立：

1. Bot 初始給 `balance_play = 1000`
2. 投幣先扣 `balance_play`，扣完才扣 `balance_cash`
3. 贏到的 reward 進 `balance_cash`
4. 由於 house edge（RTP < 100%），bot 總餘額（play + cash）長期緩慢流失
5. **補幣規則**：當 `balance_play + balance_cash < bot_refill_threshold` 時，`balance_play` 補到 `bot_refill_amount`

淨效果：bot 是個「水龍頭」，緩慢把 house 預算滴進真人的 reward pool（透過 heat 分配），同時部分從 side wall 回流 house。對真人來說只感覺到「板面比較熱鬧 + 偶爾多一點 reward」。

**補幣走獨立 action type**（不走 `ActionDeposit`）：新增 `ActionBotRefill` 常數，避免污染 deposit 報表。

### D3. Heat 系統互動 — bot 排除在 5% 保底之外

現有的 5% 保底（`docs/heat-system.md`）是為了新玩家首次體驗流暢。Bot 不該享受這個保底，否則 5 隻活躍 bot 可能吃掉 25% reward share。

實作：heat distribution 計算中，`role='bot'` 的帳戶直接使用純比例（`effective_heat / total_effective_heat`），跳過保底邏輯。但 bot 的 heat 仍計入 `total_effective_heat` 分母，這樣真人的相對份額不變。

**bot 贏到 reward 是正常的、預期的** — 正是這些 reward 最終透過 play-first draw 被 bot 再投回去 / 或被 house 經由 house edge 慢慢回收。

### D4. 行為模型 — 真人數量反應式，minimal v1

Bot 只做一件事：**依當前真人連線數調整活躍 bot 數量，隨機投幣到隨機 slot**。

**活躍數量對照表**（runtime config，可熱調）：

| 真人連線數 | 活躍 bot 數 |
|---|---|
| 0 | 3 |
| 1–2 | 4 |
| 3–4 | 3 |
| 5+ | 2 |

真人多時 bot **不是退到 0**，而是降到 2 隻背景感 — 若真人少量離開瞬間降到 0 會太突兀。

**單隻 bot 的投幣 pattern：**
- 投幣間隔：normal distribution（mean=30s、stddev=10s，clamp 到 [10s, 90s]）
- 單次投幣量：uniform random [3, 15] coin
- 目標 slot：uniform random 從 5 個 slot 擇一
- Session 長度：uniform random [10min, 40min]，session 結束後「下線」空 [2min, 8min] 再換另一隻上線

**為什麼要 session 概念：**真人連線列表（即使只是 heat share 廣播的 player 數）不會永遠是同一批，bot 輪替讓身份不被長期觀察識破。

**真人數輸入來源**：backend 內部直接查 WS hub 的連線計數（不是查 ledger），因為 hub 正是 backend 內嵌，直接函式呼叫即可。

### D5. Bot 池 & 身份

**預建 20 隻 bot**（透過 admin CLI 的 `seed` 指令一次建完），帳號 ID 固定、可長期追蹤。

**Display name 分佈**（比例貼近真人現狀）：

- 12 隻 `display_name = NULL`（UI fallback 顯示截斷的假 wallet address）
- 8 隻 `display_name = <crypto 風格 username>`

**假 wallet address 池**（給沒設 display_name 的 12 隻當 auth_providers.provider_uid 或前端 fallback 顯示用）：
必須是合法 40 字元 hex（`0x` + 40 chars），隨機生成但不綁任何 wallet 認證。

**Display name 候選池（8 個）：**
```
CoinDropMaster
0xPusher
jackpot_hunter
VitalikFan
SatoshiFTW
CascadeKing
RektLord
diamond_hands
```

seed 時若想擴充，可以再加一倍候選放池子裡隨機抽 8 個。

### D6. 部署架構 — backend 內嵌 goroutine

Bot scheduler 跑在 backend process 內，不新增獨立 service。

- 新增 `backend/business/core/bot/bot.go` — bot 業務邏輯 core
- 新增 `backend/business/core/bot/scheduler.go` — goroutine scheduler，負責：
  - 每 N 秒 tick 一次，讀真人數 → 決定目標活躍 bot 數
  - 管理每隻 bot 的 session 狀態（online/offline、下次動作時間）
  - 到點呼叫 `accounting.ProcessGameInsert`（繞過 WS，直接內部呼叫）
  - 檢查並觸發補幣
- 在 `api/main.go` 啟動時 spawn scheduler goroutine，graceful shutdown 時 cancel context

**投幣路徑**：bot scheduler → `accounting.ProcessGameInsert`（扣 balance + 寫 ledger + NATS publish 到 game server），和真人走同一路徑的後半段。Bot 不經過 HTTP handler 或 WS hub。

### D7. 追蹤 — 走現有 ledger，JOIN filter

所有 bot 的 insert / reward 照常寫 `accounting_logs`（`account_id` 就是 bot account id）。查詢時 JOIN `accounts` 用 `role` filter：

```sql
-- 每日 bot 投幣/獎勵/淨流出
SELECT DATE(l.created_at) AS day, l.action_type, l.currency, SUM(l.amount) AS total
FROM accounting_logs l
JOIN accounts a ON a.account_id = l.account_id
WHERE a.role = 'bot'
  AND l.created_at > NOW() - INTERVAL '7 days'
GROUP BY 1, 2, 3
ORDER BY 1 DESC;

-- 單隻 bot P/L
SELECT
  a.account_id,
  COALESCE(a.display_name, 'anon') AS name,
  SUM(CASE WHEN l.action_type IN ('GAME_INSERT') THEN -l.amount ELSE 0 END) AS inserted,
  SUM(CASE WHEN l.action_type IN ('GAME_REWARD','CHEST_REWARD') THEN l.amount ELSE 0 END) AS won,
  SUM(CASE WHEN l.action_type = 'BOT_REFILL' THEN l.amount ELSE 0 END) AS refilled
FROM accounting_logs l
JOIN accounts a ON a.account_id = l.account_id
WHERE a.role = 'bot'
GROUP BY a.account_id, a.display_name;
```

**所有真人 RTP / liability 報表都必須加 `WHERE role != 'bot'`**，不然會把 bot 的 CASH 誤當成 house 負債。

### D8. Prometheus Metrics

新增到現有 `/metrics` 端點（port 4010）：

| Metric | Type | 說明 |
|---|---|---|
| `bot_active_count` | gauge | 當前 online bot 數 |
| `bot_insert_total_play` | counter | 累計投幣量（PLAY，含從 CASH 扣的部分也算進去） |
| `bot_reward_total_cash` | counter | 累計獎勵量（CASH） |
| `bot_refill_total_play` | counter | 累計補幣量（對照每日 cap alert） |
| `bot_refill_daily_cap_remaining` | gauge | 當日剩餘補幣預算 |

### D9. Admin CLI 操作

新增在 `backend/app/tooling/admin/` 下的 `bot` 子指令：

| 指令 | 用途 |
|---|---|
| `admin bot seed` | 一次預建 20 隻 bot（冪等，已存在跳過） |
| `admin bot list` | 列出所有 bot（account_id、display_name、online/offline、balance、當日 P/L） |
| `admin bot stats [--since 24h]` | 彙總投幣 / 獎勵 / 淨流出 / 補幣量 |
| `admin bot pause <account_id>` | 暫停單隻（不再排程動作） |
| `admin bot resume <account_id>` | 恢復單隻 |
| `admin bot kill-switch on\|off` | 全域開關（全停 / 全恢復） |
| `admin bot refill <account_id> <amount>` | 手動補幣（測試用） |
| `admin bot config show` | 顯示當前 runtime config |
| `admin bot config set <key> <value>` | 熱調 config（見 D10） |

**Kill switch 狀態持久化**到 DB 的 `bot_config` 表（見 D10），process 重啟後仍保留狀態。

### D10. Runtime Config（熱調 / 可重載）

建一張 `bot_config` 表（key-value），scheduler 每 N 秒重讀一次，或 admin CLI 改完 SIGHUP backend process。

| Key | 範例值 | 說明 |
|---|---|---|
| `kill_switch` | `off` | 全域開關 |
| `refill_amount` | `1000` | 補幣目標額 |
| `refill_threshold` | `100` | 觸發補幣的總餘額門檻 |
| `daily_global_refill_cap` | `50000` | 全域每日補幣上限（超過熔斷、alert） |
| `crowd_scale` | `{"0":3,"1":4,"2":4,"3":3,"4":3,"5":2}` | 真人數→活躍 bot 數對照（JSON） |
| `insert_interval_mean_sec` | `30` | 投幣間隔 mean |
| `insert_interval_stddev_sec` | `10` | 投幣間隔 stddev |
| `insert_amount_min` | `3` | 單次投幣量下限 |
| `insert_amount_max` | `15` | 單次投幣量上限 |
| `session_min_min` | `10` | session 長度下限（分鐘） |
| `session_max_min` | `40` | session 長度上限（分鐘） |

### D11. Admin Skill（給 AI agent 調用）

為了讓使用者用自然語言下指令（例如「暫停 bot 3」、「看過去 24 小時 bot 表現」、「把 crowd scale 調高」），建立 `.agents/skills/play-bot-admin/SKILL.md`：

- 觸發詞：mentions of bot、play bot、bot 暫停 / 恢復 / 補幣 / 調參 / 狀況
- 內容：所有 admin CLI 指令的對照表、natural language → CLI command 映射範例、安全守則（例如改 config 前先 show，破壞性動作先確認）
- 完整流程：判斷意圖 → 決定 CLI 指令 → 執行 → 解讀輸出回報

這是實作階段的 deliverable 之一，和 backend 程式一起交付。

## Success Criteria

1. 0 真人時，板面持續有 bot 投幣活動；pusher amplitude 會因 bot 投幣量提升
2. 真人進入時看到的 player list / heat share 廣播中包含 bot 身份（display_name 和真人無法區分）
3. 真人用戶側看到的所有欄位 shape（API response、WS message）沒有任何 bot 專屬欄位或標記
4. 真人 RTP 報表（front-edge drop ratio 等）在 `WHERE role != 'bot'` filter 下正確計算，不受 bot 活動污染
5. House liability 報表（sum of `balance_cash` from non-bot accounts）不包含 bot 餘額
6. Bot 的所有投幣 / 獎勵進 `accounting_logs`，可用 role JOIN 查詢
7. 補幣走 `ActionBotRefill`（不污染 deposit 報表）
8. Admin CLI 所有指令可執行：seed / list / stats / pause / resume / kill-switch / refill / config
9. Kill switch on 後 bot 在下一個 tick（≤ 30 秒）全部停止動作
10. Daily global refill cap 達到後，補幣停止並記 error log
11. Heat 5% 保底不發放給 `role='bot'` 帳戶（單元測試涵蓋）
12. `provider_type='bot'` 的帳戶無法透過任何現有 login endpoint 登入
13. Prometheus metrics 能查到所有 D8 列出的 bot 相關指標
14. `.agents/skills/play-bot-admin/SKILL.md` 存在，AI agent 能透過自然語言操作所有 admin 功能

## Open Questions for Planning

1. **WS hub 真人數查詢介面**：目前 hub 是否已經 export 一個「當前連線數（排除 bot，若 bot 也連 WS 的話）」的函式？若沒有，需要加。
2. **Bot scheduler 失敗重試策略**：`ProcessGameInsert` 偶發失敗（例如餘額不足剛好扣完瞬間）時，是 silent skip 還是 retry？建議 silent skip + 下 tick 會再試 + metric 記錄 `bot_insert_failure_total`。
3. **真人數閾值的 hysteresis**：活躍 bot 數從 4 → 2 的切換應該要有 hysteresis（防止真人數在邊界附近抖動造成 bot 反覆上下線）。Planning 階段決定具體 debounce 時間。
4. **Scheduler tick 週期**：太短浪費 CPU，太長反應慢。建議 5 秒一次 tick。
5. **`bot_config` 表 reload 機制**：是每 tick 查 DB（簡單但有 DB 開銷）還是 SIGHUP 主動 reload（效能好但 admin CLI 要發 signal）？建議每 tick 查 DB，用 memory cache + 5 秒 TTL。
6. **20 隻 bot 在不同時段的 display_name 分配是否會重複**：同一時段活躍的 bot 如果名字 pool 重複，真人會看出來。確認 bot pool 20 隻各自擁有 unique name（8 個有 name 的用不同名字、12 個 null 的用不同假 wallet address）。
7. **Test 策略**：bot scheduler goroutine 要怎麼做單元測試？建議抽 `Clock` / `RandSource` / `PlayerCounter` 介面，測試時注入 mock。

## Files Likely Affected

### 新增
- `backend/business/core/bot/bot.go` — bot 業務邏輯
- `backend/business/core/bot/scheduler.go` — goroutine scheduler
- `backend/business/core/bot/model.go` — Bot 相關 types、Config struct
- `backend/business/core/bot/storer.go` — interface
- `backend/business/core/bot/stores/botdb/botdb.go` — DB 實作（config 表 CRUD）
- `backend/business/core/bot/bot_test.go`、`scheduler_test.go`
- `backend/app/tooling/admin/commands/bot.go` — admin CLI bot 子指令
- `zarf/postgres/migrations/<timestamp>_bot_config.sql` — 新 `bot_config` 表
- `zarf/postgres/migrations/<timestamp>_bot_seed.sql` 或透過 CLI 執行 seed
- `.agents/skills/play-bot-admin/SKILL.md` — AI agent 操作 skill

### 修改
- `backend/business/core/accounting/model.go` — 加 `ActionBotRefill` 常數
- `backend/business/core/accounting/accounting.go` — 可能加 `ProcessBotRefill` 函式（或重用既有 credit 介面）
- `backend/business/core/user/user.go` — 可能加 `RoleBot` 常數、`IsBot(account)` helper
- `backend/business/web/heat/...`（現有 heat 計算位置）— 5% 保底邏輯加 `role != 'bot'` 判斷
- 所有 login handler（`usergrp` 下）— 拒絕 `provider_type='bot'`
- `backend/app/services/api/main.go` — 啟動 bot scheduler goroutine + graceful shutdown
- `backend/app/services/api/handlers/v1/metrics` 或既有 metrics 定義 — 加 bot metrics
- 所有 RTP / liability 分析 SQL（`admin` CLI 下的 report 指令、`docs/monitoring.md` 描述的查詢）— 加 `WHERE role != 'bot'`
- `docs/spec.md` — 增補「Bot 存在且對真人不可見」的內部備註（或另建 internal doc，不 commit 到公開 repo 的話）

### 測試
- `accounting_test.go` — `ActionBotRefill` 寫入 / 查詢
- `heat` 相關 test — bot 不領 5% 保底
- `bot_test.go` — scheduler 行為、crowd scale 切換、session 輪替、kill switch
- 既有 login test — 拒絕 `provider_type='bot'`

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Bot 餘額 bug 導致暴走（補幣無限迴圈） | `daily_global_refill_cap` 熔斷 + metric alert |
| Scheduler goroutine panic 拖垮 backend | 用 recover 包住每個 bot 的 tick + panic log |
| 真人發現 bot 身份（名字重複、行為規律） | Session 輪替 + 間隔 jitter + display_name pool unique |
| 未來真錢模式上線沒關 bot 導致合規風險 | v1 非 goal 但加一個 TODO 在 spec；設定真錢模式的 feature flag 上線前強制檢查 `kill_switch=on` |
| Bot CASH 被查詢算進 house liability | 所有相關 SQL 明確加 filter，並在 code review checklist 強調 |
| `provider_type='bot'` 的帳戶被 SQL injection / 認證 bypass 登入 | Login handler 早期 reject + 單元測試涵蓋 |
