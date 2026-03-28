import { NETWORK_CONFIG } from "@coin-pusher/shared";
import { netProfiler } from "./NetProfiler"; // TEMP: profiling

interface RTTSample {
  clientTime: number;
  serverTime: number;
  rtt: number;
}

export class ClockSync {
  private samples: RTTSample[] = [];
  private offset: number = 0;
  private lastPingTime: number = 0;
  private pingInterval: number;

  // State-delta-based clock sync: uses the game server's timestamps directly.
  // This avoids the clock mismatch between Go backend (pong) and Game Server (state_delta).
  private deltaOffsets: number[] = [];
  private smoothedDeltaOffset: number | null = null;

  constructor(pingInterval: number = NETWORK_CONFIG.PING_INTERVAL) {
    this.pingInterval = pingInterval;
  }

  shouldSendPing(): boolean {
    const now = Date.now();
    if (now - this.lastPingTime >= this.pingInterval) {
      this.lastPingTime = now;
      return true;
    }
    return false;
  }

  recordPong(clientSendTime: number, serverTime: number): void {
    const now = Date.now();
    const rtt = now - clientSendTime;

    this.samples.push({
      clientTime: clientSendTime,
      serverTime,
      rtt,
    });

    // Keep only the last N samples
    if (this.samples.length > NETWORK_CONFIG.RTT_SAMPLES) {
      this.samples.shift();
    }

    console.log(`⏱️  RTT: ${rtt}ms, Offset: ${this.offset.toFixed(1)}ms`);
  }

  /**
   * Record a state_delta's serverTime for direct clock sync with the game server.
   * Called every 67ms (15Hz), much more frequent than ping/pong.
   * The game server sets serverTime = Date.now() right before publishing.
   */
  recordStateDeltaTime(gameServerTime: number): void {
    const clientNow = Date.now();
    // Raw offset: how far ahead the game server clock is from the client clock.
    // This includes network delay (NATS + relay + WebSocket), so the game server
    // is actually further ahead than this estimate. But since we're using this
    // offset to look BACKWARDS in time (targetTime = serverTime - delay),
    // underestimating the offset is conservative and safe.
    const rawOffset = gameServerTime - clientNow;

    this.deltaOffsets.push(rawOffset);
    if (this.deltaOffsets.length > 30) {
      this.deltaOffsets.shift();
    }

    // Use median to filter outliers (network jitter)
    const sorted = this.deltaOffsets.slice().sort((a, b) => a - b);
    const medianOffset = sorted[Math.floor(sorted.length / 2)];

    // Hybrid smoothing: snap on large changes, EMA on small changes
    if (this.smoothedDeltaOffset === null || Math.abs(medianOffset - this.smoothedDeltaOffset) >= 30) {
      this.smoothedDeltaOffset = medianOffset;
    } else {
      this.smoothedDeltaOffset = this.smoothedDeltaOffset * 0.9 + medianOffset * 0.1;
    }

    this.offset = this.smoothedDeltaOffset;
    netProfiler.recordOffset(this.offset); // TEMP: profiling
  }

  getServerTime(): number {
    return Date.now() + this.offset;
  }

  getOffset(): number {
    return this.offset;
  }

  getRTT(): number {
    if (this.samples.length === 0) return 0;

    // Use median RTT for more stable values (less affected by outliers)
    const sortedRTTs = this.samples.map((s) => s.rtt).sort((a, b) => a - b);

    const medianIndex = Math.floor(sortedRTTs.length / 2);
    return sortedRTTs[medianIndex];
  }
}
