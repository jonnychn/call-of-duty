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
  const tri = geo.index ? null : 3;

  // The projection axis must be chosen per TRIANGLE, not per vertex. On a
  // 45-degree chamfer the two dominant components are equal to within float
  // error, so a per-vertex choice can pick different axes for vertices of the
  // same face — the UVs then span the whole texture across a 0.7 mm strip and
  // the normal map turns into specular confetti at grazing angles. This was
  // the source of the speckle on the receiver.
  const write = (i, axis) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (axis === 0) { u = z; v = y; }
    else if (axis === 1) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  };

  if (tri) {
    for (let t = 0; t < pos.count; t += 3) {
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < 3; k++) {
        nx += nor.getX(t + k); ny += nor.getY(t + k); nz += nor.getZ(t + k);
      }
      nx = Math.abs(nx); ny = Math.abs(ny); nz = Math.abs(nz);
      const axis = (nx >= ny && nx >= nz) ? 0 : (ny >= nz ? 1 : 2);
      write(t, axis); write(t + 1, axis); write(t + 2, axis);
    }
  } else {
    for (let i = 0; i < pos.count; i++) {
      const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
      write(i, (nx >= ny && nx >= nz) ? 0 : (ny >= nz ? 1 : 2));
    }
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
  // straight into the camera and the whole gun clips to white.
  //
  // Roughness and normal strength are both deliberately conservative. A gun is
  // built almost entirely from sub-millimetre chamfers, and a glossy metal
  // whose normals change that fast samples the environment probe in a
  // different direction on every pixel — that is the rainbow specular speckle
  // along the lower receiver. There is no NDF filtering in three, so the only
  // levers are: keep gloss off the floor, keep the detail normal shallow, and
  // keep the probe from running hot. All three are applied here.
  _lib = {
    alu: std('alu', 0x3f4249, 0.52, 0.66, { normalMap: machined, roughnessMap: wearRoughness(0.52, 0.13), ns: 0.16, uvScale: 30, env: 0.52 }),
    // Same alloy but on the receiver flats, where the markings live.
    aluMarked: std('aluMarked', 0x3b3e44, 0.60, 0.60, { normalMap: marks, ns: 0.30, uvScale: 9, env: 0.45 }),
    // Nitrided barrel steel — darker and glossier than the receiver, but only
    // just: it lives on cylinders, which alias even more readily than flats.
    steel: std('steel', 0x323639, 0.40, 0.90, { normalMap: machined, roughnessMap: wearRoughness(0.40, 0.10), ns: 0.13, uvScale: 42, env: 0.55 }),
    // Bare/worn steel on pins, bolt face, springs.
    bright: std('bright', 0x8d959e, 0.36, 0.92, { normalMap: machined, ns: 0.12, uvScale: 60, env: 0.6 }),
    // Flat-dark-earth polymer furniture. The one warm accent on the weapon.
    fde: std('fde', 0x60543f, 0.72, 0.0, { normalMap: machined, roughnessMap: wearRoughness(0.70, 0.16), ns: 0.30, uvScale: 30, env: 0.40 }),
    rubber: std('rubber', 0x202225, 0.93, 0.0, { normalMap: stipple, ns: 0.85, uvScale: 60, env: 0.28 }),
    poly: std('poly', 0x272a2e, 0.76, 0.0, { normalMap: machined, ns: 0.26, uvScale: 34, env: 0.35 }),
    opticBody: std('opticBody', 0x232529, 0.62, 0.30, { normalMap: machined, ns: 0.22, uvScale: 36, env: 0.45 }),
    // Exposed fingertips. The only warm, non-metal, non-black surface in the
    // frame — it is what stops the hands merging into the weapon.
    skin: std('skin', 0x7a5540, 0.72, 0.0, { normalMap: stipple, ns: 0.18, uvScale: 120, env: 0.30 }),
    glove: std('glove', 0x2a2c31, 0.86, 0.0, { normalMap: stipple, ns: 0.60, uvScale: 44, env: 0.30 }),
    gloveHard: std('gloveHard', 0x1c1e22, 0.64, 0.0, { normalMap: machined, ns: 0.32, uvScale: 40, env: 0.32 }),
    sleeve: std('sleeve', 0x53513f, 0.94, 0.0, { normalMap: weave, ns: 0.70, uvScale: 70, env: 0.26 }),
    strap: std('strap', 0x232426, 0.86, 0.0, { normalMap: weave, ns: 0.55, uvScale: 90, env: 0.30 }),
    brass: std('brass', 0x9d7c3f, 0.38, 0.92, { uvScale: 60, env: 0.5 }),
  };
  return _lib;
}
