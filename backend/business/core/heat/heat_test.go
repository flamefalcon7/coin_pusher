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

	// Opt out of activity decay: this test's intent is the equal-input
	// equal-share invariant. Combo's default activity decay decays the
	// first-inserter's heat when the second player inserts (order matters
	// with activity decay), making "equal heat" an order-sensitive notion.
	// Activity decay is independently covered by TestActivityDecay_*.
	h := New(WithCoinHalfLife(0))
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
	h.AddHeat(small, 10) // at/above floorActivityThreshold: full floor

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

	// Small player at/above activity threshold gets full guaranteed floor.
	if smallShare < h.guaranteed {
		t.Errorf("small player share = %f, want >= guaranteed %f", smallShare, h.guaranteed)
	}
}

// TestShares_FloorScalesWithActivity verifies that the guaranteed floor is
// activity-gated by decayed heat when the floor is enabled. The production
// default is floor=0 (heatsim showed any non-zero floor opens a heartbeat
// exploit), so this test opts in via WithGuaranteed.
func TestShares_FloorScalesWithActivity(t *testing.T) {
	t.Parallel()

	h := New(WithGuaranteed(0.05))
	active := uuid.New()
	afk := uuid.New()

	h.AddHeat(active, 100) // well above threshold → full floor
	h.AddHeat(afk, 1)      // 1/10 of threshold → 10% of floor

	shares := h.GetShares()
	var activeShare, afkShare float64
	for _, s := range shares {
		if s.UserID == active {
			activeShare = s.Share
		} else {
			afkShare = s.Share
		}
	}

	// Active player's floor component is full 0.05.
	// AFK player's floor component is 0.05 * (1/10) = 0.005.
	// Competitive pool = 1 - 0.05 - 0.005 = 0.945, split by eff ratio.
	// AFK's total share must be well below a passive 0.05.
	if afkShare >= h.guaranteed {
		t.Errorf("AFK player share = %f, must be < full guaranteed floor %f", afkShare, h.guaranteed)
	}
	if activeShare <= afkShare {
		t.Errorf("active (%f) should beat AFK (%f)", activeShare, afkShare)
	}
}

// TestShares_FloorZeroWhenHeatBarelyAboveNoise verifies that a real player
// with near-prune-threshold heat (e.g., last coin inserted 30+ minutes ago)
// receives a vanishingly small floor, effectively 0. Uses opt-in floor.
func TestShares_FloorZeroWhenHeatBarelyAboveNoise(t *testing.T) {
	t.Parallel()

	h := New(WithGuaranteed(0.05))
	active := uuid.New()
	ghost := uuid.New()

	// Active player with heat = 100 (full floor).
	h.AddHeat(active, 100)
	// Ghost: 1 coin inserted, then decayed down near the prune floor of 0.01.
	// Simulate by directly setting RawHeat to 0.02 (just above prune, far
	// below activity threshold of 10).
	h.AddHeat(ghost, 1)
	h.mu.Lock()
	h.players[ghost].RawHeat = 0.02
	h.mu.Unlock()

	shares := h.GetShares()
	for _, s := range shares {
		if s.UserID == ghost {
			// Ghost's floor = 0.05 * (0.02/10) = 0.0001. Total share must
			// be tiny — well under 1%.
			if s.Share >= 0.01 {
				t.Errorf("ghost share = %f, expected near-zero (<0.01)", s.Share)
			}
		}
	}
}

func TestShares_ManyPlayers_SmoothGuaranteed(t *testing.T) {
	t.Parallel()

	// Opt out of activity decay (equal-heat invariant test under floor opt-in).
	h := New(WithCoinHalfLife(0))
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

	// Equal-heat invariant test; opt out of activity decay (combo default)
	// to keep both inserts equal at evaluation time.
	h := New(WithCoinHalfLife(0))
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

	// Equal-heat invariant test; opt out of activity decay.
	h := New(WithCoinHalfLife(0))
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

func TestShares_OneRealOneBot(t *testing.T) {
	t.Parallel()

	// Opt-in floor + opt-out of combo defaults: this test verifies the
	// floor mechanic's bot/real distinction with specific share values
	// (0.525 / 0.475) computed under α=0.7 + no activity decay. Combo's
	// new defaults (α=0.95, coinHalfLife=30) shift those values, so we
	// pin the legacy constants here to keep the assertions meaningful.
	h := New(WithGuaranteed(0.05), WithAlpha(0.7), WithCoinHalfLife(0))
	real := uuid.New()
	bot := uuid.New()

	h.AddHeat(real, 100)
	h.AddHeatForBot(bot, 100)

	shares := h.GetShares()
	if len(shares) != 2 {
		t.Fatalf("expected 2 shares, got %d", len(shares))
	}

	var realShare, botShare float64
	for _, s := range shares {
		switch s.UserID {
		case real:
			realShare = s.Share
		case bot:
			botShare = s.Share
		}
	}

	// Formula: realCount=1, guaranteed=min(0.05, 1/2)=0.05, floorTotal=0.05.
	// competitivePool=0.95, equal heat → competitivePool * 0.5 = 0.475.
	// real: 0.05 + 0.475 = 0.525; bot: 0 + 0.475 = 0.475.
	if math.Abs(realShare-0.525) > 0.01 {
		t.Errorf("real share = %f, want 0.525", realShare)
	}
	if math.Abs(botShare-0.475) > 0.01 {
		t.Errorf("bot share = %f, want 0.475", botShare)
	}

	// Total must sum to 1.
	if math.Abs(realShare+botShare-1.0) > 0.001 {
		t.Errorf("shares sum = %f, want 1.0", realShare+botShare)
	}
}

func TestShares_TwoRealThreeBots(t *testing.T) {
	t.Parallel()

	// Floor-mechanic test pinned to legacy constants; see TestShares_OneRealOneBot.
	h := New(WithGuaranteed(0.05), WithAlpha(0.7), WithCoinHalfLife(0))
	reals := []uuid.UUID{uuid.New(), uuid.New()}
	bots := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}

	for _, u := range reals {
		h.AddHeat(u, 100)
	}
	for _, b := range bots {
		h.AddHeatForBot(b, 100)
	}

	shares := h.GetShares()
	if len(shares) != 5 {
		t.Fatalf("expected 5 shares, got %d", len(shares))
	}

	// realCount=2, guaranteed=min(0.05, 1/4)=0.05, floorTotal=0.10.
	// competitivePool=0.90, equal heat → each gets competitivePool/5 = 0.18.
	// real: 0.05 + 0.18 = 0.23. bot: 0.18.
	realSet := map[uuid.UUID]bool{reals[0]: true, reals[1]: true}
	var total float64
	for _, s := range shares {
		total += s.Share
		if realSet[s.UserID] {
			if math.Abs(s.Share-0.23) > 0.01 {
				t.Errorf("real %s share = %f, want 0.23", s.UserID, s.Share)
			}
		} else {
			if math.Abs(s.Share-0.18) > 0.01 {
				t.Errorf("bot %s share = %f, want 0.18", s.UserID, s.Share)
			}
		}
	}
	if math.Abs(total-1.0) > 0.001 {
		t.Errorf("total shares = %f, want 1.0", total)
	}
}

func TestShares_AllBotsNoReal(t *testing.T) {
	t.Parallel()

	// Equal-heat invariant test; opt out of activity decay.
	h := New(WithCoinHalfLife(0))
	b1 := uuid.New()
	b2 := uuid.New()

	h.AddHeatForBot(b1, 100)
	h.AddHeatForBot(b2, 100)

	shares := h.GetShares()
	if len(shares) != 2 {
		t.Fatalf("expected 2 shares, got %d", len(shares))
	}

	// realCount=0, floorTotal=0, competitivePool=1.0. Equal heat → each 0.5.
	for _, s := range shares {
		if math.Abs(s.Share-0.5) > 0.01 {
			t.Errorf("bot %s share = %f, want 0.5", s.UserID, s.Share)
		}
	}
}

func TestShares_BotDoesNotDiluteRealFloor(t *testing.T) {
	t.Parallel()

	// Floor-mechanic test pinned to legacy constants; see TestShares_OneRealOneBot.
	h := New(WithGuaranteed(0.05), WithAlpha(0.7), WithCoinHalfLife(0))
	real := uuid.New()
	h.AddHeat(real, 100)

	// Add 50 bots with equal heat.
	for i := 0; i < 50; i++ {
		h.AddHeatForBot(uuid.New(), 100)
	}

	// Real still gets guaranteed=0.05 floor (realCount=1, so no cap kick-in).
	share := h.GetShareForUser(real)
	if share < 0.05 {
		t.Errorf("real share = %f, must be >= guaranteed floor 0.05", share)
	}
}

func TestAddHeat_LastWriteWinsFlag(t *testing.T) {
	t.Parallel()

	h := New()
	uid := uuid.New()

	h.AddHeat(uid, 10)
	h.mu.RLock()
	isBotAfterReal := h.players[uid].IsBot
	h.mu.RUnlock()
	if isBotAfterReal {
		t.Errorf("after AddHeat, IsBot=%v, want false", isBotAfterReal)
	}

	h.AddHeatForBot(uid, 5)
	h.mu.RLock()
	isBotAfterBot := h.players[uid].IsBot
	h.mu.RUnlock()
	if !isBotAfterBot {
		t.Errorf("after AddHeatForBot, IsBot=%v, want true", isBotAfterBot)
	}

	// Reverse: AddHeat after AddHeatForBot flips back to false.
	h.AddHeat(uid, 5)
	h.mu.RLock()
	isBotAfterRealAgain := h.players[uid].IsBot
	h.mu.RUnlock()
	if isBotAfterRealAgain {
		t.Errorf("after AddHeat (flip back), IsBot=%v, want false", isBotAfterRealAgain)
	}
}

func TestAddHeatForBot_AfterPruneRestoresFlag(t *testing.T) {
	t.Parallel()

	// Floor-mechanic test pinned to legacy constants; see TestShares_OneRealOneBot.
	h := New(WithGuaranteed(0.05), WithAlpha(0.7), WithCoinHalfLife(0))
	bot := uuid.New()

	// Set bot heat to decay below threshold.
	h.mu.Lock()
	h.players[bot] = &PlayerHeat{
		RawHeat:     1.0,
		LastUpdated: time.Now().Add(-3600 * time.Second), // 1hr ago
		IsBot:       true,
	}
	h.mu.Unlock()

	h.Prune()

	// Bot entry should be removed.
	h.mu.RLock()
	_, exists := h.players[bot]
	h.mu.RUnlock()
	if exists {
		t.Fatal("bot entry should be pruned")
	}

	// Re-add via AddHeatForBot → fresh entry must also be IsBot=true.
	h.AddHeatForBot(bot, 100)

	// Now compute share with a real player also present: bot must NOT get floor.
	real := uuid.New()
	h.AddHeat(real, 100)

	botShare := h.GetShareForUser(bot)
	realShare := h.GetShareForUser(real)

	// Bot is IsBot=true post-prune, gets no floor. 1 real + 1 bot equal heat.
	// real: 0.525, bot: 0.475.
	if math.Abs(botShare-0.475) > 0.01 {
		t.Errorf("bot share after prune+re-add = %f, want 0.475", botShare)
	}
	if math.Abs(realShare-0.525) > 0.01 {
		t.Errorf("real share = %f, want 0.525", realShare)
	}
}

func TestDistributeFrontEdgeDrop_MixedRealAndBot(t *testing.T) {
	t.Parallel()

	// Floor-mechanic test pinned to legacy constants; see TestShares_OneRealOneBot.
	h := New(WithGuaranteed(0.05), WithAlpha(0.7), WithCoinHalfLife(0))
	real := uuid.New()
	bot := uuid.New()

	h.AddHeat(real, 100)
	h.AddHeatForBot(bot, 100)

	dist := h.DistributeFrontEdgeDrop(100)
	if len(dist) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(dist))
	}

	total := dist[real] + dist[bot]
	if math.Abs(total-100.0) > 0.1 {
		t.Errorf("total distributed = %f, want 100.0", total)
	}

	// Real gets ~52.5, bot ~47.5.
	if math.Abs(dist[real]-52.5) > 1 {
		t.Errorf("real got %f, want ~52.5", dist[real])
	}
	if math.Abs(dist[bot]-47.5) > 1 {
		t.Errorf("bot got %f, want ~47.5", dist[bot])
	}
}

// TestShares_NoFloorDefault locks in the role-symmetry contract: with
// guaranteed=0 (production default), the formula does not distinguish real
// from bot. Two players with equal effective heat get equal shares.
//
// Activity decay (combo default) makes order matter — the first inserter's
// heat decays when the second inserts — so we opt out of activity decay
// here to isolate the role-equality property. Activity decay is
// independently covered by TestActivityDecay_*.
func TestShares_NoFloorDefault(t *testing.T) {
	t.Parallel()

	h := New(WithCoinHalfLife(0))
	real := uuid.New()
	bot := uuid.New()

	h.AddHeat(real, 100)
	h.AddHeatForBot(bot, 100)

	shares := h.GetShares()
	if len(shares) != 2 {
		t.Fatalf("expected 2 shares, got %d", len(shares))
	}

	for _, s := range shares {
		if math.Abs(s.Share-0.5) > 0.001 {
			t.Errorf("%s share = %f, want 0.5 (no-floor default treats real and bot equally)", s.UserID, s.Share)
		}
	}

	// Single-real-player share via GetShareForUser must also be unaffected
	// by floor or role: 1 of 1 active = 1.0.
	h2 := New(WithCoinHalfLife(0))
	solo := uuid.New()
	h2.AddHeat(solo, 100)
	if got := h2.GetShareForUser(solo); math.Abs(got-1.0) > 0.001 {
		t.Errorf("solo real share = %f, want 1.0", got)
	}
}

// --- Activity-driven decay (WithCoinHalfLife) ---------------------------

// TestActivityDecay_OthersInsertsErodeOwnHeat verifies the core promise of
// activity-driven decay: when other players keep inserting, an idle player's
// heat decays by max(time, activity) — and with a small coin-half-life the
// activity term dominates within a short wall-clock window.
func TestActivityDecay_OthersInsertsErodeOwnHeat(t *testing.T) {
	t.Parallel()

	h := New(WithCoinHalfLife(30))
	a := uuid.New()
	b := uuid.New()

	h.AddHeat(a, 10)
	h.AddHeat(b, 10)

	// B inserts 100 more coins. A's heat must decay via activity by
	// (ln2/30)*100 ≈ 2.31 → exp(-2.31) ≈ 0.099, so A's decayed ≈ 0.99.
	// Time-only decay over the same near-zero dt would leave A near 10.
	h.AddHeat(b, 100)

	shares := h.GetShares()
	var decayedA float64
	for _, s := range shares {
		if s.UserID == a {
			decayedA = s.RawHeat
		}
	}

	if decayedA == 0 {
		t.Fatalf("A's heat fully pruned; expected non-zero but small")
	}
	if decayedA > 2.0 {
		t.Errorf("A decayed heat = %f, want < 2.0 (activity decay should kick in)", decayedA)
	}
	if decayedA < 0.5 {
		t.Errorf("A decayed heat = %f, want > 0.5 (not over-decayed past expected ~0.99)", decayedA)
	}
}

// TestActivityDecay_OwnInsertsDontSelfDecay verifies snapshot-after-increment:
// a player's own coin inserts MUST NOT decay their own heat. Without this,
// any continuous-investing player (heartbeat, constant-low) would self-cancel
// on each insert and eventually run out of heat to invest into.
func TestActivityDecay_OwnInsertsDontSelfDecay(t *testing.T) {
	t.Parallel()

	h := New(WithCoinHalfLife(30))
	a := uuid.New()

	h.AddHeat(a, 100)
	h.AddHeat(a, 100)
	h.AddHeat(a, 100)

	h.mu.RLock()
	raw := h.players[a].RawHeat
	h.mu.RUnlock()

	// Own three 100-coin inserts in fast succession should leave raw ≈ 300.
	// Time decay over near-zero dt is negligible; activity decay must be 0
	// because the only inserts in the ticker are A's own.
	if raw < 290 {
		t.Errorf("A raw = %f after 3×100 own inserts, want ≈ 300 (own inserts must not self-decay)", raw)
	}
}

// TestActivityDecay_NewPlayerSnapshotInit verifies that a brand-new player
// added mid-simulation initializes their LastTickerSnapshot to the current
// ticker value, so they don't see "all coins inserted before they joined"
// as activity-decay against themselves on first read.
func TestActivityDecay_NewPlayerSnapshotInit(t *testing.T) {
	t.Parallel()

	h := New(WithCoinHalfLife(30))
	a := uuid.New()
	b := uuid.New()

	// A inserts 100 coins; ticker becomes 100. B does not exist yet.
	h.AddHeat(a, 100)

	// B's first-ever insert. After the call, B's snapshot must be 150
	// (post-own-insert), not 0 — otherwise the next read would treat all
	// 150 prior coins as "others' decay" against B's freshly-added 50.
	h.AddHeat(b, 50)

	h.mu.RLock()
	bSnapshot := h.players[b].LastTickerSnapshot
	bRaw := h.players[b].RawHeat
	h.mu.RUnlock()

	if bSnapshot != 150 {
		t.Errorf("B snapshot = %f, want 150 (ticker after B's own insert)", bSnapshot)
	}
	if bRaw < 49 || bRaw > 51 {
		t.Errorf("B raw = %f after first insert of 50, want ≈ 50 (no self-decay from prior history)", bRaw)
	}
}

// TestActivityDecay_ComposesWithFloor verifies activity-driven decay and the
// guaranteed floor compose without double-counting. A real player's heat
// decays via activity, then the floor mechanic computes from the decayed
// value. Shares must still sum to 1.
func TestActivityDecay_ComposesWithFloor(t *testing.T) {
	t.Parallel()

	h := New(WithCoinHalfLife(30), WithGuaranteed(0.05))
	real := uuid.New()
	bot := uuid.New()

	h.AddHeat(real, 50)
	h.AddHeatForBot(bot, 50)
	h.AddHeatForBot(bot, 100) // pushes activity decay onto real

	shares := h.GetShares()
	if len(shares) != 2 {
		t.Fatalf("expected 2 shares, got %d", len(shares))
	}

	var realShare, botShare float64
	for _, s := range shares {
		if s.UserID == real {
			realShare = s.Share
		} else {
			botShare = s.Share
		}
	}

	if sum := realShare + botShare; math.Abs(sum-1.0) > 0.001 {
		t.Errorf("shares sum = %f, want 1.0", sum)
	}
	// Bot has ~150 effective heat (no self-decay); real has ~1.55 (activity-eroded).
	// Even with the 5% floor boost, bot's competitive lead must dominate.
	if realShare >= botShare {
		t.Errorf("real %f should have less share than bot %f after activity-decay erosion", realShare, botShare)
	}
}

// --- Combo defaults regression -----------------------------------------

// TestNew_CombosByDefault locks in the post-2026-04-26 production defaults.
// If anyone changes these constants without updating heatsim and re-running
// the scenario sweep, this test breaks loudly.
func TestNew_CombosByDefault(t *testing.T) {
	t.Parallel()

	h := New()

	if math.Abs(h.alpha-0.95) > 1e-9 {
		t.Errorf("default alpha = %f, want 0.95 (combo)", h.alpha)
	}
	expectedLambdaCoin := math.Log(2) / 30.0
	if math.Abs(h.lambdaCoin-expectedLambdaCoin) > 1e-9 {
		t.Errorf("default lambdaCoin = %f, want ln(2)/30 ≈ %f (combo)", h.lambdaCoin, expectedLambdaCoin)
	}
	if h.guaranteed != 0.0 {
		t.Errorf("default guaranteed = %f, want 0 (floor disabled)", h.guaranteed)
	}
	if math.Abs(h.halfLife-180.0) > 1e-9 {
		t.Errorf("default halfLife = %f, want 180 (unchanged by combo)", h.halfLife)
	}
}

// TestActivityDecay_PushesAFKOut verifies the combo's central economic
// promise: an AFK player whose heat sits idle must lose share faster under
// combo defaults than under the legacy α=0.7 + lambdaCoin=0 formula, when
// other players keep activity flowing. Demonstrates the operational claim
// that closed the heartbeat-exploit class.
func TestActivityDecay_PushesAFKOut(t *testing.T) {
	t.Parallel()

	// Setup helper: A inserts 100 then goes AFK; B inserts 100 coins (split
	// across 20 small batches to look realistic). Returns A's share at the
	// end. 100 coins from B drives A's activity-decay exponent to ln(2)*100/30
	// ≈ 2.31 → A's decayed ≈ 9.9 under combo; under legacy A stays at ~100.
	run := func(opts ...Option) float64 {
		h := New(opts...)
		a := uuid.New()
		b := uuid.New()

		h.AddHeat(a, 100)
		for i := 0; i < 20; i++ {
			h.AddHeat(b, 5)
		}
		return h.GetShareForUser(a)
	}

	combo := run() // defaults
	legacy := run(WithAlpha(0.7), WithCoinHalfLife(0))

	if combo >= legacy {
		t.Errorf("combo share for AFK A = %f; legacy = %f. Combo must push A out faster.", combo, legacy)
	}
	// Hard sanity: combo should drop A meaningfully, not be a rounding tweak.
	// Expected combo ≈ 0.10, legacy ≈ 0.50; ratio ≈ 0.2. Allow up to 0.5
	// (50% of legacy) to leave headroom for floating-point and edge effects.
	if combo > legacy*0.5 {
		t.Errorf("combo (%f) should drop A's share to ≤50%% of legacy (%f); got ratio %.2f",
			combo, legacy, combo/legacy)
	}
}
