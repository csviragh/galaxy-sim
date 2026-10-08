/**
 * GalaxySim: a face-on 2D galaxy modelled as a continuous, self-gravitating,
 * compressible fluid (Euler + Poisson), embedded in an optional static dark
 * matter halo and stellar bulge, optionally driven by a rotating bar/spiral
 * potential. DOM-free; the UI only reads its fields.
 */
import { Hydro } from './hydro';
import { PoissonSolver } from './poisson';
import { G, MYR_PER_TIME_UNIT, myrToTime } from './units';
import { HernquistSphere, makeHalo, type HaloProfile, type SphericalComponent } from './profiles';
import { forcingBasis, forcingMultiplicity, type ForcingMode, type ForcingParams } from './forcing';

/** 'disk': rotationally supported (spiral / S0). 'hot': pressure supported (elliptical). */
export type GalaxyKind = 'disk' | 'hot';

export interface GalaxyParams {
  kind: GalaxyKind;
  /** Grid cells per side. */
  n: number;
  /** Box side length (kpc). */
  boxSize: number;

  /** Baryonic mass in the fluid (stars + gas, 1e10 M☉). */
  mass: number;
  /** Fraction of the baryonic mass in the cold gas disk (0..0.5). */
  gasFraction: number;
  /** Gas disk scale length in units of the stellar scale length. */
  gasScale: number;
  /** Isothermal sound speed of the gas (km/s). */
  gasSoundSpeed: number;
  /** Disk scale length R_d, or Hernquist-like scale a for 'hot' (kpc). */
  scaleLength: number;
  /** Outer edge of the baryonic distribution (kpc). */
  truncation: number;
  /** Target Toomre Q of the disk ('disk' kind). */
  toomreQ: number;
  /** Fraction of the circular speed supplied by rotation ('hot' kind, 0..1). */
  rotation: number;
  /** Ellipticity 1 − b/a of the initial isodensity contours ('hot' kind). */
  ellipticity: number;
  /** Polytropic index γ of the stellar fluid, P = K Σ^γ (1 = isothermal, 2 = 2D adiabatic). */
  gamma: number;
  /** Minimum initial sound speed / velocity dispersion (km/s). */
  sigmaMin: number;
  /** RMS amplitude of the seeded density perturbation. */
  noise: number;
  seed: number;

  /** Hernquist bulge mass (1e10 M☉, static potential). 0 disables. */
  bulgeMass: number;
  bulgeScale: number;

  darkMatter: boolean;
  haloProfile: HaloProfile;
  /** Halo mass M₂₀₀ (1e10 M☉). */
  haloMass: number;
  /** NFW r_s or isothermal core radius r_c (kpc). */
  haloScale: number;

  forcing: ForcingMode;
  forcingStrength: number;
  /** km/s/kpc */
  patternSpeed: number;
  pitchAngle: number;
  arms: number;
  barRadius: number;

  cfl: number;
  /** Gravitational softening length (kpc) ~ disk thickness. */
  softening: number;
  /** Recompute self-gravity every k steps. */
  gravityEvery: number;
  /** Initial background (atmosphere) surface density. */
  backgroundDensity: number;
  /** Jeans floor: keep the 2D Jeans length ≥ this many cells (0 = off). */
  jeansCells: number;
}

export const defaultGalaxyParams: GalaxyParams = {
  kind: 'disk',
  n: 256,
  boxSize: 40,
  mass: 5,
  gasFraction: 0.15,
  gasScale: 1.5,
  gasSoundSpeed: 10,
  scaleLength: 3,
  truncation: 15,
  toomreQ: 1.25,
  rotation: 0.2,
  ellipticity: 0,
  gamma: 1,
  sigmaMin: 10,
  noise: 0.03,
  seed: 1,
  bulgeMass: 1,
  bulgeScale: 0.6,
  darkMatter: true,
  haloProfile: 'nfw',
  haloMass: 100,
  haloScale: 20,
  forcing: 'spiral',
  forcingStrength: 0.05,
  patternSpeed: 20,
  pitchAngle: 15,
  arms: 2,
  barRadius: 4,
  cfl: 0.45,
  softening: 0.3,
  gravityEvery: 2,
  backgroundDensity: 1e-6,
  jeansCells: 3,
};

/** Params that only take effect on reset(). */
export const INIT_ONLY_KEYS: readonly (keyof GalaxyParams)[] = [
  'kind', 'n', 'boxSize', 'mass', 'gasFraction', 'gasScale', 'gasSoundSpeed', 'scaleLength', 'truncation', 'toomreQ', 'rotation',
  'ellipticity', 'gamma', 'sigmaMin', 'noise', 'seed', 'softening', 'backgroundDensity', 'jeansCells',
];

/** Radial profiles for the rotation-curve / Toomre-Q chart. */
export interface RadialProfiles {
  r: Float64Array;
  /** Circular speeds (km/s) from each component (fluid = stars + gas self-gravity). */
  vDisk: Float64Array;
  vBulge: Float64Array;
  vHalo: Float64Array;
  vBaryon: Float64Array;
  vTotal: Float64Array;
  /** Mass-weighted mean azimuthal velocity of the stellar / gas fluid (km/s). */
  vPhiStars: Float64Array;
  vPhiGas: Float64Array;
  /** Azimuthally averaged surface densities. */
  sigmaStars: Float64Array;
  sigmaGas: Float64Array;
  /** Mass-weighted stellar sound speed / velocity dispersion (km/s). */
  csStars: Float64Array;
  /** Toomre Q = c κ / (π G Σ) of the stars and of the gas, NaN where undefined. */
  qStars: Float64Array;
  qGas: Float64Array;
}

export interface GlobalDiagnostics {
  timeMyr: number;
  steps: number;
  dtMyr: number;
  /** Fluid mass on the grid (stars + gas). */
  mass: number;
  starMass: number;
  gasMass: number;
  /** Cumulative mass lost through the box edges. */
  massOutflow: number;
  kinetic: number;
  potential: number;
  angularMomentum: number;
  /** Mass-weighted mean radius of the stars (kpc). */
  meanRadius: number;
}

export type DensityComponent = 'stars' | 'gas' | 'total';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Time over which the bar/spiral forcing is switched on (code units). */
const FORCING_RAMP = myrToTime(150);

export class GalaxySim {
  params: GalaxyParams;
  readonly n: number;
  readonly dx: number;
  readonly boxSize: number;
  /** Stellar fluid (pressure = velocity dispersion). */
  readonly stars: Hydro;
  /** Cold isothermal gas fluid. */
  readonly gas: Hydro;
  readonly poisson: PoissonSolver;
  /** Cell-centre coordinates (kpc), length n. */
  readonly xs: Float64Array;
  /** Cylindrical radius of each cell (n²). */
  readonly radius: Float64Array;

  /** Self-gravity potential and acceleration (n²). */
  readonly phiSelf: Float64Array;
  private readonly gSelfX: Float64Array;
  private readonly gSelfY: Float64Array;
  /** Static potential & acceleration of halo and bulge (n²). */
  readonly phiHalo: Float64Array;
  private readonly gHaloX: Float64Array;
  private readonly gHaloY: Float64Array;
  readonly phiBulge: Float64Array;
  private readonly gBulgeX: Float64Array;
  private readonly gBulgeY: Float64Array;
  /** Forcing basis fields (n²). */
  private readonly fPc: Float64Array;
  private readonly fPs: Float64Array;
  private readonly fCx: Float64Array;
  private readonly fCy: Float64Array;
  private readonly fSx: Float64Array;
  private readonly fSy: Float64Array;
  private readonly sigmaBuf: Float64Array;

  halo: SphericalComponent;
  bulge: HernquistSphere;
  time = 0;
  steps = 0;
  lastDt = 0;
  private sinceGravity = Infinity;
  private forcingStart = 0;
  /** Reference surface densities of the initial model (for colour scales). */
  sigmaRef = 1;
  gasRef = 1;

  constructor(params: Partial<GalaxyParams> = {}) {
    this.params = { ...defaultGalaxyParams, ...params };
    const p = this.params;
    this.n = p.n;
    this.boxSize = p.boxSize;
    this.dx = p.boxSize / p.n;
    const n = this.n;
    const nn = n * n;
    const jeansFactor = p.jeansCells * G * this.dx;
    this.stars = new Hydro(n, this.dx, { gamma: p.gamma, boundary: 'outflow', floor: p.backgroundDensity * 0.01, jeansFactor });
    this.gas = new Hydro(n, this.dx, { gamma: 1, boundary: 'outflow', floor: p.backgroundDensity * 0.001, jeansFactor });
    this.poisson = new PoissonSolver(n, this.dx, Math.max(p.softening, 0.5 * this.dx), G);
    this.xs = new Float64Array(n);
    for (let i = 0; i < n; i++) this.xs[i] = (i + 0.5 - n / 2) * this.dx;
    this.radius = new Float64Array(nn);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) this.radius[j * n + i] = Math.hypot(this.xs[i], this.xs[j]);
    const a = () => new Float64Array(nn);
    this.phiSelf = a(); this.gSelfX = a(); this.gSelfY = a();
    this.phiHalo = a(); this.gHaloX = a(); this.gHaloY = a();
    this.phiBulge = a(); this.gBulgeX = a(); this.gBulgeY = a();
    this.fPc = a(); this.fPs = a(); this.fCx = a(); this.fCy = a(); this.fSx = a(); this.fSy = a();
    this.sigmaBuf = a();
    this.halo = makeHalo(p.haloProfile, p.haloMass, p.haloScale);
    this.bulge = new HernquistSphere(p.bulgeMass, p.bulgeScale);
    this.rebuildStaticFields();
    this.rebuildForcing();
    this.reset();
  }

  /** Whether the gas fluid is evolved at all. */
  get hasGas(): boolean {
    return this.params.gasFraction > 0;
  }

  // ------------------------------------------------------------------ setup

  /** Update runtime parameters (halo, bulge, forcing, numerics). Init-only keys apply on reset(). */
  setParams(update: Partial<GalaxyParams>): void {
    const old = this.params;
    this.params = { ...old, ...update };
    const p = this.params;
    if (
      p.haloProfile !== old.haloProfile || p.haloMass !== old.haloMass || p.haloScale !== old.haloScale ||
      p.bulgeMass !== old.bulgeMass || p.bulgeScale !== old.bulgeScale
    ) {
      this.halo = makeHalo(p.haloProfile, p.haloMass, p.haloScale);
      this.bulge = new HernquistSphere(p.bulgeMass, p.bulgeScale);
      this.rebuildStaticFields();
    }
    if (
      p.forcing !== old.forcing || p.forcingStrength !== old.forcingStrength || p.pitchAngle !== old.pitchAngle ||
      p.arms !== old.arms || p.barRadius !== old.barRadius || p.truncation !== old.truncation
    ) {
      if (p.forcing !== old.forcing) this.forcingStart = this.time;
      this.rebuildForcing();
    }
  }

  private forcingParams(): ForcingParams {
    const p = this.params;
    return {
      mode: p.forcing,
      strength: p.forcingStrength,
      patternSpeed: p.patternSpeed,
      pitchAngle: p.pitchAngle,
      arms: p.arms,
      barRadius: p.barRadius,
      outerRadius: p.truncation,
    };
  }

  /** Potentials + accelerations of halo and bulge on the grid (analytic). */
  private rebuildStaticFields(): void {
    const { n, xs, radius } = this;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const r = radius[k];
        const x = xs[i], y = xs[j];
        this.phiHalo[k] = this.halo.potential(r);
        this.phiBulge[k] = this.bulge.potential(r);
        const ah = (-G * this.halo.enclosedMass(r)) / (r * r * r);
        const ab = (-G * this.bulge.enclosedMass(r)) / (r * r * r);
        this.gHaloX[k] = ah * x; this.gHaloY[k] = ah * y;
        this.gBulgeX[k] = ab * x; this.gBulgeY[k] = ab * y;
      }
  }

  /** Forcing basis potentials and their gradients (central differences of the analytic Φ). */
  private rebuildForcing(): void {
    const { n, xs } = this;
    const fp = this.forcingParams();
    const h = 1e-3;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = xs[i], y = xs[j];
        const [c0, s0] = forcingBasis(fp, x, y);
        const [cxp, sxp] = forcingBasis(fp, x + h, y);
        const [cxm, sxm] = forcingBasis(fp, x - h, y);
        const [cyp, syp] = forcingBasis(fp, x, y + h);
        const [cym, sym] = forcingBasis(fp, x, y - h);
        this.fPc[k] = c0; this.fPs[k] = s0;
        this.fCx[k] = -(cxp - cxm) / (2 * h); this.fCy[k] = -(cyp - cym) / (2 * h);
        this.fSx[k] = -(sxp - sxm) / (2 * h); this.fSy[k] = -(syp - sym) / (2 * h);
      }
  }

  /** Current forcing factors [a cos(mΩt), a sin(mΩt)]. */
  private forcingFactors(): [number, number] {
    const p = this.params;
    if (p.forcing === 'none' || p.forcingStrength === 0) return [0, 0];
    const ramp = smoothstep((this.time - this.forcingStart) / FORCING_RAMP);
    const ang = forcingMultiplicity(this.forcingParams()) * p.patternSpeed * this.time;
    return [ramp * Math.cos(ang), ramp * Math.sin(ang)];
  }

  /** Current pattern angle of the forcing (radians), for drawing. */
  patternAngle(): number {
    return this.params.patternSpeed * this.time;
  }

  /** Corotation radius of the forcing pattern (kpc) from the current rotation curve, or NaN. */
  corotationRadius(p: RadialProfiles): number {
    const om = this.params.patternSpeed;
    if (this.params.forcing === 'none' || om <= 0) return NaN;
    for (let b = 1; b < p.r.length; b++) if (p.vTotal[b] / p.r[b] < om) return p.r[b];
    return NaN;
  }

  // ------------------------------------------------------- initial conditions

  private taper(R: number): number {
    return 1 / (1 + Math.exp((R - this.params.truncation) / 0.6));
  }

  /** Analytic (unperturbed) azimuthally averaged stellar surface density. */
  starProfile(R: number): number {
    const p = this.params;
    const m = p.mass * (1 - p.gasFraction);
    if (p.kind === 'disk') {
      const s0 = m / (2 * Math.PI * p.scaleLength * p.scaleLength);
      return s0 * Math.exp(-R / p.scaleLength) * this.taper(R);
    }
    // projected-Hernquist-like cusp, normalised to total mass m
    const a = p.scaleLength;
    return ((m * a) / (Math.PI * (R + a) ** 3)) * this.taper(R);
  }

  /** Analytic gas surface density: exponential disk, scale gasScale × R_d. */
  gasProfile(R: number): number {
    const p = this.params;
    const m = p.mass * p.gasFraction;
    if (m <= 0) return 0;
    const rg = p.gasScale * p.scaleLength;
    return ((m / (2 * Math.PI * rg * rg)) * Math.exp(-R / rg)) * this.taper(R);
  }

  /** Re-initialise both fluids in (approximate) equilibrium for the current params. */
  reset(): void {
    const p = this.params;
    const { n, xs, dx, stars, gas } = this;
    this.time = 0;
    this.steps = 0;
    this.forcingStart = 0;
    for (const h of [stars, gas]) {
      h.massOutflow = 0;
      h.massFloor = 0;
    }
    stars.gamma = p.gamma;
    const rand = rng(p.seed);
    const bgS = p.backgroundDensity;
    const bgG = p.backgroundDensity * 0.1;

    // --- 1. density fields (with seeded large-scale perturbations) ---
    const modes: [number, number, number, number][] = [];
    const nm = 48;
    for (let m = 0; m < nm; m++) {
      const lambda = 1.5 + 6.5 * rand();
      const th = 2 * Math.PI * rand();
      const kk = (2 * Math.PI) / lambda;
      modes.push([kk * Math.cos(th), kk * Math.sin(th), 2 * Math.PI * rand(), Math.sqrt(2 / nm)]);
    }
    const q = 1 - (p.kind === 'hot' ? p.ellipticity : 0);
    const nn = n * n;
    const sS = new Float64Array(nn);
    const sG = new Float64Array(nn);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = xs[i], y = xs[j];
        const Re = Math.hypot(x, y / q);
        let d = 0;
        if (p.noise > 0) for (const [kx, ky, ph, amp] of modes) d += amp * Math.cos(kx * x + ky * y + ph);
        const pert = Math.max(0.2, 1 + p.noise * d);
        const k = j * n + i;
        sS[k] = (this.starProfile(Re) / q) * pert + bgS;
        sG[k] = this.gasProfile(this.radius[k]) * pert + bgG;
      }
    this.sigmaRef = this.starProfile(p.kind === 'disk' ? 0 : p.scaleLength * 0.5);
    this.gasRef = Math.max(this.gasProfile(0), 1e-6);

    // --- 2. self-gravity of the baryons + static components ---
    const sum = this.sigmaBuf;
    for (let k = 0; k < nn; k++) sum[k] = sS[k] + sG[k];
    this.poisson.solve(sum, this.phiSelf);
    this.computeSelfAcceleration();

    // --- 3. radial profiles on a 1D grid ---
    const dr = dx;
    const nb = Math.ceil((this.boxSize * Math.SQRT1_2) / dr) + 3;
    const gSum = new Float64Array(nb);
    const cnt = new Float64Array(nb);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const R = this.radius[k];
        const b = Math.floor(R / dr);
        gSum[b] += -(this.gSelfX[k] * xs[i] + this.gSelfY[k] * xs[j]) / R;
        cnt[b] += 1;
      }
    const rb = new Float64Array(nb);
    const gR = new Float64Array(nb); // total inward acceleration
    let last = 0;
    for (let b = 0; b < nb; b++) {
      rb[b] = (b + 0.5) * dr;
      const gs = cnt[b] > 0 ? gSum[b] / cnt[b] : last;
      last = gs;
      const r = rb[b];
      let g = gs + (G * this.bulge.enclosedMass(r)) / (r * r);
      if (p.darkMatter) g += (G * this.halo.enclosedMass(r)) / (r * r);
      gR[b] = Math.max(g, 0);
    }
    const v2 = new Float64Array(nb);
    for (let b = 0; b < nb; b++) v2[b] = rb[b] * gR[b];
    const v2s = new Float64Array(nb); // smoothed, for κ
    for (let b = 0; b < nb; b++) {
      let s = 0, c = 0;
      for (let d = -2; d <= 2; d++) {
        const bb = b + d;
        if (bb >= 0 && bb < nb) { s += v2[bb]; c++; }
      }
      v2s[b] = s / c;
    }
    const kappa = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      const r = rb[b];
      const bm = Math.max(b - 1, 0), bp = Math.min(b + 1, nb - 1);
      const dv2 = (v2s[bp] - v2s[bm]) / (rb[bp] - rb[bm]);
      kappa[b] = Math.sqrt(Math.max((2 * v2s[b]) / (r * r) + dv2 / r, 1e-12));
    }
    const deriv = (f: Float64Array, b: number) => {
      const bm = Math.max(b - 1, 0), bp = Math.min(b + 1, nb - 1);
      return (f[bp] - f[bm]) / (rb[bp] - rb[bm]);
    };
    const sigS = new Float64Array(nb), sigG = new Float64Array(nb);
    for (let b = 0; b < nb; b++) {
      sigS[b] = this.starProfile(rb[b]) + bgS;
      sigG[b] = this.gasProfile(rb[b]) + bgG;
    }

    const cs = new Float64Array(nb);
    const vphiS = new Float64Array(nb);
    const vphiG = new Float64Array(nb);
    const gam = p.gamma;
    if (p.kind === 'disk') {
      // stellar dispersion from the target Toomre Q
      for (let b = 0; b < nb; b++)
        cs[b] = Math.max(p.sigmaMin, (p.toomreQ * Math.PI * G * this.starProfile(rb[b])) / kappa[b]);
      // P = Σ c²/γ; v_φ² = R g + (R/Σ) dP/dR (asymmetric drift)
      const P = new Float64Array(nb);
      for (let b = 0; b < nb; b++) P[b] = (sigS[b] * cs[b] * cs[b]) / gam;
      for (let b = 0; b < nb; b++)
        vphiS[b] = Math.sqrt(Math.max(0, v2[b] + (rb[b] * deriv(P, b)) / sigS[b]));
    } else {
      // hydrostatic: dP/dR = −Σ (1 − λ²) g, integrated inward from the edge
      const lam2 = p.rotation * p.rotation;
      const P = new Float64Array(nb);
      P[nb - 1] = (sigS[nb - 1] * p.sigmaMin * p.sigmaMin) / gam;
      for (let b = nb - 2; b >= 0; b--) {
        const f0 = sigS[b] * gR[b], f1 = sigS[b + 1] * gR[b + 1];
        P[b] = P[b + 1] + 0.5 * (f0 + f1) * (1 - lam2) * dr;
      }
      for (let b = 0; b < nb; b++) {
        cs[b] = Math.max(p.sigmaMin, Math.sqrt((gam * P[b]) / sigS[b]));
        vphiS[b] = p.rotation * Math.sqrt(v2[b]);
      }
    }
    // gas: isothermal, rotationally supported
    const cg = p.gasSoundSpeed;
    const lnSg = new Float64Array(nb);
    for (let b = 0; b < nb; b++) lnSg[b] = Math.log(sigG[b]);
    for (let b = 0; b < nb; b++) vphiG[b] = Math.sqrt(Math.max(0, v2[b] + rb[b] * cg * cg * deriv(lnSg, b)));

    const interp = (arr: Float64Array, R: number) => {
      const t = R / dr - 0.5;
      if (t <= 0) return arr[0];
      const b = Math.floor(t);
      if (b >= nb - 1) return arr[nb - 1];
      const f = t - b;
      return arr[b] * (1 - f) + arr[b + 1] * f;
    };

    // --- 4. fill the fluid states (counter-clockwise rotation) ---
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = xs[i], y = xs[j];
        const R = this.radius[k];
        const Re = Math.hypot(x, y / q);
        const c = interp(cs, p.kind === 'hot' ? Re : R);
        const vs = interp(vphiS, R);
        stars.setCell(i, j, sS[k], (-vs * y) / R, (vs * x) / R, (c * c) / (gam * Math.pow(sS[k], gam - 1)));
        const vg = interp(vphiG, R);
        gas.setCell(i, j, sG[k], (-vg * y) / R, (vg * x) / R, cg * cg);
      }
    stars.applyBoundary();
    gas.applyBoundary();
    this.sinceGravity = Infinity;
  }

  // ---------------------------------------------------------------- dynamics

  /** Copy Σ_stars + Σ_gas from the hydro grids into sigmaBuf (n²). */
  private gatherSigma(): Float64Array {
    this.surfaceDensity(this.sigmaBuf, this.hasGas ? 'total' : 'stars');
    return this.sigmaBuf;
  }

  /** −∇Φ_self by central differences (one-sided at the edges). */
  private computeSelfAcceleration(): void {
    const { n, dx, phiSelf: f, gSelfX: gx, gSelfY: gy } = this;
    const inv2 = 1 / (2 * dx);
    const inv1 = 1 / dx;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        gx[k] = i === 0 ? -(f[k + 1] - f[k]) * inv1 : i === n - 1 ? -(f[k] - f[k - 1]) * inv1 : -(f[k + 1] - f[k - 1]) * inv2;
        gy[k] = j === 0 ? -(f[k + n] - f[k]) * inv1 : j === n - 1 ? -(f[k] - f[k - n]) * inv1 : -(f[k + n] - f[k - n]) * inv2;
      }
  }

  /** Solve Poisson for the current density. */
  updateSelfGravity(): void {
    this.poisson.solve(this.gatherSigma(), this.phiSelf);
    this.computeSelfAcceleration();
    this.sinceGravity = 0;
  }

  /** Assemble the total acceleration into the hydro grids. */
  private assembleAcceleration(): void {
    const { n, stars, gas } = this;
    const dm = this.params.darkMatter ? 1 : 0;
    const [fc, fs] = this.forcingFactors();
    const { gSelfX, gSelfY, gHaloX, gHaloY, gBulgeX, gBulgeY, fCx, fCy, fSx, fSy } = this;
    const gx = stars.gx, gy = stars.gy;
    for (let j = 0; j < n; j++) {
      const o = stars.idx(0, j);
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        gx[o + i] = gSelfX[k] + dm * gHaloX[k] + gBulgeX[k] + fc * fCx[k] + fs * fSx[k];
        gy[o + i] = gSelfY[k] + dm * gHaloY[k] + gBulgeY[k] + fc * fCy[k] + fs * fSy[k];
      }
    }
    if (this.hasGas) {
      gas.gx.set(gx);
      gas.gy.set(gy);
    }
  }

  /** Advance one time step; returns dt (code units). */
  step(): number {
    const p = this.params;
    if (this.sinceGravity >= Math.max(1, p.gravityEvery)) this.updateSelfGravity();
    this.sinceGravity++;
    this.assembleAcceleration();
    let dt = Math.min(this.stars.maxTimeStep(p.cfl), myrToTime(2));
    if (this.hasGas) dt = Math.min(dt, this.gas.maxTimeStep(p.cfl));
    this.stars.step(dt);
    if (this.hasGas) this.gas.step(dt);
    this.time += dt;
    this.steps++;
    this.lastDt = dt;
    return dt;
  }

  get timeMyr(): number {
    return this.time * MYR_PER_TIME_UNIT;
  }

  // ---------------------------------------------------------- field access

  /** Surface density of stars, gas or both into out (n²). */
  surfaceDensity(out: Float32Array | Float64Array, which: DensityComponent = 'total'): void {
    const { n, stars, gas } = this;
    const useS = which !== 'gas';
    const useG = which !== 'stars' && this.hasGas;
    for (let j = 0; j < n; j++) {
      const o = stars.idx(0, j);
      for (let i = 0; i < n; i++)
        out[j * n + i] = (useS ? stars.rho[o + i] : 0) + (useG ? gas.rho[o + i] : 0);
    }
  }

  /** Mass-weighted velocity of stars + gas (km/s) into outU/outV (n²). */
  velocity(outU: Float32Array | Float64Array, outV: Float32Array | Float64Array): void {
    const { n, stars, gas } = this;
    const g = this.hasGas ? 1 : 0;
    for (let j = 0; j < n; j++) {
      const o = stars.idx(0, j);
      for (let i = 0; i < n; i++) {
        const k = o + i;
        const r = stars.rho[k] + g * gas.rho[k];
        outU[j * n + i] = (stars.mx[k] + g * gas.mx[k]) / r;
        outV[j * n + i] = (stars.my[k] + g * gas.my[k]) / r;
      }
    }
  }

  /** Total gravitational potential (km/s)² currently felt by the fluid (n²). */
  totalPotential(out: Float32Array | Float64Array): void {
    const { n } = this;
    const dm = this.params.darkMatter ? 1 : 0;
    const [fc, fs] = this.forcingFactors();
    for (let k = 0; k < n * n; k++)
      out[k] = this.phiSelf[k] + dm * this.phiHalo[k] + this.phiBulge[k] + fc * this.fPc[k] + fs * this.fPs[k];
  }

  /**
   * Vorticity ω = ∂v/∂x − ∂u/∂y (km/s/kpc) of the stellar fluid into out (n²).
   * With `perturbation`, the azimuthal mean ⟨ω⟩(R) is subtracted, which hides
   * the background differential rotation and shows arms, bars and shocks.
   */
  vorticity(out: Float32Array | Float64Array, perturbation = false): void {
    const { n, dx } = this;
    const h = this.stars;
    const { rho, mx, my, S } = h;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = h.idx(i, j);
        const dvdx = my[k + 1] / rho[k + 1] - my[k - 1] / rho[k - 1];
        const dudy = mx[k + S] / rho[k + S] - mx[k - S] / rho[k - S];
        out[j * n + i] = (dvdx - dudy) / (2 * dx);
      }
    if (!perturbation) return;
    const nb = Math.ceil(this.boxSize / dx) + 2;
    const sum = new Float64Array(nb), cnt = new Float64Array(nb);
    for (let k = 0; k < n * n; k++) {
      const b = Math.floor(this.radius[k] / dx);
      sum[b] += out[k];
      cnt[b]++;
    }
    for (let k = 0; k < n * n; k++) {
      const b = Math.floor(this.radius[k] / dx);
      out[k] -= sum[b] / cnt[b];
    }
  }

  /** Mid-plane dark-matter density ρ_DM(R) (1e10 M☉/kpc³) into out (n²). */
  haloDensity(out: Float32Array | Float64Array): void {
    for (let k = 0; k < this.n * this.n; k++) out[k] = this.halo.density(this.radius[k]);
  }

  // ------------------------------------------------------------ diagnostics

  /** Global conserved / energy quantities. */
  globals(): GlobalDiagnostics {
    const { n, xs, dx } = this;
    const dm = this.params.darkMatter ? 1 : 0;
    let ms = 0, mg = 0, ke = 0, w = 0, lz = 0, mr = 0;
    const fluids = this.hasGas ? [this.stars, this.gas] : [this.stars];
    for (const h of fluids) {
      const isStars = h === this.stars;
      for (let j = 0; j < n; j++) {
        const o = h.idx(0, j);
        for (let i = 0; i < n; i++) {
          const r = h.rho[o + i], px = h.mx[o + i], py = h.my[o + i];
          const k = j * n + i;
          if (isStars) {
            ms += r;
            mr += r * this.radius[k];
          } else mg += r;
          ke += (0.5 * (px * px + py * py)) / r;
          w += r * (0.5 * this.phiSelf[k] + dm * this.phiHalo[k] + this.phiBulge[k]);
          lz += xs[i] * py - xs[j] * px;
        }
      }
    }
    const a = dx * dx;
    return {
      timeMyr: this.timeMyr,
      steps: this.steps,
      dtMyr: this.lastDt * MYR_PER_TIME_UNIT,
      mass: (ms + mg) * a,
      starMass: ms * a,
      gasMass: mg * a,
      massOutflow: this.stars.massOutflow + (this.hasGas ? this.gas.massOutflow : 0),
      kinetic: ke * a,
      potential: w * a,
      angularMomentum: lz * a,
      meanRadius: mr / ms,
    };
  }

  /**
   * Azimuthally averaged profiles in rings of width dr out to rMax: rotation
   * curve components (self-gravity of the fluid measured from the grid
   * potential, analytic bulge & halo), mean fluid v_φ, Σ, c_s and Toomre Q.
   */
  profiles(dr = 0.5, rMax = this.boxSize / 2): RadialProfiles {
    const { n, stars, gas, xs } = this;
    const nb = Math.max(2, Math.floor(rMax / dr));
    const r = new Float64Array(nb);
    const gS = new Float64Array(nb), cnt = new Float64Array(nb);
    const mS = new Float64Array(nb), mvS = new Float64Array(nb), mc = new Float64Array(nb);
    const mG = new Float64Array(nb), mvG = new Float64Array(nb);
    const gam = stars.gamma;
    const hasGas = this.hasGas;
    for (let j = 0; j < n; j++) {
      const o = stars.idx(0, j);
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const R = this.radius[k];
        const b = Math.floor(R / dr);
        if (b >= nb) continue;
        const x = xs[i], y = xs[j];
        gS[b] += -(this.gSelfX[k] * x + this.gSelfY[k] * y) / R;
        cnt[b]++;
        const s = stars.rho[o + i];
        const K = stars.ek[o + i] / s;
        mS[b] += s;
        mvS[b] += (x * stars.my[o + i] - y * stars.mx[o + i]) / R;
        mc[b] += s * Math.sqrt(gam * K * Math.pow(s, gam - 1));
        if (hasGas) {
          mG[b] += gas.rho[o + i];
          mvG[b] += (x * gas.my[o + i] - y * gas.mx[o + i]) / R;
        }
      }
    }
    const signedSqrt = (x: number) => (x >= 0 ? Math.sqrt(x) : -Math.sqrt(-x));
    const f = () => new Float64Array(nb);
    const vDisk = f(), vBulge = f(), vHalo = f(), vBaryon = f(), vTotal = f();
    const vPhiStars = f(), vPhiGas = f(), sigmaStars = f(), sigmaGas = f(), csStars = f();
    const qStars = f(), qGas = f();
    const dm = this.params.darkMatter;
    for (let b = 0; b < nb; b++) {
      const R = (b + 0.5) * dr;
      r[b] = R;
      const d2 = cnt[b] > 0 ? (R * gS[b]) / cnt[b] : 0;
      const b2 = this.bulge.vcirc(R) ** 2;
      const h2 = this.halo.vcirc(R) ** 2;
      vDisk[b] = signedSqrt(d2);
      vBulge[b] = Math.sqrt(b2);
      vHalo[b] = Math.sqrt(h2);
      vBaryon[b] = signedSqrt(d2 + b2);
      vTotal[b] = signedSqrt(d2 + b2 + (dm ? h2 : 0));
      sigmaStars[b] = cnt[b] > 0 ? mS[b] / cnt[b] : 0;
      sigmaGas[b] = cnt[b] > 0 ? mG[b] / cnt[b] : 0;
      vPhiStars[b] = mS[b] > 0 ? mvS[b] / mS[b] : 0;
      vPhiGas[b] = mG[b] > 0 ? mvG[b] / mG[b] : NaN;
      csStars[b] = mS[b] > 0 ? mc[b] / mS[b] : 0;
    }
    // Toomre Q from the (total) rotation curve: κ² = 2v²/R² + (1/R) dv²/dR
    const cg = this.params.gasSoundSpeed;
    for (let b = 0; b < nb; b++) {
      const bm = Math.max(b - 1, 0), bp = Math.min(b + 1, nb - 1);
      const R = r[b];
      const v2 = vTotal[b] * Math.abs(vTotal[b]);
      const dv2 = (vTotal[bp] * Math.abs(vTotal[bp]) - vTotal[bm] * Math.abs(vTotal[bm])) / (r[bp] - r[bm]);
      const k2 = (2 * v2) / (R * R) + dv2 / R;
      const kap = k2 > 0 ? Math.sqrt(k2) : NaN;
      qStars[b] = sigmaStars[b] > 0 ? (csStars[b] * kap) / (Math.PI * G * sigmaStars[b]) : NaN;
      qGas[b] = hasGas && sigmaGas[b] > 0 ? (cg * kap) / (Math.PI * G * sigmaGas[b]) : NaN;
    }
    return { r, vDisk, vBulge, vHalo, vBaryon, vTotal, vPhiStars, vPhiGas, sigmaStars, sigmaGas, csStars, qStars, qGas };
  }

  /** True if any conserved variable is NaN/Infinity. */
  hasNaN(): boolean {
    for (const h of [this.stars, this.gas]) {
      const { rho, mx, my, ek } = h;
      for (let k = 0; k < rho.length; k++)
        if (!Number.isFinite(rho[k] + mx[k] + my[k] + ek[k])) return true;
    }
    return false;
  }
}
