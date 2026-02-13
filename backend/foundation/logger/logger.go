// Package logger provides a thin wrapper around zap.SugaredLogger.
package logger

import (
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

// New constructs a SugaredLogger for the given service name and log level.
func New(service string, level string) (*zap.SugaredLogger, error) {
	cfg := zap.NewProductionConfig()
	cfg.OutputPaths = []string{"stdout"}
	cfg.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

	var l zapcore.Level
	if err := l.Set(level); err != nil {
		l = zapcore.InfoLevel
	}
	cfg.Level = zap.NewAtomicLevelAt(l)

	log, err := cfg.Build(zap.AddCallerSkip(1))
	if err != nil {
		return nil, err
	}

	return log.Sugar().With("service", service), nil
}
