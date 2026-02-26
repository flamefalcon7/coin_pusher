package userdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/flamefalcon/coin-pusher/backend/business/core/user"
	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
)

// CreateNonce inserts a new auth nonce.
func (s *Store) CreateNonce(ctx context.Context, nonce, address string, expiresAt time.Time) error {
	const q = `
		INSERT INTO auth_nonces (nonce, address, expires_at)
		VALUES ($1, $2, $3)`

	if _, err := s.db.ExecContext(ctx, q, nonce, address, expiresAt); err != nil {
		return fmt.Errorf("inserting nonce: %w", err)
	}

	return nil
}

// ConsumeNonce atomically deletes and returns a nonce. Returns ErrNotFound if
// the nonce does not exist or has expired.
func (s *Store) ConsumeNonce(ctx context.Context, nonce string) (user.NonceRecord, error) {
	const q = `
		DELETE FROM auth_nonces
		WHERE nonce = $1 AND expires_at > NOW()
		RETURNING nonce, address, expires_at, created_at`

	var rec user.NonceRecord
	if err := s.db.QueryRowContext(ctx, q, nonce).Scan(
		&rec.Nonce, &rec.Address, &rec.ExpiresAt, &rec.CreatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return user.NonceRecord{}, v1.NewRequestError(v1.ErrNotFound, 401)
		}
		return user.NonceRecord{}, fmt.Errorf("consuming nonce: %w", err)
	}

	return rec, nil
}

// PurgeExpiredNonces removes all expired nonces and returns the count deleted.
func (s *Store) PurgeExpiredNonces(ctx context.Context) (int64, error) {
	const q = `DELETE FROM auth_nonces WHERE expires_at <= NOW()`

	result, err := s.db.ExecContext(ctx, q)
	if err != nil {
		return 0, fmt.Errorf("purging expired nonces: %w", err)
	}

	return result.RowsAffected()
}
