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
  u.cloudHeight = { value: 1900.0 };   // cumulus deck altitude, metres
  u.cirrusHeight = { value: 7200.0 };
  u.hazeColor = { value: new THREE.Color(0xb9c3cf) };
  u.hazeStrength = { value: 0.55 };

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
    uniform float cloudCoverage;
    uniform float cloudDensity;
    uniform float cloudScale;
    uniform float cloudHigh;
    uniform vec3 cloudColor;
    uniform vec3 cloudShadow;
    uniform float cloudTime;
    uniform float cloudHeight;
    uniform float cirrusHeight;
    uniform vec3 hazeColor;
    uniform float hazeStrength;

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

    // Distance from the eye to a cloud shell at height h above a planet of
    // radius R. A flat plane divided by direction.y blows up at the horizon,
    // which is exactly why the old deck had to be faded out below ~9 degrees
    // and therefore never existed at the elevations a player actually looks
    // at. A shell stays finite: the far distance tends to sqrt(2Rh), so
    // features converge toward the horizon instead of shearing to infinity.
    float skyShellDist( vec3 d, float h ) {
      const float R = 6371000.0;
      float b = R * d.y;
      return sqrt( max( b * b + 2.0 * R * h + h * h, 0.0 ) ) - b;
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

      if ( cloudDensity > 0.001 && direction.y > -0.02 ) {
        vec3 vd = normalize( direction );
        float dUp = max( vd.y, 0.0006 );

        // ---- cumulus deck ----
        float tLow = skyShellDist( vec3( vd.x, dUp, vd.z ), cloudHeight );
        // 2.4 km features at cloudScale 1.0.
        float sLow = 0.00042 * cloudScale;
        vec2 cuv = tLow * vd.xz * sLow + vec2( cloudTime * 0.9, cloudTime * 0.35 );

        vec2 warp = vec2( skyFbm( cuv * 0.42, 2 ), skyFbm( cuv * 0.42 + 9.1, 2 ) ) - 0.5;
        vec2 wuv = cuv + warp * 1.7;
        float n = skyFbm( wuv, 5 );

        float thr = 1.0 - cloudCoverage;
        float cov = smoothstep( thr, thr + 0.11, n );

        // Fade with distance, not with elevation: past ~70 km the deck is
        // simply part of the haze, which is what it looks like in reality.
        float far = 1.0 - smoothstep( 22000.0, 90000.0, tLow );
        cov *= far;

        // Form. Two extra taps give a usable gradient: one toward the sun for
        // the light/shade split, one "up-sun" for the bright transmitting rim.
        vec2 sunStep = normalize( vSunDirection.xz + vec2( 1e-4 ) );
        float nSun  = skyFbm( wuv + sunStep * 0.62, 4 );
        float nSun2 = skyFbm( wuv + sunStep * 1.35, 4 );
        // Optical depth toward the light: how much cloud is between this point
        // and the sun. More cloud in the way -> deeper shade.
        float depth = clamp( ( nSun - n ) * 2.0 + ( nSun2 - n ) * 1.1, -1.0, 1.0 );
        float lit = clamp( 0.5 - depth * 3.2, 0.0, 1.0 );
        // Push the midtones apart so there is a definite sunlit side and a
        // definite shaded side rather than one grey mass.
        lit = smoothstep( 0.12, 0.88, lit );

        // Thin edges transmit; thick cores do not.
        float thin = 1.0 - smoothstep( 0.05, 0.62, cov );
        // Base shading is darker underneath, which is what sells volume from
        // below — we are always looking at the base of a cumulus deck.
        float baseShade = mix( 0.34, 1.0, smoothstep( 0.02, 0.50, vd.y ) );

        vec3 cCol = mix( cloudShadow, cloudColor * 1.25, lit );
        cCol *= baseShade;
        cCol += cloudColor * thin * 0.55;                                  // translucent edge
        cCol += cloudColor * pow( max( cosTheta, 0.0 ), 5.0 ) * ( 0.30 + 1.1 * thin ); // silver lining

        // ---- cirrus sheet ----
        float tHigh = skyShellDist( vec3( vd.x, dUp, vd.z ), cirrusHeight );
        vec2 huv = tHigh * vd.xz * ( sLow * 0.30 ) + vec2( cloudTime * 0.4, -cloudTime * 0.14 );
        float hn = skyFbm( huv * vec2( 1.0, 3.4 ) + skyFbm( huv * 0.7, 2 ) * 0.8, 4 );
        float hcov = smoothstep( 0.50, 0.80, hn ) * cloudHigh;
        hcov *= 1.0 - smoothstep( 40000.0, 160000.0, tHigh );

        retColor = mix( retColor, cloudColor * 1.02, clamp( hcov * cloudDensity, 0.0, 0.8 ) );
        retColor = mix( retColor, cCol, clamp( cov * cloudDensity, 0.0, 1.0 ) );
      }

      // ---- horizon haze layering -----------------------------------------
      // Two bands rather than one ramp: a broad aerosol layer through the
      // lower sky, and a tight, brighter one sitting on the horizon line.
      // A single gradient reads as a backdrop; two depths read as air.
      if ( hazeStrength > 0.001 ) {
        float up = max( direction.y, -0.05 );
        float broad = pow( 1.0 - clamp( up, 0.0, 1.0 ), 3.2 );
        float band  = exp( -max( up, 0.0 ) * 42.0 );
        vec3 hz = hazeColor * ( 0.85 + 0.5 * pow( max( cosTheta, 0.0 ), 3.0 ) );
        retColor = mix( retColor, hz, clamp( broad * hazeStrength * 0.80, 0.0, 0.92 ) );
        retColor = mix( retColor, hz * 1.10, clamp( band * hazeStrength * 0.55, 0.0, 0.85 ) );
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
