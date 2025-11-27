import { COIN_CONFIG, RATE_LIMIT_CONFIG } from "@coin-pusher/shared";
import type { GameState } from "./GameState.js";

export class CoinManager {
  private gameState: GameState;

  constructor(gameState: GameState) {
    this.gameState = gameState;
  }

  spawnCoin(x: number, y?: number, z?: number): number | null {
    // Validate x position
    if (
      x < -RATE_LIMIT_CONFIG.MAX_X_POSITION ||
      x > RATE_LIMIT_CONFIG.MAX_X_POSITION
    ) {
      console.warn(`Invalid coin spawn x: ${x}`);
      return null;
    }

    const id = this.gameState.getNextBodyId();
    const spawnX = this.quantize(x, 3);
    const spawnY = y ?? COIN_CONFIG.SPAWN_HEIGHT;
    const spawnZ = z ?? 0;

    this.gameState.addCoin(id, spawnX, spawnY, spawnZ);
    console.log(`Spawned coin ${id} at (${spawnX}, ${spawnY}, ${spawnZ})`);

    return id;
  }

  removeCoin(id: number): void {
    this.gameState.removeCoin(id);
    console.log(`Removed coin ${id}`);
  }

  updateCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    const quantizedPos: [number, number, number] = [
      this.quantize(pos[0], 3),
      this.quantize(pos[1], 3),
      this.quantize(pos[2], 3),
    ];

    const quantizedRot: [number, number, number, number] = [
      this.quantize(rot[0], 3),
      this.quantize(rot[1], 3),
      this.quantize(rot[2], 3),
      this.quantize(rot[3], 3),
    ];

    this.gameState.updateCoinState(id, quantizedPos, quantizedRot);
  }

  private quantize(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }
}
