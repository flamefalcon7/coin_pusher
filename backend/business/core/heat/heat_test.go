package heat

import (
	"math"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestAddHeat(t *testing.T) {
	t.Parallel()

	h := New()
	uid := uuid.New()

	h.AddHeat(uid, 10)

	h.mu.RLock()
	ph := h.players[uid]
	h.mu.RUnlock()

	if ph == nil {
		t.Fatal("expected player heat entry")
	}
	if ph.RawHeat != 10 {
		t.Errorf("RawHeat = %f, want 10", ph.RawHeat)
	}

	// Add more heat.
	h.AddHeat(uid, 5)

	h.mu.RLock()
	raw := h.players[uid].RawHeat
	h.mu.RUnlock()

	// Should be close to 15 (slight decay for near-zero dt).
	if raw < 14.9 || raw > 15.1 {
		t.Errorf("RawHeat after second add = %f, want ~15", raw)
	}
}

func TestDecay(t *testing.T) {
	t.Parallel()

	h := New()
	uid := uuid.New()

	// Manually set heat with a past timestamp to test decay.
	h.mu.Lock()
	h.players[uid] = &PlayerHeat{
		RawHeat:     100,
		LastUpdated: time.Now().Add(-180 * time.Second), // one half-life ago
	}
	h.mu.Unlock()

	shares := h.GetShares()
	if len(shares) != 1 {
		t.Fatalf("expected 1 active player, got %d", len(shares))
	}

	// After 180s (one half-life), decayed heat should be ~50.
	decayed := shares[0].RawHeat
	if math.Abs(decayed-50) > 1 {
		t.Errorf("decayed heat = %f, want ~50", decayed)
	}
}

func TestShares_SinglePlayer(t *testing.T) {
	t.Parallel()

	h := New()
	uid := uuid.New()
	h.AddHeat(uid, 100)

	shares := h.GetShares()
	if len(shares) != 1 {
		t.Fatalf("expected 1 share, got %d", len(shares))
	}
	if shares[0].Share != 1.0 {
		t.Errorf("single player share = %f, want 1.0", shares[0].Share)
	}
}

func TestShares_EqualPlayers(t *testing.T) {
	t.Parallel()

	h := New()
	u1 := uuid.New()
	u2 := uuid.New()

	h.AddHeat(u1, 100)
	h.AddHeat(u2, 100)

	shares := h.GetShares()
	if len(shares) != 2 {
		t.Fatalf("expected 2 shares, got %d", len(shares))
	}

	for _, s := range shares {
		if math.Abs(s.Share-0.5) > 0.01 {
			t.Errorf("player %s share = %f, want ~0.5", s.UserID, s.Share)
		}
	}
}

func TestShares_Whale(t *testing.T) {
	t.Parallel()

	h := New()
	whale := uuid.New()
	small := uuid.New()

	h.AddHeat(whale, 10000)
	h.AddHeat(small, 1)

	shares := h.GetShares()
	if len(shares) != 2 {
		t.Fatalf("expected 2 shares, got %d", len(shares))
	}

	var whaleShare, smallShare float64
	for _, s := range shares {
		if s.UserID == whale {
			whaleShare = s.Share
		} else {
			smallShare = s.Share
		}
	}

	// Whale should get more.
	if whaleShare <= smallShare {
		t.Errorf("whale share (%f) should be > small share (%f)", whaleShare, smallShare)
	}

	// Small player should get at least the guaranteed minimum.
	if smallShare < h.guaranteed {
		t.Errorf("small player share = %f, want >= guaranteed %f", smallShare, h.guaranteed)
	}
}

func TestShares_ManyPlayers_SmoothGuaranteed(t *testing.T) {
	t.Parallel()

	h := New()
	ids := make([]uuid.UUID, 25)
	for i := range ids {
		ids[i] = uuid.New()
		h.AddHeat(ids[i], 100) // equal heat
	}

	shares := h.GetShares()
	if len(shares) != 25 {
		t.Fatalf("expected 25 shares, got %d", len(shares))
	}

	// With 25 equal players: guaranteed = min(0.05, 1/(2*25)) = 0.02
	// guaranteedTotal = 0.50, competitive pool = 0.50
	// Equal heat → equal competitive → each gets 0.02 + 0.50/25 = 0.04.
	expected := 1.0 / 25.0
	for _, s := range shares {
		if math.Abs(s.Share-expected) > 0.001 {
			t.Errorf("player %s share = %f, want %f", s.UserID, s.Share, expected)
		}
	}

	// Verify competitive pool is still meaningful (not near zero).
	// n=25 → guaranteed=0.02, total guaranteed=0.50, pool=0.50.
	n := float64(len(shares))
	guaranteed := math.Min(0.05, 1.0/(2.0*n))
	pool := 1.0 - n*guaranteed
	if pool < 0.49 {
		t.Errorf("competitive pool = %f, want >= 0.50", pool)
	}
}

func TestDistributeFrontEdgeDrop(t *testing.T) {
	t.Parallel()

	h := New()
	u1 := uuid.New()
	u2 := uuid.New()

	h.AddHeat(u1, 100)
	h.AddHeat(u2, 100)

	dist := h.DistributeFrontEdgeDrop(10)
	if dist == nil {
		t.Fatal("expected non-nil distribution")
	}
	if len(dist) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(dist))
	}

	total := dist[u1] + dist[u2]
	if math.Abs(total-10.0) > 0.01 {
		t.Errorf("total distributed = %f, want 10.0", total)
	}

	// Equal heat -> equal distribution.
	if math.Abs(dist[u1]-5.0) > 0.1 {
		t.Errorf("u1 got %f, want ~5.0", dist[u1])
	}
}

func TestDistributeFrontEdgeDrop_NoPlayers(t *testing.T) {
	t.Parallel()

	h := New()
	dist := h.DistributeFrontEdgeDrop(10)
	if dist != nil {
		t.Errorf("expected nil distribution with no players, got %v", dist)
	}
}

func TestPrune(t *testing.T) {
	t.Parallel()

	h := New()
	uid := uuid.New()

	// Set heat far in the past so it decays to negligible.
	h.mu.Lock()
	h.players[uid] = &PlayerHeat{
		RawHeat:     1.0,
		LastUpdated: time.Now().Add(-3600 * time.Second), // 1 hour ago
	}
	h.mu.Unlock()

	h.Prune()

	h.mu.RLock()
	_, exists := h.players[uid]
	h.mu.RUnlock()

	if exists {
		t.Error("expected player to be pruned")
	}
}

func TestPrune_KeepsActive(t *testing.T) {
	t.Parallel()

	h := New()
	uid := uuid.New()
	h.AddHeat(uid, 100)

	h.Prune()

	h.mu.RLock()
	_, exists := h.players[uid]
	h.mu.RUnlock()

	if !exists {
		t.Error("expected active player to be kept")
	}
}

func TestGetShareForUser(t *testing.T) {
	t.Parallel()

	h := New()
	u1 := uuid.New()
	u2 := uuid.New()

	h.AddHeat(u1, 100)
	h.AddHeat(u2, 100)

	share := h.GetShareForUser(u1)
	if math.Abs(share-0.5) > 0.01 {
		t.Errorf("share for u1 = %f, want ~0.5", share)
	}

	// Unknown user.
	unknown := uuid.New()
	share = h.GetShareForUser(unknown)
	if share != 0 {
		t.Errorf("share for unknown = %f, want 0", share)
	}
}
