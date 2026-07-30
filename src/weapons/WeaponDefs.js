// Weapon statistics. Damage is per-hit at point blank before falloff and
// multipliers; ranges are metres; rpm is rounds per minute.

export const WEAPONS = {
  carbine: {
    id: 'carbine',
    name: 'M4A1',
    class: 'Assault Rifle',
    rpm: 780,
    magazine: 30,
    reserve: 210,
    damage: 33,
    damageFalloff: [
      [0, 1.0],
      [28, 1.0],
      [55, 0.72],
      [90, 0.55],
    ],
    headshotMultiplier: 1.55,
    limbMultiplier: 0.9,
    muzzleVelocity: 880,
    reloadTime: 2.05,
    reloadEmptyTime: 2.65,
    adsTime: 0.22,
    // Cone of fire, in degrees of half-angle.
    spread: { hipBase: 2.6, hipMax: 5.4, adsBase: 0.18, adsMax: 1.1, moveScale: 1.7, growth: 0.42, recover: 3.2 },
    // Viewmodel recoil impulse per shot.
    recoil: { back: -0.62, rise: 0.30, lateral: 0.30, pitch: 2.4, yaw: 0.85, roll: 1.5 },
    // Camera kick, degrees.
    camKick: { pitch: 0.42, yaw: 0.20, recenter: 0.72 },
    // Designed recoil pattern: [horizontal, vertical] multipliers per shot.
    // This is the CoD convention — the climb is authored, not random, so a
    // player can learn to pull down-left through the middle of the mag and
    // then ride the right drift. Noise is added on top at ~15% amplitude so
    // it never feels like a rail. Wraps if the magazine outlasts the list.
    pattern: [
      [0.00, 1.00], [0.05, 1.05], [-0.10, 1.10], [0.14, 1.12], [-0.18, 1.10],
      [-0.34, 1.05], [-0.48, 0.98], [-0.55, 0.92], [-0.52, 0.86], [-0.40, 0.82],
      [-0.20, 0.80], [0.06, 0.80], [0.32, 0.82], [0.56, 0.84], [0.74, 0.86],
      [0.86, 0.88], [0.92, 0.88], [0.90, 0.86], [0.80, 0.84], [0.64, 0.82],
      [0.44, 0.80], [0.22, 0.78], [0.02, 0.78], [-0.16, 0.78], [-0.30, 0.80],
      [-0.38, 0.80], [-0.40, 0.80], [-0.36, 0.80], [-0.26, 0.78], [-0.12, 0.78],
    ],
    fireMode: 'auto',
    tracerEvery: 3,
    penetration: 0.35,
  },

  pdw: {
    id: 'pdw',
    name: 'VECTOR-9',
    class: 'SMG',
    rpm: 1010,
    magazine: 32,
    reserve: 224,
    damage: 24,
    damageFalloff: [
      [0, 1.0],
      [14, 1.0],
      [30, 0.70],
      [55, 0.48],
    ],
    headshotMultiplier: 1.4,
    limbMultiplier: 0.92,
    muzzleVelocity: 400,
    reloadTime: 1.72,
    reloadEmptyTime: 2.25,
    adsTime: 0.17,
    spread: { hipBase: 2.1, hipMax: 5.8, adsBase: 0.30, adsMax: 1.6, moveScale: 0.9, growth: 0.34, recover: 4.0 },
    recoil: { back: -0.44, rise: 0.22, lateral: 0.26, pitch: 1.6, yaw: 0.70, roll: 1.2 },
    camKick: { pitch: 0.26, yaw: 0.16, recenter: 0.80 },
    // Faster, flatter, wider pattern: climbs less but wanders more, which is
    // what makes an SMG lose to a rifle past its falloff.
    pattern: [
      [0.00, 1.00], [-0.12, 1.02], [-0.26, 1.00], [-0.34, 0.94], [-0.30, 0.88],
      [-0.14, 0.84], [0.10, 0.82], [0.36, 0.82], [0.58, 0.82], [0.70, 0.80],
      [0.68, 0.78], [0.52, 0.76], [0.28, 0.76], [0.02, 0.76], [-0.24, 0.76],
      [-0.46, 0.76], [-0.58, 0.74], [-0.56, 0.74], [-0.42, 0.74], [-0.20, 0.74],
      [0.06, 0.72], [0.32, 0.72], [0.52, 0.72], [0.62, 0.72], [0.58, 0.70],
      [0.44, 0.70], [0.22, 0.70], [-0.02, 0.70], [-0.24, 0.70], [-0.38, 0.70],
      [-0.42, 0.70], [-0.36, 0.70],
    ],
    fireMode: 'auto',
    tracerEvery: 4,
    penetration: 0.18,
  },
};
