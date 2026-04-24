package ethrpc

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"sync/atomic"
	"testing"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"go.uber.org/zap"
)

// fakeClient is a configurable ethClient for testing. Each method has a
// ResponseFunc field that controls its behavior per-call.
type fakeClient struct {
	name string

	// Counters to assert how many times each method was invoked.
	headerByNumberCalls atomic.Int32
	filterLogsCalls     atomic.Int32
	sendTxCalls         atomic.Int32
	receiptCalls        atomic.Int32
	closeCalls          atomic.Int32

	// Per-method response functions. If nil, the method returns zero + nil.
	headerByNumberFn func(ctx context.Context, n *big.Int) (*types.Header, error)
	filterLogsFn     func(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error)
	pendingNonceFn   func(ctx context.Context, a common.Address) (uint64, error)
	sendTxFn         func(ctx context.Context, tx *types.Transaction) error
	receiptFn        func(ctx context.Context, hash common.Hash) (*types.Receipt, error)
}

func (f *fakeClient) HeaderByNumber(ctx context.Context, number *big.Int) (*types.Header, error) {
	f.headerByNumberCalls.Add(1)
	if f.headerByNumberFn != nil {
		return f.headerByNumberFn(ctx, number)
	}
	return &types.Header{Number: big.NewInt(1)}, nil
}

func (f *fakeClient) FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error) {
	f.filterLogsCalls.Add(1)
	if f.filterLogsFn != nil {
		return f.filterLogsFn(ctx, q)
	}
	return nil, nil
}

func (f *fakeClient) PendingNonceAt(ctx context.Context, a common.Address) (uint64, error) {
	if f.pendingNonceFn != nil {
		return f.pendingNonceFn(ctx, a)
	}
	return 0, nil
}

func (f *fakeClient) SuggestGasTipCap(ctx context.Context) (*big.Int, error) {
	return big.NewInt(1), nil
}

func (f *fakeClient) EstimateGas(ctx context.Context, msg ethereum.CallMsg) (uint64, error) {
	return 21000, nil
}

func (f *fakeClient) SendTransaction(ctx context.Context, tx *types.Transaction) error {
	f.sendTxCalls.Add(1)
	if f.sendTxFn != nil {
		return f.sendTxFn(ctx, tx)
	}
	return nil
}

func (f *fakeClient) CallContract(ctx context.Context, msg ethereum.CallMsg, blockNumber *big.Int) ([]byte, error) {
	return nil, nil
}

func (f *fakeClient) BalanceAt(ctx context.Context, account common.Address, blockNumber *big.Int) (*big.Int, error) {
	return big.NewInt(0), nil
}

func (f *fakeClient) TransactionReceipt(ctx context.Context, txHash common.Hash) (*types.Receipt, error) {
	f.receiptCalls.Add(1)
	if f.receiptFn != nil {
		return f.receiptFn(ctx, txHash)
	}
	return nil, nil
}

func (f *fakeClient) Close() {
	f.closeCalls.Add(1)
}

// newTestClient assembles a Client with the given fake providers. Bypasses
// the dial path used by New() so unit tests don't need network.
func newTestClient(t *testing.T, timeout time.Duration, fakes ...*fakeClient) *Client {
	t.Helper()
	log := zap.NewNop().Sugar()
	provs := make([]provider, 0, len(fakes))
	for _, f := range fakes {
		provs = append(provs, provider{name: f.name, client: f})
	}
	return &Client{
		service:   "testsvc",
		timeout:   timeout,
		providers: provs,
		log:       log,
	}
}

// --- Happy path -------------------------------------------------------------

func TestClient_PrimarySucceeds_NoFallback(t *testing.T) {
	t.Parallel()

	primary := &fakeClient{name: "alchemy"}
	secondary := &fakeClient{name: "ankr"}
	c := newTestClient(t, time.Second, primary, secondary)

	h, err := c.HeaderByNumber(context.Background(), nil)
	if err != nil {
		t.Fatalf("expected success, got: %v", err)
	}
	if h == nil || h.Number.Sign() == 0 {
		t.Fatalf("expected non-nil header with number, got %v", h)
	}
	if got := primary.headerByNumberCalls.Load(); got != 1 {
		t.Errorf("primary call count: got %d, want 1", got)
	}
	if got := secondary.headerByNumberCalls.Load(); got != 0 {
		t.Errorf("secondary call count: got %d, want 0 (no fallback)", got)
	}
}

// --- Fallback on 429 --------------------------------------------------------

func TestClient_Fallback_On_429(t *testing.T) {
	t.Parallel()

	primary := &fakeClient{
		name: "alchemy",
		headerByNumberFn: func(_ context.Context, _ *big.Int) (*types.Header, error) {
			return nil, errors.New("429 Too Many Requests: Monthly capacity limit exceeded")
		},
	}
	expectedHeader := &types.Header{Number: big.NewInt(42)}
	secondary := &fakeClient{
		name: "ankr",
		headerByNumberFn: func(_ context.Context, _ *big.Int) (*types.Header, error) {
			return expectedHeader, nil
		},
	}
	c := newTestClient(t, time.Second, primary, secondary)

	h, err := c.HeaderByNumber(context.Background(), nil)
	if err != nil {
		t.Fatalf("expected success via fallback, got: %v", err)
	}
	if h != expectedHeader {
		t.Fatalf("expected header from secondary, got: %v", h)
	}
	if got := primary.headerByNumberCalls.Load(); got != 1 {
		t.Errorf("primary call count: got %d, want 1", got)
	}
	if got := secondary.headerByNumberCalls.Load(); got != 1 {
		t.Errorf("secondary call count: got %d, want 1", got)
	}
}

// --- Fallback on timeout ----------------------------------------------------

func TestClient_Fallback_On_Timeout(t *testing.T) {
	t.Parallel()

	primary := &fakeClient{
		name: "alchemy",
		headerByNumberFn: func(ctx context.Context, _ *big.Int) (*types.Header, error) {
			// Block past the per-call timeout.
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	secondary := &fakeClient{name: "ankr"}
	c := newTestClient(t, 50*time.Millisecond, primary, secondary)

	start := time.Now()
	_, err := c.HeaderByNumber(context.Background(), nil)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("expected success via fallback, got: %v", err)
	}
	// Should have timed out on primary (~50ms) then succeeded on secondary (~0ms).
	// Upper bound is generous for CI jitter.
	if elapsed > 500*time.Millisecond {
		t.Errorf("fallback took too long: %v", elapsed)
	}
	if got := secondary.headerByNumberCalls.Load(); got != 1 {
		t.Errorf("secondary call count: got %d, want 1", got)
	}
}

// --- All providers fail -----------------------------------------------------

func TestClient_AllProvidersFail(t *testing.T) {
	t.Parallel()

	fail := func(name string) *fakeClient {
		return &fakeClient{
			name: name,
			headerByNumberFn: func(_ context.Context, _ *big.Int) (*types.Header, error) {
				return nil, errors.New("429 Too Many Requests")
			},
		}
	}
	p1 := fail("public")
	p2 := fail("alchemy")
	p3 := fail("ankr")
	c := newTestClient(t, time.Second, p1, p2, p3)

	_, err := c.HeaderByNumber(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error when all providers fail")
	}
	if !contains(err.Error(), "all 3 RPC providers failed for HeaderByNumber") {
		t.Errorf("error message should describe all-fail; got: %v", err)
	}
	if p1.headerByNumberCalls.Load() != 1 || p2.headerByNumberCalls.Load() != 1 || p3.headerByNumberCalls.Load() != 1 {
		t.Errorf("each provider should be attempted once; got: %d, %d, %d",
			p1.headerByNumberCalls.Load(), p2.headerByNumberCalls.Load(), p3.headerByNumberCalls.Load())
	}
}

// --- Error wrapping preserves errors.Is -------------------------------------

func TestClient_AllFail_Preserves_DeadlineExceeded(t *testing.T) {
	t.Parallel()

	slow := func(name string) *fakeClient {
		return &fakeClient{
			name: name,
			headerByNumberFn: func(ctx context.Context, _ *big.Int) (*types.Header, error) {
				<-ctx.Done()
				return nil, ctx.Err()
			},
		}
	}
	c := newTestClient(t, 10*time.Millisecond, slow("alchemy"), slow("ankr"))

	_, err := c.HeaderByNumber(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("errors.Is should find DeadlineExceeded in wrapped error; got: %v", err)
	}
}

// --- Caller context cancellation stops iteration ----------------------------

func TestClient_CallerCancellation_StopsFallback(t *testing.T) {
	t.Parallel()

	primary := &fakeClient{
		name: "alchemy",
		headerByNumberFn: func(_ context.Context, _ *big.Int) (*types.Header, error) {
			return nil, errors.New("network error")
		},
	}
	secondaryCalled := atomic.Bool{}
	secondary := &fakeClient{
		name: "ankr",
		headerByNumberFn: func(_ context.Context, _ *big.Int) (*types.Header, error) {
			secondaryCalled.Store(true)
			return &types.Header{Number: big.NewInt(1)}, nil
		},
	}
	c := newTestClient(t, time.Second, primary, secondary)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before call

	_, err := c.HeaderByNumber(ctx, nil)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got: %v", err)
	}
	if secondaryCalled.Load() {
		t.Error("secondary should not be called after caller cancels")
	}
}

// --- SendTransaction-specific: fallthrough on non-429 transient errors ------

func TestClient_SendTransaction_FallthroughOnNetworkError(t *testing.T) {
	t.Parallel()

	primary := &fakeClient{
		name: "alchemy",
		sendTxFn: func(_ context.Context, _ *types.Transaction) error {
			return errors.New("dial tcp: connection refused")
		},
	}
	secondary := &fakeClient{
		name: "ankr",
		sendTxFn: func(_ context.Context, _ *types.Transaction) error {
			return nil
		},
	}
	c := newTestClient(t, time.Second, primary, secondary)

	tx := types.NewTx(&types.DynamicFeeTx{Nonce: 1})
	if err := c.SendTransaction(context.Background(), tx); err != nil {
		t.Fatalf("expected success via fallback, got: %v", err)
	}
	if primary.sendTxCalls.Load() != 1 || secondary.sendTxCalls.Load() != 1 {
		t.Errorf("expected primary=1 secondary=1 calls, got primary=%d secondary=%d",
			primary.sendTxCalls.Load(), secondary.sendTxCalls.Load())
	}
}

// --- SendTransaction: "already known" from fallback = success ---------------

func TestClient_SendTransaction_NonceTooLowFromFallbackIsSuccess(t *testing.T) {
	t.Parallel()

	// Simulates: primary broadcasts successfully but its response is lost
	// (timeout). Fallback sees the tx already in the mempool and returns
	// "nonce too low". This should be treated as success, not error.
	primary := &fakeClient{
		name: "alchemy",
		sendTxFn: func(_ context.Context, _ *types.Transaction) error {
			return errors.New("i/o timeout")
		},
	}
	secondary := &fakeClient{
		name: "ankr",
		sendTxFn: func(_ context.Context, _ *types.Transaction) error {
			return errors.New("nonce too low")
		},
	}
	c := newTestClient(t, time.Second, primary, secondary)

	tx := types.NewTx(&types.DynamicFeeTx{Nonce: 1})
	if err := c.SendTransaction(context.Background(), tx); err != nil {
		t.Fatalf("expected nil (already-known treated as success), got: %v", err)
	}
}

func TestClient_SendTransaction_AlreadyKnownVariants(t *testing.T) {
	t.Parallel()

	for _, variant := range []string{
		"nonce too low",
		"already known",
		"Transaction Known",
		"tx already exists",
	} {
		variant := variant
		t.Run(variant, func(t *testing.T) {
			t.Parallel()
			primary := &fakeClient{
				name: "alchemy",
				sendTxFn: func(_ context.Context, _ *types.Transaction) error {
					return errors.New("bad gateway")
				},
			}
			secondary := &fakeClient{
				name: "ankr",
				sendTxFn: func(_ context.Context, _ *types.Transaction) error {
					return errors.New(variant)
				},
			}
			c := newTestClient(t, time.Second, primary, secondary)
			if err := c.SendTransaction(context.Background(), types.NewTx(&types.DynamicFeeTx{Nonce: 1})); err != nil {
				t.Errorf("variant %q should be success, got: %v", variant, err)
			}
		})
	}
}

// --- TransactionReceipt: NotFound short-circuits fallback -------------------

func TestClient_TransactionReceipt_NotFoundSkipsFallback(t *testing.T) {
	t.Parallel()

	primary := &fakeClient{
		name: "alchemy",
		receiptFn: func(_ context.Context, _ common.Hash) (*types.Receipt, error) {
			return nil, ethereum.NotFound
		},
	}
	secondary := &fakeClient{
		name: "ankr",
		receiptFn: func(_ context.Context, _ common.Hash) (*types.Receipt, error) {
			t.Fatal("secondary should NOT be called on NotFound from primary")
			return nil, nil
		},
	}
	c := newTestClient(t, time.Second, primary, secondary)

	_, err := c.TransactionReceipt(context.Background(), common.Hash{})
	if !errors.Is(err, ethereum.NotFound) {
		t.Fatalf("expected ethereum.NotFound, got: %v", err)
	}
	if primary.receiptCalls.Load() != 1 {
		t.Errorf("primary receipt call count: got %d, want 1", primary.receiptCalls.Load())
	}
	if secondary.receiptCalls.Load() != 0 {
		t.Errorf("secondary receipt call count: got %d, want 0", secondary.receiptCalls.Load())
	}
}

func TestClient_TransactionReceipt_RealErrorTriggersFallback(t *testing.T) {
	t.Parallel()

	wantReceipt := &types.Receipt{TxHash: common.HexToHash("0xabc")}
	primary := &fakeClient{
		name: "alchemy",
		receiptFn: func(_ context.Context, _ common.Hash) (*types.Receipt, error) {
			return nil, errors.New("429 Too Many Requests")
		},
	}
	secondary := &fakeClient{
		name: "ankr",
		receiptFn: func(_ context.Context, _ common.Hash) (*types.Receipt, error) {
			return wantReceipt, nil
		},
	}
	c := newTestClient(t, time.Second, primary, secondary)

	r, err := c.TransactionReceipt(context.Background(), common.Hash{})
	if err != nil {
		t.Fatalf("expected success via fallback, got: %v", err)
	}
	if r != wantReceipt {
		t.Fatalf("got unexpected receipt: %v", r)
	}
}

// --- Close closes all providers ---------------------------------------------

func TestClient_Close_AllProviders(t *testing.T) {
	t.Parallel()

	p1 := &fakeClient{name: "a"}
	p2 := &fakeClient{name: "b"}
	p3 := &fakeClient{name: "c"}
	c := newTestClient(t, time.Second, p1, p2, p3)
	c.Close()
	for _, p := range []*fakeClient{p1, p2, p3} {
		if p.closeCalls.Load() != 1 {
			t.Errorf("provider %s: close calls = %d, want 1", p.name, p.closeCalls.Load())
		}
	}
}

// --- ProviderNames order matches construction -------------------------------

func TestClient_ProviderNames(t *testing.T) {
	t.Parallel()

	c := newTestClient(t, time.Second,
		&fakeClient{name: "public"},
		&fakeClient{name: "alchemy"},
		&fakeClient{name: "ankr"},
	)
	got := c.ProviderNames()
	want := []string{"public", "alchemy", "ankr"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("[%d] got %s want %s", i, got[i], want[i])
		}
	}
}

// --- Constructor rejects empty / all-blank URL lists ------------------------

func TestNew_RejectsEmptyURLs(t *testing.T) {
	t.Parallel()

	log := zap.NewNop().Sugar()
	_, err := New(context.Background(), log, "indexer", []string{}, time.Second)
	if err == nil {
		t.Error("expected error for empty URL list")
	}
	_, err = New(context.Background(), log, "indexer", []string{"", "   ", ""}, time.Second)
	if err == nil {
		t.Error("expected error when all URLs are blank")
	}
	_, err = New(context.Background(), log, "", []string{"http://x"}, time.Second)
	if err == nil {
		t.Error("expected error when service is empty")
	}
}

// --- resultLabel classification ---------------------------------------------

func TestResultLabel(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
		want string
	}{
		{"nil", nil, "ok"},
		{"429 plain", errors.New("429 Too Many Requests"), "rate_limited"},
		{"alchemy capacity", errors.New("429 Too Many Requests: Monthly capacity limit exceeded"), "rate_limited"},
		{"rate limit text", errors.New("Rate Limit exceeded"), "rate_limited"},
		{"ankr 403 quota", errors.New("403 Forbidden: quota exceeded"), "rate_limited"},
		{"jsonrpc -32005", errors.New("json-rpc error -32005: query exceeded limit"), "rate_limited"},
		{"context deadline", context.DeadlineExceeded, "timeout"},
		{"context canceled", context.Canceled, "timeout"},
		{"wrapped deadline", fmt.Errorf("rpc call: %w", context.DeadlineExceeded), "timeout"},
		{"502 bad gateway", errors.New("502 Bad Gateway"), "network"},
		{"503 unavailable", errors.New("503 Service Unavailable"), "network"},
		{"504 gateway timeout", errors.New("504 Gateway Timeout"), "network"},
		{"cloudflare 522", errors.New("522 Connection timed out"), "network"},
		{"eof", errors.New("unexpected EOF"), "network"},
		{"execution reverted", errors.New("execution reverted"), "other"},
		{"nonce too low", errors.New("nonce too low"), "other"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := resultLabel(tc.err); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// --- providerName classification --------------------------------------------

func TestProviderName(t *testing.T) {
	t.Parallel()

	cases := []struct {
		url  string
		want string
	}{
		{"https://base-mainnet.g.alchemy.com/v2/abc123", "alchemy"},
		{"https://rpc.ankr.com/base/xxx", "ankr"},
		{"https://mainnet.base.org", "public"},
		{"https://sepolia.base.org", "public"},
		{"https://base-mainnet.infura.io/v3/xxx", "infura"},
		{"https://x.quicknode.com/xxx", "quicknode"},
		{"https://somerandomrpc.example.com", "other"},
		{"not-a-url", "other"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.url, func(t *testing.T) {
			t.Parallel()
			if got := providerName(tc.url); got != tc.want {
				t.Errorf("providerName(%q) = %q, want %q", tc.url, got, tc.want)
			}
		})
	}
}

// --- Helpers ----------------------------------------------------------------

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
