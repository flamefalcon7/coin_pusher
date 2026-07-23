---
module: infrastructure
date: 2026-07-09
problem_type: resource_exhaustion
component: monitoring
severity: high
symptoms:
  - "coin_pusher-prometheus-1 crash-looping; `docker ps` shows a recent 'Up N hours' despite no deploy"
  - "`docker stats` shows prometheus pinned at ~899MiB / 900MiB (99.9% of mem_limit)"
  - "`docker inspect` misleadingly reports ExitCode: 0, OOMKilled: false"
  - "Grafana dashboards lose data across restarts; WAL replay on every boot"
root_cause: unbounded_label_cardinality
resolution_type: code_change
related_components:
  - prometheus
  - backend_api
  - chi_router
tags: [prometheus, oom, cardinality, tsdb, chi, metrics, 404, scanner-traffic, memcg, oomkilled-flag, mutation-testing]
related_commits:
  - "(pending) fix(metrics): collapse unmatched routes to a single path label"
supersedes_watch_item: "prometheus-oom-dns-outage-2026-06-07.md — 'if it crash-loops on the cap, raise to ~1100m'"
status: fix_verified_local_pending_deploy
---

# Prometheus OOM from unbounded `path` label cardinality (2026-07-09)

## What happened

`coin_pusher-prometheus-1` was being OOM-killed by the kernel and restarted by Docker
(`restartCount=2`), and was sitting at **899 MiB of its 900 MiB `mem_limit`** when found —
i.e. minutes away from the next kill.

Unlike the 2026-06-07 incident, this was **contained**: the `mem_limit` added back then did
its job, so only Prometheus died. No global OOM, no DNS starvation, no player impact.

## The diagnostic trap: `docker inspect` lies about OOM

The obvious first command reports the exact opposite of the truth:

```
$ docker inspect coin_pusher-prometheus-1 --format '{{.State.ExitCode}} {{.State.OOMKilled}}'
0 false
```

This is **not** evidence of a clean exit. `.State` describes the *currently running*
container after Docker restarted it — the exit code was reset. And `OOMKilled` is unreliable
for **cgroup v2 memcg** kills, where the kernel kills a process *inside* the cgroup rather
than the container's init.

The authoritative source is the kernel log:

```bash
journalctl --since "<window>" | grep -iE "oom|prometheus"
```
```
kernel: Memory cgroup out of memory: Killed process 929679 (prometheus)
        total-vm:3450044kB, anon-rss:814520kB
kernel: oom-kill:constraint=CONSTRAINT_MEMCG
dockerd: restarting container exitCode=137 restartCount=2
```

`exitCode=137` (128+9, SIGKILL) + `constraint=CONSTRAINT_MEMCG` is the real signal.
Note `dmesg -T` was **empty** here (ring buffer had rotated); `journalctl` retained it.

**Rule: never conclude "not an OOM" from `docker inspect` alone. Check the kernel log.**

## Root cause

`backend/business/web/mid/logger.go` derived the Prometheus `path` label like this:

```go
path := r.URL.Path                                    // <-- raw, attacker-controlled
if rctx := chi.RouteContext(r.Context()); rctx != nil {
    if pattern := rctx.RoutePattern(); pattern != "" {
        path = pattern                                // only when a route matched
    }
}
metrics.HTTPRequestsTotal.WithLabelValues(r.Method, path, status).Inc()
metrics.HTTPRequestDuration.WithLabelValues(r.Method, path).Observe(...)
```

chi's `RoutePattern()` returns `""` for a request that matched **no route** (a 404), so
`path` fell back to the **raw request URL**. Every unique URL sprayed at the public API by
internet vulnerability scanners minted a permanent new time series.

The histogram multiplies the damage: each unique path yields 1 counter + 12 `le` buckets +
`_sum` + `_count`.

### Evidence

`/api/v1/status/tsdb` on the live instance:

| metric | value |
|---|---|
| head series | **359,167** |
| series from `job=backend` | 358,695 (99.9%) |
| distinct `path` label values | **23,714** |
| `..._duration_seconds_bucket` series | 286,764 |

Series count by status label — the smoking gun:

| status | series |
|---|---|
| **404** | **23,886** |
| 200 | 8 |
| 405 | 3 |
| 403 | 1 |

Only **8** series belong to real routes. 99.95% of the cardinality is scanner 404 noise.
The scanners are visible in the backend request log (`/owa/auth/errorFE.aspx`,
`/_layouts/15/error.aspx`, …).

### Causal chain

```
public API reachable from the internet
  → vulnerability scanners spray thousands of unique 404 URLs
    → chi RoutePattern() == "" on 404 → raw URL used as the `path` metric label
      → 23,714 label values × (counter + 14 histogram series) ≈ 359k head series
        → ~795 MB anon RSS > mem_limit 900m
          → cgroup OOM kill → restart → WAL replay → repeat
```

## Why the 2026-06-07 fix didn't prevent this

That incident's mitigations were correct but addressed **blast radius, not cause**:

- `mem_limit: 900m` — worked exactly as designed. Scoped the kill to Prometheus alone.
- `--storage.tsdb.retention.size=512MB` — **structurally cannot help here.** Retention
  bounds *persisted blocks on disk*, not the in-memory **head block**. The cardinality
  explosion lives in the head.

Its watch item predicted the symptom ("if it crash-loops on the cap, raise to ~1100m or cut
retention to 7d") but proposed treating the symptom. Raising the cap would have bought weeks,
not a fix — cardinality grows without bound as long as scanners keep finding new URLs.

## Fix

Collapse every unmatched route to one constant label value:

```go
const unmatchedPath = "<unmatched>"

func metricPath(r *http.Request) string {
    rctx := chi.RouteContext(r.Context())
    if rctx == nil {
        return unmatchedPath
    }
    pattern := rctx.RoutePattern()
    if pattern == "" {
        return unmatchedPath
    }
    return pattern
}
```

The raw path is still emitted in the **structured log** (`logger.go`, `"path", r.URL.Path`),
so scanner forensics are unaffected. Only the *metric label* is bounded.

Expected effect: head series ~359k → a few hundred. Because a stale head series is dropped at
head compaction (~every 2h), memory should fall within ~2 hours of deploy without any manual
TSDB surgery. Old blocks on disk age out via the existing 15d retention and cost little RAM.

## Verification

`backend/business/web/mid/mid_test.go`:

1. `TestMetricPath` — table test pinning the contract (matched → pattern, unmatched → constant,
   nil route context → constant).
2. `TestMetricPath_ScannerTrafficDoesNotGrowCardinality` — N distinct scanner URLs must yield
   exactly 1 label value.
3. `TestLogger_ScrapeOutputHasBoundedPathLabels` — drives the **real** `Logger` middleware
   through a **real** chi router, then parses the **actual `promhttp` scrape body**. Asserts no
   raw URL appears as a label and ≤2 distinct `path` values exist. This pins chi's real 404
   behaviour rather than trusting our reading of it.

**Mutation-tested:** reverting `metricPath` to the original body makes all three fail, and #3
reproduces the production symptom verbatim (`counter exposed 4 distinct path labels`). A guard
that has never been seen to fail is not a guard.

Suite: `go test ./...` in `backend/` → **590 passed, 41 packages**; `go vet ./...` clean.
No `go.mod` change (used `promhttp`, already a dependency, instead of `testutil` which would
have pulled in `godebug`).

## Watch items / follow-ups

- **Deploy required** — this is a code fix; the running backend still leaks labels until
  rebuilt. Recall `/opt/coin_pusher` git has **diverged from origin/main** (see the 06-07
  doc); reconcile deliberately, do not naive `git pull`.
- **Defense in depth (not yet done):** add `metric_relabel_configs` in `prometheus.yml` to drop
  high-cardinality `path` values at scrape time, so a future regression can't OOM Prometheus
  even if it reaches the exposition endpoint.
- **Consider blocking scanner traffic at nginx** — reduces log noise and backend load, though
  the metric fix is what matters for memory.
- **Audit other label sets for the same shape.** Any `WithLabelValues` fed by
  request/user/chain-derived data is a candidate. `path` was the only unbounded one found in
  `foundation/metrics/metrics.go`, but this class of bug recurs.
- **Telegram alerting was still 404 as of the 06-07 doc.** These OOM restarts paged nobody —
  that is why a crash-loop ran unnoticed. Worth fixing before the next incident.
- The durable suggestion from 06-07 still stands: move Prometheus/Grafana off the backend
  droplet, or resize. Monitoring is ~40% of RAM on a 2 GB box also running API/DB/NATS.

## Related
- `docs/solutions/infrastructure/prometheus-oom-dns-outage-2026-06-07.md` (the containment
  that made this incident boring instead of an outage)
- ADR `docs/decisions.md` D-001 (monitoring memory caps + swap)
