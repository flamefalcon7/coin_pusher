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
  private static readonly VERTICAL_ROTATION = {
    x: Math.SQRT1_2,
    y: 0,
    z: 0,
    w: Math.SQRT1_2,
  }; // 90 degrees around X (standard spawn)
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
    const rows = 3;
    const cols = 3;
    const spacingX = COIN_CONFIG.RADIUS * 2.1; // Slightly more than diameter
    const spacingY = COIN_CONFIG.RADIUS * 2.1;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Center the wall around startX
        const xOffset = (c - (cols - 1) / 2) * spacingX;
        const yOffset = r * spacingY;

        coins.push({
          x: startX + xOffset,
          y: startY + yOffset,
          z: startZ,
          rotation: this.VERTICAL_ROTATION,
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
    const height = 5;
    const spacingY = COIN_CONFIG.THICKNESS * 1.05; // Slightly more than thickness

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
    const levels = 3;
    const spacingX = COIN_CONFIG.RADIUS * 1.1; // Half overlap
    const spacingY = COIN_CONFIG.THICKNESS * 1.05;

    for (let level = 0; level < levels; level++) {
      const coinsInLevel = levels - level;
      for (let c = 0; c < coinsInLevel; c++) {
        // Center the level
        const xOffset = (c - (coinsInLevel - 1) / 2) * spacingX * 2;
        const yOffset = level * spacingY;

        coins.push({
          x: startX + xOffset,
          y: startY + yOffset,
          z: startZ,
          rotation: this.FLAT_ROTATION,
        });
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
    const levels = 10;
    const coinsPerLevel = 8;
    const radius = COIN_CONFIG.RADIUS * 2.5; // Ring radius
    const spacingY = COIN_CONFIG.THICKNESS * 1.0; // Tight stacking
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
