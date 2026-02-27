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

func TestCanInsertCoin(t *testing.T) {
	t.Parallel()

	c := &Connection{
		send: make(chan []byte, sendBufLen),
	}

	if !c.CanInsertCoin() {
		t.Fatal("first call should return true")
	}

	if c.CanInsertCoin() {
		t.Fatal("second immediate call should return false (within 50ms)")
	}

	time.Sleep(60 * time.Millisecond)
	if !c.CanInsertCoin() {
		t.Fatal("call after cooldown should return true")
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
