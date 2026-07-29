import {
  fbm2, ridged2, worley2, worleyCell, value2, vfbm2, warpFbm2, warpRidged2,
  hash2, tri, scatter2, clamp01, smoothstep, smootherstep, mix,
} from './Noise.js';
import { heightToNormalWorld, horizonAO } from './SurfaceFields.js';

// ---------------------------------------------------------------------------
// Pure, dependency-free surface synthesis. Shared verbatim between the main
// thread and the bake worker pool — must never import three.js or touch DOM.
//
// House rules for every generator in this file:
//
//   * Tile space is the unit square. A frequency F means "F cycles across one
//     tile"; pass the same integer as the noise period and the result wraps
//     exactly. No 8/size fudge factors.
//
//   * Three detail bands, always. MACRO (metres — which part of the wall am I
//     on), MESO (centimetres — the material's actual structure) and MICRO
//     (millimetres — grain, pores, weave). A surface with only one band looks
//     soft up close and obviously tiled far away.
//
//   * Continuous noise is evaluated into a low-resolution `band` and sampled
//     back with a wrapped quintic filter; *thresholds are applied at full
//     resolution*. This is the key trick that makes the bake affordable:
//     the sharpness of a crack comes from the smoothstep, not from the
//     resolution of the noise underneath it, so a 512² band produces a
//     pixel-crisp crack in a 2048² map at a sixteenth of the cost.
//
//   * Roughness is a first-class output, not a tint of the albedo. Wet, worn,
//     polished, dusty and freshly broken are all roughness statements, and
//     roughness does more visual work than albedo on nearly every surface.
//
//   * `amplitude` is the real peak-to-peak height of the field in metres.
//     Normals and occlusion are derived from it in world units, so the same
//     generator gives the same physical slopes at any texture resolution.
// ---------------------------------------------------------------------------

const CELL = new Float32Array(5);
const MACRO = 64;                       // macro band resolution
const mesoRes = (size) => Math.min(512, Math.max(128, size >> 1));

const quint = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Evaluates `fn(u,v)` over the unit tile into an n×n band. */
function band(n, fn) {
  const d = new Float32Array(n * n);
  const inv = 1 / n;
  for (let y = 0; y < n; y++) {
    const v = y * inv;
    for (let x = 0; x < n; x++) d[y * n + x] = fn(x * inv, v);
  }
  return { d, n, cv: -1, ty: 0, r0: 0, r1: 0 };
}

/**
 * Wrapped quintic-weighted bilinear sample of a band at unit-tile (u,v).
 *
 * Generators iterate y on the outside, so the row indices and the vertical
 * weight are identical for every texel in a scanline. They are cached on the
 * band and recomputed only when v changes, which halves the cost of a lookup —
 * and with eight or nine bands live in an inner loop, band sampling is
 * otherwise the second largest line in the profile after Worley.
 */
function bs(b, u, v) {
  const n = b.n, d = b.d;
  if (b.cv !== v) {
    const fy = v * n - 0.5;
    let iy = fy | 0; if (fy < 0) iy -= 1;
    b.ty = quint(fy - iy);
    let y0 = iy % n; if (y0 < 0) y0 += n;
    b.r0 = y0 * n;
    b.r1 = (y0 + 1 === n ? 0 : y0 + 1) * n;
    b.cv = v;
  }
  const fx = u * n - 0.5;
  let ix = fx | 0; if (fx < 0) ix -= 1;
  const tx = quint(fx - ix);
  let x0 = ix % n; if (x0 < 0) x0 += n;
  const x1 = x0 + 1 === n ? 0 : x0 + 1;
  const r0 = b.r0, r1 = b.r1;
  const a = d[r0 + x0], b1 = d[r0 + x1];
  const c = d[r1 + x0], e = d[r1 + x1];
  const top = a + (b1 - a) * tx, bot = c + (e - c) * tx;
  return top + (bot - top) * b.ty;
}

// --------------------------- micro-grain tiles -----------------------------
//
// The millimetre band is, by construction, high-frequency low-amplitude noise
// with no large-scale structure at all. Evaluating a three-octave fbm per
// texel for it costs more than the whole rest of a generator and buys nothing,
// because nothing about the result depends on *where* on the tile you are.
//
// So it is precomputed once into two small tiles and indexed directly. The
// tile sizes are coprime primes, so the summed pattern only repeats after
// 251×199 ≈ 50k texels — far beyond any texture we bake — while each
// individual tile is itself seamless.

const MA_N = 251, MB_N = 199;
const microCache = new Map();

function buildMicro(n, seed, freq, octaves) {
  const d = new Float32Array(n * n);
  const inv = 1 / n;
  for (let y = 0; y < n; y++) {
    const v = y * inv;
    for (let x = 0; x < n; x++) d[y * n + x] = vfbm2(x * inv * freq, v * freq, { octaves, period: freq, seed });
  }
  return d;
}

/**
 * Direct index into a micro tile. `sx`/`sy` are texel coordinates and may be
 * strided to make the grain anisotropic — stepping x four times faster than y
 * is how the mill lines on rolled steel and the fibre of sawn timber are made,
 * for the price of one extra multiply.
 */
function mA(m, sx, sy) { return m.A[(sy % MA_N) * MA_N + (sx % MA_N)]; }
function mB(m, sx, sy) { return m.B[(sy % MB_N) * MB_N + (sx % MB_N)]; }

/** Two decorrelated micro-noise tiles: A is coarser grain, B is fine grit. */
function micro(seed) {
  let m = microCache.get(seed);
  if (!m) {
    m = { A: buildMicro(MA_N, seed, 62, 3), B: buildMicro(MB_N, seed + 977, 46, 2) };
    if (microCache.size > 24) microCache.clear();
    microCache.set(seed, m);
  }
  return m;
}

// ------------------------------ stone masks --------------------------------

const ROT_C = new Float32Array(8), ROT_S = new Float32Array(8);
for (let i = 0; i < 8; i++) { const a = i * 0.3927 + 0.11; ROT_C[i] = Math.cos(a); ROT_S[i] = Math.sin(a); }

/**
 * Coverage mask for one angular stone, given the offset from its cell point.
 *
 * A plain radial falloff gives perfect circles, and a field of perfect circles
 * reads as bubble wrap no matter how good the shading on it is — it was the
 * single most damaging artefact in the first pass of the aggregate surfaces.
 * Crushed stone is angular, so the distance metric is an octagonal norm on a
 * per-stone rotated, per-stone elongated frame, with the outline further
 * broken up by the surface's own micro grain. Rotations come from an
 * eight-entry table indexed by the cell random: a per-texel sin/cos would cost
 * more than everything else in the loop put together.
 *
 * @param jag  outline perturbation, normally (micro - 0.5) * r
 */
function stoneMask(dx, dy, id, r, jag) {
  const k = (id * 8) & 7;
  const ca = ROT_C[k], sa = ROT_S[k];
  const asp = 0.70 + id * 0.66;
  const ax = Math.abs(dx * ca - dy * sa) * asp;
  const ay = Math.abs(dx * sa + dy * ca) / asp;
  const d = Math.max(ax, ay, (ax + ay) * 0.71) + jag;
  return 1 - smoothstep(r * 0.74, r, d);
}

function lerp3(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

function planes(size) {
  return {
    rgb: new Uint8Array(size * size * 3),
    height: new Float32Array(size * size),
    rough: new Float32Array(size * size),
    metal: new Float32Array(size * size),
  };
}

function writeRGB(rgb, i, r, g, b) {
  rgb[i * 3] = clamp01(r) * 255;
  rgb[i * 3 + 1] = clamp01(g) * 255;
  rgb[i * 3 + 2] = clamp01(b) * 255;
}

// ===========================================================================
//                             surface generators
// ===========================================================================

const SURFACES = {

  // -------------------------------------------------------------------------
  /**
   * Poured concrete. Macro: pour bands, damp patches, airborne grime falling
   * down the wall. Meso: exposed aggregate, trowel sweep, shrinkage crazing
   * and structural cracking. Micro: cement paste grain and pinhole porosity.
   */
  /**
   * Board-formed concrete.
   *
   * The tells that make concrete read as concrete, in order of how much work
   * they do: blowholes (the small round air voids left against the formwork),
   * vertical run-off staining, the horizontal form-board joints, and spalled
   * patches where the face has broken away to expose aggregate. Isotropic
   * warped noise — the obvious thing to reach for — gives none of those and
   * lands somewhere between camouflage and a cloud texture.
   */
  concrete: {
    amplitude: 0.014, tile: 2.5, detail: 'grain',
    ao: { radiusTexels: 14, strength: 1.7, microStrength: 1.1 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      // MACRO. Staining on a wall is made by water, so it runs downwards:
      // high frequency across, very low frequency down.
      const stainB = band(MACRO, (u, v) => fbm2(u * 12, v * 1.4, { octaves: 4, period: 12 }));
      const dampB = band(MACRO, (u, v) => fbm2(u * 3, v * 2, { octaves: 4, period: 3 }));
      const mottleB = band(MACRO, (u, v) => fbm2(u * 5, v * 5, { octaves: 4, period: 5 }));
      const tonalB = band(32, (u, v) => fbm2(u * 2, v * 2, { octaves: 3, period: 2 }));
      const jointB = band(64, (u, v) => fbm2(u * 9, v * 3, { octaves: 3, period: 9 }));
      const spallB = band(M, (u, v) => warpFbm2(u * 7, v * 7, { octaves: 4, period: 7, warp: 0.7, warpFreq: 0.6 }));
      const crackB = band(M, (u, v) => warpRidged2(u * 13, v * 13, { octaves: 5, period: 13, warp: 0.6, warpFreq: 0.35 }));
      const crazeB = band(M, (u, v) => warpRidged2(u * 60, v * 60, { octaves: 3, period: 60, warp: 0.3, warpFreq: 0.25 }));

      const dry = [0.510, 0.503, 0.487];
      const wet = [0.175, 0.176, 0.182];
      const c = [0, 0, 0], aggC = [0, 0, 0];
      const BOARDS = 2;                       // form boards per tile
      const mic = micro(seed);
      const mA = mic.A, mB = mic.B;

      for (let y = 0; y < size; y++) {
        const v = y / size;
        // form-board joint: a shallow recessed line with a tone step across it
        const bRow = Math.floor(v * BOARDS);
        const bF = v * BOARDS - bRow;
        const boardTone = (hash2(0, bRow, seed + 3) - 0.5) * 0.16;
        const rowA = (y % MA_N) * MA_N, rowB = (y % MB_N) * MB_N;
        let xa = 0, xb = 0;

        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          const grain = mA[rowA + xa], fine = mB[rowB + xb];
          if (++xa === MA_N) xa = 0;
          if (++xb === MB_N) xb = 0;

          // MESO — blowholes. Round air voids against the formwork: sparse,
          // wildly varied in size, with a spherical-cap depth profile. Density
          // is the thing to get right — one in six cells, not one in three,
          // or the wall turns into a golf ball.
          scatter2(u * 44, v * 44, 44, seed, CELL);
          const bhId = CELL[1];
          const bhR = 0.045 + (bhId - 0.82) * 1.30;
          const bh = bhId > 0.82 && CELL[0] < bhR
            ? Math.sqrt(Math.max(0, bhR * bhR - CELL[0] * CELL[0])) / bhR : 0;
          scatter2(u * 130, v * 130, 130, seed + 17, CELL);
          const bh2 = CELL[1] > 0.80 && CELL[0] < 0.17 ? 1 - smoothstep(0.05, 0.17, CELL[0]) : 0;

          // spalled patch: the face has broken off, exposing the aggregate.
          // The aggregate Worley is only evaluated inside a spall — it is the
          // single most expensive call in the generator and it is invisible
          // over the ~95% of the tile that is intact.
          const spallRaw = bs(spallB, u, v);
          const spall = smoothstep(0.660, 0.700, spallRaw);
          let aggId = 0, aggBody = 0, agg = 0;
          if (spall > 0.002) {
            worleyCell(u * 70, v * 70, 70, seed + 29, CELL);
            aggId = CELL[2];
            aggBody = 1 - smoothstep(0.16, 0.34, CELL[0]);
            agg = aggBody * spall;
          }

          const craze = smoothstep(0.905, 0.985, bs(crazeB, u, v));
          const crack = smoothstep(0.885, 0.968, bs(crackB, u, v));

          // the form joint wobbles and fades along its length; a dead-straight
          // 1-texel line is the most mechanical mark a texture can carry
          const jw = (bs(jointB, u, v) - 0.5) * 0.10;
          const joint = (1 - smoothstep(0.004, 0.026, Math.abs(Math.min(bF, 1 - bF) + jw)))
            * (0.35 + bs(jointB, u * 1.7, v) * 0.85);
          const st = bs(stainB, u, v), dm = bs(dampB, u, v), mo = bs(mottleB, u, v), tn = bs(tonalB, u, v);

          height[i] = clamp01(0.62
            + (mo - 0.5) * 0.10
            + boardTone * 0.6
            + (grain - 0.5) * 0.05 + (fine - 0.5) * 0.035
            - bh * 0.62 - bh2 * 0.30
            - spall * 0.42 + agg * 0.40
            - joint * 0.55
            - craze * 0.26
            - crack * 0.80);

          // Value range is what separates a photograph from a noise field.
          // Metre-scale tonal drift, decimetre mottling and millimetre grain
          // all push on the same shade term, deliberately hard.
          const shade = 0.66 + tn * 0.34 + mo * 0.40 + boardTone + (grain - 0.5) * 0.30 + (fine - 0.5) * 0.16;
          c[0] = dry[0] * shade; c[1] = dry[1] * shade; c[2] = dry[2] * shade;
          // exposed aggregate: every stone a different stone
          aggC[0] = 0.26 + aggId * 0.44; aggC[1] = 0.25 + aggId * 0.42; aggC[2] = 0.24 + aggId * 0.37;
          // the fresh fracture face is lighter and chalkier than the weathered
          // skin, and its rim catches a hard shadow
          const spallRim = smoothstep(0.648, 0.663, spallRaw) * (1 - smoothstep(0.666, 0.684, spallRaw));
          lerp3(c, c, [0.400, 0.386, 0.362], spall * 0.9);
          lerp3(c, c, aggC, agg * 0.95);
          const rimK = spallRim * 0.34;
          c[0] *= 1 - rimK; c[1] *= 1 - rimK; c[2] *= 1 - rimK;
          // vertical run-off staining, strongest under the form joints
          const stain = smoothstep(0.50, 0.86, st) * (0.55 + smoothstep(0.0, 0.25, bF) * 0.45);
          c[0] *= 1 - stain * 0.36; c[1] *= 1 - stain * 0.345; c[2] *= 1 - stain * 0.30;
          const wetK = smoothstep(0.60, 0.86, dm) * 0.85;
          lerp3(c, c, wet, wetK);
          // efflorescence — pale salt bloom at the fringe of the damp
          const eff = smoothstep(0.50, 0.58, dm) * (1 - smoothstep(0.62, 0.72, dm));
          c[0] = mix(c[0], 0.76, eff * 0.40); c[1] = mix(c[1], 0.75, eff * 0.40); c[2] = mix(c[2], 0.74, eff * 0.40);
          // voids and fractures are dark because they are holes
          const dk = crack * 0.66 + craze * 0.30 + bh * 0.55 + bh2 * 0.35 + joint * 0.45;
          c[0] *= 1 - dk; c[1] *= 1 - dk; c[2] *= 1 - dk;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          // Roughness does more work here than albedo: chalky dry paste at
          // 0.95, polished aggregate faces at 0.45, wet at 0.20.
          let r = 0.95 - (grain - 0.5) * 0.14;
          r = mix(r, 0.42 + aggId * 0.26, agg * 0.9);
          r = mix(r, 0.99, spall * (1 - aggBody) * 0.7 + craze * 0.4 + crack * 0.5);
          r = mix(r, 0.20, wetK);
          r = mix(r, 0.62, stain * 0.30);        // stained areas hold a film
          rough[i] = clamp01(r);
          metal[i] = 0;
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Weathered asphalt. Macro: patch repairs, oil spill, tyre-polished wheel
   * tracks. Meso: two grades of aggregate plus alligator cracking. Micro:
   * bitumen film and quartz sparkle.
   */
  asphalt: {
    amplitude: 0.010, tile: 6.0, detail: 'grain',
    ao: { radiusTexels: 12, strength: 1.25, microStrength: 0.8 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      const patch = band(MACRO, (u, v) => warpFbm2(u * 3, v * 3, { octaves: 4, period: 3, warp: 0.7, warpFreq: 1 }));
      const oilB = band(MACRO, (u, v) => warpFbm2(u * 5 + 7, v * 5 + 2, { octaves: 4, period: 5, warp: 0.5, warpFreq: 1 }));
      const trackB = band(MACRO, (u, v) => fbm2(u * 4, v * 1, { octaves: 3, period: 4 }));
      const dustB = band(48, (u, v) => fbm2(u * 2 + 5, v * 2, { octaves: 3, period: 2 }));
      const alliB = band(M, (u, v) => warpRidged2(u * 9, v * 9, { octaves: 4, period: 9, warp: 0.55, warpFreq: 0.4 }));

      const tar = [0.052, 0.052, 0.056];
      const grey = [0.150, 0.150, 0.156];
      const stone = [0.300, 0.290, 0.276];
      const c = [0, 0, 0], stoneTone = [0, 0, 0];
      const mic = micro(seed + 5);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;

          // Aggregate. Asphalt is a *stone* surface held together by bitumen —
          // the tell is a dense field of pale chips, not a black sheet. Each
          // stone gets its own size and tone from its cell random.
          const grain = mA(mic, x, y);
          const jag = (grain - 0.5);
          scatter2(u * 30, v * 30, 30, seed, CELL);
          const bId = CELL[1];
          const bR = 0.17 + bId * 0.28;
          const bigStone = stoneMask(CELL[2], CELL[3], bId, bR, jag * bR * 0.6) * smoothstep(0.14, 0.38, bId);
          scatter2(u * 82, v * 82, 82, seed + 11, CELL);
          const cId = CELL[1];
          const chip = stoneMask(CELL[2], CELL[3], cId, 0.11 + cId * 0.12, jag * 0.07) * smoothstep(0.20, 0.48, cId);

          const alligator = smoothstep(0.80, 0.99, bs(alliB, u, v));
          const sparkle = smoothstep(0.90, 1.0, mB(mic, x, y));

          const pa = bs(patch, u, v), oi = bs(oilB, u, v), tr = bs(trackB, u, v), du = bs(dustB, u, v);
          const exposure = smoothstep(0.35, 0.75, pa);
          const polish = smoothstep(0.55, 0.9, tr);
          const oily = smoothstep(0.70, 0.90, oi);

          height[i] = clamp01(0.38
            + (pa - 0.5) * 0.20
            + bigStone * (0.30 + exposure * 0.55) * 0.52
            + chip * (0.3 + exposure * 0.7) * 0.22
            + (grain - 0.5) * 0.06
            - alligator * 0.70
            - polish * 0.08);

          // The bitumen matrix is genuinely dark, but the stone in it is not,
          // and the contrast between the two is the entire read. Crushing both
          // to black is why so much procedural asphalt looks like a void.
          lerp3(c, tar, grey, exposure * 0.9 + (pa - 0.5) * 0.25);
          // Sound asphalt keeps its aggregate coated in bitumen and reads
          // almost uniform; it is only where the surface has ravelled that
          // the stone shows through. Lifting every chip everywhere turns a
          // road into terrazzo.
          const bigK = clamp01(bigStone * (0.10 + exposure * 0.85));
          const chipK = clamp01(chip * (0.06 + exposure * 0.72)) * (1 - bigK);
          stoneTone[0] = stone[0] * (0.55 + bId * 0.85);
          stoneTone[1] = stone[1] * (0.55 + bId * 0.83);
          stoneTone[2] = stone[2] * (0.55 + bId * 0.80);
          lerp3(c, c, stoneTone, bigK);
          stoneTone[0] = stone[0] * (0.50 + cId * 0.95);
          stoneTone[1] = stone[1] * (0.50 + cId * 0.92);
          stoneTone[2] = stone[2] * (0.50 + cId * 0.88);
          lerp3(c, c, stoneTone, chipK);
          const sh = 0.84 + (grain - 0.5) * 0.34 + (pa - 0.5) * 0.16;
          c[0] *= sh; c[1] *= sh; c[2] *= sh;
          c[0] += sparkle * 0.26; c[1] += sparkle * 0.27; c[2] += sparkle * 0.30;
          const dk = smoothstep(0.5, 0.95, du) * exposure * 0.55;
          c[0] = mix(c[0], 0.30, dk); c[1] = mix(c[1], 0.285, dk); c[2] = mix(c[2], 0.255, dk);
          lerp3(c, c, OIL, oily * 0.9);
          c[0] *= 1 - alligator * 0.40; c[1] *= 1 - alligator * 0.40; c[2] *= 1 - alligator * 0.40;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          let r = 0.97 - exposure * 0.05 + (grain - 0.5) * 0.14;
          r = mix(r, 0.46 + bId * 0.24, bigK * 0.8);   // washed stone faces
          r = mix(r, 0.40, polish * 0.85);             // tyre-polished tracks
          r = mix(r, 0.16, oily);
          rough[i] = clamp01(r - sparkle * 0.35 + dk * 0.03);
          metal[i] = 0;
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Painted steel panel. Macro: panel dishing and impact dents. Meso: paint
   * chipping to primer then bare metal, rust blooming out of the chips.
   * Micro: orange-peel spray texture and rolled mill grain.
   */
  paintedMetal: {
    amplitude: 0.0035, tile: 2.5, detail: 'brushed',
    ao: { radiusTexels: 10, strength: 0.9, microStrength: 0.5 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      const base = o.base || [0.22, 0.26, 0.21];
      const dentB = band(MACRO, (u, v) => warpFbm2(u * 4, v * 4, { octaves: 4, period: 4, warp: 0.6, warpFreq: 1 }));
      const wearB = band(MACRO, (u, v) => warpFbm2(u * 5 + 3, v * 5 + 1, { octaves: 5, period: 5, warp: 0.7, warpFreq: 1 }));
      const rustB = band(MACRO, (u, v) => warpFbm2(u * 7 + 9, v * 7 + 4, { octaves: 4, period: 7, warp: 0.6, warpFreq: 1 }));
      const grimeB = band(48, (u, v) => fbm2(u * 3, v * 1, { octaves: 3, period: 3 }));
      const flakeB = band(M, (u, v) => warpRidged2(u * 30, v * 30, { octaves: 4, period: 30, warp: 0.4, warpFreq: 0.3 }));
      const scratchB = band(M, (u, v) => ridged2(u * 90 + v * 12, v * 6, { octaves: 2, period: 90 }));

      const primer = [0.185, 0.175, 0.165];
      const rustC = [0.240, 0.106, 0.048];
      const rustLt = [0.400, 0.210, 0.100];
      const steel = [0.560, 0.565, 0.580];
      const c = [0, 0, 0];
      const mic = micro(seed + 2);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;

          // ridged noise gives the scalloped flake boundary real paint makes;
          // plain fbm only ever gives soft blobs
          const chipRaw = bs(wearB, u, v) * 0.62 + bs(flakeB, u, v) * 0.38;
          const chipped = smoothstep(0.545, 0.635, chipRaw);
          const deepChip = smoothstep(0.61, 0.70, chipRaw);
          const rustRaw = bs(rustB, u, v);
          const rustMask = smoothstep(0.50, 0.80, rustRaw) * smoothstep(0.50, 0.60, chipRaw);
          const scratch = smoothstep(0.93, 1.0, bs(scratchB, u, v));

          const peel = mA(mic, x, y);
          const mill = mB(mic, x * 6, y);      // rolled mill grain runs along the sheet
          const dent = bs(dentB, u, v);

          height[i] = clamp01(0.60
            + (dent - 0.5) * 0.42
            + (peel - 0.5) * 0.10
            + (mill - 0.5) * 0.05
            - chipped * 0.20
            - deepChip * 0.18
            + rustMask * 0.10
            - scratch * 0.25);

          const fade = 0.86 + (dent - 0.5) * 0.22 + (peel - 0.5) * 0.10;
          c[0] = base[0] * fade; c[1] = base[1] * fade; c[2] = base[2] * fade;
          lerp3(c, c, primer, chipped * 0.9);
          const bare = clamp01(deepChip * (1 - rustMask) * 0.9 + scratch * 0.6);
          lerp3(c, c, steel, bare * (0.6 + mill * 0.5));
          lerp3(c, c, rustC, rustMask * 0.85);
          lerp3(c, c, rustLt, rustMask * smoothstep(0.6, 0.9, rustRaw) * 0.5);
          const grime = smoothstep(0.45, 0.9, bs(grimeB, u, v)) * 0.28;
          c[0] *= 1 - grime; c[1] *= 1 - grime * 0.96; c[2] *= 1 - grime * 0.88;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          // satin enamel -> matte primer -> very rough rust -> polished bare edge
          let r = 0.38 + (peel - 0.5) * 0.16;
          r = mix(r, 0.80, chipped);
          r = mix(r, 0.95, rustMask);
          r = mix(r, 0.22, bare * 0.9);
          rough[i] = clamp01(r + grime * 0.18);
          metal[i] = clamp01(bare * 0.95 * (1 - rustMask) + rustMask * 0.15);
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /** Parkerised gunmetal: phosphate crystal grain, machining marks, edge wear. */
  gunmetal: {
    amplitude: 0.0012, tile: 0.5, detail: 'brushed',
    ao: { radiusTexels: 9, strength: 0.7, microStrength: 0.9 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const wearB = band(MACRO, (u, v) => warpFbm2(u * 6, v * 6, { octaves: 4, period: 6, warp: 0.6, warpFreq: 1 }));
      const c = [0, 0, 0];
      const phosphate = [0.052, 0.053, 0.058];
      const worn = [0.300, 0.305, 0.320];
      const mic = micro(seed + 1);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          // phosphate coating is a crystalline deposit — worley, not fbm
          worleyCell(u * 200, v * 200, 200, seed, CELL);
          const crystal = smoothstep(0.0, 0.35, CELL[1] - CELL[0]);
          const grain = mA(mic, x, y);
          const machine = mB(mic, x * 9, y);   // broach / machining lay
          const wear = smoothstep(0.60, 0.86, bs(wearB, u, v));
          const pit = smoothstep(0.93, 1.0, mB(mic, x * 2 + 61, y * 2 + 17));

          height[i] = clamp01(0.55 + (crystal - 0.5) * 0.30 + (grain - 0.5) * 0.22 + (machine - 0.5) * 0.16 - pit * 0.55);

          lerp3(c, phosphate, worn, wear);
          const sh = 0.85 + (grain - 0.5) * 0.30 + (machine - 0.5) * 0.18 + crystal * 0.18;
          c[0] *= sh; c[1] *= sh * 1.01; c[2] *= sh * 1.05;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          // matte phosphate at 0.62, polished by contact wear down to 0.16
          rough[i] = clamp01(mix(0.62, 0.16, wear) + (crystal - 0.5) * 0.14 + (grain - 0.5) * 0.10 + pit * 0.25);
          metal[i] = 1.0;
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Desert sand. Macro: drift and shadowed hollows. Meso: wind ripples whose
   * crests bend with the flow field, plus footfall scuffing. Micro: grain
   * sparkle and scattered pebbles.
   */
  sand: {
    amplitude: 0.022, tile: 8.0, detail: 'grain',
    ao: { radiusTexels: 16, strength: 1.0, microStrength: 0.45 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      const driftB = band(MACRO, (u, v) => warpFbm2(u * 2, v * 2, { octaves: 4, period: 2, warp: 0.5, warpFreq: 1 }));
      const flowB = band(MACRO, (u, v) => fbm2(u * 3 + 4, v * 3, { octaves: 3, period: 3 }));
      const dampB = band(48, (u, v) => fbm2(u * 2 + 11, v * 2 + 6, { octaves: 3, period: 2 }));
      const scuffB = band(M, (u, v) => warpFbm2(u * 12, v * 12, { octaves: 3, period: 12, warp: 0.6, warpFreq: 0.5 }));
      const c = [0, 0, 0];
      const dry = [0.560, 0.470, 0.340];
      const pale = [0.680, 0.605, 0.470];
      const dark = [0.300, 0.245, 0.180];
      const peb = [0.400, 0.380, 0.352];
      const mic = micro(seed + 4);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          const flow = bs(flowB, u, v), drift = bs(driftB, u, v);
          // ripples: a triangle wave advected by the flow field, so crests
          // curve and fork the way wind ripples actually do
          const ripple = Math.pow(tri(u * 26 + flow * 7 + drift * 3), 0.75);
          const rippleAmp = smoothstep(0.25, 0.65, flow);
          const scuff = smoothstep(0.62, 0.88, bs(scuffB, u, v));
          const grit = mA(mic, x, y);
          scatter2(u * 24, v * 24, 24, seed + 3, CELL);
          const pebble = stoneMask(CELL[2], CELL[3], CELL[1], 0.07 + CELL[1] * 0.09, (grit - 0.5) * 0.05)
            * smoothstep(0.70, 0.90, CELL[1]);
          const sparkle = smoothstep(0.94, 1.0, mB(mic, x, y));

          height[i] = clamp01(0.42
            + (drift - 0.5) * 0.55
            + ripple * rippleAmp * 0.16
            + (grit - 0.5) * 0.05
            + pebble * 0.30
            - scuff * 0.10);

          const dp = smoothstep(0.62, 0.85, bs(dampB, u, v));
          lerp3(c, dry, pale, clamp01(drift * 0.7 + ripple * rippleAmp * 0.35));
          lerp3(c, c, dark, dp * 0.75);
          lerp3(c, c, peb, pebble);
          const sh = 0.90 + (grit - 0.5) * 0.16 + scuff * 0.06;
          c[0] *= sh; c[1] *= sh; c[2] *= sh;
          c[0] += sparkle * 0.35; c[1] += sparkle * 0.33; c[2] += sparkle * 0.28;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          let r = 0.97 + (grit - 0.5) * 0.06;
          r = mix(r, 0.55, dp);            // damp sand is much smoother
          r = mix(r, 0.40, pebble * 0.8);  // polished pebble faces
          rough[i] = clamp01(r - sparkle * 0.4);
          metal[i] = 0;
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Stucco / render facade. Macro: patch repairs in a different mix, damp
   * rising from the base, sun bleaching. Meso: trowel sweep, spalled patches
   * revealing block, hairline map cracking. Micro: sand aggregate and pinholes.
   */
  plaster: {
    amplitude: 0.008, tile: 4.5, detail: 'grain',
    ao: { radiusTexels: 13, strength: 1.1, microStrength: 0.65 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      const base = o.base || [0.62, 0.57, 0.48];
      const patchB = band(MACRO, (u, v) => warpFbm2(u * 3, v * 3, { octaves: 4, period: 3, warp: 0.6, warpFreq: 1 }));
      const risingB = band(MACRO, (u, v) => fbm2(u * 4, v * 2, { octaves: 3, period: 4 }));
      const streakB = band(MACRO, (u, v) => fbm2(u * 8, v * 1, { octaves: 4, period: 8 }));
      const bleachB = band(32, (u, v) => fbm2(u * 2 + 8, v * 2, { octaves: 3, period: 2 }));
      const trowelB = band(M, (u, v) => warpFbm2(u * 9, v * 9, { octaves: 4, period: 9, warp: 0.45, warpFreq: 0.5 }));
      const spallB = band(M, (u, v) => warpFbm2(u * 6 + 3, v * 6, { octaves: 5, period: 6, warp: 0.7, warpFreq: 0.5 }));
      const crackB = band(M, (u, v) => warpRidged2(u * 16, v * 16, { octaves: 3, period: 16, warp: 0.4, warpFreq: 0.3 }));
      const c = [0, 0, 0];
      const block = [0.335, 0.268, 0.212];
      const wet = [0.240, 0.215, 0.180];
      const mic = micro(seed + 6);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          const trowel = bs(trowelB, u, v);
          const spall = smoothstep(0.615, 0.700, bs(spallB, u, v));
          const mapCrack = smoothstep(0.83, 0.99, bs(crackB, u, v));
          const sandGrain = mA(mic, x, y);
          const pinhole = smoothstep(0.88, 1.0, mB(mic, x, y));
          const patch = bs(patchB, u, v);

          height[i] = clamp01(0.58
            + (patch - 0.5) * 0.24
            + (trowel - 0.5) * 0.30
            + (sandGrain - 0.5) * 0.09
            - pinhole * 0.25
            - spall * 0.45
            - mapCrack * 0.22);

          const sh = 0.80 + trowel * 0.32 + (sandGrain - 0.5) * 0.12 + (patch - 0.5) * 0.16;
          c[0] = base[0] * sh; c[1] = base[1] * sh; c[2] = base[2] * sh;
          const bl = smoothstep(0.5, 0.9, bs(bleachB, u, v)) * 0.30;
          c[0] = mix(c[0], 0.78, bl); c[1] = mix(c[1], 0.755, bl); c[2] = mix(c[2], 0.700, bl);
          const pr = smoothstep(0.68, 0.78, patch);
          c[0] = mix(c[0], 0.545, pr * 0.55); c[1] = mix(c[1], 0.535, pr * 0.55); c[2] = mix(c[2], 0.512, pr * 0.55);
          lerp3(c, c, block, spall * 0.9);
          const rs = smoothstep(0.55, 0.9, bs(risingB, u, v)) * (1 - smoothstep(0.15, 0.55, v));
          lerp3(c, c, wet, rs * 0.7);
          const st = smoothstep(0.52, 0.92, bs(streakB, u, v)) * 0.26;
          c[0] *= 1 - st; c[1] *= 1 - st * 0.96; c[2] *= 1 - st * 0.90;
          c[0] *= 1 - mapCrack * 0.30; c[1] *= 1 - mapCrack * 0.30; c[2] *= 1 - mapCrack * 0.30;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          let r = 0.90 - (sandGrain - 0.5) * 0.12;
          r = mix(r, 0.96, spall);       // fresh broken block is chalky
          r = mix(r, 0.45, rs * 0.8);    // damp base
          r = mix(r, 0.72, bl * 0.6);    // limewashed sheen
          rough[i] = clamp01(r);
          metal[i] = 0;
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Corrugated / profiled sheet — containers and roofing. Macro: panel dishing
   * and the corrosion map. Meso: the trapezoidal rib profile, swage lines and
   * impact creases. Micro: galvanising spangle under the paint.
   */
  corrugated: {
    amplitude: 0.045, tile: 3.0, detail: 'brushed',
    ao: { radiusTexels: 16, strength: 1.0, microStrength: 0.4 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      const base = o.base || [0.20, 0.30, 0.34];
      const rustB = band(MACRO, (u, v) => warpFbm2(u * 4, v * 4, { octaves: 5, period: 4, warp: 0.8, warpFreq: 1 }));
      const dentB = band(MACRO, (u, v) => warpFbm2(u * 6 + 5, v * 6, { octaves: 4, period: 6, warp: 0.5, warpFreq: 1 }));
      const streakB = band(MACRO, (u, v) => fbm2(u * 14, v * 1.0, { octaves: 4, period: 14 }));
      const creaseB = band(M, (u, v) => ridged2(u * 14, v * 14, { octaves: 3, period: 14 }));
      const c = [0, 0, 0];
      const rustDark = [0.190, 0.082, 0.038];
      const rustMid = [0.330, 0.150, 0.062];
      const rustLt = [0.480, 0.265, 0.130];
      const mic = micro(seed + 7);

      const RIBS = 5;
      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          // trapezoidal profile — a raw sine reads as a soft wave; the
          // flattened crest and valley is what makes it read as folded steel
          const rib = smootherstep(0.12, 0.88, tri(u * RIBS));
          const swage = 1 - smoothstep(0.0, 0.030, Math.abs(tri(v * 2) - 0.5) * 2);
          const spangle = mA(mic, x, y);
          const crease = smoothstep(0.90, 1.0, bs(creaseB, u, v));
          const dent = bs(dentB, u, v), streakN = bs(streakB, u, v);

          const rustRaw = bs(rustB, u, v) * 0.75 + (1 - rib) * 0.10 + streakN * 0.15;
          const rust = smoothstep(0.48, 0.74, rustRaw);
          const rustHeavy = smoothstep(0.66, 0.86, rustRaw);
          const streak = smoothstep(0.60, 0.95, streakN) * smoothstep(0.35, 0.6, rustRaw);

          height[i] = clamp01(0.10 + rib * 0.80
            + (dent - 0.5) * 0.10
            + (spangle - 0.5) * 0.03
            - swage * 0.10
            - crease * 0.10
            - rustHeavy * 0.10);

          const sh = 0.72 + rib * 0.40 + (dent - 0.5) * 0.14 + (spangle - 0.5) * 0.07;
          c[0] = base[0] * sh; c[1] = base[1] * sh; c[2] = base[2] * sh;
          const chalk = rib * smoothstep(0.4, 0.8, dent) * 0.20;
          c[0] = mix(c[0], base[0] * 1.7 + 0.14, chalk);
          c[1] = mix(c[1], base[1] * 1.7 + 0.14, chalk);
          c[2] = mix(c[2], base[2] * 1.7 + 0.14, chalk);
          lerp3(c, c, rustMid, rust * 0.9);
          lerp3(c, c, rustDark, rustHeavy * smoothstep(0.4, 0.8, dent) * 0.7);
          lerp3(c, c, rustLt, streak * 0.55);
          c[0] *= 1 - crease * 0.2; c[1] *= 1 - crease * 0.2; c[2] *= 1 - crease * 0.2;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          rough[i] = clamp01(mix(0.44, 0.95, rust) + (spangle - 0.5) * 0.10 + streak * 0.05);
          metal[i] = clamp01(1 - rust * 0.80);
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Brickwork in running bond with struck mortar joints. Macro: soot, damp
   * and whole-region firing variation. Meso: per-brick colour and height from
   * the cell id, chipped arrises, sandy mortar. Micro: clay grain.
   *
   * The one thing that instantly kills procedural brick is every brick being
   * the same colour, so the per-brick hash drives tone harder than anything.
   */
  brick: {
    amplitude: 0.014, tile: 3.0, detail: 'grain',
    ao: { radiusTexels: 12, strength: 1.4, microStrength: 0.6 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      const base = o.base || [0.330, 0.165, 0.115];
      const sootB = band(MACRO, (u, v) => warpFbm2(u * 3, v * 3, { octaves: 4, period: 3, warp: 0.7, warpFreq: 1 }));
      const dampB = band(48, (u, v) => fbm2(u * 3 + 6, v * 2, { octaves: 3, period: 3 }));
      const firingB = band(32, (u, v) => fbm2(u * 2 + 3, v * 2 + 9, { octaves: 3, period: 2 }));
      const chipB = band(M, (u, v) => ridged2(u * 70, v * 70, { octaves: 2, period: 70 }));
      const c = [0, 0, 0];
      const mortarC = [0.500, 0.482, 0.448];
      const darkBrick = [0.180, 0.086, 0.062];
      const paleBrick = [0.520, 0.330, 0.235];
      const freshClay = [0.560, 0.360, 0.270];
      const mic = micro(seed + 9);

      const ROWS = 8, COLS = 4, JOINT = 0.055;

      for (let y = 0; y < size; y++) {
        const v = y / size;
        const row = Math.floor(v * ROWS);
        const fy = v * ROWS - row;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          const ux = u * COLS + ((row & 1) ? 0.5 : 0.0);
          const col = Math.floor(ux);
          const fx = ux - col;

          const bid = hash2(col, row, seed);
          const bid2 = hash2(col, row, seed + 77);

          const wobble = (mB(mic, x * 3, y * 3) - 0.5) * 0.030;
          const dxj = Math.min(fx, 1 - fx) + wobble;
          const dyj = Math.min(fy, 1 - fy) * (COLS / ROWS) + wobble;
          const dj = Math.min(dxj, dyj);
          const isMortar = 1 - smoothstep(JOINT * 0.55, JOINT * 1.25, dj);
          const arris = smoothstep(JOINT * 1.1, JOINT * 3.2, dj);

          // offsetting the micro lookup per brick means no two bricks share
          // the same grain, which is most of what stops brickwork looking stamped
          const clay = mA(mic, x + ((bid * 211) | 0), y + ((bid2 * 197) | 0));
          const chip = smoothstep(0.72, 0.95, bs(chipB, u, v)) * (1 - arris) * (1 - isMortar);
          const mortarSand = mB(mic, x + 71, y + 113);

          const brickH = 0.72 + (bid - 0.5) * 0.10 + arris * 0.10 + (clay - 0.5) * 0.10 - chip * 0.35;
          const mortarH = 0.30 + (mortarSand - 0.5) * 0.12;
          height[i] = clamp01(mix(brickH, mortarH, isMortar));

          const bt = clamp01(bid2 * 0.8 + bs(firingB, u, v) * 0.5 - 0.15);
          if (bt < 0.5) lerp3(c, darkBrick, base, bt * 2);
          else lerp3(c, base, paleBrick, (bt - 0.5) * 2);
          const sh = 0.86 + (clay - 0.5) * 0.30 + arris * 0.10;
          c[0] *= sh; c[1] *= sh; c[2] *= sh;
          lerp3(c, c, freshClay, chip * 0.7);
          const ms = 0.82 + (mortarSand - 0.5) * 0.34;
          MORTAR[0] = mortarC[0] * ms; MORTAR[1] = mortarC[1] * ms; MORTAR[2] = mortarC[2] * ms;
          lerp3(c, c, MORTAR, isMortar);
          const so = smoothstep(0.52, 0.92, bs(sootB, u, v)) * 0.42;
          c[0] *= 1 - so; c[1] *= 1 - so * 0.98; c[2] *= 1 - so * 0.94;
          const dp = smoothstep(0.60, 0.90, bs(dampB, u, v)) * (1 - smoothstep(0.05, 0.5, v)) * 0.55;
          c[0] *= 1 - dp * 0.55; c[1] *= 1 - dp * 0.55; c[2] *= 1 - dp * 0.48;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          // fired clay has a faint vitrified sheen; mortar is dead matte
          let r = 0.74 + (clay - 0.5) * 0.16 - (bid - 0.5) * 0.10;
          r = mix(r, 0.95, isMortar);
          r = mix(r, 0.92, chip);
          rough[i] = clamp01(mix(r, 0.48, dp));
          metal[i] = 0;
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Weathered timber boarding. Macro: board-to-board colour and UV greying.
   * Meso: growth rings warped along the board, knots, splits, board gaps.
   * Micro: raised fibre and surface checking.
   */
  wood: {
    amplitude: 0.006, tile: 2.4, detail: 'grain',
    ao: { radiusTexels: 10, strength: 1.3, microStrength: 0.75 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      const base = o.base || [0.300, 0.205, 0.128];
      const weatherB = band(MACRO, (u, v) => warpFbm2(u * 4, v * 4, { octaves: 4, period: 4, warp: 0.6, warpFreq: 1 }));
      const c = [0, 0, 0];
      const grey = [0.310, 0.300, 0.285];
      const dark = [0.140, 0.092, 0.058];
      const knotC = [0.090, 0.055, 0.032];
      const mic = micro(seed + 11);

      const BOARDS = 5, GAP = 0.022;

      // Growth rings are the meso band. They are extremely anisotropic, so the
      // band is stretched to match: high resolution across the board, low
      // along it. A square band here would either blur the rings or cost four
      // times what it needs to.
      const RW = Math.min(1024, size), RH = Math.max(64, M >> 2);
      const rings = { d: new Float32Array(RW * RH), n: 0 };
      const ringsD = rings.d;
      for (let ry = 0; ry < RH; ry++) {
        const v = ry / RH;
        for (let rx = 0; rx < RW; rx++) {
          const u = rx / RW;
          const bi = Math.floor(u * BOARDS);
          const bid = hash2(bi, 0, seed), bid2 = hash2(bi, 1, seed);
          const fb = u * BOARDS - bi;
          const gx = (fb + bid * 3) * 5.0;
          const warp = (fbm2(u * 6 + bid * 10, v * 2.5, { octaves: 3, period: 6 }) - 0.5) * 1.6;
          ringsD[ry * RW + rx] = ridged2(gx * 6 + warp * 2.2, v * 2.2 + bid2 * 7, { octaves: 3, period: 30 });
        }
      }
      const sampleRings = (u, v) => {
        const fx = u * RW - 0.5, fy = v * RH - 0.5;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = fx - ix, ty = quint(fy - iy);
        let x0 = ix % RW; if (x0 < 0) x0 += RW;
        let y0 = iy % RH; if (y0 < 0) y0 += RH;
        const x1 = x0 + 1 === RW ? 0 : x0 + 1;
        const r0 = y0 * RW, r1 = (y0 + 1 === RH ? 0 : y0 + 1) * RW;
        const a = ringsD[r0 + x0], b1 = ringsD[r0 + x1];
        const cc = ringsD[r1 + x0], e = ringsD[r1 + x1];
        const top = a + (b1 - a) * tx, bot = cc + (e - cc) * tx;
        return top + (bot - top) * ty;
      };
      const splitB = band(M, (u, v) => ridged2(u * 10, v * 30, { octaves: 2, period: 60 }));

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          const bu = u * BOARDS;
          const bi = Math.floor(bu);
          const fb = bu - bi;
          const bid = hash2(bi, 0, seed);
          const bid2 = hash2(bi, 1, seed);

          const gap = 1 - smoothstep(GAP * 0.5, GAP * 1.6, Math.min(fb, 1 - fb));
          const edge = smoothstep(GAP * 1.4, GAP * 6.0, Math.min(fb, 1 - fb));
          const ringSharp = Math.pow(clamp01(sampleRings(u, v)), 1.6);
          scatter2(u * 5 + bid, v * 4, 5, seed + 21, CELL);
          const knot = (1 - smoothstep(0.04, 0.13, CELL[0])) * smoothstep(0.62, 0.80, CELL[1]);
          const split = smoothstep(0.90, 1.0, bs(splitB, u, v)) * smoothstep(0.4, 0.8, bid2);
          const fibre = mB(mic, x, y * 8);     // fibre runs the length of the board

          height[i] = clamp01(0.66
            + (ringSharp - 0.5) * 0.26     // latewood stands proud on weathered timber
            + (fibre - 0.5) * 0.10
            - knot * 0.28
            - split * 0.45
            - gap * 0.85
            - (1 - edge) * 0.12);

          const boardTone = 0.80 + bid * 0.42;
          c[0] = base[0] * boardTone; c[1] = base[1] * boardTone; c[2] = base[2] * boardTone;
          lerp3(c, c, dark, ringSharp * 0.55);
          lerp3(c, c, knotC, knot * 0.85);
          const wg = smoothstep(0.40, 0.85, bs(weatherB, u, v) * 0.7 + bid2 * 0.3);
          lerp3(c, c, grey, wg * 0.7);     // UV-silvered timber
          const sh = 0.88 + (fibre - 0.5) * 0.22;
          c[0] *= sh; c[1] *= sh; c[2] *= sh;
          const dkm = (1 - gap * 0.85) * (1 - split * 0.55);
          c[0] *= dkm; c[1] *= dkm; c[2] *= dkm;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          // earlywood is porous and matte, latewood denser and shinier;
          // weathering flattens the difference back out
          let r = mix(0.90, 0.62, ringSharp);
          r = mix(r, 0.96, wg * 0.8);
          r = mix(r, 0.55, knot);
          rough[i] = clamp01(r + split * 0.05);
          metal[i] = 0;
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Heavy canvas tarpaulin. Macro: hanging folds, pooled dirt, sun fade.
   * Meso: the over-under basket weave and stitched seams. Micro: fibre fuzz.
   * The weave has to stay crisp — a tarp with a blurry weave reads as painted
   * plastic — so it is generated at full resolution from an analytic cylinder
   * profile rather than from noise.
   */
  fabric: {
    amplitude: 0.005, tile: 1.6, detail: 'weave',
    ao: { radiusTexels: 8, strength: 1.2, microStrength: 0.9 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const base = o.base || [0.235, 0.225, 0.180];
      const foldB = band(MACRO, (u, v) => warpFbm2(u * 3, v * 5, { octaves: 4, period: 3, warp: 0.7, warpFreq: 1 }));
      const dirtB = band(MACRO, (u, v) => fbm2(u * 5 + 2, v * 3, { octaves: 4, period: 5 }));
      const fadeB = band(32, (u, v) => fbm2(u * 2 + 7, v * 2, { octaves: 3, period: 2 }));
      const c = [0, 0, 0];
      const mic = micro(seed + 13);

      const THREADS = 96;
      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          const tu = u * THREADS, tv = v * THREADS;
          const iu = Math.floor(tu), iv = Math.floor(tv);
          const fu = tu - iu, fv = tv - iv;
          const au = fu * 2 - 1, av = fv * 2 - 1;
          const warpT = Math.sqrt(Math.max(0, 1 - au * au));
          const weftT = Math.sqrt(Math.max(0, 1 - av * av));
          const over = ((iu + iv) & 1) === 0;
          const weave = over ? warpT * 0.85 + weftT * 0.3 : weftT * 0.85 + warpT * 0.3;
          const threadVar = hash2(iu, iv, seed) * 0.25;

          const fuzz = mB(mic, x, y);
          const seam = 1 - smoothstep(0.0, 0.012, Math.abs(tri(v * 3) - 0.5) * 2);
          const fold = bs(foldB, u, v);
          const wear = smoothstep(0.70, 0.92, fold);

          height[i] = clamp01(0.45 + weave * 0.34 + (fold - 0.5) * 0.30 + (fuzz - 0.5) * 0.06 + seam * 0.16 - wear * 0.06);

          const sh = 0.72 + weave * 0.40 + threadVar * 0.5 + (fold - 0.5) * 0.20;
          c[0] = base[0] * sh; c[1] = base[1] * sh; c[2] = base[2] * sh;
          const fd = smoothstep(0.45, 0.9, bs(fadeB, u, v)) * 0.35;
          c[0] = mix(c[0], base[0] * 1.9 + 0.06, fd);
          c[1] = mix(c[1], base[1] * 1.9 + 0.06, fd);
          c[2] = mix(c[2], base[2] * 1.85 + 0.05, fd);
          const dt = smoothstep(0.50, 0.92, bs(dirtB, u, v)) * 0.45;
          c[0] = mix(c[0], 0.130, dt); c[1] = mix(c[1], 0.118, dt); c[2] = mix(c[2], 0.098, dt);
          c[0] += seam * 0.03; c[1] += seam * 0.03; c[2] += seam * 0.03;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          // proofed canvas has a waxy sheen on the thread crowns; abraded
          // areas go fuzzy and matte
          let r = 0.86 - weave * 0.18 + (fuzz - 0.5) * 0.10;
          r = mix(r, 0.97, wear);
          rough[i] = clamp01(mix(r, 0.93, dt));
          metal[i] = 0;
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Compacted dirt and gravel hardstanding. Macro: puddled hollows, tyre ruts,
   * dust drift. Meso: three grades of loose stone in a fines matrix. Micro:
   * dried mud crazing.
   */
  gravel: {
    amplitude: 0.038, tile: 4.0, detail: 'grain',
    ao: { radiusTexels: 16, strength: 1.45, microStrength: 0.8 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      const hollowB = band(MACRO, (u, v) => warpFbm2(u * 3, v * 3, { octaves: 4, period: 3, warp: 0.7, warpFreq: 1 }));
      const rutB = band(MACRO, (u, v) => fbm2(u * 5, v * 1, { octaves: 3, period: 5 }));
      const dustB = band(48, (u, v) => fbm2(u * 3 + 4, v * 3, { octaves: 3, period: 3 }));
      const crazeB = band(M, (u, v) => warpRidged2(u * 22, v * 22, { octaves: 3, period: 22, warp: 0.4, warpFreq: 0.3 }));
      const c = [0, 0, 0];
      const soil = [0.215, 0.170, 0.128];
      const dust = [0.430, 0.375, 0.300];
      const stoneA = [0.400, 0.385, 0.360];
      const stoneB = [0.290, 0.255, 0.222];
      const wet = [0.090, 0.072, 0.058];
      const mic = micro(seed + 2);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          // Three stone grades. A cell only becomes a stone if its random
          // passes a threshold, so the fines matrix between them stays visible
          // — stones that fill the plane read as crazy paving, not as gravel.
          // Stones pack the surface — the fines only show through the gaps.
          // Sparse stones on a mud field is what wet earth looks like, not
          // what a gravel hardstanding looks like, and the difference is
          // almost entirely the coverage fraction.
          const fines = mA(mic, x, y);
          const jag = (fines - 0.5);
          scatter2(u * 20, v * 20, 20, seed, CELL);
          const s1id = CELL[1];
          const r1 = 0.24 + s1id * 0.32;
          const s1 = stoneMask(CELL[2], CELL[3], s1id, r1, jag * r1 * 0.55) * smoothstep(0.08, 0.28, s1id);
          scatter2(u * 46, v * 46, 46, seed + 5, CELL);
          const s2id = CELL[1];
          const r2 = 0.19 + s2id * 0.28;
          const s2 = stoneMask(CELL[2], CELL[3], s2id, r2, jag * r2 * 0.55) * smoothstep(0.06, 0.26, s2id);
          scatter2(u * 105, v * 105, 105, seed + 9, CELL);
          const s3id = CELL[1];
          const s3 = stoneMask(CELL[2], CELL[3], s3id, 0.15 + s3id * 0.14, jag * 0.09) * smoothstep(0.08, 0.32, s3id);
          const craze = smoothstep(0.86, 1.0, bs(crazeB, u, v));
          const hollow = bs(hollowB, u, v);
          const rutK = smoothstep(0.6, 0.92, bs(rutB, u, v));

          height[i] = clamp01(0.22
            + (hollow - 0.5) * 0.30
            + s1 * 0.62 + s2 * 0.38 + s3 * 0.20
            + (fines - 0.5) * 0.08
            - craze * 0.10
            - rutK * 0.16);

          const wetK = smoothstep(0.22, 0.06, hollow);   // water pools in the hollows
          lerp3(c, soil, dust, smoothstep(0.35, 0.85, bs(dustB, u, v)) * 0.7 + (fines - 0.5) * 0.5);
          // per-stone tone: limestone through to dark basalt, plus the odd
          // brick fragment, all from the one cell random
          const k1 = clamp01(s1);
          lerp3(c, c, s1id > 0.72 ? stoneB : stoneA, k1 * 0.95);
          if (k1 > 0.05) {
            const t1 = 0.62 + s1id * 0.80;
            c[0] *= mix(1, t1, k1); c[1] *= mix(1, t1 * 0.99, k1); c[2] *= mix(1, t1 * 0.96, k1);
          }
          const k2 = clamp01(s2) * (1 - k1);
          lerp3(c, c, s2id > 0.62 ? stoneA : stoneB, k2 * 0.9);
          if (k2 > 0.05) {
            const t2 = 0.60 + s2id * 0.85;
            c[0] *= mix(1, t2, k2); c[1] *= mix(1, t2, k2); c[2] *= mix(1, t2 * 0.97, k2);
          }
          const k3 = clamp01(s3) * (1 - k1) * (1 - k2);
          lerp3(c, c, stoneA, k3 * (0.4 + s3id * 0.6));
          const sh = 0.84 + (fines - 0.5) * 0.30 + (hollow - 0.5) * 0.14;
          c[0] *= sh; c[1] *= sh; c[2] *= sh;
          lerp3(c, c, wet, wetK * 0.85);
          c[0] *= 1 - craze * 0.25; c[1] *= 1 - craze * 0.25; c[2] *= 1 - craze * 0.25;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          let r = 0.97 + (fines - 0.5) * 0.08;
          r = mix(r, 0.42 + s1id * 0.26, k1 * 0.85);        // washed stone faces
          r = mix(r, 0.48 + s2id * 0.24, k2 * 0.75);
          r = mix(r, 0.12, wetK);                           // standing water
          rough[i] = clamp01(mix(r, 0.80, rutK * 0.5));
          metal[i] = 0;
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Glazed floor tile with grouted joints. Macro: traffic wear paths and
   * staining. Meso: the tile grid, per-tile tone, chipped corners, sandy
   * grout. Micro: glaze crazing.
   *
   * The whole point of a tile floor is a hard specular face against dead-matte
   * grout, with the sheen scuffed off along the walking line — that contrast
   * lives entirely in the roughness map.
   */
  tile: {
    amplitude: 0.005, tile: 2.0, detail: 'grain',
    ao: { radiusTexels: 11, strength: 1.4, microStrength: 0.5 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      const base = o.base || [0.400, 0.378, 0.345];
      const trafficB = band(MACRO, (u, v) => warpFbm2(u * 3, v * 3, { octaves: 4, period: 3, warp: 0.7, warpFreq: 1 }));
      const stainB = band(MACRO, (u, v) => fbm2(u * 5 + 3, v * 5, { octaves: 4, period: 5 }));
      const bodyB = band(M, (u, v) => warpFbm2(u * 30, v * 30, { octaves: 3, period: 30, warp: 0.4, warpFreq: 0.4 }));
      const crazeB = band(M, (u, v) => ridged2(u * 60, v * 60, { octaves: 2, period: 60 }));
      const chipB = band(M, (u, v) => ridged2(u * 120, v * 120, { octaves: 2, period: 120 }));
      const c = [0, 0, 0];
      const grout = [0.330, 0.318, 0.298];
      const chipC = [0.560, 0.520, 0.470];
      const mic = micro(seed + 3);

      const N = 4, JOINT = 0.030;
      for (let y = 0; y < size; y++) {
        const v = y / size;
        const ty = v * N, iy = Math.floor(ty), fy = ty - iy;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          const tx = u * N, ix = Math.floor(tx), fx = tx - ix;
          const tid = hash2(ix, iy, seed);
          const tid2 = hash2(ix, iy, seed + 41);

          const wob = (mB(mic, x * 2, y * 2) - 0.5) * 0.012;
          const dj = Math.min(Math.min(fx, 1 - fx), Math.min(fy, 1 - fy)) + wob;
          const isGrout = 1 - smoothstep(JOINT * 0.6, JOINT * 1.3, dj);
          const bevel = smoothstep(JOINT * 1.2, JOINT * 3.0, dj);

          const bodyNoise = bs(bodyB, u, v);
          const craze = smoothstep(0.90, 1.0, bs(crazeB, u, v)) * (1 - isGrout);
          const chip = (1 - bevel) * smoothstep(0.55, 0.85, bs(chipB, u, v)) * smoothstep(0.6, 0.9, tid2);
          const groutSand = mA(mic, x + 37, y + 91);

          const tileH = 0.80 + (tid - 0.5) * 0.05 + bevel * 0.10 - chip * 0.5 - craze * 0.06;
          const groutH = 0.30 + (groutSand - 0.5) * 0.16;
          height[i] = clamp01(mix(tileH, groutH, isGrout));

          const tone = 0.84 + tid * 0.30 + (bodyNoise - 0.5) * 0.28;
          c[0] = base[0] * tone; c[1] = base[1] * tone; c[2] = base[2] * tone;
          lerp3(c, c, chipC, chip * 0.8);
          const gs = 0.85 + (groutSand - 0.5) * 0.36;
          MORTAR[0] = grout[0] * gs; MORTAR[1] = grout[1] * gs; MORTAR[2] = grout[2] * gs;
          lerp3(c, c, MORTAR, isGrout);
          const st = smoothstep(0.60, 0.92, bs(stainB, u, v)) * 0.40;
          c[0] *= 1 - st; c[1] *= 1 - st * 0.97; c[2] *= 1 - st * 0.92;
          const tr = smoothstep(0.45, 0.85, bs(trafficB, u, v));
          c[0] *= 1 - tr * 0.12; c[1] *= 1 - tr * 0.12; c[2] *= 1 - tr * 0.11;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          let r = 0.16 + (bodyNoise - 0.5) * 0.06;
          r = mix(r, 0.62, tr * 0.9);
          r = mix(r, 0.90, chip);
          r = mix(r, 0.97, isGrout);
          rough[i] = clamp01(r + craze * 0.10 + st * 0.10);
          metal[i] = 0;
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Asphalt carrying a painted road marking. The stripe runs down the middle
   * of the tile in V so a long thin strip mesh reads as a continuous line.
   * The paint is thermoplastic: it sits proud of the road, holds its own glass
   * bead sparkle, and abrades off the aggregate high points first.
   */
  roadLine: {
    amplitude: 0.010, tile: 6.0, detail: 'grain',
    ao: { radiusTexels: 12, strength: 1.2, microStrength: 0.8 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const paint = o.base || [0.780, 0.760, 0.720];
      const dashed = !!o.dashed;
      const halfW = o.lineWidth ?? 0.16;
      const wearB = band(MACRO, (u, v) => warpFbm2(u * 8, v * 8, { octaves: 4, period: 8, warp: 0.7, warpFreq: 1 }));
      const patchB = band(MACRO, (u, v) => warpFbm2(u * 3, v * 3, { octaves: 4, period: 3, warp: 0.7, warpFreq: 1 }));
      const c = [0, 0, 0], pc = [0, 0, 0];
      const tar = [0.052, 0.052, 0.056];
      const stone = [0.290, 0.280, 0.266];
      const mic = micro(seed + 5);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;

          scatter2(u * 34, v * 34, 34, seed, CELL);
          const bigStone = (1 - smoothstep(0.06, 0.21, CELL[0])) * smoothstep(0.30, 0.75, CELL[1]);
          const grain = mA(mic, x, y);
          const patch = bs(patchB, u, v);
          const exposure = smoothstep(0.35, 0.75, patch);
          lerp3(c, tar, stone, clamp01(bigStone * exposure + exposure * 0.25));
          const sh = 0.86 + (grain - 0.5) * 0.22;
          c[0] *= sh; c[1] *= sh; c[2] *= sh;
          let h = 0.42 + (patch - 0.5) * 0.20 + bigStone * exposure * 0.34 + (grain - 0.5) * 0.06;
          let r = 0.96 - exposure * 0.04 + (grain - 0.5) * 0.10;

          // the marking — soft-edged, because sprayed paint always oversprays
          const ragged = (mB(mic, x, y * 2) - 0.5) * 0.020;
          let bandK = 1 - smoothstep(halfW - 0.012, halfW + 0.006, Math.abs(u - 0.5) + ragged);
          if (dashed) bandK *= smoothstep(0.10, 0.20, tri(v));
          const abrade = smoothstep(0.42, 0.78, bs(wearB, u, v)) * (0.35 + bigStone * 0.9);
          const cover = clamp01(bandK * (1 - abrade));

          if (cover > 0.001) {
            const beads = smoothstep(0.92, 1.0, mB(mic, x + 53, y + 29));
            const dirty = smoothstep(0.4, 0.9, patch) * 0.22;
            pc[0] = paint[0] * (1 - dirty); pc[1] = paint[1] * (1 - dirty * 1.05); pc[2] = paint[2] * (1 - dirty * 1.15);
            lerp3(c, c, pc, cover);
            c[0] += beads * cover * 0.25; c[1] += beads * cover * 0.25; c[2] += beads * cover * 0.25;
            h += cover * 0.10;                      // thermoplastic sits proud
            r = mix(r, 0.55 - beads * 0.35 + dirty * 0.3, cover);
          }
          height[i] = clamp01(h);
          rough[i] = clamp01(r);
          metal[i] = 0;
          writeRGB(rgb, i, c[0], c[1], c[2]);
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Heavily corroded iron. Macro: the corrosion front sweeping across the
   * plate and the run-off bleeding downwards. Meso: exfoliating scale flakes
   * with lifted edges, deep pitting. Micro: the granular oxide crust.
   *
   * Metalness drops to near zero inside the scale and stays high where sound
   * metal survives. That split is what makes rust read as rust rather than as
   * orange paint — oxide is a dielectric and must stop reflecting.
   */
  rustedIron: {
    amplitude: 0.005, tile: 2.0, detail: 'grain',
    ao: { radiusTexels: 11, strength: 1.35, microStrength: 0.85 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const frontB = band(MACRO, (u, v) => warpFbm2(u * 3, v * 3, { octaves: 5, period: 3, warp: 0.9, warpFreq: 1 }));
      const bleedB = band(MACRO, (u, v) => fbm2(u * 10, v * 1.5, { octaves: 4, period: 10 }));
      const c = [0, 0, 0];
      const steel = [0.330, 0.335, 0.345];
      const dkRust = [0.135, 0.062, 0.030];
      const mdRust = [0.300, 0.132, 0.056];
      const ltRust = [0.500, 0.280, 0.130];
      const powder = [0.360, 0.200, 0.115];
      const mic = micro(seed + 2);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          worleyCell(u * 26, v * 26, 26, seed, CELL);
          const flakeEdge = 1 - smoothstep(0.0, 0.10, CELL[1] - CELL[0]);
          const flakeId = CELL[2];
          worleyCell(u * 70, v * 70, 70, seed + 6, CELL);
          const subFlake = 1 - smoothstep(0.0, 0.08, CELL[1] - CELL[0]);
          const crust = mA(mic, x, y);
          const pit = smoothstep(0.84, 1.0, mB(mic, x + 17, y + 43));

          const front = bs(frontB, u, v);
          const corr = smoothstep(0.34, 0.62, front);
          const heavy = smoothstep(0.55, 0.82, front);
          const streak = smoothstep(0.55, 0.92, bs(bleedB, u, v)) * smoothstep(0.20, 0.45, front) * (1 - heavy);

          height[i] = clamp01(0.55
            + corr * 0.14
            + heavy * (flakeId - 0.35) * 0.34
            + flakeEdge * heavy * 0.22
            + subFlake * corr * 0.08
            + (crust - 0.5) * 0.14 * (0.3 + corr)
            - pit * 0.55 * (0.3 + corr));

          const sh = 0.85 + (crust - 0.5) * 0.34 + (flakeId - 0.5) * 0.22;
          lerp3(c, steel, mdRust, corr);
          lerp3(c, c, dkRust, heavy * smoothstep(0.5, 0.9, flakeId) * 0.85);
          lerp3(c, c, ltRust, clamp01(flakeEdge * heavy * 0.55 + streak * 0.5));
          lerp3(c, c, powder, corr * (1 - heavy) * smoothstep(0.4, 0.8, crust) * 0.4);
          const pk = (1 - pit * 0.45 * corr) * sh;
          c[0] *= pk; c[1] *= pk; c[2] *= pk;
          writeRGB(rgb, i, c[0], c[1], c[2]);

          rough[i] = clamp01(mix(0.42, 0.97, corr) + (crust - 0.5) * 0.12 + pit * 0.1);
          metal[i] = clamp01((1 - corr) * 0.95 + corr * 0.08);
        }
      }
      return p;
    },
  },

  // -------------------------------------------------------------------------
  /**
   * Dirty window glass. The albedo carries the grime layer and the roughness
   * is what sells it: near-mirror where the glass is clean, blown out to 0.5
   * where dust and salt have settled, so reflections tear across the pane
   * instead of sitting there as one flat highlight.
   */
  glass: {
    amplitude: 0.0006, tile: 2.0, detail: 'grain',
    ao: { radiusTexels: 8, strength: 0.35, microStrength: 0.2 },
    gen(size, seed, o = {}) {
      const p = planes(size);
      const { rgb, height, rough, metal } = p;
      const M = mesoRes(size);
      const grimeB = band(MACRO, (u, v) => warpFbm2(u * 4, v * 4, { octaves: 4, period: 4, warp: 0.7, warpFreq: 1 }));
      const edgeB = band(MACRO, (u, v) => fbm2(u * 6, v * 6, { octaves: 3, period: 6 }));
      const runB = band(M, (u, v) => fbm2(u * 40, v * 1.5, { octaves: 4, period: 40 }));
      const crackB = band(M, (u, v) => ridged2(u * 8, v * 8, { octaves: 4, period: 8 }));
      const mic = micro(seed + 8);

      for (let y = 0; y < size; y++) {
        const v = y / size;
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const u = x / size;
          const runoff = smoothstep(0.55, 0.95, bs(runB, u, v));
          const dust = mA(mic, x, y);
          const speck = smoothstep(0.94, 1.0, mB(mic, x, y));
          const crack = smoothstep(0.955, 1.0, bs(crackB, u, v));
          // dirt banks up in the frame rebate around the pane
          const rebate = smoothstep(0.5, 0.0, Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v)) * 8)
            * smoothstep(0.3, 0.8, bs(edgeB, u, v));
          const grime = clamp01(smoothstep(0.45, 0.85, bs(grimeB, u, v)) * 0.6 + runoff * 0.35 + rebate * 0.7 + dust * 0.10);

          height[i] = clamp01(0.5 + (bs(grimeB, u, v) - 0.5) * 0.2 + runoff * 0.25 + rebate * 0.3 + crack * 0.6);

          const g = grime * 0.85;
          const add = speck * 0.3 + crack * 0.5;
          writeRGB(rgb, i, 0.030 + g * 0.30 + add, 0.032 + g * 0.295 + add, 0.036 + g * 0.275 + add * 1.04);

          rough[i] = clamp01(0.035 + grime * 0.50 + runoff * 0.12 + crack * 0.4);
          metal[i] = 0;
        }
      }
      return p;
    },
  },
};

const OIL = [0.020, 0.019, 0.022];
const MORTAR = [0, 0, 0];

// ===========================================================================
//                          detail (micro) normal tiles
// ===========================================================================

/**
 * High-frequency normal tiles sampled at a much tighter UV scale than the base
 * maps and blended on top of them in the shader. This is what keeps a surface
 * crisp when the camera is 30 cm from it: the base normal map has to cover
 * metres, so it runs out of texels long before the eye runs out of interest,
 * and no amount of extra base resolution fixes that.
 */
const DETAIL = {
  /** Isotropic granular micro-relief — concrete, plaster, stone, dirt, brick. */
  grain(size, seed) {
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const a = vfbm2(u * 24, v * 24, { octaves: 4, period: 24, seed });
        const b = vfbm2(u * 96, v * 96, { octaves: 3, period: 96, seed: seed + 5 });
        worleyCell(u * 40, v * 40, 40, seed + 3, CELL);
        const pits = 1 - smoothstep(0.0, 0.22, CELL[0]);
        h[y * size + x] = clamp01(a * 0.45 + b * 0.35 - pits * 0.22 + 0.2);
      }
    }
    return h;
  },
  /** Anisotropic mill/brush grain — all metals. */
  brushed(size, seed) {
    const h = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const a = vfbm2(u * 160, v * 8, { octaves: 3, period: 160, seed });
        const b = vfbm2(u * 40, v * 40, { octaves: 3, period: 40, seed: seed + 7 });
        const scratch = smoothstep(0.86, 1.0, value2(u * 300, v * 6, 300, seed + 2));
        h[y * size + x] = clamp01(a * 0.55 + b * 0.30 - scratch * 0.35 + 0.15);
      }
    }
    return h;
  },
  /** Thread-scale weave — fabric, netting, webbing. */
  weave(size, seed) {
    const h = new Float32Array(size * size);
    const T = 20;
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const tu = u * T, tv = v * T;
        const iu = Math.floor(tu), iv = Math.floor(tv);
        const au = (tu - iu) * 2 - 1, av = (tv - iv) * 2 - 1;
        const cu = Math.sqrt(Math.max(0, 1 - au * au)), cv = Math.sqrt(Math.max(0, 1 - av * av));
        const over = ((iu + iv) & 1) === 0;
        const w = over ? cu * 0.9 + cv * 0.25 : cv * 0.9 + cu * 0.25;
        const fuzz = vfbm2(u * 120, v * 120, { octaves: 2, period: 120, seed });
        h[y * size + x] = clamp01(w * 0.75 + fuzz * 0.25);
      }
    }
    return h;
  },
};

/**
 * Bakes a detail normal tile. `worldSize` is how big one repeat of this tile
 * is in metres — a couple of centimetres — which is what makes the derived
 * slopes physically meaningful rather than a hand-tuned strength.
 */
export function generateDetailNormal(family, size, seed = 1, worldSize = 0.06, amplitude = 0.0009) {
  const fn = DETAIL[family] || DETAIL.grain;
  const h = fn(size, seed);
  return { size, family, normal: heightToNormalWorld(h, size, amplitude, worldSize, 1.0) };
}

export function detailFamilies() { return Object.keys(DETAIL); }

// ===========================================================================
//                                  driver
// ===========================================================================

/** Packs occlusion / roughness / metalness into one RGBA texture (glTF ORM). */
function packORM(ao, rough, metal) {
  const n = ao.length;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = clamp01(ao[i]) * 255;
    data[i * 4 + 1] = clamp01(rough[i]) * 255;
    data[i * 4 + 2] = clamp01(metal[i]) * 255;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/**
 * Runs a generator and derives the full map set as raw typed arrays: albedo
 * (RGB8), tangent-space normal (RGBA8) and a packed ORM (RGBA8). Three
 * textures per material rather than five, which is a 40% cut in both texture
 * memory and sampler slots.
 */
export function generateSurface(name, size, seed = 1, opts = {}) {
  const def = SURFACES[name];
  if (!def) throw new Error(`Unknown surface "${name}"`);
  const tileMeters = opts.tile ?? def.tile;
  const amplitude = opts.amplitude ?? def.amplitude;
  const out = def.gen(size, seed, opts);
  const normal = heightToNormalWorld(out.height, size, amplitude, tileMeters, opts.normalStrength ?? 1.0);
  const ao = horizonAO(out.height, size, amplitude, tileMeters, {
    radiusTexels: def.ao?.radiusTexels ?? 11,
    microStrength: def.ao?.microStrength ?? 0.6,
    strength: (def.ao?.strength ?? 1.0) * (opts.aoStrength ?? 1.0),
    workSize: size <= 512 ? 192 : 256,
  });
  return {
    size,
    rgb: out.rgb,
    normal,
    orm: packORM(ao, out.rough, out.metal),
    detail: def.detail || 'grain',
  };
}

export function surfaceNames() { return Object.keys(SURFACES); }
export function surfaceDef(name) { return SURFACES[name]; }
