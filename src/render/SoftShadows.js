import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Contact-hardening (PCSS) shadows.
//
// three's PCF_SOFT filter is a fixed 3x3-ish kernel: every shadow in the frame
// gets the same blur no matter how far the caster is from the receiver. That
// is the specific reason a shadow can read as "ambient darkening" rather than
// as a cast shadow — the edge under a crate is exactly as soft as the edge of
// a rooftop shadow 60 m away, so the eye gets no occluder-distance cue.
//
// PCSS fixes it in two steps:
//   1. Blocker search — average depth of the occluders above this pixel.
//   2. Penumbra estimate — the further the blocker is above the receiver, the
//      wider the filter kernel. Contact points stay razor sharp; a shadow
//      thrown from a roof onto the street goes soft.
//
// Implemented by rewriting three's shadowmap_pars_fragment chunk, so it
// applies to the CSM cascades and to any other shadow-casting light without
// per-material work.
// ---------------------------------------------------------------------------

let patched = false;

/**
 * @param {object} [opts]
 * @param {number} [opts.blockerSamples] taps in the blocker search
 * @param {number} [opts.filterSamples] taps in the variable-width PCF
 * @param {number} [opts.searchRadius] blocker search radius, in texels
 * @param {number} [opts.minRadius] filter radius at zero occluder distance
 * @param {number} [opts.maxRadius] filter radius at full penumbra
 * @param {number} [opts.penumbraScale] how fast depth difference opens the kernel
 */
export function patchSoftShadows(opts = {}) {
  if (patched) return;
  patched = true;

  const blockerSamples = opts.blockerSamples ?? 8;
  const filterSamples = opts.filterSamples ?? 12;
  const searchRadius = opts.searchRadius ?? 9.0;
  const minRadius = opts.minRadius ?? 0.75;
  const maxRadius = opts.maxRadius ?? 7.0;
  const penumbraScale = opts.penumbraScale ?? 90.0;

  const src = THREE.ShaderChunk.shadowmap_pars_fragment;

  const helpers = /* glsl */`

  // --- PCSS ---------------------------------------------------------------
  // Vogel disk rather than a stored Poisson table: no uniform array, no
  // texture, and the sample count is a compile-time constant so the loop
  // unrolls.
  vec2 pcssVogel( int i, int count, float phi ) {
    float fi = float( i ) + 0.5;
    float r = sqrt( fi / float( count ) );
    float theta = fi * 2.39996323 + phi;
    return vec2( cos( theta ), sin( theta ) ) * r;
  }

  float pcssNoise( vec2 co ) {
    return fract( sin( dot( co, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  }

  float getShadowPCSS( sampler2D shadowMap, vec2 shadowMapSize, vec3 shadowCoord ) {
    vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
    // Per-pixel rotation of the sample pattern turns banding into noise,
    // which the temporal AA and the film grain then hide.
    float phi = pcssNoise( gl_FragCoord.xy ) * 6.2831853;

    // 1. blocker search
    float blockerSum = 0.0;
    float blockerCount = 0.0;
    for ( int i = 0; i < ${blockerSamples}; i ++ ) {
      vec2 o = pcssVogel( i, ${blockerSamples}, phi ) * ${searchRadius.toFixed(1)} * texelSize;
      float d = unpackRGBAToDepth( texture2D( shadowMap, shadowCoord.xy + o ) );
      if ( d < shadowCoord.z ) {
        blockerSum += d;
        blockerCount += 1.0;
      }
    }
    if ( blockerCount < 0.5 ) return 1.0; // fully lit, and we skipped the PCF

    // 2. penumbra width from occluder distance
    float avgBlocker = blockerSum / blockerCount;
    float penumbra = clamp( ( shadowCoord.z - avgBlocker ) * ${penumbraScale.toFixed(1)}, 0.0, 1.0 );
    float radius = mix( ${minRadius.toFixed(2)}, ${maxRadius.toFixed(2)}, sqrt( penumbra ) );

    // 3. variable-width PCF
    float shadow = 0.0;
    for ( int i = 0; i < ${filterSamples}; i ++ ) {
      vec2 o = pcssVogel( i, ${filterSamples}, phi + 1.7 ) * radius * texelSize;
      shadow += texture2DCompare( shadowMap, shadowCoord.xy + o, shadowCoord.z );
    }
    return shadow / float( ${filterSamples} );
  }
  `;

  // Insert the helpers immediately before getShadow, which is where
  // texture2DCompare and unpackRGBAToDepth are already in scope.
  const anchor = 'float getShadow( sampler2D shadowMap,';
  if (src.indexOf(anchor) < 0) {
    console.warn('[SoftShadows] getShadow anchor not found; PCSS not installed');
    return;
  }
  let out = src.replace(anchor, `${helpers}\n\n\t${anchor}`);

  // Swap the fixed-kernel PCF_SOFT branch for the contact-hardening one.
  const startTag = '#elif defined( SHADOWMAP_TYPE_PCF_SOFT )';
  const endTag = '#elif defined( SHADOWMAP_TYPE_VSM )';
  const a = out.indexOf(startTag);
  const b = out.indexOf(endTag, a);
  if (a < 0 || b < 0) {
    console.warn('[SoftShadows] PCF_SOFT branch not found; PCSS not installed');
    return;
  }
  out = out.slice(0, a)
    + `${startTag}\n\n\t\t\tshadow = getShadowPCSS( shadowMap, shadowMapSize, shadowCoord.xyz );\n\n\t\t`
    + out.slice(b);

  THREE.ShaderChunk.shadowmap_pars_fragment = out;
}
