/**
 * Builds and binds the control panel. Sliders are generated from the specs
 * below; each one is either applied live ('live') or restarts the galaxy from
 * a new equilibrium ('restart').
 */
import { PRESETS, getPreset, type PresetId } from '../presets';
import { VIEW_MODES, type ViewMode } from '../worker/protocol';
import type { GalaxyParams } from '../solver';
import type { Settings } from './settings';

type NumKey = { [K in keyof GalaxyParams]: GalaxyParams[K] extends number ? K : never }[keyof GalaxyParams];

interface SliderSpec {
  key: NumKey;
  group: 'halo' | 'baryons' | 'bulge' | 'forcing' | 'numerics';
  label: string;
  min: number;
  max: number;
  step: number;
  /** Slider position is log10(value). */
  log?: boolean;
  format: (x: number, s: Settings) => string;
  apply: 'live' | 'restart';
  /** Only shown when this returns true. */
  show?: (s: Settings) => boolean;
}

const sci = (m: number) => {
  // m in 1e10 Msun → "1.0×10¹² M☉"
  const v = m * 1e10;
  const e = Math.floor(Math.log10(v));
  const sup = String(e).replace(/[0-9-]/g, (c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'['0123456789'.indexOf(c)] ?? '⁻');
  return `${(v / 10 ** e).toFixed(1)}×10${sup} M☉`;
};

const SLIDERS: SliderSpec[] = [
  { key: 'haloMass', group: 'halo', label: 'Halo mass M₂₀₀', min: 1, max: 3, step: 0.02, log: true, format: (x) => sci(x), apply: 'live' },
  { key: 'haloScale', group: 'halo', label: 'Scale radius r_s / core r_c', min: 1, max: 40, step: 0.5, format: (x) => `${x.toFixed(1)} kpc`, apply: 'live' },

  { key: 'mass', group: 'baryons', label: 'Baryonic mass (stars + gas)', min: 0.5, max: 20, step: 0.1, format: (x) => sci(x), apply: 'restart' },
  { key: 'scaleLength', group: 'baryons', label: 'Scale length', min: 0.8, max: 6, step: 0.1, format: (x, s) => `${x.toFixed(1)} kpc${s.kind === 'disk' ? ' (R_d)' : ' (a)'}`, apply: 'restart' },
  { key: 'gasFraction', group: 'baryons', label: 'Gas fraction', min: 0, max: 0.4, step: 0.01, format: (x) => `${(x * 100).toFixed(0)} %`, apply: 'restart' },
  { key: 'toomreQ', group: 'baryons', label: 'Stellar Toomre Q', min: 0.8, max: 3, step: 0.05, format: (x) => x.toFixed(2), apply: 'restart', show: (s) => s.kind === 'disk' },
  { key: 'rotation', group: 'baryons', label: 'Rotational support v_φ / v_c', min: 0, max: 0.9, step: 0.05, format: (x) => x.toFixed(2), apply: 'restart', show: (s) => s.kind === 'hot' },
  { key: 'ellipticity', group: 'baryons', label: 'Initial ellipticity 1 − b/a', min: 0, max: 0.5, step: 0.05, format: (x) => `${x.toFixed(2)} (E${Math.round(x * 10)})`, apply: 'restart', show: (s) => s.kind === 'hot' },
  { key: 'gamma', group: 'baryons', label: 'Stellar EOS index γ (P ∝ Σ^γ)', min: 1, max: 2, step: 0.05, format: (x) => x.toFixed(2), apply: 'restart' },

  { key: 'bulgeMass', group: 'bulge', label: 'Bulge mass (Hernquist)', min: 0, max: 5, step: 0.1, format: (x) => (x === 0 ? 'none' : sci(x)), apply: 'live' },

  { key: 'forcingStrength', group: 'forcing', label: 'Strength (force ratio)', min: 0, max: 0.4, step: 0.005, format: (x) => `${(x * 100).toFixed(1)} %`, apply: 'live', show: (s) => s.forcing !== 'none' },
  { key: 'patternSpeed', group: 'forcing', label: 'Pattern speed Ω_p', min: 5, max: 80, step: 1, format: (x) => `${x.toFixed(0)} km/s/kpc`, apply: 'live', show: (s) => s.forcing !== 'none' },
  { key: 'pitchAngle', group: 'forcing', label: 'Pitch angle', min: 5, max: 40, step: 1, format: (x) => `${x.toFixed(0)}°`, apply: 'live', show: (s) => s.forcing === 'spiral' },
  { key: 'barRadius', group: 'forcing', label: 'Bar scale radius', min: 1, max: 8, step: 0.25, format: (x) => `${x.toFixed(2)} kpc`, apply: 'live', show: (s) => s.forcing === 'bar' },

  { key: 'cfl', group: 'numerics', label: 'CFL number (time-step safety)', min: 0.1, max: 0.8, step: 0.05, format: (x) => x.toFixed(2), apply: 'live' },
  { key: 'gravityEvery', group: 'numerics', label: 'Self-gravity solve every', min: 1, max: 4, step: 1, format: (x) => `${x} step${x > 1 ? 's' : ''}`, apply: 'live' },
];

export interface ControlCallbacks {
  /** A live parameter changed. */
  onLive(update: Partial<GalaxyParams>): void;
  /** A restart parameter or the preset changed: rebuild from equilibrium. */
  onRestart(): void;
  onPlayPause(paused: boolean): void;
  onStep(): void;
  onSpeed(myrPerSecond: number): void;
  onViewChange(): void;
  /** Called when the preset is chosen; returns the new settings object. */
  onPreset(id: PresetId): Settings;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

export function bindControls(initial: Settings, cb: ControlCallbacks): { sync(): void; settings(): Settings } {
  let s = initial;
  const syncs: (() => void)[] = [];

  // ---- sliders ----
  for (const spec of SLIDERS) {
    const host = document.querySelector<HTMLElement>(`.sliders[data-group="${spec.group}"]`);
    if (!host) continue;
    const label = document.createElement('label');
    label.className = 'slider';
    const out = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range';
    input.id = spec.key;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    label.append(document.createTextNode(spec.label + ' '), out, input);
    host.append(label);
    const toValue = (pos: number) => (spec.log ? 10 ** pos : pos);
    const toPos = (v: number) => (spec.log ? Math.log10(v) : v);
    const sync = () => {
      input.value = String(toPos(s[spec.key]));
      out.textContent = spec.format(s[spec.key], s);
      label.dataset.hidden = String(spec.show ? !spec.show(s) : false);
    };
    input.addEventListener('input', () => {
      const v = toValue(Number(input.value));
      out.textContent = spec.format(v, s);
      if (spec.apply === 'live') {
        s[spec.key] = v;
        cb.onLive({ [spec.key]: v });
      }
    });
    input.addEventListener('change', () => {
      s[spec.key] = toValue(Number(input.value));
      if (spec.apply === 'restart') cb.onRestart();
      syncAll();
    });
    syncs.push(sync);
  }

  // ---- selects & checkboxes ----
  const preset = $<HTMLSelectElement>('preset');
  for (const p of PRESETS) preset.append(new Option(p.label, p.id));
  const presetDesc = $<HTMLParagraphElement>('preset-desc');
  preset.addEventListener('change', () => {
    s = cb.onPreset(preset.value as PresetId);
    syncAll();
  });

  const view = $<HTMLSelectElement>('view');
  view.addEventListener('change', () => {
    s.view = view.value as ViewMode;
    cb.onViewChange();
  });
  const arrows = $<HTMLInputElement>('arrows');
  arrows.addEventListener('change', () => (s.arrows = arrows.checked));
  const contours = $<HTMLInputElement>('contours');
  contours.addEventListener('change', () => (s.contours = contours.checked));

  const dm = $<HTMLInputElement>('darkMatter');
  dm.addEventListener('change', () => {
    s.darkMatter = dm.checked;
    cb.onLive({ darkMatter: s.darkMatter });
  });
  const haloProfile = $<HTMLSelectElement>('haloProfile');
  haloProfile.addEventListener('change', () => {
    s.haloProfile = haloProfile.value as Settings['haloProfile'];
    // sensible default scale radii for each profile
    s.haloScale = s.haloProfile === 'nfw' ? Math.max(s.haloScale, 15) : Math.min(s.haloScale, 6);
    cb.onLive({ haloProfile: s.haloProfile, haloScale: s.haloScale });
    syncAll();
  });
  const forcing = $<HTMLSelectElement>('forcing');
  forcing.addEventListener('change', () => {
    s.forcing = forcing.value as Settings['forcing'];
    const update: Partial<GalaxyParams> = { forcing: s.forcing };
    if (s.forcing !== 'none' && s.forcingStrength === 0) s.forcingStrength = s.forcing === 'bar' ? 0.12 : 0.05;
    if (s.forcing === 'bar' && s.patternSpeed < 25) s.patternSpeed = 40;
    if (s.forcing === 'spiral' && s.patternSpeed > 30) s.patternSpeed = 20;
    Object.assign(update, { forcingStrength: s.forcingStrength, patternSpeed: s.patternSpeed });
    cb.onLive(update);
    syncAll();
  });
  const grid = $<HTMLSelectElement>('n');
  grid.addEventListener('change', () => {
    s.n = Number(grid.value);
    cb.onRestart();
  });
  const speed = $<HTMLSelectElement>('speed');
  speed.addEventListener('change', () => {
    s.speed = Number(speed.value);
    cb.onSpeed(s.speed);
  });

  // ---- buttons ----
  const play = $<HTMLButtonElement>('play');
  play.addEventListener('click', () => {
    s.paused = !s.paused;
    cb.onPlayPause(s.paused);
    syncAll();
  });
  $<HTMLButtonElement>('step').addEventListener('click', () => {
    if (!s.paused) {
      s.paused = true;
      cb.onPlayPause(true);
      syncAll();
    }
    cb.onStep();
  });
  $<HTMLButtonElement>('reset').addEventListener('click', () => cb.onRestart());

  const panel = $<HTMLElement>('panel');
  const toggle = $<HTMLButtonElement>('panel-toggle');
  const togglePanel = () => {
    const hidden = panel.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!hidden));
  };
  toggle.addEventListener('click', togglePanel);

  function syncAll(): void {
    for (const f of syncs) f();
    preset.value = s.preset;
    presetDesc.textContent = getPreset(s.preset).description;
    view.value = s.view;
    arrows.checked = s.arrows;
    contours.checked = s.contours;
    dm.checked = s.darkMatter;
    haloProfile.value = s.haloProfile;
    forcing.value = s.forcing;
    grid.value = String(s.n);
    speed.value = String(s.speed);
    play.textContent = s.paused ? '▶ Play' : '⏸ Pause';
  }
  syncAll();

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case ' ':
        e.preventDefault();
        play.click();
        break;
      case 's':
        $<HTMLButtonElement>('step').click();
        break;
      case 'r':
        cb.onRestart();
        break;
      case 'd':
        dm.click();
        break;
      case 'v':
        s.view = VIEW_MODES[(VIEW_MODES.indexOf(s.view) + 1) % VIEW_MODES.length];
        syncAll();
        cb.onViewChange();
        break;
      case 'a':
        s.arrows = !s.arrows;
        syncAll();
        break;
      case 'h':
        togglePanel();
        break;
    }
  });

  return { sync: syncAll, settings: () => s };
}
