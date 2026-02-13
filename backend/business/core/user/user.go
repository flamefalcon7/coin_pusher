package user

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// Core manages the set of APIs for user access.
type Core struct {
	storer Storer
}

// NewCore constructs a user Core.
func NewCore(storer Storer) *Core {
	return &Core{storer: storer}
}

// FindOrCreate looks up a user by SUI address, creating one if not found.
func (c *Core) FindOrCreate(ctx context.Context, nu NewUser) (User, error) {
	usr, err := c.storer.QueryBySUIAddress(ctx, nu.SUIAddress)
	if err == nil {
		return usr, nil
	}

	if !errors.Is(err, v1.ErrNotFound) {
		return User{}, fmt.Errorf("query by sui address: %w", err)
	}

	now := time.Now().UTC()
	usr = User{
		ID:          uuid.New(),
		Name:        nu.Name,
		SUIAddress:  nu.SUIAddress,
		BalanceCoin: decimal.Zero,
		BalanceUSDC: decimal.Zero,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := c.storer.Create(ctx, usr); err != nil {
		return User{}, fmt.Errorf("create user: %w", err)
	}

	return usr, nil
}

// QueryByID finds a user by ID.
func (c *Core) QueryByID(ctx context.Context, userID uuid.UUID) (User, error) {
	usr, err := c.storer.QueryByID(ctx, userID)
	if err != nil {
		return User{}, fmt.Errorf("query by id[%s]: %w", userID, err)
	}
	return usr, nil
}

// DecrementCoinBalance decreases a user's coin balance atomically.
// Returns an error if the balance is insufficient.
func (c *Core) DecrementCoinBalance(ctx context.Context, userID uuid.UUID, amount decimal.Decimal) error {
	usr, err := c.storer.QueryByID(ctx, userID)
	if err != nil {
		return fmt.Errorf("query user: %w", err)
	}

	if usr.BalanceCoin.LessThan(amount) {
		return v1.NewInsufficientFundError("COIN", amount, usr.BalanceCoin)
	}

	return c.storer.UpdateBalance(ctx, userID, "COIN", amount.Neg())
}

// IncrementCoinBalance increases a user's coin balance atomically.
func (c *Core) IncrementCoinBalance(ctx context.Context, userID uuid.UUID, amount decimal.Decimal) error {
	return c.storer.UpdateBalance(ctx, userID, "COIN", amount)
}

// IncrementUSDCBalance increases a user's USDC balance atomically.
func (c *Core) IncrementUSDCBalance(ctx context.Context, userID uuid.UUID, amount decimal.Decimal) error {
	return c.storer.UpdateBalance(ctx, userID, "USDC", amount)
}
