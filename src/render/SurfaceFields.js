import { clamp01 } from './Noise.js';

// ---------------------------------------------------------------------------
// Scale-aware field machinery for the surface library.
//
// Two ideas drive this file:
//
//  1. Real surfaces are built from three bands of detail — macro (metres),
//     meso (centimetres) and micro (millimetres). Evaluating all three at full
//     texture resolution is wasteful: a macro fbm at 2048² costs the same as a
//     micro one but carries a hundredth of the information. `lowField` renders
//     the slow bands at a fraction of the resolution and interpolates them up,
//     which is where most of the bake budget is recovered.
//
//  2. Normals and occlusion should be derived in *world units*, not in
//     arbitrary "strength" multipliers. Every generator declares a physical
//     height amplitude in metres and a tile size in metres, so a 3 mm
//     aggregate pit produces the same slope whether the tile is 512² or 2048².
// ---------------------------------------------------------------------------

const wrap = (v, n) => ((v % n) + n) % n;
const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Evaluates `fn(u, v)` on a `low`×`low` grid over the unit tile and
 * interpolates it up to `size`×`size` with wrapping quintic interpolation
 * (quintic rather than linear so no bilinear diamond creases survive into the
 * normal map — a linear upsample of a macro field is instantly visible once
 * you differentiate it).
 */
export function lowField(size, low, fn) {
  low = Math.min(low, size);
  const src = new Float32Array(low * low);
  const inv = 1 / low;
  for (let y = 0; y < low; y++) {
    for (let x = 0; x < low; x++) src[y * low + x] = fn(x * inv, y * inv);
  }
  if (low === size) return src;
  return upsampleWrap(src, low, size);
}

/** Wrapping quintic-weighted bilinear upsample of a square field. */
export function upsampleWrap(src, low, size) {
  const out = new Float32Array(size * size);
  const scale = low / size;
  const xi = new Int32Array(size), xi1 = new Int32Array(size);
  const xw = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const fx = x * scale;
    const i0 = Math.floor(fx);
    xi[x] = wrap(i0, low);
    xi1[x] = wrap(i0 + 1, low);
    xw[x] = quintic(fx - i0);
  }
  for (let y = 0; y < size; y++) {
    const fy = y * scale;
    const j0 = Math.floor(fy);
    const r0 = wrap(j0, low) * low, r1 = wrap(j0 + 1, low) * low;
    const wy = quintic(fy - j0);
    const o = y * size;
    for (let x = 0; x < size; x++) {
      const a = src[r0 + xi[x]], b = src[r0 + xi1[x]];
      const c = src[r1 + xi[x]], d = src[r1 + xi1[x]];
      const t = xw[x];
      const top = a + (b - a) * t, bot = c + (d - c) * t;
      out[o + x] = top + (bot - top) * wy;
    }
  }
  return out;
}

/** Box-downsample a square field by an integer factor. */
export function downsample(src, size, factor) {
  const n = (size / factor) | 0;
  const out = new Float32Array(n * n);
  const inv = 1 / (factor * factor);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let j = 0; j < factor; j++) {
        const row = (y * factor + j) * size + x * factor;
        for (let i = 0; i < factor; i++) s += src[row + i];
      }
      out[y * n + x] = s * inv;
    }
  }
  return out;
}

/**
 * Separable wrapping box blur. Radius in texels.
 *
 * The wrap indices are precomputed into a table rather than recomputed with a
 * double modulo per sample: at 1024² this loop runs eight million times per
 * bake and the modulo was costing more than the blur itself.
 */
export function blurWrap(src, size, radius) {
  const r = Math.max(1, radius | 0);
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  const inv = 1 / (2 * r + 1);
  // idx[k] maps k in [-size, 2*size) to a wrapped index
  const idx = new Int32Array(size * 3);
  for (let k = 0; k < size * 3; k++) idx[k] = (k - size) % size < 0 ? ((k - size) % size) + size : (k - size) % size;
  const W = (k) => idx[k + size];

  for (let y = 0; y < size; y++) {
    const row = y * size;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + W(k)];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = acc * inv;
      acc += src[row + W(x + r + 1)] - src[row + W(x - r)];
    }
  }
  for (let x = 0; x < size; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[W(k) * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = acc * inv;
      acc += tmp[W(y + r + 1) * size + x] - tmp[W(y - r) * size + x];
    }
  }
  return out;
}

// ------------------------------- normals -----------------------------------

/**
 * Derives a tangent-space normal from a height field using world units.
 *
 * `amplitude` is the peak-to-peak height of the field in metres and
 * `tileMeters` the world size of one texture repeat, so the slope we hand to
 * the shader is the real slope of the real surface. A 4-tap central difference
 * is combined with a wider 8-tap ring: the narrow tap keeps the micro detail
 * crisp, the wide tap recovers the low-frequency form that a 1-texel
 * difference is too noisy to see. That mix is what stops procedural normal
 * maps reading as static.
 */
export function heightToNormalWorld(height, size, amplitude, tileMeters, boost = 1.0) {
  // Two channels, not four. A tangent-space normal is a unit vector with a
  // positive Z, so Z is fully determined by X and Y and storing it is pure
  // waste — and the alpha next to it is waste twice over. The shader that
  // samples this is ours (Materials.js replaces <normal_fragment_maps>
  // outright for the detail-normal blend), so it can do the one sqrt that
  // buys back a third of the normal map's memory.
  const data = new Uint8Array(size * size * 2);
  const texelMeters = tileMeters / size;
  // d(height in metres) / d(distance in metres) for a 1-texel central diff
  const k = (amplitude / (2 * texelMeters)) * boost;
  const k2 = (amplitude / (4 * texelMeters)) * boost * 0.6;
  for (let y = 0; y < size; y++) {
    const ym = wrap(y - 1, size) * size, yp = wrap(y + 1, size) * size;
    const ym2 = wrap(y - 2, size) * size, yp2 = wrap(y + 2, size) * size;
    const y0 = y * size;
    for (let x = 0; x < size; x++) {
      const xm = wrap(x - 1, size), xp = wrap(x + 1, size);
      const xm2 = wrap(x - 2, size), xp2 = wrap(x + 2, size);
      const dx = (height[y0 + xp] - height[y0 + xm]) * k + (height[y0 + xp2] - height[y0 + xm2]) * k2;
      const dy = (height[yp + x] - height[ym + x]) * k + (height[yp2 + x] - height[ym2 + x]) * k2;
      const nx = -dx, ny = -dy;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y0 + x) * 2;
      data[i] = (nx * inv * 127.5 + 127.5) | 0;
      data[i + 1] = (ny * inv * 127.5 + 127.5) | 0;
    }
  }
  return data;
}

// ------------------------------- occlusion ---------------------------------

// Eight directions is the standard HBAO tap count and is where the quality
// curve flattens: the march is O(dirs × steps) per work texel and dropping
// from twelve to eight took a fifth off the whole library's bake with no
// visible change in the occlusion — the result is low-frequency by
// construction and the micro term below carries everything sharp.
const HAO_DIRS = 8;
const DIR_COS = new Float32Array(HAO_DIRS);
const DIR_SIN = new Float32Array(HAO_DIRS);
for (let i = 0; i < HAO_DIRS; i++) {
  const a = (i / HAO_DIRS) * Math.PI * 2 + 0.37;
  DIR_COS[i] = Math.cos(a); DIR_SIN[i] = Math.sin(a);
}

/**
 * Horizon-based ambient occlusion in texture space.
 *
 * For each texel we march outwards in `HAO_DIRS` directions and track the
 * steepest rise seen; the sine of that horizon angle is the fraction of the
 * hemisphere blocked in that direction. Averaged over directions this is a
 * genuine cavity term — deep narrow cracks go properly dark, broad shallow
 * dishes barely darken at all — which a blur difference can never express,
 * because a blur difference only knows "am I below my neighbourhood mean".
 *
 * The horizon march runs on a downsampled copy (cavity occlusion is inherently
 * low frequency and this is an O(n²·dirs·steps) loop); a separate micro term
 * derived at full resolution puts the fine pitting back.
 */
export function horizonAO(height, size, amplitude, tileMeters, opts = {}) {
  const {
    radiusTexels = 11,
    steps = 6,
    strength = 1.0,
    microStrength = 0.55,
    workSize = 320,
  } = opts;

  // The march radius is expressed in texels of the work grid, not in metres.
  // Metres look more principled but are a trap: a 4.5 cm radius on a 5 m tile
  // downsampled to 256 is two texels, so the horizon search sees almost
  // nothing and the whole map comes back white. Texels keep the search a
  // fixed fraction of the tile no matter how much world the tile covers.
  const factor = Math.max(1, Math.round(size / Math.min(workSize, size)));
  const n = (size / factor) | 0;
  const h = factor > 1 ? downsample(height, size, factor) : height;
  const texelM = tileMeters / n;
  const maxR = Math.max(3, Math.min(radiusTexels, n >> 3));

  const ao = new Float32Array(n * n);
  // Step radii follow a square-ish distribution: dense near the centre where
  // contact darkening lives, sparse further out.
  const radii = new Float32Array(steps);
  for (let s = 0; s < steps; s++) radii[s] = Math.max(1, Math.round(maxR * Math.pow((s + 1) / steps, 1.7)));

  // Flatten the march into offset tables: a direction/step pair is a fixed
  // (dx, dy, 1/distance) triple, so the trig and the division come out of the
  // innermost loop entirely.
  const TAPS = HAO_DIRS * steps;
  const offX = new Int32Array(TAPS), offY = new Int32Array(TAPS);
  const invD = new Float32Array(TAPS);
  for (let d = 0; d < HAO_DIRS; d++) {
    for (let s = 0; s < steps; s++) {
      const r = radii[s], t = d * steps + s;
      offX[t] = Math.round(DIR_COS[d] * r);
      offY[t] = Math.round(DIR_SIN[d] * r);
      invD[t] = 1 / (r * texelM);
    }
  }
  const wrapX = new Int32Array(n * 3);
  for (let k = 0; k < n * 3; k++) { const m = (k - n) % n; wrapX[k] = m < 0 ? m + n : m; }

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const h0 = h[y * n + x] * amplitude;
      let occ = 0, t = 0;
      for (let d = 0; d < HAO_DIRS; d++) {
        let maxSlope = 0;
        for (let s = 0; s < steps; s++, t++) {
          const sx = wrapX[x + offX[t] + n];
          const sy = wrapX[y + offY[t] + n];
          const dh = h[sy * n + sx] * amplitude - h0;
          if (dh > 0) {
            const slope = dh * invD[t];
            if (slope > maxSlope) maxSlope = slope;
          }
        }
        // sin(atan(m)) — the fraction of that direction's hemisphere occluded
        occ += maxSlope / Math.sqrt(1 + maxSlope * maxSlope);
      }
      ao[y * n + x] = clamp01(1 - (occ / HAO_DIRS) * strength);
    }
  }

  const coarse = factor > 1 ? upsampleWrap(ao, n, size) : ao;

  // Micro cavity: fine pits below their immediate neighbourhood. Radius is
  // deliberately tiny (a few texels) so this only catches detail the horizon
  // march downsampled away.
  const microR = Math.max(2, size >> 8);
  const local = blurWrap(height, size, microR);
  const out = new Float32Array(size * size);
  // Height-field units, not metres: this term is about how far a texel sits
  // below its immediate neighbourhood relative to the field's own range, which
  // is exactly what a pore or a mortar joint is.
  const microK = 2.4 * microStrength;
  for (let i = 0; i < out.length; i++) {
    const dip = local[i] - height[i];
    const micro = dip > 0 ? clamp01(1 - dip * microK) : 1;
    out[i] = clamp01(coarse[i] * micro);
  }
  return out;
}
