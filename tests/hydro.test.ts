import { describe, expect, it } from 'vitest';
import { Hydro, type Boundary } from '../src/solver';

function blobSetup(boundary: Boundary): Hydro {
  const n = 64;
  const h = new Hydro(n, 0.25, { gamma: 1, boundary, floor: 1e-8 });
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = i - 20, y = j - 36;
      const s = 1 + 4 * Math.exp(-(x * x + y * y) / 30);
      h.setCell(i, j, s, 40 + 10 * Math.sin(j * 0.2), -25 + 5 * Math.cos(i * 0.3), 100);
    }
  return h;
}

describe('Hydro (MUSCL–Hancock / HLL)', () => {
  for (const boundary of ['periodic', 'reflect'] as const) {
    it(`conserves mass to round-off with ${boundary} boundaries`, () => {
      const h = blobSetup(boundary);
      const m0 = h.totalMass();
      for (let s = 0; s < 300; s++) h.step(h.maxTimeStep(0.45));
      expect(Math.abs(h.totalMass() - m0) / m0).toBeLessThan(1e-12);
      expect(h.massFloor).toBe(0);
    });
  }

  it('conserves momentum with periodic boundaries and no gravity', () => {
    const h = blobSetup('periodic');
    const mom = () => {
      let px = 0, py = 0;
      for (let j = 0; j < h.n; j++)
        for (let i = 0; i < h.n; i++) {
          px += h.mx[h.idx(i, j)];
          py += h.my[h.idx(i, j)];
        }
      return [px, py];
    };
    const [px0, py0] = mom();
    for (let s = 0; s < 200; s++) h.step(h.maxTimeStep(0.45));
    const [px1, py1] = mom();
    expect(Math.abs(px1 - px0) / Math.abs(px0)).toBeLessThan(1e-11);
    expect(Math.abs(py1 - py0) / Math.abs(py0)).toBeLessThan(1e-11);
  });

  it('keeps a uniform state at rest exactly static', () => {
    const n = 32;
    const h = new Hydro(n, 1, { boundary: 'outflow' });
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h.setCell(i, j, 0.3, 0, 0, 400);
    for (let s = 0; s < 100; s++) h.step(h.maxTimeStep(0.45));
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = h.idx(i, j);
        expect(h.rho[k]).toBeCloseTo(0.3, 12);
        expect(Math.abs(h.mx[k]) + Math.abs(h.my[k])).toBeLessThan(1e-12);
      }
  });

  it('propagates a sound wave at the sound speed (γ = 1)', () => {
    // 1D-like isothermal acoustic pulse along x in a periodic box: the
    // centre of mass of the right-moving half travels at c.
    const n = 128, dx = 1, c = 10;
    const h = new Hydro(n, dx, { gamma: 1, boundary: 'periodic' });
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = i - 64;
        const d = 0.01 * Math.exp(-(x * x) / 20);
        // right-moving simple wave: δu = c δΣ/Σ
        h.setCell(i, j, 1 + d, c * d, 0, c * c);
      }
    const peak = () => {
      let best = -1, at = 0;
      for (let i = 0; i < n; i++) {
        const r = h.rho[h.idx(i, 5)];
        if (r > best) { best = r; at = i; }
      }
      return at;
    };
    let t = 0;
    while (t < 3) {
      const dt = Math.min(h.maxTimeStep(0.4), 3 - t);
      h.step(dt);
      t += dt;
    }
    expect(Math.abs(peak() - (64 + c * 3))).toBeLessThanOrEqual(1);
  });
});
