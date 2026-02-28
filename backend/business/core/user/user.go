package user

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/ethereum"
)

// Core manages the set of APIs for account access.
type Core struct {
	storer         Storer
	initialBalance decimal.Decimal // balance_play granted to new accounts (0 in prod)
}

// NewCore constructs an account Core.
func NewCore(storer Storer) *Core {
	return &Core{storer: storer}
}

// SetInitialBalance sets the balance_play granted to newly created accounts.
func (c *Core) SetInitialBalance(amount decimal.Decimal) {
	c.initialBalance = amount
}

// FindOrCreate looks up an account by provider, creating one if not found.
func (c *Core) FindOrCreate(ctx context.Context, na NewAccount) (Account, error) {
	acct, err := c.storer.QueryByProvider(ctx, na.ProviderType, na.ProviderUID)
	if err == nil {
		return acct, nil
	}

	if !errors.Is(err, v1.ErrNotFound) {
		return Account{}, fmt.Errorf("query by provider: %w", err)
	}

	now := time.Now().UTC()
	acct = Account{
		ID:          uuid.New(),
		DisplayName: na.DisplayName,
		BalanceUSDC: decimal.Zero,
		BalancePlay: c.initialBalance,
		BalanceCash: decimal.Zero,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := c.storer.Create(ctx, acct); err != nil {
		return Account{}, fmt.Errorf("create account: %w", err)
	}

	ap := AuthProvider{
		ProviderID:   uuid.New(),
		AccountID:    acct.ID,
		ProviderType: na.ProviderType,
		ProviderUID:  na.ProviderUID,
		MetadataJSON: "{}",
		CreatedAt:    now,
	}

	if err := c.storer.CreateAuthProvider(ctx, ap); err != nil {
		return Account{}, fmt.Errorf("create auth provider: %w", err)
	}

	return acct, nil
}

// QueryByID finds an account by ID.
func (c *Core) QueryByID(ctx context.Context, accountID uuid.UUID) (Account, error) {
	acct, err := c.storer.QueryByID(ctx, accountID)
	if err != nil {
		return Account{}, fmt.Errorf("query by id[%s]: %w", accountID, err)
	}
	return acct, nil
}

// SetRole updates the role of an account.
func (c *Core) SetRole(ctx context.Context, accountID uuid.UUID, role string) error {
	return c.storer.SetRole(ctx, accountID, role)
}

// DecrementPlayBalance decreases an account's play balance atomically.
// Returns the new balance_play value and an error if the balance is insufficient.
func (c *Core) DecrementPlayBalance(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error) {
	return c.storer.UpdateBalance(ctx, accountID, CurrencyPlay, amount.Neg())
}

// IncrementPlayBalance increases an account's play balance atomically.
func (c *Core) IncrementPlayBalance(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal) error {
	_, err := c.storer.UpdateBalance(ctx, accountID, CurrencyPlay, amount)
	return err
}

// DecrementCashBalance decreases an account's cash balance atomically.
// Returns the new balance_cash value and an error if the balance is insufficient.
func (c *Core) DecrementCashBalance(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal) (decimal.Decimal, error) {
	return c.storer.UpdateBalance(ctx, accountID, CurrencyCash, amount.Neg())
}

// IncrementCashBalance increases an account's cash balance atomically.
func (c *Core) IncrementCashBalance(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal) error {
	_, err := c.storer.UpdateBalance(ctx, accountID, CurrencyCash, amount)
	return err
}

// IncrementUSDCBalance increases an account's USDC balance atomically.
func (c *Core) IncrementUSDCBalance(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal) error {
	_, err := c.storer.UpdateBalance(ctx, accountID, CurrencyUSDC, amount)
	return err
}

// -------------------------------------------------------------------------
// Wallet Login
// -------------------------------------------------------------------------

const nonceTTL = 5 * time.Minute

// GenerateNonce creates a cryptographic nonce for wallet login challenges.
func (c *Core) GenerateNonce(ctx context.Context) (NonceRecord, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return NonceRecord{}, fmt.Errorf("generating random bytes: %w", err)
	}

	nonce := hex.EncodeToString(b)
	expiresAt := time.Now().UTC().Add(nonceTTL)

	if err := c.storer.CreateNonce(ctx, nonce, "", expiresAt); err != nil {
		return NonceRecord{}, fmt.Errorf("creating nonce: %w", err)
	}

	return NonceRecord{
		Nonce:     nonce,
		ExpiresAt: expiresAt,
	}, nil
}

// VerifyWalletLogin verifies an EVM wallet signature and returns the account.
// Steps: consume nonce → verify EIP-191 signature → compare addresses → find or create account.
func (c *Core) VerifyWalletLogin(ctx context.Context, nonce, signature, claimedAddress string) (Account, error) {
	// 1. Consume nonce (not found / expired → 401).
	if _, err := c.storer.ConsumeNonce(ctx, nonce); err != nil {
		return Account{}, fmt.Errorf("consume nonce: %w", err)
	}

	// 2. Build the expected message and recover the signer.
	message := ethereum.FormatLoginMessage(nonce)
	recoveredAddr, err := ethereum.VerifyPersonalSign(message, signature)
	if err != nil {
		return Account{}, v1.NewRequestError(v1.ErrAuthFailed, 401)
	}

	// 3. Normalize the claimed address.
	normalizedClaimed, err := ethereum.NormalizeAddress(claimedAddress)
	if err != nil {
		return Account{}, v1.NewRequestError(v1.ErrAuthFailed, 401)
	}

	// 4. Compare recovered vs claimed (case-insensitive).
	if !strings.EqualFold(recoveredAddr, normalizedClaimed) {
		return Account{}, v1.NewRequestError(v1.ErrAuthFailed, 401)
	}

	// 5. Find or create account with wallet metadata.
	return c.FindOrCreateWithMeta(ctx, NewAccountWithMeta{
		ProviderType: "wallet",
		ProviderUID:  normalizedClaimed,
		MetadataJSON: `{"chain":"evm","chain_id":8453}`,
	})
}

// FindOrCreateWithMeta is like FindOrCreate but also sets metadata_json on the auth provider.
func (c *Core) FindOrCreateWithMeta(ctx context.Context, na NewAccountWithMeta) (Account, error) {
	acct, err := c.storer.QueryByProvider(ctx, na.ProviderType, na.ProviderUID)
	if err == nil {
		return acct, nil
	}

	if !errors.Is(err, v1.ErrNotFound) {
		return Account{}, fmt.Errorf("query by provider: %w", err)
	}

	now := time.Now().UTC()
	acct = Account{
		ID:          uuid.New(),
		DisplayName: na.DisplayName,
		BalanceUSDC: decimal.Zero,
		BalancePlay: c.initialBalance,
		BalanceCash: decimal.Zero,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := c.storer.Create(ctx, acct); err != nil {
		return Account{}, fmt.Errorf("create account: %w", err)
	}

	meta := na.MetadataJSON
	if meta == "" {
		meta = "{}"
	}

	ap := AuthProvider{
		ProviderID:   uuid.New(),
		AccountID:    acct.ID,
		ProviderType: na.ProviderType,
		ProviderUID:  na.ProviderUID,
		MetadataJSON: meta,
		CreatedAt:    now,
	}

	if err := c.storer.CreateAuthProvider(ctx, ap); err != nil {
		return Account{}, fmt.Errorf("create auth provider: %w", err)
	}

	return acct, nil
}

// PurgeExpiredNonces removes expired nonces from the database.
func (c *Core) PurgeExpiredNonces(ctx context.Context) (int64, error) {
	return c.storer.PurgeExpiredNonces(ctx)
}
