import { fbm2, ridged2, worley2, clamp01, smoothstep, mix } from './Noise.js';

// ---------------------------------------------------------------------------
// Pure, dependency-free surface synthesis. Shared verbatim between the main
// thread and the bake worker pool — must never import three.js or touch DOM.
// ---------------------------------------------------------------------------

/** Sobel-derives a tangent-space normal map from a height field. */
export function heightToNormal(height, size, strength = 2.0) {
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      data[i + 0] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * Cheap screen-space-free ambient occlusion baked from the height field:
 * compares each texel against a blurred version of itself, so crevices darken.
 */
export function heightToAO(height, size, radius = 6, strength = 1.0) {
  const blurred = new Float32Array(size * size);
  const tmp = new Float32Array(size * size);
  const r = Math.max(1, radius | 0);
  // separable box blur, wrapping
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += height[y * size + (((x + k) % size) + size) % size];
      tmp[y * size + x] = s / (2 * r + 1);
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[((((y + k) % size) + size) % size) * size + x];
      blurred[y * size + x] = s / (2 * r + 1);
    }
  }
  const ao = new Float32Array(size * size);
  for (let i = 0; i < ao.length; i++) {
    ao[i] = clamp01(1 - (blurred[i] - height[i]) * 4 * strength);
  }
  return ao;
}

// --------------------------- surface generators ----------------------------
// Each returns { rgb: Uint8Array(size*size*3), height: Float32Array,
//                rough: Float32Array, metal?: Float32Array }

const SURFACES = {
  /** Poured / board-formed concrete with aggregate pitting and staining. */
  concrete(size, seed = 1) {
    const rgb = new Uint8Array(size * size * 3);
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    const s = 8 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = x * s, v = y * s;
        const base = fbm2(u * 0.9, v * 0.9, { octaves: 6, period: 8 });
        const grain = fbm2(u * 9, v * 9, { octaves: 3, period: 72 });
        // aggregate: small pits from worley
        const w = worley2(u * 6, v * 6, 48, seed);
        const pit = smoothstep(0.0, 0.16, w.f1) * 0.85 + 0.15;
        // cracks
        const crack = smoothstep(0.72, 0.95, ridged2(u * 1.6, v * 1.6, { octaves: 4, period: 13 }));
        // vertical water staining
        const stain = fbm2(u * 0.35, v * 0.08, { octaves: 4, period: 3 });

        let h = base * 0.55 + grain * 0.18 + pit * 0.27;
        h -= crack * 0.55;
        height[i] = clamp01(h);

        let lum = 0.50 + (base - 0.5) * 0.30 + (grain - 0.5) * 0.10;
        lum *= mix(1.0, 0.72, smoothstep(0.45, 0.85, stain));
        lum *= mix(1.0, 0.45, crack);
        lum = clamp01(lum);

        // slightly warm-grey concrete, cooler in the damp streaks
        const warm = mix(1.03, 0.95, smoothstep(0.45, 0.85, stain));
        rgb[i * 3 + 0] = Math.round(clamp01(lum * warm) * 255);
        rgb[i * 3 + 1] = Math.round(clamp01(lum * 0.99) * 255);
        rgb[i * 3 + 2] = Math.round(clamp01(lum * (2 - warm) * 0.97) * 255);

        rough[i] = clamp01(0.88 - (grain - 0.5) * 0.14 - smoothstep(0.45, 0.9, stain) * 0.30);
      }
    }
    return { rgb, height, rough };
  },

  /** Weathered asphalt: fine gravel bed, tar patches, tyre polish. */
  asphalt(size, seed = 2) {
    const rgb = new Uint8Array(size * size * 3);
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    const s = 8 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = x * s, v = y * s;
        const w1 = worley2(u * 16, v * 16, 128, seed);
        const w2 = worley2(u * 34, v * 34, 272, seed + 7);
        const gravel = smoothstep(0.0, 0.35, w1.f1) * 0.6 + smoothstep(0.0, 0.3, w2.f1) * 0.4;
        const patch = fbm2(u * 0.7, v * 0.7, { octaves: 5, period: 6 });
        const crack = smoothstep(0.78, 0.97, ridged2(u * 2.2, v * 2.2, { octaves: 5, period: 18 }));

        height[i] = clamp01(gravel * 0.7 + patch * 0.3 - crack * 0.7);

        // asphalt is dark; gravel chips catch light
        let lum = 0.115 + gravel * 0.16 + (patch - 0.5) * 0.05;
        lum *= mix(1.0, 0.72, crack);
        const chip = smoothstep(0.62, 0.9, w2.f2 - w2.f1); // bright quartz specks
        lum += chip * 0.22;
        lum = clamp01(lum);
        rgb[i * 3 + 0] = Math.round(lum * 255);
        rgb[i * 3 + 1] = Math.round(clamp01(lum * 1.01) * 255);
        rgb[i * 3 + 2] = Math.round(clamp01(lum * 1.06) * 255);

        rough[i] = clamp01(0.94 - gravel * 0.12 - smoothstep(0.55, 0.9, patch) * 0.25);
      }
    }
    return { rgb, height, rough };
  },

  /** Painted steel / vehicle panel: chipped paint over primer over bare metal. */
  paintedMetal(size, seed = 3, base = [0.22, 0.26, 0.21]) {
    const rgb = new Uint8Array(size * size * 3);
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    const metal = new Float32Array(size * size);
    const s = 8 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = x * s, v = y * s;
        const wear = fbm2(u * 2.4, v * 2.4, { octaves: 5, period: 20 });
        const edgeWear = ridged2(u * 3.1, v * 3.1, { octaves: 4, period: 25 });
        const chipped = smoothstep(0.58, 0.70, wear * 0.6 + edgeWear * 0.4);
        const rustMask = smoothstep(0.55, 0.85, fbm2(u * 5.5, v * 5.5, { octaves: 4, period: 44 })) * chipped;
        const brushed = fbm2(u * 60, v * 2, { octaves: 2, period: 480 });
        const dent = fbm2(u * 1.1, v * 1.1, { octaves: 3, period: 9 });

        height[i] = clamp01(0.55 + (dent - 0.5) * 0.5 - chipped * 0.25 + (brushed - 0.5) * 0.05);

        const primer = [0.30, 0.29, 0.28];
        const rust = [0.31, 0.14, 0.07];
        const steel = [0.55, 0.56, 0.58];

        let r = base[0], g = base[1], b = base[2];
        // paint has subtle mottling
        const mot = 1 + (fbm2(u * 8, v * 8, { octaves: 3, period: 64 }) - 0.5) * 0.12;
        r *= mot; g *= mot; b *= mot;
        r = mix(r, primer[0], chipped * 0.8);
        g = mix(g, primer[1], chipped * 0.8);
        b = mix(b, primer[2], chipped * 0.8);
        const bare = smoothstep(0.72, 0.9, wear) * (1 - rustMask);
        r = mix(r, steel[0] * (0.85 + brushed * 0.3), bare);
        g = mix(g, steel[1] * (0.85 + brushed * 0.3), bare);
        b = mix(b, steel[2] * (0.85 + brushed * 0.3), bare);
        r = mix(r, rust[0], rustMask); g = mix(g, rust[1], rustMask); b = mix(b, rust[2], rustMask);

        rgb[i * 3 + 0] = Math.round(clamp01(r) * 255);
        rgb[i * 3 + 1] = Math.round(clamp01(g) * 255);
        rgb[i * 3 + 2] = Math.round(clamp01(b) * 255);

        // satin paint is smooth; rust and primer are rough
        rough[i] = clamp01(mix(0.42, 0.86, chipped) + rustMask * 0.12 - bare * 0.22);
        metal[i] = clamp01(bare * 0.9 * (1 - rustMask));
      }
    }
    return { rgb, height, rough, metal };
  },

  /** Gunmetal: phosphate/parkerised finish with machining marks. */
  gunmetal(size, seed = 4) {
    const rgb = new Uint8Array(size * size * 3);
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    const metal = new Float32Array(size * size);
    const s = 8 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = x * s, v = y * s;
        const grain = fbm2(u * 40, v * 40, { octaves: 4, period: 320 });
        const machine = fbm2(u * 110, v * 3, { octaves: 2, period: 880 });
        const wear = smoothstep(0.66, 0.86, fbm2(u * 3.2, v * 3.2, { octaves: 5, period: 26 }));
        const speck = worley2(u * 26, v * 26, 208, seed);
        const pit = 1 - smoothstep(0.0, 0.1, speck.f1);

        height[i] = clamp01(0.5 + (grain - 0.5) * 0.4 + (machine - 0.5) * 0.15 - pit * 0.4);

        let lum = 0.075 + (grain - 0.5) * 0.045 + (machine - 0.5) * 0.02;
        lum = mix(lum, 0.30, wear); // worn edges go bright bare steel
        lum = clamp01(lum);
        rgb[i * 3 + 0] = Math.round(lum * 255);
        rgb[i * 3 + 1] = Math.round(clamp01(lum * 1.02) * 255);
        rgb[i * 3 + 2] = Math.round(clamp01(lum * 1.07) * 255);

        rough[i] = clamp01(mix(0.55, 0.22, wear) + (grain - 0.5) * 0.12 + pit * 0.2);
        metal[i] = 1.0;
      }
    }
    return { rgb, height, rough, metal };
  },

  /** Sandy desert ground with ripples and scattered pebbles. */
  sand(size, seed = 5) {
    const rgb = new Uint8Array(size * size * 3);
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    const s = 8 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = x * s, v = y * s;
        const ripple = Math.sin((u * 7 + fbm2(u * 1.2, v * 1.2, { octaves: 3, period: 10 }) * 6) * Math.PI) * 0.5 + 0.5;
        const dunes = fbm2(u * 0.8, v * 0.8, { octaves: 5, period: 7 });
        const grit = fbm2(u * 55, v * 55, { octaves: 3, period: 440 });
        const peb = worley2(u * 11, v * 11, 88, seed);
        const pebble = 1 - smoothstep(0.02, 0.09, peb.f1);

        height[i] = clamp01(dunes * 0.5 + ripple * 0.22 + grit * 0.13 + pebble * 0.35);

        let r = 0.60, g = 0.50, b = 0.36;
        const tint = 0.86 + dunes * 0.3 + (grit - 0.5) * 0.12 + ripple * 0.06;
        r *= tint; g *= tint; b *= tint;
        // pebbles are greyer
        r = mix(r, 0.42, pebble); g = mix(g, 0.40, pebble); b = mix(b, 0.37, pebble);
        rgb[i * 3 + 0] = Math.round(clamp01(r) * 255);
        rgb[i * 3 + 1] = Math.round(clamp01(g) * 255);
        rgb[i * 3 + 2] = Math.round(clamp01(b) * 255);

        rough[i] = clamp01(0.95 - pebble * 0.25 + (grit - 0.5) * 0.06);
      }
    }
    return { rgb, height, rough };
  },

  /** Stucco / plaster wall, common Middle-Eastern urban facade. */
  plaster(size, seed = 6, base = [0.62, 0.57, 0.48]) {
    const rgb = new Uint8Array(size * size * 3);
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    const s = 8 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = x * s, v = y * s;
        const trowel = fbm2(u * 3.5, v * 3.5, { octaves: 5, period: 28 });
        const fine = fbm2(u * 26, v * 26, { octaves: 3, period: 208 });
        // spalled patches revealing brick-coloured substrate
        const spall = smoothstep(0.62, 0.78, fbm2(u * 1.9, v * 1.9, { octaves: 5, period: 15 }));
        const dirt = fbm2(u * 0.5, v * 0.16, { octaves: 4, period: 4 });

        height[i] = clamp01(trowel * 0.6 + fine * 0.2 - spall * 0.5);

        let r = base[0], g = base[1], b = base[2];
        const shade = 0.85 + trowel * 0.28 + (fine - 0.5) * 0.1;
        r *= shade; g *= shade; b *= shade;
        r = mix(r, 0.40, spall); g = mix(g, 0.29, spall); b = mix(b, 0.23, spall);
        const grime = smoothstep(0.5, 0.9, dirt) * 0.35;
        r *= 1 - grime; g *= 1 - grime * 0.95; b *= 1 - grime * 0.85;
        rgb[i * 3 + 0] = Math.round(clamp01(r) * 255);
        rgb[i * 3 + 1] = Math.round(clamp01(g) * 255);
        rgb[i * 3 + 2] = Math.round(clamp01(b) * 255);

        rough[i] = clamp01(0.90 - (fine - 0.5) * 0.1 + spall * 0.06);
      }
    }
    return { rgb, height, rough };
  },

  /** Corrugated / riveted sheet metal for shipping containers and roofs. */
  corrugated(size, seed = 7, base = [0.20, 0.30, 0.34]) {
    const rgb = new Uint8Array(size * size * 3);
    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    const metal = new Float32Array(size * size);
    const s = 8 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const u = x * s, v = y * s;
        // 16 ribs across the tile — integer count keeps it seamless
        const rib = Math.sin(u * Math.PI * 2 * 2) * 0.5 + 0.5;
        const ribSharp = Math.pow(rib, 0.7);
        const rust = smoothstep(0.52, 0.80, fbm2(u * 3.0, v * 3.0, { octaves: 5, period: 24 }));
        const streak = smoothstep(0.4, 0.9, fbm2(u * 6, v * 0.5, { octaves: 4, period: 48 })) * rust;
        const dent = fbm2(u * 4, v * 4, { octaves: 3, period: 32 });

        height[i] = clamp01(ribSharp * 0.75 + (dent - 0.5) * 0.18 - rust * 0.12);

        let r = base[0], g = base[1], b = base[2];
        const sh = 0.8 + ribSharp * 0.35 + (dent - 0.5) * 0.1;
        r *= sh; g *= sh; b *= sh;
        r = mix(r, 0.34, rust); g = mix(g, 0.16, rust); b = mix(b, 0.08, rust);
        r = mix(r, 0.28, streak * 0.7); g = mix(g, 0.15, streak * 0.7); b = mix(b, 0.09, streak * 0.7);
        rgb[i * 3 + 0] = Math.round(clamp01(r) * 255);
        rgb[i * 3 + 1] = Math.round(clamp01(g) * 255);
        rgb[i * 3 + 2] = Math.round(clamp01(b) * 255);

        rough[i] = clamp01(mix(0.48, 0.92, rust));
        metal[i] = clamp01(1 - rust * 0.75);
      }
    }
    return { rgb, height, rough, metal };
  },
};


/** Runs a generator and derives the full map set as raw typed arrays. */
export function generateSurface(name, size, seed = 1, opts = {}) {
  const gen = SURFACES[name];
  if (!gen) throw new Error(`Unknown surface "${name}"`);
  const out = gen(size, seed, opts.base);
  const normal = heightToNormal(out.height, size, opts.normalStrength ?? 2.0);
  const ao = heightToAO(out.height, size, Math.max(2, size >> 7), opts.aoStrength ?? 1.0);
  return {
    size,
    rgb: out.rgb,
    normal,
    rough: packSingle(out.rough),
    ao: packSingle(ao),
    metal: out.metal ? packSingle(out.metal) : null,
  };
}

/** Float32 [0,1] field -> 8-bit greyscale RGBA, ready for a DataTexture. */
function packSingle(field) {
  const n = field.length;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(clamp01(field[i]) * 255);
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  return data;
}

export function surfaceNames() {
  return Object.keys(SURFACES);
}
