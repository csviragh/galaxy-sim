/**
 * Colormaps as 256-entry RGB lookup tables (Uint8Array of length 768).
 */
export type LUT = Uint8Array;

type Stop = readonly [number, number, number, number];

export function buildLUT(stops: readonly Stop[]): LUT {
  const lut = new Uint8Array(256 * 3);
  for (let n = 0; n < 256; n++) {
    const t = n / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k];
    const [t1, r1, g1, b1] = stops[k + 1];
    const s = t1 > t0 ? Math.min(Math.max((t - t0) / (t1 - t0), 0), 1) : 0;
    lut[3 * n] = Math.round(r0 + s * (r1 - r0));
    lut[3 * n + 1] = Math.round(g0 + s * (g1 - g0));
    lut[3 * n + 2] = Math.round(b0 + s * (b1 - b0));
  }
  return lut;
}

/** Old stellar population: black → warm grey → soft gold → cream → white. */
export const starlight: LUT = buildLUT([
  [0.0, 0, 0, 0],
  [0.2, 18, 14, 14],
  [0.42, 74, 60, 50],
  [0.62, 160, 132, 96],
  [0.8, 232, 206, 156],
  [0.92, 255, 240, 210],
  [1.0, 255, 255, 248],
]);

/** Cold gas / young stars: black → deep blue → azure → pale cyan. */
export const gaslight: LUT = buildLUT([
  [0.0, 0, 0, 0],
  [0.3, 6, 16, 56],
  [0.55, 24, 70, 180],
  [0.78, 70, 150, 255],
  [0.93, 160, 210, 255],
  [1.0, 225, 240, 255],
]);

/** Dark-matter density: black → violet → magenta → pink. */
export const darkmatter: LUT = buildLUT([
  [0.0, 0, 0, 0],
  [0.3, 32, 8, 58],
  [0.6, 96, 28, 140],
  [0.85, 190, 70, 190],
  [1.0, 255, 170, 230],
]);

/** Perceptually uniform sequential map (sampled from matplotlib's viridis). */
export const viridis: LUT = buildLUT([
  [0.0, 68, 1, 84],
  [0.125, 71, 44, 122],
  [0.25, 59, 81, 139],
  [0.375, 44, 113, 142],
  [0.5, 33, 144, 141],
  [0.625, 39, 173, 129],
  [0.75, 92, 200, 99],
  [0.875, 170, 220, 50],
  [1.0, 253, 231, 37],
]);

/** Diverging blue–white–red map (similar to "RdBu"), 0.5 = zero. */
export const diverging: LUT = buildLUT([
  [0.0, 5, 48, 97],
  [0.2, 33, 102, 172],
  [0.4, 146, 197, 222],
  [0.5, 247, 247, 247],
  [0.6, 244, 165, 130],
  [0.8, 178, 24, 43],
  [1.0, 103, 0, 31],
]);

/** CSS gradient for a LUT (for legends). */
export function lutGradient(lut: LUT, steps = 8): string {
  const parts: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const n = Math.round((s / steps) * 255);
    parts.push(`rgb(${lut[3 * n]},${lut[3 * n + 1]},${lut[3 * n + 2]}) ${((s / steps) * 100).toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}
