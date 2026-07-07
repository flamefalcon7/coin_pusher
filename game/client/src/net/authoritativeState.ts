import type { StateUpdate } from "@coin-pusher/shared";
import type { BufferedState } from "./StateBuffer";

/**
 * Latest raw server state (newest buffered state_delta, pre-interpolation) —
 * the shared shape for debug consumers (dump()'s network.poses, collider
 * wireframe dynamic-body tracking). This is the physics ground truth the
 * agent-perception tooling reports.
 */
export interface AuthoritativeState {
  serverTime: number;
  pusherZ: number;
  coins: StateUpdate[];
}

/**
 * Map a newest buffered server state into AuthoritativeState. Pure and
 * dependency-free so the field mapping (the ground truth an agent reads) is
 * unit-testable without constructing a live GameClient.
 */
export function toAuthoritativeState(newest: BufferedState | null): AuthoritativeState | null {
  if (!newest) return null;
  return {
    serverTime: newest.serverTime,
    pusherZ: newest.pusherZ,
    coins: newest.updates,
  };
}
