/**
 * App entry point: runs the galaxy simulation in a Web Worker, renders the
 * snapshots it sends back, draws the rotation-curve chart and wires the
 * control panel.
 */
import './style.css';
import { Renderer, fmt } from './render/renderer';
import { Chart } from './render/chart';
import { bindControls } from './ui/controls';
import { galaxyParams, settingsForPreset, type Settings } from './ui/settings';
import type { FrameMessage, FromWorker, ToWorker } from './worker/protocol';
import type { GlobalDiagnostics, RadialProfiles } from './solver';

const canvas = document.getElementById('sim') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const chartCanvas = document.getElementById('chart') as HTMLCanvasElement;
const fpsEl = document.getElementById('fps')!;
const statsEl = document.getElementById('stats')!;
const timeEl = document.getElementById('time')!;
const dmBadge = document.getElementById('dm-badge')!;
const legendEl = document.getElementById('legend')!;
const diagEl = document.getElementById('diag')!;
const errorEl = document.getElementById('error')!;

const renderer = new Renderer(canvas, overlay);
const chart = new Chart(chartCanvas);
const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker) => worker.postMessage(m);

let settings: Settings = settingsForPreset('spiral');

const controls = bindControls(settings, {
  onLive(update) {
    send({ type: 'set', params: update });
  },
  onRestart() {
    settings = controls.settings();
    restart();
  },
  onPlayPause(paused) {
    send({ type: 'run', running: !paused });
  },
  onStep() {
    send({ type: 'step', count: 10 });
  },
  onSpeed(v) {
    send({ type: 'speed', myrPerSecond: v });
  },
  onViewChange() {
    renderer.resetScales();
    latest = null;
  },
  onPreset(id) {
    settings = settingsForPreset(id, controls.settings());
    restart();
    return settings;
  },
});

function restart(): void {
  send({ type: 'reset', params: galaxyParams(settings) });
  renderer.resetScales();
  profiles = null;
  latest = null;
}

// ---------------------------------------------------------------- frames
let latest: FrameMessage | null = null;
let fresh = false;
let waiting = false;
let profiles: RadialProfiles | null = null;
let profilesMeta = { darkMatter: true, hasGas: true, sigmaRef: 1, rMax: 20 };
let lastProfilesRequest = 0;
let lastGlobals: GlobalDiagnostics | null = null;
let nanSeen = false;
const errors: string[] = [];

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  if (m.type === 'error') {
    errors.push(m.message);
    errorEl.hidden = false;
    errorEl.textContent = `Simulation error: ${m.message}`;
    return;
  }
  waiting = false;
  latest = m;
  fresh = true;
  lastGlobals = m.globals;
  if (m.nan) nanSeen = true;
  if (m.profiles) {
    profiles = m.profiles;
    profilesMeta = { darkMatter: m.darkMatter, hasGas: m.hasGas, sigmaRef: m.sigmaRef, rMax: m.boxSize / 2 };
  }
};
worker.onerror = (e) => {
  errors.push(e.message);
  errorEl.hidden = false;
  errorEl.textContent = `Worker error: ${e.message}`;
};

function requestFrame(now: number): void {
  if (waiting) return;
  waiting = true;
  const wantProfiles = now - lastProfilesRequest > 250;
  if (wantProfiles) lastProfilesRequest = now;
  const s = controls.settings();
  send({ type: 'frame', view: s.view, arrows: s.arrows, profiles: wantProfiles });
}

function updateDiagnostics(f: FrameMessage): void {
  const g = f.globals;
  const rows: [string, string][] = [
    ['fluid mass', `${fmt(g.mass)} ×10¹⁰ M☉`],
    ['  stars / gas', `${fmt(g.starMass)} / ${fmt(g.gasMass)}`],
    ['lost at edges', `${fmt(g.massOutflow)} ×10¹⁰ M☉`],
    ['⟨R⟩ stars', `${g.meanRadius.toFixed(2)} kpc`],
    ['E_kin', `${fmt(g.kinetic)}`],
    ['E_pot (W)', `${fmt(g.potential)}`],
    ['L_z', `${fmt(g.angularMomentum)}`],
    ['time step', `${g.dtMyr.toFixed(3)} Myr`],
    ['steps', String(g.steps)],
  ];
  if (Number.isFinite(f.corotation)) rows.push(['corotation', `${f.corotation.toFixed(1)} kpc`]);
  diagEl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  diagEl.title = 'Energies in 10¹⁰ M☉ (km/s)², L_z in 10¹⁰ M☉ kpc km/s';
}

let frames = 0;
let fpsTime = performance.now();
let lastDiag = 0;
function frame(now: number): void {
  requestFrame(now);
  if (latest && fresh) {
    fresh = false;
    const s = controls.settings();
    legendEl.textContent = renderer.render(latest, { arrows: s.arrows, contours: s.contours });
    if (profiles && latest.profiles) chart.draw({ profiles, ...profilesMeta });
    timeEl.textContent = `t = ${latest.globals.timeMyr.toFixed(0)} Myr`;
    dmBadge.textContent = latest.darkMatter ? 'dark matter ON' : 'dark matter OFF';
    dmBadge.className = latest.darkMatter ? 'on' : 'off';
    if (now - lastDiag > 400) {
      updateDiagnostics(latest);
      lastDiag = now;
    }
  }
  frames++;
  if (now - fpsTime >= 500) {
    const fps = (frames * 1000) / (now - fpsTime);
    fpsEl.textContent = `${fps.toFixed(0)} fps`;
    if (latest) {
      const p = latest.perf;
      statsEl.textContent =
        `${latest.n}² · ${p.msPerStep.toFixed(1)} ms/step · ${p.myrPerSecond.toFixed(1)} Myr/s`;
    }
    frames = 0;
    fpsTime = now;
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  renderer.resize();
  fresh = true;
});

renderer.resize();
restart();
send({ type: 'speed', myrPerSecond: settings.speed });
send({ type: 'run', running: !settings.paused });
requestAnimationFrame(frame);

// Handy for debugging from the console and for automated smoke tests.
declare global {
  interface Window {
    galaxy: {
      readonly settings: Settings;
      readonly globals: GlobalDiagnostics | null;
      readonly profiles: RadialProfiles | null;
      readonly perf: FrameMessage['perf'] | null;
      readonly nan: boolean;
      readonly errors: string[];
      send(m: ToWorker): void;
    };
  }
}
window.galaxy = {
  get settings() {
    return controls.settings();
  },
  get globals() {
    return lastGlobals;
  },
  get profiles() {
    return profiles;
  },
  get perf() {
    return latest?.perf ?? null;
  },
  get nan() {
    return nanSeen;
  },
  errors,
  send,
};
