/**
 * Canvas2D renderer: rasterises the snapshot field of the current view into an
 * ImageData at grid resolution and lets the browser upscale it (bilinear
 * smoothing) into a centred square on the full-window canvas. A second canvas
 * holds vector overlays (velocity arrows, halo contours, corotation circle,
 * scale bar).
 */
import type { FrameMessage, ViewMode } from '../worker/protocol';
import { darkmatter, diverging, gaslight, starlight, viridis, type LUT } from './colormaps';

export interface RenderOptions {
  arrows: boolean;
  contours: boolean;
}

/** Smoothly tracks a robust maximum so the colour scale doesn't flicker. */
class AutoScale {
  private value = 0;
  update(observed: number): number {
    const target = Math.max(observed, 1e-12);
    this.value = this.value === 0 ? target : target > this.value ? 0.6 * this.value + 0.4 * target : 0.96 * this.value + 0.04 * target;
    return this.value;
  }
  reset(): void {
    this.value = 0;
  }
}

const LOG_RANGE_STARS: [number, number] = [-2.7, 0.3];
const LOG_RANGE_GAS: [number, number] = [-1.2, 0.35];

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly buffer: HTMLCanvasElement;
  private readonly bufferCtx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  private readonly scales = new Map<string, AutoScale>();
  /** Square drawing area in canvas pixels: x, y, side. */
  rect = { x: 0, y: 0, size: 1 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    const octx = overlay.getContext('2d');
    this.buffer = document.createElement('canvas');
    const bctx = this.buffer.getContext('2d');
    if (!ctx || !octx || !bctx) throw new Error('Canvas 2D is not supported in this browser');
    this.ctx = ctx;
    this.overlayCtx = octx;
    this.bufferCtx = bctx;
  }

  /** Match the backing store to the element size (CSS px × devicePixelRatio). */
  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.canvas, this.overlay]) {
      const w = Math.round(c.clientWidth * dpr);
      const h = Math.round(c.clientHeight * dpr);
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    const { width, height } = this.canvas;
    const size = Math.min(width, height);
    this.rect = { x: Math.round((width - size) / 2), y: Math.round((height - size) / 2), size };
  }

  resetScales(): void {
    for (const s of this.scales.values()) s.reset();
  }

  private scale(key: string, observed: number): number {
    let s = this.scales.get(key);
    if (!s) this.scales.set(key, (s = new AutoScale()));
    return s.update(observed);
  }

  /** Draw a frame; returns a short legend string for the colour scale. */
  render(f: FrameMessage, opt: RenderOptions): string {
    const n = f.n;
    if (!this.image || this.image.width !== n) {
      this.buffer.width = n;
      this.buffer.height = n;
      this.image = this.bufferCtx.createImageData(n, n);
    }
    const px = this.image.data;
    const field = f.field;
    let legend = '';
    // screen row 0 = top of the domain (largest y)
    const each = (fn: (k: number, o: number) => void) => {
      for (let row = 0; row < n; row++) {
        const j = n - 1 - row;
        for (let i = 0, k = j * n, o = row * n * 4; i < n; i++, k++, o += 4) fn(k, o);
      }
    };
    const logT = (x: number, ref: number, [lo, hi]: [number, number]) => {
      const t = (Math.log10(x / ref) - lo) / (hi - lo);
      return t < 0 ? 0 : t > 1 ? 1 : t;
    };

    switch (f.view as ViewMode) {
      case 'galaxy': {
        const gas = f.field2;
        each((k, o) => {
          const ts = logT(field[k], f.sigmaRef, LOG_RANGE_STARS);
          const ls = 3 * Math.round(ts * 255);
          let r = starlight[ls] / 255, g = starlight[ls + 1] / 255, b = starlight[ls + 2] / 255;
          if (gas && f.hasGas) {
            const tg = logT(gas[k], f.gasRef, LOG_RANGE_GAS);
            const lg = 3 * Math.round(tg * 255);
            // screen blend: young stars / gas light up the arms in blue
            const w = 1;
            r = 1 - (1 - r) * (1 - w * gaslight[lg] / 255);
            g = 1 - (1 - g) * (1 - w * gaslight[lg + 1] / 255);
            b = 1 - (1 - b) * (1 - w * gaslight[lg + 2] / 255);
          }
          px[o] = 255 * r; px[o + 1] = 255 * g; px[o + 2] = 255 * b; px[o + 3] = 255;
        });
        legend = 'stars (amber, log Σ★) + gas (blue, log Σgas)';
        break;
      }
      case 'stars':
      case 'gas': {
        const isGas = f.view === 'gas';
        const lut = isGas ? gaslight : starlight;
        const ref = isGas ? f.gasRef : f.sigmaRef;
        const range = isGas ? LOG_RANGE_GAS : LOG_RANGE_STARS;
        each((k, o) => this.put(px, o, lut, Math.round(logT(field[k], ref, range) * 255)));
        const lo = (ref * 10 ** range[0] * 1e4).toPrecision(2);
        const hi = (ref * 10 ** range[1] * 1e4).toPrecision(2);
        legend = `${isGas ? 'Σgas' : 'Σ★'}: ${lo} … ${hi} M☉/pc² (log)`;
        if (isGas && !f.hasGas) legend = 'no gas in this model (gas fraction = 0)';
        break;
      }
      case 'potential': {
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < field.length; k++) {
          if (field[k] < lo) lo = field[k];
          if (field[k] > hi) hi = field[k];
        }
        const span = Math.max(hi - lo, 1);
        // iso-potential bands make the non-axisymmetric structure visible
        const bands = 12;
        each((k, o) => {
          const t = (field[k] - lo) / span;
          const l = 3 * Math.round(Math.min(1, Math.max(0, t)) * 255);
          // smooth cosine banding (no aliasing at grid resolution)
          const shade = 0.78 + 0.22 * Math.cos(2 * Math.PI * t * bands);
          px[o] = viridis[l] * shade; px[o + 1] = viridis[l + 1] * shade; px[o + 2] = viridis[l + 2] * shade; px[o + 3] = 255;
        });
        legend = `Φ: ${fmt(lo)} … ${fmt(hi)} (km/s)²${f.darkMatter ? ' incl. halo' : ', halo off'} · ${bands} iso-Φ bands`;
        break;
      }
      case 'vorticity': {
        // show ω relative to a robust maximum (95th percentile of |ω|)
        const sample: number[] = [];
        for (let k = 0; k < field.length; k += 7) sample.push(Math.abs(field[k]));
        sample.sort((x, y) => x - y);
        const s = this.scale('vort', sample[Math.floor(sample.length * 0.95)] || 1);
        const half = 127.5 / s;
        each((k, o) => {
          const t = Math.round(127.5 + field[k] * half);
          this.put(px, o, diverging, t < 0 ? 0 : t > 255 ? 255 : t);
        });
        legend = `ω − ⟨ω⟩(R): ±${fmt(s)} km/s/kpc (vorticity minus mean rotation; red = more ccw spin)`;
        break;
      }
      case 'darkmatter': {
        let max = 0;
        for (let k = 0; k < field.length; k++) if (field[k] > max) max = field[k];
        const range: [number, number] = [-2.2, 0];
        const dim = f.darkMatter ? 1 : 0.28;
        const bar = f.field2;
        each((k, o) => {
          const t = logT(field[k], max, range);
          const l = 3 * Math.round(t * 255);
          let r = (dim * darkmatter[l]) / 255, g = (dim * darkmatter[l + 1]) / 255, b = (dim * darkmatter[l + 2]) / 255;
          if (bar) {
            const ts = logT(bar[k], f.sigmaRef, LOG_RANGE_STARS);
            const w = 0.75 * ts * ts;
            r = 1 - (1 - r) * (1 - w); g = 1 - (1 - g) * (1 - w); b = 1 - (1 - b) * (1 - w);
          }
          px[o] = 255 * r; px[o + 1] = 255 * g; px[o + 2] = 255 * b; px[o + 3] = 255;
        });
        legend = f.darkMatter
          ? `ρ_DM (mid-plane): ${(max * 1e10 / 1e9).toPrecision(2)} M☉/pc³ peak, log scale, 2.2 dex · baryons in white`
          : 'dark-matter halo is OFF (shown dimmed) · baryons in white';
        break;
      }
    }

    this.bufferCtx.putImageData(this.image, 0, 0);
    const { ctx, canvas, rect } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.buffer, rect.x, rect.y, rect.size, rect.size);
    this.drawOverlay(f, opt);
    return legend;
  }

  private put(px: Uint8ClampedArray, o: number, lut: LUT, t: number): void {
    const l = 3 * t;
    px[o] = lut[l];
    px[o + 1] = lut[l + 1];
    px[o + 2] = lut[l + 2];
    px[o + 3] = 255;
  }

  /** kpc → canvas pixel (origin at the galaxy centre, +y up). */
  private toScreen(f: FrameMessage, x: number, y: number): [number, number] {
    const { rect } = this;
    const s = rect.size / f.boxSize;
    return [rect.x + rect.size / 2 + x * s, rect.y + rect.size / 2 - y * s];
  }

  private drawOverlay(f: FrameMessage, opt: RenderOptions): void {
    const ctx = this.overlayCtx;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const kpc = this.rect.size / f.boxSize;
    const [cx, cy] = this.toScreen(f, 0, 0);
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;

    // halo contours: the halo is spherical, so iso-density curves are circles
    if (opt.contours || f.view === 'darkmatter') {
      ctx.save();
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.lineWidth = 1 * dpr;
      const alpha = f.darkMatter ? 0.7 : 0.25;
      ctx.strokeStyle = `rgba(214,140,255,${alpha})`;
      ctx.fillStyle = `rgba(214,140,255,${alpha})`;
      const rs = f.haloScale;
      for (const m of [0.25, 0.5, 1, 2]) {
        const r = rs * m;
        if (r > f.boxSize * 0.71) continue;
        ctx.beginPath();
        ctx.arc(cx, cy, r * kpc, 0, 2 * Math.PI);
        ctx.stroke();
        if (m === 1) ctx.fillText(`r_s = ${rs.toFixed(0)} kpc`, cx + r * kpc * 0.72 + 4 * dpr, cy - r * kpc * 0.72);
      }
      if (!f.darkMatter) ctx.fillText('halo OFF', cx - 28 * dpr, cy - rs * 0.5 * kpc - 6 * dpr);
      ctx.restore();
    }

    // corotation circle of the bar / spiral pattern
    if (Number.isFinite(f.corotation)) {
      ctx.save();
      ctx.setLineDash([2 * dpr, 6 * dpr]);
      ctx.strokeStyle = 'rgba(120,255,190,0.55)';
      ctx.fillStyle = 'rgba(120,255,190,0.75)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, f.corotation * kpc, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.fillText('corotation', cx + f.corotation * kpc * 0.71 + 4 * dpr, cy + f.corotation * kpc * 0.71 + 12 * dpr);
      ctx.restore();
    }

    if (opt.arrows && f.u && f.v) this.drawArrows(f, dpr);

    // scale bar
    const bar = 5 * kpc;
    const x0 = this.rect.x + this.rect.size - bar - 24 * dpr;
    const y0 = this.rect.y + this.rect.size - 22 * dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2 * dpr;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + bar, y0);
    ctx.stroke();
    ctx.fillText('5 kpc', x0 + bar / 2 - 16 * dpr, y0 - 6 * dpr);
  }

  private drawArrows(f: FrameMessage, dpr: number): void {
    const ctx = this.overlayCtx;
    const n = f.n;
    const u = f.u!, v = f.v!;
    const spacing = 30 * dpr;
    const cells = Math.max(2, Math.floor(this.rect.size / spacing));
    const step = this.rect.size / cells;
    // only draw where there is matter
    const dens = f.view === 'galaxy' || f.view === 'stars' ? f.field : null;
    const samples: number[] = [];
    let max = 0;
    for (let r = 0; r < cells; r++)
      for (let c = 0; c < cells; c++) {
        const i = Math.min(n - 1, Math.floor(((c + 0.5) / cells) * n));
        const j = Math.min(n - 1, Math.floor((1 - (r + 0.5) / cells) * n));
        const k = j * n + i;
        const show = !dens || dens[k] > f.sigmaRef * 1e-3;
        samples.push(show ? u[k] : NaN, show ? v[k] : NaN);
        if (show) max = Math.max(max, Math.hypot(u[k], v[k]));
      }
    const s = this.scale('arrows', max);
    const maxLen = 0.95 * step;
    ctx.save();
    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeStyle = 'rgba(160,255,200,0.8)';
    ctx.beginPath();
    let q = 0;
    for (let r = 0; r < cells; r++)
      for (let c = 0; c < cells; c++) {
        const uu = samples[q++], vv = samples[q++];
        if (!Number.isFinite(uu)) continue;
        const m = Math.hypot(uu, vv);
        if (m < 1e-3 * s) continue;
        const len = Math.min(1, m / s) * maxLen;
        const ux = uu / m, uy = -vv / m;
        const px = this.rect.x + (c + 0.5) * step, py = this.rect.y + (r + 0.5) * step;
        const x0 = px - 0.5 * len * ux, y0 = py - 0.5 * len * uy;
        const x1 = px + 0.5 * len * ux, y1 = py + 0.5 * len * uy;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        const head = Math.min(5 * dpr, 0.4 * len);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - head * (ux - 0.5 * uy), y1 - head * (uy + 0.5 * ux));
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - head * (ux + 0.5 * uy), y1 - head * (uy - 0.5 * ux));
      }
    ctx.stroke();
    ctx.fillStyle = 'rgba(160,255,200,0.9)';
    ctx.fillText(`arrow = ${fmt(s)} km/s`, this.rect.x + 12 * dpr, this.rect.y + this.rect.size - 14 * dpr);
    ctx.restore();
  }
}

export function fmt(x: number): string {
  if (x === 0) return '0';
  const a = Math.abs(x);
  return a >= 1e5 || a < 0.01 ? x.toExponential(1) : a >= 100 ? x.toFixed(0) : x.toPrecision(3);
}
