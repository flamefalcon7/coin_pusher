import { SimLoop, DEFAULT_CONFIG, type SimLoopConfig } from "./SimLoop.js";
import { Statistics } from "./Statistics.js";
import { ALL_ABILITIES, NO_ABILITIES, type AbilitySet } from "./AbilitySimulator.js";

// ── CLI Argument Parsing ─────────────────────────────────────────

function parseArgs(): { trials: number; config: Partial<SimLoopConfig> } {
  const args = process.argv.slice(2);
  let trials = 100;
  const config: Partial<SimLoopConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--trials":
      case "-n":
        trials = parseInt(next, 10);
        i++;
        break;
      case "--coins":
        config.coinsPerTrial = parseInt(next, 10);
        i++;
        break;
      case "--interval":
        config.coinInsertIntervalTicks = parseInt(next, 10);
        i++;
        break;
      case "--warmup":
        config.warmupCoins = parseInt(next, 10);
        i++;
        break;
      case "--settle":
        config.warmupSettleTicks = parseInt(next, 10);
        i++;
        break;
      case "--abilities":
        if (next === "all") {
          config.abilities = ALL_ABILITIES;
        } else if (next === "none") {
          config.abilities = NO_ABILITIES;
        } else {
          // Comma-separated: tornado,explosion,lightning,shock,superPush
          const set: AbilitySet = { ...NO_ABILITIES };
          for (const a of next.split(",")) {
            const key = a.trim() as keyof AbilitySet;
            if (key in set) set[key] = true;
          }
          config.abilities = set;
        }
        i++;
        break;
      case "--ability-interval":
        config.abilityIntervalTicks = parseInt(next, 10);
        i++;
        break;
      case "--max-bonus-depth":
        config.maxBonusDepth = parseInt(next, 10);
        i++;
        break;
      case "--drain-timeout":
        config.drainTimeoutTicks = parseInt(next, 10);
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        log(`Unknown argument: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  return { trials, config };
}

function printHelp(): void {
  log(`
Monte Carlo RTP Simulation

Usage: pnpm exec tsx game/server/src/simulation/run.ts [options]

Options:
  --trials, -n <N>        Number of trials (default: 100)
  --coins <N>             Player coins per trial (default: ${DEFAULT_CONFIG.coinsPerTrial})
  --interval <ticks>      Ticks between coin inserts (default: ${DEFAULT_CONFIG.coinInsertIntervalTicks})
  --warmup <N>            Warmup coins to pre-fill (default: ${DEFAULT_CONFIG.warmupCoins})
  --settle <ticks>        Warmup settle ticks (default: ${DEFAULT_CONFIG.warmupSettleTicks})
  --abilities <spec>      "all", "none", or comma-separated (default: none)
                          e.g. "tornado,explosion,superPush"
  --ability-interval <t>  Ticks between ability fires (default: ${DEFAULT_CONFIG.abilityIntervalTicks})
  --max-bonus-depth <N>   Max slot recursion depth (default: ${DEFAULT_CONFIG.maxBonusDepth})
  --drain-timeout <ticks> Max ticks to wait for coins to clear after insertion (default: ${DEFAULT_CONFIG.drainTimeoutTicks})
  --help, -h              Show this help

Output:
  Progress → stderr, JSON report → stdout
`);
}

// ── Logging (stderr so stdout stays clean for JSON) ──────────────

function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

// ── Mute/unmute console during simulation (silence Rapier/Pusher/SceneBuilder) ──

const _origLog = console.log;
const _origWarn = console.warn;

function mute(): void {
  console.log = () => {};
  console.warn = () => {};
}

function unmute(): void {
  console.log = _origLog;
  console.warn = _origWarn;
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { trials, config } = parseArgs();
  const merged = { ...DEFAULT_CONFIG, ...config };

  log(`🎰 Monte Carlo RTP Simulation`);
  log(`   Trials: ${trials}`);
  log(`   Coins/trial: ${merged.coinsPerTrial}`);
  log(`   Insert interval: ${merged.coinInsertIntervalTicks} ticks`);
  log(`   Warmup: ${merged.warmupCoins} coins, ${merged.warmupSettleTicks} ticks settle`);
  log(`   Abilities: ${JSON.stringify(merged.abilities)}`);
  log(`   Max bonus depth: ${merged.maxBonusDepth}`);
  log(``);

  const stats = new Statistics();
  const simLoop = new SimLoop(config);
  const startReal = Date.now();

  for (let i = 0; i < trials; i++) {
    const trialStart = Date.now();
    mute();
    const result = await simLoop.runTrial();
    unmute();
    const trialMs = Date.now() - trialStart;

    stats.addTrial(result);

    const trialRTP = result.coinsInserted > 0
      ? ((result.frontEdgeCoins + result.bonusFrontEdge) / result.coinsInserted * 100).toFixed(1)
      : "N/A";

    // Progress every trial or every 10th trial if >100
    if (trials <= 100 || (i + 1) % 10 === 0 || i === trials - 1) {
      const elapsed = ((Date.now() - startReal) / 1000).toFixed(1);
      const eta = i > 0
        ? (((Date.now() - startReal) / (i + 1)) * (trials - i - 1) / 1000).toFixed(0)
        : "?";
      log(
        `  [${String(i + 1).padStart(String(trials).length)}/${trials}] ` +
        `RTP=${trialRTP}% | ` +
        `inserted=${result.coinsInserted} front=${result.frontEdgeCoins} left=${result.leftWallCoins} lost=${result.lostCoins} ` +
        `bonus=${result.bonusCoinsSpawned} bonusFront=${result.bonusFrontEdge} ` +
        `spins=${result.slotSpins} jackpots=${result.slotJackpots} | ` +
        `${trialMs}ms | ${elapsed}s elapsed, ~${eta}s remaining`
      );
    }
  }

  const totalMs = Date.now() - startReal;
  log(``);
  log(`✅ Done in ${(totalMs / 1000).toFixed(1)}s`);

  // Generate report
  const report = stats.report();

  log(``);
  log(`📊 Summary:`);
  log(`   RTP: ${report.rtpPercent.toFixed(2)}% (95% CI: ${report.ci95Lower.toFixed(2)}% – ${report.ci95Upper.toFixed(2)}%)`);
  log(`   Slot trigger rate: ${(report.slotTriggerRate * 100).toFixed(2)}%`);
  log(`   Jackpot rate: ${isNaN(report.jackpotRate) ? "N/A (no spins)" : (report.jackpotRate * 100).toFixed(2) + "%"}`);
  log(`   Bonus recursion ratio (p_l_b): ${report.bonusRecursionRatio.toFixed(4)}`);

  // JSON to stdout (pipe-friendly)
  // Remove perTrialRTP from JSON to keep output manageable — or include it
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
