package userdb

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/shopspring/decimal"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

func newTestStore(t *testing.T) (*Store, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return NewStore(sqlx.NewDb(db, "sqlmock")), mock
}

// ---------------------------------------------------------------------------
// UpdateBalance: success paths
// ---------------------------------------------------------------------------

func TestUpdateBalance_Play_Success(t *testing.T) {
	t.Parallel()

	store, mock := newTestStore(t)
	accountID := uuid.New()

	mock.ExpectQuery(`UPDATE accounts SET balance_play`).
		WithArgs(accountID, decimal.NewFromInt(-5)).
		WillReturnRows(sqlmock.NewRows([]string{"balance_play"}).AddRow(decimal.NewFromInt(95)))

	bal, err := store.UpdateBalance(context.Background(), accountID, "PLAY", decimal.NewFromInt(-5))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bal.Equal(decimal.NewFromInt(95)) {
		t.Errorf("balance = %s, want 95", bal)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestUpdateBalance_USDC_Success(t *testing.T) {
	t.Parallel()

	store, mock := newTestStore(t)
	accountID := uuid.New()

	mock.ExpectQuery(`UPDATE accounts SET balance_usdc`).
		WithArgs(accountID, decimal.NewFromInt(10)).
		WillReturnRows(sqlmock.NewRows([]string{"balance_play"}).AddRow(decimal.NewFromInt(100)))

	bal, err := store.UpdateBalance(context.Background(), accountID, "USDC", decimal.NewFromInt(10))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bal.Equal(decimal.NewFromInt(100)) {
		t.Errorf("balance_play = %s, want 100", bal)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestUpdateBalance_Cash_Success(t *testing.T) {
	t.Parallel()

	store, mock := newTestStore(t)
	accountID := uuid.New()

	mock.ExpectQuery(`UPDATE accounts SET balance_cash`).
		WithArgs(accountID, decimal.NewFromInt(50)).
		WillReturnRows(sqlmock.NewRows([]string{"balance_play"}).AddRow(decimal.NewFromInt(200)))

	bal, err := store.UpdateBalance(context.Background(), accountID, "CASH", decimal.NewFromInt(50))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bal.Equal(decimal.NewFromInt(200)) {
		t.Errorf("balance_play = %s, want 200", bal)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// UpdateBalance: insufficient funds (account exists but WHERE fails)
// ---------------------------------------------------------------------------

func TestUpdateBalance_InsufficientFunds(t *testing.T) {
	t.Parallel()

	store, mock := newTestStore(t)
	accountID := uuid.New()

	// UPDATE returns no rows (balance check failed).
	mock.ExpectQuery(`UPDATE accounts SET balance_play`).
		WithArgs(accountID, decimal.NewFromInt(-999)).
		WillReturnRows(sqlmock.NewRows([]string{"balance_play"}))

	// EXISTS check returns true (account exists).
	mock.ExpectQuery(`SELECT EXISTS`).
		WithArgs(accountID).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

	_, err := store.UpdateBalance(context.Background(), accountID, "PLAY", decimal.NewFromInt(-999))
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, v1.ErrInsufficientFund) {
		t.Errorf("expected ErrInsufficientFund, got: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// UpdateBalance: account not found
// ---------------------------------------------------------------------------

func TestUpdateBalance_NotFound(t *testing.T) {
	t.Parallel()

	store, mock := newTestStore(t)
	accountID := uuid.New()

	// UPDATE returns no rows.
	mock.ExpectQuery(`UPDATE accounts SET balance_play`).
		WithArgs(accountID, decimal.NewFromInt(-5)).
		WillReturnRows(sqlmock.NewRows([]string{"balance_play"}))

	// EXISTS check returns false.
	mock.ExpectQuery(`SELECT EXISTS`).
		WithArgs(accountID).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))

	_, err := store.UpdateBalance(context.Background(), accountID, "PLAY", decimal.NewFromInt(-5))
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, v1.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

// ---------------------------------------------------------------------------
// UpdateBalance: unknown currency
// ---------------------------------------------------------------------------

func TestUpdateBalance_UnknownCurrency(t *testing.T) {
	t.Parallel()

	store, _ := newTestStore(t)
	accountID := uuid.New()

	_, err := store.UpdateBalance(context.Background(), accountID, "DOGE", decimal.NewFromInt(1))
	if err == nil {
		t.Fatal("expected error for unknown currency")
	}
	if !strings.Contains(err.Error(), "unknown currency") {
		t.Errorf("error = %v, want 'unknown currency'", err)
	}
}
