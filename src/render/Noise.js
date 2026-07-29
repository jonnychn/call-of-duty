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
