// ---------------------------------------------------------------------------
// Extensions to three's Preetham sky.
//
// The stock shader is a decent daylight gradient and nothing else: its solar
// disc is a hard 0.53-degree dot with no limb, there is no aureole, the sphere
// below the horizon keeps returning bright sky (which poisons the PMREM probe
// with light from underneath), and night is a flat black dome.
//
// This adds, without touching the scattering model itself:
//   - a limb-darkened solar disc at a controllable angular size
//   - a wide aureole around it, which is what actually sells "hazy sun"
//   - a ground half-space so the probe's lower hemisphere is dark dirt
//   - a procedural star field and a moon disc for the night preset
//   - a single `skyExposure` scalar so the sky can be balanced against the
//     scene without re-tuning turbidity
// ---------------------------------------------------------------------------

import * as THREE from 'three';

/** @param {THREE.ShaderMaterial} material the Sky's material */
export function patchSky(material) {
  const u = material.uniforms;
  u.skyExposure = { value: 1.0 };
  u.sunDiscIntensity = { value: 1.0 };
  u.sunDiscSize = { value: 0.55 };     // angular diameter, degrees
  u.aureole = { value: 0.35 };
  u.starIntensity = { value: 0.0 };
  u.groundColor = { value: new THREE.Color(0x2a2a2a) };
  u.moonPosition = { value: new THREE.Vector3(0, 1, 0) };
  u.moonIntensity = { value: 0.0 };
  u.moonSize = { value: 0.5 };
  u.cloudCoverage = { value: 0.42 };
  u.cloudDensity = { value: 0.85 };
  u.cloudScale = { value: 0.55 };
  u.cloudHigh = { value: 0.35 };
  u.cloudColor = { value: new THREE.Color(0xffffff) };
  u.cloudShadow = { value: new THREE.Color(0x8a94a6) };
  u.cloudTime = { value: 0.0 };

  let fs = material.fragmentShader;

  fs = fs.replace(
    'uniform float mieDirectionalG;',
    /* glsl */`
    uniform float mieDirectionalG;
    uniform float skyExposure;
    uniform float sunDiscIntensity;
    uniform float sunDiscSize;
    uniform float aureole;
    uniform float starIntensity;
    uniform vec3 groundColor;
    uniform vec3 moonPosition;
    uniform float moonIntensity;
    uniform float moonSize;

    float skyHash( vec3 p ) {
      p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
      p *= 17.0;
      return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
    }

    // Sparse star field on a 3D lattice, so stars are fixed to the celestial
    // sphere and do not swim when the camera turns.
    float skyStars( vec3 dir ) {
      float acc = 0.0;
      vec3 sp = dir * 340.0;
      vec3 ip = floor( sp );
      vec3 fp = fract( sp );
      float r = skyHash( ip );
      if ( r > 0.972 ) {
        vec3 off = vec3( skyHash( ip + 11.3 ), skyHash( ip + 27.1 ), skyHash( ip + 53.7 ) );
        float d = length( fp - off );
        float mag = ( r - 0.972 ) / 0.028;
        acc = ( 1.0 - smoothstep( 0.0, 0.42, d ) ) * pow( mag, 3.0 );
      }
      return acc;
    }

    // --- clouds ---------------------------------------------------------
    // Two layers projected onto flat planes at different heights: a low
    // cumulus deck with domain-warped fbm, and a thin high cirrus sheet.
    // Flat-plane projection is wrong for a real atmosphere but it is right
    // for what a player sees, and it gives free perspective convergence
    // toward the horizon, which is most of the read.

    float skyValue( vec2 p ) {
      vec2 i = floor( p ), f = fract( p );
      f = f * f * ( 3.0 - 2.0 * f );
      float a = skyHash( vec3( i, 0.0 ) );
      float b = skyHash( vec3( i + vec2( 1.0, 0.0 ), 0.0 ) );
      float c = skyHash( vec3( i + vec2( 0.0, 1.0 ), 0.0 ) );
      float d = skyHash( vec3( i + vec2( 1.0, 1.0 ), 0.0 ) );
      return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
    }

    float skyFbm( vec2 p, const int oct ) {
      float s = 0.0, amp = 0.5, norm = 0.0;
      for ( int i = 0; i < 6; i ++ ) {
        if ( i >= oct ) break;
        s += amp * skyValue( p );
        norm += amp;
        p = p * 2.07 + vec2( 13.7, 7.3 );
        amp *= 0.5;
      }
      return s / norm;
    }
    `,
  );

  // Replace the stock hard-edged disc with a limb-darkened one plus aureole.
  fs = fs.replace(
    /float sundisk = smoothstep\([\s\S]*?L0 \+= \( vSunE \* 19000\.0 \* Fex \) \* sundisk;/,
    /* glsl */`
      float discCos = cos( radians( sunDiscSize * 0.5 ) );
      float edge = 1.0 - discCos;
      float sundisk = smoothstep( discCos - edge * 0.35, discCos + edge * 0.05, cosTheta );
      // Limb darkening: the solar photosphere is ~40% dimmer at the rim.
      float rNorm = clamp( ( 1.0 - cosTheta ) / max( edge, 1e-6 ), 0.0, 1.0 );
      float mu = sqrt( max( 0.0, 1.0 - rNorm * rNorm ) );
      float limb = 0.32 + 0.68 * pow( mu, 0.62 );
      L0 += ( vSunE * 19000.0 * Fex ) * sundisk * limb * sunDiscIntensity;

      // Aureole: forward-scattered light in a few degrees around the disc.
      // Cheap to compute, and it is the difference between a sticker sun and
      // a sun that is genuinely sitting behind the air in front of it.
      float ang = max( cosTheta, 0.0 );
      L0 += ( vSunE * Fex ) * aureole * (
        2.6 * pow( ang, 1800.0 ) +
        0.45 * pow( ang, 220.0 ) +
        0.09 * pow( ang, 24.0 )
      );

      if ( moonIntensity > 0.0 ) {
        vec3 moonDir = normalize( moonPosition );
        float mCos = dot( direction, moonDir );
        float mDiscCos = cos( radians( moonSize * 0.5 ) );
        float mEdge = 1.0 - mDiscCos;
        float mDisk = smoothstep( mDiscCos - mEdge * 0.4, mDiscCos + mEdge * 0.05, mCos );
        // Crater mottling so the moon is not a clean vector circle.
        float mr = clamp( ( 1.0 - mCos ) / max( mEdge, 1e-6 ), 0.0, 1.0 );
        float mottle = 0.82 + 0.18 * skyHash( floor( direction * 900.0 ) );
        float mLimb = mix( 1.0, 0.55, smoothstep( 0.55, 1.0, mr ) );
        L0 += vec3( 3.4, 3.5, 3.9 ) * moonIntensity * mDisk * mottle * mLimb;
        // Halo through the high haze.
        L0 += vec3( 0.30, 0.36, 0.55 ) * moonIntensity * (
          0.9 * pow( max( mCos, 0.0 ), 900.0 ) + 0.12 * pow( max( mCos, 0.0 ), 60.0 ) );
      }
    `,
  );

  fs = fs.replace(
    'gl_FragColor = vec4( retColor, 1.0 );',
    /* glsl */`
      retColor *= skyExposure;

      if ( cloudDensity > 0.001 && direction.y > 0.002 ) {
        float cy = max( direction.y, 0.006 );
        vec2 base = direction.xz / cy;

        // --- low deck ---
        vec2 cuv = base * cloudScale + vec2( cloudTime * 0.9, cloudTime * 0.35 );
        vec2 warp = vec2( skyFbm( cuv * 0.45, 2 ), skyFbm( cuv * 0.45 + 9.1, 2 ) ) - 0.5;
        float n = skyFbm( cuv + warp * 1.6, 4 );
        float thr = 1.0 - cloudCoverage;
        float cov = smoothstep( thr, thr + 0.24, n );
        // The projection stretches to infinity at the horizon; fade there or
        // the deck turns into a hard grey band.
        cov *= smoothstep( 0.015, 0.16, direction.y );

        // Fake self-shadowing: sample the same field a step toward the sun
        // and compare. Cheap, and it puts the light on the correct side.
        vec2 sunStep = normalize( vSunDirection.xz + vec2( 1e-4 ) ) * 0.55;
        float nSun = skyFbm( cuv + warp * 1.6 + sunStep, 4 );
        float lit = clamp( ( n - nSun ) * 3.2 + 0.5, 0.0, 1.0 );
        // Thin edges transmit light: bright rims where the deck breaks up.
        float edge = 1.0 - smoothstep( 0.0, 0.55, cov );

        vec3 cCol = mix( cloudShadow, cloudColor, lit );
        cCol += cloudColor * edge * 0.35;
        // Silver lining / forward scatter through the cloud toward the sun.
        cCol += cloudColor * pow( max( cosTheta, 0.0 ), 6.0 ) * ( 0.35 + 0.9 * edge );

        // --- high cirrus ---
        vec2 huv = base * cloudScale * 0.34 + vec2( cloudTime * 0.35, -cloudTime * 0.12 );
        float hn = skyFbm( huv * vec2( 1.0, 3.1 ), 4 );
        float hcov = smoothstep( 0.52, 0.78, hn ) * cloudHigh;
        hcov *= smoothstep( 0.02, 0.22, direction.y );

        retColor = mix( retColor, cCol, clamp( cov * cloudDensity, 0.0, 1.0 ) );
        retColor = mix( retColor, cloudColor * 1.05, clamp( hcov * cloudDensity, 0.0, 0.85 ) );
      }

      if ( starIntensity > 0.0 ) {
        float s = skyStars( normalize( direction ) );
        // Stars fade out where the sky itself is bright.
        float visible = 1.0 - smoothstep( 0.02, 0.20, dot( retColor, vec3( 0.333 ) ) );
        retColor += vec3( 0.86, 0.90, 1.0 ) * s * starIntensity * visible
                  * smoothstep( -0.03, 0.16, direction.y );
      }

      // Below the horizon: fade to a dark ground albedo. The lower hemisphere
      // of this shader is what the PMREM probe uses as bounce light, and the
      // stock version returns near-horizon sky there, which is the single
      // biggest cause of a flat, uplit, washed-out look.
      float below = 1.0 - smoothstep( -0.09, 0.0, direction.y );
      vec3 ground = groundColor * ( 0.35 + 0.65 * dot( retColor, vec3( 0.333 ) ) );
      retColor = mix( retColor, ground, below );

      gl_FragColor = vec4( retColor, 1.0 );
    `,
  );

  material.fragmentShader = fs;
  material.needsUpdate = true;
  return material;
}
