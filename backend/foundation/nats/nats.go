// Package nats provides NATS connection management.
package nats

import (
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"go.uber.org/zap"

	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
)

// Config holds the settings for connecting to NATS.
type Config struct {
	URL           string
	ReconnectWait time.Duration
	MaxReconnects int
}

// Connect creates a new NATS connection with reconnection handling.
func Connect(cfg Config, log *zap.SugaredLogger) (*nats.Conn, error) {
	nc, err := nats.Connect(cfg.URL,
		nats.ReconnectWait(cfg.ReconnectWait),
		nats.MaxReconnects(cfg.MaxReconnects),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			log.Warnw("nats disconnected", "error", err)
			metrics.NATSDisconnects.Inc()
		}),
		nats.ReconnectHandler(func(nc *nats.Conn) {
			log.Infow("nats reconnected", "url", nc.ConnectedUrl())
			metrics.NATSReconnects.Inc()
		}),
		nats.ClosedHandler(func(_ *nats.Conn) {
			log.Infow("nats connection closed")
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("nats connect: %w", err)
	}

	log.Infow("nats connected", "url", nc.ConnectedUrl())
	return nc, nil
}
