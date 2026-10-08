/**
 * Gravitational potential of a 2D surface density Σ(x, y) living in the plane
 * z = 0 of 3D space (a razor-thin sheet), with Plummer softening ε:
 *
 *   Φ(x) = −G ∫ Σ(x′) / sqrt(|x − x′|² + ε²) d²x′
 *
 * This is the in-plane solution of ∇²Φ = 4πG Σ δ(z) (the 3D Poisson equation)
 * for a sheet, with the vertical structure (finite thickness ~ ε) modelled by
 * the softening. Note it is NOT 2D "logarithmic" gravity.
 *
 * The convolution is evaluated exactly (up to round-off) on the grid with the
 * Hockney–Eastwood zero-padding method: the n×n density is embedded in an
 * M×M (M ≥ 2n) array, so the FFT's periodic images never overlap and the
 * result equals isolated (vacuum) boundary conditions. Because density and
 * potential are real, two real rows are packed into each complex row FFT and
 * only the non-redundant half of the column spectra is transformed.
 */
import { FFT, nextPow2 } from './fft';

export class PoissonSolver {
  readonly n: number;
  readonly m: number;
  readonly dx: number;
  readonly softening: number;
  readonly G: number;
  private readonly fft: FFT;
  private readonly half: number;
  /** Real spectrum of the Green's function, size m × (m/2 + 1). */
  private readonly kernel: Float64Array;
  private readonly sre: Float64Array;
  private readonly sim: Float64Array;
  private readonly bre: Float64Array;
  private readonly bim: Float64Array;

  constructor(n: number, dx: number, softening: number, G: number) {
    this.n = n;
    this.dx = dx;
    this.softening = softening;
    this.G = G;
    this.m = nextPow2(2 * n);
    const m = this.m;
    this.half = m / 2 + 1;
    this.fft = new FFT(m);
    this.sre = new Float64Array(m * this.half);
    this.sim = new Float64Array(m * this.half);
    this.bre = new Float64Array(m);
    this.bim = new Float64Array(m);
    this.kernel = this.buildKernel();
  }

  /** Green's function per unit surface density in one cell: −G dx² / r_soft. */
  greens(di: number, dj: number): number {
    const dx = this.dx;
    const r2 = (di * di + dj * dj) * dx * dx + this.softening * this.softening;
    return (-this.G * dx * dx) / Math.sqrt(r2);
  }

  private buildKernel(): Float64Array {
    const { m, n, half } = this;
    const re = new Float64Array(m * m);
    const im = new Float64Array(m * m);
    for (let j = 0; j < m; j++) {
      const dj = j <= m / 2 ? j : j - m;
      if (Math.abs(dj) >= n) continue;
      for (let i = 0; i < m; i++) {
        const di = i <= m / 2 ? i : i - m;
        if (Math.abs(di) >= n) continue;
        re[j * m + i] = this.greens(di, dj);
      }
    }
    const { bre, bim } = this;
    // rows
    for (let j = 0; j < m; j++) {
      const o = j * m;
      for (let i = 0; i < m; i++) {
        bre[i] = re[o + i];
        bim[i] = im[o + i];
      }
      this.fft.transform(bre, bim);
      for (let i = 0; i < m; i++) {
        re[o + i] = bre[i];
        im[o + i] = bim[i];
      }
    }
    // columns
    const k = new Float64Array(m * half);
    for (let i = 0; i < half; i++) {
      for (let j = 0; j < m; j++) {
        bre[j] = re[j * m + i];
        bim[j] = im[j * m + i];
      }
      this.fft.transform(bre, bim);
      // the kernel is even in x and y, so its spectrum is real
      for (let j = 0; j < m; j++) k[j * half + i] = bre[j] / (m * m);
    }
    return k;
  }

  /**
   * Compute the potential `phi` (length n²) of the surface density `sigma`
   * (length n², row-major, index = j * n + i). Returns phi.
   */
  solve(sigma: ArrayLike<number>, phi: Float64Array = new Float64Array(this.n * this.n)): Float64Array {
    const { n, m, half, sre, sim, bre, bim, kernel, fft } = this;
    // --- forward row transforms, two real rows per complex FFT ---
    for (let j = 0; j < n; j += 2) {
      const two = j + 1 < n;
      const o0 = j * n;
      const o1 = o0 + n;
      for (let i = 0; i < n; i++) {
        bre[i] = sigma[o0 + i];
        bim[i] = two ? sigma[o1 + i] : 0;
      }
      bre.fill(0, n);
      bim.fill(0, n);
      fft.transform(bre, bim);
      // separate: A = (Z[k] + conj Z[m-k]) / 2, B = (Z[k] - conj Z[m-k]) / 2i
      const r0 = j * half;
      const r1 = r0 + half;
      for (let k = 0; k < half; k++) {
        const mk = (m - k) & (m - 1);
        const zr = bre[k];
        const zi = bim[k];
        const cr = bre[mk];
        const ci = -bim[mk];
        sre[r0 + k] = 0.5 * (zr + cr);
        sim[r0 + k] = 0.5 * (zi + ci);
        if (two) {
          // (Z - conjZ') / 2i = (dr + i di) / 2i = (di - i dr) / 2
          sre[r1 + k] = 0.5 * (zi - ci);
          sim[r1 + k] = -0.5 * (zr - cr);
        }
      }
    }
    // --- column transforms on the non-redundant half, multiply, inverse ---
    for (let k = 0; k < half; k++) {
      for (let j = 0; j < n; j++) {
        bre[j] = sre[j * half + k];
        bim[j] = sim[j * half + k];
      }
      bre.fill(0, n);
      bim.fill(0, n);
      fft.transform(bre, bim);
      for (let j = 0; j < m; j++) {
        const g = kernel[j * half + k];
        bre[j] *= g;
        bim[j] *= g;
      }
      fft.transform(bre, bim, true);
      for (let j = 0; j < n; j++) {
        sre[j * half + k] = bre[j];
        sim[j * half + k] = bim[j];
      }
    }
    // --- inverse row transforms (Hermitian rows → real), two rows at once ---
    for (let j = 0; j < n; j += 2) {
      const two = j + 1 < n;
      const r0 = j * half;
      const r1 = r0 + half;
      for (let k = 0; k < half; k++) {
        const ar = sre[r0 + k];
        const ai = sim[r0 + k];
        const br = two ? sre[r1 + k] : 0;
        const bi = two ? sim[r1 + k] : 0;
        // Z[k] = A[k] + i B[k]
        bre[k] = ar - bi;
        bim[k] = ai + br;
        if (k > 0 && k < m / 2) {
          // Z[m-k] = conj(A[k]) + i conj(B[k])
          bre[m - k] = ar + bi;
          bim[m - k] = -ai + br;
        }
      }
      fft.transform(bre, bim, true);
      const o0 = j * n;
      for (let i = 0; i < n; i++) phi[o0 + i] = bre[i];
      if (two) for (let i = 0; i < n; i++) phi[o0 + n + i] = bim[i];
    }
    return phi;
  }

  /** O(n⁴) direct summation, for testing only. */
  solveDirect(sigma: ArrayLike<number>): Float64Array {
    const n = this.n;
    const phi = new Float64Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let jj = 0; jj < n; jj++)
          for (let ii = 0; ii < n; ii++) s += sigma[jj * n + ii] * this.greens(i - ii, j - jj);
        phi[j * n + i] = s;
      }
    return phi;
  }
}
