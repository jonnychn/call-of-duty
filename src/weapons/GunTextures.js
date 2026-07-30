import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural detail maps for the viewmodel. Everything is generated at runtime
// on a 2D canvas and converted to a tangent-space normal map with a Sobel
// filter, so no art assets are involved.
//
// These are small (256px) and shared across every weapon: the whole set is
// ~1.3 MB of texture memory and bakes in a couple of milliseconds.
// ---------------------------------------------------------------------------

const cache = new Map();
function memo(key, fn) {
  let v = cache.get(key);
  if (!v) { v = fn(); cache.set(key, v); }
  return v;
}

const SIZE = 256;

function makeCanvas(size = SIZE) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** Deterministic value noise so the maps are identical every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Sobel height -> tangent-space normal map. */
function heightToNormal(ctx, size, strength) {
  const src = ctx.getImageData(0, 0, size, size).data;
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => src[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function grayTexture(ctx, size, colorSpace = THREE.NoColorSpace) {
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = colorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// --------------------------------------------------------------------------

/**
 * Stippled rubber/polymer grip texture: a dense field of raised pyramids with
 * a few moulded ridges. Used on the pistol grip, mag body and the glove palms.
 */
export function gripNormal() {
  return memo('gripNormal', () => {
    const c = makeCanvas();
    const g = c.getContext('2d');
    g.fillStyle = '#606060';
    g.fillRect(0, 0, SIZE, SIZE);
    const r = rng(0x51ab);
    const step = 16;
    for (let y = 0; y < SIZE; y += step) {
      for (let x = 0; x < SIZE; x += step) {
        const ox = (y / step) % 2 ? step / 2 : 0;
        const cx = x + ox + (r() - 0.5) * 1.2, cy = y + (r() - 0.5) * 1.2;
        const rad = step * 0.36;
        const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
        grd.addColorStop(0, '#ffffff');
        grd.addColorStop(0.55, '#b8b8b8');
        grd.addColorStop(1, '#606060');
        g.fillStyle = grd;
        g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
      }
    }
    // micro grain over the top so it never looks like a perfect lattice
    for (let i = 0; i < 5000; i++) {
      g.fillStyle = `rgba(0,0,0,${r() * 0.12})`;
      g.fillRect(r() * SIZE, r() * SIZE, 1, 1);
    }
    return heightToNormal(g, SIZE, 2.6);
  });
}

/**
 * Machined-aluminium micro detail: fine tooling lines plus scattered scratches
 * and dings. This is what stops the receiver reading as plastic.
 */
export function machinedNormal() {
  return memo('machinedNormal', () => {
    const c = makeCanvas();
    const g = c.getContext('2d');
    g.fillStyle = '#808080';
    g.fillRect(0, 0, SIZE, SIZE);
    const r = rng(0x9d3f);
    // brushed tooling lines
    for (let i = 0; i < 700; i++) {
      const y = r() * SIZE;
      const v = 128 + (r() - 0.5) * 34;
      g.strokeStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
      g.lineWidth = r() * 1.4 + 0.3;
      g.beginPath(); g.moveTo(0, y); g.lineTo(SIZE, y + (r() - 0.5) * 4); g.stroke();
    }
    // scratches
    for (let i = 0; i < 40; i++) {
      const x = r() * SIZE, y = r() * SIZE, a = r() * Math.PI * 2, len = 8 + r() * 55;
      g.strokeStyle = r() > 0.5 ? 'rgba(255,255,255,0.55)' : 'rgba(20,20,20,0.55)';
      g.lineWidth = r() * 1.1 + 0.4;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
    }
    // impact dings
    for (let i = 0; i < 22; i++) {
      const x = r() * SIZE, y = r() * SIZE, rad = 1.2 + r() * 3.2;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(40,40,40,0.8)');
      grd.addColorStop(0.7, 'rgba(210,210,210,0.5)');
      grd.addColorStop(1, 'rgba(128,128,128,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    return heightToNormal(g, SIZE, 1.5);
  });
}

/** Roughness variation: worn edges are polished, recesses hold grime. */
export function wearRoughness(base = 0.5, spread = 0.34) {
  return memo(`wear${base}_${spread}`, () => {
    const c = makeCanvas();
    const g = c.getContext('2d');
    const r = rng(0x2c71);
    const v0 = Math.round(base * 255);
    g.fillStyle = `rgb(${v0},${v0},${v0})`;
    g.fillRect(0, 0, SIZE, SIZE);
    // large soft blotches
    for (let i = 0; i < 60; i++) {
      const x = r() * SIZE, y = r() * SIZE, rad = 10 + r() * 60;
      const d = (r() - 0.5) * spread * 2 * 255;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, `rgba(${d > 0 ? 255 : 0},${d > 0 ? 255 : 0},${d > 0 ? 255 : 0},${Math.abs(d) / 255})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    // polished streaks
    for (let i = 0; i < 200; i++) {
      const y = r() * SIZE;
      g.strokeStyle = `rgba(0,0,0,${r() * 0.2})`;
      g.lineWidth = r() * 2 + 0.4;
      g.beginPath(); g.moveTo(0, y); g.lineTo(SIZE, y + (r() - 0.5) * 8); g.stroke();
    }
    return grayTexture(g, SIZE);
  });
}

/**
 * Woven nylon / cordura for the sleeve. A twill-ish over-under weave.
 */
export function weaveNormal() {
  return memo('weaveNormal', () => {
    const c = makeCanvas();
    const g = c.getContext('2d');
    g.fillStyle = '#707070';
    g.fillRect(0, 0, SIZE, SIZE);
    const step = 8;
    for (let y = 0; y < SIZE; y += step) {
      for (let x = 0; x < SIZE; x += step) {
        const over = ((x / step) + (y / step)) % 2 === 0;
        const grd = g.createLinearGradient(x, y, over ? x + step : x, over ? y : y + step);
        grd.addColorStop(0, '#555');
        grd.addColorStop(0.5, over ? '#e8e8e8' : '#c8c8c8');
        grd.addColorStop(1, '#555');
        g.fillStyle = grd;
        g.fillRect(x, y, step, step);
      }
    }
    const r = rng(0x77aa);
    for (let i = 0; i < 8000; i++) {
      g.fillStyle = `rgba(0,0,0,${r() * 0.18})`;
      g.fillRect(r() * SIZE, r() * SIZE, 1, 1);
    }
    return heightToNormal(g, SIZE, 1.9);
  });
}

/**
 * Engraved receiver markings: caliber stamp, selector legend, a serial block
 * and a couple of panel lines. Drawn with the browser's own sans-serif, which
 * is not an asset we ship.
 */
export function markingsNormal() {
  return memo('markingsNormal', () => {
    const c = makeCanvas(512);
    const S = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#808080';
    g.fillRect(0, 0, S, S);
    g.fillStyle = '#404040';
    g.textBaseline = 'middle';
    const stamp = (text, x, y, size, spacing = 1) => {
      g.font = `600 ${size}px sans-serif`;
      let cx = x;
      for (const ch of text) {
        g.fillText(ch, cx, y);
        cx += g.measureText(ch).width + spacing;
      }
    };
    stamp('CAL 5.56 NATO', 22, 60, 26, 2);
    stamp('SAFE  SEMI  AUTO', 22, 130, 20, 1.5);
    stamp('SN 4471-A', 22, 196, 18, 1.5);
    stamp('PROPERTY OF U.S. GOVT', 22, 330, 17, 1.5);
    // panel / seam lines
    g.strokeStyle = '#3a3a3a';
    g.lineWidth = 2;
    for (const y of [96, 240, 300, 400]) {
      g.beginPath(); g.moveTo(10, y); g.lineTo(S - 10, y); g.stroke();
    }
    const t = heightToNormal(g, S, 1.1);
    return t;
  });
}

export function disposeGunTextures() {
  for (const t of cache.values()) t.dispose?.();
  cache.clear();
}
