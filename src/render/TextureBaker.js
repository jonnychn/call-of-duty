import * as THREE from 'three';
import { settings } from '../core/Settings.js';
import { generateSurface, surfaceNames } from './SurfaceGen.js';

export { surfaceNames };

// ---------------------------------------------------------------------------
// Bakes tiling PBR map sets into DataTextures. All source noise is
// period-tiled, so surfaces repeat across large walls and floors seamlessly.
//
// Generation runs on a worker pool — a 1024² set costs roughly a second of
// pure JS, and there are a dozen of them, so doing it inline would stall the
// first frame for ten seconds.
// ---------------------------------------------------------------------------

const cache = new Map();
const inflight = new Map();

// ------------------------------- worker pool -------------------------------

class BakePool {
  constructor(n) {
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.size = n;
    this.failed = false;
  }

  _spawn() {
    if (this.failed) return null;
    try {
      const w = new Worker(new URL('./bake.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this._onDone(w, e.data);
      w.onerror = () => { this.failed = true; };
      this.workers.push(w);
      return w;
    } catch {
      this.failed = true;
      return null;
    }
  }

  _onDone(w, msg) {
    const entry = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (entry) {
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error));
    }
    const next = this.queue.shift();
    if (next) this._dispatch(w, next);
    else this.idle.push(w);
  }

  _dispatch(w, job) {
    this.pending.set(job.id, job);
    w.postMessage({ id: job.id, name: job.name, size: job.size, seed: job.seed, opts: job.opts });
  }

  run(name, size, seed, opts) {
    // Fall back to synchronous generation if workers are unavailable
    // (older browsers, file:// origins, or a worker that failed to boot).
    if (this.failed) {
      return Promise.resolve().then(() => generateSurface(name, size, seed, opts));
    }
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, name, size, seed, opts, resolve, reject };
      let w = this.idle.pop();
      if (!w && this.workers.length < this.size) w = this._spawn();
      if (!w) {
        if (this.failed) {
          resolve(generateSurface(name, size, seed, opts));
          return;
        }
        this.queue.push(job);
        return;
      }
      this._dispatch(w, job);
    });
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

const pool = new BakePool(Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4))));

// ----------------------------- texture wrapping ----------------------------

function applyCommon(tex) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = settings.anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function rgbToTexture(rgb, size) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0, n = size * size; i < n; i++) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  return applyCommon(tex);
}

function rgbaToTexture(rgba, size) {
  const tex = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  return applyCommon(tex);
}

function toMaps(r) {
  // Occlusion / roughness / metalness are packed into one RGB texture using
  // the glTF convention. MeshStandardMaterial samples .r for aoMap, .g for
  // roughnessMap and .b for metalnessMap, so the same texture object can fill
  // all three slots — one upload and one sampler instead of three.
  const orm = rgbaToTexture(r.orm, r.size);
  return {
    map: rgbToTexture(r.rgb, r.size),
    normalMap: rgbaToTexture(r.normal, r.size),
    ormMap: orm,
    aoMap: orm,
    roughnessMap: orm,
    metalnessMap: orm,
    detail: r.detail,
  };
}

// --------------------------------- API -------------------------------------

function keyFor(name, size, seed, opts) {
  return `${name}|${size}|${seed}|${opts.base ? opts.base.join(',') : ''}|${opts.normalStrength ?? ''}`;
}

/**
 * Bake a named surface into a Three.js-ready map set. Repeated calls with the
 * same arguments share one set of GPU textures.
 * @returns {Promise<{map, normalMap, roughnessMap, aoMap, metalnessMap?}>}
 */
export function bakeSurface(name, opts = {}) {
  const size = opts.size || settings.textureSize;
  const seed = opts.seed ?? 1;
  const key = keyFor(name, size, seed, opts);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const p = pool.run(name, size, seed, opts).then((r) => {
    const maps = toMaps(r);
    cache.set(key, maps);
    inflight.delete(key);
    return maps;
  });
  inflight.set(key, p);
  return p;
}

/** Bakes many surfaces concurrently, reporting 0..1 progress. */
export async function bakeAll(requests, onProgress) {
  let done = 0;
  const total = requests.length;
  const results = await Promise.all(requests.map(async (req) => {
    const maps = await bakeSurface(req.name, req);
    done++;
    if (onProgress) onProgress(done / total, req.key || req.name);
    return [req.key || req.name, maps];
  }));
  return Object.fromEntries(results);
}

export function disposeTextureCache() {
  // A map set aliases one ORM texture across three slots, so dedupe before
  // disposing rather than calling dispose() on the same texture four times.
  const seen = new Set();
  for (const set of cache.values()) {
    for (const v of Object.values(set)) {
      if (v && v.isTexture && !seen.has(v)) { seen.add(v); v.dispose(); }
    }
  }
  cache.clear();
  pool.dispose();
}
