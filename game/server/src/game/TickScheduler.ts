// Simple tick scheduler using setInterval
// This file exists for future enhancements (drift correction, variable tick rates, etc.)

import { PHYSICS_CONFIG } from '@coin-pusher/shared';

export class TickScheduler {
  private callback: () => void;
  private intervalId?: NodeJS.Timeout;
  private running: boolean = false;

  constructor(callback: () => void) {
    this.callback = callback;
  }

  start(): void {
    if (this.running) return;

    this.running = true;
    this.intervalId = setInterval(this.callback, PHYSICS_CONFIG.TICK_INTERVAL);
    console.log(`⏱️  Tick scheduler started at ${PHYSICS_CONFIG.TICK_RATE}Hz`);
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    console.log('⏱️  Tick scheduler stopped');
  }

  isRunning(): boolean {
    return this.running;
  }
}

