// Package debug provides health, readiness, and pprof endpoints.
package debug

import (
	"context"
	"net/http"
	"net/http/pprof"

	"github.com/go-chi/chi/v5"
	"github.com/jmoiron/sqlx"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// Routes adds debug routes to the provided router.
func Routes(mux *chi.Mux, db *sqlx.DB) {
	mux.Get("/debug/health", healthHandler())
	mux.Get("/debug/readiness", readinessHandler(db))

	// pprof
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
}

func healthHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v1.Respond(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func readinessHandler(db *sqlx.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := database.StatusCheck(context.Background(), db); err != nil {
			v1.Respond(w, http.StatusServiceUnavailable, map[string]string{
				"status": "not ready",
				"error":  err.Error(),
			})
			return
		}
		v1.Respond(w, http.StatusOK, map[string]string{"status": "ready"})
	}
}
