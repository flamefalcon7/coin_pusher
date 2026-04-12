package nats

import (
	"fmt"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"go.uber.org/zap"
)

// ConnectWithJetStream creates a NATS connection and initialises a JetStream context.
func ConnectWithJetStream(cfg Config, log *zap.SugaredLogger) (*nats.Conn, jetstream.JetStream, error) {
	nc, err := Connect(cfg, log)
	if err != nil {
		return nil, nil, fmt.Errorf("nats connect: %w", err)
	}

	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, nil, fmt.Errorf("jetstream new: %w", err)
	}

	log.Infow("jetstream initialised")
	return nc, js, nil
}
