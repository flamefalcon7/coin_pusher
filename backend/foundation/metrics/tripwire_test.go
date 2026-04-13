package metrics

import (
	"testing"
)

// TestAssertNoRefundFailures_Clean documents the intended usage pattern:
// when no code increments BatchInsertRefundFailures during the test body,
// the cleanup assertion passes.
func TestAssertNoRefundFailures_Clean(t *testing.T) {
	AssertNoRefundFailures(t)
	// Intentionally do not touch the counter — cleanup should find no delta.
}

// Note on "fires on increment": testing the Cleanup side-effect directly
// would require invoking the test runner on a synthetic *testing.T, which
// the stdlib doesn't support cleanly (testing.T.Cleanup hooks only run
// when the framework exits the test, and sync.RWMutex inside testing.T
// prevents copying). The real contract — tripwire fires when the counter
// moves — is enforced by the Unit 6 WS + HTTP handler tests that use the
// helper under the real test runner.
