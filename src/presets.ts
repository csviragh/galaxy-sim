/**
 * Galaxy presets. Each one is a set of GalaxyParams overrides on top of the
 * defaults; the user can tweak everything afterwards.
 */
import type { GalaxyParams } from './solver';

export type PresetId = 'spiral' | 'flocculent' | 'barred' | 'lenticular' | 'elliptical';

export interface Preset {
  id: PresetId;
  label: string;
  description: string;
  params: Partial<GalaxyParams>;
}

const diskBase: Partial<GalaxyParams> = {
  kind: 'disk',
  mass: 5,
  scaleLength: 3,
  truncation: 15,
  gasFraction: 0.15,
  gasScale: 1.5,
  gasSoundSpeed: 10,
  gamma: 1,
  sigmaMin: 10,
  noise: 0.03,
  rotation: 0.2,
  ellipticity: 0,
  bulgeMass: 1,
  bulgeScale: 0.6,
  darkMatter: true,
  haloProfile: 'nfw',
  haloMass: 100,
  haloScale: 20,
  pitchAngle: 15,
  arms: 2,
  barRadius: 4,
};

export const PRESETS: readonly Preset[] = [
  {
    id: 'spiral',
    label: 'Spiral (grand design, Sb)',
    description:
      'Exponential stellar + gas disk with a bulge in an NFW halo, driven by a weak rotating two-armed spiral density wave.',
    params: { ...diskBase, toomreQ: 1.25, forcing: 'spiral', forcingStrength: 0.05, patternSpeed: 20 },
  },
  {
    id: 'flocculent',
    label: 'Flocculent spiral (Sc)',
    description:
      'No external driving: a cool, gas-rich disk (Toomre Q ≈ 1.25) whose own self-gravity swing-amplifies noise into many short arms.',
    params: { ...diskBase, toomreQ: 1.25, gasFraction: 0.2, noise: 0.05, bulgeMass: 0.5, forcing: 'none', forcingStrength: 0, patternSpeed: 20 },
  },
  {
    id: 'barred',
    label: 'Barred spiral (SBb)',
    description:
      'A rotating bar potential (Ω_b = 40 km/s/kpc, corotation ≈ 5.5 kpc) drives gas inflow along the bar and two trailing arms. Stiffer stellar fluid (γ = 2).',
    params: { ...diskBase, toomreQ: 1.6, gamma: 2, forcing: 'bar', forcingStrength: 0.07, patternSpeed: 40, bulgeMass: 0.8 },
  },
  {
    id: 'lenticular',
    label: 'Lenticular (S0)',
    description: 'A hot (Q ≈ 2.5), gas-poor disk with a big bulge: rotating, but too hot to form spiral arms.',
    params: { ...diskBase, mass: 6, toomreQ: 2.5, gasFraction: 0.02, bulgeMass: 3, bulgeScale: 1, forcing: 'none', forcingStrength: 0, patternSpeed: 20 },
  },
  {
    id: 'elliptical',
    label: 'Elliptical (E2)',
    description:
      'Pressure-supported, slowly rotating (v_φ = 0.2 v_c), centrally concentrated (projected-Hernquist-like) system with initial axis ratio 0.8, in a massive halo. No gas, no arms.',
    params: {
      ...diskBase,
      kind: 'hot',
      mass: 10,
      scaleLength: 1.5,
      truncation: 30,
      gasFraction: 0,
      gamma: 2,
      noise: 0.01,
      rotation: 0.2,
      ellipticity: 0.2,
      bulgeMass: 0,
      haloMass: 150,
      haloScale: 25,
      forcing: 'none',
      forcingStrength: 0,
      patternSpeed: 20,
    },
  },
];

export function getPreset(id: PresetId): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
