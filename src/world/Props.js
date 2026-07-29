import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Set-dressing library. Every function takes the shared GeometryBuilder and
// emits boxes/shapes into it — nothing here allocates a mesh of its own, so
// dressing the level densely costs triangles but not draw calls.
//
// Everything is authored around a 1.75 m player: door heads at 2.1 m, kerbs at
// 0.16 m, waist-high cover at 0.95 m, mantleable ledges under 1.6 m. Human
// reference is the whole point of the prop pass.
// ---------------------------------------------------------------------------

const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const CYL_HI = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
const SPH = new THREE.IcosahedronGeometry(0.5, 1);

export function cylinder(b, mat, x, y, z, r, h, rot, opts) {
  b.shape(mat, opts?.hi ? CYL_HI : CYL, { x, y: y + h / 2, z },
    rot || { x: 0, y: 0, z: 0 }, { x: r * 2, y: h, z: r * 2 },
    { collide: opts?.collide !== false, uvScale: [(2 * Math.PI * r) / (mat.userData.tile ?? 2), h / (mat.userData.tile ?? 2)] });
}

// ------------------------------- barriers ---------------------------------

/** Jersey barrier — tapered profile, not a slab. Waist-high cover. */
export function jerseyBarrier(b, mat, x, y, z, rotY) {
  const L = 3.2;
  b.box(mat, x, y, z, 0.62, 0.24, L, rotY);
  b.box(mat, x, y + 0.24, z, 0.46, 0.34, L * 0.995, rotY);
  b.box(mat, x, y + 0.58, z, 0.3, 0.37, L * 0.99, rotY);
  b.box(mat, x, y + 0.95, z, 0.36, 0.06, L * 0.98, rotY);
}

/** Hesco-style gabion: wire cage of earth, chest high. */
export function hesco(b, fill, frame, x, y, z, len, rotY) {
  b.box(fill, x, y, z, 1.05, 1.15, len, rotY);
  const n = Math.max(1, Math.round(len / 1.05));
  for (let i = 0; i <= n; i++) {
    const o = -len / 2 + (len * i) / n;
    b.box(frame, x + Math.sin(rotY) * -o, y, z + Math.cos(rotY) * o, 1.12, 1.18, 0.05, rotY);
  }
  b.box(frame, x, y + 1.15, z, 1.12, 0.05, len, rotY);
}

/** Sandbag emplacement: rows of staggered bags, optionally with a firing step. */
export function sandbags(b, mat, x, y, z, rotY, rows = 3, len = 7) {
  const bag = new THREE.CapsuleGeometry(0.21, 0.32, 2, 6);
  bag.rotateZ(Math.PI / 2);
  const c = Math.cos(rotY), s = Math.sin(rotY);
  for (let row = 0; row < rows; row++) {
    const n = Math.max(2, len - row);
    for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * 0.62 + (row % 2) * 0.31;
      b.shape(mat, bag,
        { x: x + c * o, y: y + 0.2 + row * 0.33, z: z - s * o },
        { x: 0, y: rotY + (i * 0.7 % 0.2) - 0.1, z: 0 },
        { x: 1, y: 1, z: 1 }, { collide: true, uvScale: [0.6, 0.4] });
    }
  }
  bag.dispose();
}

// -------------------------------- vehicles ---------------------------------

/** Burnt-out saloon car. Sits on its rims, doors gone, roof caved. */
export function carWreck(b, body, dark, rust, x, y, z, rotY, rng) {
  const r = rng || (() => 0.5);
  const c = Math.cos(rotY), s = Math.sin(rotY);
  const P = (lx, lz) => [x + c * lx - s * lz, z + s * lx + c * lz];

  // chassis + crumple
  b.box(body, x, y + 0.36, z, 1.82, 0.46, 4.1, rotY);
  b.box(dark, x, y + 0.2, z, 1.9, 0.2, 4.2, rotY);
  // bonnet / boot
  const [bx, bz] = P(0, 1.45);
  b.box(body, bx, y + 0.82, bz, 1.7, 0.16, 1.2, rotY);
  const [tx, tz] = P(0, -1.5);
  b.box(body, tx, y + 0.8, tz, 1.66, 0.2, 1.05, rotY);
  // cabin frame — pillars only, glass blown out
  for (const lx of [-0.82, 0.82]) {
    for (const lz of [0.85, -0.15, -1.0]) {
      const [px, pz] = P(lx, lz);
      b.box(dark, px, y + 0.82, pz, 0.12, 0.62, 0.14, rotY);
    }
  }
  // caved roof
  const [rx, rz] = P(0, -0.15);
  b.box(dark, rx, y + 1.4, rz, 1.62, 0.09, 2.1, rotY + 0.05);
  b.box(dark, rx, y + 1.3, rz - 0.1, 1.0, 0.09, 1.0, rotY - 0.3);
  // rims
  for (const lx of [-0.86, 0.86]) for (const lz of [1.35, -1.35]) {
    const [wx, wz] = P(lx, lz);
    cylinder(b, rust, wx, y + 0.0, wz, 0.31, 0.22, { x: 0, y: 0, z: Math.PI / 2 + (r() - 0.5) * 0.2 });
  }
}

/** Gutted city bus lying across a street — the classic CoD sightline block. */
export function busWreck(b, body, dark, rust, glass, x, y, z, rotY) {
  const L = 10.4, W = 2.55, H = 2.05;
  const c = Math.cos(rotY), s = Math.sin(rotY);
  const P = (lx, lz) => [x + c * lx - s * lz, z + s * lx + c * lz];

  b.box(dark, x, y + 0.55, z, W, 0.4, L, rotY);            // underframe
  // side walls with a window band cut out
  for (const lx of [-W / 2 + 0.06, W / 2 - 0.06]) {
    const [sx, sz] = P(lx, 0);
    b.box(body, sx, y + 0.95, sz, 0.12, 0.72, L, rotY);     // below windows
    b.box(rust, sx, y + 2.42, sz, 0.14, 0.34, L, rotY);     // above windows
    // window pillars
    for (let i = -4; i <= 4; i++) {
      const [px, pz] = P(lx, i * 1.15);
      b.box(dark, px, y + 1.67, pz, 0.13, 0.75, 0.11, rotY);
    }
  }
  // ends
  for (const lz of [L / 2 - 0.07, -L / 2 + 0.07]) {
    const [ex, ez] = P(0, lz);
    b.box(body, ex, y + 0.95, ez, W, 1.0, 0.14, rotY);
    b.box(glass, ex, y + 1.95, ez, W - 0.24, 0.85, 0.08, rotY);
  }
  // roof — collapsed in the middle third
  const [r1x, r1z] = P(0, L / 2 - 1.9);
  b.box(rust, r1x, y + 2.72, r1z, W, 0.1, 3.6, rotY);
  const [r2x, r2z] = P(0, -L / 2 + 2.4);
  b.box(rust, r2x, y + 2.66, r2z, W, 0.1, 4.4, rotY - 0.02);
  const [r3x, r3z] = P(0.1, 0.4);
  b.box(rust, r3x, y + 2.2, r3z, W - 0.3, 0.08, 2.0, rotY + 0.16);
  // wheels on rims
  for (const lz of [L / 2 - 1.7, -L / 2 + 2.0, -L / 2 + 3.3]) {
    for (const lx of [-W / 2 + 0.2, W / 2 - 0.2]) {
      const [wx, wz] = P(lx, lz);
      cylinder(b, rust, wx, y, wz, 0.42, 0.3, { x: 0, y: rotY, z: Math.PI / 2 });
    }
  }
}

// -------------------------------- street ------------------------------------

/** Utility pole with crossarm, insulators and a slack catenary of wire. */
export function utilityPole(b, wood, metal, wire, x, y, z, h = 8.4, lean = 0) {
  cylinder(b, wood, x, y, z, 0.13, h, { x: lean, y: 0, z: lean * 0.6 });
  b.box(metal, x, y + h - 0.9, z, 2.0, 0.11, 0.11);
  b.box(metal, x, y + h - 1.9, z, 1.4, 0.09, 0.09);
  for (const o of [-0.85, 0, 0.85]) cylinder(b, metal, x + o, y + h - 0.79, z, 0.07, 0.16, null, { collide: false });
  return { top: y + h - 0.85 };
}

/** Sagging wire between two points, as a chain of thin boxes. */
export function wire(b, mat, x0, y0, z0, x1, y1, z1, sag = 1.1, seg = 8) {
  let px = x0, py = y0, pz = z0;
  for (let i = 1; i <= seg; i++) {
    const t = i / seg;
    const nx = x0 + (x1 - x0) * t;
    const nz = z0 + (z1 - z0) * t;
    const ny = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * sag;
    const dx = nx - px, dy = ny - py, dz = nz - pz;
    const len = Math.hypot(dx, dy, dz);
    const midY = (py + ny) / 2;
    const yaw = Math.atan2(dx, dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    b.shape(mat, new THREE.BoxGeometry(0.045, 0.045, 1),
      { x: (px + nx) / 2, y: midY, z: (pz + nz) / 2 },
      { x: -pitch, y: yaw, z: 0 }, { x: 1, y: 1, z: len }, { collide: false });
    px = nx; py = ny; pz = nz;
  }
}

/** Street lamp: pole, curved arm, hood. */
export function streetLamp(b, metal, x, y, z, dir = 1, h = 6.2) {
  cylinder(b, metal, x, y, z, 0.1, h);
  b.box(metal, x, y, z, 0.34, 0.5, 0.34);
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    b.box(metal, x + dir * (0.28 + t * 1.25), y + h - 0.5 + Math.sin(t * 1.5) * 0.5, z, 0.55, 0.11, 0.11, 0, { collide: false });
  }
  b.box(metal, x + dir * 1.75, y + h - 0.16, z, 0.7, 0.16, 0.34, 0, { collide: false });
}

// ------------------------------- market -------------------------------------

/** Market stall: timber frame, sloped tarp canopy, counter, produce crates. */
export function stall(b, wood, tarp, crate, x, y, z, rotY, w = 2.6, d = 1.8, rng) {
  const r = rng || (() => 0.5);
  const c = Math.cos(rotY), s = Math.sin(rotY);
  const P = (lx, lz) => [x + c * lx - s * lz, z + s * lx + c * lz];
  const H = 2.15;
  for (const lx of [-w / 2 + 0.08, w / 2 - 0.08]) {
    for (const lz of [-d / 2 + 0.08, d / 2 - 0.08]) {
      const [px, pz] = P(lx, lz);
      b.box(wood, px, y, pz, 0.09, H + (lz > 0 ? 0 : 0.32), 0.09, rotY);
    }
  }
  // counter
  const [cx, cz] = P(0, d / 2 - 0.25);
  b.box(wood, cx, y + 0.82, cz, w, 0.08, 0.62, rotY);
  b.box(wood, cx, y + 0.2, cz, w - 0.2, 0.62, 0.06, rotY);
  // canopy — sloped, slightly rippled
  const [ax, az] = P(0, 0);
  b.box(tarp, ax, y + H + 0.16, az, w + 0.5, 0.05, d + 0.6, rotY);
  b.shape(tarp, new THREE.BoxGeometry(w + 0.5, 0.05, d + 0.7),
    { x: ax, y: y + H + 0.3, z: az }, { x: -0.16, y: rotY, z: 0 }, { x: 1, y: 1, z: 1 },
    { collide: false, uvScale: [w / 2, d / 2] });
  // valance
  const [vx, vz] = P(0, d / 2 + 0.28);
  b.box(tarp, vx, y + H - 0.16, vz, w + 0.5, 0.34, 0.04, rotY, { collide: false });
  // crates under the counter
  for (let i = 0; i < 3; i++) {
    const [bx, bz] = P(-w / 2 + 0.45 + i * 0.75, -d / 2 + 0.45);
    b.box(crate, bx, y, bz, 0.5, 0.36 + r() * 0.2, 0.44, rotY + (r() - 0.5) * 0.5);
  }
}

/** Awning bolted to a facade. */
export function awning(b, tarp, metal, x, y, z, w, proj, rotY, rng) {
  const r = rng || (() => 0.5);
  const c = Math.cos(rotY), s = Math.sin(rotY);
  // Three panels across the span rather than one flat slab. Cloth stretched
  // between two bearers sags in the middle and the free edge droops; a
  // dimensionally perfect awning is one of the loudest tells in the frame.
  const nSeg = 3;
  for (let i = 0; i < nSeg; i++) {
    const t = (i + 0.5) / nSeg;
    const off = (t - 0.5) * w;
    const sag = Math.sin(t * Math.PI) * (0.05 + r() * 0.055);
    b.shape(tarp, new THREE.BoxGeometry(w / nSeg + 0.03, 0.05, proj),
      { x: x + c * off, y: y - sag, z: z - s * off },
      { x: 0.22 + sag * 0.9, y: rotY, z: (r() - 0.5) * 0.05 }, { x: 1, y: 1, z: 1 },
      { collide: false, uvScale: [w / nSeg / 2, proj / 2] });
  }
  for (const o of [-w / 2 + 0.15, w / 2 - 0.15]) {
    b.box(metal, x + c * o, y - 0.24, z - s * o, 0.05, 0.05, proj, rotY, { collide: false });
  }
  // Valance, hanging unevenly.
  for (let i = 0; i < nSeg; i++) {
    const t = (i + 0.5) / nSeg;
    const off = (t - 0.5) * w;
    const drop = 0.34 + r() * 0.16;
    b.shape(tarp, new THREE.BoxGeometry(w / nSeg + 0.02, drop, 0.03),
      { x: x + c * off + s * (proj / 2), y: y - 0.3 - drop / 2, z: z - s * off + c * (proj / 2) },
      { x: 0, y: rotY, z: (r() - 0.5) * 0.07 }, { x: 1, y: 1, z: 1 },
      { collide: false, uvScale: [w / nSeg / 1.6, drop / 1.6] });
  }
}

/** Hanging laundry line — reads instantly as "people lived here". */
export function laundry(b, wire_, cloth, x0, y0, z0, x1, y1, z1, rng) {
  const r = rng || (() => 0.5);
  wire(b, wire_, x0, y0, z0, x1, y1, z1, 0.5, 6);
  const n = 5;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const px = x0 + (x1 - x0) * t, pz = z0 + (z1 - z0) * t;
    const py = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * 0.5;
    const w = 0.5 + r() * 0.5, h = 0.6 + r() * 0.6;
    b.shape(cloth, new THREE.BoxGeometry(w, h, 0.03),
      { x: px, y: py - h / 2 - 0.03, z: pz },
      { x: 0, y: Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2, z: (r() - 0.5) * 0.2 },
      { x: 1, y: 1, z: 1 }, { collide: false, uvScale: [w, h] });
  }
}

// ------------------------------ roof clutter --------------------------------

export function acUnit(b, metal, dark, x, y, z, rotY, collide = true) {
  b.box(metal, x, y, z, 0.86, 0.62, 0.72, rotY, { collide });
  b.box(dark, x, y + 0.62, z, 0.7, 0.06, 0.58, rotY, { collide: false });
  cylinder(b, dark, x, y + 0.18, z + 0.37, 0.22, 0.05, { x: Math.PI / 2, y: 0, z: 0 }, { collide: false });
}

export function satelliteDish(b, metal, x, y, z, rotY, r = 0.55) {
  b.box(metal, x, y, z, 0.24, 0.5, 0.24, 0, { collide: false });
  b.shape(metal, new THREE.SphereGeometry(r, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.4),
    { x, y: y + 0.55 + r * 0.4, z }, { x: -1.05, y: rotY, z: 0 }, { x: 1, y: 0.45, z: 1 },
    { collide: false, uvScale: [1, 1] });
  b.box(metal, x + Math.sin(rotY) * r * 0.5, y + 0.55, z + Math.cos(rotY) * r * 0.5, 0.07, 0.07, 0.5, rotY, { collide: false });
}

export function waterTank(b, mat, x, y, z, r = 0.62, h = 1.15, collide = true) {
  cylinder(b, mat, x, y + 0.18, z, r, h, null, { hi: true, collide });
  b.box(mat, x, y, z - r * 0.7, 0.1, 0.2, 0.1, 0, { collide: false });
  b.box(mat, x, y, z + r * 0.7, 0.1, 0.2, 0.1, 0, { collide: false });
  b.box(mat, x - r * 0.7, y, z, 0.1, 0.2, 0.1, 0, { collide: false });
  b.box(mat, x + r * 0.7, y, z, 0.1, 0.2, 0.1, 0, { collide: false });
}

/** Exposed rebar sprouting from a broken concrete edge. */
export function rebar(b, mat, x, y, z, n, spread, len, rng) {
  const r = rng || (() => 0.5);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const L = len * (0.5 + r() * 0.8);
    b.shape(mat, new THREE.BoxGeometry(0.035, L, 0.035),
      { x: x + (r() - 0.5) * spread, y: y + L / 2, z: z + (r() - 0.5) * spread },
      { x: (r() - 0.5) * 0.9, y: a, z: (r() - 0.5) * 0.9 },
      { x: 1, y: 1, z: 1 }, { collide: false, uvScale: [0.05, L] });
  }
}

// -------------------------------- misc --------------------------------------

export function oilDrum(b, mat, x, y, z, rotY = 0, tipped = false) {
  if (tipped) {
    b.shape(mat, CYL_HI, { x, y: y + 0.29, z }, { x: Math.PI / 2, y: rotY, z: 0 },
      { x: 0.58, y: 0.88, z: 0.58 }, { collide: true, uvScale: [1.8, 0.9] });
  } else {
    cylinder(b, mat, x, y, z, 0.29, 0.88, null, { hi: true });
    cylinder(b, mat, x, y + 0.24, z, 0.31, 0.05, null, { hi: true, collide: false });
    cylinder(b, mat, x, y + 0.58, z, 0.31, 0.05, null, { hi: true, collide: false });
  }
}

export function crateStack(b, mat, x, y, z, rotY, rng, collide = true) {
  const r = rng || (() => 0.5);
  const n = 1 + Math.floor(r() * 3);
  let h = y;
  for (let i = 0; i < n; i++) {
    const s = 0.62 + r() * 0.3;
    b.box(mat, x + (r() - 0.5) * 0.18 * i, h, z + (r() - 0.5) * 0.18 * i, s, s * 0.72, s * 0.9, rotY + (r() - 0.5) * 0.4, { collide });
    h += s * 0.72;
  }
}

/** Pallet — flat, low, reads scale on the ground. */
export function pallet(b, mat, x, y, z, rotY) {
  b.box(mat, x, y, z, 1.2, 0.06, 0.8, rotY, { collide: false });
  for (const o of [-0.5, 0, 0.5]) b.box(mat, x + Math.cos(rotY) * o, y + 0.06, z - Math.sin(rotY) * o, 0.12, 0.08, 0.8, rotY, { collide: false });
  b.box(mat, x, y + 0.14, z, 1.2, 0.05, 0.8, rotY, { collide: false });
}

export function tyre(b, mat, x, y, z, rotY = 0, flat = false) {
  b.shape(mat, new THREE.TorusGeometry(0.32, 0.11, 6, 14),
    { x, y: y + 0.11, z }, { x: Math.PI / 2, y: rotY, z: 0 }, { x: 1, y: 1, z: flat ? 0.6 : 1 },
    { collide: false, uvScale: [2, 0.6] });
}

export function chair(b, mat, x, y, z, rotY, toppled = false) {
  const g = new THREE.Group();
  const rot = toppled ? { x: Math.PI / 2.1, y: rotY, z: 0 } : { x: 0, y: rotY, z: 0 };
  const parts = [
    [0, 0.44, 0, 0.44, 0.05, 0.44],
    [0, 0.7, -0.2, 0.44, 0.5, 0.05],
    [-0.18, 0.22, -0.18, 0.05, 0.44, 0.05],
    [0.18, 0.22, -0.18, 0.05, 0.44, 0.05],
    [-0.18, 0.22, 0.18, 0.05, 0.44, 0.05],
    [0.18, 0.22, 0.18, 0.05, 0.44, 0.05],
  ];
  const c = Math.cos(rotY), s = Math.sin(rotY);
  for (const [lx, ly, lz, w, h, d] of parts) {
    if (toppled) {
      b.shape(mat, new THREE.BoxGeometry(w, h, d),
        { x: x + c * lx - s * lz, y: y + 0.1 + lz * 0.8, z: z + s * lx + c * lz - ly * 0.8 },
        rot, { x: 1, y: 1, z: 1 }, { collide: false, uvScale: [w, h] });
    } else {
      b.box(mat, x + c * lx - s * lz, y + ly - h / 2, z + s * lx + c * lz, w, h, d, rotY, { collide: false });
    }
  }
  return g;
}
