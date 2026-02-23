import { COIN_CONFIG } from "@coin-pusher/shared";
import type { StackType } from "@coin-pusher/shared";

export type CoinSpawnData = {
  x: number;
  y: number;
  z: number;
  rotation: { x: number; y: number; z: number; w: number };
};

export class StackSpawner {
  // Rotations
  private static readonly FLAT_ROTATION = { x: 0, y: 0, z: 0, w: 1 }; // Flat on ground

  static getStackCoins(
    type: StackType,
    startX: number,
    startY: number,
    startZ: number
  ): CoinSpawnData[] {
    switch (type) {
      case "wall":
        return this.generateWall(startX, startY, startZ);
      case "tower":
        return this.generateTower(startX, startY, startZ);
      case "pyramid":
        return this.generatePyramid(startX, startY, startZ);
      case "pyramid3bleLayer":
        return this.generatePyramid3bleLayer(startX, startY, startZ);
      case "cylinder":
        return this.generateCylinder(startX, startY, startZ);
      default:
        return [];
    }
  }

  private static generateWall(
    startX: number,
    startY: number,
    startZ: number
  ): CoinSpawnData[] {
    const coins: CoinSpawnData[] = [];
    const numStacks = 6;
    const coinsPerStack = 12;

    // Spacing for straight arrangement
    const xStep = COIN_CONFIG.RADIUS * 2.05;
    const spacingY = COIN_CONFIG.THICKNESS * 1.02; // Slight gap to prevent physics jitter

    for (let s = 0; s < numStacks; s++) {
      // Center the wall around startX
      const xOffset = (s - (numStacks - 1) / 2) * xStep;

      for (let h = 0; h < coinsPerStack; h++) {
        // Stagger every other row for stability (brick pattern)
        const rowOffset = h % 2 === 0 ? 0 : xStep / 2;

        coins.push({
          x: startX + xOffset + rowOffset,
          y: startY + h * spacingY,
          z: startZ,
          rotation: this.FLAT_ROTATION,
        });
      }
    }
    return coins;
  }

  private static generateTower(
    startX: number,
    startY: number,
    startZ: number
  ): CoinSpawnData[] {
    const coins: CoinSpawnData[] = [];
    const height = 10;
    const spacingY = COIN_CONFIG.THICKNESS;

    for (let i = 0; i < height; i++) {
      coins.push({
        x: startX,
        y: startY + i * spacingY,
        z: startZ,
        rotation: this.FLAT_ROTATION,
      });
    }
    return coins;
  }

  private static generatePyramid(
    startX: number,
    startY: number,
    startZ: number
  ): CoinSpawnData[] {
    const coins: CoinSpawnData[] = [];
    const levels = 10;
    const depth = 3; // 設定深度為 3 排
    const spacingX = COIN_CONFIG.RADIUS * 1.1; // X軸重疊
    const spacingY = COIN_CONFIG.THICKNESS * 1.05;
    const spacingZ = COIN_CONFIG.RADIUS * 2.05; // Z軸標準間距 (避免重疊)

    for (let level = 0; level < levels; level++) {
      const coinsInLevel = levels - level;
      for (let c = 0; c < coinsInLevel; c++) {
        // 計算 X 偏移 (置中)
        const xOffset = (c - (coinsInLevel - 1) / 2) * spacingX * 2;
        const yOffset = level * spacingY;

        // 增加深度迴圈 (Z軸)
        for (let d = 0; d < depth; d++) {
          // 計算 Z 偏移 (置中)
          const zOffset = (d - (depth - 1) / 2) * spacingZ;

          coins.push({
            x: startX + xOffset,
            y: startY + yOffset,
            z: startZ + zOffset,
            rotation: this.FLAT_ROTATION,
          });
        }
      }
    }
    return coins;
  }

  private static generatePyramid3bleLayer(
    startX: number,
    startY: number,
    startZ: number
  ): CoinSpawnData[] {
    const coins: CoinSpawnData[] = [];
    const levels = 10;
    const stackHeight = 3; // Every unit is a stack of 3 coins
    const spacingX = COIN_CONFIG.RADIUS * 1.1;
    const spacingY = COIN_CONFIG.THICKNESS * 1.05;
    // Height of one pyramid level (3 coins)
    const levelStepY = stackHeight * spacingY;

    for (let level = 0; level < levels; level++) {
      const coinsInLevel = levels - level;
      for (let c = 0; c < coinsInLevel; c++) {
        // Center the level
        const xOffset = (c - (coinsInLevel - 1) / 2) * spacingX * 2;
        // Base Y position for this pyramid level
        const levelBaseY = startY + level * levelStepY;

        // Generate the stack of 3 coins
        for (let h = 0; h < stackHeight; h++) {
          coins.push({
            x: startX + xOffset,
            y: levelBaseY + h * spacingY,
            z: startZ,
            rotation: this.FLAT_ROTATION,
          });
        }
      }
    }
    return coins;
  }

  private static generateCylinder(
    startX: number,
    startY: number,
    startZ: number
  ): CoinSpawnData[] {
    const coins: CoinSpawnData[] = [];
    const levels = 30;
    const coinsPerLevel = 8;
    const radius = COIN_CONFIG.RADIUS * 2.8; // Ring radius (2.8R so adjacent coins don't overlap)
    const spacingY = COIN_CONFIG.THICKNESS * 1.05; // Slight gap to prevent solver jitter
    const angleStep = (Math.PI * 2) / coinsPerLevel;

    for (let level = 0; level < levels; level++) {
      // Offset every other level to create the staggered "brick" look
      // Offset by half an angle step
      const angleOffset = level % 2 === 0 ? 0 : angleStep / 2;

      for (let c = 0; c < coinsPerLevel; c++) {
        const angle = c * angleStep + angleOffset;

        const xOffset = Math.cos(angle) * radius;
        const zOffset = Math.sin(angle) * radius;
        const yOffset = level * spacingY;

        coins.push({
          x: startX + xOffset,
          y: startY + yOffset,
          z: startZ + zOffset,
          rotation: this.FLAT_ROTATION,
        });
      }
    }
    return coins;
  }
}
