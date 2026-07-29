import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { settings } from '../core/Settings.js';

// ---------------------------------------------------------------------------
// Sky, sun, and image-based lighting. The Preetham sky is rendered once into a
// PMREM cubemap that becomes the scene environment, so every PBR surface gets
// physically consistent ambient and specular response from the same sky the
// player sees.
// ---------------------------------------------------------------------------

/** Time-of-day presets. Elevation/azimuth in degrees. */
export const TIME_OF_DAY = {
  dawn:      { elevation: 4.5,  azimuth: 100, turbidity: 6.0, rayleigh: 2.6, mieCoefficient: 0.010, mieG: 0.86, sunIntensity: 3.6, sunColor: 0xffb27a, ambient: 0.55, fogColor: 0xc9a58b, fogDensity: 0.0028 },
  morning:   { elevation: 22,   azimuth: 130, turbidity: 4.0, rayleigh: 2.0, mieCoefficient: 0.006, mieG: 0.82, sunIntensity: 5.0, sunColor: 0xffe4c4, ambient: 0.70, fogColor: 0xbcc6cf, fogDensity: 0.0018 },
  noon:      { elevation: 62,   azimuth: 180, turbidity: 3.0, rayleigh: 1.4, mieCoefficient: 0.004, mieG: 0.80, sunIntensity: 6.2, sunColor: 0xfff4e2, ambient: 0.85, fogColor: 0xc4cfd8, fogDensity: 0.0012 },
  afternoon: { elevation: 28,   azimuth: 236, turbidity: 5.0, rayleigh: 2.2, mieCoefficient: 0.007, mieG: 0.84, sunIntensity: 5.4, sunColor: 0xffd9a0, ambient: 0.66, fogColor: 0xc8b499, fogDensity: 0.0020 },
  dusk:      { elevation: 2.0,  azimuth: 268, turbidity: 8.0, rayleigh: 3.2, mieCoefficient: 0.016, mieG: 0.88, sunIntensity: 3.0, sunColor: 0xff8a4a, ambient: 0.42, fogColor: 0xb4795a, fogDensity: 0.0034 },
  night:     { elevation: -8,   azimuth: 300, turbidity: 10,  rayleigh: 0.6, mieCoefficient: 0.004, mieG: 0.80, sunIntensity: 0.35, sunColor: 0x8ea6d0, ambient: 0.18, fogColor: 0x1a2233, fogDensity: 0.0042 },
};

export class Atmosphere {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.sunDirection = new THREE.Vector3();

    this.sky = new Sky();
    this.sky.scale.setScalar(45000);
    this.sky.name = 'Sky';
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.name = 'Sun';
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.camera.near = 0.5;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Hemisphere fill approximates sky/ground bounce that a single PMREM
    // probe misses in enclosed areas.
    this.hemi = new THREE.HemisphereLight(0xbfd4ee, 0x6b5a45, 0.4);
    scene.add(this.hemi);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envRT = null;

    this.preset = null;
    this.apply('afternoon');
  }

  /** @param {keyof TIME_OF_DAY | object} preset */
  apply(preset) {
    const p = typeof preset === 'string' ? TIME_OF_DAY[preset] : preset;
    if (!p) throw new Error(`Unknown time-of-day "${preset}"`);
    this.preset = p;
    this.presetName = typeof preset === 'string' ? preset : 'custom';

    const u = this.sky.material.uniforms;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = p.mieCoefficient;
    u.mieDirectionalG.value = p.mieG;

    const phi = THREE.MathUtils.degToRad(90 - p.elevation);
    const theta = THREE.MathUtils.degToRad(p.azimuth);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDirection);

    this.sun.position.copy(this.sunDirection).multiplyScalar(300);
    this.sun.target.position.set(0, 0, 0);
    this.sun.intensity = p.sunIntensity;
    this.sun.color.setHex(p.sunColor);

    this.hemi.intensity = p.ambient * 0.5;
    this.hemi.color.setHex(p.fogColor);

    this.scene.fog = new THREE.FogExp2(p.fogColor, p.fogDensity);

    this.configureShadowCamera(settings.shadowDistance);
    this.updateEnvironment();
  }

  /** Fits the sun's orthographic shadow frustum to a view distance. */
  configureShadowCamera(distance) {
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
   * Keeps the shadow frustum centred ahead of the camera so the limited
   * shadow map resolution is spent where the player is actually looking.
   */
  update(camera) {
    const target = this._t ??= new THREE.Vector3();
    const fwd = this._f ??= new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) fwd.normalize();
    target.copy(camera.position).addScaledVector(fwd, settings.shadowDistance * 0.28);
    // Snap to texel grid to stop shadow edges from crawling as the player moves.
    const texelWorld = settings.shadowDistance / settings.shadowMapSize;
    target.x = Math.round(target.x / texelWorld) * texelWorld;
    target.z = Math.round(target.z / texelWorld) * texelWorld;
    target.y = 0;

    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDirection, settings.shadowDistance * 1.4);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }

  dispose() {
    if (this.envRT) this.envRT.dispose();
    this.pmrem.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
  }
}
