// Heatsim is a Monte-Carlo style simulator that drives the real heat engine
// (backend/business/core/heat) with a virtual clock to measure per-player
// RTP under adversarial insertion strategies + PROD-faithful bot behavior.
//
// Goal: catch heat-mechanism exploits before they reach prod by stress-testing
// the formula against strategies that didn't show up in historical data.
//
// Pass criteria: every real-player strategy produces RTP < 100%. Anything
// >= 100% means a player can mint money via heat alone, regardless of game
// outcomes. That is a leak.
//
// PROD bot behavior in scenarios is kept in sync with
// backend/business/core/bot/scheduler.go (envelopes near line 41-67).
package main

import (
	"flag"
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/flamefalcon/coin-pusher/backend/business/core/heat"
)

// --- PROD bot tunables (mirror scheduler.go) -----------------------------

const (
	botInsertAmountMin   = 3
	botInsertAmountMax   = 15
	botIntervalMeanSec   = 30.0
	botIntervalStdDevSec = 10.0
	botIntervalMinSec    = 10.0
	botIntervalMaxSec    = 90.0
	botSessionMinSec     = 10 * 60
	botSessionMaxSec     = 40 * 60
	botOfflineMinSec     = 2 * 60
	botOfflineMaxSec     = 8 * 60
	botWarmupMaxSec      = 15 * 60
)

// --- Virtual clock --------------------------------------------------------

type vclock struct {
	t time.Time
}

func (c *vclock) Now() time.Time { return c.t }

// --- Strategy & player state --------------------------------------------

type strategyKind int

const (
	kindFixedPeriod strategyKind = iota // deterministic real player
	kindOneShot                         // burst once at arriveAt, then AFK
	kindNever                           // control: never inserts
	kindProdBot                         // PROD-faithful bot behavior
)

type strategy struct {
	name string
	kind strategyKind

	period         float64 // kindFixedPeriod only
	coinsPerInsert int     // kindFixedPeriod, kindOneShot

	arriveAt float64 // sim-seconds. Real-player join time. Default 0.
	leaveAt  float64 // sim-seconds. Real-player leave time. 0 = until end.

	isBot bool
}

type playerState struct {
	id       uuid.UUID
	strat    strategy
	inserted int
	received float64

	// Runtime mutable.
	nextInsertAt float64 // -1 if no more events scheduled

	// PROD bot state machine.
	sessionEndsAt float64
	isOnline      bool
}

// --- Sampling helpers (PROD bot behavior) -------------------------------

func sampleBotAmount(rng *rand.Rand) int {
	return botInsertAmountMin + rng.Intn(botInsertAmountMax-botInsertAmountMin+1)
}

func sampleBotInterval(rng *rand.Rand) float64 {
	v := rng.NormFloat64()*botIntervalStdDevSec + botIntervalMeanSec
	if v < botIntervalMinSec {
		v = botIntervalMinSec
	}
	if v > botIntervalMaxSec {
		v = botIntervalMaxSec
	}
	return v
}

func sampleBotSession(rng *rand.Rand) float64 {
	return float64(botSessionMinSec + rng.Intn(botSessionMaxSec-botSessionMinSec+1))
}

func sampleBotOffline(rng *rand.Rand) float64 {
	return float64(botOfflineMinSec + rng.Intn(botOfflineMaxSec-botOfflineMinSec+1))
}

// --- Sim core -----------------------------------------------------------

type simConfig struct {
	durationSec   float64
	dropPerSec    float64
	dropTickSec   float64
	pruneEverySec float64
	warmupSec     float64 // run bots-only for this long before measuring; real players' arriveAt is offset by this
	startTime     time.Time
}

func defaultConfig() simConfig {
	return simConfig{
		durationSec:   3600,
		dropPerSec:    1.0,
		dropTickSec:   1.0,
		pruneEverySec: 60.0,
		warmupSec:     900, // 15 min: matches bot scheduler warmup envelope (5-15 min stagger)
		startTime:     time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
}

func runSim(cfg simConfig, strategies []strategy, rng *rand.Rand, opts ...heat.Option) []playerState {
	clk := &vclock{t: cfg.startTime}
	engine := heat.NewWithClock(clk.Now, opts...)

	players := make([]playerState, len(strategies))
	for i, s := range strategies {
		p := playerState{id: uuid.New(), strat: s}
		switch s.kind {
		case kindFixedPeriod, kindOneShot:
			p.nextInsertAt = s.arriveAt
		case kindNever:
			p.nextInsertAt = -1
		case kindProdBot:
			// Warmup: stagger first insert across [0, warmupMax] so cold
			// restart doesn't synchronize bot fire moments.
			warmup := rng.Float64() * botWarmupMaxSec
			p.nextInsertAt = warmup
			p.sessionEndsAt = warmup + sampleBotSession(rng)
			p.isOnline = true
		}
		players[i] = p
	}

	pruneCounter := 0
	for simNow := 0.0; simNow <= cfg.durationSec; simNow += cfg.dropTickSec {
		clk.t = cfg.startTime.Add(time.Duration(simNow * float64(time.Second)))

		for i := range players {
			p := &players[i]

			// Bot session transitions.
			if p.strat.kind == kindProdBot && simNow >= p.sessionEndsAt {
				if p.isOnline {
					p.isOnline = false
					p.sessionEndsAt = simNow + sampleBotOffline(rng)
					p.nextInsertAt = -1
				} else {
					p.isOnline = true
					p.sessionEndsAt = simNow + sampleBotSession(rng)
					p.nextInsertAt = simNow + sampleBotInterval(rng)
				}
			}

			// Real-player leaving stops their schedule.
			if !p.strat.isBot && p.strat.leaveAt > 0 && simNow >= p.strat.leaveAt {
				p.nextInsertAt = -1
			}

			// Fire any inserts whose time has come.
			for p.nextInsertAt >= 0 && p.nextInsertAt <= simNow {
				eventTime := p.nextInsertAt
				clk.t = cfg.startTime.Add(time.Duration(eventTime * float64(time.Second)))

				amount := p.strat.coinsPerInsert
				if p.strat.kind == kindProdBot {
					amount = sampleBotAmount(rng)
				}

				if p.strat.isBot {
					engine.AddHeatForBot(p.id, amount)
				} else {
					engine.AddHeat(p.id, amount)
				}
				p.inserted += amount

				// Schedule next insert.
				switch p.strat.kind {
				case kindFixedPeriod:
					next := eventTime + p.strat.period
					if p.strat.leaveAt > 0 && next >= p.strat.leaveAt {
						p.nextInsertAt = -1
					} else {
						p.nextInsertAt = next
					}
				case kindOneShot:
					p.nextInsertAt = -1
				case kindProdBot:
					if p.isOnline {
						p.nextInsertAt = eventTime + sampleBotInterval(rng)
					} else {
						p.nextInsertAt = -1
					}
				default:
					p.nextInsertAt = -1
				}
			}
		}

		clk.t = cfg.startTime.Add(time.Duration(simNow * float64(time.Second)))
		drops := int(cfg.dropPerSec * cfg.dropTickSec)
		if drops > 0 {
			dist := engine.DistributeFrontEdgeDrop(drops)
			for i := range players {
				players[i].received += dist[players[i].id]
			}
		}

		pruneCounter++
		if cfg.pruneEverySec > 0 && float64(pruneCounter)*cfg.dropTickSec >= cfg.pruneEverySec {
			engine.Prune()
			pruneCounter = 0
		}
	}

	return players
}

// --- Reporting ----------------------------------------------------------

func report(out *os.File, label string, results []playerState, cfg simConfig) {
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

	totalInsertedReal := 0
	totalReceivedReal := 0.0
	totalDropPool := cfg.durationSec * cfg.dropPerSec

	fmt.Fprintf(out, "=== %s ===\n", label)
	fmt.Fprintf(out, "  duration=%.0fs  drop=%.2fc/s  pool=%.0f\n", cfg.durationSec, cfg.dropPerSec, totalDropPool)
	fmt.Fprintf(out, "%-22s %-4s %-9s %-10s %-8s %-8s\n", "strategy", "kind", "inserted", "received", "RTP%", "verdict")
	fmt.Fprintf(out, "%-22s %-4s %-9s %-10s %-8s %-8s\n", strings.Repeat("-", 22), "----", strings.Repeat("-", 9), strings.Repeat("-", 10), strings.Repeat("-", 8), strings.Repeat("-", 8))
	for _, p := range results {
		kind := "real"
		if p.strat.isBot {
			kind = "bot"
		}
		var rtpStr, verdict string
		if p.inserted == 0 {
			rtpStr = "—"
			verdict = "—"
		} else {
			rtp := p.received / float64(p.inserted) * 100
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
			totalInsertedReal += p.inserted
			totalReceivedReal += p.received
		}
	}
	if totalInsertedReal > 0 {
		fmt.Fprintf(out, "real aggregate RTP: %.1f%%  (%.2f / %d)\n",
			totalReceivedReal/float64(totalInsertedReal)*100, totalReceivedReal, totalInsertedReal)
	}
	fmt.Fprintf(out, "drop pool consumed: %.2f / %.0f (%.1f%%)\n\n",
		sumReceived(results), totalDropPool, sumReceived(results)/totalDropPool*100)
}

func sumReceived(results []playerState) float64 {
	var s float64
	for _, p := range results {
		s += p.received
	}
	return s
}

// --- PROD-bot strategy helpers ------------------------------------------

func prodBots(n int) []strategy {
	out := make([]strategy, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, strategy{
			name:  fmt.Sprintf("bot-%d", i+1),
			kind:  kindProdBot,
			isBot: true,
		})
	}
	return out
}

// --- Scenarios ----------------------------------------------------------

type scenarioPlan struct {
	label    string
	strats   []strategy
	cfg      simConfig
}

// Scenario A: empty regime — 0 real, 3 bots online (matches PROD
// crowd_scale[0]=3). 1 hour. Verifies bot-only steady state.
func scenarioA() scenarioPlan {
	cfg := defaultConfig()
	cfg.durationSec = 3600
	return scenarioPlan{
		label:  "A: empty (0 real, 3 bots, 1h) — bot-only baseline",
		strats: prodBots(3),
		cfg:    cfg,
	}
}

// Scenario B: one real player visits with a small-investment strategy. PROD
// crowd_scale[1]=4 → 4 bots online. We sweep multiple strategies (each in
// its own sub-run because in low-traffic regime only 1 real is present at a
// time).
func scenarioB() []scenarioPlan {
	tests := []strategy{
		{name: "drive-by-1", kind: kindOneShot, coinsPerInsert: 1},
		{name: "drive-by-10", kind: kindOneShot, coinsPerInsert: 10},
		{name: "drive-by-50", kind: kindOneShot, coinsPerInsert: 50},
		{name: "drive-by-200", kind: kindOneShot, coinsPerInsert: 200},
		{name: "heartbeat-1c-60s", kind: kindFixedPeriod, period: 60, coinsPerInsert: 1},
		{name: "heartbeat-1c-30s", kind: kindFixedPeriod, period: 30, coinsPerInsert: 1},
		{name: "heartbeat-2c-60s", kind: kindFixedPeriod, period: 60, coinsPerInsert: 2},
		{name: "heartbeat-3c-60s", kind: kindFixedPeriod, period: 60, coinsPerInsert: 3},
		{name: "constant-low-5c-30s", kind: kindFixedPeriod, period: 30, coinsPerInsert: 5},
	}
	plans := make([]scenarioPlan, 0, len(tests))
	for _, t := range tests {
		cfg := defaultConfig()
		cfg.durationSec = 3600
		strats := append([]strategy{t}, prodBots(4)...)
		plans = append(plans, scenarioPlan{
			label:  fmt.Sprintf("B[%s]: 1 real + 4 bots, 1h", t.name),
			strats: strats,
			cfg:    cfg,
		})
	}
	return plans
}

// Scenario C: 24h. 1 real visits once per hour for 5min, inserting 5 coins
// every 30s during the visit. 4 bots throughout. Tests cumulative RTP for
// the "occasional player" regime.
func scenarioC() scenarioPlan {
	cfg := defaultConfig()
	cfg.durationSec = 24 * 3600
	const visitDur = 300.0
	const visitGap = 3600.0
	const visitInsert = 5
	const visitPeriod = 30.0

	var strats []strategy
	for i := 0; i < 24; i++ {
		arrive := float64(i) * visitGap
		strats = append(strats, strategy{
			name:           fmt.Sprintf("visit-%02d", i+1),
			kind:           kindFixedPeriod,
			period:         visitPeriod,
			coinsPerInsert: visitInsert,
			arriveAt:       arrive,
			leaveAt:        arrive + visitDur,
		})
	}
	strats = append(strats, prodBots(4)...)
	return scenarioPlan{
		label:  "C: occasional real — 24×5min visits over 24h + 4 bots",
		strats: strats,
		cfg:    cfg,
	}
}

// Scenario D: 3 real players coexist (2 burst, 1 heartbeat) + 4 bots. Tests
// cross-real-player cross-subsidy: do RTPs stay symmetric for symmetric
// strategies, and do heartbeat exploiters still leak when other reals are
// present?
func scenarioD() scenarioPlan {
	cfg := defaultConfig()
	cfg.durationSec = 3600
	strats := []strategy{
		{name: "real-A-burst-50", kind: kindOneShot, coinsPerInsert: 50, arriveAt: 0},
		{name: "real-B-burst-50", kind: kindOneShot, coinsPerInsert: 50, arriveAt: 60},
		{name: "real-C-heartbeat-1c-60s", kind: kindFixedPeriod, period: 60, coinsPerInsert: 1, arriveAt: 0},
	}
	strats = append(strats, prodBots(4)...)
	return scenarioPlan{
		label:  "D: 2 burst + 1 heartbeat (3 real coexist) + 4 bots, 1h",
		strats: strats,
		cfg:    cfg,
	}
}

// Scenario E: 1 whale + 3 small reals (staggered 5-min visits) + 4 bots.
// Tests the α=0.95 regime that scenarios A-D didn't model: under near-linear
// share-by-eff, does a sustained whale crowd small players out of the share
// distribution?
//
// Pass criteria (operator-judged from RTP table):
//   - small-real RTP ≥ 20% (small players still feel rewarded)
//   - whale RTP ≤ 70% (no monopoly)
//   - Σ real RTP < 100% (no aggregate leak vs bot drop pool)
//
// Each small real visits for 5 min (10 inserts × 5 coins = 50 coins). Visits
// stagger so each small player is alone-with-whale, not competing with other
// small players — the worst case for whale dominance.
func scenarioE() scenarioPlan {
	cfg := defaultConfig()
	cfg.durationSec = 3600
	const smallVisitDur = 300.0 // 5 min
	strats := []strategy{
		{name: "whale-1000c-30s", kind: kindFixedPeriod, period: 30, coinsPerInsert: 1000, arriveAt: 0},
		{name: "small-A-5c-30s", kind: kindFixedPeriod, period: 30, coinsPerInsert: 5, arriveAt: 0, leaveAt: smallVisitDur},
		{name: "small-B-5c-30s", kind: kindFixedPeriod, period: 30, coinsPerInsert: 5, arriveAt: 600, leaveAt: 600 + smallVisitDur},
		{name: "small-C-5c-30s", kind: kindFixedPeriod, period: 30, coinsPerInsert: 5, arriveAt: 1200, leaveAt: 1200 + smallVisitDur},
	}
	strats = append(strats, prodBots(4)...)
	return scenarioPlan{
		label:  "E: 1 whale (sustained) + 3 small reals (staggered 5min visits) + 4 bots, 1h",
		strats: strats,
		cfg:    cfg,
	}
}

// --- Main ---------------------------------------------------------------

func main() {
	var (
		// CLI defaults track heat.go's New() defaults (combo: B+C). Override
		// any flag to study a single-mechanism alternative or the legacy
		// (pre-combo) behavior.
		guaranteed   = flag.Float64("guaranteed", 0.0, "per-real guaranteed floor share (PROD default 0)")
		halfLife     = flag.Float64("half-life", 180, "heat half-life seconds")
		alpha        = flag.Float64("alpha", 0.95, "diminishing-returns exponent (combo default 0.95; legacy 0.7)")
		threshold    = flag.Float64("floor-threshold", 10, "decayed-heat threshold for full floor")
		coinHalfLife = flag.Float64("coin-half-life", 30, "activity-driven decay: coins from others to halve heat. 0 disables. (combo default 30)")
		seed         = flag.Int64("seed", 42, "RNG seed for reproducibility")
		drop         = flag.Float64("drop-rate", 1.0, "front-edge coins per simulated second")
		scenario     = flag.String("scenario", "all", "scenario: A | B | C | D | E | all")
	)
	flag.Parse()

	opts := []heat.Option{
		heat.WithGuaranteed(*guaranteed),
		heat.WithHalfLife(*halfLife),
		heat.WithAlpha(*alpha),
		heat.WithFloorThreshold(*threshold),
		heat.WithCoinHalfLife(*coinHalfLife),
	}

	rng := rand.New(rand.NewSource(*seed))

	fmt.Printf("Heat config: guaranteed=%.3f half-life=%.0fs alpha=%.2f floor-threshold=%.1f coin-half-life=%.0f seed=%d drop=%.2fc/s\n\n",
		*guaranteed, *halfLife, *alpha, *threshold, *coinHalfLife, *seed, *drop)

	exec := func(plan scenarioPlan) {
		plan.cfg.dropPerSec = *drop
		// Apply bot warmup: extend total duration and shift every real-player
		// arriveAt/leaveAt forward so that bots reach steady state before
		// measurement begins. Without this, scenarios show inflated cold-start
		// RTP for any real strategy with arriveAt=0 because they monopolize
		// drops while the 4-15 min bot warmup stagger is still in effect.
		if plan.cfg.warmupSec > 0 {
			plan.cfg.durationSec += plan.cfg.warmupSec
			for i := range plan.strats {
				if !plan.strats[i].isBot {
					plan.strats[i].arriveAt += plan.cfg.warmupSec
					if plan.strats[i].leaveAt > 0 {
						plan.strats[i].leaveAt += plan.cfg.warmupSec
					}
				}
			}
		}
		results := runSim(plan.cfg, plan.strats, rng, opts...)
		report(os.Stdout, plan.label, results, plan.cfg)
	}

	switch strings.ToUpper(*scenario) {
	case "A":
		exec(scenarioA())
	case "B":
		for _, p := range scenarioB() {
			exec(p)
		}
	case "C":
		exec(scenarioC())
	case "D":
		exec(scenarioD())
	case "E":
		exec(scenarioE())
	case "ALL":
		exec(scenarioA())
		for _, p := range scenarioB() {
			exec(p)
		}
		exec(scenarioC())
		exec(scenarioD())
		exec(scenarioE())
	default:
		fmt.Fprintf(os.Stderr, "unknown scenario %q (use A | B | C | D | E | all)\n", *scenario)
		os.Exit(1)
	}
}
