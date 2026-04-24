package ethrpc

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// rpcAttempts records one sample per provider call attempt.
//
// Labels:
//   - service:  "indexer" | "executor"
//   - provider: "public" | "alchemy" | "ankr" | "infura" | "quicknode" | "other"
//   - method:   the wrapped ethclient method name, e.g. "HeaderByNumber"
//   - result:   "ok" | "rate_limited" | "timeout" | "network" | "other"
//
// Cardinality is bounded: 2 services * ~6 providers * 9 methods * 5 results
// = ~540 series upper bound. Well within Prometheus comfort zone.
var rpcAttempts = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "coinpusher_rpc_attempts_total",
	Help: "RPC call attempts broken down by service, provider, method, and result.",
}, []string{"service", "provider", "method", "result"})

// rpcProvidersConfigured reports the number of RPC providers that successfully
// dialed at construction. Alert when this gauge falls below rpcProvidersIntended
// to catch "silent degraded startup" (an env var went missing and the service
// quietly runs on fewer providers than configured).
var rpcProvidersConfigured = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "coinpusher_rpc_providers_configured",
	Help: "Number of RPC providers that dialed successfully at startup.",
}, []string{"service"})

// rpcProvidersIntended reports the number of non-empty RPC URLs the caller
// supplied. Compare against configured to detect dial failures.
var rpcProvidersIntended = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "coinpusher_rpc_providers_intended",
	Help: "Number of RPC URLs supplied at startup (excluding blank entries).",
}, []string{"service"})

// providerName derives a short, log-safe provider identifier from an RPC
// URL. API keys (typically in the URL path) are never reflected — only the
// host is inspected.
func providerName(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "other"
	}
	host := strings.ToLower(u.Host)
	switch {
	case strings.Contains(host, "alchemy.com"):
		return "alchemy"
	case strings.Contains(host, "ankr.com"):
		return "ankr"
	case host == "mainnet.base.org", strings.HasSuffix(host, ".base.org"):
		return "public"
	case strings.Contains(host, "infura"):
		return "infura"
	case strings.Contains(host, "quicknode"):
		return "quicknode"
	default:
		return "other"
	}
}

// resultLabel maps an error to a low-cardinality metric label. String
// matching is used for rate-limit detection because go-ethereum surfaces
// JSON-RPC provider errors as plain text (the HTTP status and provider
// error codes appear in the message).
//
// Labels:
//   - "ok":           err == nil
//   - "timeout":      context deadline or net.Error.Timeout()
//   - "rate_limited": 429, 403 (Ankr quota), rate-limit text, capacity text,
//                     JSON-RPC -32005 "query exceeded limit"
//   - "network":      connection/transport errors (5xx, CF 52x, net.Error)
//   - "other":        everything else (app-level errors like reverts, nonce
//                     rejections — these don't indicate provider health)
func resultLabel(err error) string {
	if err == nil {
		return "ok"
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "timeout"
	}

	msg := strings.ToLower(err.Error())

	if strings.Contains(msg, "429") ||
		strings.Contains(msg, "403") ||
		strings.Contains(msg, "rate limit") ||
		strings.Contains(msg, "too many requests") ||
		strings.Contains(msg, "capacity limit") ||
		strings.Contains(msg, "quota") ||
		strings.Contains(msg, "-32005") ||
		strings.Contains(msg, "query exceeded") ||
		strings.Contains(msg, "query returned more than") {
		return "rate_limited"
	}

	// 5xx family and Cloudflare 52x (in front of public endpoints) —
	// treat as network-layer failures of the upstream provider, not an
	// application-level error we can reason about.
	if strings.Contains(msg, "502") ||
		strings.Contains(msg, "503") ||
		strings.Contains(msg, "504") ||
		strings.Contains(msg, "520") ||
		strings.Contains(msg, "521") ||
		strings.Contains(msg, "522") ||
		strings.Contains(msg, "524") ||
		strings.Contains(msg, "bad gateway") ||
		strings.Contains(msg, "gateway timeout") ||
		strings.Contains(msg, "service unavailable") ||
		strings.Contains(msg, "eof") {
		return "network"
	}

	var netErr net.Error
	if errors.As(err, &netErr) {
		if netErr.Timeout() {
			return "timeout"
		}
		return "network"
	}

	return "other"
}
