// Central quality + gameplay tuning. Sub-systems read from here so a single
// quality switch moves the whole renderer coherently.

export const Quality = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  ULTRA: 'ultra',
};

const PRESETS = {
  low: {
    pixelRatio: 0.75,
    shadowMapSize: 1024,
    cascades: 2,
    shadowDistance: 40,
    ssao: false,
    ssaoSamples: 8,
    bloom: true,
    bloomMips: 4,
    motionBlur: false,
    dof: false,
    volumetrics: false,
    volumetricSteps: 0,
    taa: false,
    ssr: false,
    textureSize: 512,
    anisotropy: 4,
    particleBudget: 300,
    decalBudget: 64,
  },
  medium: {
    pixelRatio: 1.0,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 70,
    ssao: true,
    ssaoSamples: 12,
    bloom: true,
    bloomMips: 5,
    motionBlur: false,
    dof: true,
    volumetrics: true,
    volumetricSteps: 24,
    taa: true,
    ssr: false,
    textureSize: 1024,
    anisotropy: 8,
    particleBudget: 800,
    decalBudget: 128,
  },
  high: {
    pixelRatio: 1.0,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 110,
    ssao: true,
    ssaoSamples: 20,
    bloom: true,
    bloomMips: 6,
    motionBlur: true,
    dof: true,
    volumetrics: true,
    volumetricSteps: 40,
    taa: true,
    ssr: true,
    textureSize: 2048,
    anisotropy: 16,
    particleBudget: 1600,
    decalBudget: 256,
  },
  ultra: {
    pixelRatio: 1.0,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 160,
    ssao: true,
    ssaoSamples: 32,
    bloom: true,
    bloomMips: 6,
    motionBlur: true,
    dof: true,
    volumetrics: true,
    volumetricSteps: 64,
    taa: true,
    ssr: true,
    textureSize: 2048,
    anisotropy: 16,
    particleBudget: 3000,
    decalBudget: 512,
  },
};

export const settings = {
  quality: 'high',
  ...PRESETS.high,

  // Camera / feel
  fov: 80,
  adsFovScale: 0.62,
  sensitivity: 0.0022,
  adsSensitivityScale: 0.65,
  invertY: false,

  // Post-process artistic controls
  exposure: 0.52,
  bloomStrength: 0.42,
  bloomThreshold: 0.9,
  chromaticAberration: 0.0016,
  filmGrain: 0.030,
  vignette: 0.34,
  sharpen: 0.35,
  lensDirt: 0.35,
  motionBlurStrength: 0.55,

  audioMaster: 0.8,

  setQuality(q) {
    if (!PRESETS[q]) return;
    Object.assign(this, PRESETS[q]);
    this.quality = q;
    for (const fn of listeners) fn(this);
  },
};

const listeners = new Set();
export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notifySettingsChanged() {
  for (const fn of listeners) fn(settings);
}
