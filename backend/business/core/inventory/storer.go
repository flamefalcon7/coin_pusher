package inventory

import (
	"context"

	"github.com/google/uuid"
)

// DevDefaults holds initial inventory values for dev/test mode.
type DevDefaults struct {
	KeyCoins        int
	ScrollShock     int
	ScrollTornado   int
	ScrollExplosion int
	ScrollLightning int
	ScrollSuperPush int
	Megaspeaker     int
}

// Storer interface declares the core database operations for inventory.
type Storer interface {
	EnsureInventory(ctx context.Context, accountID uuid.UUID, devDefaults *DevDefaults) error
	CreditKeyCoins(ctx context.Context, accountID uuid.UUID, count int) error
	GetInventory(ctx context.Context, accountID uuid.UUID) (Inventory, error)
	DecrementKeyCoins(ctx context.Context, accountID uuid.UUID) error
	IncrementScroll(ctx context.Context, accountID uuid.UUID, scrollType string) error
	DecrementScroll(ctx context.Context, accountID uuid.UUID, scrollType string) error
	IncrementMegaspeaker(ctx context.Context, accountID uuid.UUID) error
	DecrementMegaspeaker(ctx context.Context, accountID uuid.UUID) error
	CreateChestOpen(ctx context.Context, co ChestOpen) error
}
