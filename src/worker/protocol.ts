/** Messages between the UI thread and the simulation worker. */
import type { GalaxyParams, GlobalDiagnostics, RadialProfiles } from '../solver';

export type ViewMode = 'galaxy' | 'stars' | 'gas' | 'potential' | 'vorticity' | 'darkmatter';
export const VIEW_MODES: readonly ViewMode[] = ['galaxy', 'stars', 'gas', 'potential', 'vorticity', 'darkmatter'];

export type ToWorker =
  | { type: 'reset'; params: GalaxyParams }
  | { type: 'set'; params: Partial<GalaxyParams> }
  | { type: 'run'; running: boolean }
  | { type: 'step'; count: number }
  /** Limit simulated Myr per wall-clock second (0 = as fast as possible). */
  | { type: 'speed'; myrPerSecond: number }
  | { type: 'frame'; view: ViewMode; arrows: boolean; profiles: boolean };

export interface FrameMessage {
  type: 'frame';
  n: number;
  boxSize: number;
  view: ViewMode;
  /** Primary field for the view (n², row-major, j = y index). */
  field: Float32Array;
  /** Secondary field: gas density for 'galaxy', stellar density for 'darkmatter'. */
  field2: Float32Array | null;
  /** Velocity (km/s) when arrows were requested. */
  u: Float32Array | null;
  v: Float32Array | null;
  sigmaRef: number;
  gasRef: number;
  hasGas: boolean;
  darkMatter: boolean;
  globals: GlobalDiagnostics;
  profiles: RadialProfiles | null;
  corotation: number;
  patternAngle: number;
  haloScale: number;
  perf: { msPerStep: number; stepsPerSecond: number; myrPerSecond: number };
  nan: boolean;
}

export type FromWorker = FrameMessage | { type: 'error'; message: string };
