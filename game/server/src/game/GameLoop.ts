import type { PhysicsWorld } from "../physics/PhysicsWorld.js";
import type { Pusher } from "../physics/Pusher.js";
import { Coin } from "../physics/Coin.js";
import type { GameState } from "./GameState.js";
import type { CoinManager } from "./CoinManager.js";
import type { NATSClient } from "../nats/NATSClient.js";
import type { DropScheduler } from "./DropScheduler.js";
import type {
  StateDeltaMessage,
  DespawnMessage,
  StateUpdate,
  SlotSymbol,
} from "@coin-pusher/shared";
import { PHYSICS_CONFIG, SCENE_CONFIG, COIN_CONFIG, PUSHER_CONFIG, RATE_LIMIT_CONFIG, SLOT_MACHINE_CONFIG, DespawnZone } from "@coin-pusher/shared";
import { PHYSICS_PARAMS } from "../physics/config.js";

export class GameLoop {
  private physicsWorld: PhysicsWorld;
  private pusher: Pusher;
  private gameState: GameState;
  private coinManager: CoinManager;
  private natsClient: NATSClient;
  private dropScheduler: DropScheduler;
  private coins: Map<number, Coin> = new Map();
  private coinOwners: Map<number, string> = new Map(); // coinId → userId
  private running: boolean = false;
  private intervalId?: NodeJS.Timeout;
  private statsIntervalId?: NodeJS.Timeout;
  private tickCount: number = 0;

  // Quantize factor cached (avoid Math.pow every tick per coin)
  private static readonly Q_FACTOR = 1000; // 10^3

  // Pre-allocated reusable arrays to reduce GC pressure
  private updates: StateUpdate[] = [];
  private despawnIds: number[] = [];

  // Tornado state
  private tornadoActive: boolean = false;
  private tornadoCenter: { x: number; z: number } = { x: 0, z: 0 };
  private tornadoStartTime: number = 0;
  private static readonly TORNADO_DURATION = RATE_LIMIT_CONFIG.TORNADO_DURATION;
  private static readonly TORNADO_RADIUS = 0.4;

  // Lightning storm state
  private lightningActive: boolean = false;
  private lightningStartTime: number = 0;
  private lightningTickCounter: number = 0;
  private static readonly LIGHTNING_DURATION = 3000; // ms

  // Slot machine state
  private slotCounter: number = 0;
  private slotSpinning: boolean = false;

  // Tick timing stats
  private tickTimings: number[] = [];
  private static readonly TIMING_WINDOW = 300; // samples (~10s at 30Hz)

  // Per-phase profiling accumulators (reset every TIMING_WINDOW)
  private profilePusher: number[] = [];
  private profileCoinUpdate: number[] = [];
  private profilePhysics: number[] = [];
  private profileStateCollect: number[] = [];
  private profileDespawn: number[] = [];
  private profilePublish: number[] = [];
  private profileActiveCounts: number[] = [];
  private profileSleepingCounts: number[] = [];

  constructor(
    physicsWorld: PhysicsWorld,
    pusher: Pusher,
    gameState: GameState,
    coinManager: CoinManager,
    natsClient: NATSClient,
    dropScheduler: DropScheduler
  ) {
    this.physicsWorld = physicsWorld;
    this.pusher = pusher;
    this.gameState = gameState;
    this.coinManager = coinManager;
    this.natsClient = natsClient;
    this.dropScheduler = dropScheduler;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    console.log(`🎮 Game loop started at ${PHYSICS_CONFIG.TICK_RATE}Hz`);

    // Use setInterval for fixed tick rate
    this.intervalId = setInterval(() => {
      this.tick();
    }, PHYSICS_CONFIG.TICK_INTERVAL);

    // Start periodic stats logging (every 10 seconds)
    this.statsIntervalId = setInterval(() => {
      this.logStats();
    }, 10000);
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    if (this.statsIntervalId) {
      clearInterval(this.statsIntervalId);
    }
    console.log("🛑 Game loop stopped");
  }

  private tick(): void {
    const tickStart = performance.now();

    // 1. Update pusher position
    this.pusher.update();
    const tAfterPusher = performance.now();

    // 1b. Check drop scheduler for next coin to drop
    const drop = this.dropScheduler.tick();
    if (drop) {
      const spawnZ = SCENE_CONFIG.BACK_WALL.POSITION.z;
      const coinId = this.coinManager.spawnCoin(drop.slotX, COIN_CONFIG.SPAWN_HEIGHT, spawnZ);
      if (coinId !== null) {
        const coin = new Coin(this.physicsWorld, coinId, drop.slotX, COIN_CONFIG.SPAWN_HEIGHT, spawnZ);
        this.addCoin(coin);
        this.coinOwners.set(coinId, drop.userId);
        // Publish coin_spawn event
        this.natsClient.publishCoinSpawn({
          op: "coin_spawn",
          coins: [{ id: coinId, owner_id: drop.userId }],
        });
      }
    }

    // 1c. Update tornado / lightning forces (before physics step)
    this.updateTornado();
    this.updateLightning();

    // 2. Pre-sleep check for coins (CCD management) BEFORE physics step
    this.coins.forEach((coin) => coin.update());
    const tAfterCoinUpdate = performance.now();

    // 3. Step physics simulation
    this.physicsWorld.step();
    const tAfterPhysics = performance.now();

    // 4. Despawn check + optional state collection
    //    Despawn runs every tick; state collection only on network-send ticks
    const updates = this.updates;
    const despawnIds = this.despawnIds;
    updates.length = 0;
    despawnIds.length = 0;
    const f = GameLoop.Q_FACTOR;
    let sleepingCount = 0;
    const classifiedDespawns: { id: number; zone: string; owner_id: string }[] = [];
    const isNetworkTick = (this.tickCount + 1) % PHYSICS_CONFIG.NETWORK_SEND_INTERVAL === 0;

    // Despawn + state collection only on network ticks (15Hz instead of 30Hz)
    // Saves ~600 translation() WASM calls per skipped tick
    if (isNetworkTick) {
      this.coins.forEach((coin, id) => {
        // Despawn check — reuse pos for state collection below
        const pos = coin.getPosition();

        if (pos.y < COIN_CONFIG.DESPAWN_Y) {
          let zone: string;

          if (pos.z > SLOT_MACHINE_CONFIG.Z_MAX_THRESHOLD) {
            zone = DespawnZone.FRONT_EDGE;
          } else if (pos.x < SLOT_MACHINE_CONFIG.X_THRESHOLD && pos.z < SLOT_MACHINE_CONFIG.Z_MAX_THRESHOLD) {
            zone = DespawnZone.LEFT_WALL;
            this.onLeftWallCoinDespawn();
          } else if (pos.x > -SLOT_MACHINE_CONFIG.X_THRESHOLD && pos.z < SLOT_MACHINE_CONFIG.Z_MAX_THRESHOLD) {
            zone = DespawnZone.RIGHT_WALL;
          } else {
            zone = DespawnZone.OTHER;
          }

          despawnIds.push(id);
          classifiedDespawns.push({
            id,
            zone,
            owner_id: this.coinOwners.get(id) ?? "",
          });
          return;
        }

        // Skip sleeping coins — their position hasn't changed
        if (coin.isSleeping()) {
          sleepingCount++;
          return;
        }

        const rot = coin.getRotation();

        // Update game state
        this.coinManager.updateCoin(
          id,
          [pos.x, pos.y, pos.z],
          [rot.x, rot.y, rot.z, rot.w]
        );

        // Quantize to 3 decimal places; protobuf float fields handle float32 natively
        updates.push({
          id,
          pos: [
            Math.round(pos.x * f) / f,
            Math.round(pos.y * f) / f,
            Math.round(pos.z * f) / f,
          ],
          rot: [
            Math.round(rot.x * f) / f,
            Math.round(rot.y * f) / f,
            Math.round(rot.z * f) / f,
            Math.round(rot.w * f) / f,
          ],
        });
      });
    }
    const tAfterStateCollect = performance.now();

    // 5. Handle despawns
    if (despawnIds.length > 0) {
      for (let i = 0; i < despawnIds.length; i++) {
        const id = despawnIds[i];
        const coin = this.coins.get(id);
        if (coin) {
          coin.destroy(this.physicsWorld);
          this.coins.delete(id);
          this.coinManager.removeCoin(id);
          this.coinOwners.delete(id);
        }
      }

      const despawnMessage: DespawnMessage = {
        op: "despawn",
        tick: this.gameState.getTick(),
        ids: despawnIds,
      };

      this.natsClient.publishDespawn(despawnMessage);
    }

    // 5b. Publish classified despawn events to NATS for backend processing
    if (classifiedDespawns.length > 0) {
      this.natsClient.publishCoinDespawn({
        coins: classifiedDespawns,
        tick: this.gameState.getTick(),
      });
    }
    const tAfterDespawn = performance.now();

    // 6. Update pusher z in game state
    const pusherZ = Math.round(this.pusher.getCurrentZ() * f) / f;
    this.gameState.updatePusherZ(pusherZ);

    this.tickCount++;

    // 7. Broadcast state delta at reduced rate (e.g. 15Hz) to halve outbound bandwidth
    if (this.tickCount % PHYSICS_CONFIG.NETWORK_SEND_INTERVAL === 0) {
      const stateDelta: StateDeltaMessage = {
        op: "state_delta",
        serverTime: Date.now(),
        tick: this.gameState.getTick(),
        updates,
        pusherZ,
      };
      this.natsClient.publishStateDelta(stateDelta);
    }
    const tAfterPublish = performance.now();

    // 8. Record per-phase timings
    const pusherMs = tAfterPusher - tickStart;
    const coinUpdateMs = tAfterCoinUpdate - tAfterPusher;
    const physicsMs = tAfterPhysics - tAfterCoinUpdate;
    const stateCollectMs = tAfterStateCollect - tAfterPhysics;
    const despawnMs = tAfterDespawn - tAfterStateCollect;
    const publishMs = tAfterPublish - tAfterDespawn;
    const tickMs = tAfterPublish - tickStart;

    this.tickTimings.push(tickMs);
    this.profilePusher.push(pusherMs);
    this.profileCoinUpdate.push(coinUpdateMs);
    this.profilePhysics.push(physicsMs);
    this.profileStateCollect.push(stateCollectMs);
    this.profileDespawn.push(despawnMs);
    this.profilePublish.push(publishMs);
    this.profileActiveCounts.push(updates.length);
    this.profileSleepingCounts.push(sleepingCount);

    if (this.tickTimings.length > GameLoop.TIMING_WINDOW) {
      this.tickTimings.shift();
      this.profilePusher.shift();
      this.profileCoinUpdate.shift();
      this.profilePhysics.shift();
      this.profileStateCollect.shift();
      this.profileDespawn.shift();
      this.profilePublish.shift();
      this.profileActiveCounts.shift();
      this.profileSleepingCounts.shift();
    }

    // Warn if tick exceeds budget (33.3ms at 30Hz)
    if (tickMs > PHYSICS_CONFIG.TICK_INTERVAL) {
      console.warn(
        `⚠️  Tick ${this.tickCount} overran: ${tickMs.toFixed(1)}ms ` +
          `(budget: ${PHYSICS_CONFIG.TICK_INTERVAL.toFixed(1)}ms) ` +
          `[physics: ${physicsMs.toFixed(1)}ms, coinUpdate: ${coinUpdateMs.toFixed(1)}ms, ` +
          `stateCollect: ${stateCollectMs.toFixed(1)}ms, publish: ${publishMs.toFixed(1)}ms, ` +
          `coins: ${this.coins.size}, active: ${updates.length}, sleeping: ${sleepingCount}]`
      );
    }

    // 9. Increment tick
    this.gameState.incrementTick();
  }

  private static percentiles(arr: number[]): { avg: number; p50: number; p95: number; p99: number; max: number } {
    if (arr.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = arr.slice().sort((a, b) => a - b);
    const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
    return {
      avg,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      max: sorted[sorted.length - 1],
    };
  }

  private static fmtMs(v: number): string {
    return v.toFixed(2);
  }

  private logStats(): void {
    const coinCount = this.coins.size;
    const n = this.tickTimings.length;
    if (n === 0) {
      this.tickCount = 0;
      return;
    }

    const fmt = GameLoop.fmtMs;
    const total = GameLoop.percentiles(this.tickTimings);
    const physics = GameLoop.percentiles(this.profilePhysics);
    const coinUpd = GameLoop.percentiles(this.profileCoinUpdate);
    const stateCol = GameLoop.percentiles(this.profileStateCollect);
    const desp = GameLoop.percentiles(this.profileDespawn);
    const pub = GameLoop.percentiles(this.profilePublish);
    const push = GameLoop.percentiles(this.profilePusher);

    const avgActive = this.profileActiveCounts.length > 0
      ? Math.round(this.profileActiveCounts.reduce((s, v) => s + v, 0) / this.profileActiveCounts.length)
      : 0;
    const avgSleeping = this.profileSleepingCounts.length > 0
      ? Math.round(this.profileSleepingCounts.reduce((s, v) => s + v, 0) / this.profileSleepingCounts.length)
      : 0;
    const overruns = this.tickTimings.filter((t) => t > PHYSICS_CONFIG.TICK_INTERVAL).length;

    // Calculate what % of total tick each phase takes (based on avg)
    const pctOf = (phase: number) => total.avg > 0 ? ((phase / total.avg) * 100).toFixed(0) : "0";

    console.log(
      `\n📊 PROFILING REPORT (${n} ticks, ${coinCount} coins: ${avgActive} active, ${avgSleeping} sleeping)\n` +
      `   Budget: ${fmt(PHYSICS_CONFIG.TICK_INTERVAL)}ms | Overruns: ${overruns}/${n}\n` +
      `   ─────────────────────────────────────────────────────────────\n` +
      `   Phase            │  avg      p50      p95      p99      max   │ % of tick\n` +
      `   ─────────────────┼──────────────────────────────────────────────┼──────────\n` +
      `   Total            │ ${fmt(total.avg).padStart(6)}  ${fmt(total.p50).padStart(6)}  ${fmt(total.p95).padStart(6)}  ${fmt(total.p99).padStart(6)}  ${fmt(total.max).padStart(6)}  │   100%\n` +
      `   Physics (Rapier) │ ${fmt(physics.avg).padStart(6)}  ${fmt(physics.p50).padStart(6)}  ${fmt(physics.p95).padStart(6)}  ${fmt(physics.p99).padStart(6)}  ${fmt(physics.max).padStart(6)}  │  ${pctOf(physics.avg).padStart(4)}%\n` +
      `   Coin update      │ ${fmt(coinUpd.avg).padStart(6)}  ${fmt(coinUpd.p50).padStart(6)}  ${fmt(coinUpd.p95).padStart(6)}  ${fmt(coinUpd.p99).padStart(6)}  ${fmt(coinUpd.max).padStart(6)}  │  ${pctOf(coinUpd.avg).padStart(4)}%\n` +
      `   State collect    │ ${fmt(stateCol.avg).padStart(6)}  ${fmt(stateCol.p50).padStart(6)}  ${fmt(stateCol.p95).padStart(6)}  ${fmt(stateCol.p99).padStart(6)}  ${fmt(stateCol.max).padStart(6)}  │  ${pctOf(stateCol.avg).padStart(4)}%\n` +
      `   Despawn          │ ${fmt(desp.avg).padStart(6)}  ${fmt(desp.p50).padStart(6)}  ${fmt(desp.p95).padStart(6)}  ${fmt(desp.p99).padStart(6)}  ${fmt(desp.max).padStart(6)}  │  ${pctOf(desp.avg).padStart(4)}%\n` +
      `   NATS publish     │ ${fmt(pub.avg).padStart(6)}  ${fmt(pub.p50).padStart(6)}  ${fmt(pub.p95).padStart(6)}  ${fmt(pub.p99).padStart(6)}  ${fmt(pub.max).padStart(6)}  │  ${pctOf(pub.avg).padStart(4)}%\n` +
      `   Pusher           │ ${fmt(push.avg).padStart(6)}  ${fmt(push.p50).padStart(6)}  ${fmt(push.p95).padStart(6)}  ${fmt(push.p99).padStart(6)}  ${fmt(push.max).padStart(6)}  │  ${pctOf(push.avg).padStart(4)}%\n` +
      `   ─────────────────────────────────────────────────────────────`
    );

    // Detailed sleep stats (when DEBUG_SLEEP enabled)
    if (PHYSICS_PARAMS.DEBUG_SLEEP) {
      let activeCoins = 0;
      let sleepingCoins = 0;
      let lowVelActiveCoins = 0;
      let totalLinVel = 0;
      let totalAngVel = 0;

      const linThresholdSq = PHYSICS_PARAMS.SLEEP_LINEAR_THRESHOLD ** 2;
      const angThresholdSq = PHYSICS_PARAMS.SLEEP_ANGULAR_THRESHOLD ** 2;

      this.coins.forEach((coin) => {
        const body = coin.getRigidBody();
        if (body.isSleeping()) {
          sleepingCoins++;
        } else {
          activeCoins++;
          const linvel = body.linvel();
          const angvel = body.angvel();

          const vSq = linvel.x ** 2 + linvel.y ** 2 + linvel.z ** 2;
          const wSq = angvel.x ** 2 + angvel.y ** 2 + angvel.z ** 2;

          totalLinVel += Math.sqrt(vSq);
          totalAngVel += Math.sqrt(wSq);

          if (vSq < linThresholdSq && wSq < angThresholdSq) {
            lowVelActiveCoins++;
          }
        }
      });

      const avgLinVel =
        activeCoins > 0 ? (totalLinVel / activeCoins).toFixed(3) : "0.000";
      const avgAngVel =
        activeCoins > 0 ? (totalAngVel / activeCoins).toFixed(3) : "0.000";

      console.log(
        `   Sleep: ${activeCoins} active (${lowVelActiveCoins} low-vel), ${sleepingCoins} sleeping\n` +
          `   Velocities (active): Lin: ${avgLinVel}, Ang: ${avgAngVel}`
      );
    }

    this.tickCount = 0;
  }

  addCoin(coin: Coin): void {
    this.coins.set(coin.getId(), coin);
  }

  clearAll(): void {
    const ids: number[] = [];
    this.coins.forEach((coin, id) => {
      coin.destroy(this.physicsWorld);
      this.coinManager.removeCoin(id);
      ids.push(id);
    });
    this.coins.clear();
    this.coinOwners.clear();

    if (ids.length > 0) {
      this.natsClient.publishDespawn({
        op: "despawn",
        tick: this.gameState.getTick(),
        ids,
      });
    }
    console.log(`Cleared all ${ids.length} coins`);
  }

  /** Fill the platform with hex-packed coins (1-2 layers, messy layout). */
  fillPlatform(): Coin[] {
    const { POSITION, DEPTH, WIDTH, FLARE_Z, FLARE_ANGLE, THICKNESS } = SCENE_CONFIG.PLATFORM;
    const surfaceY = POSITION.y + THICKNESS / 2;
    const frontZ = POSITION.z + DEPTH / 2;
    const hw = WIDTH / 2;
    const flareRad = FLARE_ANGLE * Math.PI / 180;

    const coinD = COIN_CONFIG.RADIUS * 2;
    const coinT = COIN_CONFIG.THICKNESS;
    // Hex grid: row spacing = coinD * sqrt(3)/2, column spacing = coinD
    const colSpacing = coinD;
    const rowSpacing = coinD * Math.sqrt(3) / 2;

    // Fill from just past pusher max reach to near front edge
    const pusherMaxZ = SCENE_CONFIG.PUSHER.POSITION.z
      + SCENE_CONFIG.PUSHER.DEPTH / 2
      + PUSHER_CONFIG.Z_OFFSET + PUSHER_CONFIG.AMPLITUDE;
    const zMin = pusherMaxZ + coinD;
    const zMax = frontZ - 0.02;
    const wallInset = 0.02;

    const spawned: Coin[] = [];
    let row = 0;

    for (let z = zMin; z <= zMax; z += rowSpacing) {
      // Platform half-width at this z
      let halfW: number;
      if (z < FLARE_Z) {
        halfW = hw;
      } else {
        halfW = hw + Math.tan(flareRad) * (z - FLARE_Z);
      }
      halfW -= wallInset;

      // Hex offset: odd rows shift by half a coin diameter
      const xOffset = (row % 2 === 1) ? coinD / 2 : 0;

      for (let x = -halfW + xOffset; x <= halfW; x += colSpacing) {
        if (x < -halfW || x > halfW) continue;
        // ~10% chance to skip this grid point for a messier look
        if (Math.random() < 0.1) continue;
        const layers = 1 + Math.floor(Math.random() * 2); // 1-2
        for (let layer = 0; layer < layers; layer++) {
          // Drop from above — stagger height by layer + random offset to avoid all spawning at once
          const dropHeight = 0.3 + layer * coinT * 3 + Math.random() * 0.1;
          const cy = surfaceY + dropHeight;
          const rx = x + (Math.random() - 0.5) * 0.06;
          const rz = z + (Math.random() - 0.5) * 0.06;

          // Small random Y-axis rotation for variety
          const angle = (Math.random() - 0.5) * Math.PI * 0.3;
          const rot: [number, number, number, number] = [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];

          const coinId = this.coinManager.spawnCoinUnchecked(rx, cy, rz, rot);
          const coin = new Coin(
            this.physicsWorld, coinId, rx, cy, rz,
            { x: rot[0], y: rot[1], z: rot[2], w: rot[3] }
          );
          this.addCoin(coin);
          spawned.push(coin);
        }
      }
      row++;
    }

    console.log(`Filled platform with ${spawned.length} coins`);
    return spawned;
  }

  startTornado(x: number, z: number): void {
    this.tornadoActive = true;
    this.tornadoCenter = { x, z };
    this.tornadoStartTime = performance.now();
    console.log(`🌪️  Tornado started at (${x.toFixed(2)}, ${z.toFixed(2)})`);
  }

  private updateTornado(): void {
    if (!this.tornadoActive) return;

    const elapsed = performance.now() - this.tornadoStartTime;
    if (elapsed > GameLoop.TORNADO_DURATION) {
      this.tornadoActive = false;
      console.log("🌪️  Tornado ended");
      return;
    }

    // Ramp multiplier: ramp up 0→1 in first 0.5s, hold 1.0, ramp down 1→0 in last 0.5s
    const rampUpEnd = 500;
    const rampDownStart = GameLoop.TORNADO_DURATION - 500;
    let ramp = 1.0;
    if (elapsed < rampUpEnd) {
      ramp = elapsed / rampUpEnd;
    } else if (elapsed > rampDownStart) {
      ramp = (GameLoop.TORNADO_DURATION - elapsed) / 500;
    }

    const cx = this.tornadoCenter.x;
    const cz = this.tornadoCenter.z;
    const radius = GameLoop.TORNADO_RADIUS;

    this.coins.forEach((coin) => {
      const pos = coin.getPosition();
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > radius) return;

      const body = coin.getRigidBody();
      body.wakeUp();

      const strength = (1 - dist / radius) * ramp;

      // Normalize direction toward center (avoid div by zero)
      const invDist = dist > 0.001 ? 1 / dist : 0;
      const nx = -dx * invDist;
      const nz = -dz * invDist;

      // Centripetal: pull toward center
      const centripetal = 0.008 * strength;
      // Tangential: perpendicular in XZ plane (creates spin)
      const tangential = 0.006 * strength;
      // Lift: height-capped to keep coins below wall top
      const maxTornadoY = 0.9;
      let lift: number;
      if (pos.y < maxTornadoY) {
        lift = 0.01 * strength;
      } else {
        lift = -0.004 * strength; // push back down
      }

      body.applyImpulse(
        {
          x: nx * centripetal + (-nz) * tangential,
          y: lift,
          z: nz * centripetal + nx * tangential,
        },
        true,
      );
    });
  }

  /** Instant one-shot explosion: blast coins outward + upward from center. */
  explode(x: number, z: number): void {
    const radius = 0.6;
    let affected = 0;

    this.coins.forEach((coin) => {
      const pos = coin.getPosition();
      const dx = pos.x - x;
      const dz = pos.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > radius) return;

      const body = coin.getRigidBody();
      body.wakeUp();

      // Quadratic falloff — center hits much harder than edges
      const t = 1 - dist / radius;
      const strength = t * t;

      // Normalize outward direction (avoid div by zero)
      const invDist = dist > 0.001 ? 1 / dist : 0;
      const nx = dx * invDist;
      const nz = dz * invDist;

      // Strong outward blast + upward launch + random scatter
      body.applyImpulse(
        {
          x: nx * 0.08 * strength + (Math.random() - 0.5) * 0.01,
          y: 0.06 * strength,
          z: nz * 0.08 * strength + (Math.random() - 0.5) * 0.01,
        },
        true,
      );

      // Random torque for tumbling
      body.applyTorqueImpulse(
        {
          x: (Math.random() - 0.5) * 0.002 * strength,
          y: (Math.random() - 0.5) * 0.002 * strength,
          z: (Math.random() - 0.5) * 0.002 * strength,
        },
        true,
      );
      affected++;
    });

    if (affected > 0) {
      console.log(`💥 Explosion at (${x.toFixed(2)}, ${z.toFixed(2)}): ${affected} coins affected`);
    }
  }

  /** Start a 3-second sustained lightning storm (like tornado pattern). */
  lightning(): void {
    this.lightningActive = true;
    this.lightningStartTime = performance.now();
    this.lightningTickCounter = 0;
    console.log("⚡ Lightning storm started");
  }

  private updateLightning(): void {
    if (!this.lightningActive) return;

    const elapsed = performance.now() - this.lightningStartTime;
    if (elapsed > GameLoop.LIGHTNING_DURATION) {
      this.lightningActive = false;
      console.log("⚡ Lightning storm ended");
      return;
    }

    // Strike every ~4 ticks (~133ms) → ~22 strikes over 3s
    this.lightningTickCounter++;
    if (this.lightningTickCounter % 4 !== 0) return;

    const { POSITION: PLAT_POS, DEPTH: PLAT_DEPTH, WIDTH, FLARE_Z, FLARE_ANGLE } = SCENE_CONFIG.PLATFORM;
    const { POSITION: PUSH_POS, DEPTH: PUSH_DEPTH } = SCENE_CONFIG.PUSHER;
    const hw = WIDTH / 2;
    const flareRad = FLARE_ANGLE * Math.PI / 180;

    // Full zone: pusher back edge to platform front edge
    const backZ = PUSH_POS.z - PUSH_DEPTH / 2;
    const frontZ = PLAT_POS.z + PLAT_DEPTH / 2;

    // Pick random strike position
    const sz = backZ + Math.random() * (frontZ - backZ);
    let halfW: number;
    if (sz < FLARE_Z) {
      halfW = hw;
    } else {
      halfW = hw + Math.tan(flareRad) * (sz - FLARE_Z);
    }
    halfW -= 0.05; // inset from walls
    const sx = (Math.random() * 2 - 1) * halfW;

    // Mini explosion at strike point — bigger radius & stronger impulse
    const radius = 0.35;
    let affected = 0;

    this.coins.forEach((coin) => {
      const pos = coin.getPosition();
      const dx = pos.x - sx;
      const dz = pos.z - sz;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > radius) return;

      const body = coin.getRigidBody();
      body.wakeUp();

      // Quadratic falloff
      const t = 1 - dist / radius;
      const strength = t * t;

      // Strong outward blast + upward launch
      const invDist = dist > 0.001 ? 1 / dist : 0;
      const nx = dx * invDist;
      const nz = dz * invDist;

      body.applyImpulse(
        {
          x: nx * 0.06 * strength + (Math.random() - 0.5) * 0.008,
          y: 0.055 * strength,
          z: nz * 0.06 * strength + (Math.random() - 0.5) * 0.008,
        },
        true,
      );

      // Torque for tumbling
      body.applyTorqueImpulse(
        {
          x: (Math.random() - 0.5) * 0.002 * strength,
          y: (Math.random() - 0.5) * 0.002 * strength,
          z: (Math.random() - 0.5) * 0.002 * strength,
        },
        true,
      );
      affected++;
    });

    if (affected > 0) {
      console.log(`⚡ Lightning strike at (${sx.toFixed(2)}, ${sz.toFixed(2)}): ${affected} coins`);
    }
  }

  // ── Slot Machine ──────────────────────────────────────────────────────

  private onLeftWallCoinDespawn(): void {
    if (this.slotSpinning) return;

    this.slotCounter++;
    this.natsClient.publishSlotCounter({
      op: "slot_counter",
      counter: this.slotCounter,
    });

    console.log(`🎰 Left wall coin #${this.slotCounter}/${SLOT_MACHINE_CONFIG.TRIGGER_COUNT}`);

    if (this.slotCounter >= SLOT_MACHINE_CONFIG.TRIGGER_COUNT) {
      this.triggerSlotSpin();
    }
  }

  private triggerSlotSpin(): void {
    this.slotSpinning = true;
    this.slotCounter = 0;

    // Pick 3 random symbols
    const symbols = SLOT_MACHINE_CONFIG.SYMBOLS;
    const reels: [SlotSymbol, SlotSymbol, SlotSymbol] = [
      symbols[Math.floor(Math.random() * symbols.length)],
      symbols[Math.floor(Math.random() * symbols.length)],
      symbols[Math.floor(Math.random() * symbols.length)],
    ];
    const jackpot = reels[0] === reels[1] && reels[1] === reels[2];

    // Publish counter reset
    this.natsClient.publishSlotCounter({ op: "slot_counter", counter: 0 });

    // Publish spin result
    this.natsClient.publishSlotSpin({
      op: "slot_spin",
      reels,
      jackpot,
    });

    console.log(`🎰 Spin: [${reels.join(", ")}] ${jackpot ? "🎉 JACKPOT!" : ""}`);

    if (jackpot) {
      // Wait for reel animation to finish, then spawn bonus coins
      setTimeout(() => {
        this.spawnBonusCoins();
        this.slotSpinning = false;
      }, SLOT_MACHINE_CONFIG.BONUS_SPAWN_DELAY);
    } else {
      // Allow next spin after animation completes
      setTimeout(() => {
        this.slotSpinning = false;
      }, SLOT_MACHINE_CONFIG.SPIN_DURATION);
    }
  }

  private spawnBonusCoins(): void {
    const count = SLOT_MACHINE_CONFIG.BONUS_AMOUNT;
    const interval = SLOT_MACHINE_CONFIG.BONUS_SPAWN_INTERVAL;

    console.log(`🎰 Spawning ${count} bonus coins...`);

    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        // Random X across platform width, high Y for rain effect
        const x = (Math.random() - 0.5) * SCENE_CONFIG.PLATFORM.WIDTH;
        const y = COIN_CONFIG.SPAWN_HEIGHT + 0.5 + Math.random() * 0.5;
        const z = SCENE_CONFIG.PLATFORM.POSITION.z + (Math.random() - 0.5) * 0.4;

        const angle = (Math.random() - 0.5) * Math.PI;
        const rot: { x: number; y: number; z: number; w: number } = {
          x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2),
        };

        const coinId = this.coinManager.spawnCoinUnchecked(x, y, z, [rot.x, rot.y, rot.z, rot.w]);
        const coin = new Coin(this.physicsWorld, coinId, x, y, z, rot);
        this.addCoin(coin);
      }, i * interval);
    }
  }

  shockPins(): void {
    // Pin zone bounds: coins stuck around the pins near the back wall
    const pinYMin = SCENE_CONFIG.PLATFORM.POSITION.y + SCENE_CONFIG.PINS.START_Y;
    const pinYMax = pinYMin + (SCENE_CONFIG.PINS.ROWS - 1) * SCENE_CONFIG.PINS.VERTICAL_SPACING + SCENE_CONFIG.PINS.Y_OFFSET;
    const backWallZ = SCENE_CONFIG.BACK_WALL.POSITION.z;
    const zThreshold = 0.25; // coins within 25cm of back wall

    let shocked = 0;
    this.coins.forEach((coin) => {
      const pos = coin.getPosition();

      // Check if coin is in the pin zone (near back wall, in pin Y range)
      if (pos.y >= pinYMin && pos.y <= pinYMax && pos.z < backWallZ + zThreshold) {
        const body = coin.getRigidBody();
        body.wakeUp();
        // Apply random impulse: forward (positive Z), slight downward, random lateral
        const impulse = {
          x: (Math.random() - 0.5) * 0.005,
          y: -0.002,
          z: 0.005 + Math.random() * 0.005,
        };
        body.applyImpulse(impulse, true);
        shocked++;
      }
    });

    if (shocked > 0) {
      console.log(`Shocked ${shocked} coins in pin zone`);
    }
  }
}
