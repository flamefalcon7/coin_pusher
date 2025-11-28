import * as RAPIER from "@dimforge/rapier3d-compat";
import { PHYSICS_PARAMS } from "./config.js";

export class PhysicsWorld {
  private world: RAPIER.World;
  private initialized: boolean = false;
  private eventQueue: RAPIER.EventQueue;
  private pinColliders: Set<number> = new Set();

  constructor() {
    // World will be initialized asynchronously
    this.world = null as any; // Temporary until init
    this.eventQueue = null as any;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Initialize Rapier WASM
    await RAPIER.init();

    // Create world with gravity
    this.world = new RAPIER.World(PHYSICS_PARAMS.GRAVITY);
    this.eventQueue = new RAPIER.EventQueue(true);

    console.log("⚙️  Rapier physics world initialized");
    console.log(
      `   Gravity: (${PHYSICS_PARAMS.GRAVITY.x}, ${PHYSICS_PARAMS.GRAVITY.y}, ${PHYSICS_PARAMS.GRAVITY.z})`
    );
    console.log(`   Substeps: ${PHYSICS_PARAMS.SUBSTEPS}`);
    console.log(
      `   Solver iterations: vel=${PHYSICS_PARAMS.VELOCITY_ITERATIONS}, pos=${PHYSICS_PARAMS.POSITION_ITERATIONS}`
    );

    this.initialized = true;
  }

  step(): void {
    if (!this.initialized) {
      throw new Error("PhysicsWorld not initialized");
    }

    const start = performance.now();

    // Step the physics simulation
    this.world.timestep = PHYSICS_PARAMS.DELTA_TIME;
    this.world.step(this.eventQueue);

    // Handle collision events
    this.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      if (!started) return;
      this.handleCollisions(handle1, handle2);
    });

    const end = performance.now();
    // 如果超過 16ms (60fps) 或 33ms (30fps)，說明 CPU 吃不消了
    if (end - start > 16) {
      console.log(`Physics step took ${end - start}ms`);
    }
  }

  private handleCollisions(handle1: number, handle2: number) {
    let coinBody: RAPIER.RigidBody | null = null;

    // Check if one of them is a pin
    if (this.pinColliders.has(handle1)) {
      const collider = this.world.getCollider(handle2);
      if (collider) coinBody = collider.parent();
    } else if (this.pinColliders.has(handle2)) {
      const collider = this.world.getCollider(handle1);
      if (collider) coinBody = collider.parent();
    }

    // If we found a coin body colliding with a pin
    if (coinBody && coinBody.bodyType() === RAPIER.RigidBodyType.Dynamic) {
      // Apply random lateral impulse
      // Random direction: -1 or 1
      const direction = Math.random() > 0.5 ? 1 : -1;
      // Random strength between 0.002 and 0.005 (small nudge)
      const strength = 0.002 + Math.random() * 0.003;

      coinBody.applyImpulse({ x: direction * strength, y: 0, z: 0 }, true);
    }
  }

  registerPinCollider(handle: number) {
    this.pinColliders.add(handle);
  }

  getWorld(): RAPIER.World {
    if (!this.initialized) {
      throw new Error("PhysicsWorld not initialized");
    }
    return this.world;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
