package ws

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestEncodeBatchInsertPayload_Shape(t *testing.T) {
	t.Parallel()

	data, err := EncodeBatchInsertPayload("u-123", 2, 7, "ref-abc")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	// Round-trip: decode back and assert fields match input.
	var got NATSBatchInsertCmd
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.UserID != "u-123" {
		t.Errorf("user_id: got %q want u-123", got.UserID)
	}
	if got.SlotID != 2 {
		t.Errorf("slot_id: got %d want 2", got.SlotID)
	}
	if got.Count != 7 {
		t.Errorf("count: got %d want 7", got.Count)
	}
	if got.ReferenceID != "ref-abc" {
		t.Errorf("reference_id: got %q want ref-abc", got.ReferenceID)
	}
}

func TestEncodeBatchInsertPayload_OmitsEmptyReference(t *testing.T) {
	t.Parallel()

	data, err := EncodeBatchInsertPayload("u-1", 0, 1, "")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	// `omitempty` on ReferenceID: empty value must not appear on the wire.
	// This preserves the legacy wire shape for any consumer still expecting
	// the 3-field form during a rolling deploy.
	if strings.Contains(string(data), "reference_id") {
		t.Errorf("empty reference_id should be omitted, got payload: %s", string(data))
	}
}

// Fixture regression guard — freezes the exact bytes produced by a canonical
// input so any accidental wire-format drift (field rename, reorder, tag
// typo) fails loudly. Update ONLY when intentionally changing the contract,
// and coordinate with game/server/src/nats/NATSClient.ts.
func TestEncodeBatchInsertPayload_FixtureFrozen(t *testing.T) {
	t.Parallel()

	data, err := EncodeBatchInsertPayload("alice", 3, 42, "r-xyz")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	want := []byte(`{"user_id":"alice","slot_id":3,"count":42,"reference_id":"r-xyz"}`)
	if !bytes.Equal(data, want) {
		t.Errorf("wire format drift\n  got:  %s\n  want: %s", data, want)
	}
}

// Maximum realistic count — our batch cap is 100 today but the field is int.
// Guard against future int overflow in encoding by exercising a large value.
func TestEncodeBatchInsertPayload_LargeCount(t *testing.T) {
	t.Parallel()

	data, err := EncodeBatchInsertPayload("u", 0, 1_000_000, "r")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var got NATSBatchInsertCmd
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Count != 1_000_000 {
		t.Errorf("count round-trip failed: got %d", got.Count)
	}
}
