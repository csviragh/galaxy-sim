/**
 * Compressible, self-gravitating 2D fluid on a uniform Cartesian grid.
 *
 * Conserved variables per cell (all per unit area):
 *   Σ        surface density
 *   Σu, Σv   momentum
 *   ΣK       "entropy" density; K is the adiabat in P = K Σ^γ
 *
 * Equations (isothermal for γ = 1, barotropic/polytropic otherwise; K is
 * carried with the flow so different fluid parcels can have different
 * effective temperatures / velocity dispersions):
 *
 *   ∂Σ/∂t   + ∇·(Σu)           = 0
 *   ∂(Σu)/∂t + ∇·(Σuu + P I)   = −Σ ∇Φ = Σ g
 *   ∂(ΣK)/∂t + ∇·(ΣK u)        = 0
 *
 * Scheme: unsplit MUSCL–Hancock finite volume.
 *   1. primitive variables (Σ, u, v, K), van Leer–limited slopes
 *   2. half-step predictor in primitive form (incl. ½Δt g)
 *   3. HLL Riemann fluxes at every face; the transverse momentum and the
 *      passive adiabat are upwinded with the HLL mass flux (an HLLC-like
 *      fix that keeps shear layers, i.e. differential rotation, sharp)
 *   4. conservative update + gravity source Δt Σ^{n+½} g
 * Second order in space and time; stable for CFL ≲ 0.5 with the
 * (|u|+c)+(|v|+c) wave-speed bound used in maxTimeStep().
 */
export type Boundary = 'outflow' | 'periodic' | 'reflect';

export interface HydroOptions {
  gamma?: number;
  boundary?: Boundary;
  /** Density floor (code units). */
  floor?: number;
  /** Velocity cap (km/s) applied to every cell for robustness. */
  vmax?: number;
  /**
   * Jeans pressure floor: enforce c² ≥ jeansFactor · Σ (e.g. N_J G Δx), so the
   * 2D Jeans length c²/(GΣ) never drops below N_J cells. Prevents artificial,
   * grid-scale fragmentation (Truelove et al. 1997). 0 disables.
   */
  jeansFactor?: number;
}

const GHOST = 2;

/** x^p with fast paths for the common p = 0, 1, 2. */
const pw = (x: number, p: number): number => (p === 0 ? 1 : p === 1 ? x : p === 2 ? x * x : Math.pow(x, p));

export class Hydro {
  readonly n: number;
  /** Padded row stride (n + 4). */
  readonly S: number;
  readonly dx: number;
  gamma: number;
  boundary: Boundary;
  floor: number;
  vmax: number;
  jeansFactor: number;

  // conserved, padded
  readonly rho: Float64Array;
  readonly mx: Float64Array;
  readonly my: Float64Array;
  readonly ek: Float64Array;
  /** Gravitational acceleration, padded (interior written by the caller). */
  readonly gx: Float64Array;
  readonly gy: Float64Array;

  // primitives and scratch
  private readonly pr: Float64Array;
  private readonly pu: Float64Array;
  private readonly pv: Float64Array;
  private readonly pk: Float64Array;
  private readonly sxr: Float64Array;
  private readonly sxu: Float64Array;
  private readonly sxv: Float64Array;
  private readonly sxk: Float64Array;
  private readonly syr: Float64Array;
  private readonly syu: Float64Array;
  private readonly syv: Float64Array;
  private readonly syk: Float64Array;
  private readonly hr: Float64Array;
  private readonly hu: Float64Array;
  private readonly hv: Float64Array;
  private readonly hk: Float64Array;
  private readonly fr: Float64Array;
  private readonly fm: Float64Array;
  private readonly ft: Float64Array;
  private readonly fk: Float64Array;
  private readonly gr: Float64Array;
  private readonly gm: Float64Array;
  private readonly gt: Float64Array;
  private readonly gk: Float64Array;

  /** Mass that left through the boundary (code units), cumulative. */
  massOutflow = 0;
  /** Mass added by the density floor, cumulative. */
  massFloor = 0;

  constructor(n: number, dx: number, opts: HydroOptions = {}) {
    this.n = n;
    this.dx = dx;
    this.S = n + 2 * GHOST;
    this.gamma = opts.gamma ?? 1;
    this.boundary = opts.boundary ?? 'outflow';
    this.floor = opts.floor ?? 1e-8;
    this.vmax = opts.vmax ?? 2000;
    this.jeansFactor = opts.jeansFactor ?? 0;
    const size = this.S * this.S;
    const a = () => new Float64Array(size);
    this.rho = a(); this.mx = a(); this.my = a(); this.ek = a();
    this.gx = a(); this.gy = a();
    this.pr = a(); this.pu = a(); this.pv = a(); this.pk = a();
    this.sxr = a(); this.sxu = a(); this.sxv = a(); this.sxk = a();
    this.syr = a(); this.syu = a(); this.syv = a(); this.syk = a();
    this.hr = a(); this.hu = a(); this.hv = a(); this.hk = a();
    this.fr = a(); this.fm = a(); this.ft = a(); this.fk = a();
    this.gr = a(); this.gm = a(); this.gt = a(); this.gk = a();
    this.rho.fill(this.floor);
  }

  /** Padded index of interior cell (i, j), 0 ≤ i, j < n. */
  idx(i: number, j: number): number {
    return (j + GHOST) * this.S + i + GHOST;
  }

  /** Set the state of interior cell (i, j) from primitives. K is the adiabat. */
  setCell(i: number, j: number, sigma: number, u: number, v: number, K: number): void {
    const k = this.idx(i, j);
    this.rho[k] = sigma;
    this.mx[k] = sigma * u;
    this.my[k] = sigma * v;
    this.ek[k] = sigma * K;
  }

  /** Pressure of interior cell (i, j). */
  pressure(i: number, j: number): number {
    const k = this.idx(i, j);
    const r = this.rho[k];
    return (this.ek[k] / r) * pw(r, this.gamma);
  }

  /** Adiabatic sound speed of interior cell (i, j). */
  soundSpeed(i: number, j: number): number {
    const k = this.idx(i, j);
    const r = this.rho[k];
    return Math.sqrt(((this.gamma * this.ek[k]) / r) * pw(r, this.gamma - 1));
  }

  /** Total mass in the interior (Σ dx² summed). */
  totalMass(): number {
    const { n, rho, dx } = this;
    let m = 0;
    for (let j = 0; j < n; j++) {
      const o = this.idx(0, j);
      for (let i = 0; i < n; i++) m += rho[o + i];
    }
    return m * dx * dx;
  }

  /** Copy interior accelerations into the ghost layers (zero-gradient). */
  private fillGravityGhosts(): void {
    this.fillGhostsScalar(this.gx);
    this.fillGhostsScalar(this.gy);
  }

  private fillGhostsScalar(a: Float64Array): void {
    const { S, n } = this;
    for (let j = GHOST; j < n + GHOST; j++) {
      const o = j * S;
      for (let g = 0; g < GHOST; g++) {
        a[o + g] = a[o + GHOST];
        a[o + n + GHOST + g] = a[o + n + GHOST - 1];
      }
    }
    for (let g = 0; g < GHOST; g++) {
      a.copyWithin(g * S, GHOST * S, GHOST * S + S);
      a.copyWithin((n + GHOST + g) * S, (n + GHOST - 1) * S, (n + GHOST) * S);
    }
  }

  /** Fill ghost cells of the conserved variables according to `boundary`. */
  applyBoundary(): void {
    const { S, n, rho, mx, my, ek, boundary } = this;
    const arrs = [rho, mx, my, ek];
    const lo = GHOST;
    const hi = n + GHOST - 1;
    // x boundaries on interior rows
    for (let j = lo; j <= hi; j++) {
      const o = j * S;
      for (let g = 1; g <= GHOST; g++) {
        const gl = o + lo - g;
        const gh = o + hi + g;
        let sl: number, sh: number;
        if (boundary === 'periodic') {
          sl = o + hi - g + 1;
          sh = o + lo + g - 1;
        } else if (boundary === 'reflect') {
          sl = o + lo + g - 1;
          sh = o + hi - g + 1;
        } else {
          sl = o + lo;
          sh = o + hi;
        }
        for (const a of arrs) {
          a[gl] = a[sl];
          a[gh] = a[sh];
        }
        if (boundary === 'reflect') {
          mx[gl] = -mx[gl];
          mx[gh] = -mx[gh];
        } else if (boundary === 'outflow') {
          if (mx[gl] > 0) mx[gl] = 0; // no inflow
          if (mx[gh] < 0) mx[gh] = 0;
        }
      }
    }
    // y boundaries on full rows (incl. x ghosts → corners)
    for (let g = 1; g <= GHOST; g++) {
      const gl = (lo - g) * S;
      const gh = (hi + g) * S;
      let sl: number, sh: number;
      if (boundary === 'periodic') {
        sl = (hi - g + 1) * S;
        sh = (lo + g - 1) * S;
      } else if (boundary === 'reflect') {
        sl = (lo + g - 1) * S;
        sh = (hi - g + 1) * S;
      } else {
        sl = lo * S;
        sh = hi * S;
      }
      for (const a of arrs) {
        a.copyWithin(gl, sl, sl + S);
        a.copyWithin(gh, sh, sh + S);
      }
      for (let i = 0; i < S; i++) {
        if (boundary === 'reflect') {
          my[gl + i] = -my[gl + i];
          my[gh + i] = -my[gh + i];
        } else if (boundary === 'outflow') {
          if (my[gl + i] > 0) my[gl + i] = 0;
          if (my[gh + i] < 0) my[gh + i] = 0;
        }
      }
    }
  }

  /** Largest stable time step for the given CFL number. */
  maxTimeStep(cfl: number): number {
    const { n, S, rho, mx, my, ek, gamma } = this;
    const g1 = gamma - 1;
    let smax = 1e-12;
    for (let j = GHOST; j < n + GHOST; j++) {
      for (let k = j * S + GHOST, e = k + n; k < e; k++) {
        const r = rho[k];
        const ir = 1 / r;
        const K = ek[k] * ir;
        const c = Math.sqrt(gamma * K * pw(r, g1));
        const s = Math.abs(mx[k] * ir) + Math.abs(my[k] * ir) + 2 * c;
        if (s > smax) smax = s;
      }
    }
    return (cfl * this.dx) / smax;
  }

  /** Advance by dt using the accelerations in gx/gy (interior). */
  step(dt: number): void {
    const { S, n, dx, gamma, rho, mx, my, ek, gx, gy } = this;
    const { pr, pu, pv, pk, sxr, sxu, sxv, sxk, syr, syu, syv, syk, hr, hu, hv, hk } = this;
    const { fr, fm, ft, fk, gr, gm, gt, gk } = this;
    const floor = this.floor;
    const g1 = gamma - 1;

    this.applyBoundary();
    this.fillGravityGhosts();

    // 1. primitives everywhere
    const size = S * S;
    for (let k = 0; k < size; k++) {
      const r = rho[k] > floor ? rho[k] : floor;
      const ir = 1 / r;
      pr[k] = r;
      pu[k] = mx[k] * ir;
      pv[k] = my[k] * ir;
      pk[k] = ek[k] * ir;
    }

    // 2. limited slopes (per cell differences) on cells 1..S-2
    const vl = (a: number, b: number) => (a * b > 0 ? (2 * a * b) / (a + b) : 0);
    for (let j = 1; j < S - 1; j++) {
      for (let k = j * S + 1, e = j * S + S - 1; k < e; k++) {
        sxr[k] = vl(pr[k] - pr[k - 1], pr[k + 1] - pr[k]);
        sxu[k] = vl(pu[k] - pu[k - 1], pu[k + 1] - pu[k]);
        sxv[k] = vl(pv[k] - pv[k - 1], pv[k + 1] - pv[k]);
        sxk[k] = vl(pk[k] - pk[k - 1], pk[k + 1] - pk[k]);
        syr[k] = vl(pr[k] - pr[k - S], pr[k + S] - pr[k]);
        syu[k] = vl(pu[k] - pu[k - S], pu[k + S] - pu[k]);
        syv[k] = vl(pv[k] - pv[k - S], pv[k + S] - pv[k]);
        syk[k] = vl(pk[k] - pk[k - S], pk[k + S] - pk[k]);
      }
    }

    // 3. half-step predictor (primitive form)
    const h = (0.5 * dt) / dx;
    const hdt = 0.5 * dt;
    for (let j = 1; j < S - 1; j++) {
      for (let k = j * S + 1, e = j * S + S - 1; k < e; k++) {
        const r = pr[k], u = pu[k], v = pv[k], K = pk[k];
        const rg1 = pw(r, g1);
        const c2 = gamma * K * rg1;
        const drx = sxr[k], dux = sxu[k], dvx = sxv[k], dkx = sxk[k];
        const dry = syr[k], duy = syu[k], dvy = syv[k], dky = syk[k];
        const ir = 1 / r;
        let nr = r - h * (u * drx + r * dux + v * dry + r * dvy);
        if (nr < floor) nr = floor;
        hr[k] = nr;
        hu[k] = u - h * (u * dux + v * duy + c2 * drx * ir + rg1 * dkx) + hdt * gx[k];
        hv[k] = v - h * (u * dvx + v * dvy + c2 * dry * ir + rg1 * dky) + hdt * gy[k];
        const nk = K - h * (u * dkx + v * dky);
        hk[k] = nk > 0 ? nk : K;
      }
    }

    // 4. fluxes. x-face at padded index k is between cells k-1 and k.
    const lo = GHOST, hi = n + GHOST; // interior cells lo..hi-1
    for (let j = lo; j < hi; j++) {
      for (let k = j * S + lo, e = j * S + hi + 1; k < e; k++) {
        const L = k - 1;
        let rL = hr[L] + 0.5 * sxr[L]; if (rL < floor) rL = floor;
        let rR = hr[k] - 0.5 * sxr[k]; if (rR < floor) rR = floor;
        riemann(
          rL, hu[L] + 0.5 * sxu[L], hv[L] + 0.5 * sxv[L], Math.max(hk[L] + 0.5 * sxk[L], 0),
          rR, hu[k] - 0.5 * sxu[k], hv[k] - 0.5 * sxv[k], Math.max(hk[k] - 0.5 * sxk[k], 0),
          gamma, OUT,
        );
        fr[k] = OUT[0]; fm[k] = OUT[1]; ft[k] = OUT[2]; fk[k] = OUT[3];
      }
    }
    for (let j = lo; j < hi + 1; j++) {
      for (let k = j * S + lo, e = j * S + hi; k < e; k++) {
        const D = k - S;
        let rL = hr[D] + 0.5 * syr[D]; if (rL < floor) rL = floor;
        let rR = hr[k] - 0.5 * syr[k]; if (rR < floor) rR = floor;
        // y-direction: normal velocity is v, transverse is u
        riemann(
          rL, hv[D] + 0.5 * syv[D], hu[D] + 0.5 * syu[D], Math.max(hk[D] + 0.5 * syk[D], 0),
          rR, hv[k] - 0.5 * syv[k], hu[k] - 0.5 * syu[k], Math.max(hk[k] - 0.5 * syk[k], 0),
          gamma, OUT,
        );
        gr[k] = OUT[0]; gm[k] = OUT[1]; gt[k] = OUT[2]; gk[k] = OUT[3];
      }
    }

    // boundary mass bookkeeping (positive = leaving the domain)
    let out = 0;
    for (let j = lo; j < hi; j++) {
      out += -fr[j * S + lo] + fr[j * S + hi];
      out += -gr[lo * S + j] + gr[hi * S + j];
    }
    if (this.boundary !== 'periodic') this.massOutflow += out * dt * dx;

    // 5. conservative update + gravity source
    const c = dt / dx;
    const vmax = this.vmax;
    // Jeans floor on the adiabat: K ≥ jf Σ / (γ Σ^{γ−1}) = (jf/γ) Σ^{2−γ}
    const jf = this.jeansFactor / gamma;
    const g2 = 2 - gamma;
    let added = 0;
    for (let j = lo; j < hi; j++) {
      for (let k = j * S + lo, e = j * S + hi; k < e; k++) {
        const U = k + S;
        let r = rho[k] - c * (fr[k + 1] - fr[k] + gr[U] - gr[k]);
        let px = mx[k] - c * (fm[k + 1] - fm[k] + gt[U] - gt[k]) + dt * hr[k] * gx[k];
        let py = my[k] - c * (ft[k + 1] - ft[k] + gm[U] - gm[k]) + dt * hr[k] * gy[k];
        let ee = ek[k] - c * (fk[k + 1] - fk[k] + gk[U] - gk[k]);
        if (!(r > floor)) {
          // floor: keep the velocity and adiabat of the cell
          const ir = 1 / Math.max(rho[k], floor);
          const u = mx[k] * ir, v = my[k] * ir, K = ek[k] * ir;
          added += floor - (r > 0 ? r : 0);
          r = floor;
          px = r * u; py = r * v; ee = r * K;
        }
        if (!(ee > 0)) ee = r * pk[k];
        if (jf > 0) {
          const kmin = jf * pw(r, g2);
          if (ee < r * kmin) ee = r * kmin;
        }
        const sp2 = (px * px + py * py) / (r * r);
        if (sp2 > vmax * vmax) {
          const f = vmax / Math.sqrt(sp2);
          px *= f; py *= f;
        }
        rho[k] = r; mx[k] = px; my[k] = py; ek[k] = ee;
      }
    }
    this.massFloor += added * dx * dx;
  }
}

const OUT = new Float64Array(4);

/**
 * HLL flux for the barotropic Euler equations along the normal direction, with
 * transverse velocity and adiabat upwinded by the mass flux.
 * out = [F_Σ, F_normal-momentum, F_transverse-momentum, F_ΣK]
 */
function riemann(
  rL: number, uL: number, vL: number, kL: number,
  rR: number, uR: number, vR: number, kR: number,
  gamma: number, out: Float64Array,
): void {
  const pL = kL * pw(rL, gamma);
  const pR = kR * pw(rR, gamma);
  const cL = Math.sqrt((gamma * pL) / rL);
  const cR = Math.sqrt((gamma * pR) / rR);
  const sL = Math.min(uL - cL, uR - cR);
  const sR = Math.max(uL + cL, uR + cR);
  let F0: number, F1: number;
  if (sL >= 0) {
    F0 = rL * uL;
    F1 = rL * uL * uL + pL;
  } else if (sR <= 0) {
    F0 = rR * uR;
    F1 = rR * uR * uR + pR;
  } else {
    const inv = 1 / (sR - sL);
    const ss = sL * sR;
    F0 = (sR * rL * uL - sL * rR * uR + ss * (rR - rL)) * inv;
    F1 = (sR * (rL * uL * uL + pL) - sL * (rR * uR * uR + pR) + ss * (rR * uR - rL * uL)) * inv;
  }
  out[0] = F0;
  out[1] = F1;
  if (F0 >= 0) {
    out[2] = F0 * vL;
    out[3] = F0 * kL;
  } else {
    out[2] = F0 * vR;
    out[3] = F0 * kR;
  }
}
