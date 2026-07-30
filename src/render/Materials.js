import * as THREE from 'three';
import { bakeAll, bakeDetailNormal, bakeStats } from './TextureBaker.js';
import { settings } from '../core/Settings.js';

// ---------------------------------------------------------------------------
// The world's material palette.
//
// Each entry names a procedural surface plus the world-space size of one
// texture tile, so repeats are set from real geometry dimensions rather than
// hand-tuned per mesh. On top of the baked maps every material gets two
// shader-side layers that no baked texture can provide:
//
//   * a DETAIL NORMAL sampled at a ~12 cm repeat, blended onto the base
//     normal. The base map has to cover metres, so it runs out of texels long
//     before the eye runs out of interest; this is what keeps a wall crisp
//     when you are standing against it.
//
//   * a MACRO VARIATION mask evaluated procedurally at several times the tile
//     size, modulating albedo brightness, saturation and roughness. Without
//     it a 2.5 m tile repeated across a 30 m wall announces itself as a grid
//     from across the street, no matter how good the tile is.
//
// `res: 'hi'` marks the surfaces the player is nose-to-nose with for most of
// the match. Everything else bakes at half that, which is where the load-time
// and texture-memory budget is actually won.
// ---------------------------------------------------------------------------

export const MATERIAL_DEFS = {
  concreteWall:  { surface: 'concrete', tile: 2.5, seed: 11, res: 'hi', detail: 1.0, macro: [0.10, 0.10, 0.10] },
  concreteFloor: { surface: 'concrete', tile: 3.0, seed: 12, res: 'hi', detail: 0.85, macro: [0.09, 0.08, 0.12] },
  road:          { surface: 'asphalt',  tile: 5.0, seed: 21, res: 'hi', detail: 0.9, macro: [0.12, 0.10, 0.14] },
  sand:          { surface: 'sand',     tile: 6.0, seed: 31, res: 'hi', detail: 0.7, macro: [0.09, 0.10, 0.08] },
  plasterWarm:   { surface: 'plaster',  tile: 3.2, seed: 41, res: 'hi', detail: 0.95, macro: [0.11, 0.12, 0.10], base: [0.66, 0.60, 0.49] },
  brick:         { surface: 'brick',    tile: 2.4, seed: 81, res: 'hi', detail: 0.8, macro: [0.10, 0.14, 0.09] },

  plasterPale:   { surface: 'plaster',  tile: 3.2, seed: 42, detail: 0.95, macro: [0.11, 0.12, 0.10], base: [0.74, 0.71, 0.63] },
  brickPale:     { surface: 'brick',    tile: 2.4, seed: 82, detail: 0.8, macro: [0.10, 0.14, 0.09], base: [0.44, 0.33, 0.26] },
  gravel:        { surface: 'gravel',   tile: 3.0, seed: 111, detail: 0.8, macro: [0.11, 0.09, 0.12] },
  containerRed:  { surface: 'corrugated', tile: 3.0, seed: 51, detail: 0.55, macro: [0.08, 0.10, 0.10], base: [0.38, 0.13, 0.10] },
  containerBlue: { surface: 'corrugated', tile: 3.0, seed: 52, detail: 0.55, macro: [0.08, 0.10, 0.10], base: [0.12, 0.22, 0.34] },
  militaryGreen: { surface: 'paintedMetal', tile: 2.0, seed: 61, detail: 0.5, macro: [0.07, 0.08, 0.09], base: [0.19, 0.22, 0.16] },
  rustySteel:    { surface: 'paintedMetal', tile: 1.8, seed: 62, detail: 0.6, macro: [0.08, 0.09, 0.10], base: [0.30, 0.28, 0.26] },
  rustedIron:    { surface: 'rustedIron', tile: 1.6, seed: 151, detail: 0.7, macro: [0.09, 0.10, 0.11] },
  wood:          { surface: 'wood',     tile: 2.0, seed: 91, detail: 0.75, macro: [0.10, 0.12, 0.10] },
  tile:          { surface: 'tile',     tile: 1.6, seed: 101, detail: 0.30, macro: [0.06, 0.06, 0.10] },
  tarp:          { surface: 'fabric',   tile: 1.6, seed: 121, detail: 0.65, macro: [0.09, 0.10, 0.08] },
  roadLine:      { surface: 'roadLine', tile: 4.0, seed: 141, detail: 0.8, macro: [0.09, 0.08, 0.12] },
  gunmetal:      { surface: 'gunmetal', tile: 0.5, seed: 71, detail: 0.45, macro: [0.05, 0.05, 0.07] },
  glass:         { surface: 'glass',    tile: 2.0, seed: 131, detail: 0.10, macro: [0.05, 0.04, 0.10],
                   glass: true, opacity: 0.24 },
};

/** Which detail-normal family each surface wants. */
const DETAIL_FAMILY = {
  concrete: 'grain', asphalt: 'grain', plaster: 'grain', sand: 'grain', brick: 'grain',
  gravel: 'grain', tile: 'grain', roadLine: 'grain', glass: 'grain', wood: 'grain',
  paintedMetal: 'brushed', gunmetal: 'brushed', corrugated: 'brushed', rustedIron: 'brushed',
  fabric: 'weave',
};

/** World size of one detail repeat, in metres, per family. */
const DETAIL_WORLD = { grain: 0.13, brushed: 0.09, weave: 0.05 };

// ---------------------------------------------------------------------------
//                            shader-side detail layer
// ---------------------------------------------------------------------------

const MACRO_PARS = /* glsl */`
uniform sampler2D uDetailMap;
uniform vec2 uDetailFade;
uniform float uDetailScale;
uniform float uDetailStrength;
uniform float uMacroScale;
uniform float uMacroTone;
uniform float uMacroSat;
uniform float uMacroRough;
float gMacro = 0.5;

float mv_hash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float mv_noise( vec2 p ) {
	vec2 i = floor( p ), f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mv_hash( i ), mv_hash( i + vec2( 1.0, 0.0 ) ), f.x ),
		mix( mv_hash( i + vec2( 0.0, 1.0 ) ), mv_hash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
// Two octaves is enough: this only has to break the eye's lock on the tile
// grid, and anything finer would fight the baked detail it sits on top of.
float mv_variation( vec2 uv ) {
	return mv_noise( uv ) * 0.62 + mv_noise( uv * 2.37 + 7.13 ) * 0.38;
}
`;

const MACRO_ALBEDO = /* glsl */`
	gMacro = mv_variation( vMapUv * uMacroScale );
	{
		float t = ( gMacro - 0.5 ) * 2.0;
		diffuseColor.rgb *= 1.0 + t * uMacroTone;
		// desaturating with the same mask is what stops the variation reading
		// as a lighting artefact — real weathering shifts chroma, not just value
		float l = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
		diffuseColor.rgb = mix( vec3( l ), diffuseColor.rgb, clamp( 1.0 + t * uMacroSat, 0.0, 2.0 ) );
	}
`;

const MACRO_ROUGH = /* glsl */`
	roughnessFactor = clamp( roughnessFactor + ( gMacro - 0.5 ) * 2.0 * uMacroRough, 0.028, 1.0 );
`;

const DETAIL_NORMAL = /* glsl */`
#ifdef USE_NORMALMAP_OBJECTSPACE

	normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#ifdef FLIP_SIDED
		normal = - normal;
	#endif
	#ifdef DOUBLE_SIDED
		normal = normal * faceDirection;
	#endif
	normal = normalize( normalMatrix * normal );

#elif defined( USE_NORMALMAP_TANGENTSPACE )

	// Both normal maps are two-channel (RG8) — Z is implied by the vector being
	// unit length with a positive Z, so storing it would be a third of the
	// map's memory spent on a value one sqrt recovers exactly.
	vec2 mapXY = texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0;
	mapXY *= normalScale;

	// Detail normal, sampled at a much tighter repeat and faded out with
	// distance so it never becomes shimmering sub-pixel noise at range.
	float dFade = 1.0 - smoothstep( uDetailFade.x, uDetailFade.y, length( vViewPosition ) );
	if ( dFade > 0.002 ) {
		vec2 dXY = texture2D( uDetailMap, vNormalMapUv * uDetailScale ).xy * 2.0 - 1.0;
		// Whiteout / partial-derivative blend: sum the tangent-space slopes.
		// Slerping the two vectors instead would let the detail flatten the
		// base normal wherever the detail is near-flat.
		mapXY += dXY * ( uDetailStrength * dFade );
	}

	vec3 mapN = vec3( mapXY, sqrt( max( 1e-4, 1.0 - dot( mapXY, mapXY ) ) ) );
	normal = normalize( tbn * mapN );

#elif defined( USE_BUMPMAP )

	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );

#endif
`;

/**
 * Installs the detail/variation hook on a material. Kept as a standalone
 * function because `Material.clone()` does not carry `onBeforeCompile` across
 * (and JSON-clones `userData`, which would destroy any texture stored there),
 * so every clone has to have it reinstalled.
 */
function installDetail(mat, detailMap, params) {
  mat.userData.detailParams = params;
  mat.detailMap = detailMap;
  mat.onBeforeCompile = function (shader) {
    const p = this.userData.detailParams;
    shader.uniforms.uDetailMap = { value: this.detailMap };
    shader.uniforms.uDetailScale = { value: p.detailScale };
    shader.uniforms.uDetailStrength = { value: p.detailStrength };
    shader.uniforms.uDetailFade = { value: new THREE.Vector2(p.fadeNear, p.fadeFar) };
    shader.uniforms.uMacroScale = { value: p.macroScale };
    shader.uniforms.uMacroTone = { value: p.macroTone };
    shader.uniforms.uMacroSat = { value: p.macroSat };
    shader.uniforms.uMacroRough = { value: p.macroRough };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${MACRO_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${MACRO_ALBEDO}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${MACRO_ROUGH}`)
      .replace('#include <normal_fragment_maps>', DETAIL_NORMAL);
  };
  // Every material injects the identical source, so they can all share one
  // compiled program — the per-material differences are uniforms only.
  mat.customProgramCacheKey = () => 'surfaceDetail';
  // `Material.clone()` carries neither `onBeforeCompile` nor a live texture in
  // `userData` (it JSON-clones that), so a plain clone of a library material
  // silently loses the detail layer — and, now that the normal maps are RG8,
  // would read a green channel as Z and shade the surface with a garbage
  // normal. Anything outside this file that clones a material (the world
  // builder's tinted variants, for one) has no way to know that, so the repair
  // belongs here rather than at every call site.
  mat.clone = function () {
    const c = THREE.MeshStandardMaterial.prototype.clone.call(this);
    installDetail(c, this.detailMap, { ...this.userData.detailParams });
    c.userData.tile = this.userData.tile;
    return c;
  };
  return mat;
}

export class MaterialLibrary {
  constructor() {
    /** @type {Record<string, THREE.MeshStandardMaterial>} */
    this.materials = {};
    this.ready = false;
    this.stats = null;
  }

  /** Bake resolution for a def. Capped at 1024 — see load(). */
  static sizeFor(def) {
    const cap = Math.min(settings.textureSize, 1024);
    return def.res === 'hi' ? cap : Math.max(256, cap >> 1);
  }

  async load(onProgress) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // Texture size is capped at 1024 regardless of the quality preset. A 2048
    // map over a 2.5 m tile is 1.2 mm per texel, which the 0.13 m detail
    // normal already resolves far better than a base map ever could, and 20
    // materials at 2048² would be ~1 GB of texture memory for no visible gain.
    const requests = Object.entries(MATERIAL_DEFS).map(([key, def]) => ({
      key,
      name: def.surface,
      seed: def.seed,
      base: def.base,
      tile: def.tile,
      normalStrength: def.normalStrength,
      size: MaterialLibrary.sizeFor(def),
    }));

    const families = [...new Set(Object.values(MATERIAL_DEFS).map((d) => DETAIL_FAMILY[d.surface] || 'grain'))];
    const [baked, ...detailTex] = await Promise.all([
      bakeAll(requests, onProgress),
      ...families.map((f) => bakeDetailNormal(f, { size: 512, worldSize: DETAIL_WORLD[f] ?? 0.12 })),
    ]);
    const detailByFamily = Object.fromEntries(families.map((f, i) => [f, detailTex[i]]));

    let bytes = 0;
    for (const [key, def] of Object.entries(MATERIAL_DEFS)) {
      const maps = baked[key];
      const family = DETAIL_FAMILY[def.surface] || 'grain';
      const common = {
        map: maps.map,
        normalMap: maps.normalMap,
        roughnessMap: maps.ormMap,
        aoMap: maps.ormMap,
        metalnessMap: maps.ormMap,
        roughness: def.roughness ?? 1.0,
        metalness: def.metalness ?? 1.0,
        normalScale: new THREE.Vector2(def.normalScale ?? 1, def.normalScale ?? 1),
        envMapIntensity: def.envMapIntensity ?? 1.0,
      };
      const mat = def.glass
        ? new THREE.MeshStandardMaterial({
          ...common,
          transparent: true,
          opacity: def.opacity ?? 0.25,
          depthWrite: false,
          side: THREE.DoubleSide,
          envMapIntensity: 2.4,
        })
        : new THREE.MeshStandardMaterial(common);

      const macro = def.macro || [0.09, 0.09, 0.10];
      installDetail(mat, detailByFamily[family], {
        // vMapUv is already scaled by the repeat, so it counts tiles. Dividing
        // by ~6 puts one variation blob across half a dozen tiles, which is
        // the scale that reads as "this wall is weathered unevenly" rather
        // than "this texture has noise on it".
        detailScale: def.tile / (DETAIL_WORLD[family] ?? 0.12),
        detailStrength: def.detail ?? 0.7,
        fadeNear: 14, fadeFar: 34,
        macroScale: 1 / 6,
        macroTone: macro[0], macroSat: macro[1], macroRough: macro[2],
      });
      mat.name = key;
      mat.userData.tile = def.tile;
      this.materials[key] = mat;

      const s = MaterialLibrary.sizeFor(def);
      // albedo RGBA8 + normal RG8 + packed ORM RGBA8 = 10 bytes/texel, ×4/3
      // for the mip chain
      bytes += s * s * 10 * 1.34;
    }
    bytes += 512 * 512 * 2 * 1.34 * families.length;

    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    this.stats = {
      ms: Math.round(ms),
      materials: Object.keys(MATERIAL_DEFS).length,
      detailTiles: families.length,
      textureMB: +(bytes / (1024 * 1024)).toFixed(1),
      // Generation time summed across the pool, main-thread time, and the
      // speedup actually achieved. `cpuMs / ms` below 1.5 on a 4-core machine
      // means the workers are starved, not that the generators are slow.
      cpuMs: Math.round(bakeStats.cpuMs),
      mainMs: Math.round(bakeStats.mainMs),
      workers: bakeStats.workers,
      parallelism: +(bakeStats.cpuMs / Math.max(1, ms)).toFixed(2),
    };
    // Surfaced deliberately: bake time and texture memory are the two numbers
    // this library can silently ruin, so they should never need a profiler.
    console.info(
      `[materials] ${this.stats.materials} materials + ${this.stats.detailTiles} detail tiles `
      + `in ${this.stats.ms} ms wall (${this.stats.cpuMs} ms worker CPU across `
      + `${this.stats.workers} workers, ${this.stats.parallelism}× parallel; `
      + `${this.stats.mainMs} ms on the main thread), ~${this.stats.textureMB} MB VRAM`,
    );
    this.ready = true;
    return this.materials;
  }

  get(name) {
    const m = this.materials[name];
    if (!m) throw new Error(`Material "${name}" not loaded`);
    return m;
  }

  /**
   * Returns a clone of a material with texture repeats set for a surface of
   * the given world-space extent. Clones share the same GPU textures, so this
   * is cheap — only the repeat vector differs.
   */
  tiled(name, width, height) {
    const base = this.get(name);
    const tile = base.userData.tile;
    const rx = Math.max(1, Math.round(width / tile));
    const ry = Math.max(1, Math.round(height / tile));
    const cacheKey = `${name}:${rx}x${ry}`;
    this._tileCache ??= new Map();
    if (this._tileCache.has(cacheKey)) return this._tileCache.get(cacheKey);

    const mat = base.clone();
    // clone() shares texture objects, so each repeat needs its own Texture
    // view over the same image. Clone once per *distinct* source texture —
    // ao/roughness/metalness all reference the one packed ORM map, and giving
    // them separate clones would triple the sampler count for nothing.
    const clones = new Map();
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap']) {
      const t = base[slot];
      if (!t) continue;
      let c = clones.get(t);
      if (!c) {
        c = t.clone();
        c.repeat.set(rx, ry);
        c.needsUpdate = true;
        clones.set(t, c);
      }
      mat[slot] = c;
    }
    // clone() is overridden in installDetail() to carry the detail layer and
    // the tile size across, so there is nothing to restore here.
    mat.name = `${name}@${rx}x${ry}`;
    mat.needsUpdate = true;
    this._tileCache.set(cacheKey, mat);
    return mat;
  }

  dispose() {
    for (const m of Object.values(this.materials)) m.dispose();
    if (this._tileCache) for (const m of this._tileCache.values()) m.dispose();
  }
}
