import * as THREE from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { mulberry32 } from '../render/Noise.js';

// ---------------------------------------------------------------------------
// "Blackout" — a Middle-Eastern urban block. Built procedurally from a seeded
// RNG so the layout is deterministic, then merged into a small number of draw
// calls and fed to an octree for collision.
// ---------------------------------------------------------------------------

const BOX = new THREE.BoxGeometry(1, 1, 1);
BOX.computeVertexNormals();

/** Meshes on this layer are included in the collision octree. */
export const COLLISION_LAYER = 2;

export class Level {
  /** @param {import('../render/Materials.js').MaterialLibrary} materials */
  constructor(materials) {
    this.materials = materials;
    this.root = new THREE.Group();
    this.root.name = 'Level';
    this.collision = new Octree();
    this.spawnPoints = [];
    this.coverPoints = [];
    this.rng = mulberry32(20260729);
  }

  build() {
    this._ground();
    this._perimeter();
    this._buildings();
    this._street();
    this._props();
    this._bakeCollision();
    return this.root;
  }

  // ------------------------------- helpers ---------------------------------

  /**
   * Adds an axis-aligned box. `w/h/d` are full extents; position is the centre
   * of the footprint at the base (so y is the floor height of the box).
   */
  _box(mat, x, y, z, w, h, d, rotY = 0) {
    const mesh = new THREE.Mesh(BOX, mat);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y + h / 2, z);
    mesh.rotation.y = rotY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.updateMatrixWorld();
    this.root.add(mesh);
    return mesh;
  }

  _rand(a, b) { return a + this.rng() * (b - a); }
  _randInt(a, b) { return Math.floor(this._rand(a, b + 1)); }
  _pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }

  // -------------------------------- pieces ---------------------------------

  _ground() {
    const size = 220;
    const geo = new THREE.PlaneGeometry(size, size, 64, 64);
    geo.rotateX(-Math.PI / 2);
    // Gentle undulation so the ground plane never reads as a flat card.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const d = Math.hypot(x, z);
      const bump = Math.sin(x * 0.07) * Math.cos(z * 0.09) * 0.18;
      pos.setY(i, bump * Math.min(1, d / 30));
    }
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, this.materials.tiled('sand', size, size));
    mesh.receiveShadow = true;
    mesh.name = 'Ground';
    this.root.add(mesh);
    this.ground = mesh;
  }

  _street() {
    // Main road running north-south, plus a cross street.
    const road = this.materials.tiled('road', 14, 200);
    const a = new THREE.Mesh(new THREE.PlaneGeometry(14, 200), road);
    a.rotation.x = -Math.PI / 2;
    a.position.set(0, 0.02, 0);
    a.receiveShadow = true;
    this.root.add(a);

    const roadB = this.materials.tiled('road', 160, 12);
    const b = new THREE.Mesh(new THREE.PlaneGeometry(160, 12), roadB);
    b.rotation.x = -Math.PI / 2;
    b.position.set(0, 0.025, -34);
    b.receiveShadow = true;
    this.root.add(b);

    // Kerbs
    const kerb = this.materials.get('concreteFloor');
    for (const sx of [-7.4, 7.4]) {
      this._box(kerb, sx, 0, 0, 0.8, 0.16, 200);
    }
  }

  _perimeter() {
    // Blast walls boxing the playable area — reads as a fortified district and
    // keeps the player inside without an invisible wall.
    const mat = this.materials.get('concreteWall');
    const half = 76;
    const seg = 4;
    for (let i = -half; i <= half; i += seg) {
      // gaps for the street exits
      if (Math.abs(i) < 8) continue;
      this._box(mat, i, 0, -half, seg * 0.98, 3.4, 0.6);
      this._box(mat, i, 0, half, seg * 0.98, 3.4, 0.6);
      this._box(mat, -half, 0, i, 0.6, 3.4, seg * 0.98);
      this._box(mat, half, 0, i, 0.6, 3.4, seg * 0.98);
    }
  }

  _buildings() {
    const facades = ['plasterWarm', 'plasterPale', 'concreteWall'];
    // Four quadrants of blocks flanking the streets.
    const blocks = [
      { x: -38, z: -62, w: 52, d: 44 },
      { x: 38, z: -62, w: 52, d: 44 },
      { x: -40, z: 20, w: 56, d: 74 },
      { x: 40, z: 20, w: 56, d: 74 },
    ];

    for (const b of blocks) {
      const cols = this._randInt(2, 3);
      const rows = this._randInt(2, 3);
      const cw = b.w / cols, cd = b.d / rows;
      for (let cx = 0; cx < cols; cx++) {
        for (let cz = 0; cz < rows; cz++) {
          if (this.rng() < 0.18) continue; // leave courtyards
          const px = b.x - b.w / 2 + cw * (cx + 0.5) + this._rand(-1.5, 1.5);
          const pz = b.z - b.d / 2 + cd * (cz + 0.5) + this._rand(-1.5, 1.5);
          this._building(px, pz, cw * this._rand(0.6, 0.82), cd * this._rand(0.6, 0.82), facades);
        }
      }
    }
  }

  _building(x, z, w, d, facades) {
    const floors = this._randInt(1, 4);
    const floorH = 3.2;
    const mat = this.materials.tiled(this._pick(facades), Math.max(w, d), floors * floorH);
    const trim = this.materials.get('concreteWall');

    this._box(mat, x, 0, z, w, floors * floorH, d);

    // Floor bands and a parapet give the silhouette some relief instead of a
    // bare extruded rectangle.
    for (let f = 1; f <= floors; f++) {
      const y = f * floorH - 0.18;
      this._box(trim, x, y, z, w + 0.22, 0.18, d + 0.22);
    }
    const roofY = floors * floorH;
    this._box(trim, x, roofY, z, w + 0.3, 0.55, d + 0.3);
    // hollow the parapet so it reads as a wall, not a slab
    this._box(mat, x, roofY + 0.08, z, w - 0.1, 0.44, d - 0.1);

    // Window recesses — cut as inset dark boxes on each face.
    const glass = new THREE.MeshStandardMaterial({
      color: 0x11161c, roughness: 0.12, metalness: 0.0,
      envMapIntensity: 1.4,
    });
    for (let f = 0; f < floors; f++) {
      const y = f * floorH + 1.0;
      const nx = Math.max(1, Math.floor(w / 2.6));
      const nz = Math.max(1, Math.floor(d / 2.6));
      for (let i = 0; i < nx; i++) {
        const ox = -w / 2 + w * (i + 0.5) / nx;
        if (this.rng() > 0.22) {
          this._box(glass, x + ox, y, z + d / 2 - 0.06, 1.15, 1.5, 0.12);
          this._box(trim, x + ox, y - 0.16, z + d / 2 + 0.02, 1.45, 0.16, 0.3);
        }
        if (this.rng() > 0.22) {
          this._box(glass, x + ox, y, z - d / 2 + 0.06, 1.15, 1.5, 0.12);
          this._box(trim, x + ox, y - 0.16, z - d / 2 - 0.02, 1.45, 0.16, 0.3);
        }
      }
      for (let i = 0; i < nz; i++) {
        const oz = -d / 2 + d * (i + 0.5) / nz;
        if (this.rng() > 0.22) {
          this._box(glass, x + w / 2 - 0.06, y, z + oz, 0.12, 1.5, 1.15);
          this._box(trim, x + w / 2 + 0.02, y - 0.16, z + oz, 0.3, 0.16, 1.45);
        }
        if (this.rng() > 0.22) {
          this._box(glass, x - w / 2 + 0.06, y, z + oz, 0.12, 1.5, 1.15);
          this._box(trim, x - w / 2 - 0.02, y - 0.16, z + oz, 0.3, 0.16, 1.45);
        }
      }
    }

    this.coverPoints.push(new THREE.Vector3(x + w / 2 + 1, 0, z));
    this.coverPoints.push(new THREE.Vector3(x - w / 2 - 1, 0, z));
  }

  _props() {
    const green = this.materials.get('militaryGreen');
    const rusty = this.materials.get('rustySteel');
    const conc = this.materials.get('concreteWall');

    // Shipping containers along the street — the classic sightline breakers.
    const containerSpots = [
      [-12, -18, 0], [-12, -24.5, 0], [13, 8, Math.PI / 2],
      [-16, 34, 0.2], [17, -46, Math.PI / 2], [-20, -52, 0],
      [22, 30, 0], [-24, 6, Math.PI / 2],
    ];
    for (const [x, z, r] of containerSpots) {
      const mat = this.materials.tiled(this.rng() < 0.5 ? 'containerRed' : 'containerBlue', 6.1, 2.6);
      const stack = this.rng() < 0.3 ? 2 : 1;
      for (let s = 0; s < stack; s++) {
        this._box(mat, x, s * 2.62, z, 6.1, 2.6, 2.44, r);
      }
      this.coverPoints.push(new THREE.Vector3(x, 0, z + 2));
    }

    // Jersey barriers lining the road.
    for (let i = -8; i <= 8; i++) {
      if (Math.abs(i) < 2) continue;
      for (const sx of [-8.6, 8.6]) {
        const z = i * 9 + this._rand(-1, 1);
        this._box(conc, sx, 0, z, 0.7, 0.95, 3.4, this._rand(-0.06, 0.06));
        this.coverPoints.push(new THREE.Vector3(sx + Math.sign(sx) * 1.2, 0, z));
      }
    }

    // Sandbag emplacements (stacked cylinders read better than boxes here).
    const bagMat = new THREE.MeshStandardMaterial({ color: 0x6d6046, roughness: 0.96, metalness: 0 });
    const bagGeo = new THREE.CapsuleGeometry(0.22, 0.34, 4, 8);
    bagGeo.rotateZ(Math.PI / 2);
    for (const [bx, bz, br] of [[6, -28, 0], [-6, 12, Math.PI], [10, 44, -0.5]]) {
      for (let row = 0; row < 3; row++) {
        const n = 7 - row;
        for (let i = 0; i < n; i++) {
          const m = new THREE.Mesh(bagGeo, bagMat);
          const ox = (i - (n - 1) / 2) * 0.62 + (row % 2) * 0.3;
          m.position.set(bx + Math.cos(br) * ox, 0.22 + row * 0.34, bz + Math.sin(br) * ox);
          m.rotation.y = br + this._rand(-0.1, 0.1);
          m.castShadow = true; m.receiveShadow = true;
          this.root.add(m);
        }
      }
      this.coverPoints.push(new THREE.Vector3(bx, 0, bz + 1.2));
    }

    // Burnt-out vehicle hulks.
    for (const [vx, vz, vr] of [[3, -12, 0.4], [-4, 26, 2.1], [5, 56, -1.2]]) {
      this._wreck(vx, vz, vr, rusty, green);
    }

    // Utility poles + wires for vertical interest.
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a332b, roughness: 0.9, metalness: 0.1 });
    const poleGeo = new THREE.CylinderGeometry(0.11, 0.15, 8, 8);
    for (let i = -6; i <= 6; i++) {
      if (i === 0) continue;
      const z = i * 15;
      const m = new THREE.Mesh(poleGeo, poleMat);
      m.position.set(9.4, 4, z);
      m.castShadow = true;
      this.root.add(m);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 0.12), poleMat);
      arm.position.set(9.4, 7.4, z);
      arm.castShadow = true;
      this.root.add(arm);
    }

    // Debris scatter — small rubble breaks up the ground plane silhouette.
    const rubbleMat = this.materials.get('concreteFloor');
    for (let i = 0; i < 260; i++) {
      const x = this._rand(-70, 70), z = this._rand(-70, 70);
      if (Math.hypot(x, z) < 5) continue;
      const s = this._rand(0.08, 0.42);
      const m = new THREE.Mesh(BOX, rubbleMat);
      m.scale.set(s * this._rand(0.7, 1.8), s * this._rand(0.4, 1.0), s * this._rand(0.7, 1.8));
      m.position.set(x, s * 0.2, z);
      m.rotation.set(this._rand(0, 3), this._rand(0, 6), this._rand(0, 3));
      m.castShadow = true; m.receiveShadow = true;
      m.userData.noCollide = true;
      this.root.add(m);
    }

    this.spawnPoints.push(
      new THREE.Vector3(0, 1, 60),
      new THREE.Vector3(-3, 1, -55),
      new THREE.Vector3(20, 1, 10),
    );
  }

  _wreck(x, z, rot, body, trim) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rot;

    const chassis = new THREE.Mesh(BOX, body);
    chassis.scale.set(2.0, 0.62, 4.5);
    chassis.position.y = 0.62;
    const cabin = new THREE.Mesh(BOX, body);
    cabin.scale.set(1.82, 0.72, 2.1);
    cabin.position.set(0, 1.28, -0.2);
    for (const m of [chassis, cabin]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }

    // Collapsed wheels — the hulks sit on their rims.
    const rimGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 12);
    rimGeo.rotateZ(Math.PI / 2);
    for (const [wx, wz] of [[0.95, 1.5], [-0.95, 1.5], [0.95, -1.5], [-0.95, -1.5]]) {
      const w = new THREE.Mesh(rimGeo, trim);
      w.position.set(wx, 0.3, wz);
      w.castShadow = true;
      g.add(w);
    }

    g.traverse((o) => { if (o.isMesh) o.updateMatrixWorld(); });
    this.root.add(g);
    this.coverPoints.push(new THREE.Vector3(x, 0, z + 2.6));
  }

  _bakeCollision() {
    this.root.updateMatrixWorld(true);
    // Octree filters by layer, not visibility. Everything stays on channel 0
    // so the camera still draws it; collidable meshes additionally opt into
    // COLLISION_LAYER. Small debris is left out — catching on pebbles just
    // snags movement.
    this.root.traverse((o) => {
      if (o.isMesh && !o.userData.noCollide) o.layers.enable(COLLISION_LAYER);
    });
    this.collision.layers.set(COLLISION_LAYER);
    this.collision.fromGraphNode(this.root);
  }
}
