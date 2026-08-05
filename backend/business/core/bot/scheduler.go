package bot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/shopspring/decimal"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
	"github.com/flamefalcon/coin-pusher/backend/business/web/ws"
	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
)

// SchedulerAdvisoryLockID is a well-known int64 used with pg_try_advisory_lock
// to serialize the bot scheduler across replicas. Hex-readable for logs;
// arbitrary value chosen specifically for this lock and never reused.
//
// Released automatically when the holding session's Postgres connection ends —
// scheduler does NOT explicitly unlock so that a panic'd or KILL'd process
// still releases the lock at conn close.
const SchedulerAdvisoryLockID int64 = 0x42_07_B0_75_C4_ED_57_01

// Scheduler tick cadence and behavioral constants. Plan decision D8: behavioral
// parameters are Go consts (not bot_config rows) so they cannot be tuned
// outside their tested range without a deploy.
const (
	tickInterval = 5 * time.Second

	// configCacheTTL bounds staleness of bot_config reads. Set equal to the
	// tick interval so each tick refreshes once.
	configCacheTTL = 5 * time.Second

	// Per-insert behavioral envelopes (plan §"fire_due_inserts").
	insertSlotCount    = 5 // slots 0..4
	insertAmountMin    = 3
	insertAmountMax    = 15
	intervalMeanSec    = 30.0
	intervalStdDevSec  = 10.0
	intervalMinSec     = 10
	intervalMaxSec     = 90

	// Session lifecycle envelopes.
	sessionMinSec    = 10 * 60   // 10 min
	sessionMaxSec    = 40 * 60   // 40 min
	offlineMinSec    = 2 * 60    // 2 min
	offlineMaxSec    = 8 * 60    // 8 min
	initialDelayMin  = 10
	initialDelayMax  = 50

	// Cold-restart staggering (plan §"On scheduler startup").
	warmupMinSec = 5 * 60  // 5 min
	warmupMaxSec = 15 * 60 // 15 min

	// Outbox preflight thresholds. Above either of these we stop issuing new
	// inserts to avoid amplifying a backlog (silent-house-drain risk).
	outboxStallRowCountThreshold = 100
	outboxStallOldestSeconds     = 60

	// Daily-cap log throttling: emit one ERROR every hour, not every tick.
	capLogThrottle = 1 * time.Hour

	// EMA smoothing for crowd-driven target. alpha=0.1 → ~10-tick (50s)
	// effective averaging window. Replaces the prior "N consecutive
	// observations" hysteresis (plan decision).
	emaAlpha = 0.1
)

// Defaults applied when a bot_config row is missing OR malformed. The
// scheduler treats absence of config as "use safe defaults" rather than
// "do nothing" so a fresh deploy with no admin seed still behaves sanely.
const (
	defaultRefillAmount    = "100"
	defaultRefillThreshold = "20"
	defaultDailyCap        = "10000"
)

// defaultCrowdScale maps real-player count → desired online bot count.
// Index = bucket = floor(EMA of real player count), clamped to len-1.
// Plan: low real-player counts get high bot density to avoid empty-board
// feel; high real-player counts get few bots so platform is real-player-led.
var defaultCrowdScale = []int{3, 3, 2, 2, 1, 1, 0}

// PlayerCounter is the dependency injected by main.go that returns the
// current real-player WS connection count (joined connections minus
// spectators). Bots never open WS connections (Unit 4 rejects bot login),
// so no role plumbing is needed on Connection.
type PlayerCounter interface {
	ActiveRealPlayerCount() int
}

// Clock is an injectable now() so tests can advance time deterministically
// (e.g., to verify cold-restart warmup, session expiry, ema convergence).
type Clock interface {
	Now() time.Time
}

// realClock satisfies Clock with stdlib time.
type realClock struct{}

// Now returns the current wall time.
func (realClock) Now() time.Time { return time.Now() }

// NewRealClock returns a Clock backed by time.Now.
func NewRealClock() Clock { return realClock{} }

// HubPlayerCounter wraps a *ws.Hub to satisfy PlayerCounter. Lives here in
// the bot package so that main.go's wiring stays one line.
type HubPlayerCounter struct {
	Hub *ws.Hub
}

// ActiveRealPlayerCount returns Hub.Count - Hub.SpectatorCount. Bots never
// connect via WS, so a non-spectator connection is by construction a real
// player.
func (h HubPlayerCounter) ActiveRealPlayerCount() int {
	if h.Hub == nil {
		return 0
	}
	c := h.Hub.Count() - h.Hub.SpectatorCount()
	if c < 0 {
		return 0
	}
	return c
}

// botState is the in-memory per-bot session record. Reset on process restart;
// not durable. The cold-restart warmup window staggers initial eligibility so
// a fresh boot doesn't snap every bot online at once.
type botState struct {
	accountID     uuid.UUID
	displayName   *string
	online        bool
	sessionEndsAt time.Time
	offlineUntil  time.Time
	nextActionAt  time.Time
	balancePlay   decimal.Decimal
	balanceCash   decimal.Decimal
	// capExhaustedUntil is set when the daily cap has been hit AND this bot's
	// balance is below threshold; the bot stays offline until the next UTC
	// midnight (avoids BotInsertFailureTotal spam against a permanently
	// underfunded bot). Cleared on the first tick of the next UTC day.
	capExhaustedUntil time.Time
	// lastRefKey guards against same-tick unix_nano collisions when two bots'
	// fire_due slots resolve in the same nanosecond. Stored per-state so the
	// disambiguator can append a per-bot index.
	lastRefKey string
}

// Scheduler manages bot online/offline rotation, refills, and inserts.
//
// It is constructed once per API process and runs as a single goroutine
// driven by a 5s ticker. All inputs are injected to make unit tests
// deterministic; main.go wires concrete implementations.
//
// Singleton across replicas is enforced via pg_try_advisory_lock — if the
// lock is held by another process, Run() logs a warning and returns
// immediately without ticking. The API process keeps running.
type Scheduler struct {
	botCore       *Core
	gameCore      *game.Core
	acctCore      *accounting.Core
	heatEngine    *heat.HeatEngine
	playerCounter PlayerCounter
	clock         Clock
	rng           *rand.Rand
	log           *zap.SugaredLogger
	db            *sqlx.DB

	// liveness is the game server's heartbeat gate (fed by the WS handler's
	// slot_status subscription). Bots debit real ledger rows, so an insert
	// fired while the game server is down leaves the bot's balance and heat
	// drifting away from a table that never received the coins. See D-006.
	liveness *ws.GameLiveness

	// configCacheReader (test seam): when non-nil, replaces botCore-backed
	// config fetches. Production wiring leaves this nil and uses botCore.
	configCacheReader func(ctx context.Context) (map[string]string, error)

	// state is keyed by accountID. Not concurrent — only the scheduler
	// goroutine mutates it during a tick. Read concurrently by IsBot.
	state map[uuid.UUID]*botState

	// botIDs is an atomically-replaced snapshot of bot accountIDs for
	// IsBot lookups from outside the scheduler goroutine (e.g., main.go's
	// reward flush incrementing BotRewardTotalCash).
	botIDs atomic.Value // map[uuid.UUID]struct{}

	// Hysteresis state. ema is the smoothed real-player count; lastTarget is
	// the last applied desired-online-bot count. Both are scheduler-only.
	ema        float64
	lastTarget int

	// Throttling for the daily-cap-exceeded ERROR log.
	lastCapLog time.Time

	// Cached config snapshot.
	cachedCfg     parsedConfig
	cachedAt      time.Time

	// Cached paused-account set. Refreshed with the same TTL as cachedCfg.
	// Written by `admin bot pause`/`resume`; enforced here by skipping paused
	// bots in eligibilityand fire_due. nil means "not yet loaded" (treated as
	// empty set — safer than blocking the tick on a DB error).
	pausedIDs      map[uuid.UUID]struct{}
	pausedCachedAt time.Time
}

// parsedConfig is the typed view of bot_config the tick loop consumes.
type parsedConfig struct {
	killSwitch      bool
	refillAmount    decimal.Decimal
	refillThreshold decimal.Decimal
	dailyCap        decimal.Decimal
	crowdScale      []int
}

// SchedulerDeps bundles the constructor inputs. Keeps the call site readable
// despite the wide dependency surface.
type SchedulerDeps struct {
	BotCore       *Core
	GameCore      *game.Core
	AcctCore      *accounting.Core
	HeatEngine    *heat.HeatEngine
	PlayerCounter PlayerCounter
	Clock         Clock
	RNG           *rand.Rand
	Log           *zap.SugaredLogger
	DB            *sqlx.DB
	// Liveness gates inserts on the game server's heartbeat. Leaving it nil
	// reads as dead and the scheduler will never insert — deliberate, so an
	// unwired gate fails loudly rather than resurrecting the old behaviour.
	Liveness *ws.GameLiveness
}

// NewScheduler constructs a Scheduler. None of the dependencies are validated
// here — the call site is expected to supply real values; missing deps fail
// at first use with a clear panic-line stack trace.
func NewScheduler(deps SchedulerDeps) *Scheduler {
	s := &Scheduler{
		botCore:       deps.BotCore,
		gameCore:      deps.GameCore,
		acctCore:      deps.AcctCore,
		heatEngine:    deps.HeatEngine,
		playerCounter: deps.PlayerCounter,
		clock:         deps.Clock,
		rng:           deps.RNG,
		log:           deps.Log,
		db:            deps.DB,
		liveness:      deps.Liveness,
		state:         make(map[uuid.UUID]*botState),
	}
	s.botIDs.Store(map[uuid.UUID]struct{}{})
	return s
}

// IsBot reports whether the given account ID is a known bot. Safe to call
// from any goroutine; backed by an atomic snapshot updated whenever the
// scheduler reloads its bot pool. Used by main.go's reward flush to label
// the BotRewardTotalCash counter without doing a SQL lookup per credit.
//
// Returns false during the brief window between scheduler startup and first
// pool load — acceptable since BotRewardTotalCash is observability, not a
// safety gate.
func (s *Scheduler) IsBot(accountID uuid.UUID) bool {
	if s == nil {
		return false
	}
	v := s.botIDs.Load()
	if v == nil {
		return false
	}
	m, ok := v.(map[uuid.UUID]struct{})
	if !ok {
		return false
	}
	_, isBot := m[accountID]
	return isBot
}

// ErrRealMoneyEnabled is returned by Run when the BACKEND_REAL_MONEY_ENABLED
// fail-closed gate trips. main.go treats this as a structural refusal: the
// scheduler goroutine exits, the API process continues running without
// scheduler activity, and operator intervention is required.
var ErrRealMoneyEnabled = errors.New("bot scheduler disabled: BACKEND_REAL_MONEY_ENABLED is true")

// Run blocks until ctx is canceled. Acquires the singleton advisory lock; if
// another replica holds it, logs WARN and returns nil cleanly so main.go can
// continue starting the API server.
//
// On the fail-closed real-money gate: if BACKEND_REAL_MONEY_ENABLED=true,
// Run logs at error severity (with "FATAL gate" wording so the message is
// grep-able alongside true zap.Fatal output) and returns ErrRealMoneyEnabled.
// The scheduler goroutine exits; main.go must keep the API running. Using
// zap's Fatal would call os.Exit and kill the entire API process, which is
// stricter than the plan calls for and would prevent operators from reaching
// the API to fix the misconfiguration.
func (s *Scheduler) Run(ctx context.Context) error {
	if isRealMoneyEnabled() {
		s.log.Errorw("bot scheduler FATAL gate: BACKEND_REAL_MONEY_ENABLED=true; refusing to start")
		return ErrRealMoneyEnabled
	}

	// Derive a cancellable child ctx so the advisory-lock keepalive can
	// unilaterally stop the scheduler if the pinned conn dies (the session
	// lock goes with the conn; continuing to tick under a released lock
	// would break the singleton invariant).
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	if s.db != nil {
		acquired, err := s.tryAcquireAdvisoryLock(runCtx, cancel)
		if err != nil {
			s.log.Warnw("bot scheduler advisory lock acquire failed; continuing without scheduler",
				"error", err, "lock_id", SchedulerAdvisoryLockID)
			return nil
		}
		if !acquired {
			s.log.Warnw("bot scheduler already running on another instance; this replica will not tick",
				"lock_id", SchedulerAdvisoryLockID)
			return nil
		}
	}

	ctx = runCtx // downstream tick uses the cancellable ctx

	if err := s.loadBotPool(ctx); err != nil {
		s.log.Errorw("bot scheduler initial pool load failed; aborting startup", "error", err)
		return fmt.Errorf("loading bot pool: %w", err)
	}

	s.applyWarmupStagger()

	s.log.Infow("bot scheduler started",
		"pool_size", len(s.state),
		"tick_interval", tickInterval,
		"advisory_lock_id", SchedulerAdvisoryLockID,
	)

	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			s.log.Infow("bot scheduler stopping", "reason", ctx.Err())
			metrics.BotActiveCount.Set(0)
			metrics.BotOutboxStalled.Set(0)
			return nil
		case <-ticker.C:
			s.runTick(ctx)
		}
	}
}

// advisoryLockKeepaliveInterval is how often the scheduler health-checks the
// pinned conn that holds pg_try_advisory_lock. Postgres session-scope locks
// are released silently when the TCP conn dies (network blip, idle timeout,
// DB failover) so without a keepalive the scheduler could continue ticking
// under a released lock while a second replica also acquires it — breaking
// the singleton invariant. 30s keeps the detection window short without
// hammering the DB.
const advisoryLockKeepaliveInterval = 30 * time.Second

// tryAcquireAdvisoryLock returns true iff this session holds the bot
// scheduler advisory lock. The lock is auto-released on connection close, so
// no explicit unlock is needed during shutdown.
//
// Postgres pg_try_advisory_lock acquires a session-scope lock; with sqlx's
// connection pooling we must pin the lock attempt to a single conn so the
// session that holds the lock is the same session whose lifetime governs
// release. Holding a single *sql.Conn open for the lifetime of the scheduler
// is the standard pattern.
//
// On acquire, a keepalive goroutine runs SELECT 1 on the pinned conn every
// advisoryLockKeepaliveInterval. If the check fails, the goroutine calls
// cancelRun to stop the scheduler — staying alive under a lost lock would
// break the singleton guarantee.
func (s *Scheduler) tryAcquireAdvisoryLock(ctx context.Context, cancelRun context.CancelFunc) (bool, error) {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return false, fmt.Errorf("acquire conn: %w", err)
	}

	var held bool
	if err := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", SchedulerAdvisoryLockID).Scan(&held); err != nil {
		conn.Close()
		return false, fmt.Errorf("pg_try_advisory_lock: %w", err)
	}

	if !held {
		conn.Close()
		return false, nil
	}

	// Keep the conn alive for the lifetime of the process with a periodic
	// health check. The conn is intentionally never returned to the pool —
	// closing it would release the lock. main.go's shutdown sequence
	// (cancel scheduler ctx → wait → db.Close) will close this conn.
	go func() {
		ticker := time.NewTicker(advisoryLockKeepaliveInterval)
		defer ticker.Stop()
		defer conn.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// Use a short per-probe context so a genuinely unresponsive
				// DB doesn't block the keepalive indefinitely.
				probeCtx, cancelProbe := context.WithTimeout(ctx, 5*time.Second)
				err := conn.PingContext(probeCtx)
				cancelProbe()
				if err != nil {
					s.log.Errorw("bot scheduler advisory lock conn health check failed; stopping scheduler to avoid split-brain",
						"error", err, "lock_id", SchedulerAdvisoryLockID)
					cancelRun()
					return
				}
			}
		}
	}()
	return true, nil
}

// loadBotPool fetches the bot accounts and rebuilds the in-memory state map
// + IsBot lookup snapshot. Called once at startup — bot pool changes
// (admin bot seed) are picked up after restart, not at runtime.
func (s *Scheduler) loadBotPool(ctx context.Context) error {
	bots, err := s.botCore.ListAllBots(ctx)
	if err != nil {
		return err
	}
	now := s.clock.Now()
	idSet := make(map[uuid.UUID]struct{}, len(bots))
	for _, b := range bots {
		idSet[b.AccountID] = struct{}{}
		st, ok := s.state[b.AccountID]
		if !ok {
			st = &botState{accountID: b.AccountID}
			s.state[b.AccountID] = st
		}
		st.displayName = b.DisplayName
		st.balancePlay = b.BalancePlay
		st.balanceCash = b.BalanceCash
		// Initialize never-online state to "wait warmup window".
		if st.offlineUntil.IsZero() {
			st.offlineUntil = now
		}
	}
	s.botIDs.Store(idSet)
	return nil
}

// applyWarmupStagger sets each bot's offlineUntil to a uniformly random time
// in [now+warmupMinSec, now+warmupMaxSec]. Prevents a cold restart from
// onboarding all bots into the same first tick — would otherwise create a
// thundering-herd insert burst.
func (s *Scheduler) applyWarmupStagger() {
	now := s.clock.Now()
	minSec, maxSec := warmupMinSec, warmupMaxSec
	if os.Getenv("BOT_WARMUP_FAST") == "1" {
		minSec, maxSec = 5, 10
	}
	span := maxSec - minSec
	for _, st := range s.state {
		offset := minSec + s.rng.Intn(span+1)
		st.offlineUntil = now.Add(time.Duration(offset) * time.Second)
	}
}

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

// runTick executes one scheduling pass. Designed to never propagate a panic:
// the per-bot insert loop is wrapped in recover() so a single malformed bot
// state cannot kill the goroutine.
func (s *Scheduler) runTick(ctx context.Context) {
	start := time.Now()
	metrics.WorkerRuns.WithLabelValues("bot_scheduler").Inc()
	defer func() {
		metrics.WorkerDuration.WithLabelValues("bot_scheduler").Observe(time.Since(start).Seconds())
	}()

	// Tick-level panic guard. fireOneInsert has its own recover for per-bot
	// isolation, but a panic inside getConfigCached / outboxStalled /
	// DailyRefillTotal / refillPass / adjustOnlineSet would propagate to
	// Run() and kill the scheduler goroutine permanently. The per-tick
	// guard keeps the scheduler alive across transient bugs; a persistent
	// bug will show up as sustained bot_scheduler WorkerErrors.
	defer func() {
		if r := recover(); r != nil {
			metrics.WorkerErrors.WithLabelValues("bot_scheduler").Inc()
			s.log.Errorw("bot scheduler tick panicked; recovered, will resume next tick",
				"panic", r)
		}
	}()

	now := s.clock.Now()

	cfg, err := s.getConfigCached(ctx, now)
	if err != nil {
		s.log.Warnw("bot scheduler config load error; using cached or defaults", "error", err)
		metrics.WorkerErrors.WithLabelValues("bot_scheduler").Inc()
	}

	if cfg.killSwitch {
		s.takeAllOffline()
		metrics.BotActiveCount.Set(0)
		metrics.BotOutboxStalled.Set(0)
		return
	}

	// Refresh paused-bot set (cache-fronted) and force any currently-online
	// paused bot offline. Paused bots are re-admitted automatically on resume
	// via the normal eligibility path at the next tick.
	s.refreshPausedCache(ctx, now)
	for _, st := range s.state {
		if !st.online {
			continue
		}
		if _, paused := s.pausedIDs[st.accountID]; paused {
			st.online = false
			// Set a short offlineUntil so the same bot isn't immediately
			// re-brought-online in this tick's adjustOnlineSet — a resume
			// happens via admin action, not by internal rotation.
			st.offlineUntil = now.Add(time.Minute)
		}
	}

	skipInserts := false
	if s.db != nil {
		stalled, err := s.outboxStalled(ctx)
		if err != nil {
			s.log.Warnw("bot scheduler outbox stall check error; treating as stalled", "error", err)
			stalled = true
		}
		if stalled {
			metrics.BotOutboxStalled.Set(1)
			skipInserts = true
		} else {
			metrics.BotOutboxStalled.Set(0)
		}
	}

	dailyTotal, err := s.botCore.DailyRefillTotal(ctx)
	if err != nil {
		s.log.Warnw("bot scheduler daily refill total query error", "error", err)
		dailyTotal = decimal.Zero
	}
	capRemaining := cfg.dailyCap.Sub(dailyTotal)
	if capRemaining.Sign() < 0 {
		capRemaining = decimal.Zero
	}
	metrics.BotRefillDailyCapRemaining.Set(toFloat(capRemaining))

	capExceeded := dailyTotal.GreaterThanOrEqual(cfg.dailyCap)
	if capExceeded {
		s.handleDailyCapExceeded(now, cfg)
	} else {
		s.refillPass(ctx, now, cfg)
	}

	// Crowd target via EMA hysteresis (plan decision).
	realCount := s.playerCounter.ActiveRealPlayerCount()
	s.ema = (1.0-emaAlpha)*s.ema + emaAlpha*float64(realCount)
	target := lookupCrowdScale(cfg.crowdScale, int(math.Floor(s.ema)))

	s.adjustOnlineSet(now, target)
	s.endExpiredSessions(now)

	if !skipInserts {
		s.fireDueInserts(ctx, now)
	}

	// Active count gauge reflects post-tick truth.
	online := 0
	for _, st := range s.state {
		if st.online {
			online++
		}
	}
	metrics.BotActiveCount.Set(float64(online))
	s.lastTarget = target
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// getConfigCached returns the parsed bot_config, refreshing from storage at
// most once per configCacheTTL window. Stale cache is preferred over a
// transient DB error.
func (s *Scheduler) getConfigCached(ctx context.Context, now time.Time) (parsedConfig, error) {
	if !s.cachedAt.IsZero() && now.Sub(s.cachedAt) < configCacheTTL {
		return s.cachedCfg, nil
	}

	var raw map[string]string
	var err error
	if s.configCacheReader != nil {
		raw, err = s.configCacheReader(ctx)
	} else {
		// Direct storer access via a single QueryConfigAll bypass to avoid
		// 5 separate GetConfig calls (each of which fetches the whole map
		// internally).
		raw, err = s.queryAllConfig(ctx)
	}
	if err != nil {
		// Keep stale cache on transient errors.
		if !s.cachedAt.IsZero() {
			return s.cachedCfg, err
		}
		// First load failed — return defaults so the scheduler still ticks.
		return parsedConfig{
			killSwitch:      false,
			refillAmount:    mustDecimal(defaultRefillAmount),
			refillThreshold: mustDecimal(defaultRefillThreshold),
			dailyCap:        mustDecimal(defaultDailyCap),
			crowdScale:      defaultCrowdScale,
		}, err
	}

	cfg := parsedConfig{
		killSwitch:      raw[ConfigKeyKillSwitch] == "on",
		refillAmount:    parseDecimalOr(raw[ConfigKeyRefillAmount], defaultRefillAmount),
		refillThreshold: parseDecimalOr(raw[ConfigKeyRefillThreshold], defaultRefillThreshold),
		dailyCap:        parseDecimalOr(raw[ConfigKeyDailyCap], defaultDailyCap),
		crowdScale:      parseCrowdScale(raw[ConfigKeyCrowdScale]),
	}
	s.cachedCfg = cfg
	s.cachedAt = now
	return cfg, nil
}

// queryAllConfig is a thin wrapper around the bot core's per-key API. The
// core does not currently expose QueryConfigAll directly (storer-internal),
// but GetConfig is built on QueryConfigAll under the hood — calling once for
// any known key and ignoring the value would force the call but throw away
// the rest. To stay within bot.Core's public surface, fetch each key.
//
// Future optimization: expose Core.GetAllConfig() to drop this from N round
// trips to 1. For 5 keys at 5s tick the overhead is negligible.
func (s *Scheduler) queryAllConfig(ctx context.Context) (map[string]string, error) {
	out := make(map[string]string, 5)
	for _, k := range []string{
		ConfigKeyKillSwitch,
		ConfigKeyRefillAmount,
		ConfigKeyRefillThreshold,
		ConfigKeyDailyCap,
		ConfigKeyCrowdScale,
	} {
		v, err := s.botCore.GetConfig(ctx, k)
		if err != nil {
			if errors.Is(err, ErrConfigNotFound) {
				continue
			}
			return nil, err
		}
		out[k] = v
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Outbox preflight
// ---------------------------------------------------------------------------

// outboxStalled reports whether the nats_outbox table has accumulated enough
// pending rows OR aged rows to indicate the drainer is unhealthy. When true,
// the scheduler skips inserts for this tick — refills still run because they
// are not coupled to a NATS publish path.
//
// Single SELECT fetches both signals in one round trip. Errors are surfaced
// to the caller (treated as "stalled" upstream — fail-closed for inserts).
func (s *Scheduler) outboxStalled(ctx context.Context) (bool, error) {
	const q = `
		SELECT
			COUNT(*) AS pending_count,
			COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0) AS oldest_age_sec
		FROM nats_outbox
		WHERE attempt_count < 10
	`
	var row struct {
		PendingCount int64   `db:"pending_count"`
		OldestAgeSec float64 `db:"oldest_age_sec"`
	}
	if err := s.db.GetContext(ctx, &row, q); err != nil {
		return false, fmt.Errorf("outbox stall query: %w", err)
	}
	if row.PendingCount > outboxStallRowCountThreshold {
		return true, nil
	}
	if row.OldestAgeSec > outboxStallOldestSeconds {
		return true, nil
	}
	return false, nil
}

// ---------------------------------------------------------------------------
// Refill
// ---------------------------------------------------------------------------

// refillPass tops up bots whose total balance is below the configured
// threshold. Uses a daily-bucketed reference_id so retries within the same
// UTC day are idempotent — the unique-index on accounting_logs blocks
// duplicates and ProcessBotRefill silently swallows them.
func (s *Scheduler) refillPass(ctx context.Context, now time.Time, cfg parsedConfig) {
	dayKey := now.UTC().Format("20060102")
	// Iterate in deterministic order so unit tests can assert behavior.
	for _, st := range s.iterStateOrdered() {
		total := st.balancePlay.Add(st.balanceCash)
		if total.GreaterThanOrEqual(cfg.refillThreshold) {
			continue
		}
		refKey := fmt.Sprintf("bot-refill:%s:%s", st.accountID.String(), dayKey)
		newPlay, err := s.botCore.RefillBalance(ctx, st.accountID, cfg.refillAmount, refKey)
		if err != nil {
			// Refill errors are not silent — these gate every downstream
			// insert. Log once per bot per tick, increment the worker error
			// counter, continue to next bot.
			s.log.Warnw("bot refill failed",
				"account_id", st.accountID,
				"amount", cfg.refillAmount.String(),
				"ref_key", refKey,
				"error", err)
			metrics.WorkerErrors.WithLabelValues("bot_scheduler").Inc()
			continue
		}
		// Successful refill (or idempotent replay returning current balance).
		// Track the metric only on positive delta so idempotent replays
		// don't double-count.
		delta := newPlay.Sub(st.balancePlay)
		if delta.Sign() > 0 {
			metrics.BotRefillTotalPlay.Add(toFloat(delta))
		}
		st.balancePlay = newPlay
		// Clear cap-exhaustion state — bot now has funds.
		st.capExhaustedUntil = time.Time{}
	}
}

// refreshPausedCache loads the paused-account set from bot.Core if the
// cache has expired. Uses the same TTL as config. On error, keeps the
// previous cache (fail-open for pause — operators can retry) and logs a
// warning.
func (s *Scheduler) refreshPausedCache(ctx context.Context, now time.Time) {
	if !s.pausedCachedAt.IsZero() && now.Sub(s.pausedCachedAt) < configCacheTTL {
		return
	}
	ids, err := s.botCore.PausedAccountIDs(ctx)
	if err != nil {
		s.log.Warnw("bot scheduler paused-accounts query error; using stale cache", "error", err)
		return
	}
	s.pausedIDs = ids
	s.pausedCachedAt = now
}

// handleDailyCapExceeded throttles the cap-breach error log and pulls
// underfunded bots offline so the scheduler doesn't burn metrics retrying
// inserts they cannot afford for the rest of the UTC day.
func (s *Scheduler) handleDailyCapExceeded(now time.Time, cfg parsedConfig) {
	if now.Sub(s.lastCapLog) > capLogThrottle {
		s.log.Errorw("bot scheduler daily refill cap exceeded; refills paused for rest of UTC day",
			"daily_cap", cfg.dailyCap.String())
		s.lastCapLog = now
	}
	// Use UTC components to compute the UTC-day boundary. Using now.Year()/Month()/Day()
	// directly mixes the server's local calendar date with time.UTC, which on a non-UTC
	// server produces a date offset from the cap-reset day (DailyRefillTotal uses UTC).
	nowUTC := now.UTC()
	nextMidnight := time.Date(nowUTC.Year(), nowUTC.Month(), nowUTC.Day()+1, 0, 0, 0, 0, time.UTC)
	for _, st := range s.state {
		total := st.balancePlay.Add(st.balanceCash)
		if total.LessThan(cfg.refillThreshold) {
			st.capExhaustedUntil = nextMidnight
			st.online = false
		}
	}
}

// ---------------------------------------------------------------------------
// Online/offline rotation
// ---------------------------------------------------------------------------

// takeAllOffline flips every bot to offline. Called when the kill switch is
// set; in-flight ledger writes from prior ticks are unaffected because the
// scheduler is single-threaded and each tick completes before the next runs.
func (s *Scheduler) takeAllOffline() {
	for _, st := range s.state {
		st.online = false
	}
}

// adjustOnlineSet drives the online bot count toward target by either
// promoting one offline-eligible bot online OR demoting one online bot
// offline. At most one transition per tick — the EMA hysteresis already
// smooths the input signal, so per-tick incremental adjustment is
// sufficient and avoids oscillation.
func (s *Scheduler) adjustOnlineSet(now time.Time, target int) {
	online := 0
	for _, st := range s.state {
		if st.online {
			online++
		}
	}

	if online < target {
		eligible := s.eligibleOfflineBots(now)
		if len(eligible) > 0 {
			pick := eligible[s.rng.Intn(len(eligible))]
			pick.online = true
			pick.sessionEndsAt = now.Add(randDurationSec(s.rng, sessionMinSec, sessionMaxSec))
			pick.nextActionAt = now.Add(randDurationSec(s.rng, initialDelayMin, initialDelayMax))
		}
		return
	}

	if online > target {
		victim := s.pickClosestToSessionEnd()
		if victim != nil {
			victim.online = false
			victim.offlineUntil = now.Add(randDurationSec(s.rng, offlineMinSec, offlineMaxSec))
		}
	}
}

// eligibleOfflineBots returns offline bots whose offlineUntil has elapsed
// AND who are not in cap-exhaustion state. Iteration over s.state is map
// order; sort by accountID for determinism inside tests.
func (s *Scheduler) eligibleOfflineBots(now time.Time) []*botState {
	var out []*botState
	for _, st := range s.state {
		if st.online {
			continue
		}
		if !st.offlineUntil.IsZero() && st.offlineUntil.After(now) {
			continue
		}
		if !st.capExhaustedUntil.IsZero() && st.capExhaustedUntil.After(now) {
			continue
		}
		if _, paused := s.pausedIDs[st.accountID]; paused {
			continue
		}
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].accountID.String() < out[j].accountID.String()
	})
	return out
}

// pickClosestToSessionEnd selects the online bot whose session would expire
// soonest. Tie-breaks on accountID so behavior is deterministic in tests.
func (s *Scheduler) pickClosestToSessionEnd() *botState {
	var best *botState
	for _, st := range s.state {
		if !st.online {
			continue
		}
		if best == nil {
			best = st
			continue
		}
		if st.sessionEndsAt.Before(best.sessionEndsAt) {
			best = st
		} else if st.sessionEndsAt.Equal(best.sessionEndsAt) &&
			st.accountID.String() < best.accountID.String() {
			best = st
		}
	}
	return best
}

// endExpiredSessions takes offline any bot whose session has elapsed.
func (s *Scheduler) endExpiredSessions(now time.Time) {
	for _, st := range s.state {
		if !st.online {
			continue
		}
		if !st.sessionEndsAt.IsZero() && !st.sessionEndsAt.After(now) {
			st.online = false
			st.offlineUntil = now.Add(randDurationSec(s.rng, offlineMinSec, offlineMaxSec))
		}
	}
}

// ---------------------------------------------------------------------------
// Insert firing
// ---------------------------------------------------------------------------

// fireDueInserts walks online bots whose nextActionAt has passed and fires
// one insert each. Per-bot panics are recovered so a single malformed bot
// cannot kill the goroutine; context.Canceled is a clean shutdown signal,
// not a panic, and exits the loop cleanly without metric increments.
func (s *Scheduler) fireDueInserts(ctx context.Context, now time.Time) {
	idx := 0
	for _, st := range s.iterStateOrdered() {
		idx++
		if !st.online {
			continue
		}
		if !st.nextActionAt.IsZero() && st.nextActionAt.After(now) {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		s.fireOneInsert(ctx, st, now, idx)
	}
}

// fireOneInsert performs the gameCore.ProcessBatchInsert + heat add for a
// single bot. Wrapped in recover() per the plan: panics increment a counter
// and do NOT advance nextActionAt (so the next tick retries; metric drift
// is the failure mode if we advanced).
func (s *Scheduler) fireOneInsert(ctx context.Context, st *botState, now time.Time, botIdx int) {
	defer func() {
		if r := recover(); r != nil {
			// context.Canceled flowing through panic is not expected (it's an
			// error, not a panic), but defensive: don't count cancellation
			// as a panic if it ever shows up here.
			if err, ok := r.(error); ok && errors.Is(err, context.Canceled) {
				return
			}
			metrics.BotInsertPanicTotal.Inc()
			s.log.Errorw("bot insert panic recovered",
				"account_id", st.accountID,
				"panic", r)
			// Intentionally do NOT advance nextActionAt — next tick retries.
		}
	}()

	// Skip while the game server's heartbeat is stale: the debit would commit
	// and the outbox row would publish into a subject with no subscriber,
	// leaving this bot's balance and heat drifting from a table that never got
	// the coins. Advances nextActionAt like the other failure paths so the
	// bot keeps its cadence instead of retrying every tick. See D-006.
	if !s.liveness.Live() {
		metrics.GameUnavailableRejects.WithLabelValues("bot_insert").Inc()
		st.nextActionAt = now.Add(s.intervalJitter())
		return
	}

	slotID := s.rng.Intn(insertSlotCount)
	amount := insertAmountMin + s.rng.Intn(insertAmountMax-insertAmountMin+1)

	refKey := buildRefKey(st.accountID, now)
	if refKey == st.lastRefKey {
		refKey = fmt.Sprintf("%s:%d", refKey, botIdx)
	}
	st.lastRefKey = refKey

	payload, encErr := ws.EncodeBatchInsertPayload(st.accountID.String(), slotID, amount, refKey)
	if encErr != nil {
		metrics.BotInsertFailureTotal.Inc()
		s.log.Warnw("bot insert encode payload failed",
			"account_id", st.accountID, "ref_key", refKey, "error", encErr)
		st.nextActionAt = now.Add(s.intervalJitter())
		return
	}
	subject := ws.TopicBatchInsert("main")
	outboxWriter := func(c context.Context, store accounting.Storer) error {
		return store.InsertOutboxRow(c, subject, payload, refKey)
	}

	result, err := s.gameCore.ProcessBatchInsert(ctx, st.accountID, amount, refKey, outboxWriter)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		metrics.BotInsertFailureTotal.Inc()
		s.log.Warnw("bot insert ProcessBatchInsert error",
			"account_id", st.accountID, "ref_key", refKey, "error", err)
		st.nextActionAt = now.Add(s.intervalJitter())
		return
	}
	if !result.Success {
		metrics.BotInsertFailureTotal.Inc()
		s.log.Warnw("bot insert returned failure result",
			"account_id", st.accountID, "ref_key", refKey, "result_error", result.Error)
		st.nextActionAt = now.Add(s.intervalJitter())
		return
	}

	// Update in-memory balance from the result (cheap, avoids a re-read).
	if newPlay, perr := decimal.NewFromString(result.BalancePlay); perr == nil {
		st.balancePlay = newPlay
	}
	if newCash, cerr := decimal.NewFromString(result.BalanceCash); cerr == nil {
		st.balanceCash = newCash
	}

	metrics.BotInsertTotalPlay.Add(float64(amount))
	if s.heatEngine != nil {
		s.heatEngine.AddHeatForBot(st.accountID, amount)
	}
	st.nextActionAt = now.Add(s.intervalJitter())
}

// intervalJitter samples N(intervalMeanSec, intervalStdDevSec) clamped to
// [intervalMinSec, intervalMaxSec]. Jitter spreads inserts so 3 online bots
// don't synchronize their fire moments.
func (s *Scheduler) intervalJitter() time.Duration {
	v := s.rng.NormFloat64()*intervalStdDevSec + intervalMeanSec
	if v < float64(intervalMinSec) {
		v = float64(intervalMinSec)
	}
	if v > float64(intervalMaxSec) {
		v = float64(intervalMaxSec)
	}
	return time.Duration(v * float64(time.Second))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// iterStateOrdered yields bot states in deterministic accountID order. Tests
// rely on this for predictable assertions; production behavior is unaffected
// by ordering since per-bot logic is independent.
func (s *Scheduler) iterStateOrdered() []*botState {
	out := make([]*botState, 0, len(s.state))
	for _, st := range s.state {
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].accountID.String() < out[j].accountID.String()
	})
	return out
}

// buildRefKey builds the canonical bot insert reference_id. Format:
// "bot:<accountID>:<unix_nano>". Same-tick collisions get a per-bot
// disambiguator appended at the call site.
func buildRefKey(accountID uuid.UUID, now time.Time) string {
	return fmt.Sprintf("bot:%s:%d", accountID.String(), now.UnixNano())
}

// randDurationSec returns a uniform random duration in [minSec, maxSec]
// seconds. minSec must be <= maxSec.
func randDurationSec(rng *rand.Rand, minSec, maxSec int) time.Duration {
	span := maxSec - minSec
	if span < 0 {
		span = 0
	}
	return time.Duration(minSec+rng.Intn(span+1)) * time.Second
}

// lookupCrowdScale clamps the bucket index to the configured slice length
// and returns the desired online bot count. Empty/missing scale falls back
// to the package default.
func lookupCrowdScale(scale []int, bucket int) int {
	if len(scale) == 0 {
		scale = defaultCrowdScale
	}
	if bucket < 0 {
		bucket = 0
	}
	if bucket >= len(scale) {
		bucket = len(scale) - 1
	}
	return scale[bucket]
}

// parseCrowdScale parses the crowd_scale config value written by the admin
// CLI. The canonical format is a JSON object with stringified int keys and
// int values — e.g. {"0":3,"1":4,"2":4,"3":3,"4":3,"5":2} — where the key
// is the real-player count bucket and the value is the target active-bot
// count. The map is flattened into a slice indexed by bucket so that
// lookupCrowdScale can index it directly by floor(realPlayerCount).
//
// Missing buckets fill with the last known value (typical monotonic config).
// Returns the package default on any parse error; callers should log a
// warning upstream if this is unexpected. A CSV legacy format
// ("3,3,2,2,1,1,0") is also accepted for backwards compatibility with any
// manually-edited rows in production — detected by the absence of a leading
// '{' after trimming whitespace.
func parseCrowdScale(raw string) []int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return defaultCrowdScale
	}

	// JSON object form (the canonical format written by admin CLI).
	if strings.HasPrefix(raw, "{") {
		var m map[string]int
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			return defaultCrowdScale
		}
		if len(m) == 0 {
			return defaultCrowdScale
		}
		// Find the highest int key so we can size the slice.
		maxKey := -1
		parsed := make(map[int]int, len(m))
		for k, v := range m {
			n, err := strconv.Atoi(k)
			if err != nil || n < 0 || v < 0 {
				return defaultCrowdScale
			}
			parsed[n] = v
			if n > maxKey {
				maxKey = n
			}
		}
		if maxKey < 0 {
			return defaultCrowdScale
		}
		out := make([]int, maxKey+1)
		// Forward-fill: missing buckets inherit the previous bucket's value.
		// This matches the intuition "at real_count >= N, use the last
		// explicitly set bot count" for sparse configs.
		last := 0
		for i := 0; i <= maxKey; i++ {
			if v, ok := parsed[i]; ok {
				last = v
			}
			out[i] = last
		}
		return out
	}

	// Legacy CSV form.
	parts := strings.Split(raw, ",")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		v, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || v < 0 {
			return defaultCrowdScale
		}
		out = append(out, v)
	}
	if len(out) == 0 {
		return defaultCrowdScale
	}
	return out
}

// parseDecimalOr parses a decimal string, falling back to the supplied
// default literal on any error. Used for the three decimal-typed config
// keys (refill amount, threshold, daily cap).
func parseDecimalOr(raw, fallback string) decimal.Decimal {
	if raw == "" {
		return mustDecimal(fallback)
	}
	v, err := decimal.NewFromString(raw)
	if err != nil {
		return mustDecimal(fallback)
	}
	return v
}

// mustDecimal panics on parse error. Only called with package-private literal
// constants that are obviously valid; failure means a programming error in
// this file, not user input.
func mustDecimal(s string) decimal.Decimal {
	v, err := decimal.NewFromString(s)
	if err != nil {
		panic(fmt.Sprintf("bot scheduler: invalid decimal literal %q: %v", s, err))
	}
	return v
}

// toFloat collapses a Decimal to float64 for Prometheus gauge/counter
// emission. Loss of precision is acceptable here — these are monitoring
// signals, not financial state.
func toFloat(d decimal.Decimal) float64 {
	f, _ := d.Float64()
	return f
}

// isRealMoneyEnabled is the structural fail-closed gate for the real-money
// mode (plan §"Documentation / Operational Notes"). Returns true when the
// env var is set to "true" (case-insensitive); any other value (including
// unset) is false. Tests override realMoneyEnvLookup to inject deterministic
// values without touching the live process env.
func isRealMoneyEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(realMoneyEnvLookup("BACKEND_REAL_MONEY_ENABLED")))
	return v == "true"
}

// realMoneyEnvLookup is the test seam for the real-money gate. Production
// uses os.Getenv; tests assign a stub before calling NewScheduler+Run.
var realMoneyEnvLookup = os.Getenv

// LoadAndFireOneInsertForTest is an integration-test helper exported so
// scheduler_integration_test.go (external `bot_test` package) can drive a
// single insert through the production code path without waiting for the
// 5s tick interval.
//
// Loads the bot pool, locates the bot with the given ID, marks it online
// with nextActionAt in the past, and invokes the same fireOneInsert path
// the tick loop uses. Not safe for production use.
func LoadAndFireOneInsertForTest(s *Scheduler, ctx context.Context, botID uuid.UUID, now time.Time) error {
	if err := s.loadBotPool(ctx); err != nil {
		return fmt.Errorf("load pool: %w", err)
	}
	st, ok := s.state[botID]
	if !ok {
		return fmt.Errorf("bot %s not in pool after load", botID)
	}
	st.online = true
	st.nextActionAt = now.Add(-1 * time.Second)
	st.sessionEndsAt = now.Add(10 * time.Minute)

	s.fireOneInsert(ctx, st, now, 0)
	return nil
}
