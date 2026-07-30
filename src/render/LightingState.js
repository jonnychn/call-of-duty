import * as THREE from 'three';

// ---------------------------------------------------------------------------
// One-way channel from Atmosphere (author) to PostFX (reader).
//
// Time of day decides exposure, grade, bloom, god-ray strength and the screen
// position of the sun. All of that lives here rather than being duplicated in
// two systems, so a preset change moves lighting and post together and there
// is exactly one place to look when a frame is the wrong brightness.
// ---------------------------------------------------------------------------

export const lighting = {
  /** Direction *to* the sky sun, world space, unit length. */
  sunDirection: new THREE.Vector3(0, 1, 0),
  /** Direction *to* the key light (differs from the sun at night). */
  keyDirection: new THREE.Vector3(0, 1, 0),
  sunColor: new THREE.Color(1, 1, 1),
  godrayColor: new THREE.Color(1, 1, 1),

  /** 0 when the disc is below the horizon: kills shafts and flare. */
  sunAboveHorizon: 1,

  /** Scene key, linear multiplier applied before the film curve. */
  exposure: 1.0,
  contrast: 1.12,
  saturation: 1.02,
  lift: new THREE.Vector3(0.003, 0.005, 0.012),
  gain: new THREE.Vector3(1.02, 1.0, 0.98),

  bloom: 0.34,
  godray: 1.0,
  flare: 0.8,

  /** Bumped on every preset change so readers can react. */
  version: 0,
};
