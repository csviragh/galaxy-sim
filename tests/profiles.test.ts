import { describe, expect, it } from 'vitest';
import { G, HernquistSphere, IsothermalHalo, NFWHalo, r200FromMass, RHO_CRIT } from '../src/solver';

describe('dark-matter halo profiles', () => {
  it('r200 encloses a mean density of 200 ρ_crit', () => {
    const m = 100;
    const r = r200FromMass(m);
    expect(m / ((4 / 3) * Math.PI * r ** 3) / RHO_CRIT).toBeCloseTo(200, 6);
    expect(r).toBeGreaterThan(150);
    expect(r).toBeLessThan(260); // ~206 kpc for 1e12 M☉
  });

  it('NFW circular velocity matches the analytic formula', () => {
    const h = new NFWHalo(100, 20);
    const m = (x: number) => Math.log(1 + x) - x / (1 + x);
    const v200 = Math.sqrt((G * 100) / h.r200);
    for (const r of [1, 5, 10, 20, 50, h.r200]) {
      const x = r / 20;
      const analytic = v200 * Math.sqrt((m(x) / m(h.c)) * (h.r200 / r));
      expect(h.vcirc(r)).toBeCloseTo(analytic, 8);
    }
    expect(h.enclosedMass(h.r200)).toBeCloseTo(100, 10);
  });

  it('pseudo-isothermal circular velocity matches v∞² (1 − (rc/r) atan(r/rc)) and flattens', () => {
    const h = new IsothermalHalo(100, 5);
    for (const r of [0.5, 5, 20, 60]) {
      const analytic = h.vInfinity * Math.sqrt(1 - (5 / r) * Math.atan(r / 5));
      expect(h.vcirc(r)).toBeCloseTo(analytic, 8);
    }
    expect(h.vcirc(100) / h.vInfinity).toBeGreaterThan(0.95);
    expect(h.enclosedMass(h.r200)).toBeCloseTo(100, 8);
  });

  it('potentials are consistent with the enclosed mass (dΦ/dr = G M / r²)', () => {
    for (const c of [new NFWHalo(100, 20), new IsothermalHalo(80, 4), new HernquistSphere(2, 0.7)]) {
      for (const r of [0.3, 2, 8, 30, 150]) {
        const h = 1e-4 * r;
        const dphi = (c.potential(r + h) - c.potential(r - h)) / (2 * h);
        expect(dphi / ((G * c.enclosedMass(r)) / (r * r))).toBeCloseTo(1, 5);
      }
    }
  });

  it('density integrates to the enclosed mass', () => {
    for (const c of [new NFWHalo(100, 20), new IsothermalHalo(100, 5), new HernquistSphere(1, 0.6)]) {
      let m = 0;
      const R = 30, N = 30000;
      for (let k = 0; k < N; k++) {
        const r = ((k + 0.5) * R) / N;
        m += 4 * Math.PI * r * r * c.density(r) * (R / N);
      }
      expect(m / c.enclosedMass(R)).toBeCloseTo(1, 2);
    }
  });
});
