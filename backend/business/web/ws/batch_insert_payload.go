package ws

import (
	"encoding/json"
	"fmt"
)

// EncodeBatchInsertPayload builds the JSON bytes published to
// TopicBatchInsert for consumption by the game server. Centralized here so:
//
//  1. The outbox row writer (Go backend) and the drainer (Go backend) agree
//     on wire format at commit time — the bytes stored in nats_outbox are
//     exactly what the drainer later publishes.
//  2. A byte-for-byte fixture regression test can freeze the shape (see
//     batch_insert_payload_test.go) to catch accidental drift.
//  3. The game server's BatchInsertCommand type (game/server/src/nats/NATSClient.ts)
//     stays the single source of truth for the consumer-side shape; any
//     change here must be matched there.
//
// referenceID MUST be non-empty when the outbox path is in use — the game
// server dedupes on it to bound at-least-once retries. Legacy (pre-outbox)
// publishes can pass "" and dedup is simply skipped downstream.
func EncodeBatchInsertPayload(userID string, slotID, count int, referenceID string) ([]byte, error) {
	cmd := NATSBatchInsertCmd{
		UserID:      userID,
		SlotID:      slotID,
		Count:       count,
		ReferenceID: referenceID,
	}
	data, err := json.Marshal(cmd)
	if err != nil {
		return nil, fmt.Errorf("marshal batch_insert payload: %w", err)
	}
	return data, nil
}
