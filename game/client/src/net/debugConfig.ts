import { NETWORK_CONFIG } from "@coin-pusher/shared";

/**
 * Mutable runtime config for interpolation tuning.
 * Defaults to NETWORK_CONFIG values. Modified by the debug panel (?debug=1).
 * The Interpolator reads from this instead of NETWORK_CONFIG directly.
 */
export const debugConfig = {
  interpolationDelayBase: NETWORK_CONFIG.INTERPOLATION_DELAY_BASE,
  interpolationDelayMultiplier: NETWORK_CONFIG.INTERPOLATION_DELAY_MULTIPLIER,
  interpolationDelayMin: NETWORK_CONFIG.INTERPOLATION_DELAY_MIN,
  interpolationDelayMax: NETWORK_CONFIG.INTERPOLATION_DELAY_MAX,
  interpolationDelayJitterMargin: NETWORK_CONFIG.INTERPOLATION_DELAY_JITTER_MARGIN,
  extrapolationMaxTime: NETWORK_CONFIG.EXTRAPOLATION_MAX_TIME,
};

/**
 * Shared debug gate: true when the page is loaded with `?debug=1`.
 * Used by the debug panel and the scrapeable debug HUD (DebugReadout) so the
 * latter is never exposed in a normal production session.
 */
export function isDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("debug") === "1";
}
