/** UI state: the full GalaxyParams plus view / playback preferences. */
import { defaultGalaxyParams, type GalaxyParams } from '../solver';
import { getPreset, type PresetId } from '../presets';
import type { ViewMode } from '../worker/protocol';

export interface UISettings {
  preset: PresetId;
  view: ViewMode;
  arrows: boolean;
  contours: boolean;
  paused: boolean;
  /** Simulated Myr per wall-clock second; 0 = as fast as possible. */
  speed: number;
}

export type Settings = GalaxyParams & UISettings;

/** Keys that are kept when switching presets (numerics and view preferences). */
const KEEP: (keyof Settings)[] = ['n', 'cfl', 'gravityEvery', 'view', 'arrows', 'contours', 'paused', 'speed'];

export function settingsForPreset(id: PresetId, previous?: Settings): Settings {
  const base: Settings = {
    ...defaultGalaxyParams,
    ...getPreset(id).params,
    preset: id,
    view: 'galaxy',
    arrows: false,
    contours: false,
    paused: false,
    speed: 0,
  };
  if (previous) for (const k of KEEP) (base as unknown as Record<string, unknown>)[k] = previous[k];
  base.preset = id;
  return base;
}

/** Strip UI-only fields to get the solver parameters. */
export function galaxyParams(s: Settings): GalaxyParams {
  const { preset: _p, view: _v, arrows: _a, contours: _c, paused: _pa, speed: _s, ...rest } = s;
  return rest;
}
