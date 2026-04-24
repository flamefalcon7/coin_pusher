// Package ethrpc provides a multi-provider Ethereum RPC client with
// sequential failover. It wraps go-ethereum's *ethclient.Client so callers
// treat an ordered list of providers as a single client; when the primary
// fails, calls automatically retry against the next provider.
//
// The wrapper is intentionally narrow: it only exposes the subset of
// ethclient methods used by the indexer and executor services. Adding a new
// method requires touching this package in exactly one place (the wrapper
// function) — the inner generic call helper handles fallback, metrics, and
// logging uniformly.
package ethrpc

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"go.uber.org/zap"
)

// ethClient is the subset of *ethclient.Client methods this package wraps.
// Declared as an interface so tests can substitute a fake implementation.
type ethClient interface {
	HeaderByNumber(ctx context.Context, number *big.Int) (*types.Header, error)
	FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error)
	PendingNonceAt(ctx context.Context, account common.Address) (uint64, error)
	SuggestGasTipCap(ctx context.Context) (*big.Int, error)
	EstimateGas(ctx context.Context, msg ethereum.CallMsg) (uint64, error)
	SendTransaction(ctx context.Context, tx *types.Transaction) error
	CallContract(ctx context.Context, msg ethereum.CallMsg, blockNumber *big.Int) ([]byte, error)
	BalanceAt(ctx context.Context, account common.Address, blockNumber *big.Int) (*big.Int, error)
	TransactionReceipt(ctx context.Context, txHash common.Hash) (*types.Receipt, error)
	Close()
}

type provider struct {
	name   string // "alchemy", "public", "ankr", "other"
	client ethClient
}

// Client is a fallback-aware ethereum RPC client. Callers use it exactly
// like *ethclient.Client. Calls are attempted against providers in the
// order supplied to New; the first non-error response is returned.
type Client struct {
	service   string // metric label: "indexer" or "executor"
	timeout   time.Duration
	providers []provider
	log       *zap.SugaredLogger
}

// perDialTimeout caps how long each individual provider dial is allowed
// to take. Applied per URL so a slow/hung provider does not starve the
// others. (Aggregate dial time is bounded by the caller's context.)
const perDialTimeout = 5 * time.Second

// New constructs a Client that will try each URL in order on every call.
// Each URL is dialed at construction; if a URL fails to dial it is skipped
// (with a warning log) and the remaining providers are used. If zero
// providers dial successfully, New returns an error. timeout is the
// per-call deadline applied to each individual provider attempt (set to 0
// to disable per-call timeout and inherit only from the caller's context).
//
// New also records a Prometheus gauge `coinpusher_rpc_providers_configured`
// with the count of providers that dialed successfully. Alerting on this
// gauge falling below expected detects the "silent degraded startup" case
// where an env var goes missing and the service quietly runs on fewer
// providers than intended.
func New(ctx context.Context, log *zap.SugaredLogger, service string, urls []string, timeout time.Duration) (*Client, error) {
	if service == "" {
		return nil, fmt.Errorf("service label is required")
	}
	if len(urls) == 0 {
		return nil, fmt.Errorf("at least one RPC URL is required")
	}

	// Count the non-blank URLs the caller intended to configure, so we
	// can report "configured vs. dialed" discrepancies via metrics.
	intended := 0
	for _, u := range urls {
		if strings.TrimSpace(u) != "" {
			intended++
		}
	}

	var providers []provider
	for _, u := range urls {
		u = strings.TrimSpace(u)
		if u == "" {
			continue
		}
		name := providerName(u)

		// Per-URL timeout so a slow Alchemy DNS resolution does not
		// starve Ankr/public dials.
		dialCtx, cancel := context.WithTimeout(ctx, perDialTimeout)
		c, err := ethclient.DialContext(dialCtx, u)
		cancel()
		if err != nil {
			log.Warnw("rpc provider dial failed; skipping",
				"service", service,
				"provider", name,
				"error", err,
			)
			continue
		}
		providers = append(providers, provider{name: name, client: c})
		log.Infow("rpc provider connected",
			"service", service,
			"provider", name,
			"position", len(providers),
		)
	}

	// Record configured count even on failure so the alert can reference
	// it (e.g., "intended 3, configured 1" → alert).
	rpcProvidersConfigured.WithLabelValues(service).Set(float64(len(providers)))
	rpcProvidersIntended.WithLabelValues(service).Set(float64(intended))

	if len(providers) == 0 {
		return nil, fmt.Errorf("no RPC providers could be dialed from %d URL(s)", len(urls))
	}

	return &Client{
		service:   service,
		timeout:   timeout,
		providers: providers,
		log:       log,
	}, nil
}

// Close closes all underlying clients. Safe to call multiple times.
func (c *Client) Close() {
	for _, p := range c.providers {
		p.client.Close()
	}
}

// ProviderNames returns the ordered provider names this client will use,
// e.g. []string{"public", "alchemy", "ankr"}. Useful for startup logging.
func (c *Client) ProviderNames() []string {
	names := make([]string, len(c.providers))
	for i, p := range c.providers {
		names[i] = p.name
	}
	return names
}

// call is the generic fallback helper. Every wrapped method funnels
// through here. It loops providers in order, applies the per-call timeout,
// records the attempt in the Prometheus counter, and returns the first
// successful result. On all-fail it returns the LAST provider's error
// wrapped so callers can errors.Is(..., context.DeadlineExceeded) etc.
//
// If the caller's outer context is cancelled mid-loop the function returns
// immediately with that context's error (does not consume further
// providers or record additional metrics for an abandoned call).
func call[T any](c *Client, ctx context.Context, method string, op func(ctx context.Context, client ethClient) (T, error)) (T, error) {
	var zero T
	var lastErr error

	for i, p := range c.providers {
		// Short-circuit if caller already cancelled.
		if err := ctx.Err(); err != nil {
			return zero, err
		}

		callCtx := ctx
		var cancel context.CancelFunc
		if c.timeout > 0 {
			callCtx, cancel = context.WithTimeout(ctx, c.timeout)
		}
		result, err := op(callCtx, p.client)
		if cancel != nil {
			cancel()
		}

		label := resultLabel(err)
		rpcAttempts.WithLabelValues(c.service, p.name, method, label).Inc()

		if err == nil {
			if i > 0 {
				// Successful fallback — operators want to see this.
				c.log.Infow("rpc call served by fallback provider",
					"service", c.service,
					"method", method,
					"provider", p.name,
					"fallback_position", i+1,
					"primary_providers_tried", i,
				)
			}
			return result, nil
		}

		lastErr = err
		c.log.Warnw("rpc call failed; trying next provider",
			"service", c.service,
			"method", method,
			"provider", p.name,
			"provider_position", i+1,
			"result", label,
			"error", err,
		)
	}

	return zero, fmt.Errorf("all %d RPC providers failed for %s: %w", len(c.providers), method, lastErr)
}

// ---------------------------------------------------------------------------
// Wrapped methods. Add new wrappers here only. Implementation is uniform:
// delegate to call() with the method name as metric label.
// ---------------------------------------------------------------------------

// HeaderByNumber fetches the header for a given block (nil = latest).
func (c *Client) HeaderByNumber(ctx context.Context, number *big.Int) (*types.Header, error) {
	return call(c, ctx, "HeaderByNumber", func(ctx context.Context, client ethClient) (*types.Header, error) {
		return client.HeaderByNumber(ctx, number)
	})
}

// FilterLogs returns matching event logs for the given filter query.
func (c *Client) FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error) {
	return call(c, ctx, "FilterLogs", func(ctx context.Context, client ethClient) ([]types.Log, error) {
		return client.FilterLogs(ctx, q)
	})
}

// PendingNonceAt returns the pending nonce for an account.
func (c *Client) PendingNonceAt(ctx context.Context, account common.Address) (uint64, error) {
	return call(c, ctx, "PendingNonceAt", func(ctx context.Context, client ethClient) (uint64, error) {
		return client.PendingNonceAt(ctx, account)
	})
}

// SuggestGasTipCap returns the suggested max priority fee per gas.
func (c *Client) SuggestGasTipCap(ctx context.Context) (*big.Int, error) {
	return call(c, ctx, "SuggestGasTipCap", func(ctx context.Context, client ethClient) (*big.Int, error) {
		return client.SuggestGasTipCap(ctx)
	})
}

// EstimateGas returns an estimate of the gas needed to execute the call.
func (c *Client) EstimateGas(ctx context.Context, msg ethereum.CallMsg) (uint64, error) {
	return call(c, ctx, "EstimateGas", func(ctx context.Context, client ethClient) (uint64, error) {
		return client.EstimateGas(ctx, msg)
	})
}

// SendTransaction broadcasts a signed transaction.
//
// Idempotency under fallback: if the primary provider errors (timeout,
// network blip, etc.) we retry on the next provider. If that next
// provider reports the tx is already known ("nonce too low", "already
// known", "transaction known"), the primary DID actually propagate the
// tx into the mempool — we treat this as success, not error, so callers
// don't mark confirmed withdrawals as failed and recovery doesn't churn.
func (c *Client) SendTransaction(ctx context.Context, tx *types.Transaction) error {
	_, err := call(c, ctx, "SendTransaction", func(ctx context.Context, client ethClient) (struct{}, error) {
		return struct{}{}, client.SendTransaction(ctx, tx)
	})
	if err != nil && isTxAlreadyKnown(err) {
		c.log.Infow("SendTransaction: tx already in network (idempotent success via fallback)",
			"service", c.service,
		)
		return nil
	}
	return err
}

// isTxAlreadyKnown detects the non-error responses that Ethereum nodes
// return when a signed transaction has already been observed in the
// mempool or chain. Seeing these after a failover attempt means the
// primary provider successfully propagated the tx, even if its HTTP
// response did not reach us.
func isTxAlreadyKnown(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "nonce too low") ||
		strings.Contains(msg, "already known") ||
		strings.Contains(msg, "transaction known") ||
		strings.Contains(msg, "already exists")
}

// CallContract executes a message call against a specific block (nil = latest).
func (c *Client) CallContract(ctx context.Context, msg ethereum.CallMsg, blockNumber *big.Int) ([]byte, error) {
	return call(c, ctx, "CallContract", func(ctx context.Context, client ethClient) ([]byte, error) {
		return client.CallContract(ctx, msg, blockNumber)
	})
}

// BalanceAt returns the wei balance of an account at a given block (nil = latest).
func (c *Client) BalanceAt(ctx context.Context, account common.Address, blockNumber *big.Int) (*big.Int, error) {
	return call(c, ctx, "BalanceAt", func(ctx context.Context, client ethClient) (*big.Int, error) {
		return client.BalanceAt(ctx, account, blockNumber)
	})
}

// TransactionReceipt returns the receipt for a mined transaction.
//
// NotFound short-circuit: an unmined tx returns ethereum.NotFound, which
// is an EXPECTED result during receipt polling — not a sign the provider
// is sick. Without a short-circuit, waitForReceipt loops would fan out
// to every provider on every poll, amplifying RPC cost under RPC
// degradation (the exact scenario this package is supposed to help). So
// NotFound from the first provider is returned immediately; callers
// retry on the next tick.
func (c *Client) TransactionReceipt(ctx context.Context, txHash common.Hash) (*types.Receipt, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(c.providers) == 0 {
		return nil, fmt.Errorf("no RPC providers configured")
	}

	// Try primary directly so NotFound can return without fallback churn.
	primary := c.providers[0]
	callCtx, cancel := context.WithTimeout(ctx, c.effectiveTimeout())
	receipt, err := primary.client.TransactionReceipt(callCtx, txHash)
	cancel()
	rpcAttempts.WithLabelValues(c.service, primary.name, "TransactionReceipt", resultLabel(err)).Inc()

	// NotFound is not a provider error — caller loops and retries.
	if errors.Is(err, ethereum.NotFound) {
		return nil, err
	}
	if err == nil {
		return receipt, nil
	}

	// Real error from primary — fall through to remaining providers.
	c.log.Warnw("rpc call failed; trying next provider",
		"service", c.service,
		"method", "TransactionReceipt",
		"provider", primary.name,
		"provider_position", 1,
		"result", resultLabel(err),
		"error", err,
	)
	lastErr := err
	for i := 1; i < len(c.providers); i++ {
		if cerr := ctx.Err(); cerr != nil {
			return nil, cerr
		}
		p := c.providers[i]
		callCtx, cancel := context.WithTimeout(ctx, c.effectiveTimeout())
		receipt, err := p.client.TransactionReceipt(callCtx, txHash)
		cancel()
		label := resultLabel(err)
		rpcAttempts.WithLabelValues(c.service, p.name, "TransactionReceipt", label).Inc()
		if err == nil {
			c.log.Infow("rpc call served by fallback provider",
				"service", c.service,
				"method", "TransactionReceipt",
				"provider", p.name,
				"fallback_position", i+1,
			)
			return receipt, nil
		}
		if errors.Is(err, ethereum.NotFound) {
			return nil, err
		}
		lastErr = err
		c.log.Warnw("rpc call failed; trying next provider",
			"service", c.service,
			"method", "TransactionReceipt",
			"provider", p.name,
			"provider_position", i+1,
			"result", label,
			"error", err,
		)
	}
	return nil, fmt.Errorf("all %d RPC providers failed for TransactionReceipt: %w", len(c.providers), lastErr)
}

// effectiveTimeout returns the per-call timeout, or a generous default
// when the Client was constructed with timeout=0.
func (c *Client) effectiveTimeout() time.Duration {
	if c.timeout > 0 {
		return c.timeout
	}
	return 30 * time.Second
}
