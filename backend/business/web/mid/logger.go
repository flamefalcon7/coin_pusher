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

// unmatchedPath is the Prometheus `path` label used for requests that matched no
// route. Using the raw URL here would let anyone on the internet mint an unbounded
// number of time series by spraying 404s — which is exactly what OOM-killed
// Prometheus on 2026-07-09. The raw path is still logged, just not made a label.
const unmatchedPath = "<unmatched>"

// metricPath returns the bounded `path` label for a request: the chi route pattern
// when one matched, otherwise a single constant shared by all unmatched requests.
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

			path := metricPath(r)
			status := strconv.Itoa(rw.statusCode)
			metrics.HTTPRequestsTotal.WithLabelValues(r.Method, path, status).Inc()
			metrics.HTTPRequestDuration.WithLabelValues(r.Method, path).Observe(time.Since(start).Seconds())
		})
	}
}
