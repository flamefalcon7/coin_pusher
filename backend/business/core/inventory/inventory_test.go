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
	decrementKeyCoinsFn    func(ctx context.Context, accountID uuid.UUID, count int) error
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
func (m *mockStorer) DecrementKeyCoins(ctx context.Context, accountID uuid.UUID, count int) error {
	if m.decrementKeyCoinsFn != nil {
		return m.decrementKeyCoinsFn(ctx, accountID, count)
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
func (m *mockStorer) CreditPlayBalance(_ context.Context, _ uuid.UUID, _ int) (string, error) {
	return "100", nil
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

	if TotalWeight != 150 {
		t.Errorf("TotalWeight = %d, want 150", TotalWeight)
	}
}

func TestScrollWeights_IncludesMegaspeaker(t *testing.T) {
	t.Parallel()

	found := false
	for _, sw := range ScrollWeights {
		if sw.Type == ItemMegaspeaker {
			found = true
			if sw.Weight != 30 {
				t.Errorf("megaspeaker weight = %d, want 30", sw.Weight)
			}
			break
		}
	}
	if !found {
		t.Fatal("megaspeaker not found in ScrollWeights")
	}
}

func TestScrollWeights_IncludesPlayCoins(t *testing.T) {
	t.Parallel()

	found := false
	for _, sw := range ScrollWeights {
		if sw.Type == ItemPlayCoins {
			found = true
			if sw.Weight != 20 {
				t.Errorf("play_coins weight = %d, want 20", sw.Weight)
			}
			break
		}
	}
	if !found {
		t.Fatal("play_coins not found in ScrollWeights")
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

	// Verify each type appears roughly at its expected rate (±5%).
	for _, sw := range ScrollWeights {
		pct := float64(counts[sw.Type]) / float64(trials) * 100
		expected := float64(sw.Weight) / float64(TotalWeight) * 100
		if math.Abs(pct-expected) > 5 {
			t.Errorf("%s distribution = %.1f%%, expected ~%.1f%% (±5%%)", sw.Type, pct, expected)
		}
	}

	// Every scroll type should appear at least once.
	for _, sw := range ScrollWeights {
		if counts[sw.Type] == 0 {
			t.Errorf("scroll type %q never appeared in %d trials", sw.Type, trials)
		}
	}
}

func TestRollPlayCoinsAmount_Range(t *testing.T) {
	t.Parallel()

	const trials = 10000
	for i := 0; i < trials; i++ {
		amt, err := rollPlayCoinsAmount()
		if err != nil {
			t.Fatalf("rollPlayCoinsAmount error on iteration %d: %v", i, err)
		}
		if amt < 10 || amt > 100 {
			t.Fatalf("play coins amount %d out of range [10, 100]", amt)
		}
	}
}

func TestRollPlayCoinsAmount_Distribution(t *testing.T) {
	t.Parallel()

	const trials = 100000
	tiers := [4]int{} // 0: 10-20, 1: 21-50, 2: 51-80, 3: 100

	for i := 0; i < trials; i++ {
		amt, err := rollPlayCoinsAmount()
		if err != nil {
			t.Fatalf("iteration %d: %v", i, err)
		}
		switch {
		case amt >= 10 && amt <= 20:
			tiers[0]++
		case amt >= 21 && amt <= 50:
			tiers[1]++
		case amt >= 51 && amt <= 80:
			tiers[2]++
		case amt == 100:
			tiers[3]++
		default:
			t.Fatalf("unexpected amount %d", amt)
		}
	}

	// Expected: 80%, 15%, 4.9%, 0.1% — allow ±2% tolerance.
	expectations := []struct {
		name     string
		expected float64
		tol      float64
	}{
		{"10-20", 80.0, 2.0},
		{"21-50", 15.0, 2.0},
		{"51-80", 4.9, 2.0},
		{"100", 0.1, 0.5},
	}
	for i, exp := range expectations {
		pct := float64(tiers[i]) / float64(trials) * 100
		if math.Abs(pct-exp.expected) > exp.tol {
			t.Errorf("tier %s: got %.2f%%, expected ~%.1f%% (±%.1f%%)", exp.name, pct, exp.expected, exp.tol)
		}
	}
}
