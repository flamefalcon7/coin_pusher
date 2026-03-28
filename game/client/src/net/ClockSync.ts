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

    // Recalculate offset
    this.calculateOffset();
    netProfiler.recordOffset(this.offset); // TEMP: profiling

    console.log(`⏱️  RTT: ${rtt}ms, Offset: ${this.offset.toFixed(1)}ms`);
  }

  private calculateOffset(): void {
    if (this.samples.length === 0) return;

    // Get median RTT to filter out outliers
    const sortedRTTs = this.samples.map((s) => s.rtt).sort((a, b) => a - b);

    const medianRTT = sortedRTTs[Math.floor(sortedRTTs.length / 2)];

    // Find sample with RTT closest to median
    let bestSample = this.samples[0];
    let minDiff = Math.abs(bestSample.rtt - medianRTT);

    for (const sample of this.samples) {
      const diff = Math.abs(sample.rtt - medianRTT);
      if (diff < minDiff) {
        minDiff = diff;
        bestSample = sample;
      }
    }

    // Calculate offset: (serverTime - clientTime) - RTT/2
    const clientMidpoint = bestSample.clientTime + bestSample.rtt / 2;
    this.offset = bestSample.serverTime - clientMidpoint;
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
