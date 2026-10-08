import { describe, expect, it } from 'vitest';
import { FFT, G, PoissonSolver } from '../src/solver';

describe('FFT', () => {
  it('matches a naive DFT and round-trips', () => {
    const n = 32;
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 0.7) + 0.3 * i;
      im[i] = Math.cos(i * 1.3);
    }
    const r0 = re.slice(), i0 = im.slice();
    const fft = new FFT(n);
    fft.transform(re, im);
    for (const k of [0, 1, 5, 16, 31]) {
      let sr = 0, si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += r0[t] * Math.cos(a) - i0[t] * Math.sin(a);
        si += r0[t] * Math.sin(a) + i0[t] * Math.cos(a);
      }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
    fft.transform(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i] / n).toBeCloseTo(r0[i], 12);
      expect(im[i] / n).toBeCloseTo(i0[i], 12);
    }
  });
});

describe('PoissonSolver (zero-padded FFT convolution)', () => {
  for (const n of [16, 15]) {
    it(`equals direct summation for an arbitrary density (n = ${n})`, () => {
      const solver = new PoissonSolver(n, 0.5, 0.3, G);
      const sigma = new Float64Array(n * n);
      for (let k = 0; k < n * n; k++) sigma[k] = Math.abs(Math.sin(k * 1.37)) + (k % 7 === 0 ? 2 : 0);
      const fast = solver.solve(sigma);
      const direct = solver.solveDirect(sigma);
      let maxErr = 0, maxVal = 0;
      for (let k = 0; k < n * n; k++) {
        maxErr = Math.max(maxErr, Math.abs(fast[k] - direct[k]));
        maxVal = Math.max(maxVal, Math.abs(direct[k]));
      }
      expect(maxErr / maxVal).toBeLessThan(1e-10);
    });
  }

  it('reproduces the analytic potential and field of a Kuzmin disk', () => {
    // Σ(R) = M a / (2π (R² + a²)^{3/2}); in-plane potential with Plummer
    // softening ε equals the Kuzmin potential at height ε:
    //   Φ(R) = −G M / sqrt(R² + (a + ε)²)
    const n = 256, L = 80, dx = L / n, eps = 0.3, a = 1.5, M = 5;
    const solver = new PoissonSolver(n, dx, eps, G);
    const sigma = new Float64Array(n * n);
    const xs = (i: number) => (i + 0.5 - n / 2) * dx;
    let mInBox = 0;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const R2 = xs(i) ** 2 + xs(j) ** 2;
        sigma[j * n + i] = (M * a) / (2 * Math.PI * (R2 + a * a) ** 1.5);
        mInBox += sigma[j * n + i] * dx * dx;
      }
    expect(mInBox / M).toBeGreaterThan(0.95);
    const phi = solver.solve(sigma);
    const j0 = n / 2; // row just above the x axis
    const errs: number[] = [];
    for (let i = n / 2 + 4; i < n / 2 + 40; i++) {
      // radial field from the grid vs analytic
      const R = Math.hypot(xs(i), xs(j0));
      const gNum = -(phi[j0 * n + i + 1] - phi[j0 * n + i - 1]) / (2 * dx);
      const gAna = (-G * M * xs(i)) / (R * R + (a + eps) ** 2) ** 1.5;
      errs.push(Math.abs(gNum - gAna) / Math.abs(gAna));
      // potential: compare up to the constant contributed by mass outside the box
    }
    expect(Math.max(...errs)).toBeLessThan(0.03);
    // potential differences between two radii (removes the constant offset)
    const p = (i: number) => phi[j0 * n + i];
    const pa = (i: number) => (-G * M) / Math.sqrt(xs(i) ** 2 + xs(j0) ** 2 + (a + eps) ** 2);
    const i1 = n / 2 + 2, i2 = n / 2 + 30;
    expect((p(i2) - p(i1)) / (pa(i2) - pa(i1))).toBeCloseTo(1, 1);
  });
});
