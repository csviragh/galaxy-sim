/**
 * Static, spherically symmetric mass components that act on the fluid only
 * through their gravity: the dark-matter halo (NFW or cored pseudo-isothermal)
 * and an optional stellar bulge (Hernquist). All functions take the 3D radius
 * r in kpc; in the galactic plane r = R.
 */
import { G, RHO_CRIT } from './units';

export type HaloProfile = 'nfw' | 'iso';

export interface SphericalComponent {
  /** Mass enclosed within radius r (1e10 M☉). */
  enclosedMass(r: number): number;
  /** Density at radius r (1e10 M☉/kpc³). */
  density(r: number): number;
  /** Potential Φ(r) in (km/s)², → 0 at infinity. */
  potential(r: number): number;
  /** Circular velocity sqrt(G M(<r)/r) in km/s. */
  vcirc(r: number): number;
}

/** Radius inside which the mean density is 200 ρ_crit, for a mass M200. */
export function r200FromMass(m200: number): number {
  return Math.cbrt((3 * m200) / (4 * Math.PI * 200 * RHO_CRIT));
}

const nfwM = (x: number) => Math.log1p(x) - x / (1 + x);

/**
 * Navarro–Frenk–White halo, ρ = ρs / [(r/rs)(1 + r/rs)²], normalised so that
 * M(<r200) = m200. Concentration c = r200 / rs.
 */
export class NFWHalo implements SphericalComponent {
  readonly r200: number;
  readonly c: number;
  readonly rhoS: number;
  constructor(readonly m200: number, readonly rs: number) {
    this.r200 = r200FromMass(m200);
    this.c = this.r200 / rs;
    this.rhoS = m200 / (4 * Math.PI * rs ** 3 * nfwM(this.c));
  }
  enclosedMass(r: number): number {
    return (this.m200 * nfwM(r / this.rs)) / nfwM(this.c);
  }
  density(r: number): number {
    const x = Math.max(r, 1e-3) / this.rs;
    return this.rhoS / (x * (1 + x) * (1 + x));
  }
  potential(r: number): number {
    const x = r / this.rs;
    const k = (G * this.m200) / nfwM(this.c);
    if (x < 1e-6) return -k / this.rs;
    return (-k * Math.log1p(x)) / r;
  }
  vcirc(r: number): number {
    return r > 0 ? Math.sqrt((G * this.enclosedMass(r)) / r) : 0;
  }
}

/** ∫ (x − atan x)/x² dx = atan(x)/x + ½ ln(1 + x²) */
const isoF = (x: number) => (x < 1e-6 ? 1 : Math.atan(x) / x + 0.5 * Math.log1p(x * x));

/**
 * Cored pseudo-isothermal halo, ρ = ρ0 / (1 + (r/rc)²), truncated at r200 and
 * normalised so that M(<r200) = m200. Its rotation curve rises linearly in the
 * core and becomes flat, v → sqrt(4πGρ0) rc, at r ≫ rc.
 */
export class IsothermalHalo implements SphericalComponent {
  readonly r200: number;
  readonly c: number;
  readonly rho0: number;
  constructor(readonly m200: number, readonly rc: number) {
    this.r200 = r200FromMass(m200);
    this.c = this.r200 / rc;
    this.rho0 = m200 / (4 * Math.PI * rc ** 3 * (this.c - Math.atan(this.c)));
  }
  enclosedMass(r: number): number {
    if (r >= this.r200) return this.m200;
    const x = r / this.rc;
    return 4 * Math.PI * this.rho0 * this.rc ** 3 * (x - Math.atan(x));
  }
  density(r: number): number {
    if (r > this.r200) return 0;
    const x = r / this.rc;
    return this.rho0 / (1 + x * x);
  }
  potential(r: number): number {
    if (r >= this.r200) return (-G * this.m200) / r;
    const x = r / this.rc;
    return (-G * this.m200) / this.r200 - 4 * Math.PI * G * this.rho0 * this.rc ** 2 * (isoF(this.c) - isoF(x));
  }
  vcirc(r: number): number {
    return r > 0 ? Math.sqrt((G * this.enclosedMass(r)) / r) : 0;
  }
  /** Asymptotic flat circular velocity sqrt(4πGρ0) rc (ignoring truncation). */
  get vInfinity(): number {
    return Math.sqrt(4 * Math.PI * G * this.rho0) * this.rc;
  }
}

/** Hernquist (1990) sphere: ρ = M a / (2π r (r + a)³), M(<r) = M r²/(r + a)². */
export class HernquistSphere implements SphericalComponent {
  constructor(readonly mass: number, readonly a: number) {}
  enclosedMass(r: number): number {
    return (this.mass * r * r) / ((r + this.a) * (r + this.a));
  }
  density(r: number): number {
    const rr = Math.max(r, 1e-3);
    return (this.mass * this.a) / (2 * Math.PI * rr * (rr + this.a) ** 3);
  }
  potential(r: number): number {
    return (-G * this.mass) / (r + this.a);
  }
  vcirc(r: number): number {
    return r > 0 ? Math.sqrt((G * this.enclosedMass(r)) / r) : 0;
  }
}

export function makeHalo(profile: HaloProfile, m200: number, scale: number): SphericalComponent {
  return profile === 'nfw' ? new NFWHalo(m200, scale) : new IsothermalHalo(m200, scale);
}
