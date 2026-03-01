package accounting

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"github.com/flamefalcon/coin-pusher/backend/foundation/database"
)

// StorerFactory builds a Storer bound to the given DBTX (db or tx).
type StorerFactory func(database.DBTX) Storer

// UserStorerFactory builds a user.Storer bound to the given DBTX.
type UserStorerFactory func(database.DBTX) user.Storer

// MetricRecorder is a callback for recording metric events to the progress system.
type MetricRecorder func(ctx context.Context, accountID uuid.UUID, metricType string, delta decimal.Decimal) error

// Core manages the set of APIs for accounting access.
type Core struct {
	db              *sqlx.DB         // needed to start transactions; nil in unit tests
	storer          Storer           // default storer (non-tx)
	userCore        *user.Core       // default user core (non-tx)
	newStorer       StorerFactory    // creates tx-bound accounting storer
	newUserStorer   UserStorerFactory // creates tx-bound user storer
	metricRecorder  MetricRecorder
}

// NewCore constructs an accounting Core.
//
// In production, pass factory funcs so that execTx can build tx-bound stores.
// In unit tests, pass nil for db and factories — methods fall back to the
// default storer/userCore (which are mocks).
func NewCore(db *sqlx.DB, storer Storer, userCore *user.Core, newStorer StorerFactory, newUserStorer UserStorerFactory) *Core {
	return &Core{
		db:            db,
		storer:        storer,
		userCore:      userCore,
		newStorer:     newStorer,
		newUserStorer: newUserStorer,
	}
}

// SetMetricRecorder sets the callback for recording metric events.
func (c *Core) SetMetricRecorder(fn MetricRecorder) {
	c.metricRecorder = fn
}

// txStores holds tx-bound instances used inside execTx.
type txStores struct {
	storer   Storer
	userCore *user.Core
}

// execTx runs fn inside a database transaction. Factory funcs create
// tx-bound stores so every SQL call within fn shares the same tx.
//
// When db is nil (unit tests), fn receives the default (mock) stores directly.
func (c *Core) execTx(ctx context.Context, fn func(s txStores) error) error {
	if c.db == nil {
		return fn(txStores{storer: c.storer, userCore: c.userCore})
	}

	return database.ExecTx(ctx, c.db, func(tx *sqlx.Tx) error {
		s := txStores{
			storer:   c.newStorer(tx),
			userCore: user.NewCore(c.newUserStorer(tx)),
		}
		return fn(s)
	})
}

// ProcessDeposit handles an on-chain deposit event idempotently.
// The reference_id (tx hash) ensures each deposit is only applied once.
// The idempotency check and balance credit are wrapped in a single transaction
// to prevent TOCTOU double-credit under concurrent calls.
func (c *Core) ProcessDeposit(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal, currency, referenceID string) error {
	return c.execTx(ctx, func(s txStores) error {
		// Idempotency check inside tx to prevent TOCTOU race.
		_, err := s.storer.QueryByReference(ctx, ActionDeposit, referenceID)
		if err == nil {
			return nil // Already processed.
		}
		if !errors.Is(err, v1.ErrNotFound) {
			return fmt.Errorf("checking reference: %w", err)
		}

		now := time.Now().UTC()
		log := AccountingLog{
			LogID:       uuid.New(),
			AccountID:   accountID,
			ActionType:  ActionDeposit,
			Amount:      amount,
			Currency:    currency,
			ReferenceID: referenceID,
			CreatedAt:   now,
		}

		if err := s.storer.Create(ctx, log); err != nil {
			return fmt.Errorf("creating deposit log: %w", err)
		}

		switch currency {
		case CurrencyUSDC:
			return s.userCore.IncrementUSDCBalance(ctx, accountID, amount)
		case CurrencyPlay:
			return s.userCore.IncrementPlayBalance(ctx, accountID, amount)
		case CurrencyCash:
			return s.userCore.IncrementCashBalance(ctx, accountID, amount)
		default:
			return fmt.Errorf("unknown currency: %s", currency)
		}
	})
}

// ProcessGameInsert handles a coin insertion game event.
// Debits the account's play balance and creates a ledger entry atomically.
// Returns the new balance_play value.
func (c *Core) ProcessGameInsert(ctx context.Context, accountID uuid.UUID, coinCount int, referenceID string) (decimal.Decimal, error) {
	amount := decimal.NewFromInt(int64(coinCount))

	var newPlay decimal.Decimal
	err := c.execTx(ctx, func(s txStores) error {
		var txErr error
		newPlay, txErr = s.userCore.DecrementPlayBalance(ctx, accountID, amount)
		if txErr != nil {
			return txErr
		}

		now := time.Now().UTC()
		log := AccountingLog{
			LogID:       uuid.New(),
			AccountID:   accountID,
			ActionType:  ActionGameInsert,
			Amount:      amount,
			Currency:    CurrencyPlay,
			ReferenceID: referenceID,
			CreatedAt:   now,
		}

		if txErr = s.storer.Create(ctx, log); txErr != nil {
			return fmt.Errorf("creating game insert log: %w", txErr)
		}
		return nil
	})

	if err != nil {
		return decimal.Zero, err
	}

	// Record game insert metric for progress system (after tx succeeds).
	if c.metricRecorder != nil {
		if mrErr := c.metricRecorder(ctx, accountID, "game_insert_count", amount); mrErr != nil {
			_ = mrErr
		}
	}

	return newPlay, nil
}

// ProcessGameInsertRefund reverses a game insert by crediting play balance back.
// Used when NATS publish fails after balance was already debited.
func (c *Core) ProcessGameInsertRefund(ctx context.Context, accountID uuid.UUID, coinCount int, referenceID string) (decimal.Decimal, error) {
	amount := decimal.NewFromInt(int64(coinCount))

	var newPlay decimal.Decimal
	err := c.execTx(ctx, func(s txStores) error {
		if err := s.userCore.IncrementPlayBalance(ctx, accountID, amount); err != nil {
			return err
		}

		acct, err := s.userCore.QueryByID(ctx, accountID)
		if err != nil {
			return err
		}
		newPlay = acct.BalancePlay

		now := time.Now().UTC()
		log := AccountingLog{
			LogID:       uuid.New(),
			AccountID:   accountID,
			ActionType:  ActionGameInsertRefund,
			Amount:      amount,
			Currency:    CurrencyPlay,
			ReferenceID: referenceID,
			CreatedAt:   now,
		}

		if txErr := s.storer.Create(ctx, log); txErr != nil {
			return fmt.Errorf("creating game insert refund log: %w", txErr)
		}
		return nil
	})

	if err != nil {
		return decimal.Zero, err
	}
	return newPlay, nil
}

// ProcessGameReward handles a game reward event (coins distributed via heat shares).
// Credits the account's cash balance and creates a ledger entry atomically.
func (c *Core) ProcessGameReward(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal, referenceID string) error {
	return c.execTx(ctx, func(s txStores) error {
		if err := s.userCore.IncrementCashBalance(ctx, accountID, amount); err != nil {
			return err
		}

		now := time.Now().UTC()
		log := AccountingLog{
			LogID:       uuid.New(),
			AccountID:   accountID,
			ActionType:  ActionGameReward,
			Amount:      amount,
			Currency:    CurrencyCash,
			ReferenceID: referenceID,
			CreatedAt:   now,
		}

		if err := s.storer.Create(ctx, log); err != nil {
			return fmt.Errorf("creating game reward log: %w", err)
		}
		return nil
	})
}
