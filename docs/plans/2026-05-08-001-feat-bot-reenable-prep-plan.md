---
title: "feat: Pre-bot-reenable hardening — Scenario E + RTP monitoring + ramp runbook"
type: feat
status: active
date: 2026-05-08
---

# Pre-bot-reenable hardening — Scenario E + RTP monitoring + ramp runbook

## Overview

The B+C combo (commit `1e0da1c`, deployed 2026-05-08) closes the heat-formula leak class that motivated the bot kill-switch. Three follow-ups must land before flipping `bot_config.kill_switch=off`:

1. **Scenario E in heatsim** — verify α=0.95 doesn't open a *whale dominance* leak class that the existing scenarios A-D didn't model.
2. **Per-user RTP monitoring in Grafana** — surface real PROD player economics (combo's predictions are simulator-grounded; we need a reality check before trusting).
3. **Bot re-enable runbook** — written gating procedure: phased crowd-scale ramp with explicit stop signals tied to the monitoring deployed in Unit 2.

This plan does not flip the kill switch. The runbook is the artifact; the operator runs it later.

## Problem Frame

The B+C combo closed three known leak classes:
- Floor-based heartbeat exploit (closed 2026-04-25 by `30f8505`)
- Activity-decay-tail drive-by exploit (closed 2026-05-08 by `1e0da1c`)
- Cold-start cross-real RTP asymmetry under floor mechanics (closed 2026-05-08 by `1e0da1c`)

But two known unknowns remain from the combo plan's Risks table:

- **α=0.95 makes the share function near-linear**. Compared to α=0.7, a whale (e.g., 10000-coin/min sustained) has dramatically more eff than a small player (50-coin/min). Heatsim's Scenarios B/D had no whale character so this regime is untested. If a whale + small reals coexist, small reals could see RTP < 5% and abandon the game — a different failure mode than wealth extraction, but a real product risk.
- **Heatsim ≠ PROD**. The simulator's strategies (heartbeat, drive-by, constant-low) don't cover every adversarial pattern a real player might invent. We need ground-truth from production accounting_logs to confirm combo behaves like the model predicted.

The bot kill-switch is the only thing currently preventing both classes from manifesting. Re-enabling bots without these checks would re-open the same risk surface that motivated the kill-switch in the first place — just with different leak shape.

## Requirements Trace

- **R1.** A heatsim scenario E that models 1 whale (1000-coin/30s sustained) + 3 small reals (5-coin/30s burst, 5-min visit) + 4 bots, runs under combo defaults, and reports per-strategy RTP.
- **R2.** Pass criteria for Scenario E: small-real RTP ≥ 20% (not crushed); whale RTP ≤ 70% (not pure monopoly); Σ real RTP < 100% (no aggregate leak).
- **R3.** A Grafana panel showing per-user RTP over a rolling window (1h + 24h), sourced from `accounting_logs`, with at least: top-N users by 24h RTP, count of users with 24h RTP > 100%, and aggregate real-player RTP.
- **R4.** A Grafana alert that fires when any single user's 24h RTP exceeds 100% with at least 100 coins inserted (filters drive-by noise), routed to the existing Telegram contact point.
- **R5.** A markdown runbook at `docs/runbooks/bot-reenable.md` documenting the phased crowd-scale ramp, soak windows, alert-driven gates, manual rollback procedure, and the explicit pre-flight checklist that ties Units 1+2 to this Unit.
- **R6.** No production behavior change in this plan unless and until the operator manually executes the runbook. Specifically: kill_switch stays `on` at plan completion.

## Scope Boundaries

- **Non-goal**: actually flipping `kill_switch=off`. The runbook documents the procedure; the operator decides when.
- **Non-goal**: adjusting α back if Scenario E surfaces whale dominance. If the test fails, the next plan handles formula re-tuning. This plan only diagnoses.
- **Non-goal**: a long-term per-user RTP dashboard with role splits, leaderboards, or trends. Unit 2 ships the minimum needed for re-enable gating; broader dashboards are separate work.
- **Non-goal**: automated kill-switch activation. The alert notifies a human; the human flips the switch via existing `admin bot kill-switch on`.
- **Non-goal**: changing `crowd_scale` defaults in the seed. The runbook overrides per-phase but doesn't ship a new default.
- **Non-goal**: monitoring bot economic health (bot RTP, cash death-water). Bots aren't the leak surface this plan addresses; that's tracked separately in TODOs.
- **Non-goal**: re-enabling bots before the soak window completes. The runbook explicitly defines a minimum soak; shortcuts are rollbacks, not features.

## Context & Research

### Relevant Code and Patterns

- `backend/app/tooling/heatsim/main.go` — simulator with `scenarioA/B/C/D()` functions and `prodBots(n)` helper. Unit 1 adds `scenarioE()` following the same shape. CLI flag `--scenario` already accepts named scenarios.
- `backend/business/core/accounting/model.go` — `AccountingLog` struct + action types. RTP query reads:
  - **Cost** = sum of `Amount` where `ActionType IN (ActionGameInsert)` and `Currency = CurrencyPlay` (player's PLAY spent on coin inserts).
  - **Income** = sum of `Amount` where `ActionType IN (ActionGameReward, ActionChestReward, ActionProgressReward, ActionReferralReward)` and `Currency = CurrencyCash` (CASH earned).
  - `RTP = income_cash / cost_play` (1 PLAY = 1 CASH face value; mixing currencies is intentional since CASH is the withdrawable form).
  - Excludes refunds (`GAME_INSERT_REFUND`, `WITHDRAW_REFUND`, `WITHDRAW_FEE_REFUND`) since those net out.
- `deploy/grafana/dashboards/` — existing dashboards (`overview.json`, `game-server.json`, `blockchain.json`) follow Grafana JSON model. New dashboard added here with provisioning provider already configured.
- `deploy/grafana/provisioning/datasources/prometheus.yml` — current single Prometheus datasource. Unit 2 adds a sibling `postgres.yml` for SQL queries. PostgreSQL plugin is shipped with Grafana 11.0; no extra install.
- `deploy/grafana/provisioning/alerting/alerts.yml` — existing alerts (43KB). Provisioned format. Unit 2 appends a new RTP alert to this file following the same structure as existing rules.
- `deploy/grafana/provisioning/alerting/contact-points.yml` — Telegram contact point already wired; new alert routes to the same target.
- `backend/app/tooling/admin/bot.go` — provides `admin bot kill-switch on|off` and `admin bot config crowd_scale '[1,1,0,0,0,0]'` for per-tier bot caps. Runbook uses these existing commands.
- `docker-compose.services.yml` — Grafana service already on `app` network; can reach `postgres:5432` directly. New datasource just needs credentials (use the existing `BACKEND_DB_*` env vars or a read-only role).

### Institutional Learnings

- 2026-04-25 / 2026-05-08 heat plan retrospective: simulator-only validation is insufficient for production economic systems. The combo plan explicitly listed PROD-monitoring-by-user as a Risks-table follow-up — this plan delivers it.
- 2026-04-25 cold-start lesson (from heatsim): pre-warming and steady-state measurement matter. The 24h alert window in Unit 2 is the production equivalent — a 1h window catches transient spikes (legitimate big wins), 24h catches sustained exploitation.
- DEPLOYMENT.md / monitoring.md establish that Telegram is the existing alert sink. New alerts route there for consistency.
- Existing bot scheduler (`backend/business/core/bot/scheduler.go`) reads `bot_config.crowd_scale` JSON every tick (~5s), so phased ramps via SQL update propagate automatically. No restart needed.

### External References

- None. This plan reuses existing Grafana / PostgreSQL patterns; no new tech.

## Key Technical Decisions

- **Postgres datasource over Prometheus metrics for RTP**: Per-user RTP would require either a Prometheus gauge with `user_id` label (cardinality risk: thousands of users → label explosion) or an exporter that recomputes metrics periodically. SQL via Postgres datasource is the simplest path: no new code, queries adapt freely during incident triage. If cardinality / cost concerns emerge later, a low-cardinality alert exporter is a separate refactor.
- **Read-only DB user** for Grafana access: Grafana's Postgres datasource gets credentials separate from backend's own `BACKEND_DB_USER` to enforce read-only. Adds one new env var in `.env` and one role-create migration.
- **Alert thresholds (24h window, 100-coin floor, 100% RTP)**: 24h captures sustained patterns (single-spike false positives are filtered by the 100-coin minimum-investment floor). 100% is the leak boundary: at 100% RTP a player breaks even on heat alone, ignoring game outcomes; above is house-loss territory.
- **Two-phase alert ladder, not three**: Single alert at 100% RTP. Below 100% the formula is working as intended. Adding a "warning" tier at 80% adds noise without action — operator response is the same (investigate). Keep the alert simple.
- **Phased crowd-scale ramp via existing `admin bot config`**: The bot scheduler already honors `crowd_scale` JSON live (5s tick). Runbook leverages this; no new admin commands. Phases: `[1,1,0,0,0,0]` → `[2,2,1,1,0,0]` → `[3,4,4,3,3,2]` (current PROD default).
- **Auto-rollback signal**: Single user 24h RTP > 150% with ≥ 100 coins inserted, OR aggregate real RTP > 80%. Either fires the same alert. Operator runs `admin bot kill-switch on` manually — no automated kill (avoid feedback-loop bugs flipping the switch on legitimate spikes).
- **Soak window: 24h per phase**: Aligns with the alert's 24h rolling window. Operator confirms zero alerts fire over a full 24h before advancing. Total ramp: 72h minimum.
- **Runbook lives in `docs/runbooks/`**: New directory. Pattern follows existing `docs/solutions/` convention (problem-and-procedure markdown). Runbook is intended for operator + future Claude sessions to consume.

## Open Questions

### Resolved During Planning

- **Should we also export a low-cardinality "max real-user RTP" Prometheus gauge?** No, defer. Postgres datasource covers the ad-hoc use case; if Postgres becomes a Grafana SPOF or query-cost issue, layering on a metric is a separate, cheap follow-up.
- **Does the runbook need automation?** No. Manual gates are appropriate for an irreversible-ish economic decision. The cost of slowness is a few hours of bots-off; the cost of automated re-enable into a hidden leak is back to where we started.
- **What if Scenario E surfaces a problem?** Plan freezes Unit 2 + Unit 3, surfaces a follow-up plan to retune α (likely α=0.85 + raise coinHalfLife to 50). Re-running heatsim's full A-E suite validates the retune.
- **Should bot kill-switch flip be automated on alert fire?** No. Alerts wake the operator; operator decides. Automated cutoffs on a single signal create their own failure mode (a flapping alert can keep bots flipping on/off, which is worse than a 30-min human delay).
- **What if `accounting_logs` query becomes slow at scale?** Defer. Current row counts (~hundreds of rows/day in PROD) make even unindexed scans trivial. If this becomes a problem, add a covering index `(account_id, created_at, action_type)` — separate one-line migration.

### Deferred to Implementation

- **Exact SQL query shape for per-user RTP** — implementer iterates against live `accounting_logs` data to see what window function gives the cleanest RTP.
- **Read-only DB role name** — implementer chooses (`grafana_ro` is the obvious shape, but pin in implementation).
- **Telegram alert message wording** — implementer drafts during the alert YAML edit, copying tone from existing alerts.
- **Whether the runbook codifies a specific "first-ramp" `crowd_scale`** — implementer decides during writing whether to pin literal phase values or define them as pseudocode the operator parameterizes.

## Implementation Units

- [ ] **Unit 1: Add Scenario E to heatsim**

**Goal:** Add a whale-vs-small-players scenario to heatsim that exercises α=0.95's untested regime, and run it to confirm pass criteria from R2.

**Requirements:** R1, R2.

**Dependencies:** None.

**Files:**
- Modify: `backend/app/tooling/heatsim/main.go` (add `scenarioE()` and route from `--scenario=E|all` switch in `main()`).

**Approach:**
- Mirror `scenarioD()` shape. New scenario:
  - 1 whale: `kindFixedPeriod`, period 30s, coinsPerInsert 1000, arriveAt 0, no leaveAt
  - 3 small reals: each `kindFixedPeriod`, period 30s, coinsPerInsert 5, arriveAt staggered (0, 600, 1200), leaveAt 5min after each arrive
  - 4 PROD bots
  - 1h duration (warmup-shifted to 4500s as scenarioB)
- Add scenario to `--scenario=all` iteration so a default heatsim run includes E.
- Pass criteria are evaluated by the operator reading the RTP table — no automated assertions.

**Patterns to follow:**
- `scenarioD()` for the multi-real-coexist construction.
- `prodBots(4)` helper for bot population.
- Existing `report()` function handles the RTP table without modification.

**Test scenarios:**
- *Happy path*: `go run ./app/tooling/heatsim/ --scenario=E` produces an RTP table with 1 whale + 3 small reals + 4 bots, each with a verdict (ok / warm / LEAK).
- *Edge case*: `--scenario=all` includes E in the output between D and the end.
- Test expectation for the simulator code itself: none — simulator is a tool. Verification is interpreting the RTP table.

**Verification:**
- Operator interprets the RTP table:
  - **Pass**: small-real RTP ≥ 20%; whale RTP ≤ 70%; total real RTP < 100%.
  - **Soft pass with note**: small-real RTP in [10%, 20%] — usable but small reals feel marginal; document this in the runbook's known-issues.
  - **Fail**: small-real RTP < 10% OR whale RTP > 70% OR total real RTP > 100% — this plan halts; spawn a follow-up plan to retune α.

---

- [ ] **Unit 2: Per-user RTP monitoring in Grafana**

**Goal:** Surface per-user RTP from `accounting_logs` in Grafana, with a Telegram alert that fires when any user's 24h RTP exceeds 100% with ≥ 100 coins inserted.

**Requirements:** R3, R4.

**Dependencies:** None directly; runs in parallel with Unit 1.

**Files:**
- Create: `deploy/grafana/provisioning/datasources/postgres.yml` (Postgres datasource pointed at `postgres:5432` with read-only credentials).
- Create: `deploy/grafana/dashboards/economy-rtp.json` (dashboard with three panels: top-10 users by 24h RTP, count of users above 100% RTP threshold, aggregate real-player RTP).
- Modify: `deploy/grafana/provisioning/alerting/alerts.yml` (append RTP alert rule).
- Modify: `docker-compose.services.yml` (add `GF_DATABASE_GRAFANA_RO_PASSWORD` env var passthrough to grafana service; reference new env var).
- Modify: `.env.example` or equivalent (document new `GRAFANA_RO_PASSWORD` env var).
- Create: SQL migration adding a read-only `grafana_ro` role with `SELECT` on `accounting_logs` and `accounts` (path matches existing migration convention; check `backend/foundation/database/` for the seed migration location).
- Test: smoke run a manual query against PROD via `psql` to confirm the SQL shape returns expected results.

**Approach:**
- **Datasource**: standard Grafana Postgres datasource YAML. Credentials via env var so secrets stay out of git.
- **Read-only role**: minimum-permission user (`SELECT` on `accounting_logs`, `accounts`; nothing else). Avoids any risk of dashboard config / alert query mutating data.
- **RTP SQL** (sketch — actual query refined during implementation):
  - Per-user: `SUM(amount) FILTER (WHERE action_type='GAME_REWARD' AND currency='CASH') / NULLIF(SUM(amount) FILTER (WHERE action_type='GAME_INSERT' AND currency='PLAY'), 0)` over `created_at > now() - interval '24 hours'`.
  - Filter: `HAVING SUM(...inserts...) >= 100` to suppress drive-by noise.
  - Excludes refund actions (they net to zero in the ledger anyway, but explicit exclusion is clearer).
  - Excludes bots (`role = 'bot'` in `accounts` join).
- **Three panels**:
  - Panel 1: table of top-10 real users by 24h RTP with columns (user_id short, inserts, rewards, RTP%).
  - Panel 2: stat showing count of real users with 24h RTP > 100% AND inserts ≥ 100. Goal: 0.
  - Panel 3: stat showing aggregate `Σ rewards / Σ inserts` across all real users in the last 24h. Goal: < 50%.
- **Alert**: query on Panel 2's metric; fires when count > 0 for ≥ 5 min; routes to existing Telegram contact point.

**Execution note:** characterization-first — write the SQL queries against PROD's read-replica or a snapshot first to verify correctness against real data, then build the Grafana panels. Do not develop SQL blind against an empty dev database.

**Patterns to follow:**
- `deploy/grafana/dashboards/overview.json` for the dashboard JSON shape.
- Existing alert rules in `deploy/grafana/provisioning/alerting/alerts.yml` for the alert structure (label conventions, eval interval, contact point routing).
- `docker-compose.services.yml`'s existing env var passthrough pattern (e.g., `GF_AUTH_PROXY_*`) for the new credentials.

**Test scenarios:**
- *Happy path*: Visit the dashboard URL after deploy; all three panels render with current PROD data (currently zero real-player activity given bots are off, so panels show empty state gracefully).
- *Edge case*: A user with zero inserts but some rewards (e.g., received progress reward only) — RTP query handles divide-by-zero via `NULLIF`, panel hides them.
- *Edge case*: A user with inserts < 100 in window — alert query's HAVING filter excludes them.
- *Integration*: Manually insert a synthetic high-RTP row pair into `accounting_logs` on a staging DB → confirm alert fires within 5 min → remove rows → confirm alert clears.
- *Error path*: Postgres datasource credentials wrong → Grafana shows clear "unable to connect" on panel; check Grafana logs surface the auth failure.

**Verification:**
- Dashboard at `https://<domain>/grafana/d/economy-rtp/` renders without error post-deploy.
- Manually triggering an RTP-over-100% scenario on staging fires the Telegram alert within 5 min.
- After clearing the synthetic data, the alert auto-resolves.
- `psql -U grafana_ro` confirms read-only role can SELECT but not INSERT/UPDATE/DELETE.

---

- [ ] **Unit 3: Bot re-enable runbook**

**Goal:** Document the phased re-enable procedure as a markdown runbook the operator (and future Claude) can execute when ready, with explicit gates tied to Units 1 and 2.

**Requirements:** R5, R6.

**Dependencies:** Units 1 and 2 (the runbook references their pass-criteria and dashboards).

**Files:**
- Create: `docs/runbooks/bot-reenable.md`
- Create: `docs/runbooks/` directory if it doesn't exist.

**Approach:**
- Sections of the runbook:
  1. **Pre-flight checklist** (must all be true before starting):
     - Combo (commit `1e0da1c`) deployed and stable in PROD.
     - Scenario E from Unit 1 has been run; pass criteria met (or soft-pass-with-note explicitly accepted).
     - Per-user RTP dashboard from Unit 2 is live and rendering.
     - Telegram alert tested end-to-end on staging.
     - Operator has SSH access to backend droplet and admin CLI ready.
  2. **Phased ramp**:
     - Phase 1: `crowd_scale = [1,1,0,0,0,0]` (max 1 bot ever online). Soak 24h. Watch RTP dashboard daily; zero alerts allowed.
     - Phase 2: `crowd_scale = [2,2,1,1,0,0]`. Soak 24h.
     - Phase 3: `crowd_scale = [3,4,4,3,3,2]` (PROD default). Soak 24h.
     - Each phase advance is a manual operator decision.
  3. **Commands** for each phase (literal SSH + admin CLI commands, the same shape as the deploy procedure documented in `docs/DEPLOYMENT.md`).
  4. **Stop signals** (any single signal triggers immediate rollback):
     - Telegram alert fires (`real_user_rtp_above_100pct > 0`).
     - Aggregate real RTP panel shows > 80% sustained over 1h.
     - Operator observes any unexplained > 50% RTP user even below alert threshold.
     - Total system error rate spikes (existing alerts).
  5. **Rollback procedure**:
     - `admin bot kill-switch on` (immediate, no questions).
     - SSH + investigation; check `accounting_logs` for the offending user/window.
     - Decision tree: revert combo? Retune α? Add new sim scenario?
     - Don't re-flip without a written post-mortem identifying root cause.
  6. **Known limitations**:
     - Runbook assumes monitoring covers the leak class. New leak classes (out-of-distribution attacks not in heatsim) won't fire the alert until they're large enough; supplement with weekly manual review of accounting_logs.
     - No automatic kill-switch on alert; operator response time is the failure mode — escalation policy belongs in DEPLOYMENT.md or oncall docs.

**Patterns to follow:**
- `docs/DEPLOYMENT.md` for the SSH + admin CLI command formatting style.
- `docs/solutions/` for the structured-procedure-with-rationale prose style.
- `docs/monitoring.md` for cross-references to dashboards and alerts.

**Test scenarios:**
- Test expectation: none — runbook is documentation. Verification is operator readability.

**Verification:**
- Another developer (or Claude in a future session) can read the runbook and execute Phase 1 without needing to ask clarifying questions about commands or thresholds.
- All command snippets in the runbook are copy-pasteable and reference existing CLI tools (no inventing).
- Stop signals link to specific dashboard panels / alert names from Unit 2.
- Pre-flight checklist references Unit 1's heatsim invocation and Unit 2's dashboard URL by name.

## System-Wide Impact

- **Interaction graph:**
  - Unit 1: heatsim is a standalone CLI; no new integrations.
  - Unit 2: Grafana → Postgres (new datasource); Grafana → Telegram (existing alert routing); SQL queries against `accounting_logs` (existing table). No backend code path change.
  - Unit 3: documentation only; no code paths touched.
- **Error propagation:** New alert rule must not throw on empty-result queries — verify `NULLIF` and `COALESCE` cover the zero-inserts case.
- **State lifecycle risks:** Read-only role grants are the only persistent change. Migration is one-way (drop role for rollback); no data loss path.
- **API surface parity:** None. No public API changes.
- **Integration coverage:** Unit 2's alert end-to-end test (synthetic ledger row → alert fires → cleanup → alert clears) covers the SQL-to-Telegram chain that mocks alone wouldn't prove.
- **Unchanged invariants:**
  - `bot_config.kill_switch=on` stays unchanged at plan completion.
  - `heat.HeatEngine` constants (α=0.95, coinHalfLife=30, halfLife=180, guaranteed=0) unchanged.
  - `accounting_logs` schema unchanged.
  - Existing Prometheus / backend / executor / indexer alert rules unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Scenario E surfaces whale dominance and forces α retuning | Plan halts at Unit 1 result; new plan handles retune. Units 2-3 still useful (carry over). Total wasted effort: ~1 day if E fails. |
| Postgres datasource leaks credentials via Grafana logs / config dump | Use a read-only role with minimal grants. Even if creds leak, attacker can only read accounting_logs (which they can't modify or use to extract value). Rotate password post-incident. |
| Read-only role migration accidentally locks out backend writes | Migration creates a NEW role, doesn't modify existing roles. Backend continues using its own credentials. Migration is reversible (DROP ROLE). |
| Alert false positives during legitimate big-win sessions | 24h window + 100-coin minimum filter both shrink the false-positive surface. If real users hit > 100% RTP legitimately for sustained 24h, that itself is a signal worth investigating — not a false positive. |
| Operator runs the runbook before Unit 2 is fully deployed | Runbook's pre-flight checklist explicitly requires Unit 2 dashboard live. If skipped, blame is operator-error not runbook-design. Add a `git grep "alerts.yml"` check or similar to surface Unit 2's deployment state in the pre-flight if a script harness exists. |
| Bot re-enable surfaces an out-of-distribution exploit not modeled by heatsim | Phased ramp limits blast radius to one tier at a time. 24h soak per phase gives the alert time to fire. If exploit's RTP is < 100% it slips through; mitigation = supplement alerts with weekly manual log review (documented as known limitation). |
| Grafana dashboard outage during incident | Postgres queries can be run directly via `psql` from the SSH session — runbook includes the raw SQL as a fallback. |

## Documentation / Operational Notes

- After Unit 3 lands, link the runbook from `docs/monitoring.md` and `docs/DEPLOYMENT.md` so it's discoverable from the existing monitoring entry-points.
- After Unit 2 lands, add a one-line note to `docs/monitoring.md` about the new Postgres datasource (so future debuggers don't assume "Prometheus only").
- After bot re-enable actually completes (per runbook), update `docs/heat-system.md` with a "Production validated" section showing actual PROD RTP numbers vs. simulator predictions — this becomes the institutional learning that future heat-formula tuning calibrates against.
- Plan does not introduce new env vars to the production secrets management except `GRAFANA_RO_PASSWORD`. Document in the standard `.env` template / DEPLOYMENT.md.
- Alert eval interval matches existing alerts (5min as default) — don't introduce a special cadence.

## Sources & References

- **Origin:** combo plan's Risks table at `docs/plans/2026-04-26-001-feat-heat-combo-bc-alpha-coindecay-plan.md` (the three flagged follow-ups).
- **Combo deploy commit:** `1e0da1c` (heat defaults flip), deployed 2026-05-08.
- **Floor-disable commit:** `30f8505` (Phase 1 of the multi-step heat hardening).
- **Existing monitoring stack:** `docs/monitoring.md`, `deploy/grafana/`, `deploy/prometheus/`.
- **Existing deploy / SSH patterns:** `docs/DEPLOYMENT.md`.
- **Bot admin CLI:** `backend/app/tooling/admin/bot.go` (kill-switch, config, pause/resume).
- **Heatsim:** `backend/app/tooling/heatsim/main.go` (existing scenarioA-D).
- **Accounting model:** `backend/business/core/accounting/model.go` (action types and ledger shape).
- Related PRs/commits: this plan's eventual implementation will produce 3-4 commits matching its units.
