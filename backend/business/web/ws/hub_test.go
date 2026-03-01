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
