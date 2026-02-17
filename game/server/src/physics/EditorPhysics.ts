import * as RAPIER from "@dimforge/rapier3d-compat";
import type { PhysicsWorld } from "./PhysicsWorld.js";

type EditorObject = {
  id: string;
  type: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
};

const FRICTION = 0.3;
const RESTITUTION = 0.2;

export class EditorPhysics {
  private world: RAPIER.World;
  private bodies: RAPIER.RigidBody[] = [];

  constructor(physicsWorld: PhysicsWorld) {
    this.world = physicsWorld.getWorld();
  }

  syncObjects(objects: EditorObject[]): void {
    // Remove all existing editor bodies
    for (const body of this.bodies) {
      this.world.removeRigidBody(body);
    }
    this.bodies = [];

    // Recreate from scratch
    for (const obj of objects) {
      const [px, py, pz] = obj.position;
      const [rx, ry, rz] = obj.rotation;
      const [sx, sy, sz] = obj.scale;

      const quat = this.eulerToQuat(rx, ry, rz);

      const bodyDesc = RAPIER.RigidBodyDesc.fixed()
        .setTranslation(px, py, pz)
        .setRotation(quat);
      const body = this.world.createRigidBody(bodyDesc);

      const colliderDesc = this.createCollider(obj.type, sx, sy, sz);
      if (colliderDesc) {
        colliderDesc.setFriction(FRICTION).setRestitution(RESTITUTION);
        this.world.createCollider(colliderDesc, body);
      } else {
        console.warn(`EditorPhysics: collider creation failed for ${obj.type} id=${obj.id}`);
      }

      this.bodies.push(body);
    }

    if (objects.length > 0) {
      console.log(`Editor physics synced: ${objects.length} objects`);
    }
  }

  private createCollider(
    type: string,
    sx: number,
    sy: number,
    sz: number
  ): RAPIER.ColliderDesc | null {
    switch (type) {
      case "box":
        return RAPIER.ColliderDesc.cuboid(0.5 * sx, 0.5 * sy, 0.5 * sz);
      case "sphere":
        return RAPIER.ColliderDesc.ball(0.5 * Math.max(sx, sy, sz));
      case "cylinder":
        return RAPIER.ColliderDesc.cylinder(0.5 * sy, 0.5 * Math.max(sx, sz));
      case "prism": {
        // Match BabylonJS CreateCylinder tessellation=3 exactly:
        //   x = cos(-angle) * r, z = sin(-angle) * r, r = 0.5
        // θ=0:     (0.5,  0)      θ=2π/3: (-0.25, -√3/4)    θ=4π/3: (-0.25, √3/4)
        const k = Math.sqrt(3) / 4; // ≈ 0.433
        const hy = 0.5 * sy;
        const verts = new Float32Array([
           0.5 * sx,  -hy,   0 * sz,
          -0.25 * sx, -hy,  -k * sz,
          -0.25 * sx, -hy,   k * sz,
           0.5 * sx,   hy,   0 * sz,
          -0.25 * sx,  hy,  -k * sz,
          -0.25 * sx,  hy,   k * sz,
        ]);
        return RAPIER.ColliderDesc.convexHull(verts);
      }
      default:
        return null;
    }
  }

  private eulerToQuat(
    x: number,
    y: number,
    z: number
  ): { x: number; y: number; z: number; w: number } {
    // BabylonJS uses intrinsic YXZ rotation order: q = qY * qX * qZ
    const qx = this.quatFromAxisAngle(1, 0, 0, x);
    const qy = this.quatFromAxisAngle(0, 1, 0, y);
    const qz = this.quatFromAxisAngle(0, 0, 1, z);
    return this.quatMultiply(this.quatMultiply(qy, qx), qz);
  }

  private quatFromAxisAngle(
    ax: number,
    ay: number,
    az: number,
    angle: number
  ) {
    const half = angle / 2;
    const s = Math.sin(half);
    return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(half) };
  }

  private quatMultiply(
    a: { x: number; y: number; z: number; w: number },
    b: { x: number; y: number; z: number; w: number }
  ) {
    return {
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
  }
}
