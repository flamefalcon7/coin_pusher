import { DROP_SCHEDULER_CONFIG } from "@coin-pusher/shared";

interface PlayerQueue {
  userId: string;
  slotX: number;
  pending: number;
}

export class DropScheduler {
  private queues: Map<string, PlayerQueue> = new Map();
  private roundRobinOrder: string[] = [];
  private currentIndex: number = 0;
  private dropCooldown: number = 0;

  enqueue(userId: string, slotX: number, count: number): number {
    let q = this.queues.get(userId);
    if (!q) {
      q = { userId, slotX, pending: 0 };
      this.queues.set(userId, q);
      this.roundRobinOrder.push(userId);
    }
    const space = DROP_SCHEDULER_CONFIG.MAX_QUEUE - q.pending;
    const accepted = Math.min(count, space);
    q.pending += accepted;
    q.slotX = slotX;
    return accepted;
  }

  // Called every tick. Returns next coin to drop or null.
  tick(): { userId: string; slotX: number } | null {
    if (this.dropCooldown > 0) {
      this.dropCooldown--;
      return null;
    }

    const startIndex = this.currentIndex;
    do {
      if (this.roundRobinOrder.length === 0) return null;

      this.currentIndex = this.currentIndex % this.roundRobinOrder.length;
      const userId = this.roundRobinOrder[this.currentIndex];
      const q = this.queues.get(userId);

      if (q && q.pending > 0) {
        q.pending--;
        this.dropCooldown = DROP_SCHEDULER_CONFIG.DROP_INTERVAL_TICKS;
        this.currentIndex = (this.currentIndex + 1) % this.roundRobinOrder.length;

        if (q.pending === 0) {
          this.queues.delete(userId);
          this.roundRobinOrder = this.roundRobinOrder.filter(id => id !== userId);
        }

        return { userId, slotX: q.slotX };
      }

      // Empty queue, remove and continue
      this.roundRobinOrder.splice(this.currentIndex, 1);
      if (this.roundRobinOrder.length > 0) {
        this.currentIndex = this.currentIndex % this.roundRobinOrder.length;
      }
    } while (this.currentIndex !== startIndex && this.roundRobinOrder.length > 0);

    return null;
  }

  getPending(userId: string): number {
    return this.queues.get(userId)?.pending ?? 0;
  }

  clear(): void {
    this.queues.clear();
    this.roundRobinOrder = [];
    this.currentIndex = 0;
    this.dropCooldown = 0;
  }
}
