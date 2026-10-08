/**
 * Small hand-drawn chart (no charting library): rotation curve v_c(R) by
 * component plus the measured mean rotation of the fluids, and the Toomre Q
 * profile underneath.
 */
import type { RadialProfiles } from '../solver';

export interface ChartInput {
  profiles: RadialProfiles;
  darkMatter: boolean;
  hasGas: boolean;
  sigmaRef: number;
  rMax: number;
}

const COLORS = {
  total: '#ffffff',
  baryons: '#ffb347',
  halo: '#d68cff',
  gas: '#5ac8fa',
  stars: '#ffe08a',
  grid: 'rgba(255,255,255,0.09)',
  axis: 'rgba(255,255,255,0.45)',
  text: '#c8ccda',
};

export class Chart {
  private readonly ctx: CanvasRenderingContext2D;
  private vMax = 300;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported');
    this.ctx = ctx;
  }

  private resize(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return dpr;
  }

  draw(d: ChartInput): void {
    const dpr = this.resize();
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const p = d.profiles;
    const nb = p.r.length;
    const rMax = d.rMax;
    // only show measured quantities where there is a real galaxy
    const inGalaxy = (b: number) => p.sigmaStars[b] > d.sigmaRef * 3e-4;

    // y-axis range: grow in 50 km/s steps, never shrink below 300
    let top = 0;
    for (let b = 0; b < nb; b++) {
      top = Math.max(top, p.vTotal[b], p.vHalo[b], p.vBaryon[b]);
      if (inGalaxy(b)) top = Math.max(top, p.vPhiStars[b], Number.isFinite(p.vPhiGas[b]) ? p.vPhiGas[b] : 0);
    }
    const want = Math.max(300, Math.ceil((top * 1.1) / 50) * 50);
    this.vMax = want > this.vMax ? want : Math.max(want, this.vMax - 1);
    const vMax = this.vMax;

    const font = `${10.5 * dpr}px system-ui, sans-serif`;
    ctx.font = font;
    const L = 34 * dpr, R = 8 * dpr, T = 30 * dpr;
    const h1 = (H - T) * 0.58;
    const gap = 20 * dpr;
    const h2 = H - T - h1 - gap - 18 * dpr;
    const plotW = W - L - R;
    const X = (r: number) => L + (r / rMax) * plotW;

    // ---------- rotation curve ----------
    const Y1 = (v: number) => T + h1 - (v / vMax) * h1;
    this.frame(L, T, plotW, h1, rMax, dpr, (v) => Y1(v), vMax, 50, 'km/s');
    const line = (arr: Float64Array, color: string, width: number, dash: number[] = [], mask?: (b: number) => boolean) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.setLineDash(dash.map((x) => x * dpr));
      ctx.beginPath();
      let pen = false;
      for (let b = 0; b < nb; b++) {
        const ok = Number.isFinite(arr[b]) && (!mask || mask(b));
        if (!ok) { pen = false; continue; }
        const x = X(p.r[b]), y = Y1(Math.max(0, Math.min(arr[b], vMax * 1.05)));
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
      ctx.restore();
    };
    const dots = (arr: Float64Array, color: string) => {
      ctx.fillStyle = color;
      for (let b = 0; b < nb; b++) {
        if (!inGalaxy(b) || !Number.isFinite(arr[b])) continue;
        ctx.beginPath();
        ctx.arc(X(p.r[b]), Y1(Math.max(0, Math.min(arr[b], vMax))), 1.9 * dpr, 0, 2 * Math.PI);
        ctx.fill();
      }
    };
    line(p.vHalo, COLORS.halo, 1.5, d.darkMatter ? [] : [4, 4]);
    line(p.vBaryon, COLORS.baryons, 1.5);
    line(p.vTotal, COLORS.total, 2.2);
    dots(p.vPhiStars, COLORS.stars);
    if (d.hasGas) dots(p.vPhiGas, COLORS.gas);

    // legend
    const items: [string, string, boolean][] = [
      ['total v_c', COLORS.total, true],
      ['baryons', COLORS.baryons, true],
      [d.darkMatter ? 'DM halo' : 'DM halo (off)', COLORS.halo, true],
      ['⟨v_φ⟩ stars', COLORS.stars, false],
    ];
    if (d.hasGas) items.push(['⟨v_φ⟩ gas', COLORS.gas, false]);
    let lx = L, ly = 9 * dpr;
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    for (const [label, color, isLine] of items) {
      const w = ctx.measureText(label).width + 22 * dpr;
      if (lx + w > W) { lx = L; ly += 12 * dpr; }
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      if (isLine) {
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 12 * dpr, ly); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(lx + 6 * dpr, ly, 2.2 * dpr, 0, 2 * Math.PI); ctx.fill();
      }
      ctx.fillStyle = COLORS.text;
      ctx.fillText(label, lx + 15 * dpr, ly + 3.5 * dpr);
      lx += w;
    }

    // ---------- Toomre Q ----------
    const top2 = T + h1 + gap;
    const qMax = 4;
    const Y2 = (q: number) => top2 + h2 - (Math.min(q, qMax) / qMax) * h2;
    this.frame(L, top2, plotW, h2, rMax, dpr, Y2, qMax, 1, 'Q', true);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,90,90,0.6)';
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(L, Y2(1)); ctx.lineTo(L + plotW, Y2(1)); ctx.stroke();
    ctx.restore();
    const qline = (arr: Float64Array, color: string) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath();
      let pen = false;
      for (let b = 1; b < nb; b++) {
        if (!inGalaxy(b) || !Number.isFinite(arr[b])) { pen = false; continue; }
        const x = X(p.r[b]), y = Y2(arr[b]);
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
      ctx.restore();
    };
    qline(p.qStars, COLORS.stars);
    if (d.hasGas) qline(p.qGas, COLORS.gas);
    ctx.fillStyle = COLORS.text;
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    ctx.fillText(`Toomre Q (stars${d.hasGas ? ', gas' : ''}); Q < 1 unstable`, L + 4 * dpr, top2 - 4 * dpr);
    ctx.fillText('R (kpc)', L + plotW - 36 * dpr, H - 2 * dpr);
  }

  private frame(
    x: number, y: number, w: number, h: number, rMax: number, dpr: number,
    Y: (v: number) => number, vMax: number, vStep: number, unit: string, xLabels = false,
  ): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.text;
    ctx.lineWidth = 1;
    ctx.font = `${9.5 * dpr}px ui-monospace, monospace`;
    for (let v = 0; v <= vMax + 1e-9; v += vStep) {
      const yy = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
      if (vStep >= 50 ? v % 100 === 0 : true) ctx.fillText(String(v), x - 28 * dpr, yy + 3 * dpr);
    }
    for (let r = 0; r <= rMax + 1e-9; r += 5) {
      const xx = Math.round(x + (r / rMax) * w) + 0.5;
      ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx, y + h); ctx.stroke();
      if (xLabels) ctx.fillText(String(r), xx - 4 * dpr, y + h + 11 * dpr);
    }
    ctx.strokeStyle = COLORS.axis;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    if (unit !== 'Q') ctx.fillText(unit, x + 4 * dpr, y + 11 * dpr);
    ctx.restore();
  }
}
