---
title: Unified Wallet for Coin Insert (play-first, cash fallback)
type: feat
status: completed
date: 2026-04-12
origin: docs/brainstorms/2026-04-12-unified-wallet-insert-requirements.md
---

# Unified Wallet for Coin Insert (play-first, cash fallback)

## Overview

讓用戶可以用 `balance_cash`（可提現餘額）投幣，而不只是 `balance_play`。DB schema 與 ledger 語意保持不變；投幣時在單一 DB transaction 內按 **play-first, cash-second** 順序扣款，並為實際使用的每種幣各寫一筆 `ActionGameInsert` ledger entry。前端把兩個餘額合併成單一「Balance」顯示，並在旁邊標示 `withdrawable` 部分，透過現有的 `InfoTip` 元件解釋扣款順序。

## Problem Frame

目前 `ProcessGameInsert` 只從 `balance_play` 扣款；用戶贏到的 `balance_cash` 只能提現。這造成四個問題：留存（贏了只能走）、方便性（play coin 用完中斷）、經濟循環斷裂、用戶抱怨「贏的錢不能投」。（詳見 origin：docs/brainstorms/2026-04-12-unified-wallet-insert-requirements.md）

## Requirements Trace

- R1. 在 `balance_play = 0, balance_cash > 0` 時仍可投幣
- R2. 投幣優先消耗 `balance_play`，歸零後才動用 `balance_cash`（play-first）
- R3. Ledger 對混合投幣寫入兩筆 entry，currency 分別為 PLAY / CASH，共用同一 `reference_id`
- R4. Insert 失敗 refund 時，play 與 cash 各自還回正確金額
- R5. 前端顯示單一合併餘額 + withdrawable 子標示 + InfoTip 解釋扣款順序
- R6. 提現功能行為不變，上限仍為 `balance_cash`
- R7. 單一 DB transaction 保證 insert 的原子性（任何失敗整筆 rollback）

## Scope Boundaries

- 不動 DB schema（`balance_play` / `balance_cash` 兩欄維持分離）
- 不動 ledger currency 語意（PLAY / CASH / USDC 仍分開）
- 不動 withdraw flow（仍只從 `balance_cash` 扣）
- 不引入 cash ↔ play 匯率（維持 1:1 等值）
- 不實作遺留的 `ActionExchangeCashPlay`（將移除該常數）
- 不加 toast 提示、不加 settings 開關（由 InfoTip 吸收說明）

## Context & Research

### Relevant Code and Patterns

- `backend/business/core/accounting/accounting.go` — `ProcessGameInsert` (line 128)、`ProcessGameInsertRefund` (line 172)；`execTx` 提供 tx-bound stores 的標準範式
- `backend/business/core/user/user.go` — `DecrementPlayBalance` / `DecrementCashBalance` / `IncrementXxx`（line 135–157）；所有 balance mutation 都走 `storer.UpdateBalance(currency, delta)`，底層是 atomic SQL
- `backend/business/core/game/game.go` — `ProcessGameInsert` 的三個呼叫點（line 46, 67, 85）；`RefundBatchInsert` (line 97) 目前只接受 `coinCount`
- `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go:54-128` — HTTP `BatchInsert` 處理器；response 型別 `BatchInsertResponse{Queued, HeatShare, Balance}`；refund 使用**不同** reference_id（line 113）
- `backend/business/web/ws/handler.go:615-724` — WS `batch_insert` 處理器；ack 訊息結構 `{op, queued, heat_share, balance}`（line 718–723）；同樣 refund 用不同 reference_id
- `game/client/src/ui/PlayerInfo.tsx` — 現有 Play / Cash 雙欄顯示 + 已沿用 `InfoTip` 元件
- `game/client/src/ui/InfoTip.tsx` — 現有 hover tooltip 元件，可直接沿用
- `game/client/src/App.tsx:162-186` — `balance` / `balanceCash` 兩個 state 的初始化與更新點
- `game/client/src/net/GameClient.ts:48-52, 307-315` — `BatchInsertAckCallback(queued, error?, balance?)` 與 `batch_insert_ack` case
- `backend/business/core/accounting/model.go:15` — 遺留且未使用的 `ActionExchangeCashPlay` 常數
- 已驗證的 pattern：`execTx` + 單一 tx 內多筆 ledger Create（見 `ProcessDeposit` 與 `ProcessGameReward`）

### Institutional Learnings

- Refund flow 已在 2026-03-01 security-audit 強化：NATS publish 失敗後必 refund 並寫 ledger entry 保證稽核軌跡（docs/security-audit.md:293）—— 本計畫必須維持此保證，且對每種被動用的幣各寫一筆 refund entry

## Key Technical Decisions

- **Play-first 扣款順序（決策）**：符合「贏來的錢是我的」心理模型，長期客訴風險低於 cash-first；經濟循環仍透過長時間遊玩自然發生
- **Schema 不動（決策）**：保留兩欄讓 ledger 稽核軌跡清晰；unified wallet 僅是 UX 層合併
- **Split-aware refund via caller state（決策）**：refund 函式改為接受明確的 `(playToRefund, cashToRefund)`，而非 `coinCount` + 查 ledger。理由：insert 與 refund 在同一 handler 內，caller 已有 split 資訊；不查 DB 更快、更可靠、也避免與 insert 使用不同 `reference_id` 的現況衝突
- **新 `DecrementForInsert` 組合原語（決策）**：放在 `user.Core`，單一方法在 tx 內讀帳戶 → 計算 split → 分兩次 `UpdateBalance` → 回傳 `(playDebited, cashDebited, newPlay, newCash)`。讓 `accounting.Core` 只負責 ledger，balance 原子性由 user layer 保證
- **餘額不足判定**：`balance_play + balance_cash < coinCount` → 整筆 tx rollback，回傳與今日等效的「餘額不足」錯誤
- **WS / HTTP response 同步送兩個餘額**：不在後端做合計；前端統一邏輯 `total = play + cash`，方便除錯也讓 withdrawable 顯示一致
- **移除 `ActionExchangeCashPlay`**：無引用，未來若要做真正的 exchange 可以重新定義

## Open Questions

### Resolved During Planning

- Q: `ProcessGameInsert` 簽章？ → A: 回傳 `(newPlay, newCash, playDebited, cashDebited decimal.Decimal, err error)`；caller 保留 split 用於 refund 與 response
- Q: WS / HTTP ack payload？ → A: 兩個 response 都改送 `balance_play` + `balance_cash` 兩個欄位（取代單一 `balance`）
- Q: 是否清掉 `ActionExchangeCashPlay` 常數？ → A: 是，無引用
- Q: 是否需要新 helper？ → A: 新增 `user.Core.DecrementForInsert(ctx, accountID, amount) (playDeb, cashDeb, newPlay, newCash, err)`
- Q: Refund 如何知道原本的 split？ → A: Caller（handler）在 insert 成功後保留 split，失敗時傳入 refund；不靠 ledger 查詢

### Deferred to Implementation

- `DecrementForInsert` 的 SQL 具體形式（單一 `UPDATE ... RETURNING` 可否處理兩欄條件式更新，或拆成兩個 `UpdateBalance` 呼叫）—— 先以「讀 + 兩次寫」為預設實作，效能充足則不再優化
- 既有 `game_test.go` / `accounting_test.go` / `gamegrp_test.go` 既有測試的精確修改範圍，以測試執行時實際 diff 為準
- WS ack message 的 Go 型別是否仍沿用 `map[string]interface{}` 或升級為 struct — 現況是 map，為最小變更計畫先沿用

## Implementation Units

- [ ] **Unit 1: 新增 `user.Core.DecrementForInsert` 原語**

**Goal:** 提供單一方法，在單一 DB call 內按 play-first 順序扣款並回傳 split，作為 `accounting.ProcessGameInsert` 的底層原語。

**Requirements:** R1, R2, R7

**Dependencies:** 無

**Files:**
- Modify: `backend/business/core/user/user.go`
- Modify: `backend/business/core/user/stores/userdb/userdb.go`（若需要新 SQL）
- Modify: `backend/business/core/user/storer.go`（若需擴展 Storer 介面）
- Test: `backend/business/core/user/user_test.go`

**Approach:**
- 新增 `DecrementForInsert(ctx, accountID, amount) (playDeb, cashDeb, newPlay, newCash decimal.Decimal, err error)`
- 實作：先 `QueryByIDForUpdate`（取得 play/cash），計算 `playDeb = min(play, amount)`、`cashDeb = amount - playDeb`，檢查 `cashDeb <= cash` 否則回 `ErrInsufficientBalance`（或既有等效錯誤），然後依序 `UpdateBalance(PLAY, -playDeb)` 與 `UpdateBalance(CASH, -cashDeb)`（若 > 0）
- 呼叫方負責 tx（`accounting.execTx` 已提供）
- `playDeb` 為 0 時不做 PLAY 的 update；`cashDeb` 為 0 時不做 CASH 的 update

**Patterns to follow:**
- 鄰近 `DecrementPlayBalance` / `DecrementCashBalance` 的錯誤處理
- `QueryByIDForUpdate` 範式（已用於既有 tx 流程）

**Test scenarios:**
- Happy path: `play=10, cash=5, amount=3` → `playDeb=3, cashDeb=0, newPlay=7, newCash=5`
- Happy path (純 cash 來源): `play=0, cash=5, amount=3` → `playDeb=0, cashDeb=3, newPlay=0, newCash=2`
- Edge case (跨幣): `play=2, cash=10, amount=5` → `playDeb=2, cashDeb=3, newPlay=0, newCash=7`
- Edge case (剛好耗盡 play): `play=5, cash=5, amount=5` → `playDeb=5, cashDeb=0, newPlay=0, newCash=5`
- Error path: `play=2, cash=2, amount=5` → `ErrInsufficientBalance`，兩欄餘額未變更
- Edge case: `amount=0` → `playDeb=0, cashDeb=0`，視為成功（上層應已過濾，但原語應安全）

**Verification:**
- Unit tests 覆蓋所有上述 scenario 且通過
- 回傳的 `newPlay + newCash = oldPlay + oldCash - amount`（或錯誤路徑兩者都不變）

---

- [ ] **Unit 2: 改造 `accounting.ProcessGameInsert` / `ProcessGameInsertRefund` 為 split-aware**

**Goal:** 在 tx 內使用 `DecrementForInsert`；對實際扣到的每種幣寫入一筆 `ActionGameInsert` ledger；回傳 split 資訊給上層。Refund 接受明確 `(playDeb, cashDeb)` 並對應還款 + 兩筆 `ActionGameInsertRefund` ledger。

**Requirements:** R3, R4, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `backend/business/core/accounting/accounting.go`
- Modify: `backend/business/core/accounting/model.go`（移除 `ActionExchangeCashPlay`）
- Test: `backend/business/core/accounting/accounting_test.go`

**Approach:**
- `ProcessGameInsert` 新簽章：`(ctx, accountID, coinCount int, referenceID string) (playDeb, cashDeb, newPlay, newCash decimal.Decimal, err error)`
- 內部：`execTx` → 呼叫 `userCore.DecrementForInsert` → 若 `playDeb > 0` 寫 `ActionGameInsert` currency=PLAY amount=playDeb，若 `cashDeb > 0` 寫一筆 currency=CASH amount=cashDeb，**共用同一 `referenceID`**
- Metric recorder 呼叫保持原樣（`"game_insert_count"` 以總 `amount = playDeb + cashDeb` 記錄，行為等同今日）
- `ProcessGameInsertRefund` 新簽章：`(ctx, accountID, playDeb, cashDeb decimal.Decimal, referenceID string) (newPlay, newCash decimal.Decimal, err error)`
- 內部：tx 內對兩欄分別 `IncrementXxx`，並對應寫入 `ActionGameInsertRefund` ledger（每種幣各一筆，若該幣為 0 則略過）
- 移除 `ActionExchangeCashPlay` 常數（無引用）

**Patterns to follow:**
- 鄰近 `ProcessDeposit`（line 86）—— 在同一 tx 內多次寫 ledger 的範式
- `metrics.ProgressMetricErrors` 錯誤容忍範式

**Test scenarios:**
- Happy path (純 play): `play=10, cash=0, count=3` → `playDeb=3, cashDeb=0`；ledger 有一筆 PLAY entry，無 CASH entry
- Happy path (純 cash): `play=0, cash=10, count=3` → `cashDeb=3, playDeb=0`；ledger 有一筆 CASH entry，無 PLAY entry
- Happy path (混合): `play=2, cash=5, count=4` → `playDeb=2, cashDeb=2`；**兩筆** ledger entries 共用同一 `referenceID`，currencies 分別為 PLAY / CASH
- Error path: `play=1, cash=1, count=3` → `ErrInsufficientBalance`；無任何 ledger 寫入；兩欄餘額未變更
- Happy path (refund, 混合): `playDeb=2, cashDeb=3, referenceID="ref-X"` → 兩欄各自 increment，ledger 兩筆 refund entries
- Happy path (refund, 純 play): `playDeb=5, cashDeb=0` → 只寫一筆 PLAY refund entry
- Integration: insert 後立刻 refund 同樣 split → 兩欄餘額回到 insert 前

**Verification:**
- Unit tests 覆蓋上述所有 scenario
- 單一 `referenceID` 可在 ledger 中查到 1 或 2 筆 insert entry（視 split 而定）
- `ActionExchangeCashPlay` 常數從 model.go 移除，`go build ./...` 通過

---

- [ ] **Unit 3: `game.Core` 與 `GameEventResult` 傳遞 split + cash balance**

**Goal:** 更新 `game.Core` 的四個呼叫點以使用新簽章；`GameEventResult` 攜帶兩個餘額與 split；`RefundBatchInsert` 接受明確 `(playDeb, cashDeb)`。

**Requirements:** R3, R4

**Dependencies:** Unit 2

**Files:**
- Modify: `backend/business/core/game/game.go`
- Modify: `backend/business/core/game/model.go`（`GameEventResult` 欄位）
- Test: `backend/business/core/game/game_test.go`

**Approach:**
- `GameEventResult` 新增：`BalanceCash string`、`PlayDebited string`、`CashDebited string`（皆為 decimal 字串，與既有 `BalancePlay` 一致）
- `processInsertCoin` / `processSpawnStack` / `ProcessBatchInsert`：接 `ProcessGameInsert` 新回傳值，填入 result
- `RefundBatchInsert` 新簽章：`(ctx, accountID, playDeb, cashDeb decimal.Decimal, referenceID string) (GameEventResult, error)`；caller 必須帶入 split
- 正值 vs 小數字串格式化沿用 `newPlay.String()` 慣例

**Patterns to follow:**
- 既有 `GameEventResult.BalancePlay` 的序列化
- 鄰近 `ProcessBatchInsert` 的 Success/Error 範式

**Test scenarios:**
- Happy path: insert 混合扣款 → result 包含 `BalancePlay`, `BalanceCash`, `PlayDebited`, `CashDebited` 四欄皆正確
- Happy path: insert 純 play → `CashDebited = "0"`，`BalanceCash` 不變
- Error path: 餘額不足 → `Success=false`，無需填 balance 欄位（或填空字串）
- Happy path (refund): 給定 split → 兩個 balance 正確回復

**Verification:**
- Unit tests 通過
- 所有既有 `game_test.go` 用例更新後通過

---

- [ ] **Unit 4: HTTP `BatchInsert` handler 與 response 型別更新**

**Goal:** HTTP `POST /v1/game/batch-insert` response 同時回傳 `balance_play` + `balance_cash`；refund 路徑使用保留的 split。

**Requirements:** R3, R4

**Dependencies:** Unit 3

**Files:**
- Modify: `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go`
- Test: `backend/app/services/api/handlers/v1/gamegrp/gamegrp_test.go`

**Approach:**
- `BatchInsertResponse` 修改：移除 `Balance string`，新增 `BalancePlay string \`json:"balance_play"\`` 與 `BalanceCash string \`json:"balance_cash"\``
- Handler 在 `ProcessBatchInsert` 成功後，在 refund 失敗路徑上傳入 `playDebited, cashDebited` 給 `RefundBatchInsert`（由 `result` 取得，轉為 decimal）
- 保持原 `refundKey`（不同 reference_id）行為，但改為傳 split 值

**Patterns to follow:**
- 既有 `BatchInsertResponse` 序列化與錯誤處理

**Test scenarios:**
- Happy path: 回傳 JSON 同時包含 `balance_play` 與 `balance_cash` 字串欄位，且數值正確
- Happy path (混合扣款): response 中 `balance_play` 下降、`balance_cash` 也下降
- Error path (`count > 100`): 維持 `StatusBadRequest`，行為不變
- Error path (餘額不足): `StatusBadRequest` with `insufficient balance` error（依 Unit 2 錯誤訊息）
- Integration: NATS publish 失敗 → refund 被呼叫並帶入正確 split，兩欄餘額還原

**Verification:**
- `gamegrp_test.go` 更新後通過
- 手動 curl / Postman 驗證 response shape

---

- [ ] **Unit 5: WS `batch_insert_ack` 訊息與 handler 更新**

**Goal:** WS `batch_insert_ack` 同時回傳 `balance_play` + `balance_cash`；refund 傳 split。

**Requirements:** R3, R4

**Dependencies:** Unit 3

**Files:**
- Modify: `backend/business/web/ws/handler.go`
- Modify: `game/shared/src/types.ts`（`BatchInsertAckMessage` 型別）
- Modify: `game/client/src/net/GameClient.ts`（`BatchInsertAckCallback` 簽章與 switch case）
- Modify: `game/client/src/App.tsx`（`onBatchInsertAck` 接線處，更新 `setBalance` / `setBalanceCash`）
- Test: 不新增後端測試（目前 ws handler 無 unit test 覆蓋此路徑）；client 端以手動整合驗證
- Test（前端邊界）: `game/client/src/App.tsx` 的狀態更新若有既有測試則對應更新

**Approach:**
- `handler.go` 三處 `batch_insert_ack` map 中的 `balance` 欄位改為 `balance_play` + `balance_cash`（錯誤路徑只需保留 `queued/error`，不需 balance）
- `handler.go` 的 refund 呼叫（line 709）改為傳入 split（由 `result.PlayDebited` / `result.CashDebited` parse）
- `types.ts` `BatchInsertAckMessage` 新增兩個可選欄位 `balance_play?: string`、`balance_cash?: string`，移除舊的 `balance?: string`
- `GameClient.ts` `BatchInsertAckCallback` 簽章改為 `(queued, error?, balancePlay?, balanceCash?)`
- `App.tsx` 的 `onBatchInsertAck` 拿到兩個值後呼叫 `setBalance` 與 `setBalanceCash`

**Patterns to follow:**
- 既有 `reward` 訊息攜帶 `balance` 的反序列化

**Test scenarios:**
- Integration (manual): WS 模式投幣 → PlayerInfo 兩個餘額數字即時更新
- Integration (manual): NATS 失敗 refund 後，兩個餘額數字恢復至 insert 前

**Verification:**
- 前端 type check 通過
- 手動端對端測試：投幣後 balance_play 下降；play 歸零後投幣，balance_cash 下降

---

- [ ] **Unit 6: 前端 UI 合併顯示 + InfoTip 文案**

**Goal:** `PlayerInfo` 顯示單一 `Balance` 總額 + 下方小字 `Withdrawable: X`；移除舊的雙欄 `Play / Cash`；InfoTip 文案解釋扣款順序。

**Requirements:** R5, R6

**Dependencies:** Unit 5（前端型別已更新）

**Files:**
- Modify: `game/client/src/ui/PlayerInfo.tsx`
- Modify: `game/client/src/ui/PlayerInfo.css`（若樣式需要調整）
- Modify: `game/client/src/pages/WithdrawPage.tsx`（文案從 "Cash coin" 改為 "Withdrawable balance"，上限仍為 `balance_cash`）
- Test: 既有 snapshot / unit tests 若有則更新（目前 PlayerInfo 無 unit test 檔）

**Approach:**
- `PlayerInfoProps` 維持 `balancePlay` + `balanceCash` 兩個 props；內部計算 `total = parseFloat(balancePlay) + parseFloat(balanceCash)`
- 展開模式：主 row 顯示 `Balance: [total] [InfoTip]`，下方 sub-row 顯示 `Withdrawable: [balanceCash]`
- Collapsed mobile 模式：顯示單一合併數字（可選擇同樣附 withdrawable 小字，依空間）
- InfoTip 文案：
  > `Your balance is the sum of play coins and withdrawable rewards. Inserting coins consumes play coins first; once play coins are empty, withdrawable rewards will be used. Only withdrawable balance can be withdrawn.`
- `WithdrawPage`：UI label 由 `Cash` / `Cash coin` 改為 `Withdrawable balance`，values 與行為不變

**Patterns to follow:**
- 現有 `InfoTip` 使用（line 75, 78）
- 現有 `fmt()` 格式化

**Test scenarios:**
- Visual: `balance_play=100, balance_cash=30` → 顯示 `Balance: 130`、`Withdrawable: 30`
- Visual: `balance_play=0, balance_cash=50` → `Balance: 50`、`Withdrawable: 50`
- Visual: `balance_play=100, balance_cash=0` → `Balance: 100`、`Withdrawable: 0`
- Visual: InfoTip hover/tap 顯示正確文案
- Visual (WithdrawPage): 顯示 `Withdrawable balance: [balance_cash]`；可提上限仍為 `balance_cash`

**Verification:**
- 手動 QA 三種餘額組合
- 型別檢查通過
- 既有 withdraw flow 仍可正常提現（submit amount <= balance_cash）

---

- [ ] **Unit 7: Client `auth.ts` 與其他 balance 顯示點審視**

**Goal:** 確保所有讀 `balance_play` / `balance_cash` 的前端位置行為正確（尤其 `/auth/me` refresh 後）。

**Requirements:** R5, R6

**Dependencies:** Unit 6

**Files:**
- Modify: `game/client/src/net/auth.ts`（若 Account 型別需註解）
- Modify (review only): `game/client/src/pages/ProgressPage.tsx`, `ChestPage.tsx`, `net/ProgressClient.ts`, `net/InventoryClient.ts` —— 依現狀多半為只讀顯示，確認不需改
- Test: 既有測試若有則更新

**Approach:**
- 逐一審視 6 個檔案（見 grep 結果）確認：
  - 若檔案呈現「Play coin」獨立數字（如 missions 頁），保留但考慮加短說明或改稱「Play」本身語意
  - 若檔案計算總額做判斷（例如可投上限），應改為 `balance_play + balance_cash`
- 此 unit 為審視 + 必要時微調；不強制改動

**Patterns to follow:**
- Unit 6 的合併呈現 pattern

**Test scenarios:**
- Test expectation: review + smoke test only（若無行為變更則不新增測試）

**Verification:**
- 手動走過 `/progress`、`/chest` 頁面，確認顯示合理無錯亂

## System-Wide Impact

- **Interaction graph:** `gamegrp.BatchInsert` HTTP handler、`ws.Handler.handleBatchInsert` WS handler、`game.Core`、`accounting.Core`、`user.Core` 全線簽章變更；前端 `App.tsx` ↔ `GameClient.ts` ↔ `PlayerInfo.tsx` 對應更新。
- **Error propagation:** 餘額不足錯誤從 `user.Core.DecrementForInsert` 冒泡到 `accounting` → `game` → handler；HTTP 回 `400 Bad Request`，WS 則靜默（維持現況行為）。
- **State lifecycle risks:** Insert 與 refund 必須用相同 split；若 caller 傳錯 split，refund 會造成帳目不平。單元測試必須驗證 insert 回傳的 split 與 refund 接收的 split 一致。
- **API surface parity:** HTTP `BatchInsertResponse` 與 WS `batch_insert_ack` 兩個 payload 形狀必須同步更新（兩邊前端都讀）。
- **Integration coverage:** Mocks 無法證明「NATS publish 失敗 → refund 用正確 split → 兩欄餘額都回復」的完整流程；需手動整合驗證（或新增 integration test）。
- **Unchanged invariants:** `balance_play` / `balance_cash` DB 欄位不動；withdraw flow（`RequestWithdrawal` 與其 `DecrementCashBalance` 路徑）完全不變；`ProcessGameReward` 仍只 credit `balance_cash`；deposit 仍按 currency 入對應欄位。

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Insert / refund split 不一致導致帳目漂移 | Caller 直接傳遞 split（不查 DB），且單元測試對混合扣款 + refund 做 round-trip 驗證 |
| WS 與 HTTP 兩個 payload 不同步（只改一個會讓部分客戶端顯示錯誤） | Unit 4 + Unit 5 必須一併落地；前端 type 變更會編譯失敗，作為 fail-fast 防線 |
| 用戶心理感受「withdrawable 變少了」— 即使有 InfoTip 仍可能客訴 | Play-first 扣款順序將此風險降到最低；InfoTip 文案明確說明；後續可觀察客訴數據再決定是否加 toast |
| 既有 `refundKey` 與 `insertRefKey` 不同的歷史包袱 | 本計畫不改變 reference_id 策略（refund 仍用新 key）；僅將 split 從「coinCount」改為「(playDeb, cashDeb)」，對稽核軌跡為加強（兩筆 refund entries 對應兩筆 insert entries） |
| DB migration 風險 | 無 migration；schema 零變動 |

## Documentation / Operational Notes

- `docs/brainstorms/2026-04-12-unified-wallet-insert-requirements.md` 為 origin，無需更新
- `docs/security-audit.md` 提到的 refund ledger 不變性仍然成立（事實上更細緻：每種幣各一筆）
- 無 feature flag；變更為一次性上線（前後端必須同時部署，因應 payload shape 變更）
- 建議部署時序：backend 先（兼容舊前端? 不，因為 `balance_play`/`balance_cash` 是新欄位） → 前後端同步 release 為佳

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-12-unified-wallet-insert-requirements.md](../brainstorms/2026-04-12-unified-wallet-insert-requirements.md)
- Related code:
  - `backend/business/core/accounting/accounting.go`
  - `backend/business/core/game/game.go`
  - `backend/business/core/user/user.go`
  - `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go`
  - `backend/business/web/ws/handler.go`
  - `game/client/src/ui/PlayerInfo.tsx`
- Related security audit note: `docs/security-audit.md:293`
