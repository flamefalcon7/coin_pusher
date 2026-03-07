package inventory

import (
	"context"
	"fmt"
	"math"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"github.com/flamefalcon/coin-pusher/backend/business/core/accounting"
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
func (m *mockStorer) CreditPlayBalance(_ context.Context, _ uuid.UUID, amount int) (string, error) {
	return fmt.Sprintf("%d", 100+amount), nil
}

// ---------------------------------------------------------------------------
// Mock accounting storer
// ---------------------------------------------------------------------------

type mockAcctStorer struct {
	mu      sync.Mutex
	created []accounting.AccountingLog
}

func (m *mockAcctStorer) Create(_ context.Context, log accounting.AccountingLog) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.created = append(m.created, log)
	return nil
}

func (m *mockAcctStorer) QueryByAccountID(_ context.Context, _ uuid.UUID, _, _ int) ([]accounting.AccountingLog, error) {
	return nil, nil
}

func (m *mockAcctStorer) QueryByReference(_ context.Context, _, _ string) (accounting.AccountingLog, error) {
	return accounting.AccountingLog{}, nil
}

// ---------------------------------------------------------------------------
// ConsumeMegaspeaker
// ---------------------------------------------------------------------------

func TestConsumeMegaspeaker_Success(t *testing.T) {
	t.Parallel()

	ms := &mockStorer{}
	core := NewCore(nil, ms, nil, nil)

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
	core := NewCore(nil, ms, nil, nil)

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

// ---------------------------------------------------------------------------
// OpenChest
// ---------------------------------------------------------------------------

func TestOpenChest_PlayCoins_WritesAccountingLog(t *testing.T) {
	t.Parallel()

	// Run OpenChest many times until we hit a play_coins result.
	// play_coins has 20/150 ≈ 13.3% chance, so we'll almost certainly hit it.
	ms := &mockStorer{}
	acctMs := &mockAcctStorer{}
	core := NewCore(nil, ms, nil, nil)
	core.SetAcctStorer(acctMs)

	accountID := uuid.New()
	var gotPlayCoins bool

	for i := 0; i < 200; i++ {
		result, err := core.OpenChest(context.Background(), accountID)
		if err != nil {
			t.Fatalf("OpenChest error on iteration %d: %v", i, err)
		}
		if result.ScrollType == ItemPlayCoins {
			gotPlayCoins = true
			break
		}
	}

	if !gotPlayCoins {
		t.Fatal("never rolled play_coins in 200 attempts")
	}

	acctMs.mu.Lock()
	defer acctMs.mu.Unlock()

	if len(acctMs.created) != 1 {
		t.Fatalf("expected 1 accounting log, got %d", len(acctMs.created))
	}

	log := acctMs.created[0]
	if log.ActionType != accounting.ActionChestReward {
		t.Errorf("action_type = %q, want %q", log.ActionType, accounting.ActionChestReward)
	}
	if log.Currency != accounting.CurrencyPlay {
		t.Errorf("currency = %q, want %q", log.Currency, accounting.CurrencyPlay)
	}
	if log.AccountID != accountID {
		t.Errorf("account_id = %s, want %s", log.AccountID, accountID)
	}
	if log.Amount.LessThanOrEqual(decimal.Zero) {
		t.Errorf("amount = %s, want > 0", log.Amount)
	}
	if log.ReferenceID == "" {
		t.Error("reference_id is empty, want chest open_id")
	}
}

func TestOpenChest_NonPlayCoins_NoAccountingLog(t *testing.T) {
	t.Parallel()

	ms := &mockStorer{}
	acctMs := &mockAcctStorer{}
	core := NewCore(nil, ms, nil, nil)
	core.SetAcctStorer(acctMs)

	accountID := uuid.New()
	var gotNonPlayCoins bool

	for i := 0; i < 200; i++ {
		// Snapshot count before this call.
		acctMs.mu.Lock()
		countBefore := len(acctMs.created)
		acctMs.mu.Unlock()

		result, err := core.OpenChest(context.Background(), accountID)
		if err != nil {
			t.Fatalf("OpenChest error on iteration %d: %v", i, err)
		}
		if result.ScrollType != ItemPlayCoins {
			gotNonPlayCoins = true

			// No new accounting log should have been created for this call.
			acctMs.mu.Lock()
			countAfter := len(acctMs.created)
			acctMs.mu.Unlock()

			if countAfter != countBefore {
				t.Errorf("non-play_coins open created %d accounting logs, want 0", countAfter-countBefore)
			}
			break
		}
	}

	if !gotNonPlayCoins {
		t.Fatal("never rolled a non-play_coins type in 200 attempts")
	}
}

func TestOpenChest_PlayCoins_AmountInRange(t *testing.T) {
	t.Parallel()

	ms := &mockStorer{}
	acctMs := &mockAcctStorer{}
	core := NewCore(nil, ms, nil, nil)
	core.SetAcctStorer(acctMs)

	accountID := uuid.New()

	for i := 0; i < 500; i++ {
		result, err := core.OpenChest(context.Background(), accountID)
		if err != nil {
			t.Fatalf("OpenChest error on iteration %d: %v", i, err)
		}
		if result.ScrollType == ItemPlayCoins {
			if result.ScrollCount < 10 || result.ScrollCount > 100 {
				t.Fatalf("play_coins scroll_count = %d, want [10, 100]", result.ScrollCount)
			}
		}
	}

	// Verify all accounting logs have amounts in valid range.
	acctMs.mu.Lock()
	defer acctMs.mu.Unlock()

	for _, log := range acctMs.created {
		amt := log.Amount.IntPart()
		if amt < 10 || amt > 100 {
			t.Errorf("accounting log amount = %d, want [10, 100]", amt)
		}
	}
}

func TestOpenChest_ChestOpenLog_MatchesAccountingRef(t *testing.T) {
	t.Parallel()

	var chestOpens []ChestOpen
	ms := &mockStorer{
		createChestOpenFn: func(_ context.Context, co ChestOpen) error {
			chestOpens = append(chestOpens, co)
			return nil
		},
	}
	acctMs := &mockAcctStorer{}
	core := NewCore(nil, ms, nil, nil)
	core.SetAcctStorer(acctMs)

	accountID := uuid.New()

	for i := 0; i < 200; i++ {
		result, err := core.OpenChest(context.Background(), accountID)
		if err != nil {
			t.Fatalf("OpenChest error on iteration %d: %v", i, err)
		}
		if result.ScrollType == ItemPlayCoins {
			break
		}
	}

	acctMs.mu.Lock()
	defer acctMs.mu.Unlock()

	if len(acctMs.created) == 0 {
		t.Fatal("no accounting logs created; never hit play_coins")
	}

	// Find the chest_open whose scroll_type is play_coins.
	var matchingOpen *ChestOpen
	for i := range chestOpens {
		if chestOpens[i].ScrollType == ItemPlayCoins {
			matchingOpen = &chestOpens[i]
			break
		}
	}
	if matchingOpen == nil {
		t.Fatal("no chest_open with play_coins found")
	}

	log := acctMs.created[0]
	if log.ReferenceID != matchingOpen.OpenID.String() {
		t.Errorf("accounting reference_id = %q, want chest open_id = %q", log.ReferenceID, matchingOpen.OpenID.String())
	}
}
