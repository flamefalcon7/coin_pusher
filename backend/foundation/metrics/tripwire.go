package metrics

import (
	"testing"

	iometrics "github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// AssertNoRefundFailures is the tripwire regression assertion for the
// outbox rollout. Once Unit 6 flips handlers to the outbox path, the old
// refund code path must never fire — any increment of
// coinpusher_batch_insert_refund_failures_total signals a regression
// (someone wired the refund path back, or the flag-off path ran when it
// shouldn't have).
//
// Call this from t.Cleanup in any test that exercises batch_insert with
// the outbox path enabled. It captures the counter value at registration
// time and asserts the value has not advanced at teardown.
//
// The test helper lives here (not in a test file) so it can be shared
// across package-level tests in accounting/, ws/, gamegrp/, and outbox/
// without each copy drifting. Fulfills R1 from the outbox plan.
func AssertNoRefundFailures(t *testing.T) {
	t.Helper()
	start := refundFailuresValue()
	t.Cleanup(func() {
		end := refundFailuresValue()
		if end > start {
			t.Errorf(
				"BatchInsertRefundFailures tripwire fired: counter advanced from %f to %f "+
					"during this test. Refund path must stay dormant when outbox is enabled.",
				start, end,
			)
		}
	})
}

// refundFailuresValue reads the current value of the global counter. Uses
// the Prometheus Collect pattern because Counter has no public .Get()
// method that would survive a production-metrics-style global registry.
func refundFailuresValue() float64 {
	ch := make(chan iometrics.Metric, 1)
	BatchInsertRefundFailures.Collect(ch)
	close(ch)
	m := <-ch
	var pb dto.Metric
	if err := m.Write(&pb); err != nil {
		return 0
	}
	if pb.Counter == nil || pb.Counter.Value == nil {
		return 0
	}
	return *pb.Counter.Value
}
