/**
 * Galactic code units.
 *
 *   length   1 kpc
 *   velocity 1 km/s
 *   mass     1e10 M☉
 *   time     1 kpc / (km/s) ≈ 977.8 Myr
 *
 * In these units Newton's constant is G ≈ 4.3009e4 kpc (km/s)² / (1e10 M☉).
 * Surface densities are in 1e10 M☉/kpc² (= 1e4 M☉/pc²).
 */
export const G = 4.300917e4;

/** Myr per code time unit (1 kpc / (km/s)). */
export const MYR_PER_TIME_UNIT = 977.7922;

/** M☉/pc² per code surface-density unit. */
export const MSUN_PC2_PER_SIGMA_UNIT = 1e4;

/** Hubble constant in km/s/kpc (H₀ = 70 km/s/Mpc), used to define r₂₀₀. */
export const H0 = 0.07;

/** Critical density of the Universe in 1e10 M☉/kpc³. */
export const RHO_CRIT = (3 * H0 * H0) / (8 * Math.PI * G);

export const myrToTime = (myr: number): number => myr / MYR_PER_TIME_UNIT;
export const timeToMyr = (t: number): number => t * MYR_PER_TIME_UNIT;
