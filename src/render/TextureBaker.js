import * as THREE from 'three';
import { settings } from '../core/Settings.js';
import { generateSurface, generateDetailNormal, surfaceNames } from './SurfaceGen.js';

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

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Load-time accounting. `cpuMs` is generation time measured inside the workers,
 * `mainMs` is everything this module does on the main thread (unpacking the
 * message and constructing DataTextures). Comparing cpuMs against the caller's
 * wall clock is the only way to tell a slow generator apart from a pool that
 * never got the cores it asked for, and comparing mainMs against wall time is
 * the only way to prove the bake really is off the main thread.
 */
export const bakeStats = { jobs: 0, cpuMs: 0, mainMs: 0, workers: 0, sync: 0 };

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
      bakeStats.jobs++;
      bakeStats.cpuMs += (msg.result && msg.result.cpuMs) || 0;
      bakeStats.workers = this.workers.length;
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error));
    }
    const next = this.queue.shift();
    if (next) this._dispatch(w, next);
    else this.idle.push(w);
  }

  _dispatch(w, job) {
    this.pending.set(job.id, job);
    w.postMessage({ id: job.id, kind: job.kind, name: job.name, size: job.size, seed: job.seed, opts: job.opts });
  }

  run(kind, name, size, seed, opts) {
    const local = () => {
      // The fallback runs on the main thread, so it is charged to mainMs — the
      // point of the number is "how long was the first frame blocked", not
      // "where in the file did the work happen".
      const t = now();
      const r = (kind === 'detail'
        ? generateDetailNormal(name, size, seed, opts.worldSize, opts.amplitude)
        : generateSurface(name, size, seed, opts));
      bakeStats.mainMs += now() - t;
      bakeStats.sync++;
      bakeStats.jobs++;
      return r;
    };
    // Fall back to synchronous generation if workers are unavailable
    // (older browsers, file:// origins, or a worker that failed to boot).
    if (this.failed) return Promise.resolve().then(local);
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, kind, name, size, seed, opts, resolve, reject };
      let w = this.idle.pop();
      if (!w && this.workers.length < this.size) w = this._spawn();
      if (!w) {
        if (this.failed) { resolve(local()); return; }
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

function rgbToTexture(rgba, size) {
  // Generators emit RGBA directly, so this is a wrap, not a repack. It used to
  // widen an RGB buffer here — twenty size²-element loops and twenty fresh
  // multi-megabyte allocations, all on the main thread during load.
  const tex = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  return applyCommon(tex);
}

function rgbaToTexture(rgba, size) {
  const tex = new THREE.DataTexture(rgba, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  return applyCommon(tex);
}

/**
 * Two-channel tangent-space normal. Z is reconstructed in the fragment shader
 * (see Materials.js), so this is RG8 — half the bytes of the RGBA8 it
 * replaces, across every material in the library.
 */
function normalToTexture(rg, size) {
  const tex = new THREE.DataTexture(rg, size, size, THREE.RGFormat);
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
    normalMap: normalToTexture(r.normal, r.size),
    ormMap: orm,
    aoMap: orm,
    roughnessMap: orm,
    metalnessMap: orm,
    detail: r.detail,
  };
}

// --------------------------------- API -------------------------------------

function keyFor(name, size, seed, opts) {
  return `${name}|${size}|${seed}|${opts.base ? opts.base.join(',') : ''}|${opts.normalStrength ?? ''}|${opts.tile ?? ''}`;
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

  const p = pool.run('surface', name, size, seed, opts).then((r) => {
    const t = now();
    const maps = toMaps(r);
    bakeStats.mainMs += now() - t;
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

// ----------------------------- detail normals ------------------------------

const detailCache = new Map();

/**
 * Bakes a micro-normal tile for one detail family. These are tiny (a few
 * centimetres of world per repeat) and shared by every material that names the
 * same family, so the whole library costs two or three of them.
 */
export function bakeDetailNormal(family, opts = {}) {
  const size = opts.size || 512;
  const seed = opts.seed ?? 5;
  const worldSize = opts.worldSize ?? 0.12;
  const amplitude = opts.amplitude ?? 0.0011;
  const key = `${family}|${size}|${seed}|${worldSize}|${amplitude}`;
  if (detailCache.has(key)) return detailCache.get(key);
  const p = pool.run('detail', family, size, seed, { worldSize, amplitude })
    .then((r) => {
      const t = now();
      const tex = normalToTexture(r.normal, r.size);
      bakeStats.mainMs += now() - t;
      return tex;
    });
  detailCache.set(key, p);
  return p;
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
  for (const p of detailCache.values()) Promise.resolve(p).then((t) => t && t.dispose());
  detailCache.clear();
  pool.dispose();
}
