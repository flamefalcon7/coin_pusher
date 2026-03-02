package mid

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
)

// responseWriter wraps http.ResponseWriter to capture the status code.
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// Hijack implements http.Hijacker so WebSocket upgrades work through this middleware.
func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := rw.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("wrapped ResponseWriter does not support Hijack")
	}
	return hijacker.Hijack()
}

// Logger returns middleware that logs every request with method, path,
// status code, duration, and correlation ID.
func Logger(log *zap.SugaredLogger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
			next.ServeHTTP(rw, r)

			log.Infow("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rw.statusCode,
				"duration", time.Since(start).String(),
				"correlation_id", GetCorrelationID(r.Context()),
			)

			path := r.URL.Path
			if rctx := chi.RouteContext(r.Context()); rctx != nil {
				if pattern := rctx.RoutePattern(); pattern != "" {
					path = pattern
				}
			}
			status := strconv.Itoa(rw.statusCode)
			metrics.HTTPRequestsTotal.WithLabelValues(r.Method, path, status).Inc()
			metrics.HTTPRequestDuration.WithLabelValues(r.Method, path).Observe(time.Since(start).Seconds())
		})
	}
}
