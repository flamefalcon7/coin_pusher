package user

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
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

	// Resolve referrer if code provided.
	var referredBy *uuid.UUID
	if na.ReferralCode != "" {
		referrer, err := c.storer.QueryByReferralCode(ctx, na.ReferralCode)
		if err == nil {
			referredBy = &referrer.ID
		}
		// Silently ignore invalid referral codes.
	}

	now := time.Now().UTC()
	acct = Account{
		ID:          uuid.New(),
		BalanceUSDC: decimal.Zero,
		BalancePlay: c.initialBalance,
		BalanceCash: decimal.Zero,
		ReferredBy:  referredBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	// Retry up to 3 times on referral code collision.
	for attempts := 0; attempts < 3; attempts++ {
		code, err := generateReferralCode()
		if err != nil {
			return Account{}, fmt.Errorf("generate referral code: %w", err)
		}
		acct.ReferralCode = code

		err = c.storer.Create(ctx, acct)
		if err == nil {
			break
		}
		if !database.IsUniqueViolation(err) {
			return Account{}, fmt.Errorf("create account: %w", err)
		}
		// Unique violation on referral_code — retry with new code.
		if attempts == 2 {
			return Account{}, fmt.Errorf("create account: referral code collision after 3 attempts")
		}
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
		// Concurrent request already created the provider — return the existing account.
		if database.IsUniqueViolation(err) {
			return c.storer.QueryByProvider(ctx, na.ProviderType, na.ProviderUID)
		}
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

// QueryByIDForUpdate finds an account by ID with a FOR UPDATE row lock.
// Must be called within a transaction.
func (c *Core) QueryByIDForUpdate(ctx context.Context, accountID uuid.UUID) (Account, error) {
	acct, err := c.storer.QueryByIDForUpdate(ctx, accountID)
	if err != nil {
		return Account{}, fmt.Errorf("query for update by id[%s]: %w", accountID, err)
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
// referralCode is optional — only used when creating a new account.
func (c *Core) VerifyWalletLogin(ctx context.Context, nonce, signature, claimedAddress, referralCode string) (Account, error) {
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
		ReferralCode: referralCode,
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

	// Resolve referrer if code provided.
	var referredBy *uuid.UUID
	if na.ReferralCode != "" {
		referrer, err := c.storer.QueryByReferralCode(ctx, na.ReferralCode)
		if err != nil {
			return Account{}, v1.NewRequestError(
				fmt.Errorf("invalid referral code"),
				400,
			)
		}
		referredBy = &referrer.ID
	}

	now := time.Now().UTC()
	acct = Account{
		ID:          uuid.New(),
		BalanceUSDC: decimal.Zero,
		BalancePlay: c.initialBalance,
		BalanceCash: decimal.Zero,
		ReferredBy:  referredBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	// Retry up to 3 times on referral code collision.
	for attempts := 0; attempts < 3; attempts++ {
		code, err := generateReferralCode()
		if err != nil {
			return Account{}, fmt.Errorf("generate referral code: %w", err)
		}
		acct.ReferralCode = code

		err = c.storer.Create(ctx, acct)
		if err == nil {
			break
		}
		if !database.IsUniqueViolation(err) {
			return Account{}, fmt.Errorf("create account: %w", err)
		}
		if attempts == 2 {
			return Account{}, fmt.Errorf("create account: referral code collision after 3 attempts")
		}
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
		// Concurrent request already created the provider — return the existing account.
		if database.IsUniqueViolation(err) {
			return c.storer.QueryByProvider(ctx, na.ProviderType, na.ProviderUID)
		}
		return Account{}, fmt.Errorf("create auth provider: %w", err)
	}

	return acct, nil
}

// PurgeExpiredNonces removes expired nonces from the database.
func (c *Core) PurgeExpiredNonces(ctx context.Context) (int64, error) {
	return c.storer.PurgeExpiredNonces(ctx)
}

// -------------------------------------------------------------------------
// Referral + Username
// -------------------------------------------------------------------------

// Thresholds for feature unlocks (cumulative USDC deposited).
var (
	ThresholdCustomReferralCode = decimal.NewFromInt(10)
	ThresholdCustomUsername     = decimal.NewFromInt(100)
)

// Validation constraints.
var (
	nameRegex     = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	reservedNames = map[string]bool{
		"admin": true, "administrator": true, "mod": true, "moderator": true,
		"system": true, "support": true, "help": true, "null": true,
		"undefined": true, "root": true, "coinpusher": true, "coin_pusher": true,
		"flamefalcon": true, "flame_falcon": true,
	}
)

// ValidateName checks a display name or referral code against the rules.
// Returns an error message string or "" if valid.
func ValidateName(name string, minLen, maxLen int) error {
	n := len(name)
	if n < minLen || n > maxLen {
		return fmt.Errorf("must be %d-%d characters", minLen, maxLen)
	}
	if !nameRegex.MatchString(name) {
		return fmt.Errorf("only letters, numbers, underscore, and hyphen allowed")
	}
	if reservedNames[strings.ToLower(name)] {
		return fmt.Errorf("this name is reserved")
	}
	return nil
}

// SetDisplayName validates and sets a custom username.
// Requires lifetime deposit >= $100 and display_name not already set.
func (c *Core) SetDisplayName(ctx context.Context, accountID uuid.UUID, name string) error {
	if err := ValidateName(name, 3, 20); err != nil {
		return v1.NewRequestError(err, 400)
	}

	acct, err := c.storer.QueryByID(ctx, accountID)
	if err != nil {
		return err
	}

	if acct.DisplayName != nil {
		return v1.NewRequestError(fmt.Errorf("username already set"), 409)
	}

	if acct.LifetimeDepositUSDC.LessThan(ThresholdCustomUsername) {
		return v1.NewRequestError(
			fmt.Errorf("requires $%s lifetime deposit (current: $%s)",
				ThresholdCustomUsername.StringFixed(0), acct.LifetimeDepositUSDC.StringFixed(2)),
			403,
		)
	}

	return c.storer.SetDisplayName(ctx, accountID, name)
}

// SetCustomReferralCode validates and sets a custom referral code.
// Requires lifetime deposit >= $10 and code not already customized.
// The code is stored in uppercase for case-insensitive matching.
func (c *Core) SetCustomReferralCode(ctx context.Context, accountID uuid.UUID, code string) error {
	code = strings.ToLower(code)

	if err := ValidateName(code, 3, 20); err != nil {
		return v1.NewRequestError(err, 400)
	}

	acct, err := c.storer.QueryByID(ctx, accountID)
	if err != nil {
		return err
	}

	if acct.ReferralCodeCustomized {
		return v1.NewRequestError(fmt.Errorf("referral code already customized"), 409)
	}

	if acct.LifetimeDepositUSDC.LessThan(ThresholdCustomReferralCode) {
		return v1.NewRequestError(
			fmt.Errorf("requires $%s lifetime deposit (current: $%s)",
				ThresholdCustomReferralCode.StringFixed(0), acct.LifetimeDepositUSDC.StringFixed(2)),
			403,
		)
	}

	// Prevent self-collision: can't set code to another user's existing code.
	// The UNIQUE index handles this, but we get a cleaner error from the store.
	return c.storer.SetReferralCode(ctx, accountID, code)
}

// QueryByReferralCode looks up an account by referral code.
func (c *Core) QueryByReferralCode(ctx context.Context, code string) (Account, error) {
	return c.storer.QueryByReferralCode(ctx, code)
}

// IncrementLifetimeDeposit adds to lifetime deposit tracker.
func (c *Core) IncrementLifetimeDeposit(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal) error {
	return c.storer.IncrementLifetimeDeposit(ctx, accountID, amount)
}

// MarkReferralRewardPaid marks the referral reward as paid.
func (c *Core) MarkReferralRewardPaid(ctx context.Context, accountID uuid.UUID) error {
	return c.storer.MarkReferralRewardPaid(ctx, accountID)
}

// CountReferrals returns how many users this account has referred.
func (c *Core) CountReferrals(ctx context.Context, accountID uuid.UUID) (int, error) {
	return c.storer.CountReferrals(ctx, accountID)
}

// generateReferralCode creates a random 8-character alphanumeric code (XXXX-XXXX).
func generateReferralCode() (string, error) {
	const charset = "abcdefghjklmnpqrstuvwxyz23456789" // no 0/o/1/i/l confusion
	b := make([]byte, 8)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		if err != nil {
			return "", err
		}
		b[i] = charset[n.Int64()]
	}
	return string(b[:4]) + "-" + string(b[4:]), nil
}
