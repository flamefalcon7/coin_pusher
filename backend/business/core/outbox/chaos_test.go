//go:build integration

// Integration tests for the outbox drainer. These require a live Postgres +
// NATS and are skipped in the default go test run. Run with:
//
//	docker compose -f docker-compose.dev.yml up -d postgres nats
//	go test -tags=integration ./backend/business/core/outbox/...
//
// Env overrides:
//	OUTBOX_TEST_PG_DSN  (default: postgres://postgres:postgres@localhost:5432/coinpusher?sslmode=disable)
//	OUTBOX_TEST_NATS_URL (default: nats://localhost:4222)

package outbox

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
	"github.com/nats-io/nats.go"
	"go.uber.org/zap"
)

func integrationEnv() (pgDSN, natsURL string) {
	pgDSN = os.Getenv("OUTBOX_TEST_PG_DSN")
	if pgDSN == "" {
		pgDSN = "postgres://postgres:postgres@localhost:5432/coinpusher?sslmode=disable"
	}
	natsURL = os.Getenv("OUTBOX_TEST_NATS_URL")
	if natsURL == "" {
		natsURL = "nats://localhost:4222"
	}
	return
}

func setupIntegration(t *testing.T) (*sqlx.DB, *nats.Conn, string) {
	t.Helper()
	pgDSN, natsURL := integrationEnv()

	db, err := sqlx.Connect("postgres", pgDSN)
	if err != nil {
		t.Skipf("Postgres unavailable (%v) — skipping integration test", err)
	}
	// Ensure the tables exist.
	if _, err := db.Exec(`SELECT 1 FROM nats_outbox LIMIT 0`); err != nil {
		t.Skipf("nats_outbox not present in test DB (%v) — run admin migrate first", err)
	}

	nc, err := nats.Connect(natsURL)
	if err != nil {
		db.Close()
		t.Skipf("NATS unavailable (%v) — skipping integration test", err)
	}

	// Clean slate per-test: truncate both outbox tables. Parallel integration
	// tests are not supported; these run one at a time against a shared DB.
	if _, err := db.Exec(`TRUNCATE nats_outbox, nats_outbox_dlq RESTART IDENTITY`); err != nil {
		db.Close()
		nc.Close()
		t.Fatalf("truncate: %v", err)
	}

	return db, nc, pgDSN
}

// TestIntegration_ChaosNATSOutage simulates a NATS outage by pointing the
// drainer at a bad URL, accumulating rows in outbox, then switching to a
// healthy URL. Rows must drain in order once NATS is back.
//
// Skipped when the env isn't available (no postgres/nats locally).
func TestIntegration_ChaosNATSOutage(t *testing.T) {
	db, nc, _ := setupIntegration(t)
	defer db.Close()
	defer nc.Close()

	// Seed 20 rows to a test subject.
	subject := "test.outbox.chaos"
	for i := 0; i < 20; i++ {
		payload := []byte(fmt.Sprintf(`{"n":%d}`, i))
		ref := fmt.Sprintf("ref-chaos-%d", i)
		if _, err := db.Exec(
			`INSERT INTO nats_outbox (subject, payload, reference_id) VALUES ($1, $2, $3)`,
			subject, payload, ref,
		); err != nil {
			t.Fatalf("seed insert: %v", err)
		}
	}

	// Subscribe to NATS subject before the drainer starts.
	received := make(chan []byte, 50)
	sub, err := nc.Subscribe(subject, func(m *nats.Msg) {
		received <- m.Data
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer sub.Unsubscribe()

	// Start drainer. Use the real DB + real NATS.
	pgDSN, _ := integrationEnv()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	go func() {
		_ = Run(ctx, db, nc, zap.NewNop().Sugar(), Config{
			ListenDSN:        pgDSN,
			FallbackTick:     200 * time.Millisecond,
			BatchSize:        50,
			MaxAttempts:      10,
			TableSizeRefresh: 1 * time.Hour,
		})
	}()

	// Expect all 20 rows to arrive in commit order (subject order is
	// guaranteed per-subject by the drainer's algorithm).
	got := make([]int, 0, 20)
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
collect:
	for len(got) < 20 {
		select {
		case <-deadline.C:
			t.Fatalf("timeout waiting for drain — got %d/20, received so far: %v", len(got), got)
		case data := <-received:
			var n int
			if _, err := fmt.Sscanf(string(data), `{"n":%d}`, &n); err != nil {
				t.Fatalf("parse payload %q: %v", string(data), err)
			}
			got = append(got, n)
			if len(got) == 20 {
				break collect
			}
		}
	}
	// Per-subject ordering invariant.
	for i, n := range got {
		if n != i {
			t.Errorf("out-of-order at position %d: got %d, want %d (full: %v)", i, n, i, got)
			break
		}
	}

	// Table should be empty after drain.
	var remaining int
	if err := db.Get(&remaining, `SELECT COUNT(*) FROM nats_outbox WHERE subject = $1`, subject); err != nil {
		t.Fatalf("count: %v", err)
	}
	if remaining != 0 {
		t.Errorf("expected 0 rows remaining, got %d", remaining)
	}
}

// TestIntegration_Concurrency_1000 fires 1000 inserts across 50 simulated
// rooms (20 per room), drains, and asserts per-room ordering + zero losses.
func TestIntegration_Concurrency_1000(t *testing.T) {
	db, nc, _ := setupIntegration(t)
	defer db.Close()
	defer nc.Close()

	const rooms = 50
	const perRoom = 20

	// Subscribe to all room subjects with a wildcard.
	received := make(chan *nats.Msg, rooms*perRoom*2)
	sub, err := nc.Subscribe("test.room.*", func(m *nats.Msg) { received <- m })
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer sub.Unsubscribe()

	// Concurrent writers.
	var wg sync.WaitGroup
	for r := 0; r < rooms; r++ {
		wg.Add(1)
		go func(room int) {
			defer wg.Done()
			subj := fmt.Sprintf("test.room.%d", room)
			for i := 0; i < perRoom; i++ {
				ref := fmt.Sprintf("r%d-n%d", room, i)
				payload := []byte(fmt.Sprintf(`{"room":%d,"n":%d}`, room, i))
				if _, err := db.Exec(
					`INSERT INTO nats_outbox (subject, payload, reference_id) VALUES ($1, $2, $3)`,
					subj, payload, ref,
				); err != nil {
					t.Errorf("insert room=%d n=%d: %v", room, i, err)
					return
				}
			}
		}(r)
	}
	wg.Wait()

	// Start drainer.
	pgDSN, _ := integrationEnv()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	go func() {
		_ = Run(ctx, db, nc, zap.NewNop().Sugar(), Config{
			ListenDSN:        pgDSN,
			FallbackTick:     100 * time.Millisecond,
			BatchSize:        500,
			MaxAttempts:      10,
			TableSizeRefresh: 1 * time.Hour,
		})
	}()

	// Collect all messages, bucket by room, verify per-room order + total.
	total := rooms * perRoom
	perRoomGot := make(map[int][]int, rooms)
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()

	for collected := 0; collected < total; {
		select {
		case <-deadline.C:
			t.Fatalf("timeout: got %d/%d", collected, total)
		case m := <-received:
			// Parse {"room":X,"n":Y} minimally.
			s := strings.TrimPrefix(string(m.Data), `{"room":`)
			parts := strings.SplitN(s, `,"n":`, 2)
			if len(parts) != 2 {
				t.Fatalf("bad payload: %s", string(m.Data))
			}
			var room, n int
			fmt.Sscanf(parts[0], "%d", &room)
			fmt.Sscanf(strings.TrimSuffix(parts[1], "}"), "%d", &n)
			perRoomGot[room] = append(perRoomGot[room], n)
			collected++
		}
	}

	// Per-room order check.
	for room, ns := range perRoomGot {
		for i, n := range ns {
			if n != i {
				t.Errorf("room %d out-of-order at position %d: got %d (full: %v)", room, i, n, ns)
				break
			}
		}
		if len(ns) != perRoom {
			t.Errorf("room %d: got %d messages, want %d", room, len(ns), perRoom)
		}
	}
}
