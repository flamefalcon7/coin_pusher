// Coin Pusher API server entry point.
package main

import (
	"context"
	crand "crypto/rand"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ardanlabs/conf/v3"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/nats-io/nats.go"
	"github.com/shopspring/decimal"
	"github.com/vmihailenco/msgpack/v5"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/debug"
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/depositgrp"
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/gamegrp"
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/inventorygrp"
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/progressgrp"
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/sponsorgrp"
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/usergrp"
	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	ledgerdb "github.com/flamefalcon/coin-pusher/backend/business/core/accounting/stores/ledgerdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/deposit"
	depositdb "github.com/flamefalcon/coin-pusher/backend/business/core/deposit/stores/depositdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/outbox"
	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
	"github.com/flamefalcon/coin-pusher/backend/business/core/inventory"
	"github.com/flamefalcon/coin-pusher/backend/business/core/sponsor"
	sponsordb "github.com/flamefalcon/coin-pusher/backend/business/core/sponsor/stores/sponsordb"
	inventorydb "github.com/flamefalcon/coin-pusher/backend/business/core/inventory/stores/inventorydb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/progress"
	progressdb "github.com/flamefalcon/coin-pusher/backend/business/core/progress/stores/progressdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user/stores/userdb"
	"github.com/flamefalcon/coin-pusher/backend/business/web/auth"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	"github.com/flamefalcon/coin-pusher/backend/business/web/ws"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
	"github.com/flamefalcon/coin-pusher/backend/foundation/keystore"
	"github.com/flamefalcon/coin-pusher/backend/foundation/logger"
	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
	foundnats "github.com/flamefalcon/coin-pusher/backend/foundation/nats"
	"github.com/flamefalcon/coin-pusher/backend/foundation/wallet"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type config struct {
	Web struct {
		APIHost         string        `conf:"default:0.0.0.0:4000"`
		DebugHost       string        `conf:"default:0.0.0.0:4010"`
		ReadTimeout     time.Duration `conf:"default:5s"`
		WriteTimeout    time.Duration `conf:"default:10s"`
		IdleTimeout     time.Duration `conf:"default:120s"`
		ShutdownTimeout time.Duration `conf:"default:20s"`
		CORSOrigins     string        `conf:"default:*"`
	}
	DB struct {
		User         string `conf:"default:postgres"`
		Password     string `conf:"default:postgres,mask"`
		Host         string `conf:"default:localhost:5432"`
		Name         string `conf:"default:coinpusher"`
		MaxIdleConns int    `conf:"default:2"`
		MaxOpenConns int    `conf:"default:10"`
		DisableTLS   bool   `conf:"default:false"`
	}
	Auth struct {
		KeysFolder string `conf:"default:zarf/keys"`
		ActiveKID  string `conf:"default:default"`
		Issuer     string `conf:"default:coin-pusher"`
		DevMode    bool   `conf:"default:false"`
	}
	Game struct {
		APIKey string `conf:"default:dev-secret,mask"`
	}
	Wallet struct {
		Seed string `conf:"mask"`
	}
	NATS struct {
		URL           string        `conf:"default:nats://localhost:4222"`
		ReconnectWait time.Duration `conf:"default:2s"`
		MaxReconnects int           `conf:"default:60"`
	}
	// Outbox controls the transactional-outbox drainer for NATS batch_insert.
	// When Enabled, handlers write event rows to nats_outbox inside the
	// balance-debit tx and the drainer publishes them at-least-once. When
	// disabled (default), handlers fall back to the legacy publish-then-refund
	// flow. Flag exists for staged rollout; Unit 8 of the outbox plan removes
	// both the flag and the legacy path once production bakes confirm zero
	// BatchInsertRefundFailures increments.
	Outbox struct {
		Enabled bool `conf:"default:false"`
	}
}

func run() error {
	// -------------------------------------------------------------------------
	// Configuration
	var cfg config
	help, err := conf.Parse("BACKEND", &cfg)
	if err != nil {
		if err == conf.ErrHelpWanted {
			fmt.Println(help)
			return nil
		}
		return fmt.Errorf("parsing config: %w", err)
	}

	// -------------------------------------------------------------------------
	// Logger
	log, err := logger.New("api", "info")
	if err != nil {
		return fmt.Errorf("constructing logger: %w", err)
	}
	defer log.Sync()

	log.Infow("starting service", "host", cfg.Web.APIHost)

	if (cfg.Web.CORSOrigins == "*" || cfg.Web.CORSOrigins == "") && !cfg.Auth.DevMode {
		return fmt.Errorf("BACKEND_WEB_CORS_ORIGINS must be set in production (not wildcard or empty)")
	}

	if cfg.Game.APIKey == "dev-secret" && !cfg.Auth.DevMode {
		return fmt.Errorf("BACKEND_GAME_APIKEY must be set in production (not default)")
	}

	// -------------------------------------------------------------------------
	// Database
	db, err := database.Open(database.Config{
		User:         cfg.DB.User,
		Password:     cfg.DB.Password,
		Host:         cfg.DB.Host,
		Name:         cfg.DB.Name,
		MaxIdleConns: cfg.DB.MaxIdleConns,
		MaxOpenConns: cfg.DB.MaxOpenConns,
		DisableTLS:   cfg.DB.DisableTLS,
	})
	if err != nil {
		return fmt.Errorf("connecting to db: %w", err)
	}
	defer db.Close()

	metrics.StartDBCollector(db.DB, 5*time.Second)

	// -------------------------------------------------------------------------
	// Auth
	a, err := buildAuth(cfg, log)
	if err != nil {
		return fmt.Errorf("constructing auth: %w", err)
	}

	// -------------------------------------------------------------------------
	// Business Core
	userCore := user.NewCore(userdb.NewStore(db))
	if cfg.Auth.DevMode {
		userCore.SetInitialBalance(decimal.NewFromInt(10000))
	}
	acctCore := accounting.NewCore(
		db,
		ledgerdb.NewStore(db),
		userCore,
		func(dbtx database.DBTX) accounting.Storer { return ledgerdb.NewStore(dbtx) },
		func(dbtx database.DBTX) user.Storer { return userdb.NewStore(dbtx) },
	)
	gameCore := game.NewCore(userCore, acctCore)
	heatEngine := heat.New()
	inventoryCore := inventory.NewCore(
		db,
		inventorydb.NewStore(db),
		func(dbtx database.DBTX) inventory.Storer { return inventorydb.NewStore(dbtx) },
		func(dbtx database.DBTX) accounting.Storer { return ledgerdb.NewStore(dbtx) },
	)
	if cfg.Auth.DevMode {
		inventoryCore.SetDevDefaults(inventory.DevDefaults{
			KeyCoins:        100,
			ScrollShock:     100,
			ScrollTornado:   100,
			ScrollExplosion: 100,
			ScrollLightning: 100,
			ScrollSuperPush: 100,
			Megaspeaker:     100,
		})
	}

	// Progress/promotion domain.
	progressCore := progress.NewCore(
		log,
		db,
		progressdb.NewStore(db),
		func(dbtx database.DBTX) progress.Storer { return progressdb.NewStore(dbtx) },
		func(dbtx database.DBTX) accounting.Storer { return ledgerdb.NewStore(dbtx) },
		func(dbtx database.DBTX) user.Storer { return userdb.NewStore(dbtx) },
		inventoryCore,
	)

	// Wire metric recorder callbacks.
	acctCore.SetMetricRecorder(progressCore.RecordMetric)

	// Deposit/withdrawal domain (requires wallet seed).
	var depositCore *deposit.Core
	if cfg.Wallet.Seed != "" {
		w, err := wallet.New(cfg.Wallet.Seed)
		if err != nil {
			return fmt.Errorf("constructing wallet: %w", err)
		}
		depositCore = deposit.NewCore(
			db,
			depositdb.NewStore(db),
			w,
			acctCore,
			userCore,
			func(dbtx database.DBTX) deposit.Storer { return depositdb.NewStore(dbtx) },
			func(dbtx database.DBTX) user.Storer { return userdb.NewStore(dbtx) },
			func(dbtx database.DBTX) accounting.Storer { return ledgerdb.NewStore(dbtx) },
		)
		depositCore.SetMetricRecorder(progressCore.RecordMetric)

		log.Infow("deposit/withdrawal system initialized")
	} else {
		log.Warnw("BACKEND_WALLET_SEED not set — deposit/withdrawal routes disabled")
	}

	// -------------------------------------------------------------------------
	// NATS
	nc, err := foundnats.Connect(foundnats.Config{
		URL:           cfg.NATS.URL,
		ReconnectWait: cfg.NATS.ReconnectWait,
		MaxReconnects: cfg.NATS.MaxReconnects,
	}, log)
	if err != nil {
		return fmt.Errorf("connecting to nats: %w", err)
	}
	defer nc.Drain()

	// -------------------------------------------------------------------------
	// Outbox drainer. Always started once the nats_outbox schema is present,
	// independent of the BACKEND_OUTBOX_ENABLED flag. Rationale: the flag only
	// gates whether handlers WRITE outbox rows on new requests. Draining must
	// always be running so that a rollback (flag ON → OFF) cannot orphan rows
	// that were already committed — every nats_outbox row represents a balance
	// that was debited atomically, and must eventually reach NATS. An idle
	// drainer against an empty table is cheap (one empty SELECT per 5s tick).
	//
	// pq.NewListener needs its own connection string (separate from the sqlx
	// pool). Reconstruct it from the same DB config values.
	sslMode := "require"
	if cfg.DB.DisableTLS {
		sslMode = "disable"
	}
	listenDSN := fmt.Sprintf("host=%s user=%s password=%s dbname=%s sslmode=%s",
		strings.Split(cfg.DB.Host, ":")[0], cfg.DB.User, cfg.DB.Password, cfg.DB.Name, sslMode)
	if hostPort := strings.Split(cfg.DB.Host, ":"); len(hostPort) == 2 {
		listenDSN += " port=" + hostPort[1]
	}

	// Cancelable context + WaitGroup so graceful shutdown can drain to empty
	// before db.Close / nc.Drain tear down the drainer's dependencies. Without
	// this, a SIGTERM mid-pass leaves successfully-published rows un-DELETEd,
	// forcing a duplicate delivery on next boot.
	outboxCtx, outboxCancel := context.WithCancel(context.Background())
	var outboxWg sync.WaitGroup
	outboxWg.Add(1)
	go func() {
		defer outboxWg.Done()
		log.Infow("outbox drainer starting", "handler_flag", cfg.Outbox.Enabled)
		if err := outbox.Run(outboxCtx, db, nc, log, outbox.Config{
			ListenDSN: listenDSN,
		}); err != nil {
			log.Errorw("outbox drainer exited with error", "error", err)
		}
	}()
	if !cfg.Outbox.Enabled {
		log.Infow("outbox handler flag OFF — handlers on legacy publish+refund; drainer still running to clear any residual rows")
	}

	// -------------------------------------------------------------------------
	// WebSocket Hub, Relay, Handler
	hub := ws.NewHub()

	idleWarning := 25 * time.Minute
	idleTimeout := 30 * time.Minute
	idleCheck := 30 * time.Second
	if os.Getenv("IDLE_TEST") == "1" {
		idleWarning = 10 * time.Second
		idleTimeout = 20 * time.Second
		idleCheck = 3 * time.Second
		log.Infow("idle timeout TEST MODE enabled", "warning", idleWarning, "timeout", idleTimeout)
	}
	hub.StartIdleChecker(log, idleCheck, idleWarning, idleTimeout)

	relay := ws.NewRelay(log, nc, hub, "main")
	if err := relay.Start(); err != nil {
		return fmt.Errorf("starting nats relay: %w", err)
	}

	// Parse allowed origins for WebSocket CheckOrigin.
	var wsOrigins []string
	if cfg.Web.CORSOrigins == "*" {
		wsOrigins = []string{"*"}
	} else {
		for _, o := range strings.Split(cfg.Web.CORSOrigins, ",") {
			wsOrigins = append(wsOrigins, strings.TrimSpace(o))
		}
	}

	// Sponsor domain.
	sponsorStore := sponsordb.NewStore(db)
	sponsorCore := sponsor.NewCore(
		db,
		sponsorStore,
		func(dbtx database.DBTX) sponsor.Storer { return sponsordb.NewStore(dbtx) },
	)

	wsHandler := ws.NewHandler(log, hub, nc, a, gameCore, heatEngine, inventoryCore, userCore, sponsorCore, wsOrigins, cfg.Outbox.Enabled)

	// Subscribe to slot_status from game server for cap enforcement.
	if err := wsHandler.SubscribeSlotStatus(); err != nil {
		return fmt.Errorf("subscribing to slot_status: %w", err)
	}

	// -------------------------------------------------------------------------
	// Routes
	apiMux := buildAPIMux(log, db, a, cfg.Game.APIKey, cfg.Web.CORSOrigins, cfg.Auth.DevMode, userCore, acctCore, gameCore, heatEngine, inventoryCore, depositCore, progressCore, sponsorCore, nc, wsHandler, cfg.Outbox.Enabled)

	// -------------------------------------------------------------------------
	// Debug server
	debugMux := chi.NewRouter()
	debug.Routes(debugMux, db)
	debugServer := &http.Server{
		Addr:    cfg.Web.DebugHost,
		Handler: debugMux,
	}
	go func() {
		log.Infow("debug server starting", "host", cfg.Web.DebugHost)
		if err := debugServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Errorw("debug server error", "error", err)
		}
	}()

	// -------------------------------------------------------------------------
	// API server
	apiServer := &http.Server{
		Addr:         cfg.Web.APIHost,
		Handler:      apiMux,
		ReadTimeout:  cfg.Web.ReadTimeout,
		WriteTimeout: cfg.Web.WriteTimeout,
		IdleTimeout:  cfg.Web.IdleTimeout,
	}

	serverErrors := make(chan error, 1)
	go func() {
		log.Infow("api server starting", "host", cfg.Web.APIHost)
		serverErrors <- apiServer.ListenAndServe()
	}()

	// -------------------------------------------------------------------------
	// Heat broadcast goroutine (1s interval)
	stopHeat := make(chan struct{})
	go func() {
		// In-memory display name cache to avoid DB queries every broadcast.
		type cachedName struct {
			name      string
			fetchedAt time.Time
		}
		nameCache := make(map[uuid.UUID]cachedName)
		const nameCacheTTL = 60 * time.Second

		resolveName := func(uid uuid.UUID) string {
			if cached, ok := nameCache[uid]; ok && time.Since(cached.fetchedAt) < nameCacheTTL {
				return cached.name
			}
			name := uid.String()[:8] + "..."
			if acct, err := userCore.QueryByID(context.Background(), uid); err == nil && acct.DisplayName != nil {
				name = *acct.DisplayName
			}
			nameCache[uid] = cachedName{name: name, fetchedAt: time.Now()}
			return name
		}

		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				workerStart := time.Now()
				metrics.WorkerRuns.WithLabelValues("heat_broadcast").Inc()

				shares := heatEngine.GetShares()
				metrics.HeatActivePlayers.Set(float64(len(shares)))
				if len(shares) == 0 {
					metrics.WorkerDuration.WithLabelValues("heat_broadcast").Observe(time.Since(workerStart).Seconds())
					continue
				}
				type playerHeat struct {
					UserID   string  `msgpack:"user_id"`
					Username string  `msgpack:"username"`
					Share    float64 `msgpack:"share"`
					RawHeat  float64 `msgpack:"raw_heat"`
				}
				type heatMsg struct {
					Op      string       `msgpack:"op"`
					Players []playerHeat `msgpack:"players"`
				}
				msg := heatMsg{Op: "heat_update"}
				for _, s := range shares {
					msg.Players = append(msg.Players, playerHeat{
						UserID:   s.UserID.String(),
						Username: resolveName(s.UserID),
						Share:    s.Share,
						RawHeat:  s.RawHeat,
					})
				}
				data, err := msgpack.Marshal(msg)
				if err != nil {
					log.Errorw("heat broadcast marshal error", "error", err)
					metrics.WorkerErrors.WithLabelValues("heat_broadcast").Inc()
					metrics.WorkerDuration.WithLabelValues("heat_broadcast").Observe(time.Since(workerStart).Seconds())
					continue
				}
				nc.Publish(ws.TopicHeatUpdate("main"), data)

				// Prune stale heat entries and evict stale name cache entries.
				heatEngine.Prune()
				for uid, cached := range nameCache {
					if time.Since(cached.fetchedAt) > 5*nameCacheTTL {
						delete(nameCache, uid)
					}
				}
				metrics.WorkerDuration.WithLabelValues("heat_broadcast").Observe(time.Since(workerStart).Seconds())
			case <-stopHeat:
				return
			}
		}
	}()

	// -------------------------------------------------------------------------
	// Nonce purge goroutine (10 min interval)
	stopNoncePurge := make(chan struct{})
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				workerStart := time.Now()
				metrics.WorkerRuns.WithLabelValues("nonce_purge").Inc()
				n, err := userCore.PurgeExpiredNonces(context.Background())
				if err != nil {
					log.Errorw("nonce purge error", "error", err)
					metrics.WorkerErrors.WithLabelValues("nonce_purge").Inc()
				} else if n > 0 {
					log.Infow("purged expired nonces", "count", n)
				}
				metrics.WorkerDuration.WithLabelValues("nonce_purge").Observe(time.Since(workerStart).Seconds())
			case <-stopNoncePurge:
				return
			}
		}
	}()

	// -------------------------------------------------------------------------
	// Reward accumulator + flush goroutine (10s interval)
	var rewardMu sync.Mutex
	rewardAccum := make(map[uuid.UUID]float64)
	notifyAccum := make(map[uuid.UUID]float64)

	// Sponsor reward accumulator (keyed by campaignID -> accountID -> amount).
	type sponsorRewardKey struct {
		CampaignID uuid.UUID
		AccountID  uuid.UUID
	}
	sponsorRewardAccum := make(map[sponsorRewardKey]decimal.Decimal)

	// In-memory cache of active campaign data to avoid N+1 DB queries in despawn handler.
	var sponsorCacheMu sync.RWMutex
	sponsorCampaignCache := make(map[uuid.UUID]sponsor.Campaign)

	// Subscribe to coin_despawn events from game server.
	despawnSub, err := nc.Subscribe(ws.TopicCoinDespawn("main"), func(msg *nats.Msg) {
		var evt struct {
			Coins []struct {
				ID        int    `json:"id"`
				Zone      string `json:"zone"`
				OwnerID   string `json:"owner_id"`
				SponsorID string `json:"sponsor_id,omitempty"`
			} `json:"coins"`
			Tick int `json:"tick"`
		}
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			log.Errorw("coin_despawn unmarshal error", "error", err)
			return
		}

		// Separate regular front-edge coins from sponsor front-edge coins.
		regularFrontCount := 0
		sponsorFrontCounts := make(map[string]int) // campaignID -> count

		for _, c := range evt.Coins {
			if c.Zone == "front" {
				if c.SponsorID != "" {
					sponsorFrontCounts[c.SponsorID]++
				} else {
					regularFrontCount++
				}
			}
		}

		// Handle regular coin rewards via heat distribution.
		if regularFrontCount > 0 {
			dist := heatEngine.DistributeFrontEdgeDrop(regularFrontCount)
			if dist != nil {
				rewardMu.Lock()
				for uid, amount := range dist {
					rewardAccum[uid] += amount
					notifyAccum[uid] += amount
				}
				rewardMu.Unlock()
			}
		}

		// Handle sponsor coin rewards: distribute sponsor tokens via heat shares.
		for campaignIDStr, count := range sponsorFrontCounts {
			campaignID, err := uuid.Parse(campaignIDStr)
			if err != nil {
				log.Errorw("sponsor coin despawn: invalid campaign_id", "campaign_id", campaignIDStr)
				continue
			}

			// Look up reward_per_coin from cache (refreshed by sponsor_config).
			sponsorCacheMu.RLock()
			camp, cached := sponsorCampaignCache[campaignID]
			sponsorCacheMu.RUnlock()
			if !cached {
				camp, err = sponsorCore.Get(context.Background(), campaignID)
				if err != nil {
					log.Errorw("sponsor coin despawn: campaign lookup failed", "campaign_id", campaignIDStr, "error", err)
					continue
				}
				sponsorCacheMu.Lock()
				sponsorCampaignCache[campaignID] = camp
				sponsorCacheMu.Unlock()
			}

			totalReward := camp.RewardPerCoin.Mul(decimal.NewFromInt(int64(count)))
			shares := heatEngine.GetShares()
			if len(shares) == 0 {
				continue
			}

			rewardMu.Lock()
			for _, ps := range shares {
				playerAmount := totalReward.Mul(decimal.NewFromFloat(ps.Share))
				key := sponsorRewardKey{CampaignID: campaignID, AccountID: ps.UserID}
				sponsorRewardAccum[key] = sponsorRewardAccum[key].Add(playerAmount)
			}
			rewardMu.Unlock()
		}
	})
	if err != nil {
		return fmt.Errorf("subscribing to coin_despawn: %w", err)
	}
	defer despawnSub.Unsubscribe()

	flushRewards := func() {
		workerStart := time.Now()
		metrics.WorkerRuns.WithLabelValues("reward_flush").Inc()
		metrics.RewardFlushTotal.Inc()
		rewardMu.Lock()
		batch := rewardAccum
		rewardAccum = make(map[uuid.UUID]float64)
		rewardMu.Unlock()

		const coinPrecision = 1e6 // 6 decimal places, aligned with stablecoin precision
		for uid, amount := range batch {
			// Floor to coin precision. Dust stays with house.
			truncated := math.Floor(amount*coinPrecision) / coinPrecision
			if truncated < 1/coinPrecision {
				continue
			}
			refKey := uuid.NewString()
			amt := decimal.NewFromFloat(truncated)
			if err := acctCore.ProcessGameReward(context.Background(), uid, amt, refKey); err != nil {
				log.Errorw("heat reward flush error", "user_id", uid, "amount", truncated, "error", err)
				metrics.RewardFlushErrors.Inc()
				metrics.WorkerErrors.WithLabelValues("reward_flush").Inc()
			}
		}
		metrics.WorkerDuration.WithLabelValues("reward_flush").Observe(time.Since(workerStart).Seconds())
	}

	stopFlush := make(chan struct{})
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				flushRewards()
			case <-stopFlush:
				return
			}
		}
	}()

	// Reward notification flush — 1s interval, publishes to NATS for WS relay.
	stopNotify := make(chan struct{})
	go func() {
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				workerStart := time.Now()
				metrics.WorkerRuns.WithLabelValues("reward_notify").Inc()

				rewardMu.Lock()
				batch := notifyAccum
				notifyAccum = make(map[uuid.UUID]float64)
				rewardMu.Unlock()

				const coinPrecision = 1e6
				for uid, amount := range batch {
					truncated := math.Floor(amount*coinPrecision) / coinPrecision
					if truncated < 1/coinPrecision {
						continue
					}
					msg := struct {
						Op     string  `json:"op"`
						UserID string  `json:"user_id"`
						Amount float64 `json:"amount"`
					}{
						Op:     "reward",
						UserID: uid.String(),
						Amount: truncated,
					}
					data, err := json.Marshal(msg)
					if err != nil {
						log.Errorw("reward_notify marshal error", "error", err)
						metrics.WorkerErrors.WithLabelValues("reward_notify").Inc()
						continue
					}
					if err := nc.Publish(ws.TopicRewardNotify("main"), data); err != nil {
						log.Errorw("reward_notify publish error", "error", err)
						metrics.WorkerErrors.WithLabelValues("reward_notify").Inc()
					}
				}
				metrics.WorkerDuration.WithLabelValues("reward_notify").Observe(time.Since(workerStart).Seconds())
			case <-stopNotify:
				return
			}
		}
	}()

	// Sponsor reward flush — 10s interval, distributes sponsor tokens.
	flushSponsorRewards := func() {
		rewardMu.Lock()
		batch := sponsorRewardAccum
		sponsorRewardAccum = make(map[sponsorRewardKey]decimal.Decimal)
		rewardMu.Unlock()

		if len(batch) == 0 {
			return
		}

		flushEpoch := time.Now().Unix() / 10 // 10s buckets for deterministic ref_key

		// Per-flush campaign cache to avoid N+1 queries.
		campaignCache := make(map[uuid.UUID]sponsor.Campaign)

		for key, amount := range batch {
			if amount.IsZero() {
				continue
			}
			refKey := fmt.Sprintf("sponsor:%s:%s:%d", key.CampaignID, key.AccountID, flushEpoch)
			if err := sponsorCore.DistributeReward(context.Background(), key.CampaignID, key.AccountID, amount, refKey); err != nil {
				log.Errorw("sponsor reward flush error",
					"campaign_id", key.CampaignID,
					"account_id", key.AccountID,
					"amount", amount.String(),
					"error", err)
				continue
			}

			// Query actual cumulative balance for this player+campaign.
			var totalBalance string
			bals, err := sponsorCore.GetBalances(context.Background(), key.AccountID)
			if err != nil {
				log.Errorw("sponsor reward: balance lookup for notify", "error", err)
				totalBalance = amount.String() // fallback to flush amount
			} else {
				for _, b := range bals {
					if b.CampaignID == key.CampaignID {
						totalBalance = b.Balance.String()
						break
					}
				}
				if totalBalance == "" {
					totalBalance = amount.String()
				}
			}

			// Look up campaign for token symbol (use cache below).
			camp, ok := campaignCache[key.CampaignID]
			if !ok {
				camp, err = sponsorCore.Get(context.Background(), key.CampaignID)
				if err != nil {
					log.Errorw("sponsor reward: campaign lookup for notify", "error", err)
					continue
				}
				campaignCache[key.CampaignID] = camp
			}
			notifyMsg := struct {
				Op           string `json:"op"`
				UserID       string `json:"user_id"`
				CampaignID   string `json:"campaign_id"`
				TokenSymbol  string `json:"token_symbol"`
				Amount       string `json:"amount"`
				TotalBalance string `json:"total_balance"`
			}{
				Op:           "sponsor_reward",
				UserID:       key.AccountID.String(),
				CampaignID:   key.CampaignID.String(),
				TokenSymbol:  camp.TokenSymbol,
				Amount:       amount.String(),
				TotalBalance: totalBalance,
			}
			data, err := json.Marshal(notifyMsg)
			if err != nil {
				log.Errorw("sponsor_reward marshal error", "error", err)
				continue
			}
			if err := nc.Publish("game.main.sponsor_reward", data); err != nil {
				log.Errorw("sponsor_reward publish error", "error", err)
			}
		}
	}

	stopSponsorFlush := make(chan struct{})
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				flushSponsorRewards()
			case <-stopSponsorFlush:
				return
			}
		}
	}()

	// -------------------------------------------------------------------------
	// Key coin lucky draw: subscribe to key_coin_front_despawn from game server.
	keyCoinSub, err := nc.Subscribe(ws.TopicKeyCoinFrontDespawn("main"), func(msg *nats.Msg) {
		var evt struct {
			Count int `json:"count"`
			Tick  int `json:"tick"`
		}
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			log.Errorw("key_coin_front_despawn unmarshal error", "error", err)
			return
		}
		if evt.Count <= 0 {
			return
		}

		// Get heat shares to determine winner.
		shares := heatEngine.GetShares()
		if len(shares) == 0 {
			return
		}

		// Weighted random pick a winner based on heat shares.
		var totalShare float64
		for _, s := range shares {
			totalShare += s.Share
		}

		rVal := mustCryptoRandFloat64() * totalShare
		var cumulative float64
		var winnerID uuid.UUID
		for _, s := range shares {
			cumulative += s.Share
			if rVal < cumulative {
				winnerID = s.UserID
				break
			}
		}
		if winnerID == uuid.Nil {
			winnerID = shares[len(shares)-1].UserID
		}

		// Credit key coins to winner.
		if err := inventoryCore.CreditKeyCoins(context.Background(), winnerID, evt.Count); err != nil {
			log.Errorw("key coin credit error", "user_id", winnerID, "count", evt.Count, "error", err)
			return
		}
		metrics.KeyCoinDrawTotal.Inc()

		// Look up winner display name (fallback to truncated UUID like heat broadcast).
		winnerName := winnerID.String()[:8] + "..."
		acct, err := userCore.QueryByID(context.Background(), winnerID)
		if err == nil && acct.DisplayName != nil {
			winnerName = *acct.DisplayName
		}

		// Publish key_coin_draw to NATS for broadcast to all clients.
		drawMsg, _ := json.Marshal(map[string]interface{}{
			"op":          "key_coin_draw",
			"winner_id":   winnerID.String(),
			"winner_name": winnerName,
			"count":       evt.Count,
		})
		nc.Publish(ws.TopicKeyCoinDraw("main"), drawMsg)

		// Send inventory_update to winner via WS.
		inv, err := inventoryCore.GetInventory(context.Background(), winnerID)
		if err == nil {
			invMsg, _ := msgpack.Marshal(map[string]interface{}{
				"op":                "inventory_update",
				"key_coins":         inv.KeyCoins,
				"scroll_shock":      inv.ScrollShock,
				"scroll_tornado":    inv.ScrollTornado,
				"scroll_explosion":  inv.ScrollExplosion,
				"scroll_lightning":  inv.ScrollLightning,
				"scroll_super_push": inv.ScrollSuperPush,
				"megaspeaker":       inv.Megaspeaker,
			})
			hub.SendToUser(winnerID.String(), invMsg)
		}

		log.Infow("key coin draw", "winner_id", winnerID, "count", evt.Count)
	})
	if err != nil {
		return fmt.Errorf("subscribing to key_coin_front_despawn: %w", err)
	}
	defer keyCoinSub.Unsubscribe()

	// -------------------------------------------------------------------------
	// Progress expiration worker (30s interval) — expires unclaimed rewards past deadline
	stopExpire := make(chan struct{})
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				workerStart := time.Now()
				metrics.WorkerRuns.WithLabelValues("progress_expire").Inc()
				n, err := progressCore.ExpireOverdue(context.Background(), time.Now().UTC(), 100)
				if err != nil {
					log.Errorw("progress expire error", "error", err)
					metrics.WorkerErrors.WithLabelValues("progress_expire").Inc()
				} else if n > 0 {
					log.Infow("progress expired", "count", n)
				}
				metrics.WorkerDuration.WithLabelValues("progress_expire").Observe(time.Since(workerStart).Seconds())
			case <-stopExpire:
				return
			}
		}
	}()

	// -------------------------------------------------------------------------
	// RTP monitor worker — computes global RTP every 1h, per-player anomaly every 4h
	stopRTP := make(chan struct{})
	go func() {
		rtpTicker := time.NewTicker(1 * time.Hour)
		anomalyTicker := time.NewTicker(4 * time.Hour)
		defer rtpTicker.Stop()
		defer anomalyTicker.Stop()

		rtpStore := ledgerdb.NewStore(db)

		computeRTP := func() {
			workerStart := time.Now()
			metrics.WorkerRuns.WithLabelValues("rtp_monitor").Inc()

			windows := []struct {
				label    string
				duration time.Duration
			}{
				{"1h", 1 * time.Hour},
				{"24h", 24 * time.Hour},
				{"7d", 7 * 24 * time.Hour},
			}

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			for _, w := range windows {
				since := time.Now().UTC().Add(-w.duration)
				inserted, err := rtpStore.SumByActionSince(ctx, accounting.ActionGameInsert, since)
				if err != nil {
					log.Errorw("rtp_monitor: query inserted error", "window", w.label, "error", err)
					metrics.WorkerErrors.WithLabelValues("rtp_monitor").Inc()
					continue
				}
				rewarded, err := rtpStore.SumByActionSince(ctx, accounting.ActionGameReward, since)
				if err != nil {
					log.Errorw("rtp_monitor: query rewarded error", "window", w.label, "error", err)
					metrics.WorkerErrors.WithLabelValues("rtp_monitor").Inc()
					continue
				}

				insF, _ := inserted.Float64()
				rewF, _ := rewarded.Float64()
				metrics.RTPCoinsInserted.WithLabelValues(w.label).Set(insF)
				metrics.RTPCoinsRewarded.WithLabelValues(w.label).Set(rewF)

				if insF > 0 {
					metrics.RTPRatio.WithLabelValues(w.label).Set(rewF / insF)
				} else {
					metrics.RTPRatio.WithLabelValues(w.label).Set(0)
				}

				log.Infow("rtp_monitor", "window", w.label, "inserted", insF, "rewarded", rewF, "rtp", func() float64 {
					if insF > 0 {
						return rewF / insF
					}
					return 0
				}())
			}
			metrics.WorkerDuration.WithLabelValues("rtp_monitor").Observe(time.Since(workerStart).Seconds())
		}

		computeAnomaly := func() {
			workerStart := time.Now()
			metrics.WorkerRuns.WithLabelValues("rtp_anomaly").Inc()

			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()

			since := time.Now().UTC().Add(-24 * time.Hour)

			insertsByPlayer, err := rtpStore.SumByPlayerSince(ctx, accounting.ActionGameInsert, since)
			if err != nil {
				log.Errorw("rtp_anomaly: query inserts error", "error", err)
				metrics.WorkerErrors.WithLabelValues("rtp_anomaly").Inc()
				metrics.WorkerDuration.WithLabelValues("rtp_anomaly").Observe(time.Since(workerStart).Seconds())
				return
			}
			rewardsByPlayer, err := rtpStore.SumByPlayerSince(ctx, accounting.ActionGameReward, since)
			if err != nil {
				log.Errorw("rtp_anomaly: query rewards error", "error", err)
				metrics.WorkerErrors.WithLabelValues("rtp_anomaly").Inc()
				metrics.WorkerDuration.WithLabelValues("rtp_anomaly").Observe(time.Since(workerStart).Seconds())
				return
			}

			// Build reward lookup.
			rewardMap := make(map[uuid.UUID]float64, len(rewardsByPlayer))
			for _, r := range rewardsByPlayer {
				f, _ := r.Total.Float64()
				rewardMap[r.AccountID] = f
			}

			// Compute per-player RTP for players with meaningful activity.
			const minInsert = 10.0 // ignore players with fewer than 10 coins inserted
			type playerRTP struct {
				id  uuid.UUID
				rtp float64
			}
			var players []playerRTP
			var sum, sumSq float64

			for _, ins := range insertsByPlayer {
				insF, _ := ins.Total.Float64()
				if insF < minInsert {
					continue
				}
				rewF := rewardMap[ins.AccountID]
				rtp := rewF / insF
				players = append(players, playerRTP{id: ins.AccountID, rtp: rtp})
				sum += rtp
				sumSq += rtp * rtp
			}

			if len(players) < 2 {
				metrics.RTPPlayerAnomalyCount.Set(0)
				metrics.WorkerDuration.WithLabelValues("rtp_anomaly").Observe(time.Since(workerStart).Seconds())
				return
			}

			n := float64(len(players))
			mean := sum / n
			variance := sumSq/n - mean*mean
			stddev := math.Sqrt(variance)
			threshold := mean + 2*stddev

			anomalyCount := 0
			for _, p := range players {
				if p.rtp > threshold {
					anomalyCount++
					log.Warnw("rtp_anomaly: high RTP player",
						"account_id", p.id,
						"rtp", fmt.Sprintf("%.4f", p.rtp),
						"mean", fmt.Sprintf("%.4f", mean),
						"threshold", fmt.Sprintf("%.4f", threshold),
					)
				}
			}

			metrics.RTPPlayerAnomalyCount.Set(float64(anomalyCount))
			log.Infow("rtp_anomaly", "players_analyzed", len(players), "mean_rtp", fmt.Sprintf("%.4f", mean), "stddev", fmt.Sprintf("%.4f", stddev), "anomalies", anomalyCount)
			metrics.WorkerDuration.WithLabelValues("rtp_anomaly").Observe(time.Since(workerStart).Seconds())
		}

		// Run once at startup after a short delay.
		select {
		case <-time.After(10 * time.Second):
			computeRTP()
			computeAnomaly()
		case <-stopRTP:
			return
		}

		for {
			select {
			case <-rtpTicker.C:
				computeRTP()
			case <-anomalyTicker.C:
				computeAnomaly()
			case <-stopRTP:
				return
			}
		}
	}()

	// -------------------------------------------------------------------------
	// Shutdown
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-serverErrors:
		return fmt.Errorf("server error: %w", err)
	case sig := <-shutdown:
		log.Infow("shutdown started", "signal", sig)

		// Stop background goroutines.
		close(stopHeat)
		close(stopFlush)
		close(stopNotify)
		close(stopSponsorFlush)
		close(stopNoncePurge)
		close(stopExpire)
		close(stopRTP)

		// Stop outbox drainer BEFORE nc.Drain / db.Close (both fire via defer
		// at run()'s return). Waiting here guarantees the in-flight drain pass
		// finishes — publishing remaining rows and DELETE-ing them — before
		// the NATS connection drains or the DB pool closes. Without this, a
		// mid-pass DELETE hits a closed pool, rows stay un-deleted, and the
		// next boot re-publishes them (duplicate delivery).
		log.Infow("stopping outbox drainer")
		outboxCancel()
		outboxWg.Wait()

		// Flush remaining accumulated rewards to DB before exit.
		log.Infow("flushing remaining rewards")
		flushRewards()
		flushSponsorRewards()

		// Stop NATS relay first.
		relay.Stop()

		ctx, cancel := context.WithTimeout(context.Background(), cfg.Web.ShutdownTimeout)
		defer cancel()

		if err := apiServer.Shutdown(ctx); err != nil {
			apiServer.Close()
			return fmt.Errorf("graceful shutdown: %w", err)
		}

		if err := debugServer.Shutdown(ctx); err != nil {
			debugServer.Close()
		}
	}

	return nil
}

func buildAuth(cfg config, log *zap.SugaredLogger) (*auth.Auth, error) {
	if cfg.Auth.DevMode {
		log.Infow("AUTH DEV MODE ENABLED — signature verification disabled")
		return auth.NewDevAuth(cfg.Auth.Issuer), nil
	}

	ks, err := keystore.New(os.DirFS(cfg.Auth.KeysFolder))
	if err != nil {
		return nil, fmt.Errorf("loading keys: %w", err)
	}

	return auth.New(ks, cfg.Auth.ActiveKID, cfg.Auth.Issuer), nil
}

func mustCryptoRandFloat64() float64 {
	max := new(big.Int).SetUint64(1 << 53)
	n, err := crand.Int(crand.Reader, max)
	if err != nil {
		return 0
	}
	return float64(n.Uint64()) / float64(1<<53)
}

func buildAPIMux(
	log *zap.SugaredLogger,
	db *sqlx.DB,
	a *auth.Auth,
	gameAPIKey string,
	corsOrigins string,
	devMode bool,
	userCore *user.Core,
	acctCore *accounting.Core,
	gameCore *game.Core,
	heatEngine *heat.HeatEngine,
	inventoryCore *inventory.Core,
	depositCore *deposit.Core,
	progressCore *progress.Core,
	sponsorCore *sponsor.Core,
	nc *nats.Conn,
	wsHandler *ws.Handler,
	outboxEnabled bool,
) *chi.Mux {
	mux := chi.NewRouter()

	// Global middleware.
	origins := []string{"https://*", "http://*"}
	if corsOrigins != "*" {
		origins = nil
		for _, o := range strings.Split(corsOrigins, ",") {
			o = strings.TrimSpace(o)
			if strings.Contains(o, "*") {
				log.Warnw("rejecting wildcard CORS origin in production", "origin", o)
				continue
			}
			origins = append(origins, o)
		}
	}
	mux.Use(cors.Handler(cors.Options{
		AllowedOrigins:   origins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	mux.Use(mid.CorrelationID())
	mux.Use(mid.Panics(log))
	mux.Use(mid.Logger(log))

	// WebSocket route (no auth middleware -- auth happens during WS upgrade).
	mux.Get("/ws", wsHandler.ServeHTTP)

	// V1 routes.
	userGrp := usergrp.New(userCore, a)
	gameGrp := gamegrp.New(gameCore, heatEngine, nc, outboxEnabled)
	invGrp := inventorygrp.New(inventoryCore)

	// Public
	mux.Get("/v1/auth/nonce", mid.Errors(log, userGrp.Nonce))
	mux.Post("/v1/auth/wallet/login", mid.Errors(log, userGrp.WalletLogin))
	if devMode {
		mux.Post("/v1/auth/login", mid.Errors(log, userGrp.Login))
	}

	// JWT-protected
	progGrp := progressgrp.New(progressCore, userCore)
	mux.Group(func(r chi.Router) {
		r.Use(mid.Authenticate(a))
		r.Get("/v1/user/profile", mid.Errors(log, userGrp.Profile))
		r.Put("/v1/user/display-name", mid.Errors(log, userGrp.SetDisplayName))
		r.Put("/v1/user/referral-code", mid.Errors(log, userGrp.SetReferralCode))
		r.Get("/v1/user/referral", mid.Errors(log, userGrp.ReferralInfo))
		r.Get("/v1/inventory", mid.Errors(log, invGrp.GetInventory))
		r.Post("/v1/chest/open", mid.Errors(log, invGrp.OpenChest))

		// Progress routes (user).
		r.Get("/v1/progress", mid.Errors(log, progGrp.ListUserProgress))
		r.Post("/v1/progress/{id}/claim", mid.Errors(log, progGrp.ClaimProgress))

		// Deposit/withdrawal routes (only if wallet is configured).
		if depositCore != nil {
			depGrp := depositgrp.New(depositCore, userCore)
			r.Get("/v1/deposit/address", mid.Errors(log, depGrp.GetAddress))
			r.Get("/v1/deposits", mid.Errors(log, depGrp.ListDeposits))
			r.Get("/v1/withdraw/nonce", mid.Errors(log, depGrp.WithdrawNonce))
			r.Post("/v1/withdraw", mid.Errors(log, depGrp.RequestWithdrawal))
			r.Get("/v1/withdrawals", mid.Errors(log, depGrp.ListWithdrawals))
		}
	})

	// Admin routes — JWT + admin role required.
	mux.Group(func(r chi.Router) {
		r.Use(mid.Authenticate(a))
		r.Use(mid.RequireAdmin())
		r.Post("/v1/admin/progress", mid.Errors(log, progGrp.CreateProgress))
		r.Put("/v1/admin/progress/{id}", mid.Errors(log, progGrp.UpdateProgress))
		r.Get("/v1/admin/progress", mid.Errors(log, progGrp.ListAllProgress))
		r.Get("/v1/admin/progress/{id}/users", mid.Errors(log, progGrp.ListUserProgressByProgressID))
	})

	// Sponsor routes — mix of public and JWT-protected.
	sponsorGrp := sponsorgrp.New(sponsorCore, log)
	mux.Route("/v1/sponsor", func(r chi.Router) {
		// Public endpoints.
		r.Get("/campaigns", mid.Errors(log, sponsorGrp.List))
		r.Get("/campaign/{id}", mid.Errors(log, sponsorGrp.GetByID))

		// JWT-protected endpoints.
		r.Group(func(r chi.Router) {
			r.Use(mid.Authenticate(a))
			r.Post("/campaign", mid.Errors(log, sponsorGrp.Create))
			r.Post("/campaign/{id}/upload", mid.Errors(log, sponsorGrp.Upload))
			r.Get("/balances", mid.Errors(log, sponsorGrp.GetBalances))
			r.Get("/campaigns/mine", mid.Errors(log, sponsorGrp.ListMine))
		})
	})

	// Admin sponsor routes — JWT + admin role required.
	mux.Group(func(r chi.Router) {
		r.Use(mid.Authenticate(a))
		r.Use(mid.RequireAdmin())
		r.Put("/v1/admin/sponsor/campaign/{id}/pause", mid.Errors(log, sponsorGrp.Pause))
		r.Put("/v1/admin/sponsor/campaign/{id}/resume", mid.Errors(log, sponsorGrp.Resume))
		r.Delete("/v1/admin/sponsor/campaign/{id}", mid.Errors(log, sponsorGrp.Remove))
	})

	// Static file server for sponsor uploads with security headers.
	uploadsFS := http.StripPrefix("/uploads/sponsors/", http.FileServer(http.Dir("./uploads/sponsors")))
	mux.Get("/uploads/sponsors/*", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self'")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		uploadsFS.ServeHTTP(w, r)
	})

	// Game-secret-protected
	mux.Group(func(r chi.Router) {
		r.Use(mid.GameSecret(gameAPIKey))
		r.Post("/v1/game/event", mid.Errors(log, gameGrp.Event))
	})

	return mux
}
