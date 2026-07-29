import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { settings } from '../core/Settings.js';
import { lighting } from './LightingState.js';

// ---------------------------------------------------------------------------
// Post chain:
//   scene -> GTAO -> viewmodel -> god rays -> bloom -> [luminance probe]
//         -> tonemap + grade -> SMAA
//
// Everything up to the tonemap runs in scene-referred HDR (half-float, no
// colour space). The tonemap pass is where the frame becomes an image: it
// owns exposure, the film curve, the grade, the lens, and the sRGB encode.
// three's OutputPass is deliberately *not* used — ACES with a fixed exposure
// is exactly what made the original frames sit in a mid-grey band, and the
// shoulder/toe have to be art-directable per time of day.
// ---------------------------------------------------------------------------

const NEUTRAL_RT = {
  type: THREE.HalfFloatType,
  colorSpace: THREE.NoColorSpace,
  depthBuffer: false,
  stencilBuffer: false,
};

// --- shared GLSL -----------------------------------------------------------

const LUMA = /* glsl */`
  float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
`;

// ---------------------------------------------------------------------------
// God rays. Screen-space radial march from the sun's projected position over
// a luminance-thresholded copy of the frame: anything solid between the
// camera and the sky punches a hole in the shafts for free, so the rays
// automatically respect the silhouette of the level.
// ---------------------------------------------------------------------------

class GodRayPass extends Pass {
  constructor(width, height, steps) {
    super();
    this.needsSwap = true;
    this.steps = Math.max(8, Math.min(64, steps | 0));

    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.rtA = new THREE.WebGLRenderTarget(w, h, NEUTRAL_RT);
    this.rtB = new THREE.WebGLRenderTarget(w, h, NEUTRAL_RT);

    this.maskMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        sunUV: { value: new THREE.Vector2(0.5, 0.5) },
        aspect: { value: 1.0 },
        threshold: { value: 0.7 },
        falloff: { value: 1.35 },
      },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 sunUV;
        uniform float aspect;
        uniform float threshold;
        uniform float falloff;
        varying vec2 vUv;
        ${LUMA}
        void main() {
          vec3 c = texture2D( tDiffuse, vUv ).rgb;
          float l = luma( c );
          // Only genuinely bright things (sky, the disc, muzzle flashes) seed
          // shafts. Everything else is an occluder.
          float m = smoothstep( threshold, threshold * 2.2, l );
          // Rays fade with angular distance from the sun so the whole frame
          // does not smear.
          vec2 d = ( vUv - sunUV ) * vec2( aspect, 1.0 );
          m *= exp( - dot( d, d ) * falloff );
          gl_FragColor = vec4( c * m, 1.0 );
        }
      `,
      depthTest: false, depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      defines: { STEPS: this.steps >> 1 },
      uniforms: {
        tDiffuse: { value: null },
        sunUV: { value: new THREE.Vector2(0.5, 0.5) },
        density: { value: 0.85 },
        decay: { value: 0.96 },
        weight: { value: 1.0 },
        stride: { value: 1.0 },
      },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 sunUV;
        uniform float density;
        uniform float decay;
        uniform float weight;
        uniform float stride;
        varying vec2 vUv;
        void main() {
          vec2 delta = ( vUv - sunUV ) * ( density / float( STEPS ) ) * stride;
          vec2 uv = vUv;
          vec3 acc = vec3( 0.0 );
          float illum = 1.0;
          float norm = 0.0;
          for ( int i = 0; i < STEPS; i ++ ) {
            uv -= delta;
            acc += texture2D( tDiffuse, uv ).rgb * illum;
            norm += illum;
            illum *= decay;
          }
          gl_FragColor = vec4( acc / max( norm, 1e-4 ) * weight, 1.0 );
        }
      `,
      depthTest: false, depthWrite: false,
    });

    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tRays: { value: null },
        strength: { value: 1.0 },
        tint: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tRays;
        uniform float strength;
        uniform vec3 tint;
        varying vec2 vUv;
        void main() {
          vec3 base = texture2D( tDiffuse, vUv ).rgb;
          vec3 rays = texture2D( tRays, vUv ).rgb;
          gl_FragColor = vec4( base + rays * tint * strength, 1.0 );
        }
      `,
      depthTest: false, depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.maskMat);
  }

  setSteps(steps) {
    const s = Math.max(8, Math.min(64, steps | 0));
    if (s === this.steps) return;
    this.steps = s;
    this.blurMat.defines.STEPS = s >> 1;
    this.blurMat.needsUpdate = true;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.maskMat.uniforms.aspect.value = width / Math.max(1, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    const strength = this.compMat.uniforms.strength.value;
    if (strength <= 0.001) {
      // Nothing to add; blit through so the chain stays consistent.
      this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.compMat.uniforms.tRays.value = this.rtB.texture;
      this.quad.material = this.compMat;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.quad.render(renderer);
      return;
    }

    this.maskMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.maskMat;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);

    // Two iterations: the second picks up where the first left off (stride
    // multiplied by the step count), which buys long shafts for half the taps.
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
    this.blurMat.uniforms.stride.value = 1.0;
    renderer.setRenderTarget(this.rtB);
    this.quad.render(renderer);

    this.blurMat.uniforms.tDiffuse.value = this.rtB.texture;
    this.blurMat.uniforms.stride.value = this.steps >> 1;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);

    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.compMat.uniforms.tRays.value = this.rtA.texture;
    this.quad.material = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  get rays() { return this.rtA.texture; }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose();
    this.maskMat.dispose(); this.blurMat.dispose(); this.compMat.dispose();
    this.quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Eye adaptation. A 64x64 log-luminance reduction (free mip chain) feeding a
// 1x1 ping-pong that smooths over time. Deliberately clamped to about a stop
// either side: this is a stabiliser for muzzle flashes and stepping out of an
// alley, not an auto-exposure that overrides the time-of-day key.
// ---------------------------------------------------------------------------

const LOG_MIN = -10.0, LOG_RANGE = 20.0;

class ExposurePass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.enabled = true;

    const nearest = {
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    };
    // 32x32 log-luminance, then a single 64-tap gather down to 1x1. No
    // mipmaps: generateMipmap on a float target is the kind of thing that
    // works on one driver and not the next.
    this.lumRT = new THREE.WebGLRenderTarget(32, 32, {
      ...nearest, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.rtRead = new THREE.WebGLRenderTarget(1, 1, nearest);
    this.rtWrite = new THREE.WebGLRenderTarget(1, 1, nearest);
    this.latest = this.rtWrite.texture;

    this.lumMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        ${LUMA}
        void main() {
          vec3 c = texture2D( tDiffuse, vUv ).rgb;
          float l = log2( max( luma( c ), 1e-4 ) );
          // Centre-weighted: metering off a bright sky at the top of frame
          // is how you end up with a black scene.
          float w = 1.0 - 0.65 * clamp( length( vUv - 0.5 ) * 1.9, 0.0, 1.0 );
          gl_FragColor = vec4( ( l - ( ${LOG_MIN.toFixed(1)} ) ) / ${LOG_RANGE.toFixed(1)} * w, w, 0.0, 1.0 );
        }
      `,
      depthTest: false, depthWrite: false,
    });

    this.adaptMat = new THREE.ShaderMaterial({
      uniforms: {
        tLum: { value: this.lumRT.texture },
        tPrev: { value: null },
        rate: { value: 0.1 },
        reset: { value: 1.0 },
      },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        uniform sampler2D tLum;
        uniform sampler2D tPrev;
        uniform float rate;
        uniform float reset;
        varying vec2 vUv;
        void main() {
          // 8x8 bilinear gather over the 32x32 map: every texel contributes.
          vec2 acc = vec2( 0.0 );
          for ( int y = 0; y < 8; y ++ ) {
            for ( int x = 0; x < 8; x ++ ) {
              vec2 uv = ( vec2( float( x ), float( y ) ) * 4.0 + 2.0 ) / 32.0;
              acc += texture2D( tLum, uv ).xy;
            }
          }
          float cur = acc.x / max( acc.y, 1e-4 );
          float prev = texture2D( tPrev, vec2( 0.5 ) ).x;
          float v = mix( prev, cur, clamp( rate, 0.0, 1.0 ) );
          gl_FragColor = vec4( mix( v, cur, reset ), 0.0, 0.0, 1.0 );
        }
      `,
      depthTest: false, depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.lumMat);
    this._first = true;
  }

  /** @returns {THREE.Texture} 1x1 holding the smoothed normalised log-luminance. */
  get result() { return this.latest; }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    this.lumMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.lumMat;
    renderer.setRenderTarget(this.lumRT);
    this.quad.render(renderer);

    this.adaptMat.uniforms.tPrev.value = this.rtRead.texture;
    this.adaptMat.uniforms.rate.value =
      1 - Math.exp(-settings.exposureAdaptSpeed * Math.max(deltaTime || 0.016, 1e-3));
    this.adaptMat.uniforms.reset.value = this._first ? 1 : 0;
    this._first = false;
    this.quad.material = this.adaptMat;
    renderer.setRenderTarget(this.rtWrite);
    this.quad.render(renderer);

    this.latest = this.rtWrite.texture;
    const t = this.rtRead; this.rtRead = this.rtWrite; this.rtWrite = t;
  }

  dispose() {
    this.lumRT.dispose(); this.rtRead.dispose(); this.rtWrite.dispose();
    this.lumMat.dispose(); this.adaptMat.dispose(); this.quad.dispose();
  }
}

const QUAD_VS = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

// ---------------------------------------------------------------------------
// Tonemap + grade + lens. The only pass that writes display-referred pixels.
// ---------------------------------------------------------------------------

const TonemapShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDirt: { value: null },
    tAdapt: { value: null },
    tRays: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },

    exposure: { value: 1.0 },
    autoExposure: { value: 0.0 },
    adaptMin: { value: -0.55 },
    adaptMax: { value: 0.55 },

    A: { value: 0.24 }, B: { value: 0.28 }, C: { value: 0.12 },
    D: { value: 0.28 }, E: { value: 0.012 }, F: { value: 0.26 },
    whitePoint: { value: 9.5 },
    contrast: { value: 1.12 },
    highlightDesat: { value: 0.55 },

    saturation: { value: 1.02 },
    lift: { value: new THREE.Vector3(0.003, 0.005, 0.012) },
    gain: { value: new THREE.Vector3(1.02, 1.0, 0.98) },

    sunUV: { value: new THREE.Vector2(0.5, 0.5) },
    sunOnScreen: { value: 0.0 },
    flare: { value: 0.8 },
    flareTint: { value: new THREE.Color(1, 0.85, 0.6) },

    aberration: { value: 0.0009 },
    vignette: { value: 0.42 },
    grain: { value: 0.026 },
    sharpen: { value: 0.30 },
    dirtAmount: { value: 0.22 },
    flash: { value: 0.0 },
    damage: { value: 0.0 },
  },
  vertexShader: QUAD_VS,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tDirt;
    uniform sampler2D tAdapt;
    uniform sampler2D tRays;
    uniform vec2 resolution;
    uniform float time;

    uniform float exposure;
    uniform float autoExposure;
    uniform float adaptMin;
    uniform float adaptMax;

    uniform float A, B, C, D, E, F;
    uniform float whitePoint;
    uniform float contrast;
    uniform float highlightDesat;

    uniform float saturation;
    uniform vec3 lift;
    uniform vec3 gain;

    uniform vec2 sunUV;
    uniform float sunOnScreen;
    uniform float flare;
    uniform vec3 flareTint;

    uniform float aberration;
    uniform float vignette;
    uniform float grain;
    uniform float sharpen;
    uniform float dirtAmount;
    uniform float flash;
    uniform float damage;
    varying vec2 vUv;

    ${LUMA}

    float hash13( vec3 p ) {
      p = fract( p * 0.1031 );
      p += dot( p, p.yzx + 33.33 );
      return fract( ( p.x + p.y ) * p.z );
    }

    // Hable's filmic curve with the shoulder/toe exposed. Compared with ACES
    // this keeps more of the toe (deeper, cleaner blacks) and rolls the
    // shoulder off later, which is what puts real separation between a
    // sunlit wall and the sky behind it.
    vec3 filmic( vec3 x ) {
      return ( ( x * ( A * x + C * B ) + D * E ) / ( x * ( A * x + B ) + D * F ) ) - E / F;
    }

    vec3 toSRGB( vec3 c ) {
      c = clamp( c, 0.0, 1.0 );
      return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;
      float r2 = dot( centred, centred );

      // Lateral chromatic aberration grows toward the frame edge, zero in the
      // centre so the crosshair stays crisp.
      float ca = aberration * ( 0.25 + r2 * 3.0 );
      vec2 dir = normalize( centred + 1e-6 );
      vec3 col;
      col.r = texture2D( tDiffuse, uv - dir * ca ).r;
      col.g = texture2D( tDiffuse, uv ).g;
      col.b = texture2D( tDiffuse, uv + dir * ca ).b;

      // ---- lens veiling + ghosts (scene-referred, so they tonemap) --------
      if ( flare > 0.001 && sunOnScreen > 0.001 ) {
        float aspect = resolution.x / max( resolution.y, 1.0 );
        // How much of the disc actually reaches the lens, read straight off
        // the god-ray buffer: occluded sun -> no flare, for free.
        float occ = clamp( luma( texture2D( tRays, sunUV ).rgb ) * 1.6, 0.0, 1.0 );
        float amt = flare * sunOnScreen * occ;

        vec2 d = ( uv - sunUV ) * vec2( aspect, 1.0 );
        float dd = dot( d, d );
        // Broad veiling glare — the haze inside the lens barrel.
        col += flareTint * amt * 0.16 * exp( -dd * 5.0 );
        col += flareTint * amt * 0.42 * exp( -dd * 90.0 );

        // A short, deliberately restrained ghost chain along the optical axis.
        vec2 axis = ( vec2( 0.5 ) - sunUV );
        for ( int i = 0; i < 3; i ++ ) {
          float fi = float( i );
          vec2 g = sunUV + axis * ( 0.85 + fi * 0.72 );
          vec2 gd = ( uv - g ) * vec2( aspect, 1.0 );
          float gr = length( gd );
          float radius = 0.035 + fi * 0.028;
          // Thin annulus, not a filled blob.
          float ring = smoothstep( radius, radius * 0.72, gr ) * smoothstep( radius * 0.45, radius * 0.7, gr );
          vec3 tint = i == 0 ? vec3( 0.45, 0.62, 1.0 )
                    : i == 1 ? vec3( 1.0, 0.72, 0.42 )
                             : vec3( 0.62, 1.0, 0.72 );
          col += tint * ring * amt * 0.055;
        }
      }

      // ---- exposure -------------------------------------------------------
      float ev = 0.0;
      if ( autoExposure > 0.5 ) {
        float logAvg = texture2D( tAdapt, vec2( 0.5 ) ).x * ${LOG_RANGE.toFixed(1)} + ( ${LOG_MIN.toFixed(1)} );
        // Pull toward an 18% grey key, then clamp hard.
        ev = clamp( log2( 0.18 ) - logAvg, adaptMin, adaptMax );
      }
      col *= exposure * exp2( ev );

      // Highlight desaturation: real film and real sensors go to white, not
      // to a clipped hue.
      float mx = max( col.r, max( col.g, col.b ) );
      col = mix( col, vec3( mx ), highlightDesat * smoothstep( 1.0, 7.0, mx ) );

      // Contrast about 18% grey, in log space, before the curve.
      vec3 lg = log2( max( col, 1e-5 ) );
      col = exp2( ( lg - log2( 0.18 ) ) * contrast + log2( 0.18 ) );

      // ---- film curve -----------------------------------------------------
      col = filmic( col * 2.0 ) / filmic( vec3( whitePoint ) );

      // ---- display-referred grade ----------------------------------------
      if ( dirtAmount > 0.001 ) {
        vec3 dirt = texture2D( tDirt, uv ).rgb;
        col += dirt * dirtAmount * smoothstep( 0.62, 1.0, luma( col ) ) * 0.8;
      }

      col = col * gain + lift;

      float lum = luma( col );
      col = mix( vec3( lum ), col, saturation );

      // Unsharp mask, computed on normalised HDR luminance so the halo
      // strength does not depend on where the pixel sits on the curve.
      if ( sharpen > 0.001 ) {
        vec2 px = 1.0 / resolution;
        float l0 = luma( texture2D( tDiffuse, uv ).rgb );
        float lb = 0.25 * (
          luma( texture2D( tDiffuse, uv + vec2(  px.x, 0.0 ) ).rgb ) +
          luma( texture2D( tDiffuse, uv + vec2( -px.x, 0.0 ) ).rgb ) +
          luma( texture2D( tDiffuse, uv + vec2( 0.0,  px.y ) ).rgb ) +
          luma( texture2D( tDiffuse, uv + vec2( 0.0, -px.y ) ).rgb ) );
        float d = ( l0 - lb ) / max( l0 + lb, 1e-3 );
        col *= 1.0 + clamp( d, -0.5, 0.5 ) * sharpen * 1.3;
      }

      col += vec3( 1.0, 0.92, 0.78 ) * flash;
      col = mix( col, vec3( lum * 0.55, lum * 0.06, lum * 0.05 ) + vec3( 0.22, 0.0, 0.0 ), damage * 0.55 );

      // Natural vignette: cos^4 falloff, not a hard radial ramp.
      float vig = pow( cos( clamp( sqrt( r2 ) * 1.35, 0.0, 1.5 ) ), 4.0 );
      col *= mix( 1.0, vig, vignette );

      // Animated grain, stronger in the shadows where sensor noise lives.
      if ( grain > 0.0001 ) {
        float n = hash13( vec3( gl_FragCoord.xy, time * 60.0 ) ) - 0.5;
        col += n * grain * ( 1.0 - smoothstep( 0.0, 0.7, luma( col ) ) );
      }

      gl_FragColor = vec4( toSRGB( col ), 1.0 );
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

const _sunWorld = new THREE.Vector3();

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

    // The tonemap pass owns tone mapping now; leaving it on the renderer
    // would double-apply it to anything drawn straight to the canvas.
    renderer.toneMapping = THREE.NoToneMapping;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

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
      radius: 0.5,
      distanceExponent: 1.4,
      thickness: 1.0,
      scale: 1.35,
      samples: Math.max(8, Math.round(settings.ssaoSamples / 2)),
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    });
    this.gtao.blendIntensity = 1.0;
    this.gtao.enabled = settings.ssao;
    this.composer.addPass(this.gtao);

    // Viewmodel is composited after AO (which only makes sense for world
    // geometry) but before god rays and bloom, so the gun occludes shafts and
    // muzzle flashes bloom.
    this.viewmodelPass = null;

    this.godrays = new GodRayPass(size.x, size.y, settings.volumetricSteps);
    this.godrays.enabled = settings.volumetrics;
    this.composer.addPass(this.godrays);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      settings.bloomStrength,
      0.75,            // radius
      settings.bloomThreshold,
    );
    this.bloom.enabled = settings.bloom;
    this.composer.addPass(this.bloom);

    this.exposurePass = new ExposurePass();
    this.exposurePass.enabled = settings.autoExposure;
    this.composer.addPass(this.exposurePass);

    this.dirt = makeLensDirt(512);
    this.tonemap = new ShaderPass(TonemapShader);
    this.tonemap.uniforms.tDirt.value = this.dirt;
    this.tonemap.uniforms.tAdapt.value = this.exposurePass.result;
    this.tonemap.uniforms.tRays.value = this.godrays.rays;
    this.composer.addPass(this.tonemap);
    // Backwards-compatible alias: HUD/FX poke `grade` for flash and damage.
    this.grade = this.tonemap;

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this._lightingVersion = -1;
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
    const idx = this.composer.passes.indexOf(this.godrays);
    this.composer.insertPass(pass, idx < 0 ? this.composer.passes.length : idx);
    return pass;
  }

  applySettings() {
    const u = this.tonemap.uniforms;
    u.aberration.value = settings.chromaticAberration;
    u.vignette.value = settings.vignette;
    u.grain.value = settings.filmGrain;
    u.sharpen.value = settings.sharpen;
    u.dirtAmount.value = settings.lensDirt;

    const t = settings.tone;
    u.A.value = t.shoulderStrength;
    u.B.value = t.linearStrength;
    u.C.value = t.linearAngle;
    u.D.value = t.toeStrength;
    u.E.value = t.toeNumerator;
    u.F.value = t.toeDenominator;
    u.whitePoint.value = t.whitePoint;
    u.highlightDesat.value = t.highlightDesat;
    u.adaptMin.value = settings.exposureAdaptMin;
    u.adaptMax.value = settings.exposureAdaptMax;
    u.autoExposure.value = settings.autoExposure ? 1 : 0;

    this.bloom.enabled = settings.bloom;
    this.bloom.threshold = settings.bloomThreshold;
    this.gtao.enabled = settings.ssao;
    this.gtao.updateGtaoMaterial({ samples: Math.max(8, Math.round(settings.ssaoSamples / 2)) });
    this.godrays.enabled = settings.volumetrics;
    this.godrays.setSteps(settings.volumetricSteps);
    this.exposurePass.enabled = settings.autoExposure;
    this._lightingVersion = -1; // force a re-pull of the time-of-day grade
  }

  /** Pulls exposure/grade/god-ray authoring from the current time of day. */
  _syncLighting() {
    if (this._lightingVersion === lighting.version) return;
    this._lightingVersion = lighting.version;
    const u = this.tonemap.uniforms;
    u.exposure.value = lighting.exposure * settings.exposure;
    u.contrast.value = lighting.contrast * settings.tone.contrast;
    u.saturation.value = lighting.saturation;
    u.lift.value.copy(lighting.lift);
    u.gain.value.copy(lighting.gain);
    u.flareTint.value.copy(lighting.godrayColor);
    this.bloom.strength = settings.bloomStrength * (lighting.bloom / 0.34);
    this.godrays.compMat.uniforms.tint.value.copy(lighting.godrayColor);
  }

  /** Projects the sun to screen space for god rays and the flare. */
  _updateSun() {
    const cam = this.camera;
    _sunWorld.copy(lighting.sunDirection).multiplyScalar(8000).add(cam.position);
    _sunWorld.project(cam);
    const behind = _sunWorld.z > 1 || _sunWorld.z < -1;
    const uvx = _sunWorld.x * 0.5 + 0.5;
    const uvy = _sunWorld.y * 0.5 + 0.5;

    // Fade out as the disc leaves the frame instead of popping.
    const edge = Math.max(Math.abs(_sunWorld.x), Math.abs(_sunWorld.y));
    let onScreen = behind ? 0 : THREE.MathUtils.clamp(1.6 - edge * 1.1, 0, 1);
    onScreen *= lighting.sunAboveHorizon;

    this.godrays.maskMat.uniforms.sunUV.value.set(uvx, uvy);
    this.godrays.blurMat.uniforms.sunUV.value.set(uvx, uvy);
    this.godrays.compMat.uniforms.strength.value =
      settings.godrayStrength * lighting.godray * onScreen * 0.55;

    const u = this.tonemap.uniforms;
    u.sunUV.value.set(uvx, uvy);
    u.sunOnScreen.value = onScreen;
    u.flare.value = settings.flareStrength * lighting.flare;
  }

  /** Brief white flash — explosions, flashbangs, close muzzle blast. */
  setFlash(v) { this.tonemap.uniforms.flash.value = v; }
  /** Red damage wash, 0..1. */
  setDamage(v) { this.tonemap.uniforms.damage.value = v; }

  setSize(w, h) {
    this.composer.setSize(w, h);
    this.gtao.setSize(w, h);
    this.bloom.setSize(w, h);
    this.godrays.setSize(w, h);
    const dpr = this.renderer.getPixelRatio();
    this.tonemap.uniforms.resolution.value.set(w * dpr, h * dpr);
  }

  render(dt) {
    this.time += dt;
    this.tonemap.uniforms.time.value = this.time;
    this._syncLighting();
    this._updateSun();
    this.tonemap.uniforms.tAdapt.value = this.exposurePass.result;
    this.tonemap.uniforms.tRays.value = this.godrays.rays;
    if (this.enabled) {
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose() {
    this.composer.dispose();
    this.godrays.dispose();
    this.exposurePass.dispose();
    this.dirt.dispose();
  }
}
