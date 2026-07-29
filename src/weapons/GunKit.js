import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gripNormal, machinedNormal, wearRoughness, weaveNormal, markingsNormal } from './GunTextures.js';

// ---------------------------------------------------------------------------
// Shared construction kit for procedural weapons.
//
// Two ideas do most of the work here:
//
//  1. Everything is *geometry*, not meshes. Parts are accumulated into a Batch
//     keyed by material and merged once at the end, so a 400-primitive weapon
//     costs ~8 draw calls instead of ~400.
//  2. Boxes are chamfered by default. A hard 90-degree edge catches no light;
//     a 0.6 mm chamfer catches a specular line along every edge, which is what
//     actually makes a black gun read as a solid object rather than a blob.
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * Planar-projects UVs from the dominant normal axis so texel density is the
 * same on every part regardless of its size. `scale` is texture repeats/metre.
 */
export function planarUV(geo, scale = 26) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (nx >= ny && nx >= nz) { u = z; v = y; }
    else if (ny >= nz) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  if (rx || ry || rz) {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m.makeRotationFromQuaternion(_q);
    geo.applyMatrix4(_m);
  }
  if (x || y || z) geo.translate(x, y, z);
  return geo;
}

/** Plain box. Use for internal / never-silhouetted filler. */
export function gBox(w, h, d, x, y, z, rx, ry, rz) {
  return place(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
}

const _chamferCache = new Map();

/**
 * Box with a chamfer on all twelve edges, built by extruding a rounded-corner
 * rectangle. `c` is the chamfer size in metres (default 0.7 mm).
 */
export function gChamfer(w, h, d, x, y, z, rx, ry, rz, c = 0.0007) {
  c = Math.min(c, w * 0.32, h * 0.32, d * 0.32);
  const key = `${w.toFixed(5)}|${h.toFixed(5)}|${d.toFixed(5)}|${c.toFixed(5)}`;
  let base = _chamferCache.get(key);
  if (!base) {
    const hw = w / 2 - c, hh = h / 2 - c;
    const s = new THREE.Shape();
    s.moveTo(-hw, -hh);
    s.lineTo(hw, -hh); s.lineTo(hw, hh); s.lineTo(-hw, hh);
    s.closePath();
    base = new THREE.ExtrudeGeometry(s, {
      depth: d - 2 * c, bevelEnabled: true, bevelThickness: c, bevelSize: c,
      bevelOffset: 0, bevelSegments: 1, curveSegments: 1, steps: 1,
    });
    base.translate(0, 0, -(d - 2 * c) / 2);
    base.deleteAttribute('uv');
    base.computeVertexNormals();
    _chamferCache.set(key, base);
  }
  return place(base.clone(), x, y, z, rx, ry, rz);
}

/** Cylinder along an axis. */
export function gCyl(rt, rb, h, seg, x, y, z, axis = 'z', open = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  return place(g, x, y, z);
}

/** Cylinder with chamfered rims — reads far better on end caps than a disc. */
export function gRod(r, h, seg, x, y, z, axis = 'z', c = 0.0006) {
  const pts = [
    new THREE.Vector2(0, -h / 2),
    new THREE.Vector2(r - c, -h / 2),
    new THREE.Vector2(r, -h / 2 + c),
    new THREE.Vector2(r, h / 2 - c),
    new THREE.Vector2(r - c, h / 2),
    new THREE.Vector2(0, h / 2),
  ];
  const g = new THREE.LatheGeometry(pts, seg);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  return place(g, x, y, z);
}

/** Tube (hollow cylinder), for barrel shrouds and optic bodies. */
export function gTube(rOuter, rInner, h, seg, x, y, z, axis = 'z') {
  const pts = [
    new THREE.Vector2(rInner, -h / 2),
    new THREE.Vector2(rOuter, -h / 2),
    new THREE.Vector2(rOuter, h / 2),
    new THREE.Vector2(rInner, h / 2),
    new THREE.Vector2(rInner, -h / 2),
  ];
  const g = new THREE.LatheGeometry(pts, seg);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  return place(g, x, y, z);
}

/** Screw / pin head with a slot, ~1-2 mm. Sold entirely on the specular. */
export function gScrew(r, x, y, z, axis = 'y', depth = 0.0012) {
  const head = gRod(r, depth, 10, 0, 0, 0, 'y', r * 0.25);
  const slot = gBox(r * 1.8, depth * 0.9, r * 0.34, 0, depth * 0.35, 0);
  const g = mergeGeometries([head, slot], false);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  return place(g, x, y, z);
}

/** Coil spring, used for the magazine follower and stock detents. */
export function gSpring(r, len, turns, seg, x, y, z, axis = 'z') {
  const wire = 0.0006;
  const path = [];
  const n = turns * seg;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    path.push(new THREE.Vector3(Math.cos(t * turns * Math.PI * 2) * r, t * len - len / 2, Math.sin(t * turns * Math.PI * 2) * r));
  }
  const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(path), n, wire, 4, false);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  return place(g, x, y, z);
}

// ---------------------------------------------------------------------------

/** Accumulates geometry per material and emits one merged mesh per material. */
export class Batch {
  constructor(uvScale = 26) {
    this.map = new Map();
    this.uvScale = uvScale;
  }

  add(mat, ...geos) {
    let a = this.map.get(mat);
    if (!a) { a = []; this.map.set(mat, a); }
    // UVs are always regenerated at flush time so every part shares the same
    // texel density regardless of which primitive produced it.
    for (const g of geos) { if (g.attributes.uv) g.deleteAttribute('uv'); a.push(g); }
    return this;
  }

  /** Merge and attach to `group`. Returns the group. */
  flush(group, name = 'part') {
    for (const [mat, geosIn] of this.map) {
      // ExtrudeGeometry is non-indexed and the primitives are indexed, so
      // normalise before merging, then project UVs on the final vertex set.
      const geos = geosIn.map((g) => (g.index ? g.toNonIndexed() : g));
      const scale = mat.userData?.uvScale ?? this.uvScale;
      for (const g of geos) planarUV(g, scale);
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) { console.warn('weapon batch merge failed for', mat.name); continue; }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${name}:${mat.name || 'mat'}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    this.map.clear();
    return group;
  }
}

// ---------------------------------------------------------------------------
// Material library. Values are tuned for the viewmodel light rig: real gun
// albedo is near-black and disappears under ACES, so everything is lifted a
// stop and the separation is carried by roughness and metalness instead.
// ---------------------------------------------------------------------------

let _lib = null;

export function gunMaterials() {
  if (_lib) return _lib;

  const machined = machinedNormal();
  const stipple = gripNormal();
  const weave = weaveNormal();
  const marks = markingsNormal();

  const std = (name, color, roughness, metalness, opts = {}) => {
    const m = new THREE.MeshStandardMaterial({
      name, color: new THREE.Color(color), roughness, metalness,
      envMapIntensity: opts.env ?? 1.6,
      normalMap: opts.normalMap ?? null,
      roughnessMap: opts.roughnessMap ?? null,
      normalScale: new THREE.Vector2(opts.ns ?? 0.6, opts.ns ?? 0.6),
      ...opts.extra,
    });
    m.userData.uvScale = opts.uvScale ?? 26;
    return m;
  };

  // Anodising is a dielectric film over aluminium, not bare metal, so the
  // receiver runs at partial metalness: full metalness mirrors the desert sky
  // straight into the camera and the whole gun clips to white. Roughness is
  // also kept off the floor — under a normal map, gloss below ~0.35 is what
  // produces the grazing-angle specular speckle.
  _lib = {
    alu: std('alu', 0x3b3e44, 0.46, 0.72, { normalMap: machined, roughnessMap: wearRoughness(0.46, 0.22), ns: 0.40, uvScale: 30, env: 0.85 }),
    // Same alloy but on the receiver flats, where the markings live.
    aluMarked: std('aluMarked', 0x393c42, 0.48, 0.70, { normalMap: marks, ns: 0.55, uvScale: 9, env: 0.8 }),
    // Nitrided barrel steel — darker and glossier than the receiver.
    steel: std('steel', 0x2f333a, 0.36, 0.95, { normalMap: machined, roughnessMap: wearRoughness(0.36, 0.16), ns: 0.30, uvScale: 42, env: 0.8 }),
    // Bare/worn steel on pins, bolt face, springs.
    bright: std('bright', 0x8b939d, 0.30, 0.95, { normalMap: machined, ns: 0.25, uvScale: 60, env: 0.9 }),
    // Flat-dark-earth polymer furniture. The one warm accent on the weapon.
    fde: std('fde', 0x62553f, 0.68, 0.02, { normalMap: machined, roughnessMap: wearRoughness(0.66, 0.24), ns: 0.45, uvScale: 30, env: 0.55 }),
    rubber: std('rubber', 0x232528, 0.90, 0.0, { normalMap: stipple, ns: 1.0, uvScale: 60, env: 0.4 }),
    poly: std('poly', 0x2a2d31, 0.70, 0.02, { normalMap: machined, ns: 0.35, uvScale: 34, env: 0.55 }),
    opticBody: std('opticBody', 0x26282c, 0.50, 0.45, { normalMap: machined, ns: 0.35, uvScale: 36, env: 0.7 }),
    // Exposed fingertips. The only warm, non-metal, non-black surface in the
    // frame — it is what stops the hands merging into the weapon.
    skin: std('skin', 0x7a5540, 0.70, 0.0, { normalMap: stipple, ns: 0.22, uvScale: 120, env: 0.4 }),
    glove: std('glove', 0x2b2d32, 0.84, 0.02, { normalMap: stipple, ns: 0.75, uvScale: 44, env: 0.45 }),
    gloveHard: std('gloveHard', 0x1d1f23, 0.56, 0.05, { normalMap: machined, ns: 0.45, uvScale: 40, env: 0.5 }),
    sleeve: std('sleeve', 0x565442, 0.92, 0.0, { normalMap: weave, ns: 0.85, uvScale: 70, env: 0.4 }),
    strap: std('strap', 0x2a2b2d, 0.8, 0.02, { normalMap: weave, ns: 0.7, uvScale: 90, env: 0.6 }),
    brass: std('brass', 0xb08d4a, 0.22, 1.0, { uvScale: 60 }),
  };
  return _lib;
}
