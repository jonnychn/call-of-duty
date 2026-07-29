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
    csm: false,
    softShadows: 0,
    shadowDistance: 40,
    ssao: false,
    ssaoSamples: 8,
    bloom: true,
    bloomMips: 4,
    motionBlur: false,
    dof: false,
    volumetrics: false,
    volumetricSteps: 0,
    aerialPerspective: true,
    autoExposure: false,
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
    csm: true,
    softShadows: 0,
    shadowDistance: 70,
    ssao: true,
    ssaoSamples: 12,
    bloom: true,
    bloomMips: 5,
    motionBlur: false,
    dof: true,
    volumetrics: true,
    volumetricSteps: 24,
    aerialPerspective: true,
    autoExposure: true,
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
    csm: true,
    softShadows: 1,
    shadowDistance: 110,
    ssao: true,
    ssaoSamples: 20,
    bloom: true,
    bloomMips: 6,
    motionBlur: true,
    dof: true,
    volumetrics: true,
    volumetricSteps: 40,
    aerialPerspective: true,
    autoExposure: true,
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
    csm: true,
    softShadows: 1,
    shadowDistance: 170,
    ssao: true,
    ssaoSamples: 32,
    bloom: true,
    bloomMips: 6,
    motionBlur: true,
    dof: true,
    volumetrics: true,
    volumetricSteps: 64,
    aerialPerspective: true,
    autoExposure: true,
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
  // `exposure` is a global stop offset on top of the per-time-of-day exposure
  // the Atmosphere publishes. 1.0 = shoot the preset as authored.
  exposure: 1.0,
  bloomStrength: 0.34,
  bloomThreshold: 1.05,
  chromaticAberration: 0.0009,
  filmGrain: 0.017,
  vignette: 0.42,
  sharpen: 0.30,
  lensDirt: 0.22,
  motionBlurStrength: 0.55,

  // Filmic tone curve (Hable). Higher shoulder = softer highlight rolloff,
  // higher toe = deeper, more contrasty blacks. These are the knobs that
  // decide whether the frame reads as "video" or as "film".
  tone: {
    shoulderStrength: 0.24,
    linearStrength: 0.28,
    linearAngle: 0.12,
    toeStrength: 0.28,
    toeNumerator: 0.012,
    toeDenominator: 0.26,
    whitePoint: 9.5,
    contrast: 1.0,       // global multiplier on the per-preset contrast
    highlightDesat: 0.55, // how much the shoulder pushes toward white
  },

  // Eye adaptation. Deliberately narrow — this is a stabiliser, not an
  // auto-exposure that overrides the art direction.
  exposureAdaptSpeed: 1.6,
  exposureAdaptMin: -0.55, // stops
  exposureAdaptMax: 0.55,

  godrayStrength: 1.0,
  flareStrength: 1.0,

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
