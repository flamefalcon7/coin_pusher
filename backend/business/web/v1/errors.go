package v1

import (
	"errors"
	"fmt"
)

// RequestError is used to pass an error during the request through the
// application with web-specific context.
type RequestError struct {
	Err    error
	Status int
}

// NewRequestError wraps a provided error with an HTTP status code.
func NewRequestError(err error, status int) error {
	return &RequestError{Err: err, Status: status}
}

// Error implements the error interface.
func (re *RequestError) Error() string {
	return re.Err.Error()
}

// Unwrap returns the wrapped error for errors.Is/As support.
func (re *RequestError) Unwrap() error {
	return re.Err
}

// ErrorResponse is the form used for API responses from failures.
type ErrorResponse struct {
	Error string `json:"error"`
}

// Sentinel errors used across the application.
var (
	ErrNotFound         = errors.New("not found")
	ErrAuthFailed       = errors.New("authentication failed")
	ErrForbidden        = errors.New("forbidden")
	ErrInsufficientFund = errors.New("insufficient balance")
)

// NewNotFoundError creates a not-found RequestError.
func NewNotFoundError() error {
	return NewRequestError(ErrNotFound, 404)
}

// NewAuthError creates an auth-failed RequestError.
func NewAuthError() error {
	return NewRequestError(ErrAuthFailed, 401)
}

// NewForbiddenError creates a forbidden RequestError.
func NewForbiddenError() error {
	return NewRequestError(ErrForbidden, 403)
}

// NewInsufficientFundError creates an insufficient-fund RequestError.
func NewInsufficientFundError(currency string, required, available fmt.Stringer) error {
	return NewRequestError(
		fmt.Errorf("%w: need %s %s, have %s", ErrInsufficientFund, required, currency, available),
		402,
	)
}
