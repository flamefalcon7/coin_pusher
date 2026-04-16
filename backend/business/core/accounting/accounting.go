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
	"github.com/flamefalcon/coin-pusher/backend/foundation/metrics"
)

// StorerFactory builds a Storer bound to the given DBTX (db or tx).
type StorerFactory func(database.DBTX) Storer

// UserStorerFactory builds a user.Storer bound to the given DBTX.
type UserStorerFactory func(database.DBTX) user.Storer

// MetricRecorder is a callback for recording metric events to the progress system.
type MetricRecorder func(ctx context.Context, accountID uuid.UUID, metricType string, delta decimal.Decimal) error

// OutboxWriter is a caller-supplied callback invoked inside ProcessGameInsert's
// transaction, after the balance debit and accounting_logs writes. The
// callback writes a row to nats_outbox (or equivalent) via the tx-bound
// Storer so the outbox row commits atomically with the balance change.
//
// Kept domain-pure: this package does NOT know what NATS subject or payload
// shape the caller intends. Handlers (WS/HTTP) construct OutboxWriters that
// know both. A nil OutboxWriter is legal and means "no outbox row this call"
// — used by non-batch-insert paths (ProcessDeposit, ProcessGameReward, etc.)
// and by unit tests that don't exercise outbox semantics.
//
// If the callback returns an error, the entire transaction rolls back —
// balance, logs, and any outbox-side write are reverted together. This is
// the atomicity guarantee that closes the "balance debited but event never
// published" gap.
type OutboxWriter func(ctx context.Context, s Storer) error

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
// Debits the account using a play-first, cash-second priority within a single
// transaction and writes a ledger entry for each currency that was actually
// used (one or two entries sharing the same referenceID).
//
// The optional OutboxWriter is invoked inside the same transaction, after the
// log writes. Callers that need to publish an event for this insert (e.g.,
// the batch_insert WS/HTTP handlers) pass a writer that inserts into
// nats_outbox; callers that don't (deposit paths, tests) pass nil.
//
// After successful commit, a best-effort `NOTIFY outbox_new` is fired so the
// drainer wakes immediately. Notify failure is silently swallowed — the
// drainer's fallback tick catches missed notifications within a few seconds.
//
// Returns the amounts debited from each currency and the resulting balances.
func (c *Core) ProcessGameInsert(ctx context.Context, accountID uuid.UUID, coinCount int, referenceID string, outboxWriter OutboxWriter) (playDebited, cashDebited, newPlay, newCash decimal.Decimal, err error) {
	amount := decimal.NewFromInt(int64(coinCount))

	err = c.execTx(ctx, func(s txStores) error {
		var txErr error
		playDebited, cashDebited, newPlay, newCash, txErr = s.userCore.DecrementForInsert(ctx, accountID, amount)
		if txErr != nil {
			return txErr
		}

		now := time.Now().UTC()

		if playDebited.Sign() > 0 {
			log := AccountingLog{
				LogID:       uuid.New(),
				AccountID:   accountID,
				ActionType:  ActionGameInsert,
				Amount:      playDebited,
				Currency:    CurrencyPlay,
				ReferenceID: referenceID,
				CreatedAt:   now,
			}
			if txErr := s.storer.Create(ctx, log); txErr != nil {
				return fmt.Errorf("creating game insert log (play): %w", txErr)
			}
		}

		if cashDebited.Sign() > 0 {
			log := AccountingLog{
				LogID:       uuid.New(),
				AccountID:   accountID,
				ActionType:  ActionGameInsert,
				Amount:      cashDebited,
				Currency:    CurrencyCash,
				ReferenceID: referenceID,
				CreatedAt:   now,
			}
			if txErr := s.storer.Create(ctx, log); txErr != nil {
				return fmt.Errorf("creating game insert log (cash): %w", txErr)
			}
		}

		// Outbox row (optional) — atomic with balance + logs. If this fails,
		// the whole tx rolls back: no debit, no logs, no stuck row.
		if outboxWriter != nil {
			if txErr := outboxWriter(ctx, s.storer); txErr != nil {
				return fmt.Errorf("outbox writer: %w", txErr)
			}
		}

		return nil
	})

	if err != nil {
		return decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero, err
	}

	// Wake the outbox drainer. Best-effort: drainer's 5s fallback tick catches
	// missed notifications, and the notify isn't transactional so we fire it
	// after commit. Skip the notify when there's no DB (unit tests) or no
	// outbox writer (non-outbox callers). Use a short-timeout context
	// detached from the request ctx so a slow notify can't stall the caller.
	if outboxWriter != nil && c.db != nil {
		notifyCtx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		// Channel name is the shared outbox.NotifyChannel const; kept as a
		// string literal here to avoid a circular import between accounting
		// and outbox. Any change to the channel name must update BOTH sides —
		// the string here and outbox.NotifyChannel — or the listen/notify
		// handshake silently breaks. Covered by the Unit 6 integration test.
		if _, notifyErr := c.db.ExecContext(notifyCtx, "NOTIFY outbox_new"); notifyErr != nil {
			metrics.OutboxNotifyErrors.Inc()
		}
		cancel()
	}

	// Record game insert metric for progress system (after tx succeeds).
	// Metric amount is the total debited across both currencies — behaviourally
	// identical to pre-split insert for downstream progress tracking.
	if c.metricRecorder != nil {
		if mrErr := c.metricRecorder(ctx, accountID, "game_insert_count", amount); mrErr != nil {
			metrics.ProgressMetricErrors.Inc()
		}
	}

	return playDebited, cashDebited, newPlay, newCash, nil
}

// ProcessGameInsertRefund reverses a split game insert by crediting each
// currency back by the exact amount originally debited. The caller is expected
// to have retained the split returned by ProcessGameInsert and pass it in here.
//
// Writes one ledger entry per non-zero leg. Used when NATS publish fails after
// balance was already debited.
func (c *Core) ProcessGameInsertRefund(ctx context.Context, accountID uuid.UUID, playDebited, cashDebited decimal.Decimal, referenceID string) (newPlay, newCash decimal.Decimal, err error) {
	if playDebited.Sign() < 0 || cashDebited.Sign() < 0 {
		return decimal.Zero, decimal.Zero, fmt.Errorf("refund amounts must be non-negative: play=%s cash=%s", playDebited, cashDebited)
	}

	err = c.execTx(ctx, func(s txStores) error {
		// Idempotency check inside the transaction (mirrors ProcessDeposit's
		// TOCTOU-safe pattern, docs/security-audit.md P0-8). If any refund
		// entry already exists for this referenceID, short-circuit with the
		// current balances — replay must be a no-op, not a double-credit.
		_, qerr := s.storer.QueryByReference(ctx, ActionGameInsertRefund, referenceID)
		if qerr == nil {
			acct, err := s.userCore.QueryByID(ctx, accountID)
			if err != nil {
				return err
			}
			newPlay = acct.BalancePlay
			newCash = acct.BalanceCash
			return nil
		}
		if !errors.Is(qerr, v1.ErrNotFound) {
			return fmt.Errorf("checking refund idempotency: %w", qerr)
		}

		now := time.Now().UTC()

		if playDebited.Sign() > 0 {
			if err := s.userCore.IncrementPlayBalance(ctx, accountID, playDebited); err != nil {
				return err
			}
			log := AccountingLog{
				LogID:       uuid.New(),
				AccountID:   accountID,
				ActionType:  ActionGameInsertRefund,
				Amount:      playDebited,
				Currency:    CurrencyPlay,
				ReferenceID: referenceID,
				CreatedAt:   now,
			}
			if txErr := s.storer.Create(ctx, log); txErr != nil {
				return fmt.Errorf("creating game insert refund log (play): %w", txErr)
			}
		}

		if cashDebited.Sign() > 0 {
			if err := s.userCore.IncrementCashBalance(ctx, accountID, cashDebited); err != nil {
				return err
			}
			log := AccountingLog{
				LogID:       uuid.New(),
				AccountID:   accountID,
				ActionType:  ActionGameInsertRefund,
				Amount:      cashDebited,
				Currency:    CurrencyCash,
				ReferenceID: referenceID,
				CreatedAt:   now,
			}
			if txErr := s.storer.Create(ctx, log); txErr != nil {
				return fmt.Errorf("creating game insert refund log (cash): %w", txErr)
			}
		}

		acct, err := s.userCore.QueryByID(ctx, accountID)
		if err != nil {
			return err
		}
		newPlay = acct.BalancePlay
		newCash = acct.BalanceCash
		return nil
	})

	if err != nil {
		return decimal.Zero, decimal.Zero, err
	}
	return newPlay, newCash, nil
}

// ProcessBotRefill credits a bot account's balance_play idempotently.
//
// Mirrors ProcessDeposit shape: inside a single transaction, (a) check the
// (ActionBotRefill, referenceID) pair for prior processing, (b) if already
// processed, short-circuit with the current balance_play, (c) otherwise write
// one ActionBotRefill ledger entry and credit balance_play.
//
// Caller is responsible for policy: verifying the target account has role='bot'
// (bot.Core.RefillBalance does this), rejecting non-positive amounts, and
// constructing a unique reference_id (e.g., "bot-refill:<account_id>:<yyyymmdd>").
// The unique-constraint index on (action_type, reference_id, currency) backs
// up this guard at the DB level.
func (c *Core) ProcessBotRefill(ctx context.Context, accountID uuid.UUID, amount decimal.Decimal, referenceID string) (newPlay decimal.Decimal, err error) {
	if amount.Sign() <= 0 {
		return decimal.Zero, fmt.Errorf("bot refill amount must be positive: %s", amount)
	}
	if referenceID == "" {
		return decimal.Zero, fmt.Errorf("bot refill reference_id must be non-empty")
	}

	err = c.execTx(ctx, func(s txStores) error {
		// Idempotency check inside tx to prevent TOCTOU race.
		_, qerr := s.storer.QueryByReference(ctx, ActionBotRefill, referenceID)
		if qerr == nil {
			// Already processed — return current balance_play.
			acct, aerr := s.userCore.QueryByID(ctx, accountID)
			if aerr != nil {
				return fmt.Errorf("querying bot account on idempotent replay: %w", aerr)
			}
			newPlay = acct.BalancePlay
			return nil
		}
		if !errors.Is(qerr, v1.ErrNotFound) {
			return fmt.Errorf("checking bot refill reference: %w", qerr)
		}

		now := time.Now().UTC()
		logEntry := AccountingLog{
			LogID:       uuid.New(),
			AccountID:   accountID,
			ActionType:  ActionBotRefill,
			Amount:      amount,
			Currency:    CurrencyPlay,
			ReferenceID: referenceID,
			CreatedAt:   now,
		}
		if cerr := s.storer.Create(ctx, logEntry); cerr != nil {
			return fmt.Errorf("creating bot refill log: %w", cerr)
		}

		if ierr := s.userCore.IncrementPlayBalance(ctx, accountID, amount); ierr != nil {
			return fmt.Errorf("crediting bot play balance: %w", ierr)
		}

		// Re-read balance post-credit for return value.
		acct, aerr := s.userCore.QueryByID(ctx, accountID)
		if aerr != nil {
			return fmt.Errorf("querying bot account post-credit: %w", aerr)
		}
		newPlay = acct.BalancePlay
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
