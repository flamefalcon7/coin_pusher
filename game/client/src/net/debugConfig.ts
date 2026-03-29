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
  extrapolationMaxTime: NETWORK_CONFIG.EXTRAPOLATION_MAX_TIME,
  useHermite: true,
  hermiteClamp: true,
};
