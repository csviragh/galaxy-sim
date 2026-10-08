/**
 * Runs the GalaxySim off the UI thread. The worker steps the simulation in
 * ~12 ms chunks and answers 'frame' requests with a snapshot of the field
 * needed by the current view (buffers are transferred, not copied).
 */
/// <reference lib="webworker" />
import { GalaxySim, type GalaxyParams } from '../solver';
import type { FrameMessage, ToWorker, ViewMode } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let sim: GalaxySim | null = null;
let running = true;
let myrPerSecond = 0;
let pending: { view: ViewMode; arrows: boolean; profiles: boolean } | null = null;
let loopScheduled = false;
let throttled = false;

// performance bookkeeping (exponential moving averages)
let msPerStep = 0;
let stepsPerSecond = 0;
let simRate = 0;
let rateWindowStart = performance.now();
let rateSteps = 0;
let rateMyr = 0;
// throttle bookkeeping
let throttleStart = performance.now();
let throttleMyr = 0;

const INIT_ONLY: (keyof GalaxyParams)[] = ['n', 'boxSize', 'softening', 'backgroundDensity', 'jeansCells', 'gamma'];

function build(params: GalaxyParams): void {
  if (!sim || INIT_ONLY.some((k) => sim!.params[k] !== params[k])) {
    sim = new GalaxySim(params);
  } else {
    sim.setParams(params);
    sim.reset();
  }
  throttleStart = performance.now();
  throttleMyr = 0;
}

function doSteps(budgetMs: number): void {
  if (!sim) return;
  const t0 = performance.now();
  let steps = 0;
  const myr0 = sim.timeMyr;
  while (performance.now() - t0 < budgetMs) {
    if (myrPerSecond > 0) {
      const allowed = ((performance.now() - throttleStart) / 1000) * myrPerSecond;
      if (throttleMyr >= allowed) break;
    }
    const s0 = performance.now();
    const before = sim.timeMyr;
    sim.step();
    throttleMyr += sim.timeMyr - before;
    const dtMs = performance.now() - s0;
    msPerStep = msPerStep === 0 ? dtMs : 0.95 * msPerStep + 0.05 * dtMs;
    steps++;
  }
  throttled = steps === 0 && myrPerSecond > 0;
  rateSteps += steps;
  rateMyr += sim.timeMyr - myr0;
  const now = performance.now();
  if (now - rateWindowStart > 1000) {
    const s = (now - rateWindowStart) / 1000;
    stepsPerSecond = rateSteps / s;
    simRate = rateMyr / s;
    rateSteps = 0;
    rateMyr = 0;
    rateWindowStart = now;
  }
}

function sendFrame(req: { view: ViewMode; arrows: boolean; profiles: boolean }): void {
  if (!sim) return;
  const n = sim.n;
  const nn = n * n;
  const field = new Float32Array(nn);
  let field2: Float32Array | null = null;
  switch (req.view) {
    case 'galaxy':
      sim.surfaceDensity(field, 'stars');
      field2 = new Float32Array(nn);
      sim.surfaceDensity(field2, 'gas');
      break;
    case 'stars':
      sim.surfaceDensity(field, 'stars');
      break;
    case 'gas':
      sim.surfaceDensity(field, 'gas');
      break;
    case 'potential':
      sim.totalPotential(field);
      break;
    case 'vorticity':
      sim.vorticity(field, true);
      break;
    case 'darkmatter':
      sim.haloDensity(field);
      field2 = new Float32Array(nn);
      sim.surfaceDensity(field2, 'total');
      break;
  }
  let u: Float32Array | null = null;
  let v: Float32Array | null = null;
  if (req.arrows) {
    u = new Float32Array(nn);
    v = new Float32Array(nn);
    sim.velocity(u, v);
  }
  const profiles = req.profiles ? sim.profiles() : null;
  const msg: FrameMessage = {
    type: 'frame',
    n,
    boxSize: sim.boxSize,
    view: req.view,
    field,
    field2,
    u,
    v,
    sigmaRef: sim.sigmaRef,
    gasRef: sim.gasRef,
    hasGas: sim.hasGas,
    darkMatter: sim.params.darkMatter,
    globals: sim.globals(),
    profiles,
    corotation: profiles ? sim.corotationRadius(profiles) : NaN,
    patternAngle: sim.patternAngle(),
    haloScale: sim.params.haloScale,
    perf: { msPerStep, stepsPerSecond: running ? stepsPerSecond : 0, myrPerSecond: running ? simRate : 0 },
    nan: req.profiles ? sim.hasNaN() : false,
  };
  const transfer: Transferable[] = [field.buffer];
  if (field2) transfer.push(field2.buffer);
  if (u && v) transfer.push(u.buffer, v.buffer);
  if (profiles) for (const a of Object.values(profiles)) transfer.push((a as Float64Array).buffer);
  self.postMessage(msg, transfer);
}

function loop(): void {
  loopScheduled = false;
  try {
    if (running) doSteps(12);
    if (pending) {
      const req = pending;
      pending = null;
      sendFrame(req);
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e) });
    running = false;
  }
  schedule();
}

function schedule(): void {
  if (loopScheduled) return;
  if (!running && !pending) return;
  loopScheduled = true;
  setTimeout(loop, throttled && !pending ? 4 : 0);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'reset':
      build(m.params);
      break;
    case 'set':
      sim?.setParams(m.params);
      break;
    case 'run':
      running = m.running;
      throttleStart = performance.now();
      throttleMyr = 0;
      break;
    case 'step':
      for (let i = 0; i < m.count; i++) sim?.step();
      break;
    case 'speed':
      myrPerSecond = m.myrPerSecond;
      throttleStart = performance.now();
      throttleMyr = 0;
      break;
    case 'frame':
      pending = { view: m.view, arrows: m.arrows, profiles: m.profiles };
      break;
  }
  schedule();
};
