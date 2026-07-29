import * as THREE from 'three';
import { bakeAll } from './TextureBaker.js';
import { settings } from '../core/Settings.js';

// ---------------------------------------------------------------------------
// The world's material palette. Each entry names a procedural surface plus the
// world-space size of one texture tile, so repeats are set from real geometry
// dimensions rather than hand-tuned per mesh.
// ---------------------------------------------------------------------------

export const MATERIAL_DEFS = {
  concreteWall:  { surface: 'concrete',     tile: 4.0, seed: 11, normalStrength: 2.2, roughness: 1.0, metalness: 0.0 },
  concreteFloor: { surface: 'concrete',     tile: 5.0, seed: 12, normalStrength: 1.6, roughness: 1.0, metalness: 0.0 },
  road:          { surface: 'asphalt',      tile: 6.0, seed: 21, normalStrength: 1.8, roughness: 1.0, metalness: 0.0 },
  sand:          { surface: 'sand',         tile: 8.0, seed: 31, normalStrength: 1.4, roughness: 1.0, metalness: 0.0 },
  plasterWarm:   { surface: 'plaster',      tile: 4.5, seed: 41, normalStrength: 2.0, roughness: 1.0, metalness: 0.0, base: [0.66, 0.60, 0.49] },
  plasterPale:   { surface: 'plaster',      tile: 4.5, seed: 42, normalStrength: 2.0, roughness: 1.0, metalness: 0.0, base: [0.74, 0.71, 0.63] },
  containerRed:  { surface: 'corrugated',   tile: 3.0, seed: 51, normalStrength: 3.0, roughness: 1.0, metalness: 1.0, base: [0.38, 0.13, 0.10] },
  containerBlue: { surface: 'corrugated',   tile: 3.0, seed: 52, normalStrength: 3.0, roughness: 1.0, metalness: 1.0, base: [0.12, 0.22, 0.34] },
  militaryGreen: { surface: 'paintedMetal', tile: 2.5, seed: 61, normalStrength: 1.8, roughness: 1.0, metalness: 1.0, base: [0.19, 0.22, 0.16] },
  rustySteel:    { surface: 'paintedMetal', tile: 2.0, seed: 62, normalStrength: 2.2, roughness: 1.0, metalness: 1.0, base: [0.30, 0.28, 0.26] },
  gunmetal:      { surface: 'gunmetal',     tile: 0.5, seed: 71, normalStrength: 1.2, roughness: 1.0, metalness: 1.0 },
};

export class MaterialLibrary {
  constructor() {
    /** @type {Record<string, THREE.MeshStandardMaterial>} */
    this.materials = {};
    this.ready = false;
  }

  async load(onProgress) {
    const requests = Object.entries(MATERIAL_DEFS).map(([key, def]) => ({
      key,
      name: def.surface,
      seed: def.seed,
      base: def.base,
      normalStrength: def.normalStrength,
      size: settings.textureSize,
    }));

    const baked = await bakeAll(requests, onProgress);

    for (const [key, def] of Object.entries(MATERIAL_DEFS)) {
      const maps = baked[key];
      const mat = new THREE.MeshStandardMaterial({
        map: maps.map,
        normalMap: maps.normalMap,
        roughnessMap: maps.roughnessMap,
        aoMap: maps.aoMap,
        metalnessMap: maps.metalnessMap || null,
        roughness: def.roughness ?? 1.0,
        metalness: maps.metalnessMap ? (def.metalness ?? 1.0) : 0.0,
        envMapIntensity: 1.0,
      });
      mat.name = key;
      mat.userData.tile = def.tile;
      this.materials[key] = mat;
    }
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
    // clone() shares texture objects; we need per-repeat copies of each map.
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap']) {
      const t = base[slot];
      if (!t) continue;
      const c = t.clone();
      c.repeat.set(rx, ry);
      c.needsUpdate = true;
      mat[slot] = c;
    }
    mat.needsUpdate = true;
    this._tileCache.set(cacheKey, mat);
    return mat;
  }

  dispose() {
    for (const m of Object.values(this.materials)) m.dispose();
    if (this._tileCache) for (const m of this._tileCache.values()) m.dispose();
  }
}
