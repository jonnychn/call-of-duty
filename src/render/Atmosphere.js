import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { settings } from '../core/Settings.js';
import { lighting } from './LightingState.js';
import { patchAerialPerspective, aerialUniforms } from './AerialPerspective.js';
import { patchSky } from './SkyShader.js';

// ---------------------------------------------------------------------------
// Sky, sun, image-based lighting, cascaded shadows and aerial perspective.
//
// The chain is:
//   preset -> Preetham sky (patched: sun disc, limb darkening, ground, stars)
//          -> PMREM probe        (ambient + specular IBL)
//          -> key light (CSM)    (direct sun/moon, 2-4 cascades)
//          -> fill + bounce      (hemisphere + a dim opposing directional)
//          -> aerial perspective (height fog + Mie inscatter, in every shader)
//          -> LightingState      (exposure/grade/god-rays consumed by PostFX)
//
// Everything downstream of the preset is derived, so a time-of-day switch
// moves the entire look coherently instead of just changing brightness.
// ---------------------------------------------------------------------------

/**
 * Time-of-day presets. Six deliberately different lighting scenarios rather
 * than one scene at six brightnesses.
 *
 *  elevation/azimuth   sun position used for the *sky* (degrees)
 *  lightElevation/..   optional override for the *key light* (night: the moon)
 *  exposure            scene key, in linear multiplier, before the film curve
 *  fog*                aerial perspective; see AerialPerspective.js
 */
export const TIME_OF_DAY = {
  // Cold blue pre-dawn with a thin band of fire on the eastern horizon.
  // Ground mist sits low and thick; anything above head height is clear.
  dawn: {
    elevation: 2.2, azimuth: 96,
    turbidity: 4.5, rayleigh: 3.4, mieCoefficient: 0.020, mieG: 0.90,
    skyExposure: 0.62, sunDiscIntensity: 0.55, aureole: 0.55,
    starIntensity: 0.22, groundColor: 0x14161c,
    sunIntensity: 2.4, sunColor: 0xffa661,
    ambient: 0.42, hemiSky: 0x5c7ba8, hemiGround: 0x2a2118, hemiIntensity: 0.34,
    bounceColor: 0x3c4c68, bounceIntensity: 0.22,
    fogColor: 0x2f3d55, fogSunColor: 0xff9a5c, fogHorizon: 0x6e6478,
    fogDensity: 0.042, fogHeight: 0.22, fogBase: 0.0,
    fogMie: 2.6, fogMieG: 0.76, fogInscatter: 1.15,
    exposure: 1.45, contrast: 1.16, saturation: 1.06,
    lift: [0.006, 0.010, 0.020], gain: [1.02, 0.99, 1.02],
    bloom: 0.46, godray: 1.15, godrayColor: 0xffb375, flare: 0.55,
  },

  // Clean, cool, high-clarity. The "clear tactical morning" reference frame:
  // long shadows, crisp air, almost no haze. Highest contrast of the six.
  morning: {
    elevation: 24, azimuth: 122,
    turbidity: 2.6, rayleigh: 1.7, mieCoefficient: 0.0035, mieG: 0.78,
    skyExposure: 0.95, sunDiscIntensity: 0.9, aureole: 0.22,
    starIntensity: 0.0, groundColor: 0x2a2721,
    sunIntensity: 5.6, sunColor: 0xfff0d6,
    ambient: 0.62, hemiSky: 0x9db9de, hemiGround: 0x4a4034, hemiIntensity: 0.30,
    bounceColor: 0x6a6252, bounceIntensity: 0.16,
    fogColor: 0x7d95ad, fogSunColor: 0xdcd0bc, fogHorizon: 0xa6b6c6,
    fogDensity: 0.0075, fogHeight: 0.030, fogBase: 0.0,
    fogMie: 0.9, fogMieG: 0.68, fogInscatter: 0.85,
    exposure: 1.0, contrast: 1.14, saturation: 1.02,
    lift: [0.002, 0.004, 0.010], gain: [1.01, 1.0, 1.0],
    bloom: 0.26, godray: 0.55, godrayColor: 0xffe9c8, flare: 0.5,
  },

  // Harsh overhead light. Short hard shadows, bleached highlights, very
  // desaturated — the least flattering and most "documentary" of the six.
  noon: {
    elevation: 68, azimuth: 186,
    turbidity: 3.4, rayleigh: 1.1, mieCoefficient: 0.0045, mieG: 0.76,
    skyExposure: 1.05, sunDiscIntensity: 1.0, aureole: 0.18,
    starIntensity: 0.0, groundColor: 0x35312a,
    sunIntensity: 6.6, sunColor: 0xfff6ea,
    ambient: 0.72, hemiSky: 0xa8c2e0, hemiGround: 0x554b3c, hemiIntensity: 0.36,
    bounceColor: 0x7a705c, bounceIntensity: 0.20,
    fogColor: 0x8fa2b4, fogSunColor: 0xc9c6bd, fogHorizon: 0xb4c0ca,
    fogDensity: 0.0055, fogHeight: 0.022, fogBase: 0.0,
    fogMie: 0.55, fogMieG: 0.62, fogInscatter: 0.7,
    exposure: 0.86, contrast: 1.08, saturation: 0.90,
    lift: [0.004, 0.005, 0.008], gain: [1.0, 1.0, 1.0],
    bloom: 0.30, godray: 0.30, godrayColor: 0xfff3e2, flare: 0.35,
  },

  // The hero look: low western sun, warm dust in the air, long raking
  // shadows coming toward the camera down the street.
  afternoon: {
    elevation: 17, azimuth: 246,
    turbidity: 5.5, rayleigh: 2.1, mieCoefficient: 0.011, mieG: 0.86,
    skyExposure: 0.90, sunDiscIntensity: 1.0, aureole: 0.45,
    starIntensity: 0.0, groundColor: 0x2b241a,
    sunIntensity: 5.2, sunColor: 0xffcf92,
    ambient: 0.52, hemiSky: 0x86a4cc, hemiGround: 0x4d3d2a, hemiIntensity: 0.28,
    bounceColor: 0x8a6a44, bounceIntensity: 0.22,
    fogColor: 0x6d7a90, fogSunColor: 0xffbd7a, fogHorizon: 0xa78f74,
    fogDensity: 0.013, fogHeight: 0.055, fogBase: 0.0,
    fogMie: 2.0, fogMieG: 0.76, fogInscatter: 1.0,
    exposure: 1.05, contrast: 1.14, saturation: 1.05,
    lift: [0.003, 0.005, 0.013], gain: [1.03, 1.0, 0.96],
    bloom: 0.36, godray: 1.0, godrayColor: 0xffc98c, flare: 0.8,
  },

  // Sun on the deck. Near-silhouette: the sky is the only bright thing in
  // the frame, everything vertical goes to a shape.
  dusk: {
    elevation: 0.6, azimuth: 272,
    turbidity: 7.5, rayleigh: 3.0, mieCoefficient: 0.026, mieG: 0.91,
    skyExposure: 0.78, sunDiscIntensity: 0.7, aureole: 0.85,
    starIntensity: 0.10, groundColor: 0x18140f,
    sunIntensity: 2.1, sunColor: 0xff7a3c,
    ambient: 0.36, hemiSky: 0x4a5c86, hemiGround: 0x241a12, hemiIntensity: 0.30,
    bounceColor: 0x6e3f24, bounceIntensity: 0.24,
    fogColor: 0x384560, fogSunColor: 0xff8340, fogHorizon: 0xa05a3a,
    fogDensity: 0.026, fogHeight: 0.070, fogBase: 0.0,
    fogMie: 3.4, fogMieG: 0.80, fogInscatter: 1.25,
    exposure: 1.5, contrast: 1.22, saturation: 1.10,
    lift: [0.004, 0.006, 0.018], gain: [1.05, 0.99, 0.95],
    bloom: 0.55, godray: 1.5, godrayColor: 0xff9a4e, flare: 1.0,
  },

  // Moonlit. The sky sun is well below the horizon so the Preetham term
  // collapses to near-black and the stars come through; the key light is a
  // separate cool moon high in the north-west.
  night: {
    elevation: -9, azimuth: 300,
    lightElevation: 38, lightAzimuth: 318,
    turbidity: 2.0, rayleigh: 0.8, mieCoefficient: 0.003, mieG: 0.80,
    skyExposure: 1.0, sunDiscIntensity: 0.0, aureole: 0.0,
    starIntensity: 1.0, groundColor: 0x05070c,
    moonIntensity: 1.0, moonSize: 0.55,
    sunIntensity: 0.85, sunColor: 0x9fb8e8,
    ambient: 0.30, hemiSky: 0x2c3a5c, hemiGround: 0x0d1018, hemiIntensity: 0.22,
    bounceColor: 0x1c2438, bounceIntensity: 0.12,
    fogColor: 0x0e1524, fogSunColor: 0x5a76ac, fogHorizon: 0x1a2438,
    fogDensity: 0.020, fogHeight: 0.045, fogBase: 0.0,
    fogMie: 1.8, fogMieG: 0.72, fogInscatter: 0.9,
    exposure: 3.6, contrast: 1.26, saturation: 0.86,
    lift: [0.002, 0.005, 0.014], gain: [0.94, 0.98, 1.10],
    bloom: 0.60, godray: 0.85, godrayColor: 0x9ec0ff, flare: 0.45,
  },
};

const _v = new THREE.Vector3();

export class Atmosphere {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sunDirection = new THREE.Vector3();  // direction *to* the sky sun
    this.lightDirection = new THREE.Vector3(); // direction *to* the key light

    // Global shader surgery. Both are idempotent and must happen before any
    // material compiles.
    patchAerialPerspective();

    this.sky = new Sky();
    this.sky.scale.setScalar(45000);
    this.sky.name = 'Sky';
    patchSky(this.sky.material);
    scene.add(this.sky);

    // Key light. When CSM is on this is a hidden proxy that only carries
    // direction/colour/intensity into the cascade lights.
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.name = 'Sun';
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.028;
    this.sun.shadow.camera.near = 0.5;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Sky/ground bounce that a single probe under-represents in alleys.
    this.hemi = new THREE.HemisphereLight(0xbfd4ee, 0x6b5a45, 0.4);
    scene.add(this.hemi);

    // A dim directional from roughly the opposite side of the key, standing
    // in for the big diffuse bounce off the ground and the far buildings.
    // Without it, shadowed faces go to a flat single-colour ambient.
    this.bounce = new THREE.DirectionalLight(0x8a7a60, 0.2);
    this.bounce.castShadow = false;
    scene.add(this.bounce);
    scene.add(this.bounce.target);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envRT = null;

    /** @type {CSM|null} */
    this.csm = null;
    this._patched = new Set();
    this._scanCountdown = 0;

    this.preset = null;
    this.apply('afternoon');
    // Level geometry already exists at this point; patch it now so the first
    // compiled frame has fog uniforms instead of recompiling 20 frames in.
    this._scanMaterials();
  }

  /** @param {keyof TIME_OF_DAY | object} preset */
  apply(preset) {
    const p = typeof preset === 'string' ? TIME_OF_DAY[preset] : preset;
    if (!p) throw new Error(`Unknown time-of-day "${preset}"`);
    this.preset = p;
    this.presetName = typeof preset === 'string' ? preset : 'custom';

    // --- sky --------------------------------------------------------------
    const u = this.sky.material.uniforms;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = p.mieCoefficient;
    u.mieDirectionalG.value = p.mieG;
    u.skyExposure.value = p.skyExposure ?? 1.0;
    u.sunDiscIntensity.value = p.sunDiscIntensity ?? 1.0;
    u.aureole.value = p.aureole ?? 0.3;
    u.starIntensity.value = p.starIntensity ?? 0.0;
    u.moonIntensity.value = p.moonIntensity ?? 0.0;
    u.moonSize.value = p.moonSize ?? 0.5;
    u.groundColor.value.setHex(p.groundColor ?? 0x2a2a2a);

    dirFromAngles(this.sunDirection, p.elevation, p.azimuth);
    u.sunPosition.value.copy(this.sunDirection);

    dirFromAngles(
      this.lightDirection,
      p.lightElevation ?? p.elevation,
      p.lightAzimuth ?? p.azimuth,
    );
    u.moonPosition.value.copy(this.lightDirection);

    // --- direct lighting --------------------------------------------------
    this.sun.position.copy(this.lightDirection).multiplyScalar(300);
    this.sun.target.position.set(0, 0, 0);
    this.sun.intensity = p.sunIntensity;
    this.sun.color.setHex(p.sunColor);
    this.sun.visible = !this.csm;

    this.hemi.intensity = p.hemiIntensity ?? p.ambient * 0.4;
    this.hemi.color.setHex(p.hemiSky ?? 0xbfd4ee);
    this.hemi.groundColor.setHex(p.hemiGround ?? 0x6b5a45);

    // Bounce comes from the opposite azimuth and slightly below the horizon,
    // so it lifts the shadow side without flattening the key.
    dirFromAngles(_v, -12, (p.lightAzimuth ?? p.azimuth) + 180);
    this.bounce.position.copy(_v).multiplyScalar(200);
    this.bounce.target.position.set(0, 0, 0);
    this.bounce.color.setHex(p.bounceColor ?? 0x8a7a60);
    this.bounce.intensity = p.bounceIntensity ?? 0.18;

    if (this.csm) {
      this.csm.lightDirection.copy(this.lightDirection).negate().normalize();
      for (const l of this.csm.lights) {
        l.color.setHex(p.sunColor);
        l.intensity = p.sunIntensity;
      }
      this.csm.lightIntensity = p.sunIntensity;
    }

    // --- aerial perspective ----------------------------------------------
    // scene.fog stays a FogExp2 purely to switch USE_FOG/FOG_EXP2 on; the
    // actual integration happens in the patched chunk.
    this.scene.fog = new THREE.FogExp2(p.fogColor, 0.0001);
    const a = aerialUniforms;
    a.aerialSunColor.value.setHex(p.fogSunColor).convertSRGBToLinear();
    a.aerialHorizonColor.value.setHex(p.fogHorizon ?? p.fogColor).convertSRGBToLinear();
    a.aerialSunDirection.value.copy(this.sunDirection);
    a.aerialDensity.value = settings.aerialPerspective ? p.fogDensity : 0.0;
    a.aerialHeightFalloff.value = p.fogHeight;
    a.aerialBaseHeight.value = p.fogBase ?? 0.0;
    a.aerialMie.value = p.fogMie;
    a.aerialMieG.value = p.fogMieG;
    a.aerialInscatter.value = p.fogInscatter;

    // --- published state for PostFX --------------------------------------
    lighting.sunDirection.copy(this.sunDirection);
    lighting.keyDirection.copy(this.lightDirection);
    lighting.sunColor.setHex(p.sunColor);
    lighting.godrayColor.setHex(p.godrayColor ?? p.sunColor);
    lighting.exposure = p.exposure;
    lighting.contrast = p.contrast;
    lighting.saturation = p.saturation;
    lighting.lift.fromArray(p.lift);
    lighting.gain.fromArray(p.gain);
    lighting.bloom = p.bloom;
    lighting.godray = p.godray;
    lighting.flare = p.flare;
    // Below the horizon there is no disc to shaft or flare from.
    lighting.sunAboveHorizon = THREE.MathUtils.smoothstep(this.sunDirection.y, -0.03, 0.06);
    lighting.version++;

    this.configureShadowCamera(settings.shadowDistance);
    this.updateEnvironment();
  }

  /**
   * (Re)builds the shadow rig for a view distance. With CSM enabled this
   * rebuilds the cascade split; otherwise it refits the single ortho box.
   */
  configureShadowCamera(distance) {
    if (settings.csm) {
      if (this.csm && (this.csm.cascades !== settings.cascades ||
                       this.csm.shadowMapSize !== settings.shadowMapSize)) {
        this._disposeCSM();
      }
      if (this.csm) {
        this.csm.maxFar = distance;
        this.csm.updateFrustums();
        return;
      }
      // Needs the camera — deferred to the first update() call.
      this._csmPending = true;
      return;
    }

    this._disposeCSM();
    const c = this.sun.shadow.camera;
    const half = distance * 0.5;
    c.left = -half; c.right = half;
    c.top = half; c.bottom = -half;
    c.near = 0.5;
    c.far = distance * 3.0;
    c.updateProjectionMatrix();
    this.sun.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
  }

  _createCSM(camera) {
    this._csmPending = false;
    this.csm = new CSM({
      camera,
      parent: this.scene,
      cascades: settings.cascades,
      maxFar: settings.shadowDistance,
      mode: 'practical',
      shadowMapSize: settings.shadowMapSize,
      shadowBias: -0.00018,
      lightDirection: this.lightDirection.clone().negate().normalize(),
      lightIntensity: this.preset.sunIntensity,
      lightNear: 1,
      lightFar: settings.shadowDistance * 6,
      lightMargin: settings.shadowDistance * 1.5,
    });
    this.csm.fade = true;
    for (const l of this.csm.lights) {
      l.color.setHex(this.preset.sunColor);
      l.intensity = this.preset.sunIntensity;
      // Normal-offset scales with cascade size; the far cascades need much
      // more of it or their texels self-shadow into acne stripes.
      l.shadow.normalBias = 0.02;
      l.shadow.camera.updateProjectionMatrix();
    }
    // Far cascades cover far more world per texel — scale their offsets up.
    for (let i = 0; i < this.csm.lights.length; i++) {
      const t = i / Math.max(1, this.csm.lights.length - 1);
      this.csm.lights[i].shadow.normalBias = 0.015 + t * 0.09;
      this.csm.lights[i].shadow.bias = -0.00012 - t * 0.0004;
    }
    this.csm.updateFrustums();
    this.sun.visible = false;
    this.sun.castShadow = false;
    this._patched.clear();
    this._scanCountdown = 0;
  }

  _disposeCSM() {
    if (!this.csm) return;
    for (const m of this._patched) {
      delete m.onBeforeCompile;
      if (m.defines) { delete m.defines.USE_CSM; delete m.defines.CSM_CASCADES; delete m.defines.CSM_FADE; }
      m.needsUpdate = true;
    }
    this._patched.clear();
    this.csm.remove();
    this.csm.dispose();
    this.csm = null;
    this.sun.visible = true;
    this.sun.castShadow = true;
  }

  /**
   * Materials appear over the lifetime of the level (props, enemies, decals),
   * so the CSM shader injection and the shared aerial-perspective uniforms
   * have to be applied lazily rather than once at startup.
   */
  _scanMaterials() {
    const self = this;
    this.scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      for (const mat of list) {
        if (self._patched.has(mat) || mat === self.sky.material) continue;
        self._patched.add(mat);
        if (self.csm && mat.isMeshStandardMaterial) self.csm.setupMaterial(mat);
        const prev = mat.onBeforeCompile;
        mat.onBeforeCompile = function (shader, renderer) {
          if (prev) prev.call(this, shader, renderer);
          // Share the uniform *objects* so one write updates every material.
          for (const k in aerialUniforms) shader.uniforms[k] = aerialUniforms[k];
        };
        mat.needsUpdate = true;
      }
    });
  }

  /** Re-renders the sky into the PMREM environment probe. */
  updateEnvironment() {
    if (this.envRT) this.envRT.dispose();
    // Sky is a huge box; render it from a temporary scene so nothing else
    // leaks into the probe.
    const probeScene = new THREE.Scene();
    const skyClone = this.sky;
    const prevParent = skyClone.parent;
    probeScene.add(skyClone);
    this.envRT = this.pmrem.fromScene(probeScene, 0.04);
    if (prevParent) prevParent.add(skyClone);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = this.preset.ambient;
  }

  /**
   * Per-frame: refit shadows to the camera and keep the shared shader
   * uniforms current.
   */
  update(camera) {
    if (settings.csm && !this.csm && this._csmPending !== false) {
      this._createCSM(camera);
    }

    if (this.csm) {
      if (this.csm.camera !== camera) this.csm.camera = camera;
      this.csm.update();
      this.csm.updateUniforms?.();
    } else {
      const target = this._t ??= new THREE.Vector3();
      const fwd = this._f ??= new THREE.Vector3();
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() > 1e-6) fwd.normalize();
      target.copy(camera.position).addScaledVector(fwd, settings.shadowDistance * 0.28);
      const texelWorld = settings.shadowDistance / settings.shadowMapSize;
      target.x = Math.round(target.x / texelWorld) * texelWorld;
      target.z = Math.round(target.z / texelWorld) * texelWorld;
      target.y = 0;
      this.sun.target.position.copy(target);
      this.sun.position.copy(target).addScaledVector(this.lightDirection, settings.shadowDistance * 1.4);
      this.sun.target.updateMatrixWorld();
      this.sun.updateMatrixWorld();
    }

    // Keep the sky box centred on the camera so it never clips.
    this.sky.position.set(camera.position.x, 0, camera.position.z);

    if (--this._scanCountdown <= 0) {
      this._scanCountdown = 20;
      this._scanMaterials();
    }
  }

  dispose() {
    this._disposeCSM();
    if (this.envRT) this.envRT.dispose();
    this.pmrem.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
  }
}

/** Unit vector from elevation/azimuth in degrees. */
function dirFromAngles(out, elevationDeg, azimuthDeg) {
  const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  return out.setFromSphericalCoords(1, phi, theta);
}
