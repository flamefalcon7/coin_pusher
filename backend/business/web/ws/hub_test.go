package ws

import "testing"

func TestAddMegaspeakerMsg(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	hub.AddMegaspeakerMsg([]byte("msg1"))
	hub.AddMegaspeakerMsg([]byte("msg2"))
	hub.AddMegaspeakerMsg([]byte("msg3"))

	got := hub.GetMegaspeakerHistory()
	if len(got) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(got))
	}
	if string(got[0]) != "msg1" {
		t.Errorf("got[0] = %q, want %q", got[0], "msg1")
	}
	if string(got[2]) != "msg3" {
		t.Errorf("got[2] = %q, want %q", got[2], "msg3")
	}
}

func TestAddMegaspeakerMsg_Cap50(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	for i := 0; i < 60; i++ {
		hub.AddMegaspeakerMsg([]byte{byte(i)})
	}

	got := hub.GetMegaspeakerHistory()
	if len(got) != 50 {
		t.Fatalf("expected 50 messages, got %d", len(got))
	}

	// First retained message should be index 10 (60-50).
	if got[0][0] != 10 {
		t.Errorf("first message = %d, want 10", got[0][0])
	}
	// Last retained message should be index 59.
	if got[49][0] != 59 {
		t.Errorf("last message = %d, want 59", got[49][0])
	}
}

func TestGetMegaspeakerHistory_Empty(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	got := hub.GetMegaspeakerHistory()

	if got == nil {
		t.Fatal("expected non-nil slice, got nil")
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 messages, got %d", len(got))
	}
}

func TestGetMegaspeakerHistory_IsCopy(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	hub.AddMegaspeakerMsg([]byte("original"))

	got := hub.GetMegaspeakerHistory()
	got[0] = []byte("mutated")

	// Hub state should be unchanged.
	fresh := hub.GetMegaspeakerHistory()
	if string(fresh[0]) != "original" {
		t.Errorf("hub state was mutated: got %q, want %q", fresh[0], "original")
	}
}

// ---------------------------------------------------------------------------
// SpectatorCount
// ---------------------------------------------------------------------------

func TestSpectatorCount_AddRemove(t *testing.T) {
	t.Parallel()

	hub := NewHub()

	s1 := &Connection{send: make(chan []byte, 1), hub: hub, spectator: true}
	s2 := &Connection{send: make(chan []byte, 1), hub: hub, spectator: true}
	u1 := &Connection{send: make(chan []byte, 1), hub: hub, userID: "user-1"}

	hub.Add(s1)
	hub.Add(s2)
	hub.Add(u1)

	if hub.Count() != 3 {
		t.Fatalf("expected 3 total connections, got %d", hub.Count())
	}
	if hub.SpectatorCount() != 2 {
		t.Fatalf("expected 2 spectators, got %d", hub.SpectatorCount())
	}

	hub.Remove(s1)
	if hub.SpectatorCount() != 1 {
		t.Errorf("expected 1 spectator after remove, got %d", hub.SpectatorCount())
	}
	if hub.Count() != 2 {
		t.Errorf("expected 2 total after remove, got %d", hub.Count())
	}

	// Removing non-spectator should not change spectator count.
	hub.Remove(u1)
	if hub.SpectatorCount() != 1 {
		t.Errorf("expected 1 spectator after removing user, got %d", hub.SpectatorCount())
	}
}

func TestSpectatorCount_DoubleRemove(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	s := &Connection{send: make(chan []byte, 1), hub: hub, spectator: true}
	hub.Add(s)
	hub.Remove(s)
	hub.Remove(s) // should not decrement below 0

	if hub.SpectatorCount() != 0 {
		t.Errorf("expected 0 spectators, got %d", hub.SpectatorCount())
	}
}

// ---------------------------------------------------------------------------
// DisconnectUser
// ---------------------------------------------------------------------------

func TestDisconnectUser_NoConnections(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	n := hub.DisconnectUser("user-1")
	if n != 0 {
		t.Errorf("expected 0 disconnected, got %d", n)
	}
}

func TestDisconnectUser_RemovesTargetOnly(t *testing.T) {
	t.Parallel()

	hub := NewHub()

	// Create connections with nil websocket.Conn — we only test hub bookkeeping.
	c1 := &Connection{userID: "user-1", send: make(chan []byte, 1), hub: hub}
	c2 := &Connection{userID: "user-2", send: make(chan []byte, 1), hub: hub}
	c3 := &Connection{userID: "user-1", send: make(chan []byte, 1), hub: hub}

	hub.Add(c1)
	hub.Add(c2)
	hub.Add(c3)

	if hub.Count() != 3 {
		t.Fatalf("expected 3 connections, got %d", hub.Count())
	}

	n := hub.DisconnectUser("user-1")
	if n != 2 {
		t.Errorf("expected 2 disconnected, got %d", n)
	}

	if hub.Count() != 1 {
		t.Errorf("expected 1 remaining connection, got %d", hub.Count())
	}

	// Remaining connection should be user-2.
	hub.mu.RLock()
	for c := range hub.connections {
		if c.userID != "user-2" {
			t.Errorf("remaining connection userID = %q, want %q", c.userID, "user-2")
		}
	}
	hub.mu.RUnlock()
}

func TestDisconnectUser_OtherUserUnaffected(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	c1 := &Connection{userID: "user-1", send: make(chan []byte, 1), hub: hub}
	hub.Add(c1)

	n := hub.DisconnectUser("user-999")
	if n != 0 {
		t.Errorf("expected 0 disconnected, got %d", n)
	}
	if hub.Count() != 1 {
		t.Errorf("expected 1 connection, got %d", hub.Count())
	}
}
