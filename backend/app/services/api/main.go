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
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/gamegrp"
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/inventorygrp"
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/usergrp"
	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	ledgerdb "github.com/flamefalcon/coin-pusher/backend/business/core/accounting/stores/ledgerdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
	"github.com/flamefalcon/coin-pusher/backend/business/core/inventory"
	inventorydb "github.com/flamefalcon/coin-pusher/backend/business/core/inventory/stores/inventorydb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user/stores/userdb"
	"github.com/flamefalcon/coin-pusher/backend/business/web/auth"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	"github.com/flamefalcon/coin-pusher/backend/business/web/ws"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
	"github.com/flamefalcon/coin-pusher/backend/foundation/keystore"
	"github.com/flamefalcon/coin-pusher/backend/foundation/logger"
	foundnats "github.com/flamefalcon/coin-pusher/backend/foundation/nats"
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
	NATS struct {
		URL           string        `conf:"default:nats://localhost:4222"`
		ReconnectWait time.Duration `conf:"default:2s"`
		MaxReconnects int           `conf:"default:60"`
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

	if cfg.Web.CORSOrigins == "*" && !cfg.Auth.DevMode {
		return fmt.Errorf("BACKEND_WEB_CORS_ORIGINS must be set in production (not wildcard)")
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
	)
	if cfg.Auth.DevMode {
		inventoryCore.SetDevDefaults(inventory.DevDefaults{
			KeyCoins:        100,
			ScrollShock:     100,
			ScrollTornado:   100,
			ScrollExplosion: 100,
			ScrollLightning: 100,
			ScrollSuperPush: 100,
		})
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
	// WebSocket Hub, Relay, Handler
	hub := ws.NewHub()
	relay := ws.NewRelay(log, nc, hub, "main")
	if err := relay.Start(); err != nil {
		return fmt.Errorf("starting nats relay: %w", err)
	}

	wsHandler := ws.NewHandler(log, hub, nc, a, gameCore, heatEngine, inventoryCore)

	// Subscribe to slot_status from game server for cap enforcement.
	if err := wsHandler.SubscribeSlotStatus(); err != nil {
		return fmt.Errorf("subscribing to slot_status: %w", err)
	}

	// -------------------------------------------------------------------------
	// Routes
	apiMux := buildAPIMux(log, db, a, cfg.Game.APIKey, cfg.Web.CORSOrigins, userCore, acctCore, gameCore, heatEngine, inventoryCore, nc, wsHandler)

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
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				shares := heatEngine.GetShares()
				if len(shares) == 0 {
					continue
				}
				type playerHeat struct {
					UserID  string  `msgpack:"user_id"`
					Share   float64 `msgpack:"share"`
					RawHeat float64 `msgpack:"raw_heat"`
				}
				type heatMsg struct {
					Op      string       `msgpack:"op"`
					Players []playerHeat `msgpack:"players"`
				}
				msg := heatMsg{Op: "heat_update"}
				for _, s := range shares {
					msg.Players = append(msg.Players, playerHeat{
						UserID:  s.UserID.String(),
						Share:   s.Share,
						RawHeat: s.RawHeat,
					})
				}
				data, err := msgpack.Marshal(msg)
				if err != nil {
					log.Errorw("heat broadcast marshal error", "error", err)
					continue
				}
				nc.Publish(ws.TopicHeatUpdate("main"), data)

				// Prune stale heat entries.
				heatEngine.Prune()
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
				n, err := userCore.PurgeExpiredNonces(context.Background())
				if err != nil {
					log.Errorw("nonce purge error", "error", err)
				} else if n > 0 {
					log.Infow("purged expired nonces", "count", n)
				}
			case <-stopNoncePurge:
				return
			}
		}
	}()

	// -------------------------------------------------------------------------
	// Reward accumulator + flush goroutine (10s interval)
	var rewardMu sync.Mutex
	rewardAccum := make(map[uuid.UUID]float64)

	// Subscribe to coin_despawn events from game server.
	despawnSub, err := nc.Subscribe(ws.TopicCoinDespawn("main"), func(msg *nats.Msg) {
		var evt struct {
			Zone      string `json:"zone"`
			CoinCount int    `json:"coin_count"`
		}
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			log.Errorw("coin_despawn unmarshal error", "error", err)
			return
		}

		if evt.Zone != "front" {
			return // side/back drops are house profit
		}

		dist := heatEngine.DistributeFrontEdgeDrop(evt.CoinCount)
		if dist == nil {
			return
		}

		rewardMu.Lock()
		for uid, amount := range dist {
			rewardAccum[uid] += amount
		}
		rewardMu.Unlock()
	})
	if err != nil {
		return fmt.Errorf("subscribing to coin_despawn: %w", err)
	}
	defer despawnSub.Unsubscribe()

	stopFlush := make(chan struct{})
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
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
					}
				}
			case <-stopFlush:
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

		// Look up winner display name.
		winnerName := ""
		acct, err := userCore.QueryByID(context.Background(), winnerID)
		if err == nil {
			winnerName = acct.DisplayName
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
		close(stopNoncePurge)

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
	userCore *user.Core,
	acctCore *accounting.Core,
	gameCore *game.Core,
	heatEngine *heat.HeatEngine,
	inventoryCore *inventory.Core,
	nc *nats.Conn,
	wsHandler *ws.Handler,
) *chi.Mux {
	mux := chi.NewRouter()

	// Global middleware.
	origins := []string{"https://*", "http://*"}
	if corsOrigins != "*" {
		origins = strings.Split(corsOrigins, ",")
		for i := range origins {
			origins[i] = strings.TrimSpace(origins[i])
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

	// Debug routes (also on the API mux for convenience).
	debug.Routes(mux, db)

	// WebSocket route (no auth middleware -- auth happens during WS upgrade).
	mux.Get("/ws", wsHandler.ServeHTTP)

	// V1 routes.
	userGrp := usergrp.New(userCore, a)
	gameGrp := gamegrp.New(gameCore, heatEngine, nc)
	invGrp := inventorygrp.New(inventoryCore)

	// Public
	mux.Get("/v1/auth/nonce", mid.Errors(log, userGrp.Nonce))
	mux.Post("/v1/auth/wallet/login", mid.Errors(log, userGrp.WalletLogin))
	mux.Post("/v1/auth/login", mid.Errors(log, userGrp.Login)) // dev mode only

	// JWT-protected
	mux.Group(func(r chi.Router) {
		r.Use(mid.Authenticate(a))
		r.Get("/v1/user/profile", mid.Errors(log, userGrp.Profile))
		r.Post("/v1/game/batch-insert", mid.Errors(log, gameGrp.BatchInsert))
		r.Get("/v1/inventory", mid.Errors(log, invGrp.GetInventory))
		r.Post("/v1/chest/open", mid.Errors(log, invGrp.OpenChest))
	})

	// Game-secret-protected
	mux.Group(func(r chi.Router) {
		r.Use(mid.GameSecret(gameAPIKey))
		r.Post("/v1/game/event", mid.Errors(log, gameGrp.Event))
	})

	return mux
}
