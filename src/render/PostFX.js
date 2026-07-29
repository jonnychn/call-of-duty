import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { settings } from '../core/Settings.js';

// ---------------------------------------------------------------------------
// Post chain:
//   scene -> GTAO -> bloom -> tonemap/sRGB (OutputPass) -> grade -> AA
// GTAO and bloom operate in HDR; the grade pass runs in display space where
// grain, vignette and chromatic aberration behave the way a real lens does.
// ---------------------------------------------------------------------------

/**
 * Final grade: chromatic aberration, lens dirt bloom bleed, vignette,
 * film grain, and a light unsharp mask to restore micro-contrast lost to AA.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDirt: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
    aberration: { value: 0.0016 },
    vignette: { value: 0.34 },
    grain: { value: 0.03 },
    sharpen: { value: 0.35 },
    dirtAmount: { value: 0.35 },
    exposureBias: { value: 1.0 },
    saturation: { value: 1.04 },
    lift: { value: new THREE.Vector3(0.004, 0.006, 0.012) },
    gain: { value: new THREE.Vector3(1.02, 1.00, 0.97) },
    flash: { value: 0.0 },
    damage: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tDirt;
    uniform vec2 resolution;
    uniform float time;
    uniform float aberration;
    uniform float vignette;
    uniform float grain;
    uniform float sharpen;
    uniform float dirtAmount;
    uniform float exposureBias;
    uniform float saturation;
    uniform vec3 lift;
    uniform vec3 gain;
    uniform float flash;
    uniform float damage;
    varying vec2 vUv;

    float hash13(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.yzx + 33.33);
      return fract((p.x + p.y) * p.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;
      float r2 = dot(centred, centred);

      // Lateral chromatic aberration grows toward the frame edge, as in a
      // real lens — zero in the centre so the crosshair stays crisp.
      float ca = aberration * (0.25 + r2 * 3.0);
      vec2 dir = normalize(centred + 1e-6);
      vec3 col;
      col.r = texture2D(tDiffuse, uv - dir * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + dir * ca).b;

      // Unsharp mask against a 4-tap box blur.
      if (sharpen > 0.001) {
        vec2 px = 1.0 / resolution;
        vec3 blur =
          texture2D(tDiffuse, uv + vec2( px.x, 0.0)).rgb +
          texture2D(tDiffuse, uv + vec2(-px.x, 0.0)).rgb +
          texture2D(tDiffuse, uv + vec2(0.0,  px.y)).rgb +
          texture2D(tDiffuse, uv + vec2(0.0, -px.y)).rgb;
        blur *= 0.25;
        col += (col - blur) * sharpen;
      }

      col *= exposureBias;

      // Lens dirt picks up highlights that already bloomed.
      if (dirtAmount > 0.001) {
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        vec3 dirt = texture2D(tDirt, uv).rgb;
        col += dirt * dirtAmount * smoothstep(0.65, 1.6, lum) * 0.9;
      }

      // Lift/gain grade — a subtle cool shadow, warm highlight split.
      col = col * gain + lift;

      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, saturation);

      // Muzzle/explosion flash and the red damage wash.
      col += vec3(1.0, 0.92, 0.78) * flash;
      col = mix(col, vec3(lum * 0.55, lum * 0.06, lum * 0.05) + vec3(0.22, 0.0, 0.0), damage * 0.55);

      // Natural vignette: cos^4 falloff, not a hard radial ramp.
      float vig = pow(cos(clamp(sqrt(r2) * 1.35, 0.0, 1.5)), 4.0);
      col *= mix(1.0, vig, vignette);

      // Animated grain, stronger in the shadows where sensor noise lives.
      if (grain > 0.0001) {
        float n = hash13(vec3(gl_FragCoord.xy, time * 60.0)) - 0.5;
        col += n * grain * (1.0 - smoothstep(0.0, 0.75, lum));
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/** Procedural lens-dirt: smeared blobs and radial streaks, generated once. */
function makeLensDirt(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  let s = 99991;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 220; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = 3 + Math.pow(rnd(), 3) * 60;
    const a = 0.03 + rnd() * 0.16;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,250,240,${a})`);
    grad.addColorStop(0.5, `rgba(200,215,255,${a * 0.35})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // Wiper-style streaks
  for (let i = 0; i < 40; i++) {
    const y = rnd() * size;
    g.strokeStyle = `rgba(220,230,255,${0.02 + rnd() * 0.05})`;
    g.lineWidth = 1 + rnd() * 6;
    g.beginPath();
    g.moveTo(0, y);
    g.bezierCurveTo(size * 0.3, y + (rnd() - 0.5) * 60, size * 0.7, y + (rnd() - 0.5) * 60, size, y + (rnd() - 0.5) * 40);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
    this.time = 0;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    // Float target keeps HDR headroom for bloom thresholding.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(renderer.getPixelRatio());

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.gtao = new GTAOPass(scene, camera, size.x, size.y);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.updateGtaoMaterial({
      radius: 0.42,
      distanceExponent: 1.2,
      thickness: 1.0,
      scale: 1.0,
      samples: Math.max(8, Math.round(settings.ssaoSamples / 2)),
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    });
    this.gtao.blendIntensity = 0.95;
    this.gtao.enabled = settings.ssao;
    this.composer.addPass(this.gtao);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      settings.bloomStrength,
      0.62,            // radius
      settings.bloomThreshold,
    );
    this.bloom.enabled = settings.bloom;
    this.composer.addPass(this.bloom);

    // Viewmodel is composited after AO (which only makes sense for world
    // geometry) but before bloom, so muzzle flashes and the optic dot bloom.
    this.viewmodelPass = null;

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this.dirt = makeLensDirt(512);
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.tDirt.value = this.dirt;
    this.composer.addPass(this.grade);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this.applySettings();
    this.setSize(size.x, size.y);
  }

  /**
   * Composites a separate scene (the weapon viewmodel) over the world with a
   * cleared depth buffer, so the gun can never intersect level geometry.
   */
  attachViewmodel(scene, camera) {
    const pass = new RenderPass(scene, camera);
    pass.clear = false;
    pass.clearDepth = true;
    this.viewmodelPass = pass;
    const idx = this.composer.passes.indexOf(this.bloom);
    this.composer.insertPass(pass, idx < 0 ? this.composer.passes.length : idx);
    return pass;
  }

  applySettings() {
    const u = this.grade.uniforms;
    u.aberration.value = settings.chromaticAberration;
    u.vignette.value = settings.vignette;
    u.grain.value = settings.filmGrain;
    u.sharpen.value = settings.sharpen;
    u.dirtAmount.value = settings.lensDirt;
    this.bloom.enabled = settings.bloom;
    this.bloom.strength = settings.bloomStrength;
    this.bloom.threshold = settings.bloomThreshold;
    this.gtao.enabled = settings.ssao;
    this.gtao.updateGtaoMaterial({ samples: Math.max(8, Math.round(settings.ssaoSamples / 2)) });
  }

  /** Brief white flash — explosions, flashbangs, close muzzle blast. */
  setFlash(v) { this.grade.uniforms.flash.value = v; }
  /** Red damage wash, 0..1. */
  setDamage(v) { this.grade.uniforms.damage.value = v; }

  setSize(w, h) {
    this.composer.setSize(w, h);
    this.gtao.setSize(w, h);
    this.bloom.setSize(w, h);
    const dpr = this.renderer.getPixelRatio();
    this.grade.uniforms.resolution.value.set(w * dpr, h * dpr);
  }

  render(dt) {
    this.time += dt;
    this.grade.uniforms.time.value = this.time;
    if (this.enabled) {
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose() {
    this.composer.dispose();
    this.dirt.dispose();
  }
}
