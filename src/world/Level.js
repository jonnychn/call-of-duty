import * as THREE from 'three';
import { CollisionOctree } from './CollisionOctree.js';
import { mulberry32 } from '../render/Noise.js';
import { GeometryBuilder } from './Builder.js';
import * as P from './Props.js';

// ---------------------------------------------------------------------------
// "Blackout" — a hand-authored Middle-Eastern urban corridor.
//
// LAYOUT INTENT
//
// The level is a single strong axis: a street running along +Z, walled on both
// sides by facades that sit 10.4 m from the centreline. At 1.75 m eye height
// that puts three to four storeys of building inside every frame, so the player
// is always *inside* a place instead of standing on a plane looking at a
// distant wall.
//
//   z -26 .. +18   southern market quarter. A square off the west side with
//                  stalls and laundry lines, an east-west alley at z ~ -11.
//   z +18 .. +40   the junction. Collapsed block on the east spills a rubble
//                  ramp that climbs to its roof — the readable way up.
//   z +36 .. +62   courtyard block east (market yard + external stair +
//                  footbridge), shophouse row west with balconies.
//   z +64 .. +70   THE GATEHOUSE. An arched span across the street. It is the
//                  thing you walk toward from the spawn, it frames everything
//                  beyond it, and it caps the sky with a solid lintel.
//   z +72 .. +112  the far quarter, seen through the arch: a 23 m minaret
//                  offset to the west so a slice of it shows in the opening.
//
// Sightlines are deliberately staged: bus wreck and crater break the near
// third, the gatehouse pinches the middle, the minaret terminates the vista.
// Verticality is reachable: rubble ramp -> east roof (6.6 m), courtyard stair
// -> terrace (6.6 m) -> footbridge, gatehouse roof via the west shophouse.
//
// Everything static goes through GeometryBuilder, which world-projects UVs and
// merges by material + 44 m chunk, so density costs triangles, not draw calls.
// ---------------------------------------------------------------------------

/** Meshes on this layer are included in the collision octree. */
export const COLLISION_LAYER = 2;

const ROAD_HALF = 7.0;      // asphalt half-width
const KERB = 10.4;          // facade line / back of pavement
const PAVE_Y = 0.17;        // pavement top

export class Level {
  /** @param {import('../render/Materials.js').MaterialLibrary} materials */
  constructor(materials) {
    this.materials = materials;
    this.root = new THREE.Group();
    this.root.name = 'Level';
    this.collision = new CollisionOctree();
    this.spawnPoints = [];
    this.coverPoints = [];
    this.rng = mulberry32(20260729);
    this.b = new GeometryBuilder(materials);
  }

  _rand(a, b) { return a + this.rng() * (b - a); }
  _randInt(a, b) { return Math.floor(this._rand(a, b + 1)); }
  _pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }
  _cover(x, z) { this.coverPoints.push(new THREE.Vector3(x, 0, z)); }

  build() {
    const b = this.b;
    const R = () => this.rng();

    // Material handles. Everything here is a real baked surface from the shared
    // library; the four `tinted` entries reuse another surface's maps under a
    // different base colour, which keeps charred metal and hessian textured
    // without paying for another bake.
    this.M = {
      sand: b.mat('sand'),
      gravel: b.mat('gravel'),
      road: b.mat('road'),
      roadLine: b.mat('roadLine'),
      conc: b.mat('concreteWall'),
      concF: b.mat('concreteFloor'),
      plasterA: b.mat('plasterWarm'),
      plasterB: b.mat('plasterPale'),
      brick: b.mat('brick'),
      brickPale: b.mat('brickPale'),
      tile: b.mat('tile'),
      wood: b.mat('wood'),
      glass: b.mat('glass'),
      tarp: b.mat('tarp'),
      cRed: b.mat('containerRed'),
      cBlue: b.mat('containerBlue'),
      green: b.mat('militaryGreen'),
      rust: b.mat('rustedIron'),
      steel: b.mat('rustySteel'),
      gun: b.mat('gunmetal'),
    };
    this.M.dark = b.tinted('__charred', 'rustedIron', 0x2a2622, { roughness: 1.0, metalness: 0.35, tile: 2 });
    this.M.scorch = b.tinted('__scorch', 'road', 0x3a352e, { roughness: 1.0, tile: 4 });
    this.M.bag = b.tinted('__sandbag', 'tarp', 0xb9a682, { roughness: 1.0, tile: 0.9 });
    this.M.cloth = b.tinted('__cloth', 'tarp', 0xd6cec0, { roughness: 1.0, side: THREE.DoubleSide, tile: 1.1 });
    this.M.tarpB = b.tinted('__tarpBlue', 'tarp', 0x5d7488, { roughness: 1.0, side: THREE.DoubleSide, tile: 2 });
    this.M.wire = b.tinted('__wire', 'gunmetal', 0x2a2a2c, { roughness: 0.8, metalness: 0.5, tile: 1 });
    this.M.trim = this.M.conc;

    this._ground();
    this._street();
    this._westBlocks();
    this._eastBlocks();
    this._gatehouse();
    this._farQuarter();
    this._marketQuarter();
    this._perimeter();
    this._dressing();

    const info = b.emit(this.root, COLLISION_LAYER);
    this.buildStats = info;

    const t0 = performance.now();
    this._bakeCollision();
    const oct = this.collision.stats ? this.collision.stats() : null;
    this.buildStats.octreeMs = Math.round(performance.now() - t0);
    this.buildStats.octree = oct;
    console.log('[level]', JSON.stringify(this.buildStats));

    this.spawnPoints.push(
      new THREE.Vector3(0, 1.0, 40),
      new THREE.Vector3(-17, 1.0, 8),
      new THREE.Vector3(23, 1.0, 50),
      new THREE.Vector3(2, 1.0, 96),
    );
    return this.root;
  }

  // =========================================================================
  //  Architecture primitives
  // =========================================================================

  /**
   * A straight wall run with rectangular openings punched clean through it.
   * Real holes, not painted-on rectangles: the wall is `t` thick so every
   * opening has a visible reveal, and light passes through it.
   *
   * @param axis 'x' | 'z' — the direction the wall runs.
   * @param openings [{c, w, y, h}] c = centre along axis, y = sill (absolute).
   */
  _wall(mat, axis, a0, a1, p, y0, h, t, openings = []) {
    const b = this.b;
    const put = (s, e, yy, hh) => {
      if (e - s < 0.02 || hh < 0.02) return;
      if (axis === 'x') b.aabb(mat, s, yy, p - t / 2, e, yy + hh, p + t / 2);
      else b.aabb(mat, p - t / 2, yy, s, p + t / 2, yy + hh, e);
    };
    const ops = openings
      .filter((o) => o.c - o.w / 2 > a0 - 0.01 && o.c + o.w / 2 < a1 + 0.01)
      .sort((u, v) => u.c - v.c);
    let cursor = a0;
    for (const o of ops) {
      const s = o.c - o.w / 2, e = o.c + o.w / 2;
      if (s > cursor) put(cursor, s, y0, h);
      const top = o.y + o.h;
      if (o.y > y0) put(s, e, y0, o.y - y0);
      if (top < y0 + h) put(s, e, top, y0 + h - top);
      cursor = e;
    }
    if (cursor < a1) put(cursor, a1, y0, h);
  }

  /** Sill + lintel + jamb trim that makes an opening read as built, not cut. */
  _reveal(axis, c, p, y, w, h, t, outward) {
    const b = this.b, m = this.M.trim;
    const d = t + 0.14;
    const N = { collide: false };
    if (axis === 'x') {
      b.box(m, c, y - 0.09, p + outward * 0.03, w + 0.34, 0.1, d, 0, N);   // sill
      b.box(m, c, y + h, p + outward * 0.03, w + 0.34, 0.14, d, 0, N);     // lintel
    } else {
      b.box(m, p + outward * 0.03, y - 0.09, c, d, 0.1, w + 0.34, 0, N);
      b.box(m, p + outward * 0.03, y + h, c, d, 0.14, w + 0.34, 0, N);
    }
  }

  /**
   * A hollow building shell. Walls are perforated, so windows and doors are
   * geometry. An inset core blocks see-through unless `hollow` is set (used for
   * the enterable shop and the courtyard block).
   */
  _block(o) {
    const b = this.b, R = () => this.rng();
    const { x0, x1, z0, z1 } = o;
    const floors = o.floors ?? 3;
    const fh = o.floorH ?? 3.3;
    const y0 = o.y0 ?? 0;
    const t = o.thick ?? 0.42;
    const H = floors * fh;
    const mat = o.mat ?? this.M.plasterA;
    const trim = this.M.trim;
    const open = new Set(o.open ?? []);
    const noGround = new Set(o.noGround ?? []);
    const doors = o.doors ?? [];
    const extra = o.extra ?? [];
    const w = x1 - x0, d = z1 - z0;

    const faces = [
      { n: '+z', axis: 'x', a0: x0, a1: x1, p: z1 - t / 2, out: 1 },
      { n: '-z', axis: 'x', a0: x0, a1: x1, p: z0 + t / 2, out: -1 },
      { n: '+x', axis: 'z', a0: z0 + t, a1: z1 - t, p: x1 - t / 2, out: 1 },
      { n: '-x', axis: 'z', a0: z0 + t, a1: z1 - t, p: x0 + t / 2, out: -1 },
    ];

    const balconies = [];
    for (const f of faces) {
      const span = f.a1 - f.a0;
      const ops = [];
      if (open.has(f.n)) {
        const n = Math.max(1, Math.round(span / 3.0));
        const step = span / n;
        for (let fl = 0; fl < floors; fl++) {
          const isGround = fl === 0;
          if (isGround && noGround.has(f.n)) continue;
          const sill = y0 + fl * fh + 1.05;
          for (let i = 0; i < n; i++) {
            const c = f.a0 + step * (i + 0.5);
            if (doors.some((dd) => dd.face === f.n && Math.abs(dd.c - c) < (dd.w + 1.4) / 2)) continue;
            if (R() < 0.1) continue;                       // bricked-up gaps
            const ww = 1.15, hh = isGround ? 1.5 : 1.6;
            ops.push({ c, w: ww, y: sill, h: hh });
            this._reveal(f.axis, c, f.p, sill, ww, hh, t, f.out);
            // shutter / grille inside the reveal
            if (R() < 0.45) {
              const gm = R() < 0.5 ? this.M.wood : this.M.rust;
              if (f.axis === 'x') b.box(gm, c, sill + 0.06, f.p - f.out * 0.14, ww - 0.06, hh - 0.12, 0.05, 0, { collide: false });
              else b.box(gm, f.p - f.out * 0.14, sill + 0.06, c, 0.05, hh - 0.12, ww - 0.06, 0, { collide: false });
            }
            if (o.balcony && fl > 0 && R() < 0.4) balconies.push({ f, c, y: y0 + fl * fh });
          }
        }
      }
      for (const dd of doors) {
        if (dd.face !== f.n) continue;
        const hh = dd.h ?? 2.35, ww = dd.w ?? 1.5;
        ops.push({ c: dd.c, w: ww, y: y0 + 0.02, h: hh });
        this._reveal(f.axis, dd.c, f.p, y0 + 0.02, ww, hh, t, f.out);
      }
      for (const ex of extra) {
        if (ex.face !== f.n) continue;
        ops.push({ c: ex.c, w: ex.w, y: ex.y, h: ex.h });
        this._reveal(f.axis, ex.c, f.p, ex.y, ex.w, ex.h, t, f.out);
      }
      this._wall(mat, f.axis, f.a0, f.a1, f.p, y0, H, t, ops);
    }

    // Balcony slabs + railings, projecting 1.15 m into the street.
    for (const bal of balconies) {
      const { f, c, y } = bal;
      const bw = 2.4, proj = 1.15;
      if (f.axis === 'x') {
        const pz = f.p + f.out * (proj / 2);
        b.box(this.M.concF, c, y - 0.16, pz, bw, 0.16, proj);
        for (const s of [-1, 1]) b.box(trim, c + s * (bw / 2 - 0.05), y, pz, 0.1, 0.95, proj, 0, { collide: false });
        b.box(trim, c, y, f.p + f.out * proj, bw, 0.95, 0.1, 0, { collide: false });
        for (let i = -3; i <= 3; i++) b.box(this.M.rust, c + i * 0.34, y + 0.1, f.p + f.out * proj, 0.05, 0.75, 0.05, 0, { collide: false });
      } else {
        const px = f.p + f.out * (proj / 2);
        b.box(this.M.concF, px, y - 0.16, c, proj, 0.16, bw);
        for (const s of [-1, 1]) b.box(trim, px, y, c + s * (bw / 2 - 0.05), proj, 0.95, 0.1, 0, { collide: false });
        b.box(trim, f.p + f.out * proj, y, c, 0.1, 0.95, bw, 0, { collide: false });
      }
      this.balconyAnchors ??= [];
      this.balconyAnchors.push({ f, c, y, out: f.out });
    }

    // Storey string-courses — horizontal shadow lines that stop the facade
    // reading as one tall extrusion.
    for (let fl = 1; fl < floors; fl++) {
      const y = y0 + fl * fh - 0.12;
      b.aabb(trim, x0 - 0.1, y, z0 - 0.1, x1 + 0.1, y + 0.16, z1 + 0.1, { collide: false });
    }

    // Interior floors + occlusion core.
    // `hollowFloors` leaves the bottom N storeys empty so an interior can be
    // dressed inside them; everything above still gets a solid occlusion core
    // so you never see straight through a building.
    const hf = o.hollowFloors ?? 0;
    if (!o.hollow) {
      for (let fl = Math.max(1, hf); fl <= floors; fl++) {
        b.aabb(this.M.concF, x0 + t, y0 + fl * fh - 0.25, z0 + t, x1 - t, y0 + fl * fh, z1 - t,
          { collide: fl === Math.max(1, hf) });
      }
      const cy0 = y0 + hf * fh;
      const inset = 2.1;
      if (w > inset * 2 + 1 && d > inset * 2 + 1) {
        b.aabb(mat, x0 + inset, cy0, z0 + inset, x1 - inset, y0 + H, z1 - inset);
      } else {
        b.aabb(mat, x0 + t, cy0, z0 + t, x1 - t, y0 + H, z1 - t);
      }
    }

    // Roof: slab, parapet, coping, clutter.
    if (o.roof !== false) {
      const roofY = y0 + H;
      b.aabb(this.M.concF, x0, roofY - 0.3, z0, x1, roofY, z1);
      const pt = 0.3, ph = o.parapet ?? 0.9;
      b.aabb(mat, x0, roofY, z0, x1, roofY + ph, z0 + pt);
      b.aabb(mat, x0, roofY, z1 - pt, x1, roofY + ph, z1);
      b.aabb(mat, x0, roofY, z0 + pt, x0 + pt, roofY + ph, z1 - pt);
      b.aabb(mat, x1 - pt, roofY, z0 + pt, x1, roofY + ph, z1 - pt);
      b.aabb(trim, x0 - 0.09, roofY + ph, z0 - 0.09, x1 + 0.09, roofY + ph + 0.12, z1 + 0.09, { collide: false });
      if (o.roofClutter !== false) this._roofClutter(x0 + 1.2, x1 - 1.2, z0 + 1.2, z1 - 1.2, roofY, o.walkableRoof === true);
    }

    // Facade services: drainpipes, AC boxes, dishes, cable runs.
    for (const f of faces) {
      if (!open.has(f.n)) continue;
      const span = f.a1 - f.a0;
      const nPipe = Math.max(1, Math.round(span / 9));
      for (let i = 0; i < nPipe; i++) {
        const c = f.a0 + span * ((i + 0.5) / nPipe) + (R() - 0.5) * 2;
        const px = f.axis === 'x' ? c : f.p + f.out * 0.13;
        const pz = f.axis === 'x' ? f.p + f.out * 0.13 : c;
        P.cylinder(b, this.M.rust, px, y0, pz, 0.06, H - 0.4, null, { collide: false });
      }
      for (let fl = 1; fl < floors; fl++) {
        if (R() < 0.5) {
          const c = f.a0 + R() * span;
          const px = f.axis === 'x' ? c : f.p + f.out * 0.35;
          const pz = f.axis === 'x' ? f.p + f.out * 0.35 : c;
          P.acUnit(b, this.M.rust, this.M.dark, px, y0 + fl * fh + 1.3, pz, f.axis === 'x' ? 0 : Math.PI / 2);
        }
      }
    }

    if (o.cover !== false) {
      this._cover(x0 - 1.2, (z0 + z1) / 2);
      this._cover(x1 + 1.2, (z0 + z1) / 2);
    }
    return { H: y0 + H };
  }

  _roofClutter(x0, x1, z0, z1, y, collide = false) {
    const b = this.b, R = () => this.rng();
    const w = x1 - x0, d = z1 - z0;
    if (w < 2 || d < 2) return;
    const n = Math.max(2, Math.round((w * d) / 34));
    for (let i = 0; i < n; i++) {
      const x = x0 + R() * w, z = z0 + R() * d;
      const r = R();
      const C = { collide };
      if (r < 0.3) P.waterTank(b, this.M.rust, x, y, z, 0.5 + R() * 0.25, 1.0 + R() * 0.4, collide);
      else if (r < 0.55) P.acUnit(b, this.M.rust, this.M.dark, x, y, z, R() * 3, collide);
      else if (r < 0.72) P.satelliteDish(b, this.M.concF, x, y, z, R() * 6.2, 0.45 + R() * 0.3);
      else if (r < 0.86) b.box(this.M.conc, x, y, z, 1.4 + R(), 1.0 + R() * 0.8, 1.3 + R(), R() * 3, C); // stair headhouse
      else P.crateStack(b, this.M.wood, x, y, z, R() * 3, R, collide);
    }
    // A slack aerial cable or two.
    if (R() < 0.7) P.wire(b, this.M.wire, x0, y + 1.6, z0, x1, y + 1.4, z1, 0.6, 5);
  }

  /** Straight run of steps. Each riser is mantle-legal on its own. */
  _stairs(mat, x, y, z, w, rise, run, steps, dirX, dirZ) {
    const b = this.b;
    for (let i = 0; i < steps; i++) {
      const h = (i + 1) * rise;
      const cx = x + dirX * (run * (i + 0.5));
      const cz = z + dirZ * (run * (i + 0.5));
      b.box(mat, cx, 0 + y, cz, dirX ? run : w, h, dirZ ? run : w);
    }
    return { top: y + steps * rise, x: x + dirX * run * steps, z: z + dirZ * run * steps };
  }

  /**
   * Collapsed-slab ramp. Reads as a building that fell into the street and is
   * the level's primary "you can climb here" affordance — every step is a
   * mantle or a walk-up, nothing over 1.4 m.
   */
  _rubbleRamp(x, z, dirX, dirZ, len, top, width) {
    const b = this.b, R = () => this.rng();
    const steps = Math.max(4, Math.round(len / 1.6));
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const h = 0.35 + top * Math.pow(t, 1.15);
      const cx = x + dirX * len * t, cz = z + dirZ * len * t;
      b.box(this.M.concF, cx, 0, cz, dirX ? len / steps + 1.1 : width, h, dirZ ? len / steps + 1.1 : width,
        (R() - 0.5) * 0.14);
      // broken slab edge + rebar
      b.box(this.M.conc, cx + (R() - 0.5) * 1.2, h, cz + (R() - 0.5) * 1.2, 0.9 + R(), 0.22, 0.8 + R(), R() * 3);
      if (R() < 0.5) P.rebar(b, this.M.rust, cx + (R() - 0.5) * width, h, cz + (R() - 0.5) * width, 3, 0.6, 0.7, R);
    }
    // Loose spill at the foot.
    for (let i = 0; i < 26; i++) {
      const a = R() * Math.PI * 2, rr = R() * 5;
      const s = 0.16 + R() * 0.5;
      b.box(this.M.concF, x + Math.cos(a) * rr - dirX * 1.5, 0, z + Math.sin(a) * rr - dirZ * 1.5,
        s * 1.6, s * 0.7, s * 1.4, R() * 3, { collide: false });
    }
  }

  /** Shell crater: rim lip, scorched floor, radiating throw-out. */
  _crater(x, z, r, depth) {
    const b = this.b, R = () => this.rng();
    const seg = 18;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const rr = r * (0.92 + R() * 0.2);
      b.box(this.M.concF, x + Math.cos(a) * rr, -0.02, z + Math.sin(a) * rr,
        r * 0.55, 0.22 + R() * 0.28, r * 0.55, a, { collide: false });
    }
    b.plane(this.M.scorch, x, 0.035, z, r * 2.6, r * 2.6, 0, { collide: false });
    b.plane(this.M.gravel, x, 0.05, z, r * 1.5, r * 1.5, 0, { collide: false });
    for (let i = 0; i < 40; i++) {
      const a = R() * Math.PI * 2, rr = r * (1.0 + R() * 2.4);
      const s = 0.1 + R() * 0.36;
      b.box(this.M.concF, x + Math.cos(a) * rr, 0, z + Math.sin(a) * rr, s * 1.7, s * 0.6, s * 1.3, R() * 3, { collide: false });
    }
  }

  // =========================================================================
  //  Ground and street
  // =========================================================================

  _ground() {
    const size = 300;
    const geo = new THREE.PlaneGeometry(size, size, 44, 44);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const inStreet = Math.abs(x) < KERB + 2;
      const bump = Math.sin(x * 0.07) * Math.cos(z * 0.09) * 0.22 + Math.sin(x * 0.31 + z * 0.19) * 0.07;
      const fade = Math.min(1, Math.max(0, (Math.abs(x) - KERB - 2) / 12));
      pos.setY(i, bump * (inStreet ? 0 : fade));
    }
    geo.computeVertexNormals();
    const uv = geo.attributes.uv;
    const tile = this.M.sand.userData.tile ?? 8;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * size / tile, uv.getY(i) * size / tile);
    geo.deleteAttribute('uv1');

    const mesh = new THREE.Mesh(geo, this.M.sand);
    mesh.receiveShadow = true;
    mesh.name = 'Ground';
    mesh.layers.enable(COLLISION_LAYER);
    mesh.updateMatrixWorld();
    this.root.add(mesh);
    this.ground = mesh;
  }

  _street() {
    const b = this.b, R = () => this.rng();
    const Z0 = -60, Z1 = 122;

    // Asphalt with a shallow crown, plus a darker worn centre band.
    b.plane(this.M.road, 0, 0.03, (Z0 + Z1) / 2, ROAD_HALF * 2, Z1 - Z0);
    b.plane(this.M.scorch, 0, 0.045, (Z0 + Z1) / 2, 3.2, Z1 - Z0, 0, { collide: false });

    // Pavements: raised slab + kerb face + gutter strip. The kerb is the single
    // most useful human-scale reference in the frame.
    for (const s of [-1, 1]) {
      b.aabb(this.M.concF, s * ROAD_HALF, 0, Z0, s * KERB, PAVE_Y, Z1);
      b.aabb(this.M.conc, s * (ROAD_HALF - 0.16), 0, Z0, s * ROAD_HALF, PAVE_Y + 0.005, Z1);
      // gutter darkening
      b.plane(this.M.scorch, s * (ROAD_HALF - 0.5), 0.05, (Z0 + Z1) / 2, 1.0, Z1 - Z0, 0, { collide: false });
      // kerb joints every 2.4 m
      for (let z = Z0; z < Z1; z += 2.4) {
        b.box(this.M.conc, s * (ROAD_HALF - 0.09), PAVE_Y - 0.02, z, 0.2, 0.03, 0.06, 0, { collide: false });
      }
    }

    // Broken centre line + edge lines. A corridor level lives or dies on its
    // leading lines; these run straight at the gatehouse.
    // The marking texture is one stripe across its U axis, so these quads take
    // u = 0..1 across their width and repeat only along their length.
    for (let z = Z0; z < Z1; z += 6.4) {
      b.plane(this.M.roadLine, 0, 0.052, z, 1.3, 3.2, 0, { collide: false, uv: [1, 0.8] });
    }
    for (const s2 of [-1, 1]) {
      b.plane(this.M.roadLine, s2 * (ROAD_HALF - 1.2), 0.052, (Z0 + Z1) / 2, 1.3, Z1 - Z0, 0,
        { collide: false, uv: [1, (Z1 - Z0) / 4] });
    }
    // Faded pedestrian crossing where the cross street meets the junction.
    for (let i = 0; i < 9; i++) {
      b.plane(this.M.roadLine, -5.6 + i * 1.5, 0.053, 20.0, 1.3, 3.4, 0, { collide: false, uv: [1, 0.85] });
    }

    // Cross street heading west out of the junction.
    b.plane(this.M.road, -26, 0.032, 15, 34, 6.4);
    // Sand / dirt encroaching over the asphalt at the edges.
    for (let i = 0; i < 40; i++) {
      const z = -58 + R() * 178;
      const s = R() < 0.5 ? -1 : 1;
      b.plane(this.M.sand, s * (ROAD_HALF - R() * 1.6), 0.055, z, 1.2 + R() * 2.4, 2 + R() * 6, 0, { collide: false });
    }

    // Manhole covers and a drain grate — small, but they read as a real road.
    for (const [x, z] of [[-2.4, 12], [3.1, 47], [-3.6, 84], [2.0, -18]]) {
      P.cylinder(b, this.M.rust, x, 0.04, z, 0.4, 0.04, null, { hi: true, collide: false });
    }
  }

  _perimeter() {
    const b = this.b;
    const mat = this.M.conc;
    // T-wall ring well outside the facades: it is a backstop, not scenery.
    const X = 46, ZA = -50, ZB = 126;
    const seg = 4;
    for (let x = -X; x <= X; x += seg) {
      this._twall(x, ZA, 0);
      this._twall(x, ZB, 0);
    }
    for (let z = ZA; z <= ZB; z += seg) {
      this._twall(-X, z, Math.PI / 2);
      this._twall(X, z, Math.PI / 2);
    }
    // Invisible blockers behind the set. These are what actually keep the
    // player in bounds; the T-walls in front of them are scenery. Four boxes,
    // 48 triangles, instead of a visible slab that would show down the alleys.
    const H = { collide: true, hidden: true };
    b.aabb(mat, -46, 0, -52, -38.5, 14, 128, H);
    b.aabb(mat, 36.5, 0, -52, 46, 14, 128, H);
    b.aabb(mat, -46, 0, -52, 46, 14, -44, H);
    b.aabb(mat, -46, 0, 119, 46, 14, 128, H);
  }

  _twall(x, z, rotY) {
    const b = this.b;
    const N = { collide: false };
    b.box(this.M.concF, x, 0, z, 3.9, 0.25, 1.5, rotY, N);
    b.box(this.M.conc, x, 0.25, z, 3.6, 3.4, 0.42, rotY, N);
    b.box(this.M.conc, x, 3.65, z, 3.7, 0.16, 0.55, rotY, N);
  }

  // =========================================================================
  //  West side of the street
  // =========================================================================

  _westBlocks() {
    const b = this.b, R = () => this.rng();

    // --- WA: shophouse row, z 22..40. Balconies over the pavement, awnings,
    //     and one ground-floor shop the player can walk into.
    this._block({
      x0: -28, x1: -KERB, z0: 22, z1: 33.5, floors: 3, mat: this.M.plasterA,
      open: ['+x', '+z'], balcony: true, noGround: ['+x'], hollowFloors: 1,
      doors: [{ face: '+x', c: 24.6, w: 1.6, h: 2.5 }],
      extra: [
        { face: '+x', c: 28.4, w: 3.6, y: 0.02, h: 2.7 },   // shopfront
        { face: '+x', c: 31.6, w: 2.0, y: 0.95, h: 1.7 },   // side window
      ],
    });
    // Solid mass behind the shop room so only the shop itself is enterable.
    b.aabb(this.M.plasterA, -27.6, 0, 22.4, -20.9, 3.3, 33.1);
    this._shopInterior(-20.5, -KERB, 22.4, 33.1);

    this._block({
      x0: -26, x1: -KERB, z0: 34.5, z1: 40, floors: 2, mat: this.M.brick,
      open: ['+x', '+z', '-z'], balcony: true,
      doors: [{ face: '+x', c: 37.2, w: 1.4 }],
    });

    // Alley A (z 40..46) — a real gap in the wall, 6 m wide, running west.
    this._block({ x0: -30, x1: -KERB, z0: 46, z1: 62, floors: 2, mat: this.M.plasterB, open: ['+x', '-z', '+z'], balcony: true, doors: [{ face: '+x', c: 50.5, w: 1.6, h: 2.5 }] });
    // Alley walls get their own texture change + service clutter.
    for (let z = 41; z < 45.5; z += 1.6) {
      if (R() < 0.5) P.cylinder(b, this.M.rust, -14 - R() * 12, 0, z, 0.05, 5, null, { collide: false });
    }
    P.laundry(b, this.M.wire, this.M.cloth, -12.5, 6.4, 42.0, -25, 5.9, 43.4, R);
    P.laundry(b, this.M.wire, this.M.cloth, -13.5, 4.2, 44.6, -26, 4.6, 43.0, R);

    // Rubble choke halfway down alley A: you can climb it but not sprint it.
    this._rubbleRamp(-19, 43, -1, 0, 5.5, 1.5, 5.4);

    // --- The stepped mass that lets you reach the gatehouse roof from the west
    //     shophouse: crates -> low roof (5.2) -> mantle -> parapet.
    P.crateStack(b, this.M.wood, -12.2, PAVE_Y, 60.5, 0.3, R);
    b.box(this.M.conc, -12.6, PAVE_Y, 58.6, 2.4, 1.35, 2.2, 0.1);
    b.box(this.M.conc, -12.9, PAVE_Y + 1.35, 57.0, 2.0, 1.3, 2.0, -0.15);

    this._cover(-11.6, 30); this._cover(-11.6, 50);
  }

  /**
   * The enterable ground-floor shop. Gutted, one room, a counter, a hole in the
   * back wall to the alley, and a big shopfront opening that throws a hard slab
   * of light across the floor.
   */
  /**
   * Dresses the gutted ground-floor shop. The shell (walls, openings, ceiling
   * slab) already exists — this is contents only, plus a partition that turns
   * one big box into two readable spaces.
   */
  _shopInterior(x0, x1, z0, z1) {
    const b = this.b, R = () => this.rng();
    const cz = (z0 + z1) / 2;
    // Worn tile floor over the shell's slab.
    b.plane(this.M.tile, (x0 + x1) / 2, 0.03, cz, x1 - x0 - 0.5, z1 - z0 - 0.5, 0, { collide: false });

    // Back partition with a doorway — depth inside the room.
    this._wall(this.M.plasterB, 'z', z0 + 0.4, z1 - 0.4, x0 + 3.2, 0, 3.05, 0.22,
      [{ c: cz + 1.6, w: 1.1, y: 0.02, h: 2.2 }]);
    // Collapsed section of the ceiling slab lets a shaft of light into the back.
    P.rebar(b, this.M.rust, x0 + 1.6, 3.05, z0 + 2.4, 9, 1.8, 0.9, R);

    // Steel roller shutter half-open over the shopfront.
    b.box(this.M.rust, -10.55, 2.35, 28.4, 0.14, 0.42, 3.7, 0, { collide: false });
    for (let i = 0; i < 4; i++) b.box(this.M.rust, -10.5, 1.95 + i * 0.1, 28.4, 0.06, 0.06, 3.6, 0, { collide: false });
    P.awning(b, this.M.tarp, this.M.rust, -9.6, 3.35, 28.4, 4.6, 1.9, -Math.PI / 2);
    // Shop sign board.
    b.box(this.M.wood, -10.5, 2.95, 24.6, 0.1, 0.75, 3.2, 0, { collide: false });

    // Contents.
    b.box(this.M.wood, x0 + 4.6, 0, cz - 2.4, 0.72, 0.95, 3.6, 0);        // counter
    b.box(this.M.wood, x0 + 0.9, 0, cz + 2.2, 0.44, 2.2, 3.2, 0);          // shelving
    for (let i = 0; i < 5; i++) {
      b.box(this.M.wood, x0 + 1.3, 0.42 + i * 0.42, cz + 2.2, 0.62, 0.05, 3.0, 0, { collide: false });
    }
    b.box(this.M.wood, x0 + 6.0, 0, z0 + 1.6, 1.5, 0.76, 0.9, 0.3);        // table
    P.chair(b, this.M.wood, x0 + 7.4, 0, cz + 1.0, 0.7, true);
    P.chair(b, this.M.wood, x0 + 5.6, 0, z0 + 2.9, 2.1, false);
    P.crateStack(b, this.M.wood, x1 - 1.6, 0, z0 + 1.4, 0.4, R);
    P.crateStack(b, this.M.wood, x0 + 1.3, 0, z1 - 1.6, 1.1, R);
    P.oilDrum(b, this.M.rust, x0 + 2.0, 0, z1 - 2.6, 0, false);
    // Rubble, papers and a shaft-catching dust of debris on the floor.
    for (let i = 0; i < 46; i++) {
      b.plane(this.M.cloth, x0 + 0.6 + R() * (x1 - x0 - 1.2), 0.05, z0 + 0.6 + R() * (z1 - z0 - 1.2),
        0.22 + R() * 0.18, 0.3 + R() * 0.18, R() * 3, { collide: false });
    }
    for (let i = 0; i < 40; i++) {
      const s = 0.1 + R() * 0.3;
      b.box(this.M.concF, x0 + 0.6 + R() * (x1 - x0 - 1.2), 0.04, z0 + 0.6 + R() * (z1 - z0 - 1.2),
        s * 1.5, s * 0.6, s * 1.3, R() * 3, { collide: false });
    }
    this.spawnPoints.push(new THREE.Vector3(x0 + 5.5, 0.2, cz));
    this._cover(x0 + 4.6, cz - 2.4);
  }

  // =========================================================================
  //  East side of the street
  // =========================================================================

  _eastBlocks() {
    const b = this.b, R = () => this.rng();

    // --- EA: the collapsed block. Its north-west corner has fallen into the
    //     street; the debris is the ramp to its roof at 6.6 m.
    this._block({
      x0: KERB, x1: 28, z0: 16, z1: 30, floors: 2, floorH: 3.3, mat: this.M.plasterB,
      open: ['-x', '+z', '-z'], parapet: 0.85, walkableRoof: true,
      doors: [{ face: '-x', c: 20.5, w: 1.6 }],
    });
    // Shear the corner off: a wedge of missing wall with exposed floor slabs.
    this._collapseCorner(KERB, 30, 1, -1, 7.5, 6.6);
    this._rubbleRamp(11.4, 32.6, 0.55, -0.83, 10.5, 6.3, 5.0);
    this._cover(12.2, 26);

    // --- EB: courtyard block, z 36..62. Hollow: the middle is an open market
    //     yard entered from the street through a 5 m gap.
    const cy = { x0: 15.5, x1: 31.5, z0: 42, z1: 62 };
    // south range
    this._block({ x0: KERB, x1: 34, z0: 36, z1: 41.5, floors: 3, mat: this.M.plasterA, open: ['-x', '-z', '+z'], balcony: true, doors: [{ face: '-x', c: 38.8, w: 1.5 }] });
    // street range, split by the courtyard gate
    this._block({ x0: KERB, x1: 15.5, z0: 41.5, z1: 46.0, floors: 3, mat: this.M.brick, open: ['-x'], balcony: true });
    this._gateArch(KERB, 15.5, 46.0, 51.0, 5.4, 3.0);
    this._block({ x0: KERB, x1: 15.5, z0: 51.0, z1: 62, floors: 3, mat: this.M.plasterB, open: ['-x'], balcony: true, doors: [{ face: '-x', c: 57.0, w: 1.5 }] });
    // east range
    this._block({ x0: 31.5, x1: 36, z0: 41.5, z1: 62, floors: 3, mat: this.M.plasterA, open: ['-x'], cover: false });
    // north range with the external stair
    this._block({ x0: KERB, x1: 36, z0: 62, z1: 66, floors: 3, mat: this.M.brick, open: ['-z', '+z'], cover: false });

    this._courtyard(cy);

    // --- EC: tall far-side block beyond the gatehouse.
    this._block({ x0: 12, x1: 34, z0: 72, z1: 92, floors: 4, mat: this.M.plasterB, open: ['-x', '-z'], balcony: true, doors: [{ face: '-x', c: 78, w: 1.5 }] });
    this._block({ x0: 12, x1: 32, z0: 96, z1: 112, floors: 3, mat: this.M.plasterA, open: ['-x', '-z'] });

    // --- EE: southern east frontage.
    this._block({ x0: KERB, x1: 30, z0: -26, z1: -8, floors: 3, mat: this.M.plasterA, open: ['-x', '+z'], balcony: true, doors: [{ face: '-x', c: -18, w: 1.5 }] });
    this._block({ x0: KERB, x1: 32, z0: -4, z1: 12, floors: 2, mat: this.M.brick, open: ['-x', '-z', '+z'], balcony: true, doors: [{ face: '-x', c: 2.5, w: 1.6 }] });
  }

  /** Removes a building corner and leaves cantilevered slabs and rebar. */
  _collapseCorner(x, z, dirX, dirZ, w, top) {
    const b = this.b, R = () => this.rng();
    for (let i = 0; i < 3; i++) {
      const y = 3.3 * (i + 1) - 0.3;
      if (y > top) break;
      const l = w * (1 - i * 0.22);
      b.box(this.M.concF, x + dirX * l * 0.5, y, z + dirZ * l * 0.5, l, 0.3, l, 0.06 * i, { collide: true });
      P.rebar(b, this.M.rust, x + dirX * l, y + 0.3, z + dirZ * l, 7, 1.6, 0.9, R);
    }
    for (let i = 0; i < 14; i++) {
      const a = R() * Math.PI * 2, rr = 1 + R() * 5;
      b.box(this.M.conc, x + dirX * 2 + Math.cos(a) * rr, R() * 3.5, z + dirZ * 2 + Math.sin(a) * rr,
        0.8 + R() * 1.4, 0.24, 0.7 + R() * 1.2, R() * 3, { collide: false });
    }
  }

  /** A vaulted gate through a street range — courtyards need an entrance. */
  _gateArch(x0, x1, z0, z1, w, springing) {
    const b = this.b;
    const cz = (z0 + z1) / 2;
    const mat = this.M.brick;
    const r = w / 2;
    // piers
    b.aabb(mat, x0, 0, z0, x1, springing, cz - r);
    b.aabb(mat, x0, 0, cz + r, x1, springing, z1);
    // barrel vault approximated by slabs
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const y = springing + (r * (i + 0.5)) / steps;
      const hw = Math.sqrt(Math.max(0, r * r - Math.pow(y - springing, 2)));
      const sh = r / steps + 0.01;
      b.aabb(mat, x0, y, z0, x1, y + sh, cz - hw);
      b.aabb(mat, x0, y, cz + hw, x1, y + sh, z1);
    }
    b.aabb(mat, x0, springing + r, z0, x1, 9.9, z1);
    b.aabb(this.M.concF, x0, 9.9, z0, x1, 10.2, z1);
    b.aabb(mat, x0, 10.2, z0, x1, 11.0, z0 + 0.3);
    b.aabb(mat, x0, 10.2, z1 - 0.3, x1, 11.0, z1);
    // keystone + voussoir band on the street face
    b.box(this.M.concF, x0 - 0.06, springing + r - 0.1, cz, 0.16, 0.5, 0.7, 0, { collide: false });
    b.plane(this.M.concF, (x0 + x1) / 2, 0.06, cz, x1 - x0, w, 0, { collide: false });
  }

  /** The market yard inside EB: stalls, awning run, well, stair up, footbridge. */
  _courtyard(c) {
    const b = this.b, R = () => this.rng();
    const cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2;
    b.plane(this.M.gravel, cx, 0.03, cz, c.x1 - c.x0, c.z1 - c.z0);
    b.plane(this.M.concF, cx, 0.05, cz, 6.5, 6.5, 0.4, { collide: false });

    // Stall row along the west side, facing into the yard.
    for (let i = 0; i < 4; i++) {
      P.stall(b, this.M.wood, this.M.tarp, this.M.wood, c.x0 + 1.6, 0, c.z0 + 2.6 + i * 3.4, -Math.PI / 2, 2.8, 1.9, R);
      this._cover(c.x0 + 2.6, c.z0 + 2.6 + i * 3.4);
    }
    // Continuous awning along the east side.
    for (let i = 0; i < 5; i++) {
      P.awning(b, this.M.tarp, this.M.rust, c.x1 - 1.0, 2.9, c.z0 + 2.2 + i * 3.6, 3.4, 2.0, -Math.PI / 2);
    }
    // Laundry and bunting overhead — the thing that makes a courtyard read.
    P.laundry(b, this.M.wire, this.M.cloth, c.x0 + 0.4, 7.0, c.z0 + 4, c.x1 - 0.4, 6.4, c.z0 + 7, R);
    P.laundry(b, this.M.wire, this.M.cloth, c.x0 + 0.4, 6.2, c.z0 + 12, c.x1 - 0.4, 6.9, c.z0 + 10, R);
    P.wire(b, this.M.wire, c.x0, 9.4, c.z0 + 16, c.x1, 9.0, c.z0 + 15, 1.0, 6);

    // Well / cistern head at the centre — a landmark inside the yard.
    P.cylinder(b, this.M.conc, cx, 0, cz, 1.15, 0.85, null, { hi: true });
    P.cylinder(b, this.M.dark, cx, 0.85, cz, 0.95, 0.04, null, { hi: true, collide: false });
    for (const s of [-1, 1]) b.box(this.M.rust, cx + s * 1.05, 0.85, cz, 0.1, 1.9, 0.1, 0, { collide: false });
    b.box(this.M.rust, cx, 2.7, cz, 2.3, 0.1, 0.1, 0, { collide: false });
    this._cover(cx, cz + 1.6);

    // External stair: yard -> terrace (6.6 m). Open risers, concrete.
    const s1 = this._stairs(this.M.concF, c.x1 - 3.4, 0, c.z1 - 1.6, 2.2, 0.19, 0.31, 17, 0, -1);
    b.aabb(this.M.concF, c.x1 - 4.6, s1.top - 0.3, c.z1 - 8.4, c.x1 - 2.2, s1.top, c.z1 - 5.4);
    const s2 = this._stairs(this.M.concF, c.x1 - 3.4, s1.top, c.z1 - 7.9, 2.2, 0.19, 0.31, 17, 0, 1);
    // Landing / terrace slab over the yard's north-east corner.
    b.aabb(this.M.concF, c.x1 - 6.2, s2.top - 0.32, c.z1 - 4.0, c.x1 + 0.4, s2.top, c.z1 + 0.2);
    for (let i = 0; i < 12; i++) b.box(this.M.rust, c.x1 - 6.2 + i * 0.52, s2.top, c.z1 - 4.0, 0.06, 0.95, 0.06, 0, { collide: false });
    b.box(this.M.concF, c.x1 - 3.0, s2.top + 0.95, c.z1 - 4.0, 6.6, 0.1, 0.14, 0, { collide: false });
    P.sandbags(b, this.M.bag, c.x1 - 4.2, s2.top, c.z1 - 2.0, Math.PI, 3, 6);
    this._cover(c.x1 - 4.2, c.z1 - 2.6);

    // Footbridge: plank deck on steel beams, terrace -> west range roof.
    const by = s2.top;
    b.aabb(this.M.rust, c.x0 - 0.6, by - 0.24, c.z1 - 3.2, c.x1 - 5.6, by - 0.06, c.z1 - 1.4);
    for (let i = 0; i < 16; i++) {
      b.box(this.M.wood, c.x0 - 0.4 + i * 0.62, by - 0.06, c.z1 - 2.3, 0.55, 0.08, 1.7, 0, { collide: false });
    }
    for (const zz of [c.z1 - 3.2, c.z1 - 1.4]) {
      for (let i = 0; i < 9; i++) b.box(this.M.rust, c.x0 - 0.4 + i * 1.1, by, zz, 0.06, 1.0, 0.06, 0, { collide: false });
      b.aabb(this.M.rust, c.x0 - 0.6, by + 1.0, zz - 0.05, c.x1 - 5.6, by + 1.06, zz + 0.05, { collide: false });
    }
    this.spawnPoints.push(new THREE.Vector3(c.x1 - 9.5, by + 0.25, c.z1 - 2.3)); // on the footbridge, clear of the sandbags

    // Ground clutter: pallets, crates, drums, tyres, a burnt car in the corner.
    P.carWreck(b, this.M.dark, this.M.dark, this.M.rust, c.x0 + 3.4, 0, c.z1 - 4.0, 1.15, R);
    for (let i = 0; i < 9; i++) {
      const x = c.x0 + 1 + R() * (c.x1 - c.x0 - 2), z = c.z0 + 1 + R() * (c.z1 - c.z0 - 2);
      const r = R();
      if (r < 0.35) P.crateStack(b, this.M.wood, x, 0, z, R() * 3, R);
      else if (r < 0.6) P.oilDrum(b, this.M.rust, x, 0, z, R() * 3, R() < 0.3);
      else if (r < 0.8) P.pallet(b, this.M.wood, x, 0.02, z, R() * 3);
      else P.tyre(b, this.M.dark, x, 0.02, z, R() * 3, true);
    }
  }

  // =========================================================================
  //  The gatehouse — the hero framing element
  // =========================================================================

  _gatehouse() {
    const b = this.b, R = () => this.rng();
    const z0 = 64, z1 = 70.5;
    const mat = this.M.brick;
    const springing = 4.4;
    const r = 6.2;                 // arch radius -> 12.4 m span, crown at 10.6
    const top = 15.4;

    // Piers.
    b.aabb(mat, -16, 0, z0, -r, springing, z1);
    b.aabb(mat, r, 0, z0, 16, springing, z1);
    // Plinth course.
    b.aabb(this.M.concF, -16.2, 0, z0 - 0.2, -r + 0.2, 0.75, z1 + 0.2, { collide: false });
    b.aabb(this.M.concF, r - 0.2, 0, z0 - 0.2, 16.2, 0.75, z1 + 0.2, { collide: false });

    // Barrel vault, cut as slabs so the intrados is a true arc.
    const steps = 26;
    for (let i = 0; i < steps; i++) {
      const y = springing + (r * (i + 0.5)) / steps;
      const hw = Math.sqrt(Math.max(0, r * r - Math.pow(y - springing, 2)));
      const sh = r / steps + 0.02;
      b.aabb(mat, -16, y, z0, -hw, y + sh, z1);
      b.aabb(mat, hw, y, z0, 16, y + sh, z1);
    }
    // Mass above the crown, with a band of windows and a big square opening
    // that keeps the silhouette from being one solid slab.
    const crown = springing + r;
    this._wall(mat, 'x', -16, 16, z0 + 0.3, crown, top - crown, 0.6, [
      { c: -9.5, w: 1.4, y: crown + 1.2, h: 1.9 },
      { c: -4.5, w: 1.4, y: crown + 1.2, h: 1.9 },
      { c: 0, w: 3.0, y: crown + 1.0, h: 2.6 },
      { c: 4.5, w: 1.4, y: crown + 1.2, h: 1.9 },
      { c: 9.5, w: 1.4, y: crown + 1.2, h: 1.9 },
    ]);
    this._wall(mat, 'x', -16, 16, z1 - 0.3, crown, top - crown, 0.6, [
      { c: -9.5, w: 1.4, y: crown + 1.2, h: 1.9 },
      { c: 0, w: 3.0, y: crown + 1.0, h: 2.6 },
      { c: 9.5, w: 1.4, y: crown + 1.2, h: 1.9 },
    ]);
    b.aabb(mat, -16, crown, z0 + 0.6, -12, top, z1 - 0.6);
    b.aabb(mat, 12, crown, z0 + 0.6, 16, top, z1 - 0.6);
    b.aabb(this.M.concF, -16, crown, z0 + 0.6, 16, crown + 0.3, z1 - 0.6);
    for (const c of [-9.5, -4.5, 0, 4.5, 9.5]) this._reveal('x', c, z0 + 0.3, crown + 1.1, c === 0 ? 3.0 : 1.4, c === 0 ? 2.6 : 1.9, 0.6, -1);

    // Roof, parapet, and a crenellated coping — the top edge of the frame.
    b.aabb(this.M.concF, -16.4, top, z0 - 0.4, 16.4, top + 0.35, z1 + 0.4);
    for (let x = -16.4; x < 16.4; x += 1.3) {
      b.box(mat, x + 0.45, top + 0.35, z0 - 0.15, 0.9, 1.0, 0.5);
      b.box(mat, x + 0.45, top + 0.35, z1 + 0.15, 0.9, 1.0, 0.5);
    }
    b.aabb(mat, -16.4, top + 0.35, z0 + 0.35, -15.9, top + 1.35, z1 - 0.35);
    b.aabb(mat, 15.9, top + 0.35, z0 + 0.35, 16.4, top + 1.35, z1 - 0.35);
    this._roofClutter(-15, 15, z0 + 1, z1 - 1, top + 0.35, true);

    // Corbelled string course under the arch springing, plus lamp brackets.
    for (const s of [-1, 1]) {
      b.aabb(this.M.concF, s > 0 ? r - 0.3 : -16.2, springing - 0.35, z0 - 0.25, s > 0 ? 16.2 : -r + 0.3, springing, z1 + 0.25, { collide: false });
    }
    for (const s of [-1, 1]) {
      b.box(this.M.rust, s * (r - 0.5), 3.4, z0 - 0.4, 0.12, 0.12, 0.8, 0, { collide: false });
      b.box(this.M.rust, s * (r - 0.5), 3.9, z0 - 0.75, 0.42, 0.5, 0.42, 0, { collide: false });
    }

    // Hanging sign over the passage — occludes the vista slightly, which is
    // exactly what stops the arch reading as an empty rectangle.
    b.box(this.M.rust, 0, 3.9, z0 - 0.5, 0.08, 0.08, 1.0, 0, { collide: false });
    b.box(this.M.rust, -2.6, 3.2, z0 - 0.9, 5.2, 0.9, 0.08, 0.04, { collide: false });

    // Blast damage: the west pier has taken a hit.
    b.box(this.M.dark, -r - 1.6, 0, z0 - 0.15, 2.6, 3.2, 0.35, 0.05, { collide: false });
    P.rebar(b, this.M.rust, -r - 1.4, 2.6, z0 - 0.2, 6, 1.4, 0.8, R);

    // Checkpoint dressing under the arch: barriers, a burnt car, sandbags.
    P.jerseyBarrier(b, this.M.conc, -4.6, 0, z0 - 2.2, 0.06);
    P.jerseyBarrier(b, this.M.conc, -1.2, 0, z0 - 2.4, -0.03);
    P.jerseyBarrier(b, this.M.conc, 3.6, 0, z1 + 2.0, 0.02);
    P.sandbags(b, this.M.bag, 5.6, 0, z0 - 3.2, -Math.PI / 2, 3, 6);
    this._cover(-4.6, z0 - 3.2); this._cover(5.6, z0 - 4.0);
    this._cover(0, z1 + 2.6);
  }

  // =========================================================================
  //  Far quarter (seen through the arch)
  // =========================================================================

  _farQuarter() {
    const b = this.b, R = () => this.rng();

    this._block({ x0: -32, x1: -KERB, z0: 74, z1: 86, floors: 4, mat: this.M.plasterB, open: ['+x', '-z', '+z'], balcony: true, doors: [{ face: '+x', c: 80, w: 1.5 }] });
    this._block({ x0: -32, x1: -16, z0: 88, z1: 104, floors: 3, mat: this.M.plasterA, open: ['+x', '-z'] });
    this._block({ x0: -32, x1: -KERB, z0: 108, z1: 118, floors: 3, mat: this.M.brick, open: ['-z'] });

    // --- The minaret. Offset just far enough west that a slice of it lands
    //     inside the arch opening from the spawn, which is the whole point.
    const mx = -13.0, mz = 94.0, H = 23.5;
    const mat = this.M.plasterB;
    b.box(this.M.concF, mx, 0, mz, 6.4, 1.0, 6.4);
    b.box(mat, mx, 1.0, mz, 5.2, 9.0, 5.2);
    b.box(this.M.concF, mx, 10.0, mz, 5.8, 0.4, 5.8, 0, { collide: false });
    b.box(mat, mx, 10.4, mz, 4.2, 5.0, 4.2, Math.PI / 8);
    b.box(this.M.concF, mx, 15.4, mz, 5.4, 0.35, 5.4, Math.PI / 8, { collide: false });
    // gallery railing
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      b.box(this.M.rust, mx + Math.cos(a) * 2.5, 15.75, mz + Math.sin(a) * 2.5, 0.08, 0.9, 0.08, a, { collide: false });
    }
    b.box(mat, mx, 15.75, mz, 3.0, H - 16.6, 3.0, Math.PI / 8);
    // window slots on the shaft
    for (let i = 0; i < 4; i++) {
      const y = 3.0 + i * 2.0;
      b.box(this.M.dark, mx, y, mz - 2.62, 0.7, 1.5, 0.14, 0, { collide: false });
      b.box(this.M.dark, mx - 2.62, y, mz, 0.14, 1.5, 0.7, 0, { collide: false });
    }
    // cap
    b.box(this.M.concF, mx, H - 0.85, mz, 3.6, 0.3, 3.6, Math.PI / 8, { collide: false });
    b.shape(this.M.concF, new THREE.ConeGeometry(2.0, 2.6, 8),
      { x: mx, y: H + 0.75, z: mz }, { x: 0, y: Math.PI / 8, z: 0 }, { x: 1, y: 1, z: 1 },
      { collide: false, uvScale: [3, 2] });
    P.cylinder(b, this.M.rust, mx, H + 2.0, mz, 0.06, 1.4, null, { collide: false });

    // A vehicle checkpoint and craters on the far stretch so the vista through
    // the arch has depth cues rather than empty asphalt.
    this._crater(-1.8, 78.5, 3.2, 0.6);
    P.carWreck(b, this.M.dark, this.M.dark, this.M.rust, 3.6, 0, 86.0, 1.9, R);
    P.busWreck(b, this.M.cRed, this.M.dark, this.M.rust, this.M.glass, -2.0, 0, 104.0, 1.35);
    for (let i = 0; i < 5; i++) P.jerseyBarrier(b, this.M.conc, -5 + i * 2.6, 0, 99 + (i % 2) * 1.2, Math.PI / 2);
    for (let i = -6; i <= 6; i++) {
      if (Math.abs(i) < 1) continue;
      P.utilityPole(b, this.M.wood, this.M.rust, this.M.wire, 9.6, PAVE_Y, 74 + i * 6, 8.4, 0.02);
    }
  }

  // =========================================================================
  //  Southern market quarter
  // =========================================================================

  _marketQuarter() {
    const b = this.b, R = () => this.rng();

    // Square on the west side of the street, z -2..18, bounded west by MA.
    this._block({ x0: -38, x1: -24, z0: -6, z1: 22, floors: 2, mat: this.M.plasterA, open: ['+x', '+z'], balcony: true, doors: [{ face: '+x', c: 4.0, w: 1.6 }, { face: '+x', c: 14.0, w: 1.4 }] });
    // North side of the square is WA's flank; south side:
    this._block({ x0: -32, x1: -KERB, z0: -9, z1: -2, floors: 3, mat: this.M.brick, open: ['+z', '+x'], balcony: true });
    // Alley (z -14 .. -9) then the southern block.
    this._block({ x0: -32, x1: -KERB, z0: -26, z1: -14, floors: 3, mat: this.M.plasterB, open: ['+z', '+x', '-z'], balcony: true, doors: [{ face: '+z', c: -19, w: 1.5 }] });

    // --- Square dressing. This is the pose "wall" and "alley" backdrop.
    b.plane(this.M.gravel, -17.5, 0.04, 8, 12.5, 18);
    for (let i = 0; i < 5; i++) {
      P.stall(b, this.M.wood, this.M.tarp, this.M.wood, -22.0, 0, 0.5 + i * 3.6, Math.PI / 2, 2.9, 2.0, R);
      this._cover(-20.6, 0.5 + i * 3.6);
    }
    for (let i = 0; i < 4; i++) {
      P.awning(b, this.M.tarp, this.M.rust, -12.6, 3.0, 2.5 + i * 4.0, 3.6, 2.2, Math.PI / 2);
    }
    P.laundry(b, this.M.wire, this.M.cloth, -23.4, 6.6, 4.0, -11.4, 6.0, 5.2, R);
    P.laundry(b, this.M.wire, this.M.cloth, -23.4, 5.6, 11.5, -11.4, 6.4, 10.2, R);
    P.wire(b, this.M.wire, -23.4, 8.2, 15.5, -11.4, 8.0, 16.4, 0.9, 6);

    // Fountain/basin at the square's centre gives the eye a focal point.
    b.box(this.M.concF, -17.6, 0, 12.2, 4.4, 0.55, 4.4, 0.2);
    b.box(this.M.dark, -17.6, 0.55, 12.2, 3.6, 0.05, 3.6, 0.2, { collide: false });
    P.cylinder(b, this.M.concF, -17.6, 0.55, 12.2, 0.5, 1.5, null, { hi: true });
    this._cover(-17.6, 14.6);

    // Sandbagged position at the square's mouth, facing north up the street.
    P.sandbags(b, this.M.bag, -12.0, PAVE_Y, 19.5, 0, 3, 8);
    P.hesco(b, this.M.bag, this.M.rust, -9.2, 0, 17.0, 4.0, 0);
    this._cover(-12.0, 18.0);

    // --- Alley at z -14..-9: containers, drums, fire escape, deep shade.
    for (const [x, z, rot, col] of [[-13.5, -11.5, 0.02, 0], [-21.0, -11.4, 0, 1], [-28.5, -11.6, 0.05, 0]]) {
      const m = col ? this.M.cBlue : this.M.cRed;
      this._container(m, x, 0, z, rot);
      this._cover(x, z + 2.0);
    }
    this._container(this.M.cBlue, -25.0, 0, -11.5, 0.03);
    this._container(this.M.cRed, -25.0, 2.62, -11.5, -0.02);
    for (let i = 0; i < 6; i++) P.oilDrum(b, this.M.rust, -30 + R() * 18, 0, -13.4 + R() * 1.2, R() * 3, R() < 0.25);
    // Fire escape on the south alley wall — climbable to a 4.2 m platform.
    this._fireEscape(-16.5, -14.0, 4.2);

    // Street frontage south of the square.
    P.carWreck(b, this.M.dark, this.M.dark, this.M.rust, -3.4, 0, -6.0, 0.35, R);
    this._crater(4.2, -20.0, 2.8, 0.5);
    for (let i = 0; i < 6; i++) P.jerseyBarrier(b, this.M.conc, -8.4, 0, -24 + i * 3.6, 0.0);
    for (let i = -3; i <= 2; i++) P.utilityPole(b, this.M.wood, this.M.rust, this.M.wire, -9.6, PAVE_Y, i * 8 - 2, 8.4, -0.02);
  }

  _container(mat, x, y, z, rotY) {
    const b = this.b;
    const L = 6.06, W = 2.44, H = 2.59;
    b.box(mat, x, y, z, W, H, L, rotY);
    // corrugation is in the material; add corner castings + door furniture.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.box(this.M.rust, x + sx * (W / 2 - 0.09) * Math.cos(rotY), y, z + sz * (L / 2 - 0.09), 0.2, H, 0.2, rotY, { collide: false });
    }
    const c = Math.cos(rotY), s = Math.sin(rotY);
    for (const o of [-0.55, 0.55]) {
      b.box(this.M.rust, x + c * o - s * (L / 2 + 0.03), y + 0.2, z + s * o + c * (L / 2 + 0.03), 0.1, H - 0.5, 0.1, rotY, { collide: false });
    }
    b.box(this.M.rust, x - s * (L / 2 + 0.04), y + 1.1, z + c * (L / 2 + 0.04), 0.9, 0.12, 0.08, rotY, { collide: false });
  }

  /** Zig-zag steel fire escape bolted to a wall. Reachable, mantle-friendly. */
  _fireEscape(x, z, top) {
    const b = this.b;
    const m = this.M.rust;
    b.aabb(m, x - 1.4, top - 0.1, z - 0.1, x + 1.4, top, z + 1.5);
    for (let i = 0; i < 6; i++) b.box(m, x - 1.4 + i * 0.55, top, z + 1.45, 0.06, 1.0, 0.06, 0, { collide: false });
    b.aabb(m, x - 1.4, top + 1.0, z + 1.4, x + 1.4, top + 1.06, z + 1.5, { collide: false });
    // steps down to a chest-high landing you can mantle onto
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      b.box(m, x + 1.5 + i * 0.34, top - 0.42 - i * 0.42, z + 0.7, 0.34, 0.08, 1.1, 0, { collide: true });
    }
    b.box(m, x + 4.4, 0, z + 0.7, 0.9, 1.15, 1.1, 0);
  }

  // =========================================================================
  //  Street dressing — the pass that turns geometry into a place
  // =========================================================================

  _dressing() {
    const b = this.b, R = () => this.rng();

    // Poles + catenary wires down both sides of the main street. Overhead
    // lines are the cheapest way to close the top of a street frame.
    const polesW = [], polesE = [];
    for (let z = -30; z <= 62; z += 11) {
      polesW.push(P.utilityPole(b, this.M.wood, this.M.rust, this.M.wire, -9.7, PAVE_Y, z, 8.6, -0.015).top);
      polesE.push(P.utilityPole(b, this.M.wood, this.M.rust, this.M.wire, 9.7, PAVE_Y, z, 8.2, 0.015).top);
    }
    for (let i = 1; i < polesW.length; i++) {
      const z0 = -30 + (i - 1) * 11, z1 = -30 + i * 11;
      P.wire(b, this.M.wire, -9.7, polesW[i - 1], z0, -9.7, polesW[i], z1, 1.2);
      P.wire(b, this.M.wire, -9.1, polesW[i - 1] - 1.0, z0, -9.1, polesW[i] - 1.0, z1, 1.4);
      P.wire(b, this.M.wire, 9.7, polesE[i - 1], z0, 9.7, polesE[i], z1, 1.2);
      P.wire(b, this.M.wire, 9.1, polesE[i - 1] - 1.0, z0, 9.1, polesE[i] - 1.0, z1, 1.4);
    }
    // Cross-street spans: these cut across the vanishing point and give the
    // corridor its depth reading.
    for (const z of [-19, 3, 25, 41, 57]) {
      P.wire(b, this.M.wire, -9.7, 7.4, z, 9.7, 7.2, z + 0.6, 1.5, 10);
    }
    // Street lamps alternate sides.
    for (let i = 0; i < 8; i++) {
      const z = -24 + i * 11.5;
      const s = i % 2 ? 1 : -1;
      P.streetLamp(b, this.M.rust, s * 8.9, PAVE_Y, z, -s, 6.4);
    }

    // Bus wreck skewed across the near third of the street: it breaks the
    // sightline to the arch without hiding it, and forces a route choice.
    P.busWreck(b, this.M.cBlue, this.M.dark, this.M.rust, this.M.glass, -1.6, 0, 51.5, 1.42);
    this._cover(-1.6, 48.6); this._cover(-1.6, 54.4);
    // scorch under it
    b.plane(this.M.scorch, -1.6, 0.055, 51.5, 12, 6, 1.42, { collide: false });

    // Crater in the near road — the "ground" pose looks straight into it.
    this._crater(2.6, 36.5, 3.4, 0.7);

    // A second car wreck pulled onto the pavement as a firing position.
    P.carWreck(b, this.M.dark, this.M.dark, this.M.rust, 8.6, PAVE_Y, 44.0, 0.18, R);
    P.sandbags(b, this.M.bag, 7.9, PAVE_Y, 41.0, Math.PI, 3, 6);
    this._cover(8.4, 42.0);

    // Barriers and checkpoint furniture staged along the corridor.
    for (let i = 0; i < 5; i++) P.jerseyBarrier(b, this.M.conc, -6.2, 0, 26 + i * 3.5, 0.02);
    for (let i = 0; i < 4; i++) P.jerseyBarrier(b, this.M.conc, 6.2, 0, 56 + i * 3.5, -0.02);
    P.hesco(b, this.M.bag, this.M.rust, 8.2, PAVE_Y, 30.0, 5.0, 0);
    P.hesco(b, this.M.bag, this.M.rust, -8.4, PAVE_Y, 12.0, 4.0, 0);

    // Containers used as a chicane just south of the gatehouse.
    this._container(this.M.cRed, 4.4, 0, 60.5, Math.PI / 2 + 0.06);
    this._container(this.M.cBlue, -4.8, 0, 63.0, Math.PI / 2 - 0.04);
    this._cover(4.4, 58.6); this._cover(-4.8, 61.0);

    // Pavement clutter: drums, crates, tyres, pallets, chairs outside shops.
    for (let i = 0; i < 34; i++) {
      const s = R() < 0.5 ? -1 : 1;
      const x = s * (ROAD_HALF + 0.6 + R() * 3.0);
      const z = -28 + R() * 90;
      const r = R();
      if (r < 0.22) P.oilDrum(b, this.M.rust, x, PAVE_Y, z, R() * 3, R() < 0.2);
      else if (r < 0.44) P.crateStack(b, this.M.wood, x, PAVE_Y, z, R() * 3, R);
      else if (r < 0.58) P.tyre(b, this.M.dark, x, PAVE_Y, z, R() * 3, R() < 0.5);
      else if (r < 0.7) P.pallet(b, this.M.wood, x, PAVE_Y + 0.01, z, R() * 3);
      else if (r < 0.82) P.chair(b, this.M.wood, x, PAVE_Y, z, R() * 6, R() < 0.5);
      else b.box(this.M.conc, x, PAVE_Y, z, 0.5 + R() * 0.7, 0.4 + R() * 0.5, 0.5 + R() * 0.7, R() * 3);
    }

    // Rubble drifts against the kerbs and building bases — nothing in a war
    // zone meets the ground with a clean line.
    for (let i = 0; i < 420; i++) {
      const s = R() < 0.5 ? -1 : 1;
      const near = R();
      const x = near < 0.55 ? s * (ROAD_HALF + R() * 3.6) : s * (KERB + R() * 22);
      const z = -34 + R() * 152;
      const sz = 0.09 + R() * 0.34;
      b.box(this.M.concF, x, R() < 0.9 ? 0.02 : 0.0, z, sz * (1 + R()), sz * (0.4 + R() * 0.5), sz * (1 + R()),
        R() * 3, { collide: false });
    }
    // Paper, cloth scraps and shell casings catching light on the asphalt.
    for (let i = 0; i < 150; i++) {
      const x = (R() - 0.5) * 2 * (KERB - 0.4);
      const z = -30 + R() * 140;
      b.plane(this.M.cloth, x, 0.06, z, 0.18 + R() * 0.2, 0.24 + R() * 0.2, R() * 3, { collide: false });
    }
    for (let i = 0; i < 90; i++) {
      const x = (R() - 0.5) * 16, z = 30 + R() * 34;
      P.cylinder(b, this.M.gun, x, 0.05, z, 0.011, 0.05, { x: Math.PI / 2, y: R() * 3, z: 0 }, { collide: false });
    }
  }

  // =========================================================================

  _bakeCollision() {
    this.root.updateMatrixWorld(true);
    this.root.traverse((o) => {
      if (o.isMesh && !o.userData.noCollide) o.layers.enable(COLLISION_LAYER);
    });
    this.collision.layers.set(COLLISION_LAYER);

    this.collision.fromGraphNode(this.root);
  }
}
