import { describe, expect, it } from 'vitest';
import { GalaxySim, type GalaxyParams } from '../src/solver';

const small: Partial<GalaxyParams> = { n: 96, boxSize: 40, softening: 0.5 };

function maxSpeedRelative(sim: GalaxySim): number {
  const n = sim.n;
  const u = new Float64Array(n * n), v = new Float64Array(n * n), s = new Float64Array(n * n);
  sim.velocity(u, v);
  sim.surfaceDensity(s);
  // mass-weighted rms speed of the galaxy
  let m = 0, e = 0;
  for (let k = 0; k < n * n; k++) {
    if (sim.radius[k] > 12) continue;
    m += s[k];
    e += s[k] * (u[k] * u[k] + v[k] * v[k]);
  }
  return Math.sqrt(e / m);
}

describe('GalaxySim equilibria', () => {
  it('a non-rotating pressure-supported (elliptical) model stays nearly static', () => {
    const sim = new GalaxySim({
      ...small, kind: 'hot', mass: 10, scaleLength: 1.5, rotation: 0, ellipticity: 0, noise: 0, gamma: 2, gasFraction: 0,
      bulgeMass: 0, forcing: 'none', darkMatter: true,
    });
    const r0 = sim.globals().meanRadius;
    for (let s = 0; s < 300; s++) sim.step();
    const g = sim.globals();
    expect(sim.hasNaN()).toBe(false);
    // mass-weighted rms velocity stays small compared to v_c ~ 250 km/s
    expect(maxSpeedRelative(sim)).toBeLessThan(25);
    expect(Math.abs(g.meanRadius - r0) / r0).toBeLessThan(0.05);
  });

  it('a rotating disk in equilibrium keeps its size and angular momentum', () => {
    const sim = new GalaxySim({ ...small, forcing: 'none', noise: 0, toomreQ: 2 });
    const g0 = sim.globals();
    for (let s = 0; s < 300; s++) sim.step();
    const g = sim.globals();
    expect(sim.hasNaN()).toBe(false);
    expect(Math.abs(g.meanRadius - g0.meanRadius) / g0.meanRadius).toBeLessThan(0.03);
    expect(Math.abs(g.angularMomentum - g0.angularMomentum) / g0.angularMomentum).toBeLessThan(0.03);
    // mean azimuthal speed at 8 kpc remains close to its initial value
    const p0 = new GalaxySim({ ...small, forcing: 'none', noise: 0, toomreQ: 2 }).profiles();
    const p = sim.profiles();
    expect(Math.abs(p.vPhiStars[16] - p0.vPhiStars[16]) / p0.vPhiStars[16]).toBeLessThan(0.05);
  });

  it('initialises a disk with the requested Toomre Q', () => {
    const sim = new GalaxySim({ ...small, toomreQ: 1.5, noise: 0 });
    const p = sim.profiles();
    for (const R of [4, 6, 8, 10]) {
      const b = Math.round(R / 0.5 - 0.5);
      expect(p.qStars[b]).toBeGreaterThan(1.3);
      expect(p.qStars[b]).toBeLessThan(1.7);
    }
  });
});

describe('GalaxySim robustness', () => {
  it('produces no NaNs over many steps (spiral forcing, then dark matter removed)', () => {
    const sim = new GalaxySim({ ...small, forcing: 'spiral', forcingStrength: 0.05, toomreQ: 1.1 });
    for (let s = 0; s < 800; s++) sim.step();
    expect(sim.hasNaN()).toBe(false);
    sim.setParams({ darkMatter: false });
    for (let s = 0; s < 400; s++) sim.step();
    expect(sim.hasNaN()).toBe(false);
    const g = sim.globals();
    expect(Number.isFinite(g.kinetic + g.potential + g.angularMomentum)).toBe(true);
  });

  it('bar forcing and γ ≠ 1 also stay finite', () => {
    const sim = new GalaxySim({ ...small, forcing: 'bar', forcingStrength: 0.3, gamma: 1.5 });
    for (let s = 0; s < 500; s++) sim.step();
    expect(sim.hasNaN()).toBe(false);
  });
});

describe('dark matter', () => {
  it('makes the rotation curve flatter at large radii', () => {
    const withDM = new GalaxySim({ ...small, darkMatter: true, noise: 0 }).profiles();
    const noDM = new GalaxySim({ ...small, darkMatter: false, noise: 0 }).profiles();
    const at = (p: Float64Array, R: number) => p[Math.round(R / 0.5 - 0.5)];
    const ratioDM = at(withDM.vTotal, 18) / at(withDM.vTotal, 7);
    const ratioNo = at(noDM.vTotal, 18) / at(noDM.vTotal, 7);
    expect(ratioDM).toBeGreaterThan(0.9); // flat
    expect(ratioNo).toBeLessThan(0.8); // falling, ~Keplerian
    expect(ratioDM).toBeGreaterThan(ratioNo + 0.15);
  });

  it('removing the halo from a disk set up with dark matter makes it expand', () => {
    const sim = new GalaxySim({ ...small, forcing: 'none', noise: 0 });
    const r0 = sim.globals().meanRadius;
    sim.setParams({ darkMatter: false });
    while (sim.timeMyr < 150) sim.step();
    expect(sim.hasNaN()).toBe(false);
    expect(sim.globals().meanRadius / r0).toBeGreaterThan(1.15);
  });
});
