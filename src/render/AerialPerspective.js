import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Aerial perspective.
//
// Replaces three's flat FogExp2 with an analytically integrated exponential
// *height* fog plus directional Mie inscattering. Two things fall out of that
// which uniform fog can never give you:
//
//   1. Depth cue from altitude. Haze pools in the street and thins out at
//      roof height, so a skyline reads as further away than a kerb at the
//      same distance.
//   2. Depth cue from azimuth. Looking into the sun the air glows and warms;
//      looking away from it the same air is a cool, dark scrim. That single
//      asymmetry is most of what makes a render stop looking like a render.
//
// Implemented by rewriting the four built-in fog chunks, so every material in
// the project picks it up with no per-material code. The extra uniforms are
// *shared objects* injected via onBeforeCompile (see Atmosphere._scanMaterials)
// so one write updates the whole scene.
//
// Everything is evaluated in view space: `viewMatrix` and `cameraPosition` are
// available in every fragment shader three generates, but world position is
// not (sprites never compute it), so the world-space sun direction and world
// up are rotated into view space in the shader instead.
// ---------------------------------------------------------------------------

export const aerialUniforms = {
  aerialSunDirection: { value: new THREE.Vector3(0, 1, 0) },
  aerialSunColor: { value: new THREE.Color(1, 0.8, 0.6) },
  aerialHorizonColor: { value: new THREE.Color(0.6, 0.65, 0.72) },
  aerialDensity: { value: 0.013 },
  aerialHeightFalloff: { value: 0.055 },
  aerialBaseHeight: { value: 0.0 },
  aerialMie: { value: 2.0 },
  aerialMieG: { value: 0.76 },
  aerialInscatter: { value: 1.0 },
  aerialMaxOpacity: { value: 0.965 },
};

let patched = false;

export function patchAerialPerspective() {
  if (patched) return;
  patched = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
  #ifdef USE_FOG
    varying float vFogDepth;
    varying vec3 vFogView;
  #endif
  `;

  THREE.ShaderChunk.fog_vertex = /* glsl */`
  #ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vFogView = mvPosition.xyz;
  #endif
  `;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
  #ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vFogView;

    #ifdef FOG_EXP2
      uniform float fogDensity;
    #else
      uniform float fogNear;
      uniform float fogFar;
    #endif

    uniform vec3 aerialSunDirection;
    uniform vec3 aerialSunColor;
    uniform vec3 aerialHorizonColor;
    uniform float aerialDensity;
    uniform float aerialHeightFalloff;
    uniform float aerialBaseHeight;
    uniform float aerialMie;
    uniform float aerialMieG;
    uniform float aerialInscatter;
    uniform float aerialMaxOpacity;

    // Henyey-Greenstein, normalised over the sphere.
    float aerialHG( float cosT, float g ) {
      float g2 = g * g;
      float d = 1.0 + g2 - 2.0 * g * cosT;
      return ( 1.0 - g2 ) / ( 12.566370614 * d * sqrt( max( d, 1e-4 ) ) );
    }

    // Optical depth of exp(-k*h) density integrated along a straight segment
    // running from height h0 to height h1 over a path of length len.
    float aerialOpticalDepth( float h0, float h1, float len, float k, float density ) {
      float dh = h1 - h0;
      float e0 = exp( - k * h0 );
      if ( abs( dh ) < 1e-3 ) return density * len * e0;
      float e1 = exp( - k * h1 );
      return density * len * ( e0 - e1 ) / ( k * dh );
    }
  #endif
  `;

  THREE.ShaderChunk.fog_fragment = /* glsl */`
  #ifdef USE_FOG
  {
    float aDist = max( length( vFogView ), 1e-4 );
    vec3 aDirView = vFogView / aDist;

    // World up and the world-space sun, both rotated into view space.
    vec3 aUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    vec3 aSun = normalize( ( viewMatrix * vec4( aerialSunDirection, 0.0 ) ).xyz );

    float camH = cameraPosition.y - aerialBaseHeight;
    float fragH = camH + dot( vFogView, aUp );

    float od = aerialOpticalDepth( camH, fragH, aDist, aerialHeightFalloff, aerialDensity );
    float fogFactor = ( 1.0 - exp( - od ) ) * aerialMaxOpacity;

    float cosT = dot( aDirView, aSun );
    // Mie aureole: a tight, bright forward lobe around the sun direction.
    float mie = clamp( aerialHG( cosT, aerialMieG ) * aerialMie, 0.0, 1.0 );
    // Plus a broad forward bias so the whole sunward half of the sky is warmer.
    float broad = ( 0.5 + 0.5 * cosT );
    broad = broad * broad * 0.55;

    // Rays pointed at the horizon travel through the most air and end up
    // the colour of the far haze band; rays pointed up stay closer to the
    // cool zenith tint.
    float upness = dot( aDirView, aUp );
    vec3 haze = mix( fogColor, aerialHorizonColor, smoothstep( 0.28, -0.10, upness ) );
    haze = mix( haze, aerialSunColor, clamp( mie + broad * 0.6, 0.0, 1.0 ) );
    haze *= aerialInscatter;

    gl_FragColor.rgb = mix( gl_FragColor.rgb, haze, fogFactor );
  }
  #endif
  `;
}
