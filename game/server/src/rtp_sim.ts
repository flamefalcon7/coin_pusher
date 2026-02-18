import { PhysicsWorld } from "./physics/PhysicsWorld.js";
import { SceneBuilder } from "./physics/SceneBuilder.js";
import { Pusher } from "./physics/Pusher.js";
import { Coin } from "./physics/Coin.js";
import {
  PHYSICS_CONFIG,
  SCENE_CONFIG,
  PUSHER_CONFIG,
  COIN_CONFIG,
} from "@coin-pusher/shared";

// 模擬參數
const SIMULATION_CONFIG = {
  TOTAL_COINS_TO_INSERT: 1000, // 模擬投入的總硬幣數
  COIN_INSERT_INTERVAL_TICKS: 60, // 每多少 tick 投一枚 (30 ticks = 1秒)
  SUBSTEPS: 1, // 為了速度，可以稍微降低精度，但建議保持與生產環境一致以求準確
  LOG_INTERVAL: 100, // 每投入多少硬幣印一次 Log
};

async function runSimulation() {
  console.log("🚀 開始 RTP 模擬...");

  // 1. 初始化物理世界
  const physicsWorld = new PhysicsWorld();
  await physicsWorld.init();
  // const _rapierWorld = physicsWorld.getWorld();

  // 2. 建立場景
  const sceneBuilder = new SceneBuilder(physicsWorld);
  sceneBuilder.buildStaticScene();

  // 3. 初始化推板 (我們將手動驅動它)
  const pusher = new Pusher(physicsWorld);
  const pusherBody = pusher.getRigidBody();

  // 4. 狀態追蹤
  let activeCoins = new Map<number, Coin>();
  let coinIdCounter = 0;

  let stats = {
    inserted: 0,
    won: 0, // 前方掉落
    lost: 0, // 側面掉落
    active: 0,
  };

  // 模擬變數
  let currentTick = 0;
  let simTime = 0;
  const dt = 1 / PHYSICS_CONFIG.TICK_RATE;

  // 平台邊界定義 (根據 SCENE_CONFIG)
  const PLATFORM_Z_EDGE =
    SCENE_CONFIG.PLATFORM.POSITION.z + SCENE_CONFIG.PLATFORM.DEPTH / 2; // 約 0.7
  const PLATFORM_X_EDGE = SCENE_CONFIG.PLATFORM.WIDTH / 2; // 約 0.6

  console.log(
    `📋 邊界設定: 前方邊緣 Z > ${PLATFORM_Z_EDGE}, 側面邊界 X > |${PLATFORM_X_EDGE}|`
  );

  const startTime = Date.now();

  // --- 主循環 ---
  while (
    stats.inserted < SIMULATION_CONFIG.TOTAL_COINS_TO_INSERT ||
    stats.active > 0
  ) {
    currentTick++;
    simTime += dt;

    // A. 投幣邏輯
    if (
      stats.inserted < SIMULATION_CONFIG.TOTAL_COINS_TO_INSERT &&
      currentTick % SIMULATION_CONFIG.COIN_INSERT_INTERVAL_TICKS === 0
    ) {
      // 隨機 X 位置投幣 (-0.4 到 0.4 之間)
      const randomX = (Math.random() - 0.5) * 0.8;
      const id = ++coinIdCounter;

      // 建立硬幣 (直接使用 Coin 類別)
      const coin = new Coin(
        physicsWorld,
        id,
        randomX,
        COIN_CONFIG.SPAWN_HEIGHT,
        0 // Z axis
      );

      activeCoins.set(id, coin);
      stats.inserted++;
      stats.active++;

      if (stats.inserted % SIMULATION_CONFIG.LOG_INTERVAL === 0) {
        printStats(stats, simTime);
      }
    }

    // B. 驅動推板 (手動計算位置，不依賴 Date.now())
    // 模擬 Pusher.ts 中的邏輯
    const omega = 2 * Math.PI * PUSHER_CONFIG.FREQUENCY;
    const phase = omega * simTime + PUSHER_CONFIG.INITIAL_PHASE;
    const currentPusherZ =
      PUSHER_CONFIG.AMPLITUDE * Math.sin(phase) + PUSHER_CONFIG.Z_OFFSET;
    const velocityZ = PUSHER_CONFIG.AMPLITUDE * omega * Math.cos(phase);

    pusherBody.setLinvel({ x: 0, y: 0, z: velocityZ }, true);
    pusherBody.setTranslation(
      {
        x: SCENE_CONFIG.PUSHER.POSITION.x,
        y: SCENE_CONFIG.PUSHER.POSITION.y,
        z: SCENE_CONFIG.PUSHER.POSITION.z + currentPusherZ,
      },
      true
    );

    // C. 更新硬幣 & 檢查狀態
    const coinsToRemove: number[] = [];

    activeCoins.forEach((coin, id) => {
      coin.update(); // 處理 CCD 和 Sleep 邏輯
      const pos = coin.getPosition();

      // 檢查是否掉落 (Despawn Y)
      if (pos.y < COIN_CONFIG.DESPAWN_Y) {
        coinsToRemove.push(id);

        // 判定勝負
        // 如果 Z 超過平台邊緣，且在左右牆壁範圍內 -> WIN
        if (
          pos.z > PLATFORM_Z_EDGE &&
          Math.abs(pos.x) < PLATFORM_X_EDGE + 0.1
        ) {
          stats.won++;
        } else {
          // 其他情況 (側面掉落或掉到推板後面) -> LOSS
          stats.lost++;
        }
      }
    });

    // D. 清理移除的硬幣
    coinsToRemove.forEach((id) => {
      const coin = activeCoins.get(id);
      if (coin) {
        coin.destroy(physicsWorld);
        activeCoins.delete(id);
        stats.active--;
      }
    });

    // E. 物理步進
    physicsWorld.step();

    // 如果所有幣都投完了，且場上沒幣了，或者運行太久，就結束
    if (
      stats.inserted >= SIMULATION_CONFIG.TOTAL_COINS_TO_INSERT &&
      stats.active === 0
    ) {
      break;
    }

    // 安全中斷：避免死循環 (例如 1小時模擬時間)
    if (simTime > 3600 * 2) break;
  }

  const duration = (Date.now() - startTime) / 1000;
  console.log("\n🏁 模擬完成!");
  console.log(
    `⏱️  耗時: ${duration.toFixed(2)} 秒 (模擬時間: ${simTime.toFixed(2)} 秒)`
  );
  printStats(stats, simTime, true);
}

function printStats(stats: any, _simTime: number, final = false) {
  const rtp = (stats.won / stats.inserted) * 100;
  // const _houseEdge = (stats.lost / stats.inserted) * 100;

  console.log(
    `${final ? "📊 最終統計" : "⏱️  進度"}: ` +
      `投入: ${stats.inserted} | ` +
      `贏取: ${stats.won} | ` +
      `輸掉: ${stats.lost} | ` +
      `場上: ${stats.active} | ` +
      `RTP: ${rtp.toFixed(2)}%`
  );
}

// 執行
runSimulation().catch(console.error);
