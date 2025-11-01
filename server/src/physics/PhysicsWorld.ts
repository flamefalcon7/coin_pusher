import * as RAPIER from "@dimforge/rapier3d-compat";
import { PHYSICS_PARAMS } from "./config.js";

export class PhysicsWorld {
  private world: RAPIER.World;
  private initialized: boolean = false;

  constructor() {
    // World will be initialized asynchronously
    this.world = null as any; // Temporary until init
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    // Initialize Rapier WASM
    await RAPIER.init();

    // Create world with gravity
    this.world = new RAPIER.World(PHYSICS_PARAMS.GRAVITY);

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

    // Step the physics simulation
    this.world.timestep = PHYSICS_PARAMS.DELTA_TIME;
    this.world.step();
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
