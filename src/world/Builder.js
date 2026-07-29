import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// GeometryBuilder — accumulates static level geometry into per-material,
// per-spatial-chunk buckets and merges each bucket into a single mesh.
//
// Two things this buys us:
//
//  1. Draw calls stay proportional to (materials x occupied chunks) instead of
//     to the number of boxes, so the level can be dressed as densely as it
//     needs to be.
//  2. UVs are generated in *world* units at authoring time, so a 20 m wall and
//     the 0.4 m kerb beside it have identical texel density with no per-mesh
//     material clones. This is the single biggest tell of amateur work and it
//     is free if you never let a 0..1 box UV survive.
// ---------------------------------------------------------------------------

const CHUNK = 44;

/** Face order of THREE.BoxGeometry: +X, -X, +Y, -Y, +Z, -Z (4 verts each). */
function worldUvBox(w, h, d, tile, ox, oy, oz) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const spans = [
    [d, h, oz, oy], [d, h, oz, oy],
    [w, d, ox, oz], [w, d, ox, oz],
    [w, h, ox, oy], [w, h, ox, oy],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv, uo, vo] = spans[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su / tile + uo / tile, uv.getY(k) * sv / tile + vo / tile);
    }
  }
  uv.needsUpdate = true;
  g.deleteAttribute('uv1');
  return g;
}

/** Scales an arbitrary geometry's 0..1-ish UVs into world units. */
function scaleUv(g, su, sv) {
  const uv = g.attributes.uv;
  if (!uv) return g;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  g.deleteAttribute('uv1');
  return g;
}

export class GeometryBuilder {
  /**
   * @param {import('../render/Materials.js').MaterialLibrary} materials
   */
  constructor(materials) {
    this.materials = materials;
    /** @type {Map<string, {mat: THREE.Material, tile: number, geos: THREE.BufferGeometry[], collide: boolean, chunk: string}>} */
    this.buckets = new Map();
    this._fallbacks = new Map();
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this.stats = { boxes: 0 };
  }

  /**
   * Resolves a material name against the shared library, falling back to a
   * locally-defined MeshStandardMaterial when another agent has not added that
   * surface yet. `tile` is the world size of one texture repeat.
   */
  mat(name, fallback) {
    if (this.materials.materials[name]) return this.materials.get(name);
    if (!fallback) return this.materials.get('concreteWall');
    if (!this._fallbacks.has(name)) {
      const m = new THREE.MeshStandardMaterial({
        color: fallback.color,
        roughness: fallback.roughness ?? 0.92,
        metalness: fallback.metalness ?? 0,
        side: fallback.side ?? THREE.FrontSide,
        transparent: fallback.transparent ?? false,
        opacity: fallback.opacity ?? 1,
      });
      m.name = name;
      m.userData.tile = fallback.tile ?? 2;
      this._fallbacks.set(name, m);
    }
    return this._fallbacks.get(name);
  }

  _bucket(mat, collide) {
    return { mat, collide };
  }

  _key(mat, collide, x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    return `${mat.name || mat.uuid}|${collide ? 'c' : 'n'}|${cx},${cz}`;
  }

  _push(mat, geo, collide, x, z) {
    const key = this._key(mat, collide, x, z);
    let b = this.buckets.get(key);
    if (!b) { b = { mat, geos: [], collide }; this.buckets.set(key, b); }
    b.geos.push(geo);
  }

  /**
   * Axis-aligned-ish box. x/z are the footprint centre, y is the BASE (floor)
   * height, w/h/d are full extents. rotY rotates about the footprint centre.
   */
  box(mat, x, y, z, w, h, d, rotY = 0, opts) {
    if (w <= 0 || h <= 0 || d <= 0) return;
    const tile = mat.userData.tile ?? 2;
    const g = worldUvBox(w, h, d, tile, x - w / 2, y, z - d / 2);
    if (rotY) {
      this._e.set(0, rotY, 0);
      this._q.setFromEuler(this._e);
      this._m4.compose(new THREE.Vector3(x, y + h / 2, z), this._q, new THREE.Vector3(1, 1, 1));
    } else {
      this._m4.makeTranslation(x, y + h / 2, z);
    }
    g.applyMatrix4(this._m4);
    this.stats.boxes++;
    this._push(mat, g, opts?.collide !== false, x, z);
  }

  /** Box specified by min/max corners. */
  aabb(mat, x0, y0, z0, x1, y1, z1, opts) {
    this.box(mat, (x0 + x1) / 2, y0, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 0, opts);
  }

  /** Arbitrary geometry placed by a full transform. UVs are scaled by su/sv. */
  shape(mat, geo, position, rotation, scale, opts) {
    const g = geo.clone();
    if (opts?.uvScale) scaleUv(g, opts.uvScale[0], opts.uvScale[1]);
    else g.deleteAttribute('uv1');
    this._e.set(rotation?.x || 0, rotation?.y || 0, rotation?.z || 0);
    this._q.setFromEuler(this._e);
    this._m4.compose(
      new THREE.Vector3(position.x, position.y, position.z),
      this._q,
      new THREE.Vector3(scale?.x ?? 1, scale?.y ?? 1, scale?.z ?? 1),
    );
    g.applyMatrix4(this._m4);
    this._push(mat, g, opts?.collide !== false, position.x, position.z);
  }

  /** Horizontal quad (floors, road, decals) at height y. */
  plane(mat, x, y, z, w, d, rotY = 0, opts) {
    const tile = mat.userData.tile ?? 2;
    const g = new THREE.PlaneGeometry(w, d);
    scaleUv(g, w / tile, d / tile);
    g.rotateX(-Math.PI / 2);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y, z);
    this._push(mat, g, opts?.collide !== false, x, z);
  }

  /**
   * Emits everything into `root`, one mesh per bucket. Collidable meshes get
   * COLLISION_LAYER enabled; non-collidable ones are flagged noCollide.
   */
  emit(root, collisionLayer) {
    let meshes = 0, tris = 0;
    for (const [key, b] of this.buckets) {
      if (!b.geos.length) continue;
      const merged = mergeGeometries(b.geos, false);
      for (const g of b.geos) g.dispose();
      if (!merged) { console.warn('merge failed for', key); continue; }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, b.mat);
      mesh.name = key;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (b.collide) mesh.layers.enable(collisionLayer);
      else mesh.userData.noCollide = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrixWorld();
      root.add(mesh);
      meshes++;
      tris += (merged.index ? merged.index.count : merged.attributes.position.count) / 3;
    }
    this.buckets.clear();
    return { meshes, tris, boxes: this.stats.boxes };
  }
}
