import type { NATSClient } from "../nats/NATSClient.js";
import { COIN_CONFIG } from "@coin-pusher/shared";

export interface SponsorConfig {
  id: string;
  brand_name: string;
  token_symbol: string;
  brand_color: string;
  logo_url: string;
  ad_image_url: string;
  placement_tier?: "primary" | "secondary" | "tertiary";
}

export interface PendingQuota {
  quotaId: string;
  sponsorId: string;
  remaining: number;
  total: number;
}

/**
 * Callback provided by GameLoop to spawn a sponsor coin with both game state
 * and physics body creation. Returns the coinId, or null if spawn failed.
 */
export type SpawnSponsorCoinFn = (
  x: number,
  y: number,
  sponsorId: string,
) => number | null;

/** Spawn interval for tick-based quota draining: ~150 ticks at 30Hz = ~5 seconds. */
const QUOTA_SPAWN_INTERVAL_TICKS = 150;

/** Maximum coins per bonus drop to prevent resource exhaustion. */
const MAX_BONUS_DROP_COINS = 100;

/** Slot X positions for sponsor coin spawns (matches SLOT_CONFIG.POSITIONS). */
const SPONSOR_SLOT_POSITIONS = [-0.4, -0.2, 0, 0.2, 0.4];

export class SponsorManager {
  private natsClient: NATSClient;

  /** Callback to spawn a sponsor coin with physics body (set by GameLoop). */
  private spawnFn: SpawnSponsorCoinFn | null = null;

  /** Active sponsor configurations, keyed by sponsor id. */
  activeSponsors: Map<string, SponsorConfig> = new Map();

  /** Maps coinId to sponsorId for tracking despawns. */
  coinSponsorMap: Map<number, string> = new Map();

  /** Pending quotas received from backend, drained by tick(). */
  pendingQuotas: PendingQuota[] = [];

  /** Round-robin index for fair sponsor spawning across quotas. */
  sponsorRoundRobin: number = 0;

  /** Timers for bonus drop staggered spawns. */
  private bonusDropTimers: ReturnType<typeof setTimeout>[] = [];

  private readonly rng: () => number;

  /** @param rng session RNG — see DropScheduler for why this is not Math.random. */
  constructor(
    natsClient: NATSClient,
    rng: () => number = Math.random,
  ) {
    this.natsClient = natsClient;
    this.rng = rng;
  }

  /** Set the spawn callback (called by GameLoop after construction). */
  setSpawnFn(fn: SpawnSponsorCoinFn): void {
    this.spawnFn = fn;
  }

  /** Update activeSponsors map from NATS sponsor_config message. */
  onSponsorConfig(sponsors: SponsorConfig[]): void {
    this.activeSponsors.clear();
    for (const s of sponsors) {
      this.activeSponsors.set(s.id, s);
    }
    console.log(`Sponsor config updated: ${sponsors.length} sponsors active`);
  }

  /** Add a quota batch to the pending queue (received from backend via NATS). */
  onSponsorQuota(msg: { quota_id: string; sponsor_id: string; coin_count: number }): void {
    this.pendingQuotas.push({
      quotaId: msg.quota_id,
      sponsorId: msg.sponsor_id,
      remaining: msg.coin_count,
      total: msg.coin_count,
    });
    console.log(`Sponsor quota received: ${msg.quota_id} sponsor=${msg.sponsor_id} count=${msg.coin_count}`);
  }

  /**
   * Schedule a bonus drop: staggered spawn of sponsor coins (1 per 100ms).
   * These are event-driven bonus drops, not quota-based.
   */
  onBonusDrop(msg: { sponsor_id: string; coin_count: number }): void {
    const { sponsor_id } = msg;
    const coin_count = Math.min(msg.coin_count, MAX_BONUS_DROP_COINS);
    console.log(`Bonus drop: sponsor=${sponsor_id} count=${coin_count}`);

    for (let i = 0; i < coin_count; i++) {
      const timer = setTimeout(() => {
        this.spawnOneSponsorCoin(sponsor_id);
      }, i * 100);
      this.bonusDropTimers.push(timer);
    }
  }

  /**
   * Called every physics tick. Every ~150 ticks (~5s at 30Hz), drain one
   * coin from the next pending quota in round-robin order.
   */
  tick(tickCount: number): void {
    if (this.pendingQuotas.length === 0) return;
    if (tickCount % QUOTA_SPAWN_INTERVAL_TICKS !== 0) return;

    // Round-robin across pending quotas
    this.sponsorRoundRobin = this.sponsorRoundRobin % this.pendingQuotas.length;
    const quota = this.pendingQuotas[this.sponsorRoundRobin];

    // Spawn one coin for this quota's sponsor
    this.spawnOneSponsorCoin(quota.sponsorId);
    quota.remaining--;

    // If quota fully drained, publish consumed event and remove
    if (quota.remaining <= 0) {
      this.natsClient.publishSponsorQuotaConsumed({
        quota_id: quota.quotaId,
        coins_spawned: quota.total,
      });
      this.pendingQuotas.splice(this.sponsorRoundRobin, 1);
      // Adjust round-robin index after removal
      if (this.pendingQuotas.length > 0) {
        this.sponsorRoundRobin = this.sponsorRoundRobin % this.pendingQuotas.length;
      } else {
        this.sponsorRoundRobin = 0;
      }
    } else {
      this.sponsorRoundRobin = (this.sponsorRoundRobin + 1) % this.pendingQuotas.length;
    }
  }

  /**
   * Spawn a single sponsor coin at a random slot position.
   * Uses the spawn callback set by GameLoop to create both game state
   * and physics body. Registers the coin in coinSponsorMap for despawn tracking.
   */
  spawnOneSponsorCoin(sponsorId: string): void {
    if (!this.spawnFn) return;

    // Pick random slot X from the predefined positions
    const slotX = SPONSOR_SLOT_POSITIONS[Math.floor(this.rng() * SPONSOR_SLOT_POSITIONS.length)];

    const coinId = this.spawnFn(slotX, COIN_CONFIG.SPAWN_HEIGHT, sponsorId);

    if (coinId !== null) {
      this.coinSponsorMap.set(coinId, sponsorId);

      // Publish coin_spawn event with sponsor_id
      this.natsClient.publishCoinSpawn({
        op: "coin_spawn",
        coins: [{ id: coinId, owner_id: "", sponsor_id: sponsorId }],
      });
    }
  }

  /**
   * Called when a coin despawns. Returns the sponsorId if the coin was a
   * sponsor coin, or null otherwise. Removes the coin from the tracking map.
   */
  onCoinDespawn(coinId: number): string | null {
    const sponsorId = this.coinSponsorMap.get(coinId);
    if (sponsorId !== undefined) {
      this.coinSponsorMap.delete(coinId);
      return sponsorId;
    }
    return null;
  }

  /** Return the current list of active sponsor configurations. */
  getActiveSponsorConfig(): SponsorConfig[] {
    return Array.from(this.activeSponsors.values());
  }

  /** Clean up: clear timers and maps. */
  dispose(): void {
    for (const timer of this.bonusDropTimers) {
      clearTimeout(timer);
    }
    this.bonusDropTimers = [];
    this.coinSponsorMap.clear();
    this.pendingQuotas = [];
    this.activeSponsors.clear();
  }
}
