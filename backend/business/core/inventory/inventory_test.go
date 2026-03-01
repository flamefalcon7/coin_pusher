package inventory

import (
	"context"
	"fmt"
	"math"
	"testing"

	"github.com/google/uuid"
)

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

type mockStorer struct {
	ensureInventoryFn      func(ctx context.Context, accountID uuid.UUID, dd *DevDefaults) error
	creditKeyCoinsFn       func(ctx context.Context, accountID uuid.UUID, count int) error
	getInventoryFn         func(ctx context.Context, accountID uuid.UUID) (Inventory, error)
	decrementKeyCoinsFn    func(ctx context.Context, accountID uuid.UUID) error
	incrementScrollFn      func(ctx context.Context, accountID uuid.UUID, scrollType string) error
	decrementScrollFn      func(ctx context.Context, accountID uuid.UUID, scrollType string) error
	incrementMegaspeakerFn func(ctx context.Context, accountID uuid.UUID) error
	decrementMegaspeakerFn func(ctx context.Context, accountID uuid.UUID) error
	createChestOpenFn      func(ctx context.Context, co ChestOpen) error
}

func (m *mockStorer) EnsureInventory(ctx context.Context, accountID uuid.UUID, dd *DevDefaults) error {
	if m.ensureInventoryFn != nil {
		return m.ensureInventoryFn(ctx, accountID, dd)
	}
	return nil
}
func (m *mockStorer) CreditKeyCoins(ctx context.Context, accountID uuid.UUID, count int) error {
	if m.creditKeyCoinsFn != nil {
		return m.creditKeyCoinsFn(ctx, accountID, count)
	}
	return nil
}
func (m *mockStorer) GetInventory(ctx context.Context, accountID uuid.UUID) (Inventory, error) {
	if m.getInventoryFn != nil {
		return m.getInventoryFn(ctx, accountID)
	}
	return Inventory{}, nil
}
func (m *mockStorer) DecrementKeyCoins(ctx context.Context, accountID uuid.UUID) error {
	if m.decrementKeyCoinsFn != nil {
		return m.decrementKeyCoinsFn(ctx, accountID)
	}
	return nil
}
func (m *mockStorer) IncrementScroll(ctx context.Context, accountID uuid.UUID, scrollType string) error {
	if m.incrementScrollFn != nil {
		return m.incrementScrollFn(ctx, accountID, scrollType)
	}
	return nil
}
func (m *mockStorer) DecrementScroll(ctx context.Context, accountID uuid.UUID, scrollType string) error {
	if m.decrementScrollFn != nil {
		return m.decrementScrollFn(ctx, accountID, scrollType)
	}
	return nil
}
func (m *mockStorer) IncrementMegaspeaker(ctx context.Context, accountID uuid.UUID) error {
	if m.incrementMegaspeakerFn != nil {
		return m.incrementMegaspeakerFn(ctx, accountID)
	}
	return nil
}
func (m *mockStorer) DecrementMegaspeaker(ctx context.Context, accountID uuid.UUID) error {
	if m.decrementMegaspeakerFn != nil {
		return m.decrementMegaspeakerFn(ctx, accountID)
	}
	return nil
}
func (m *mockStorer) CreateChestOpen(ctx context.Context, co ChestOpen) error {
	if m.createChestOpenFn != nil {
		return m.createChestOpenFn(ctx, co)
	}
	return nil
}

// ---------------------------------------------------------------------------
// ConsumeMegaspeaker
// ---------------------------------------------------------------------------

func TestConsumeMegaspeaker_Success(t *testing.T) {
	t.Parallel()

	ms := &mockStorer{}
	core := NewCore(nil, ms, nil)

	err := core.ConsumeMegaspeaker(context.Background(), uuid.New())
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
}

func TestConsumeMegaspeaker_NoCharge(t *testing.T) {
	t.Parallel()

	ms := &mockStorer{
		decrementMegaspeakerFn: func(_ context.Context, _ uuid.UUID) error {
			return fmt.Errorf("no megaspeaker charges")
		},
	}
	core := NewCore(nil, ms, nil)

	err := core.ConsumeMegaspeaker(context.Background(), uuid.New())
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

// ---------------------------------------------------------------------------
// ScrollWeights
// ---------------------------------------------------------------------------

func TestScrollWeights_TotalWeight(t *testing.T) {
	t.Parallel()

	if TotalWeight != 115 {
		t.Errorf("TotalWeight = %d, want 115", TotalWeight)
	}
}

func TestScrollWeights_IncludesMegaspeaker(t *testing.T) {
	t.Parallel()

	found := false
	for _, sw := range ScrollWeights {
		if sw.Type == ItemMegaspeaker {
			found = true
			if sw.Weight != 15 {
				t.Errorf("megaspeaker weight = %d, want 15", sw.Weight)
			}
			break
		}
	}
	if !found {
		t.Fatal("megaspeaker not found in ScrollWeights")
	}
}

// ---------------------------------------------------------------------------
// rollScrollType distribution
// ---------------------------------------------------------------------------

func TestRollScrollType_Distribution(t *testing.T) {
	t.Parallel()

	const trials = 10000
	counts := make(map[string]int)

	for i := 0; i < trials; i++ {
		st, err := rollScrollType()
		if err != nil {
			t.Fatalf("rollScrollType error on iteration %d: %v", i, err)
		}
		counts[st]++
	}

	// Verify megaspeaker appears roughly 15/115 ≈ 13.04% of the time (±5%).
	megaCount := counts[ItemMegaspeaker]
	megaPct := float64(megaCount) / float64(trials) * 100
	expected := float64(15) / float64(TotalWeight) * 100

	if math.Abs(megaPct-expected) > 5 {
		t.Errorf("megaspeaker distribution = %.1f%%, expected ~%.1f%% (±5%%)", megaPct, expected)
	}

	// Every scroll type should appear at least once.
	for _, sw := range ScrollWeights {
		if counts[sw.Type] == 0 {
			t.Errorf("scroll type %q never appeared in %d trials", sw.Type, trials)
		}
	}
}
