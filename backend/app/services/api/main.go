// Coin Pusher API server entry point.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ardanlabs/conf/v3"
	"github.com/go-chi/chi/v5"
	"github.com/jmoiron/sqlx"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/debug"
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/gamegrp"
	"github.com/flamefalcon/coin-pusher/backend/app/services/api/handlers/v1/usergrp"
	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
	ledgerdb "github.com/flamefalcon/coin-pusher/backend/business/core/accounting/stores/ledgerdb"
	"github.com/flamefalcon/coin-pusher/backend/business/core/game"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user/stores/userdb"
	"github.com/flamefalcon/coin-pusher/backend/business/web/auth"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
	"github.com/flamefalcon/coin-pusher/backend/foundation/keystore"
	"github.com/flamefalcon/coin-pusher/backend/foundation/logger"
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
	}
	DB struct {
		User         string `conf:"default:postgres"`
		Password     string `conf:"default:postgres,mask"`
		Host         string `conf:"default:localhost:5432"`
		Name         string `conf:"default:coinpusher"`
		MaxIdleConns int    `conf:"default:2"`
		MaxOpenConns int    `conf:"default:10"`
		DisableTLS   bool   `conf:"default:true"`
	}
	Auth struct {
		KeysFolder string `conf:"default:zarf/keys"`
		ActiveKID  string `conf:"default:default"`
		Issuer     string `conf:"default:coin-pusher"`
		DevMode    bool   `conf:"default:true"`
	}
	Game struct {
		APIKey string `conf:"default:dev-secret,mask"`
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
	acctCore := accounting.NewCore(ledgerdb.NewStore(db), userCore)
	gameCore := game.NewCore(userCore, acctCore)

	// -------------------------------------------------------------------------
	// Routes
	apiMux := buildAPIMux(log, db, a, cfg.Game.APIKey, userCore, acctCore, gameCore)

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
	// Shutdown
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-serverErrors:
		return fmt.Errorf("server error: %w", err)
	case sig := <-shutdown:
		log.Infow("shutdown started", "signal", sig)

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

func buildAPIMux(
	log *zap.SugaredLogger,
	db *sqlx.DB,
	a *auth.Auth,
	gameAPIKey string,
	userCore *user.Core,
	acctCore *accounting.Core,
	gameCore *game.Core,
) *chi.Mux {
	mux := chi.NewRouter()

	// Global middleware.
	mux.Use(mid.CorrelationID())
	mux.Use(mid.Panics(log))
	mux.Use(mid.Logger(log))

	// Debug routes (also on the API mux for convenience).
	debug.Routes(mux, db)

	// V1 routes.
	userGrp := usergrp.New(userCore, a)
	gameGrp := gamegrp.New(gameCore)

	// Public
	mux.Post("/v1/auth/login", mid.Errors(log, userGrp.Login))

	// JWT-protected
	mux.Group(func(r chi.Router) {
		r.Use(mid.Authenticate(a))
		r.Get("/v1/user/profile", mid.Errors(log, userGrp.Profile))
	})

	// Game-secret-protected
	mux.Group(func(r chi.Router) {
		r.Use(mid.GameSecret(gameAPIKey))
		r.Post("/v1/game/event", mid.Errors(log, gameGrp.Event))
	})

	return mux
}
