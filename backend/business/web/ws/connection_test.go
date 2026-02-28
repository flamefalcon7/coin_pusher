package ws

import (
	"testing"
	"time"
)

func TestCanBatchInsert(t *testing.T) {
	t.Parallel()

	c := &Connection{
		send: make(chan []byte, sendBufLen),
	}

	// First call should always succeed (zero lastBatchInsert).
	if !c.CanBatchInsert() {
		t.Fatal("first call should return true")
	}

	// Immediate second call should be rate-limited.
	if c.CanBatchInsert() {
		t.Fatal("second immediate call should return false (within 200ms)")
	}

	// After waiting past the cooldown, should succeed again.
	time.Sleep(210 * time.Millisecond)
	if !c.CanBatchInsert() {
		t.Fatal("call after cooldown should return true")
	}
}


func TestIsAdmin(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		role string
		want bool
	}{
		{"admin role", "admin", true},
		{"user role", "user", false},
		{"empty role", "", false},
		{"unknown role", "moderator", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			c := &Connection{
				send: make(chan []byte, sendBufLen),
				role: tc.role,
			}

			if got := c.IsAdmin(); got != tc.want {
				t.Errorf("IsAdmin() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCanBatchInsert_Concurrent(t *testing.T) {
	t.Parallel()

	c := &Connection{
		send: make(chan []byte, sendBufLen),
	}

	// Run concurrent calls; exactly one should succeed.
	results := make(chan bool, 10)
	for i := 0; i < 10; i++ {
		go func() {
			results <- c.CanBatchInsert()
		}()
	}

	allowed := 0
	for i := 0; i < 10; i++ {
		if <-results {
			allowed++
		}
	}

	if allowed != 1 {
		t.Errorf("expected exactly 1 allowed, got %d", allowed)
	}
}
