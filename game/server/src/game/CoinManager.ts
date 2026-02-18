import { COIN_CONFIG, RATE_LIMIT_CONFIG } from "@coin-pusher/shared";
import type { GameState } from "./GameState.js";

export class CoinManager {
  private gameState: GameState;

  constructor(gameState: GameState) {
    this.gameState = gameState;
  }

  spawnCoin(
    x: number,
    y?: number,
    z?: number,
    rotation?: [number, number, number, number]
  ): number | null {
    // Validate x position
    if (
      x < -RATE_LIMIT_CONFIG.MAX_X_POSITION ||
      x > RATE_LIMIT_CONFIG.MAX_X_POSITION
    ) {
      return null;
    }

    const id = this.gameState.getNextBodyId();
    const f = 1000;
    const spawnX = Math.round(x * f) / f;
    const spawnY = y ?? COIN_CONFIG.SPAWN_HEIGHT;
    const spawnZ = z ?? 0;

    this.gameState.addCoin(id, spawnX, spawnY, spawnZ, rotation);

    return id;
  }

  /** Spawn a coin without x-range validation (for fill platform). */
  spawnCoinUnchecked(
    x: number,
    y: number,
    z: number,
    rotation?: [number, number, number, number]
  ): number {
    const id = this.gameState.getNextBodyId();
    const f = 1000;
    const spawnX = Math.round(x * f) / f;

    this.gameState.addCoin(id, spawnX, y, z, rotation);

    return id;
  }

  removeCoin(id: number): void {
    this.gameState.removeCoin(id);
  }

  updateCoin(
    id: number,
    pos: [number, number, number],
    rot: [number, number, number, number]
  ): void {
    // Store raw values — quantization for network is done in GameLoop
    this.gameState.updateCoinState(id, pos, rot);
  }
}
