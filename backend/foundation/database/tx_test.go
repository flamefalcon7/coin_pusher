package database

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/jmoiron/sqlx"
)

func TestExecTx_Commit(t *testing.T) {
	t.Parallel()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	sdb := sqlx.NewDb(db, "sqlmock")

	mock.ExpectBegin()
	mock.ExpectCommit()

	called := false
	err = ExecTx(context.Background(), sdb, func(tx *sqlx.Tx) error {
		called = true
		if tx == nil {
			t.Error("expected non-nil tx")
		}
		return nil
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("fn was not called")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestExecTx_Rollback(t *testing.T) {
	t.Parallel()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	sdb := sqlx.NewDb(db, "sqlmock")

	mock.ExpectBegin()
	mock.ExpectRollback()

	fnErr := errors.New("something failed")
	err = ExecTx(context.Background(), sdb, func(tx *sqlx.Tx) error {
		return fnErr
	})

	if !errors.Is(err, fnErr) {
		t.Errorf("expected fnErr, got: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestExecTx_PanicRollback(t *testing.T) {
	t.Parallel()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	sdb := sqlx.NewDb(db, "sqlmock")

	mock.ExpectBegin()
	mock.ExpectRollback()

	defer func() {
		r := recover()
		if r == nil {
			t.Error("expected panic to propagate")
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Error(err)
		}
	}()

	_ = ExecTx(context.Background(), sdb, func(tx *sqlx.Tx) error {
		panic("boom")
	})
}

func TestDBTX_InterfaceSatisfaction(t *testing.T) {
	t.Parallel()

	// Compile-time checks are in tx.go, but verify at runtime that
	// a *sqlx.DB can be assigned to DBTX.
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	sdb := sqlx.NewDb(db, "sqlmock")

	var _ DBTX = sdb
}
