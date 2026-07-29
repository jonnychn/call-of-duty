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
    fireMode: 'auto',
    tracerEvery: 3,
    penetration: 0.35,
  },
};
