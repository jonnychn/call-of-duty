// Deterministic noise primitives used by the procedural material library.
// Everything is seeded so a given material always bakes byte-identical maps.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERM = new Uint8Array(512);
(function buildPerm() {
  const rnd = mulberry32(1337);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

function grad2(hash, x, y) {
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

/** Tiling Perlin noise. `period` must be an integer for seamless wrap. */
export function perlin2(x, y, period = 256) {
  const X0 = Math.floor(x), Y0 = Math.floor(y);
  const xf = x - X0, yf = y - Y0;
  const u = fade(xf), v = fade(yf);
  // Wrap inlined rather than closed over: this is the single hottest function
  // in the whole bake (tens of millions of calls) and the per-call closure
  // allocation showed up as real time in the profile.
  const p = period;
  let w0 = X0 % p; if (w0 < 0) w0 += p;
  let w1 = (X0 + 1) % p; if (w1 < 0) w1 += p;
  let w2 = Y0 % p; if (w2 < 0) w2 += p;
  let w3 = (Y0 + 1) % p; if (w3 < 0) w3 += p;
  const xi = w0 & 255, yi = w2 & 255;
  const xi1 = w1 & 255, yi1 = w3 & 255;

  const aa = PERM[PERM[xi] + yi];
  const ab = PERM[PERM[xi] + yi1];
  const ba = PERM[PERM[xi1] + yi];
  const bb = PERM[PERM[xi1] + yi1];

  const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v); // roughly [-1,1]
}

/** Fractal Brownian motion over tiling Perlin. Returns [0,1]. */
export function fbm2(x, y, { octaves = 5, lacunarity = 2, gain = 0.5, period = 64 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * perlin2(x * freq, y * freq, period * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm * 0.5 + 0.5;
}

/** Ridged multifractal — good for cracks, rock, chipped paint edges. */
export function ridged2(x, y, { octaves = 5, lacunarity = 2, gain = 0.5, period = 64 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(perlin2(x * freq, y * freq, period * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Tiling Worley/cellular noise. Returns { f1, f2, id }, distances in cell units.
 * Hand-inlined hashing (no closures) — this runs tens of millions of times
 * during a texture bake and allocation here dominates the profile.
 */
export function worley2(x, y, period = 8, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = Infinity, f2 = Infinity, id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      let h = (Math.imul(wx, 73856093) ^ Math.imul(wy, 19349663) ^ Math.imul(seed, 83492791)) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
      h = (h ^ (h >>> 16)) >>> 0;
      const rx = (h & 0xffff) / 65536;
      const ry = (h >>> 16) / 65536;
      const ddx = cx + rx - x, ddy = cy + ry - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) { f2 = f1; f1 = d; id = h; }
      else if (d < f2) { f2 = d; }
    }
  }
  return { f1, f2, id };
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const mix = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Additional primitives for the multi-scale material library.
// Everything here is integer-lattice hashed and period-wrapped so the result
// tiles exactly, and allocation-free so it can run per-texel at 2048².
// ---------------------------------------------------------------------------

/** Fast 2D integer hash -> [0,1). */
export function hash2(x, y, seed = 0) {
  let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(seed | 0, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Second independent channel of the same hash (avoids a second call cost). */
export function hash2b(x, y, seed = 0) {
  return hash2(x, y, (seed | 0) + 0x9e3779b9);
}

/**
 * Tiling value noise. Cheaper than Perlin (no gradient dot products) which
 * matters a great deal for the micro-grain octaves that must run at full
 * texture resolution.
 */
export function value2(x, y, period = 64, seed = 0) {
  const X0 = Math.floor(x), Y0 = Math.floor(y);
  const xf = x - X0, yf = y - Y0;
  const u = fade(xf), v = fade(yf);
  const p = period | 0;
  const x0 = ((X0 % p) + p) % p, y0 = ((Y0 % p) + p) % p;
  const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Fractal value noise, [0,1]. */
export function vfbm2(x, y, { octaves = 4, lacunarity = 2, gain = 0.5, period = 64, seed = 0 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * value2(x * freq, y * freq, period * freq, seed + i * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// --------------------------- cached warp fields ----------------------------
//
// The warp offset is, by definition, a LOW frequency field: `warpFreq` is a
// fraction of the base frequency, so over one tile it carries only a handful
// of cycles. Evaluating it as two 3-octave fbms *per sample* — six octaves of
// Perlin to produce a value that barely changes between neighbouring texels —
// was costing more than the warped noise it feeds. It dominated the bake:
// 1.5 s of concrete's 2.1 s went into three warped bands.
//
// So it is tabulated once per (period, warpFreq, tag) on a small grid and
// sampled with a wrapping quintic filter. A 128² table over ~4 cycles is 32
// samples per cycle, far beyond what the offset needs to stay smooth, and the
// table is shared by every band and every surface that asks for the same
// warp geometry.
//
// A side effect is a genuine correctness fix. The old code used the requested
// `warpFreq` while giving the underlying fbm the *rounded* period `wp`, so the
// warp field did not actually close across the tile (warpFreq 0.6 on period 7
// spans 4.2 units of a 4-periodic field) and left a faint seam in every warped
// surface. The table spans exactly `wp` units, so it wraps exactly.

const WARP_RES = 128;
const warpCache = new Map();

function warpTable(period, warpFreq, ox1, oy1, ox2, oy2, tag) {
  const wp = Math.max(1, Math.round(period * warpFreq));
  const key = `${tag}|${wp}`;
  let t = warpCache.get(key);
  if (t) return t;
  const N = WARP_RES;
  const qx = new Float32Array(N * N), qy = new Float32Array(N * N);
  const step = wp / N;
  for (let j = 0; j < N; j++) {
    const v = j * step;
    for (let i = 0; i < N; i++) {
      const u = i * step;
      qx[j * N + i] = fbm2(u + ox1, v + oy1, { octaves: 3, period: wp }) - 0.5;
      qy[j * N + i] = fbm2(u + ox2, v + oy2, { octaves: 3, period: wp }) - 0.5;
    }
  }
  t = { qx, qy, N };
  if (warpCache.size > 48) warpCache.clear();
  warpCache.set(key, t);
  return t;
}

/** Wrapping quintic-weighted sample of a warp table at unit-tile (u, v). */
function warpSample(arr, N, gx, gy) {
  let i0 = Math.floor(gx), j0 = Math.floor(gy);
  const tx = fade(gx - i0), ty = fade(gy - j0);
  i0 %= N; if (i0 < 0) i0 += N;
  j0 %= N; if (j0 < 0) j0 += N;
  const i1 = i0 + 1 === N ? 0 : i0 + 1;
  const r0 = j0 * N, r1 = (j0 + 1 === N ? 0 : j0 + 1) * N;
  const a = arr[r0 + i0], b = arr[r0 + i1];
  const c = arr[r1 + i0], d = arr[r1 + i1];
  const top = a + (b - a) * tx, bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

/**
 * Domain-warped fbm. A single warp iteration is what separates "procedural
 * noise" from "a photograph of a surface": it destroys the axis-aligned
 * lattice signature of Perlin and produces the swirled, flow-like structure
 * real weathering has.
 */
export function warpFbm2(x, y, { octaves = 5, period = 64, warp = 0.5, warpFreq = 0.5 } = {}) {
  const t = warpTable(period, warpFreq, 3.7, 1.3, -2.1, 5.9, 'f');
  const gx = (x / period) * t.N, gy = (y / period) * t.N;
  const qx = warpSample(t.qx, t.N, gx, gy);
  const qy = warpSample(t.qy, t.N, gx, gy);
  return fbm2(x + qx * warp, y + qy * warp, { octaves, period });
}

/** Domain-warped ridged noise — cracks that meander instead of running straight. */
export function warpRidged2(x, y, { octaves = 4, period = 64, warp = 0.4, warpFreq = 0.5 } = {}) {
  const t = warpTable(period, warpFreq, 11.2, -4.4, -8.8, 7.1, 'r');
  const gx = (x / period) * t.N, gy = (y / period) * t.N;
  const qx = warpSample(t.qx, t.N, gx, gy);
  const qy = warpSample(t.qy, t.N, gx, gy);
  return ridged2(x + qx * warp, y + qy * warp, { octaves, period });
}

/**
 * Tiling Worley variant that also returns the offset from the cell centre and
 * a per-cell random. Needed for scattered elements (pebbles, aggregate,
 * gravel) where each cell must be shaded as its own little object.
 * Writes into `out` (length >= 5) to stay allocation-free.
 * out = [f1, f2, cellRandom, dxFromCentre, dyFromCentre]
 */
export function worleyCell(x, y, period, seed, out) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = Infinity, f2 = Infinity, best = 0, bdx = 0, bdy = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      let h = (Math.imul(wx, 73856093) ^ Math.imul(wy, 19349663) ^ Math.imul(seed, 83492791)) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
      h = (h ^ (h >>> 16)) >>> 0;
      const rx = (h & 0xffff) / 65536;
      const ry = (h >>> 16) / 65536;
      const ddx = cx + rx - x, ddy = cy + ry - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) { f2 = f1; f1 = d; best = ((h >>> 8) & 0xffff) / 65536; bdx = ddx; bdy = ddy; }
      else if (d < f2) { f2 = d; }
    }
  }
  out[0] = f1; out[1] = f2; out[2] = best; out[3] = bdx; out[4] = bdy;
  return out;
}

/**
 * Single-cell scattered points: one jittered point per grid cell, jitter
 * confined to the middle half of the cell so any feature with a radius up to
 * a quarter of a cell is guaranteed to lie inside it.
 *
 * That constraint is what lets this skip the 3×3 neighbourhood a real Worley
 * lookup needs, which makes it roughly nine times cheaper. For *scattered*
 * features — blowholes, pebbles, specks, rivets — that is all we ever needed;
 * full Worley is only required when the cells have to partition the plane.
 * out = [distance, cellRandom, dx, dy]
 */
export function scatter2(x, y, period, seed, out) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const wx = ((xi % period) + period) % period;
  const wy = ((yi % period) + period) % period;
  let h = (Math.imul(wx, 73856093) ^ Math.imul(wy, 19349663) ^ Math.imul(seed, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  const rx = 0.25 + (h & 0x7ff) * (0.5 / 2048);
  const ry = 0.25 + ((h >>> 11) & 0x7ff) * (0.5 / 2048);
  const dx = x - xi - rx, dy = y - yi - ry;
  out[0] = Math.sqrt(dx * dx + dy * dy);
  out[1] = ((h >>> 22) & 0x3ff) * (1 / 1024);
  out[2] = dx; out[3] = dy;
  return out;
}

/** Distance to the nearest Worley cell *edge* — clean mortar lines, crazing. */
export function worleyEdge(x, y, period, seed) {
  const w = worley2(x, y, period, seed);
  return w.f2 - w.f1;
}

/** Signed triangle wave in [0,1], period 1. Seamless for any integer freq. */
export function tri(t) {
  const f = t - Math.floor(t);
  return f < 0.5 ? f * 2 : 2 - f * 2;
}

export const saturate = clamp01;
export const smootherstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
