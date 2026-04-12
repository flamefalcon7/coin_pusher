// Package game provides game event processing logic.
package game

import "github.com/google/uuid"

// Event types from the game server.
const (
	EventInsertCoin = "INSERT_COIN"
	EventSpawnStack = "SPAWN_STACK"
)

// Stack types and their coin costs.
var StackCoinCosts = map[string]int{
	"wall":     72,
	"tower":    10,
	"pyramid":  300,
	"cylinder": 80,
}

// GameEvent represents an event from the game server.
type GameEvent struct {
	UserID         uuid.UUID `json:"user_id"`
	Type           string    `json:"type"`
	CoinCount      int       `json:"coin_count,omitempty"`
	StackType      string    `json:"stack_type,omitempty"`
	IdempotencyKey string    `json:"idempotency_key,omitempty"`
}

// GameEventResult is the response sent back to the game server.
//
// On a successful coin insert, PlayDebited + CashDebited reflect the play-first
// split actually applied to the account. The caller retains these so a refund
// (on NATS publish failure, etc.) can reverse the exact split.
type GameEventResult struct {
	Success     bool   `json:"success"`
	BalancePlay string `json:"balance_play,omitempty"`
	BalanceCash string `json:"balance_cash,omitempty"`
	PlayDebited string `json:"play_debited,omitempty"`
	CashDebited string `json:"cash_debited,omitempty"`
	Error       string `json:"error,omitempty"`
}
