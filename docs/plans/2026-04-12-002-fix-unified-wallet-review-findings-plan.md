---
title: Fix Unified Wallet Review Findings (P1 + P2, conf > 0.6)
type: fix
status: completed
date: 2026-04-12
origin: docs/plans/2026-04-12-001-feat-unified-wallet-insert-plan.md
---

# Fix Unified Wallet Review Findings (P1 + P2, conf > 0.6)

## Overview

Address the P1 and P2 findings (confidence > 0.6) raised during `ce:review` on the `feat/unified-wallet-insert` branch before merge. The upstream feature plan (`2026-04-12-001-feat-unified-wallet-insert-plan.md`) delivered the split-aware insert/refund architecture correctly, but the review surfaced concrete reliability, idempotency, observability, and UX gaps that should be closed before production. The SEC-001 schema fix (unique index on `(action_type, reference_id, currency)`) was already applied inline during review and is not in scope here.

## Problem Frame

The split-insert feature introduced three new surfaces of risk that the review consolidated into 13 actionable findings:

1. **Refund fragility.** The refund flow parses debit amounts from strings with ignored errors, uses the HTTP request context (which may be cancelled exactly when the refund is needed), and has no idempotency guard — so any retry silently double-credits. (P1-1, P1-2, P1-3; 3-4 reviewer consensus on each.)
2. **Weak boundaries on `DecrementForInsert`.** The primitive is exported, which means a future caller outside `execTx` could produce a partial-debit without rollback. (P1-4.)
3. **Observability and UX gaps.** Debit split is not exposed in responses, the WS refund-split path is untested, the `Withdrawable` UI label lost its tooltip, `docs/spec.md` still describes the pre-split model, and the `TestBatchInsert_ResponseShape` test bypasses the real HTTP handler. (P1-5 + P2-6, P2-7, P2-8, P2-9, P2-11, P2-12, P2-13, P2-14.)

See review findings #1–#14 in the conversation log preceding this plan.

## Requirements Trace

- R1. Refund path correctly reverses the exact per-currency split even under transient failure; ignored parse errors are eliminated (addresses P1-1)
- R2. Refund is idempotent — a retry of `ProcessGameInsertRefund` with the same correlation key must not double-credit (P1-2)
- R3. HTTP `BatchInsert` refund survives request-context cancellation (P1-3)
- R4. `DecrementForInsert` cannot silently corrupt balances when called outside a transaction (P1-4)
- R5. WS `batch_insert` refund-split path has regression coverage (P1-5)
- R6. HTTP and WS insert responses expose per-currency debit split so clients/agents can verify what was consumed (P2-6)
- R7. Unified wallet UI preserves the tooltip that previously explained what "withdrawable" means and how it is earned (P2-7)
- R8. `docs/spec.md` reflects the current unified-wallet / play-first semantics (P2-8)
- R9. The HTTP end-to-end response shape is tested through the real handler, not a struct stub (P2-9)
- R10. `QueryByReference` has a variant that returns all rows so future audit callers cannot silently drop a CASH leg (P2-11)
- R11. `PROTOCOL_VERSION` is bumped to signal the WS `batch_insert_ack` shape change (P2-12)
- R12. `WithdrawPage.tsx` wording is internally consistent after the "Cash Coins" removal (P2-13)
- R13. `GameEventResult` no longer carries two flavors of concern (response shape + in-process split carry) — or the coupling is documented if we choose to keep it (P2-14)

## Scope Boundaries

- Not fixing pre-existing issues flagged as "not caused by this PR" (heat rollback on refund, process-crash-between-debit-and-publish, metric recorder timeout). Those become separate follow-up tickets, not this plan.
- Not refactoring the `GameEventResult` struct into a new value type this pass if a minimal fix (explicit typed-return alongside the response struct) is sufficient — default to the minimal change, flag the larger refactor as a deferred option (see R13).
- Not introducing external retries or a dead-letter queue for refund — idempotency + deterministic correlation IDs is the scope; durable retry infrastructure is future work.
- Not touching the withdraw flow; withdraw continues to only debit `balance_cash`.
- Not bumping API version or introducing a v2 endpoint — `PROTOCOL_VERSION` and deployment ordering are the mitigation for breaking WS shape.

## Context & Research

### Relevant Code and Patterns

- **Idempotency precedent:** `backend/business/core/accounting/accounting.go` `ProcessDeposit` uses `storer.QueryByReference(ctx, ActionDeposit, referenceID)` inside the same `execTx` to detect replay. This is the canonical pattern to follow for refund idempotency.
- **Fresh-context refund precedent:** `backend/business/web/ws/handler.go` already uses `context.Background()` in its refund call. The HTTP handler (`backend/app/services/api/handlers/v1/gamegrp/gamegrp.go`) should mirror it.
- **Ignored-error refund sites:**
  - `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go` (refund block, around lines 119-130)
  - `backend/business/web/ws/handler.go` (refund block, around lines 705-715)
- **Ledger QueryByReference implementation:** `backend/business/core/accounting/stores/ledgerdb/ledgerdb.go` — single-row `GetContext`. Needs a `QueryAllByReference` companion.
- **Shared TS protocol:** `game/shared/src/types.ts` contains `PROTOCOL_VERSION` constant and `BatchInsertAckMessage` type.
- **InfoTip pattern:** `game/client/src/ui/InfoTip.tsx` is the existing hover-help component; the `Withdrawable` label in `PlayerInfo.tsx` previously used it.
- **Canonical Go balance mutation test harness:** `backend/business/core/accounting/accounting_test.go` `TestProcessGameInsertRefund` — mirror its split-refund scenario pattern for new idempotency tests.
- **HTTP handler integration test precedent:** `backend/app/services/api/handlers/v1/gamegrp/gamegrp_test.go` `TestBatchInsert_CountExceedsMax` uses `httptest.NewRecorder` + `errHandler(log, grp.BatchInsert)` — follow the same shape for the new end-to-end response-shape test.
- **WS handler test skeleton:** `backend/business/web/ws/handler_test.go` currently only covers megaspeaker. We need to add the first `batch_insert` test; if the helper plumbing is thin, supplement minimally rather than building a whole test harness from scratch.

### Institutional Learnings

- `docs/security-audit.md:100-108` (P0-8): Deposit idempotency was hardened by moving the `QueryByReference` check inside `execTx`. Refund currently lacks this guard — fixing it is the direct analog of that hardening.
- `docs/security-audit.md:291-296` (P1-14, 2026-03-01): The refund-on-NATS-failure path was the predecessor work to this feature; it predates per-currency split. Our fix extends that hardening to cover idempotency and parse-error robustness that were implicit assumptions when refund credited a single currency.
- `docs/backend-optimization.md:42-68` (Priority 2b): "Debit and ledger INSERT must be in one transaction." Already followed by current code; no change needed but confirms single-tx invariants for any new refund-inside-tx logic.
- `docs/security-audit.md:272-288` (P1-13): The learnings researcher flagged this as a latent RETURNING-clause bug. **Verified during review — this has already been fixed in the code; only the documentation comment at `backend/business/core/user/stores/userdb/userdb.go:131-133` and the local variable name `balPlay` are stale.** Not in scope for this plan beyond a doc touch-up if time permits.

### External References

None needed — all patterns are local.

## Key Technical Decisions

- **Deterministic refund correlation ID.** Derive the refund's `referenceID` from the insert's `referenceID` (suffix pattern, e.g., `<insert-ref>:refund`). This makes refund lookups deterministic, makes idempotency guards effective (a retried refund hashes to the same ID), and makes audit-trail correlation trivial. Rationale: uniform correlation is more valuable than using a fresh UUID per attempt.
- **Refund idempotency check inside tx.** Mirror `ProcessDeposit`'s pattern: `QueryByReference(ctx, ActionGameInsertRefund, referenceID)` inside `execTx`; on hit, short-circuit with success. Rationale: consistency with existing pattern; atomic with the credit.
- **HTTP refund uses `context.Background()`.** Mirror the WS handler's existing pattern. Rationale: refund must survive request-context cancellation; refund is fire-and-forget from the request's perspective.
- **Parse errors on `result.PlayDebited` / `result.CashDebited` are fatal.** Return an error instead of silently passing `decimal.Zero`. Increment `BatchInsertRefundFailures` and log with full context. Rationale: a silent zero-refund causes permanent fund loss; explicit failure is observable and alertable.
- **`DecrementForInsert` protection: doc + regression test + convention, not refactor.** Strengthen the doc comment to "MUST be called inside execTx; behavior is undefined otherwise"; add a regression test that asserts the rollback path with a tx mock. Rationale: a full refactor (tx-context marker type) is high-cost; the risk is theoretical (no current misuse); strong documentation + regression test is proportionate.
- **Add `QueryAllByReference` for split-aware audit.** Keep singular `QueryByReference` for idempotency lookup (where the first-row-match semantics happen to be fine). Introduce `QueryAllByReference` returning `[]AccountingLog` for any future caller that needs the full split. Rationale: non-breaking, future-proof, avoids accidentally double-changing behavior of current callers.
- **Expose split in HTTP + WS responses (R6).** Add `play_debited` + `cash_debited` fields to both payloads; the data is already on `GameEventResult`. Rationale: 2-line change per handler; improves agent-accessibility and debugability; fulfils "agent-native parity" review finding.
- **Keep `GameEventResult` as-is for this plan (R13).** Accept the string-based split carry for now. Rationale: the typed-value refactor is a cleanup, not a correctness fix, and introducing an `InsertSplit` value type ripples through 4 callers. Flag it as deferred work.
- **Bump `PROTOCOL_VERSION` to 2.** Rationale: WS `batch_insert_ack` message shape changed (field renames + additions). Bumping is cheap and signals compatibility; CDN-cached clients that gate on version can force reload.
- **Restore `Withdrawable` tooltip (R7).** Add an `InfoTip` to the `Withdrawable` row explaining how it is earned and that only it can be withdrawn — salvaging the content the previous UI had before the merge. Rationale: zero-cost UX restoration; removes a regression from the merge.
- **`docs/spec.md` update (R8).** Rewrite the "Economy / Balance Model" section to describe unified wallet + play-first draw. Rationale: canonical source for AI players / future contributors; drift from code is a context-starvation bug.
- **WithdrawPage wording sweep (R12).** Settle on one canonical term ("coins") and apply consistently across min-withdrawal error, fee row, amount input label, and history column. Rationale: 4 reviewer findings converge here; UX consistency is cheap.

## Open Questions

### Resolved During Planning

- Q: Should the refund idempotency guard return success (no-op) or error on replay? → A: Return success with the existing balances read fresh, mirroring `ProcessDeposit`'s silent dedup. Callers already ignore the refund's return value.
- Q: Refund correlation ID format? → A: `<insert-ref>:refund` — simple, collision-free within the insert's namespace.
- Q: `DecrementForInsert` hardening strategy — unexport / runtime guard / refactor? → A: Doc + regression test + convention. Refactor is over-engineering; unexporting breaks accounting's legitimate cross-package use; runtime guard requires threading a tx-marker through signatures.
- Q: `PROTOCOL_VERSION` 1 → 2 or stay at 1? → A: Bump to 2.
- Q: `GameEventResult` refactor now or later? → A: Later. Flag as deferred.
- Q: Should we remove `ActionExchangeCashPlay` from the schema `CHECK` constraint? → A: No — it's defensive history, harmless, and removing it requires a constraint DROP/ADD migration.

### Deferred to Implementation

- Exact test harness shape for the first `handler_test.go` batch_insert test (what mock NATS / mock game core interface emerges naturally) — decide while writing it.
- Whether the spec.md rewrite needs new diagrams or prose only — decide while editing; lean prose-first.
- Whether `QueryAllByReference` belongs in the same file or a new one — trivial, decide while touching the Storer interface.

## Implementation Units

- [ ] **Unit 1: Harden refund error handling (parse + context)**

**Goal:** Eliminate silent fund-loss modes in both refund call sites. Parse errors on `PlayDebited`/`CashDebited` become fatal + observable; HTTP refund uses `context.Background()` like the WS one already does.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go`
- Modify: `backend/business/web/ws/handler.go`
- Test: `backend/app/services/api/handlers/v1/gamegrp/gamegrp_test.go`
- Test: `backend/business/web/ws/handler_test.go` (new test — see also Unit 4)

**Approach:**
- In both refund sites, check the error returned by `decimal.NewFromString` for both `PlayDebited` and `CashDebited`. On any parse error, log with full context (user_id, count, raw strings), increment `metrics.BatchInsertRefundFailures`, and return/abort *without* calling `RefundBatchInsert`. Rationale: crediting a silent zero is worse than failing loudly.
- In `gamegrp.go`, replace the `ctx` passed to `RefundBatchInsert` with `context.Background()`. Keep the original request `ctx` for any observability spans but not for the DB tx.
- Double-check there is no other ignored-error `_ :=` pattern in the refund paths introduced by this feature.

**Patterns to follow:**
- WS handler's existing `context.Background()` usage in its refund call
- Existing `metrics.BatchInsertRefundFailures.Inc()` error-path pattern

**Test scenarios:**
- Error path: set `result.PlayDebited = ""` and inject NATS publish failure → HTTP handler returns error, no `RefundBatchInsert` call, `BatchInsertRefundFailures` incremented
- Error path: set `result.CashDebited = "NaN"` → same as above
- Happy path: normal split → refund called with correct `(playDeb, cashDeb)`, no error
- Integration: HTTP handler with cancelled request context + NATS publish failure → refund still completes (asserts `context.Background()` is in effect)

**Verification:**
- Tests pass
- Manual grep: no `decimal.NewFromString(...)` with `_` discard remains in the refund paths
- Grep confirms only `context.Background()` is used for `RefundBatchInsert` calls

---

- [ ] **Unit 2: Refund idempotency + deterministic correlation ID**

**Goal:** `ProcessGameInsertRefund` is idempotent — a retry with the same correlation ID must not double-credit. The refund correlation ID is derived deterministically from the insert ID.

**Requirements:** R2

**Dependencies:** Unit 1 (same files touched; land sequentially to keep diffs small)

**Files:**
- Modify: `backend/business/core/accounting/accounting.go`
- Modify: `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go`
- Modify: `backend/business/web/ws/handler.go`
- Test: `backend/business/core/accounting/accounting_test.go`

**Approach:**
- In `ProcessGameInsertRefund`, inside `execTx`, call `storer.QueryByReference(ctx, ActionGameInsertRefund, referenceID)`. If a row is found, short-circuit: read current balances via `userCore.QueryByID` and return them. If `ErrNotFound`, proceed with the credit + log writes as today.
- In both call sites (HTTP + WS), replace `refundKey := uuid.NewString()` with a deterministic derivation from the insert's reference ID: `refundKey := insertRefKey + ":refund"` (pick the exact separator during implementation — colon is safe since both keys are UUID-like today).
- Ensure the insert's reference key is in scope at the refund call site (HTTP handler already has `refKey` at line 89; WS handler has it at line 675).

**Patterns to follow:**
- `ProcessDeposit` at `accounting.go:86-123` — this is the canonical idempotency pattern to mirror, including the error-type check `errors.Is(err, v1.ErrNotFound)`.

**Test scenarios:**
- Happy path: first call credits normally, ledger entries written
- Idempotency: second call with same `referenceID` returns success, reads current balances, writes no additional ledger entries, does not double-credit
- Idempotency on mixed split: first call credits `(play=2, cash=3)`; second call with same refID is a no-op and balances match the first-call post-state
- Error path: underlying storer error on QueryByReference propagates correctly

**Verification:**
- Tests pass
- Grep confirms no `uuid.NewString()` remains in the refund paths for the correlation ID
- The two refund entries (PLAY + CASH) still share the same `referenceID` (consistent with the unified index fix)

---

- [ ] **Unit 3: Protect `DecrementForInsert` from out-of-tx misuse**

**Goal:** Make it loud and obvious when `DecrementForInsert` is called outside a transaction — via documentation, regression test, and (if low-cost) convention mechanism. Do not restructure the user.Core API.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `backend/business/core/user/user.go` (doc comment on `DecrementForInsert`)
- Test: `backend/business/core/user/user_test.go`

**Approach:**
- Expand the doc comment on `DecrementForInsert` to state unambiguously: the caller MUST provide a transaction-bound `Storer`; behavior is undefined (fund leak possible) if called outside `execTx`. Include the rationale: the primitive issues two sequential writes and relies on DB rollback for atomicity.
- Add a regression test that simulates a failure on the second `UpdateBalance` call (mock the storer to succeed on `CurrencyPlay` and fail on `CurrencyCash`). Assert that the returned error surfaces the failure and — importantly — document via the test name and comment that the caller (via execTx) is responsible for rolling back the play debit. Test purpose: pin the contract so any change to the order of writes is visible.
- Consider (judgement call during implementation) whether a sentinel interface like `type TxStorer interface { IsTxBound() bool }` adds value or is YAGNI. Lean YAGNI; skip unless trivial.

**Test scenarios:**
- Error path: storer mock returns error on second `UpdateBalance` (CASH) → `DecrementForInsert` returns that error, PLAY was written first, the test's comment explains rollback responsibility lies with execTx

**Verification:**
- Doc comment explicitly names the contract and the failure mode
- Regression test passes and serves as contract documentation

---

- [ ] **Unit 4: WS `batch_insert` refund-split test**

**Goal:** First regression test for the WS handler's refund path. Proves that when NATS publish fails after a split debit, the refund receives the correct per-currency amounts and uses `context.Background()`.

**Requirements:** R5

**Dependencies:** Unit 1 (the WS handler's error-handling behavior must be finalized first), Unit 2 (idempotency affects refund semantics)

**Files:**
- Test: `backend/business/web/ws/handler_test.go` (new `batch_insert` test — add first-of-kind for this handler)

**Approach:**
- Introduce the minimal harness needed: a mock/stub NATS connection whose `Publish` returns a controlled error, plus a mock `gameCore` that can be injected into the WS handler. Reuse the `mockUserStorer` / `mockAcctStorer` style from existing `*_test.go` files in `backend/business/core/` rather than inventing a new mocking style.
- Test exercises: seed account with `play=2, cash=10`; WS client sends `batch_insert` for count=5; `nc.Publish` returns error; refund fires.
- Assert: refund was called with `(playDeb=2, cashDeb=3, refID=<insertRef>:refund)`; post-state balances match the pre-insert state (full restoration); if user visible ACK is sent, it carries the restored balances.
- If the existing WS handler harness is too thin to set up cleanly, document what's missing and add the minimum wiring (for example, making `gameCore` a pluggable interface on `Handler`) — but keep scope-bounded to what this test needs.

**Patterns to follow:**
- `game_test.go` `TestRefundBatchInsert_RoundTrip` for the roundtrip assertion style
- `gamegrp_test.go` for HTTP-style handler test harness

**Test scenarios:**
- Integration: WS batch_insert with mixed-split input + NATS publish failure → refund fires with correct split, balances restored
- Integration: same as above but with idempotent retry (caller invokes refund twice with same derived refID) → second call is a no-op
- Edge case: insert succeeds, NATS publish succeeds → no refund is attempted; balances reflect the debit

**Verification:**
- At least one end-to-end test covering the refund-split path lives in `handler_test.go`
- All tests pass

---

- [ ] **Unit 5: Expose debit split in HTTP + WS responses**

**Goal:** Surface `play_debited` and `cash_debited` in both the HTTP `BatchInsertResponse` and the WS `batch_insert_ack` so clients and agents can verify the split without storing pre-insert state.

**Requirements:** R6

**Dependencies:** None (additive to existing responses)

**Files:**
- Modify: `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go` (add `PlayDebited` + `CashDebited` to `BatchInsertResponse`; populate from `result`)
- Modify: `backend/business/web/ws/handler.go` (add `play_debited` + `cash_debited` to the `batch_insert_ack` map)
- Modify: `game/shared/src/types.ts` (add optional fields to `BatchInsertAckMessage`)
- Modify: `game/client/src/net/GameClient.ts` (only if the callback needs to surface the new fields — likely not, since the UI does not need them; pass-through is fine)
- Test: `backend/app/services/api/handlers/v1/gamegrp/gamegrp_test.go` (extend existing response-shape test to assert the new fields)

**Approach:**
- Add `PlayDebited string \`json:"play_debited,omitempty"\`` and `CashDebited string \`json:"cash_debited,omitempty"\`` to `BatchInsertResponse`. Populate from `result.PlayDebited` / `result.CashDebited`.
- Mirror in the WS ack map: `"play_debited": result.PlayDebited, "cash_debited": result.CashDebited`. Use `omitempty`-equivalent behavior by only setting the keys when non-empty if strict output is desired; otherwise include always since they are empty-string on zero-debit legs which is safe.
- In `game/shared/src/types.ts`, add `play_debited?: string; cash_debited?: string` to `BatchInsertAckMessage`.

**Patterns to follow:**
- The existing `BalancePlay` / `BalanceCash` fields on the same struct and message

**Test scenarios:**
- Happy path (mixed split): HTTP response contains both `play_debited` and `cash_debited` with correct amounts
- Happy path (pure play): `cash_debited` is either absent (`omitempty`) or `"0"` — decide during implementation and assert consistently
- Happy path (pure cash): `play_debited` same treatment
- Happy path: WS ack JSON contains the same fields with same semantics

**Verification:**
- Tests pass
- Manual check: `curl`ing the endpoint or inspecting a WS frame shows the new fields

---

- [ ] **Unit 6: Restore `Withdrawable` InfoTip + WithdrawPage wording sweep**

**Goal:** Recover the UX regression where the `Withdrawable` row lost its tooltip. Make `WithdrawPage.tsx` wording internally consistent after the "Cash Coins" label removal.

**Requirements:** R7, R12

**Dependencies:** None

**Files:**
- Modify: `game/client/src/ui/PlayerInfo.tsx`
- Modify: `game/client/src/pages/WithdrawPage.tsx`
- Test: Test expectation: none — pure UI copy; manual smoke test via dev server

**Approach:**
- `PlayerInfo.tsx`: Add an `InfoTip` to the `Withdrawable` label with copy explaining: withdrawable is earned when coins fall off the front edge, and only withdrawable can be withdrawn. Keep it short; do not duplicate the full wallet explanation that already lives on the `Balance` row tooltip.
- `WithdrawPage.tsx`: pick one canonical term ("coins") and apply it consistently to:
  - The min-withdrawal error: "Minimum withdrawal is 10 coins (1 USDC)"
  - The fee row: "{fee} coins"
  - The amount input label: "Amount (coins)"
  - The history amount column: keep consistent with the above
- Leave the "Withdrawable balance" banner label from the upstream PR unchanged — it is the canonical term.

**Patterns to follow:**
- Existing `InfoTip` usage elsewhere in `PlayerInfo.tsx`

**Test scenarios:**
- Test expectation: none -- pure UI copy, no behavior change; manual smoke-test

**Verification:**
- Dev server shows the tooltip on hover/tap of the `Withdrawable` label
- All `WithdrawPage` user-visible copy uses "coins" consistently; no bare numbers without a unit

---

- [ ] **Unit 7: HTTP end-to-end response-shape test + `QueryAllByReference` primitive + `PROTOCOL_VERSION` bump + spec.md update**

**Goal:** Close the observability and audit-preparedness gaps. Replace the struct-stub test with a real end-to-end one. Add `QueryAllByReference` so future audit callers do not silently miss split legs. Bump protocol version. Update `docs/spec.md`.

**Requirements:** R8, R9, R10, R11

**Dependencies:** Unit 5 (the HTTP response test asserts the new fields added there)

**Files:**
- Modify: `backend/app/services/api/handlers/v1/gamegrp/gamegrp_test.go` (replace `TestBatchInsert_ResponseShape` with an end-to-end `httptest` version)
- Modify: `backend/business/core/accounting/storer.go` (add `QueryAllByReference` to the interface)
- Modify: `backend/business/core/accounting/stores/ledgerdb/ledgerdb.go` (implement `QueryAllByReference` returning `[]AccountingLog`)
- Modify: `backend/business/core/accounting/accounting_test.go` mock (add `queryAllByReferenceFn` to the mock struct if other tests need it; at minimum add the no-op implementation for interface satisfaction)
- Modify: `game/shared/src/types.ts` (bump `PROTOCOL_VERSION` from 1 to 2)
- Modify: `docs/spec.md` (rewrite the Economy / Balance Model section to reflect unified wallet + play-first draw order; keep concise)

**Approach:**
- **End-to-end HTTP test:** mirror `TestBatchInsert_CountExceedsMax`'s `httptest` + `errHandler(log, grp.BatchInsert)` shape. Drive a real request through the handler; assert the JSON body contains `balance_play`, `balance_cash`, `play_debited`, `cash_debited`. Remove or deprecate the existing struct-stub `TestBatchInsert_ResponseShape`. A NATS stub is required — use a no-op `nats.Conn` substitute or make the test path skip the publish by feeding a gameCore that returns success (follow whatever pattern the `CountExceedsMax` test uses, or add the minimum plumbing).
- **`QueryAllByReference`:** add to the `Storer` interface; implement in `ledgerdb` using `sqlx.SelectContext` (not `GetContext`) to return all rows matching `(action_type, reference_id)`. Current callers continue to use the singular `QueryByReference`. No behavior change to existing idempotency flow; this is purely additive.
- **`PROTOCOL_VERSION`:** bump to 2 in `game/shared/src/types.ts`. Add a brief inline comment noting: v2 adds `balance_cash`, `play_debited`, `cash_debited` to `batch_insert_ack`; removes `balance`.
- **`docs/spec.md` update:** rewrite the "Economy / Balance Model" section (around lines 309-349 per the agent-native reviewer's citation). Describe: single wallet total, withdrawable sub-balance, play-first draw, what feeds each half. Keep it short and factual; link (by path, not URL) to `docs/plans/2026-04-12-001-feat-unified-wallet-insert-plan.md` for implementation details.

**Patterns to follow:**
- `TestBatchInsert_CountExceedsMax` in `gamegrp_test.go` for the `httptest` harness
- `sqlx.SelectContext` usage elsewhere in `ledgerdb.go` or companion store files for multi-row queries

**Test scenarios:**
- Happy path (HTTP e2e): POST `/v1/game/batch-insert` with a valid count against a seeded account → response JSON contains all four balance/debit fields; status 200
- Happy path (HTTP e2e mixed split): seed `play=2, cash=10`; request count=5 → response shows `balance_play=0, balance_cash=7, play_debited=2, cash_debited=3`
- Error path (HTTP e2e): invalid count → 400 as before (regression coverage preserved)
- Happy path (`QueryAllByReference`): two ledger entries sharing a reference ID → returned slice has 2 entries with distinct currencies
- Happy path (`QueryAllByReference`): no entries → empty slice, no error
- Test expectation for `PROTOCOL_VERSION` bump: none — constant change; TypeScript build compiles
- Test expectation for spec.md: none — documentation-only

**Verification:**
- New end-to-end test passes and the old struct-stub test is gone (or marked clearly as a unit-only assertion)
- `QueryAllByReference` has coverage and is callable through the Storer interface
- `PROTOCOL_VERSION === 2` in the built shared types
- `docs/spec.md` no longer references the old single-currency insert model

## System-Wide Impact

- **Interaction graph:** Refund path gains idempotency + deterministic correlation (Units 1, 2) → any retry semantics at upstream layers (HTTP retries, WS reconnect-then-retry) become safe without further coordination. `QueryAllByReference` (Unit 7) becomes available for future audit/reconciliation callers without changing existing idempotency callers.
- **Error propagation:** Parse errors in refund paths (Unit 1) stop being silent — they now surface as explicit errors + metric increments. Monitoring dashboards watching `BatchInsertRefundFailures` will see these; alert thresholds may need adjustment if the rate is non-zero in practice.
- **State lifecycle risks:** Refund double-credit (Unit 2) is closed. `DecrementForInsert` contract is clarified but not enforced at the type level (Unit 3) — a future maintainer could still misuse it, now with a louder doc + regression test as the guardrail.
- **API surface parity:** HTTP + WS stay symmetric on refund behavior (Unit 1 brings HTTP up to WS's ctx pattern). New response fields (Unit 5) land on both channels simultaneously. `PROTOCOL_VERSION` (Unit 7) signals the aggregate WS shape change from this PR + this fix-up.
- **Integration coverage:** New WS handler test (Unit 4) closes the largest coverage gap. HTTP e2e test (Unit 7) closes the struct-stub bypass.
- **Unchanged invariants:** Withdraw flow untouched. `balance_play` / `balance_cash` DB schema untouched (the unique index was already patched upstream during review). Ledger `currency` semantics untouched. The `ActionExchangeCashPlay` `CHECK` constraint remains (historic, harmless).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `QueryAllByReference` accidentally gets used where idempotency-lookup semantics are expected (silent behavior change) | Doc comment explicitly distinguishes the two; keep both functions side-by-side with contrasting purpose; no current caller migrates |
| `PROTOCOL_VERSION=2` bump is visible to cached clients; they may not reload | Version gate is advisory only (we do not hard-reject v1 clients). Deploy backend + client bundle together; no hard break |
| Deterministic refund correlation ID (`<insert-ref>:refund`) collides with a pre-existing audit log convention | Grep confirms no existing refund entries carry that suffix pattern today (fresh UUIDs); colon separator is safe; flag if a surprise collision is found during implementation |
| Adding an end-to-end HTTP test requires mocking NATS; if done poorly, test is flaky or slow | Reuse whatever the `CountExceedsMax` test does; it compiles but does not actually publish because count is rejected early. For the success-path e2e, either stub NATS or rely on the existing NATS mock pattern if one is available |
| `docs/spec.md` rewrite accidentally changes product intent beyond the scope of this PR | Scope the edit strictly to the balance-model section; leave game loop, ability, multiplayer sections untouched |
| Unit 3 (doc + test only) leaves the theoretical risk in place that a future contributor calls `DecrementForInsert` outside execTx | Accepted trade-off; full refactor is out of scope; regression test pins the contract |

## Documentation / Operational Notes

- Update `docs/spec.md` "Economy / Balance Model" (Unit 7).
- `PROTOCOL_VERSION` bump (Unit 7): deployment order — deploy backend and frontend together. A cached frontend at v1 will silently miss the new ack fields but will still function on existing fields (balance_play, balance_cash).
- Observability: the new error-surface in Unit 1 will increase `BatchInsertRefundFailures` if parse paths were ever hit silently. Watch the metric after deploy; if it fires unexpectedly, investigate whether any caller is producing empty `PlayDebited` / `CashDebited` strings.
- No DB migration in this plan (schema was patched upstream).

## Sources & References

- **Originating review:** Conversation review pass on `feat/unified-wallet-insert` (see findings #1–#14 in the chat transcript preceding this plan)
- **Upstream feature plan:** `docs/plans/2026-04-12-001-feat-unified-wallet-insert-plan.md`
- **Upstream feature requirements:** `docs/brainstorms/2026-04-12-unified-wallet-insert-requirements.md`
- **Institutional learning precedents:** `docs/security-audit.md:100-108` (P0-8 deposit idempotency), `docs/security-audit.md:291-296` (P1-14 NATS-failure refund), `docs/backend-optimization.md:42-68` (Priority 2b single-tx)
- Related code:
  - `backend/business/core/accounting/accounting.go` — `ProcessDeposit`, `ProcessGameInsertRefund`
  - `backend/business/core/user/user.go` — `DecrementForInsert`
  - `backend/business/web/ws/handler.go` — WS `batch_insert` handler and refund path
  - `backend/app/services/api/handlers/v1/gamegrp/gamegrp.go` — HTTP `BatchInsert` handler and refund path
  - `game/shared/src/types.ts` — `PROTOCOL_VERSION`, `BatchInsertAckMessage`
  - `game/client/src/ui/PlayerInfo.tsx` — `Withdrawable` label + InfoTip
  - `game/client/src/pages/WithdrawPage.tsx` — wording
  - `docs/spec.md` — canonical product spec
