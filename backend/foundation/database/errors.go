package database

import (
	"errors"

	"github.com/lib/pq"
)

// IsUniqueViolation returns true if the error is a PostgreSQL unique
// constraint violation (error code 23505).
func IsUniqueViolation(err error) bool {
	var pgErr *pq.Error
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
