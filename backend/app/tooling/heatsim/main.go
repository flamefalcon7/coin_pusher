// Heatsim is a Monte-Carlo style simulator that drives the real heat engine
// (backend/business/core/heat) with a virtual clock to measure per-player
// RTP under adversarial insertion strategies.
//
// Goal: catch heat-mechanism exploits before they reach prod by stress-testing
// the formula against strategies that didn't show up in historical data.
//
// Pass criteria: every adversarial strategy must produce RTP < 100%. Anything
// >= 100% means a player can mint money via heat alone, regardless of game
// outcomes. That is a leak.
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
)

// --- Virtual clock --------------------------------------------------------

type vclock struct {
	t time.Time
}

func (c *vclock) Now() time.Time { return c.t }
func (c *vclock) advance(d time.Duration) {
	c.t = c.t.Add(d)
}

// --- Strategies -----------------------------------------------------------

// A strategy decides how often a player inserts coins and how many.
// All quantities are in simulated seconds / coin counts.
type strategy struct {
	name string
	// period: seconds between inserts. 0 means insert once at startDelay.
	period float64
	// coinsPerInsert: coins added each time the strategy fires.
	coinsPerInsert int
	// startDelay: seconds to wait before first insert.
	startDelay float64
	// stopAt: seconds after which the strategy goes silent. 0 = never stops.
	stopAt float64
	// isBot: routes inserts through AddHeatForBot vs AddHeat. The current
	// (post-2026-04-25 fix) heat engine excludes bots from the floor.
	isBot bool
}

// firstEvent returns the time of the strategy's first insert, or -1 if it
// never inserts (zero coinsPerInsert).
func (s strategy) firstEvent() float64 {
	if s.coinsPerInsert == 0 {
		return -1
	}
	return s.startDelay
}

// eventAfter returns the strategy's next insert time strictly after `since`,
// or -1 if no more events. One-shot strategies (period == 0) always return -1
// here — the caller is responsible for setting them to -1 after firing.
func (s strategy) eventAfter(since float64) float64 {
	if s.coinsPerInsert == 0 || s.period == 0 {
		return -1
	}
	// First k such that startDelay + k*period > since, k >= 1.
	var k int
	if since < s.startDelay {
		k = 0
	} else {
		k = int((since-s.startDelay)/s.period) + 1
	}
	next := s.startDelay + float64(k)*s.period
	if s.stopAt > 0 && next >= s.stopAt {
		return -1
	}
	return next
}

// --- Simulation -----------------------------------------------------------

type playerState struct {
	id       uuid.UUID
	strat    strategy
	inserted int     // total coins inserted
	received float64 // total coins received from front-edge drops
}

type simConfig struct {
	durationSec   float64
	dropPerSec    float64 // front-edge coins per second
	dropTickSec   float64 // how often we run a distribution (batches drops)
	pruneEverySec float64
	startTime     time.Time
}

func defaultConfig() simConfig {
	return simConfig{
		durationSec:   3600, // 1 hr
		dropPerSec:    1.0,  // 1 front-edge coin per second on average
		dropTickSec:   1.0,  // distribute every simulated second
		pruneEverySec: 60.0, // prune negligible heat once per simulated minute
		startTime:     time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
}

type event struct {
	t      float64 // simulated seconds since start
	kind   string  // "insert" or "drop" or "prune"
	player int     // index into players slice (insert only)
}

func runSim(cfg simConfig, strategies []strategy, opts ...heat.Option) []playerState {
	clk := &vclock{t: cfg.startTime}
	engine := heat.NewWithClock(clk.Now, opts...)

	players := make([]playerState, len(strategies))
	for i, s := range strategies {
		players[i] = playerState{
			id:    uuid.New(),
			strat: s,
		}
	}

	// Build heap-style schedule. With a few hundred events per hour we just
	// re-scan inserts each tick — simpler than a real priority queue and
	// fast enough at this scale.
	nextInsertAt := make([]float64, len(players))
	for i, p := range players {
		nextInsertAt[i] = p.strat.firstEvent()
	}

	tick := 0
	for simNow := 0.0; simNow <= cfg.durationSec; simNow += cfg.dropTickSec {
		// Advance virtual clock to this simulated time.
		clk.t = cfg.startTime.Add(time.Duration(simNow * float64(time.Second)))

		// Fire any inserts whose time has come.
		for i := range players {
			for nextInsertAt[i] >= 0 && nextInsertAt[i] <= simNow {
				eventTime := nextInsertAt[i]
				clk.t = cfg.startTime.Add(time.Duration(eventTime * float64(time.Second)))
				p := &players[i]
				if p.strat.isBot {
					engine.AddHeatForBot(p.id, p.strat.coinsPerInsert)
				} else {
					engine.AddHeat(p.id, p.strat.coinsPerInsert)
				}
				p.inserted += p.strat.coinsPerInsert
				nextInsertAt[i] = p.strat.eventAfter(eventTime)
			}
		}

		// Restore clock to drop time.
		clk.t = cfg.startTime.Add(time.Duration(simNow * float64(time.Second)))

		// Distribute the drops accumulated in this tick.
		drops := int(cfg.dropPerSec * cfg.dropTickSec)
		if drops > 0 {
			dist := engine.DistributeFrontEdgeDrop(drops)
			for i := range players {
				players[i].received += dist[players[i].id]
			}
		}

		tick++
		if cfg.pruneEverySec > 0 && float64(tick)*cfg.dropTickSec >= cfg.pruneEverySec {
			engine.Prune()
			tick = 0
		}
	}

	return players
}

// --- Reporting ------------------------------------------------------------

func report(out *os.File, results []playerState, cfg simConfig) {
	// Sort: real players first by RTP desc, then bots.
	sort.SliceStable(results, func(i, j int) bool {
		ri, rj := results[i], results[j]
		if ri.strat.isBot != rj.strat.isBot {
			return !ri.strat.isBot
		}
		if ri.inserted == 0 && rj.inserted == 0 {
			return ri.strat.name < rj.strat.name
		}
		if ri.inserted == 0 {
			return false
		}
		if rj.inserted == 0 {
			return true
		}
		return ri.received/float64(ri.inserted) > rj.received/float64(rj.inserted)
	})

	totalInserted := 0
	totalReceived := 0.0
	totalDropPool := cfg.durationSec * cfg.dropPerSec

	fmt.Fprintf(out, "Heat-mechanism RTP simulation\n")
	fmt.Fprintf(out, "  duration:      %.0fs\n", cfg.durationSec)
	fmt.Fprintf(out, "  drop rate:     %.2f coins/s  (pool=%.0f over run)\n", cfg.dropPerSec, totalDropPool)
	fmt.Fprintf(out, "  drop tick:     %.2fs\n", cfg.dropTickSec)
	fmt.Fprintf(out, "\n")
	fmt.Fprintf(out, "%-22s %-4s %-9s %-10s %-8s %-8s\n", "strategy", "kind", "inserted", "received", "RTP%", "verdict")
	fmt.Fprintf(out, "%-22s %-4s %-9s %-10s %-8s %-8s\n", "----------------------", "----", "---------", "----------", "--------", "--------")
	for _, p := range results {
		kind := "real"
		if p.strat.isBot {
			kind = "bot"
		}
		var rtp float64
		var rtpStr, verdict string
		if p.inserted == 0 {
			rtpStr = "—"
			verdict = "—"
		} else {
			rtp = p.received / float64(p.inserted) * 100
			rtpStr = fmt.Sprintf("%.1f%%", rtp)
			switch {
			case rtp >= 100:
				verdict = "LEAK"
			case rtp >= 80:
				verdict = "warm"
			default:
				verdict = "ok"
			}
		}
		fmt.Fprintf(out, "%-22s %-4s %-9d %-10.2f %-8s %-8s\n",
			p.strat.name, kind, p.inserted, p.received, rtpStr, verdict)
		if !p.strat.isBot {
			totalInserted += p.inserted
			totalReceived += p.received
		}
	}
	fmt.Fprintf(out, "\n")
	if totalInserted > 0 {
		fmt.Fprintf(out, "Real-player aggregate RTP: %.1f%%  (received %.2f / inserted %d)\n",
			totalReceived/float64(totalInserted)*100, totalReceived, totalInserted)
	}
	fmt.Fprintf(out, "Drop pool consumed:         %.2f / %.0f  (%.1f%% reached players)\n",
		sumReceived(results), totalDropPool, sumReceived(results)/totalDropPool*100)
}

func sumReceived(results []playerState) float64 {
	var s float64
	for _, p := range results {
		s += p.received
	}
	return s
}

// --- Scenarios ------------------------------------------------------------

// scenarioMixed represents the operational regime today: a handful of bots
// generating constant heat, plus a mix of adversarial / realistic real
// players. RTP for any real strategy >= 100% means that strategy mints money
// from the heat formula alone.
func scenarioMixed(numBots int) []strategy {
	strategies := []strategy{
		{name: "heartbeat-1c-60s", period: 60, coinsPerInsert: 1, startDelay: 0},
		{name: "heartbeat-2c-60s", period: 60, coinsPerInsert: 2, startDelay: 0},
		{name: "heartbeat-1c-30s", period: 30, coinsPerInsert: 1, startDelay: 0},
		{name: "burst-then-AFK-200", period: 0, coinsPerInsert: 200, startDelay: 0},
		{name: "burst-then-AFK-50", period: 0, coinsPerInsert: 50, startDelay: 0},
		{name: "constant-low-5c-30s", period: 30, coinsPerInsert: 5, startDelay: 0},
		{name: "whale-100c-60s", period: 60, coinsPerInsert: 100, startDelay: 0},
		{name: "never-insert", period: 0, coinsPerInsert: 0, startDelay: 0},
	}
	for i := 0; i < numBots; i++ {
		strategies = append(strategies, strategy{
			name:           fmt.Sprintf("bot-%d", i+1),
			period:         5, // bots insert every 5s like the prod bot tick
			coinsPerInsert: 5,
			startDelay:     float64(i) * 0.5, // stagger
			isBot:          true,
		})
	}
	return strategies
}

// --- Main -----------------------------------------------------------------

func main() {
	var (
		duration   = flag.Float64("duration", 3600, "simulated seconds")
		drop       = flag.Float64("drop-rate", 1.0, "front-edge coins per simulated second")
		bots       = flag.Int("bots", 5, "number of bots in the scenario")
		guaranteed = flag.Float64("guaranteed", 0.05, "per-real-player guaranteed floor share (0 disables floor)")
		halfLife   = flag.Float64("half-life", 180, "heat half-life in seconds")
		alpha      = flag.Float64("alpha", 0.7, "diminishing-returns exponent")
		threshold  = flag.Float64("floor-threshold", 10, "decayed-heat threshold for full floor")
	)
	flag.Parse()

	cfg := defaultConfig()
	cfg.durationSec = *duration
	cfg.dropPerSec = *drop

	opts := []heat.Option{
		heat.WithGuaranteed(*guaranteed),
		heat.WithHalfLife(*halfLife),
		heat.WithAlpha(*alpha),
		heat.WithFloorThreshold(*threshold),
	}

	fmt.Printf("Heat engine config: guaranteed=%.3f half-life=%.0fs alpha=%.2f floor-threshold=%.1f\n\n",
		*guaranteed, *halfLife, *alpha, *threshold)

	strategies := scenarioMixed(*bots)
	results := runSim(cfg, strategies, opts...)
	report(os.Stdout, results, cfg)
}
