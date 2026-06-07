# Decisions (ADR log)

Architecture / infrastructure / tech decisions, newest-relevant first. Number sequentially
from D-001; **never reuse numbers.** Respect `Accepted` decisions — don't reopen unless asked.
When superseding: new `D-XXX` status `Supersedes D-YYY`; set `D-YYY` to `Superseded by D-XXX`.

For the "what broke + how we fixed it" record (bugs, incidents), see `docs/solutions/`.
This file is for the **why** behind a choice — especially the alternatives we rejected.

---

## D-001: Cap monitoring memory + add swap instead of resizing the droplet
**Status**: Accepted
**Date**: 2026-06-07 · **Component**: infrastructure / monitoring

### Context
On 2026-06-07 Prometheus reached 1.1 GB RSS on the 2 GB / zero-swap backend droplet and was
OOM-killed, cascading into Docker embedded-DNS starvation and a ~40-min player-facing outage
(full incident: `docs/solutions/infrastructure/prometheus-oom-dns-outage-2026-06-07.md`). The
box runs 8 containers; the monitoring stack (Prometheus 724 MB + Grafana ~120 MB) is ~40% of RAM.
We needed an immediate fix that survives the next Prometheus compaction.

### Decision
Keep the monitoring stack on the backend droplet for now, but (1) add a 2 GB swapfile
(`swappiness=10`) as a reclaim cushion, and (2) set `mem_limit: 900m` on the Prometheus
container plus trim retention `30d → 15d` with a `512MB` size cap. The `mem_limit` is the load-
bearing decision: it **scopes any future Prometheus memory blowup to the Prometheus container**,
so it can never again trigger a *global* OOM that kills the backend/DB.

### Rationale
- Scoping the OOM to Prometheus removes the player-facing failure mode immediately, with zero
  cost and no migration.
- Swap + reduced retention shrink the likelihood of hitting the cap at all.
- It's reversible config, deployable in minutes, no new infrastructure to operate.

### Alternatives Considered
- **Resize droplet to 4 GB** — rejected for now: costs money monthly, doesn't *prevent* an
  unbounded Prometheus from eventually OOMing again (just raises the ceiling), and needs a reboot.
  Still the right durable move; see "Future".
- **Move Prometheus + Grafana to a separate / the game droplet** — best long-term isolation, but
  more work (provisioning, datasource networking, dashboards) than the incident response window
  allowed. Deferred, not rejected.
- **Just add swap, no mem_limit** — rejected: swap alone still lets Prometheus drive the *whole
  box* into reclaim thrash; it wouldn't have prevented the global OOM, only delayed it.

### Consequences
- ✅ A Prometheus memory spike can no longer take down the backend/DB or the game.
- ⚠️ Prometheus sits ~80% of the 900 M cap right after restart (WAL replay); if it crash-loops on
  the cap, raise to ~1100 m or cut retention to 7d.
- 🔮 Future durable fix: move monitoring off the backend droplet, or resize to 4 GB. Revisit as
  real-player load grows.

### Related
- `docs/solutions/infrastructure/prometheus-oom-dns-outage-2026-06-07.md`
- Commits `90ef844` (mem_limit + retention), `ceb221b` (RTP query hygiene)

---

## ADR template (copy for new entries)

```markdown
## D-XXX: <Short title>
**Status**: Accepted | Proposed | Superseded by D-YYY | Deprecated
**Date**: YYYY-MM-DD · **Component**: <area>

### Context — <what problem / forces?>
### Decision — <the choice, as a complete sentence>
### Rationale — <why; bullets OK>
### Alternatives Considered — <Alt A — rejected because …>
### Consequences — ✅ <positive> · ⚠️ <tradeoff> · 🔮 <future implication>
### Related — <solutions/ link · commits · related D-YYY>
```
