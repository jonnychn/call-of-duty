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
  const wrap = (v) => ((v % period) + period) % period;
  const X0 = Math.floor(x), Y0 = Math.floor(y);
  const xf = x - X0, yf = y - Y0;
  const u = fade(xf), v = fade(yf);
  const xi = wrap(X0) & 255, yi = wrap(Y0) & 255;
  const xi1 = wrap(X0 + 1) & 255, yi1 = wrap(Y0 + 1) & 255;

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

/**
 * Domain-warped fbm. A single warp iteration is what separates "procedural
 * noise" from "a photograph of a surface": it destroys the axis-aligned
 * lattice signature of Perlin and produces the swirled, flow-like structure
 * real weathering has.
 */
export function warpFbm2(x, y, { octaves = 5, period = 64, warp = 0.5, warpFreq = 0.5, seed = 0 } = {}) {
  const wp = Math.max(1, Math.round(period * warpFreq));
  const qx = fbm2(x * warpFreq + 3.7, y * warpFreq + 1.3, { octaves: 3, period: wp }) - 0.5;
  const qy = fbm2(x * warpFreq - 2.1, y * warpFreq + 5.9, { octaves: 3, period: wp }) - 0.5;
  return fbm2(x + qx * warp, y + qy * warp, { octaves, period });
}

/** Domain-warped ridged noise — cracks that meander instead of running straight. */
export function warpRidged2(x, y, { octaves = 4, period = 64, warp = 0.4, warpFreq = 0.5 } = {}) {
  const wp = Math.max(1, Math.round(period * warpFreq));
  const qx = fbm2(x * warpFreq + 11.2, y * warpFreq - 4.4, { octaves: 3, period: wp }) - 0.5;
  const qy = fbm2(x * warpFreq - 8.8, y * warpFreq + 7.1, { octaves: 3, period: wp }) - 0.5;
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
