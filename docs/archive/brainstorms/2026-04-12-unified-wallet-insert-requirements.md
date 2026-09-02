---
date: 2026-04-12
status: superseded
reviewed: 2026-09-02
outcome: "Became docs/plans/2026-04-12-001, shipped."
---

# Unified Wallet for Coin Insert — Requirements

**Date:** 2026-04-12
**Status:** Ready for planning

## Problem

目前只有 `balance_play` 可以用來投幣；`balance_cash` 只能提現。這個分離造成：

1. 用戶贏了 cash coin 想繼續玩必須先提現或先買 play coin（流程中斷）
2. Play coin 用完時體驗被打斷
3. 贏到的 cash coin 無法再投入，經濟循環斷裂，LTV 受限
4. 用戶實際反映「為什麼我贏的錢不能投」

## Goal

讓 cash coin 也能用來投幣，但不讓用戶覺得「我不小心把可提現的錢花掉了」。

## Non-goals

- 不改動 `balance_play` / `balance_cash` 的 DB schema
- 不改動 ledger 的 currency 語意（PLAY / CASH / USDC 仍分開記）
- 不改動 withdraw 流程（仍只從 `balance_cash` 扣）
- 不引入 cash↔play 的匯率轉換（兩者維持 1:1 等值）
- 不實作遺留的 `ActionExchangeCashPlay`（該常數可清掉或留待後續）

## Chosen Approach: 「Schema 不動 + UX 合併 + 分層扣款」

### Insert 扣款邏輯（play-first）

當用戶投入 N 個 coin，在單一 DB transaction 內：

1. 先從 `balance_play` 扣，扣到 0 或扣滿 N 為止
2. 不足的部分從 `balance_cash` 扣
3. 若兩者合計仍不足 N，整筆交易 rollback（同今日「餘額不足」行為）
4. 為實際扣到的每種幣各寫一筆 ledger entry：
   - e.g. 投 5 coin，play 扣 3、cash 扣 2 → 兩筆 `ActionGameInsert`，一筆 currency=PLAY amount=3，一筆 currency=CASH amount=2
   - 共用同一 `reference_id`（便於 refund 對應）

**選擇 play-first 而非 cash-first 的理由：**
- 符合「贏來的錢是我的」心理模型，避免「偷花我的提現餘額」客訴
- 經濟循環仍會發生 — 只要用戶持續玩，cash coin 遲早被消耗
- Cash-first 會強迫 withdrawable 立刻下降，短期 KPI 好看但長期客訴風險高

### Refund 邏輯（GameInsertRefund）

Refund 必須精準還原扣款拆分：
- 透過同 `reference_id` 查詢所有 insert ledger entries
- 對每筆 entry 按其 currency 還款（play 還給 play、cash 還給 cash）
- 寫對應的 `ActionGameInsertRefund` entries（同樣拆分、同 reference_id）

這保證：任何中間狀態失敗（NATS publish 等）都能精確回滾，不會把 cash coin 變成 play coin 或反之。

### 前端 UX

**錢包顯示改為單一數字：**
```
Balance: 150   [?]
         withdrawable: 30
```

- 主數字 = `balance_play + balance_cash`
- 小字顯示 `withdrawable`（= `balance_cash`）
- 旁邊 `[?]` 使用現有的 `InfoTip.tsx` 元件，hover/tap 顯示完整說明：

  > 你的餘額由兩部分組成：play coin（投幣用）和 withdrawable coin（可提現）。投幣時會**先使用 play coin**，用完後才會動用 withdrawable coin。只有 withdrawable 的部分可以提現。

**提現頁（WithdrawPage）:**
- 可提金額上限仍 = `balance_cash`（後端約束不變）
- UI 文案從「Cash coin」改為「Withdrawable balance」以呼應新語彙

### 不需要做的事

- ❌ 投幣時的 toast 提示（被 InfoTip 吸收，避免打斷）
- ❌ Settings 開關（play-first 已經足夠保守，無需再給一層保護）
- ❌ DB migration
- ❌ Ledger schema 改動

## Success Criteria

1. 用戶在 `balance_play=0, balance_cash>0` 時仍可正常投幣
2. 投幣時優先消耗 `balance_play`，歸零後才動用 `balance_cash`
3. Ledger 對每次混合投幣正確寫入兩筆 entry，currency 分別為 PLAY / CASH
4. Insert 失敗 refund 時，play 與 cash 各自還回正確金額
5. 前端錢包顯示單一合併數字 + withdrawable 子標示
6. InfoTip hover 文案正確解釋兩種幣與扣款順序
7. 提現功能行為不變，上限仍為 `balance_cash`

## Open Questions for Planning

1. `ProcessGameInsert` 函式簽章是否回傳 split 資訊給上游（NATS publish / 客戶端）？還是只回傳合計 new balance？
   - 建議：回傳 `(newPlay, newCash)` 兩個值，客戶端自行合併顯示，對除錯也友善
2. WS 協定（`game/shared/src/types.ts` 的 player state）是否要同時送 `balance_play` + `balance_cash`？
   - 建議：兩個都送，前端合併；避免後端做合計讓語意變糊
3. 現有 `ActionExchangeCashPlay` 常數是否移除？
   - 建議：移除（model.go:15），無引用
4. `DecrementPlayBalance` / `DecrementCashBalance` 是否需要包一層 `DecrementForInsert(playFirst=true)` 的高階函式？
   - 交由 planning 決定

## Files Likely Affected

- `backend/business/core/accounting/accounting.go` — `ProcessGameInsert` / `ProcessGameInsertRefund`
- `backend/business/core/accounting/model.go` — 移除未使用常數
- `backend/business/core/user/user.go` — 可能需要組合 decrement helper
- `backend/app/services/api/handlers/v1/depositgrp/` — 若 insert endpoint 回傳結構改變
- `game/shared/src/types.ts` — player state balance 欄位
- `game/client/src/ui/PlayerInfo.tsx` — 合併顯示 + InfoTip
- `game/client/src/pages/WithdrawPage.tsx` — 文案調整
- `game/server/src/simulation/` — 若需要感知餘額（通常 insert 是 HTTP 非遊戲迴圈）
- 對應的 `*_test.go` 測試更新（accounting_test、depositgrp_test）
