package depositgrp

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/deposit"
	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	"github.com/flamefalcon/coin-pusher/backend/business/web/mid"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/ethereum"
)

// ---------------------------------------------------------------------------
// Helpers: generate a real ETH keypair and sign a message via EIP-191.
// ---------------------------------------------------------------------------

type testWallet struct {
	Address    string // EIP-55 checksummed
	PrivateHex string
}

func newTestWallet(t *testing.T) testWallet {
	t.Helper()
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey).Hex()
	privHex := fmt.Sprintf("%x", crypto.FromECDSA(key))
	return testWallet{Address: addr, PrivateHex: privHex}
}

// personalSign performs EIP-191 personal_sign on message with the given hex private key.
func personalSign(t *testing.T, privHex, message string) string {
	t.Helper()
	key, err := crypto.HexToECDSA(privHex)
	if err != nil {
		t.Fatalf("hex to ecdsa: %v", err)
	}
	prefixed := fmt.Sprintf("\x19Ethereum Signed Message:\n%d%s", len(message), message)
	hash := crypto.Keccak256([]byte(prefixed))
	sig, err := crypto.Sign(hash, key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	// crypto.Sign returns v=0/1, MetaMask uses v=27/28.
	sig[64] += 27
	return fmt.Sprintf("0x%x", sig)
}

// ---------------------------------------------------------------------------
// Mock: user.Storer (for user.Core — controls nonce + wallet address).
// ---------------------------------------------------------------------------

type mockUserStorer struct {
	consumeNonceFn       func(ctx context.Context, nonce string) (user.NonceRecord, error)
	queryWalletAddressFn func(ctx context.Context, accountID uuid.UUID) (string, error)
}

func (m *mockUserStorer) Create(_ context.Context, _ user.Account) error                 { return nil }
func (m *mockUserStorer) CreateAuthProvider(_ context.Context, _ user.AuthProvider) error { return nil }
func (m *mockUserStorer) QueryByID(_ context.Context, _ uuid.UUID) (user.Account, error) {
	return user.Account{}, nil
}
func (m *mockUserStorer) QueryByIDForUpdate(_ context.Context, _ uuid.UUID) (user.Account, error) {
	return user.Account{}, nil
}
func (m *mockUserStorer) QueryByProvider(_ context.Context, _, _ string) (user.Account, error) {
	return user.Account{}, nil
}
func (m *mockUserStorer) UpdateBalance(_ context.Context, _ uuid.UUID, _ string, _ decimal.Decimal) (decimal.Decimal, error) {
	return decimal.Zero, nil
}
func (m *mockUserStorer) SetRole(_ context.Context, _ uuid.UUID, _ string) error { return nil }
func (m *mockUserStorer) QueryByReferralCode(_ context.Context, _ string) (user.Account, error) {
	return user.Account{}, nil
}
func (m *mockUserStorer) SetDisplayName(_ context.Context, _ uuid.UUID, _ string) error  { return nil }
func (m *mockUserStorer) SetReferralCode(_ context.Context, _ uuid.UUID, _ string) error { return nil }
func (m *mockUserStorer) SetReferredBy(_ context.Context, _, _ uuid.UUID) error           { return nil }
func (m *mockUserStorer) IncrementLifetimeDeposit(_ context.Context, _ uuid.UUID, _ decimal.Decimal) error {
	return nil
}
func (m *mockUserStorer) MarkReferralRewardPaid(_ context.Context, _ uuid.UUID) error { return nil }
func (m *mockUserStorer) CountReferrals(_ context.Context, _ uuid.UUID) (int, error)  { return 0, nil }
func (m *mockUserStorer) QueryWalletAddress(ctx context.Context, accountID uuid.UUID) (string, error) {
	if m.queryWalletAddressFn != nil {
		return m.queryWalletAddressFn(ctx, accountID)
	}
	return "", nil
}
func (m *mockUserStorer) CreateNonce(_ context.Context, _, _ string, _ time.Time) error { return nil }
func (m *mockUserStorer) ConsumeNonce(ctx context.Context, nonce string) (user.NonceRecord, error) {
	if m.consumeNonceFn != nil {
		return m.consumeNonceFn(ctx, nonce)
	}
	return user.NonceRecord{}, nil
}
func (m *mockUserStorer) PurgeExpiredNonces(_ context.Context) (int64, error) { return 0, nil }

// ---------------------------------------------------------------------------
// Mock: deposit.Storer (minimal — only RequestWithdrawal path).
// ---------------------------------------------------------------------------

type mockDepositStorer struct {
	createWithdrawRequestFn   func(ctx context.Context, wr deposit.WithdrawRequest) error
	queryDailyWithdrawTotalFn func(ctx context.Context, accountID uuid.UUID) (decimal.Decimal, error)
}

func (m *mockDepositStorer) QueryAddressByAccount(_ context.Context, _ uuid.UUID, _ string) (deposit.DepositAddress, error) {
	return deposit.DepositAddress{}, nil
}
func (m *mockDepositStorer) QueryAddressByAddress(_ context.Context, _, _ string) (deposit.DepositAddress, error) {
	return deposit.DepositAddress{}, nil
}
func (m *mockDepositStorer) QueryAllAddresses(_ context.Context, _ string) ([]deposit.DepositAddress, error) {
	return nil, nil
}
func (m *mockDepositStorer) CreateAddress(_ context.Context, _ deposit.DepositAddress) error {
	return nil
}
func (m *mockDepositStorer) NextDerivationIndex(_ context.Context, _ string) (int, error) {
	return 0, nil
}
func (m *mockDepositStorer) AcquireAdvisoryLock(_ context.Context, _ int64) error { return nil }
func (m *mockDepositStorer) CreateDeposit(_ context.Context, _ deposit.Deposit) error {
	return nil
}
func (m *mockDepositStorer) QueryDepositByTxHash(_ context.Context, _ string) (deposit.Deposit, error) {
	return deposit.Deposit{}, nil
}
func (m *mockDepositStorer) QueryDepositsByAccount(_ context.Context, _ uuid.UUID) ([]deposit.Deposit, error) {
	return nil, nil
}
func (m *mockDepositStorer) CreateWithdrawRequest(ctx context.Context, wr deposit.WithdrawRequest) error {
	if m.createWithdrawRequestFn != nil {
		return m.createWithdrawRequestFn(ctx, wr)
	}
	return nil
}
func (m *mockDepositStorer) QueryWithdrawRequestsByAccount(_ context.Context, _ uuid.UUID) ([]deposit.WithdrawRequest, error) {
	return nil, nil
}
func (m *mockDepositStorer) UpdateWithdrawRequestStatus(_ context.Context, _ uuid.UUID, _ string, _, _ *string) error {
	return nil
}
func (m *mockDepositStorer) QueryDailyWithdrawTotal(ctx context.Context, accountID uuid.UUID) (decimal.Decimal, error) {
	if m.queryDailyWithdrawTotalFn != nil {
		return m.queryDailyWithdrawTotalFn(ctx, accountID)
	}
	return decimal.Zero, nil
}
func (m *mockDepositStorer) QueryWithdrawRequestsByStatus(_ context.Context, _ []string, _ int) ([]deposit.WithdrawRequest, error) {
	return nil, nil
}
func (m *mockDepositStorer) QueryWithdrawRequestForUpdate(_ context.Context, _ uuid.UUID) (deposit.WithdrawRequest, error) {
	return deposit.WithdrawRequest{}, nil
}
func (m *mockDepositStorer) CreateSweep(_ context.Context, _ deposit.Sweep) error { return nil }
func (m *mockDepositStorer) UpdateSweepStatus(_ context.Context, _ uuid.UUID, _ string, _, _, _ *string) error {
	return nil
}
func (m *mockDepositStorer) ClaimApprovedWithdrawals(_ context.Context, _ int) ([]deposit.WithdrawRequest, error) {
	return nil, nil
}
func (m *mockDepositStorer) HasActiveSweep(_ context.Context, _ uuid.UUID) (bool, error) {
	return false, nil
}
func (m *mockDepositStorer) QuerySweepsByStatus(_ context.Context, _ []string, _ int) ([]deposit.Sweep, error) {
	return nil, nil
}
func (m *mockDepositStorer) CountApprovedWithdrawals(_ context.Context) (int, error) {
	return 0, nil
}
func (m *mockDepositStorer) CountActiveSweeps(_ context.Context) (int, error) {
	return 0, nil
}
func (m *mockDepositStorer) CountDepositAddresses(_ context.Context, _ string) (int, error) {
	return 0, nil
}

// ---------------------------------------------------------------------------
// Test: RequestWithdrawal with real EIP-191 signatures.
// ---------------------------------------------------------------------------

func TestRequestWithdrawal_SignatureVerification(t *testing.T) {
	t.Parallel()

	w := newTestWallet(t)
	accountID := uuid.New()
	nonce := "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aabb7788ccddeeff"
	toAddress := "0x1234567890abcdef1234567890abcdef12345678"
	amount := "25.500000"     // cash coins (sent in request body)
	usdcAmount := "2.550000"  // USDC = cash / ExchangeRate (used in signed message)

	// Build the canonical message and sign it (signed message uses USDC amount).
	message := ethereum.FormatWithdrawMessage(nonce, toAddress, usdcAmount)
	sig := personalSign(t, w.PrivateHex, message)

	// Construct user.Core with mock storer.
	userStorer := &mockUserStorer{
		consumeNonceFn: func(_ context.Context, n string) (user.NonceRecord, error) {
			if n == nonce {
				return user.NonceRecord{Nonce: n}, nil
			}
			return user.NonceRecord{}, v1.NewRequestError(v1.ErrNotFound, 401)
		},
		queryWalletAddressFn: func(_ context.Context, _ uuid.UUID) (string, error) {
			return w.Address, nil
		},
	}
	userCore := user.NewCore(userStorer)

	// Construct deposit.Core with nil DB (uses mock storer directly).
	depositCore := deposit.NewCore(nil, &mockDepositStorer{
		queryDailyWithdrawTotalFn: func(_ context.Context, _ uuid.UUID) (decimal.Decimal, error) {
			return decimal.Zero, nil
		},
	}, nil, nil, userCore, nil, nil, nil)

	grp := New(depositCore, userCore)

	// Helper to call handler with claims injected.
	// Returns (status, body, panickedPastAuth).
	// panickedPastAuth is true if the handler passed signature verification
	// but panicked inside deposit.RequestWithdrawal (expected — no real DB).
	type result struct {
		status           int
		body             string
		panickedPastAuth bool
	}
	callHandler := func(body string) result {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/v1/withdraw", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		ctx := mid.SetClaims(req.Context(), mid.Claims{AccountID: accountID.String(), Role: "user"})
		rec := httptest.NewRecorder()

		var res result
		func() {
			defer func() {
				if r := recover(); r != nil {
					// Panic means we passed all auth checks and reached deposit layer.
					res = result{status: 0, body: fmt.Sprintf("panic: %v", r), panickedPastAuth: true}
				}
			}()
			err := grp.RequestWithdrawal(ctx, rec, req.WithContext(ctx))
			if err != nil {
				var reqErr *v1.RequestError
				if ok := matchRequestError(err, &reqErr); ok {
					res = result{status: reqErr.Status, body: reqErr.Error()}
				} else {
					res = result{status: 500, body: err.Error()}
				}
			} else {
				res = result{status: rec.Code, body: rec.Body.String()}
			}
		}()
		return res
	}

	// -------------------------------------------------------------------
	// Case 1: Happy path — valid signature passes all auth checks.
	// -------------------------------------------------------------------
	t.Run("valid signature - passes verification", func(t *testing.T) {
		body := fmt.Sprintf(`{"to_address":"%s","amount":"%s","nonce":"%s","signature":"%s"}`,
			toAddress, amount, nonce, sig)

		nonceUsed := false
		userStorer.consumeNonceFn = func(_ context.Context, n string) (user.NonceRecord, error) {
			if nonceUsed {
				return user.NonceRecord{}, v1.NewRequestError(v1.ErrNotFound, 401)
			}
			nonceUsed = true
			return user.NonceRecord{Nonce: n}, nil
		}

		res := callHandler(body)
		if res.status == 400 || res.status == 401 {
			t.Fatalf("signature verification should pass, got %d: %s", res.status, res.body)
		}
		// panickedPastAuth or 200 both mean signature verification succeeded.
		if res.panickedPastAuth {
			t.Log("PASS: signature verification passed (reached deposit layer)")
		} else {
			t.Logf("PASS: status=%d", res.status)
		}
	})

	// -------------------------------------------------------------------
	// Case 2: Tampered amount — signed 25.500000 but send 99.000000.
	// -------------------------------------------------------------------
	t.Run("tampered amount - 401", func(t *testing.T) {
		userStorer.consumeNonceFn = func(_ context.Context, _ string) (user.NonceRecord, error) {
			return user.NonceRecord{}, nil
		}
		body := fmt.Sprintf(`{"to_address":"%s","amount":"99.000000","nonce":"%s","signature":"%s"}`,
			toAddress, nonce, sig)

		res := callHandler(body)
		if res.status != 401 {
			t.Fatalf("tampered amount should be 401, got %d: %s", res.status, res.body)
		}
	})

	// -------------------------------------------------------------------
	// Case 3: Reused nonce — ConsumeNonce returns not found.
	// -------------------------------------------------------------------
	t.Run("reused nonce - 401", func(t *testing.T) {
		userStorer.consumeNonceFn = func(_ context.Context, _ string) (user.NonceRecord, error) {
			return user.NonceRecord{}, v1.NewRequestError(v1.ErrNotFound, 401)
		}
		body := fmt.Sprintf(`{"to_address":"%s","amount":"%s","nonce":"%s","signature":"%s"}`,
			toAddress, amount, nonce, sig)

		res := callHandler(body)
		if res.status != 401 {
			t.Fatalf("reused nonce should be 401, got %d: %s", res.status, res.body)
		}
	})

	// -------------------------------------------------------------------
	// Case 4: Missing nonce/signature — 400.
	// -------------------------------------------------------------------
	t.Run("missing signature - 400", func(t *testing.T) {
		body := fmt.Sprintf(`{"to_address":"%s","amount":"%s"}`, toAddress, amount)

		res := callHandler(body)
		if res.status != 400 {
			t.Fatalf("missing signature should be 400, got %d: %s", res.status, res.body)
		}
	})

	// -------------------------------------------------------------------
	// Case 5: Tampered to_address — signed for addr A, send addr B.
	// -------------------------------------------------------------------
	t.Run("tampered to_address - 401", func(t *testing.T) {
		userStorer.consumeNonceFn = func(_ context.Context, _ string) (user.NonceRecord, error) {
			return user.NonceRecord{}, nil
		}
		differentAddr := "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		body := fmt.Sprintf(`{"to_address":"%s","amount":"%s","nonce":"%s","signature":"%s"}`,
			differentAddr, amount, nonce, sig)

		res := callHandler(body)
		if res.status != 401 {
			t.Fatalf("tampered address should be 401, got %d: %s", res.status, res.body)
		}
	})

	// -------------------------------------------------------------------
	// Case 6: Wallet address mismatch — signature valid but from different wallet.
	// -------------------------------------------------------------------
	t.Run("wrong wallet - 401", func(t *testing.T) {
		userStorer.consumeNonceFn = func(_ context.Context, _ string) (user.NonceRecord, error) {
			return user.NonceRecord{}, nil
		}
		userStorer.queryWalletAddressFn = func(_ context.Context, _ uuid.UUID) (string, error) {
			return "0x0000000000000000000000000000000000000001", nil
		}
		body := fmt.Sprintf(`{"to_address":"%s","amount":"%s","nonce":"%s","signature":"%s"}`,
			toAddress, amount, nonce, sig)

		res := callHandler(body)
		if res.status != 401 {
			t.Fatalf("wrong wallet should be 401, got %d: %s", res.status, res.body)
		}

		// Reset.
		userStorer.queryWalletAddressFn = func(_ context.Context, _ uuid.UUID) (string, error) {
			return w.Address, nil
		}
	})

	// -------------------------------------------------------------------
	// Case 7: Lowercase address — client sends lowercase, should still work.
	// -------------------------------------------------------------------
	t.Run("lowercase address - passes verification", func(t *testing.T) {
		lowerAddr := strings.ToLower(toAddress)
		lowerMessage := ethereum.FormatWithdrawMessage(nonce, lowerAddr, usdcAmount)
		lowerSig := personalSign(t, w.PrivateHex, lowerMessage)

		userStorer.consumeNonceFn = func(_ context.Context, _ string) (user.NonceRecord, error) {
			return user.NonceRecord{}, nil
		}

		body := fmt.Sprintf(`{"to_address":"%s","amount":"%s","nonce":"%s","signature":"%s"}`,
			lowerAddr, amount, nonce, lowerSig)

		res := callHandler(body)
		if res.status == 400 || res.status == 401 {
			t.Fatalf("lowercase address should pass verification, got %d: %s", res.status, res.body)
		}
		if res.panickedPastAuth {
			t.Log("PASS: lowercase address verification passed (reached deposit layer)")
		} else {
			t.Logf("PASS: status=%d", res.status)
		}
	})
}

func matchRequestError(err error, target **v1.RequestError) bool {
	for err != nil {
		if re, ok := err.(*v1.RequestError); ok {
			*target = re
			return true
		}
		if uw, ok := err.(interface{ Unwrap() error }); ok {
			err = uw.Unwrap()
		} else {
			break
		}
	}
	return false
}
