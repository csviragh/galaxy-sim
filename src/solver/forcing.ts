/**
 * Optional rigidly rotating, non-axisymmetric external potentials that drive
 * density waves in the disk:
 *
 *  - spiral: Φ = −A(R) cos(m(φ − Ωp t) + m cot(i) ln R)   (logarithmic m-armed
 *    trailing spiral with pitch angle i, Lin–Shu style density-wave forcing)
 *  - bar:    Φ = −A(R) cos(2(φ − Ωb t)),  A ∝ x²/(1 + x²)^{5/2}, x = R/Rb
 *            (∝ R² inside, quadrupole-like ∝ R⁻³ fall-off outside)
 *
 * Both are written as Φ(t) = a(t) [Pc cos(mΩt) + Ps sin(mΩt)] with the two
 * static basis fields Pc = −A cos Ψ and Ps = −A sin Ψ precomputed, so a step
 * only needs two scalar factors.
 */
export type ForcingMode = 'none' | 'spiral' | 'bar';

export interface ForcingParams {
  mode: ForcingMode;
  /** Dimensionless strength: peak non-axisymmetric / axisymmetric force ratio. */
  strength: number;
  /** Pattern speed Ωp in km/s/kpc. */
  patternSpeed: number;
  /** Spiral pitch angle (degrees). */
  pitchAngle: number;
  /** Number of spiral arms. */
  arms: number;
  /** Bar scale radius (kpc). */
  barRadius: number;
  /** Outer radius where the spiral forcing fades (kpc). */
  outerRadius: number;
}

/** Reference circular speed used to scale the forcing amplitude (km/s). */
export const V0 = 200;

/** max of x²/(1 + x²)^{5/2}, reached at x² = 2/3. */
const BAR_PEAK = (2 / 3) / (5 / 3) ** 2.5;

/** Basis potentials Pc, Ps at a point, and the azimuthal multiplicity m. */
export function forcingBasis(p: ForcingParams, x: number, y: number): [number, number] {
  const R = Math.hypot(x, y);
  if (p.mode === 'none' || R < 1e-9) return [0, 0];
  const phi = Math.atan2(y, x);
  let A: number;
  let psi: number;
  if (p.mode === 'spiral') {
    const m = p.arms;
    const cot = 1 / Math.tan((Math.max(p.pitchAngle, 2) * Math.PI) / 180);
    const rin = 2;
    const env = ((R * R) / (R * R + rin * rin)) / (1 + (R / p.outerRadius) ** 6);
    A = ((p.strength * V0 * V0) / (m * cot)) * env;
    psi = m * phi + m * cot * Math.log(R);
  } else {
    const x2 = (R / p.barRadius) ** 2;
    // normalised so the peak of A is ½ ε V0², i.e. peak tangential/radial force ≈ ε
    A = (0.5 * p.strength * V0 * V0 * x2) / (BAR_PEAK * (1 + x2) ** 2.5);
    psi = 2 * phi;
  }
  return [-A * Math.cos(psi), -A * Math.sin(psi)];
}

export function forcingMultiplicity(p: ForcingParams): number {
  return p.mode === 'spiral' ? p.arms : 2;
}
