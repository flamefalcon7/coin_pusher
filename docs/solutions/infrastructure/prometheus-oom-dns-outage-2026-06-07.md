---
module: infrastructure
date: 2026-06-07
problem_type: resource_exhaustion
component: monitoring
severity: critical
symptoms:
  - "Players intermittently could not connect for ~40min; site HTTP stayed 200 but game/WS path degraded"
  - "Backend logs: 'lookup postgres on 127.0.0.11:53: i/o timeout' and nginx 'unexpected DNS response for backend'"
  - "NATS connection flapping (disconnected EOF -> reconnected) in a loop"
  - "Operator SSH locked out for ~30min: TCP connects, then 'Connection timed out during banner exchange'"
root_cause: memory_exhaustion
resolution_type: config_change
related_components:
  - prometheus
  - docker_embedded_dns
  - nginx
  - sshd
tags: [prometheus, oom, swap, docker-dns, mem_limit, retention, outage, fail2ban, self-inflicted-load, tsdb-compaction, explain-analyze]
related_commits:
  - "90ef844 fix(monitoring): cap prometheus memory + trim retention to prevent global OOM"
  - "ceb221b perf(monitoring): index-align per-user RTP queries"
status: deployed
---

# Prometheus OOM → Docker DNS starvation → player-facing outage (2026-06-07)

## What happened

The `coin_pusher-prometheus-1` container grew to **1.1 GB RSS** on the **2 GB, zero-swap**
backend droplet (`146.190.104.138`) and was **OOM-killed** by the kernel at 14:17 UTC
(22:17 GMT+8). Confirmed in `dmesg`:

```
Out of memory: Killed process (prometheus) total-vm:9.6GB, anon-rss:1.1GB
```

The memory exhaustion (not the kill itself) starved **Docker's embedded DNS resolver
(127.0.0.11)**. Inter-container name resolution failed intermittently, so:

- backend couldn't resolve/reach `postgres` → query errors, bot scheduler stopped (split-brain guard)
- **nginx (`resolver 127.0.0.11 valid=5s`) couldn't resolve the `backend` upstream → players couldn't connect**
- NATS connections flapped

The public site stayed `HTTP 200` throughout (nginx + warm containers), which masked the
severity and misled early triage toward "is the server dead?" (it wasn't).

## Causal chain

```
Prometheus TSDB memory growth + periodic compaction (every ~2h)
  on a 2GB / 0-swap box already running 8 containers
    → memory exhausted → kernel global OOM-killer fires → kills Prometheus (biggest consumer)
        → during the pressure window, Docker embedded DNS (127.0.0.11) times out
            → nginx can't resolve `backend`, backend can't resolve `postgres`, NATS flaps
                → players can't connect (~19:00–19:43 GMT+8)
```

### Compounding factor — self-inflicted (operator error, documented for the lesson)

During investigation, aggressive **SSH retry loops + parallel bursts** (≈37 concurrent
connections) were fired **from the operator's own IP** against the already memory-tight box.
This:
- spiked `load` to **~79** on a 1–2 vCPU box and jammed `sshd` (default `MaxStartups 10:30:100`),
  producing the "banner exchange" lockout
- and a mistaken `fail2ban-client set sshd banip <operator-ip>` **banned the operator's own IP**
  (the 37 connections were legitimate key-auth reconnects — `Accepted publickey`, not an attacker)

Recovery: unbanned via a **ProxyJump through the game droplet over the VPC**
(`ssh -J root@<game> root@10.104.0.3`, source IP not banned). Killing the self-inflicted
connection storm dropped `load` from 79 → 2 almost immediately.

**Lesson:** do not hammer SSH retries against a resource-starved box from the operator IP —
it self-amplifies and can self-ban. Prefer the **DigitalOcean web console (out-of-band)** or a
**low-rate** single-connection retry. Note both droplets share the same key, so the game box is
a viable VPC jump host when the backend's public `sshd` is jammed.

### Misdiagnosis corrected (the value of EXPLAIN before claiming a bottleneck)

The per-user RTP Grafana alert/dashboard queries (added 2026-05-08) were suspected of being a
daily-worsening full table scan of `accounting_logs`. **`EXPLAIN (ANALYZE, BUFFERS)` disproved it:**
the planner drives the join from the tiny `accounts` table (**~9 real accounts** after excluding
bot/admin) and does index scans via `idx_accounting_logs_account_created` — **0.5 ms**, no seq scan.
The RTP query was **not** the cause. Always get a real plan before blaming a query.

## Fix (deployed)

1. **2 GB swapfile** on the host (`swappiness=10`) as a reclaim cushion (see `.csp/add-swap.sh`).
2. **`mem_limit: 900m` on the prometheus container** — the key protection: a Prometheus memory
   spike can now only kill **Prometheus itself**, never trigger a *global* OOM that takes down
   backend/postgres. (`docker-compose.services.yml`)
3. **Retention trimmed `30d → 15d` + `--storage.tsdb.retention.size=512MB`** to shrink the working set.
4. (Hygiene, not the fix) **`action_type IN (...)` predicate** added to RTP alert + 3 dashboard
   panels to future-proof against real-user growth (commit `ceb221b`).

## Diagnostic command cheat-sheet (for next time)

```bash
# memory / swap / load
free -h ; uptime
# confirm OOM kills
dmesg -T | grep -iE "out of memory|killed process|oom-kill"
# conntrack table (rule out table-full DNS drops)
cat /proc/sys/net/netfilter/nf_conntrack_{count,max}
# per-container CPU/mem
docker stats --no-stream
# SSH connection flood / who is connected on :22
ss -tn | grep ':22' | awk '{print $5}' | sed 's/:[0-9]*$//' | sort | uniq -c | sort -rn
fail2ban-client status sshd
# prove/disprove a query is the bottleneck
docker exec -i coin_pusher-postgres-1 psql -U postgres -d coinpusher -c "EXPLAIN (ANALYZE, BUFFERS) <query>"
```

## Watch items / follow-ups

- **Prometheus sits ~80% of the 900M cap right after restart** (WAL replay high-water). If it
  crash-loops on the cap, raise to ~1100m **or** cut retention to 7d. Acceptable as-is because the
  cap scopes any kill to Prometheus only.
- **Telegram alerting was 404** during the incident (`failed to send telegram message: 404`), so
  these alerts fired but never reached anyone. The bot token / webhook is dead — fix so future
  incidents page someone.
- **Server git drift:** `/opt/coin_pusher` HEAD (`c304d68`) has **diverged from origin/main** and
  carries uncommitted server-side changes (`.htpasswd`, staged `postgres.yml`/`economy-rtp.json`,
  `.env.bak.*`, `docker-compose.*.bak.*`). The "git pull deploy" model is not clean. Reconcile
  deliberately before the next backend deploy; the live container config is correct and the on-disk
  compose was re-asserted to match, but git is not the source of truth on this box yet.
- **Durable fix worth scheduling:** move Prometheus + Grafana off the backend droplet (or resize to
  4 GB). The monitoring stack is ~40% of RAM on a box that also runs the API/DB/NATS.

## Related
- ADR: `docs/decisions.md` D-001 (monitoring memory caps + swap)
- Commits: `90ef844`, `ceb221b`
