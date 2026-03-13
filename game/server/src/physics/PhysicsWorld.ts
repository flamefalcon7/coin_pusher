import * as RAPIER from "@dimforge/rapier3d-compat";
import { PHYSICS_PARAMS } from "./config.js";

export class PhysicsWorld {
  private world: RAPIER.World;
  private initialized: boolean = false;
  private substeps: number = PHYSICS_PARAMS.SUBSTEPS;

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
    this.world.numSolverIterations = PHYSICS_PARAMS.VELOCITY_ITERATIONS;
    this.world.numInternalPgsIterations = PHYSICS_PARAMS.POSITION_ITERATIONS;

    // Set timestep once (constant across all steps)
    this.world.timestep = PHYSICS_PARAMS.DELTA_TIME / this.substeps;

    console.log("⚙️  Rapier physics world initialized");
    console.log(
      `   Gravity: (${PHYSICS_PARAMS.GRAVITY.x}, ${PHYSICS_PARAMS.GRAVITY.y}, ${PHYSICS_PARAMS.GRAVITY.z})`
    );
    console.log(`   Substeps: ${PHYSICS_PARAMS.SUBSTEPS}`);
    console.log(
      `   Solver iterations: vel=${this.world.numSolverIterations}, pos=${this.world.numInternalPgsIterations}`
    );

    this.initialized = true;
  }

  step(): void {
    if (!this.initialized) {
      throw new Error("PhysicsWorld not initialized");
    }

    // Step the physics simulation
    for (let i = 0; i < this.substeps; i++) {
      this.world.step();
    }
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
