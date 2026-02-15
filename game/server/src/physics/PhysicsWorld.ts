import * as RAPIER from "@dimforge/rapier3d-compat";
import { PHYSICS_PARAMS } from "./config.js";

export class PhysicsWorld {
  private world: RAPIER.World;
  private initialized: boolean = false;
  private eventQueue: RAPIER.EventQueue;
  private pinColliders: Set<number> = new Set();
  private substeps: number = PHYSICS_PARAMS.SUBSTEPS;

  // Bound collision handler to avoid creating a new closure every substep
  private collisionHandler: (handle1: number, handle2: number, started: boolean) => void;

  constructor() {
    // World will be initialized asynchronously
    this.world = null as any; // Temporary until init
    this.eventQueue = null as any;
    this.collisionHandler = (handle1: number, handle2: number, started: boolean) => {
      if (!started) return;
      this.handleCollisions(handle1, handle2);
    };
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Initialize Rapier WASM
    await RAPIER.init();

    // Create world with gravity
    this.world = new RAPIER.World(PHYSICS_PARAMS.GRAVITY);
    this.world.maxVelocityIterations = PHYSICS_PARAMS.VELOCITY_ITERATIONS;
    this.world.maxStabilizationIterations = PHYSICS_PARAMS.POSITION_ITERATIONS;
    this.eventQueue = new RAPIER.EventQueue(true);

    // Set timestep once (constant across all steps)
    this.world.timestep = PHYSICS_PARAMS.DELTA_TIME / this.substeps;

    console.log("⚙️  Rapier physics world initialized");
    console.log(
      `   Gravity: (${PHYSICS_PARAMS.GRAVITY.x}, ${PHYSICS_PARAMS.GRAVITY.y}, ${PHYSICS_PARAMS.GRAVITY.z})`
    );
    console.log(`   Substeps: ${PHYSICS_PARAMS.SUBSTEPS}`);
    console.log(
      `   Solver iterations: vel=${this.world.maxVelocityIterations}, pos=${this.world.maxStabilizationIterations}`
    );

    this.initialized = true;
  }

  step(): void {
    if (!this.initialized) {
      throw new Error("PhysicsWorld not initialized");
    }

    // Step the physics simulation
    for (let i = 0; i < this.substeps; i++) {
      this.world.step(this.eventQueue);

      // Handle collision events within substep
      this.eventQueue.drainCollisionEvents(this.collisionHandler);
    }
  }

  private handleCollisions(handle1: number, handle2: number) {
    // Pin collision logic
    let coinBody: RAPIER.RigidBody | null = null;

    if (this.pinColliders.has(handle1)) {
      const collider = this.world.getCollider(handle2);
      if (collider) coinBody = collider.parent();
    } else if (this.pinColliders.has(handle2)) {
      const collider = this.world.getCollider(handle1);
      if (collider) coinBody = collider.parent();
    }

    if (coinBody && coinBody.bodyType() === RAPIER.RigidBodyType.Dynamic) {
      const direction = Math.random() > 0.5 ? 1 : -1;
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
