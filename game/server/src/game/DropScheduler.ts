import { DROP_SCHEDULER_CONFIG, SLOT_CONFIG } from "@coin-pusher/shared";

interface QueueEntry {
  userId: string;
  count: number;
}

export interface DropResult {
  userId: string;
  slotX: number;
  slotIndex: number;
}

class SlotQueue {
  private entries: QueueEntry[] = [];
  private roundRobinIndex: number = 0;
  private cooldown: number = 0;
  private totalPending: number = 0;

  enqueue(userId: string, count: number): number {
    const space = DROP_SCHEDULER_CONFIG.SLOT_CAP - this.totalPending;
    const accepted = Math.min(count, Math.max(0, space));
    if (accepted > 0) {
      // Merge into existing entry for same user, or create new
      const existing = this.entries.find(e => e.userId === userId);
      if (existing) {
        existing.count += accepted;
      } else {
        this.entries.push({ userId, count: accepted });
      }
      this.totalPending += accepted;
    }
    return accepted;
  }

  tick(): { userId: string } | null {
    if (this.cooldown > 0) {
      this.cooldown--;
      return null;
    }

    if (this.entries.length === 0) return null;

    // Round-robin across users in this slot
    this.roundRobinIndex = this.roundRobinIndex % this.entries.length;
    const entry = this.entries[this.roundRobinIndex];

    entry.count--;
    this.totalPending--;
    this.cooldown = DROP_SCHEDULER_CONFIG.DROP_INTERVAL_TICKS;

    const userId = entry.userId;

    if (entry.count === 0) {
      this.entries.splice(this.roundRobinIndex, 1);
      if (this.entries.length > 0) {
        this.roundRobinIndex = this.roundRobinIndex % this.entries.length;
      } else {
        this.roundRobinIndex = 0;
      }
    } else {
      this.roundRobinIndex = (this.roundRobinIndex + 1) % this.entries.length;
    }

    return { userId };
  }

  getPending(): number {
    return this.totalPending;
  }

  getUserPending(userId: string): number {
    return this.entries.find(e => e.userId === userId)?.count ?? 0;
  }

  clear(): void {
    this.entries = [];
    this.roundRobinIndex = 0;
    this.cooldown = 0;
    this.totalPending = 0;
  }
}

export class DropScheduler {
  private slots: SlotQueue[];

  constructor() {
    this.slots = Array.from({ length: SLOT_CONFIG.POSITIONS.length }, () => new SlotQueue());
  }

  enqueue(userId: string, slotIndex: number, count: number): number {
    if (slotIndex < 0 || slotIndex >= this.slots.length) return 0;
    return this.slots[slotIndex].enqueue(userId, count);
  }

  tick(): DropResult[] {
    const results: DropResult[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const drop = this.slots[i].tick();
      if (drop) {
        const offset = (Math.random() * 2 - 1) * DROP_SCHEDULER_CONFIG.RANDOM_X_OFFSET;
        results.push({
          userId: drop.userId,
          slotX: SLOT_CONFIG.POSITIONS[i] + offset,
          slotIndex: i,
        });
      }
    }
    return results;
  }

  getSlotCounts(): number[] {
    return this.slots.map(s => s.getPending());
  }

  getPending(userId: string): number {
    let total = 0;
    for (const slot of this.slots) {
      total += slot.getUserPending(userId);
    }
    return total;
  }

  clear(): void {
    for (const slot of this.slots) {
      slot.clear();
    }
  }
}
