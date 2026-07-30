import * as THREE from 'three';
import {
  Batch, gBox, gChamfer, gCyl, gRod, gTube, gScrew, gSpring, gunMaterials, planarUV,
} from './GunKit.js';

// ---------------------------------------------------------------------------
// Procedural weapons. Authored in metres, muzzle-forward along -Z, bore on the
// Y=0 axis, and returned with named sub-groups the animation layer drives.
//
// Everything is chamfered and batched: see GunKit.js. Two weapons are built
// from the same kit — a 5.56 carbine and a 9 mm PDW — so the rig, the hand
// solver and the animation layer are all proven to be weapon-agnostic.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

// ------------------------------- sub-assemblies -----------------------------

/** M-LOK / KeyMod style handguard: octagonal tube with recessed slots. */
function handguard(b, M, { z0, z1, r, slots = 4, mat }) {
  const len = z1 - z0, cz = (z0 + z1) / 2;
  const wall = 0.0038;
  // Octagonal shell as one lathe-free extrusion: eight chamfered panels.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    const w = r * 0.792;
    b.add(mat, gChamfer(w, wall, len, Math.cos(a) * r, Math.sin(a) * r, cz, 0, 0, a + Math.PI / 2, 0.0009));
    // M-LOK slots are *recessed*: a darker inset panel a hair below the flat,
    // so the silhouette stays clean and thin geometry can't shimmer.
    if (i === 0 || i === 2 || i === 4 || i === 6 || i === 5 || i === 3) {
      for (let s = 0; s < slots; s++) {
        const z = z0 + len * ((s + 0.75) / (slots + 0.5));
        const d = r - wall * 0.62;
        b.add(M.steel, gChamfer(w * 0.46, 0.0016, 0.024, Math.cos(a) * d, Math.sin(a) * d, z, 0, 0, a + Math.PI / 2, 0.0004));
      }
    }
  }
  // Front and rear reinforcing collars.
  b.add(mat, gTube(r + 0.0022, r - 0.004, 0.010, 16, 0, 0, z0 + 0.006));
  b.add(M.alu, gTube(r + 0.0030, r - 0.004, 0.014, 16, 0, 0, z1 - 0.008));
  // Anti-rotation screws around the rear collar, each lying flat on its facet.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const s = gScrew(0.0019, 0, 0, 0, 'y', 0.0010);
    s.rotateZ(a - Math.PI / 2);
    s.translate(Math.cos(a) * (r + 0.0026), Math.sin(a) * (r + 0.0026), z1 - 0.008);
    b.add(M.bright, s);
  }
}

/** Picatinny rail: a base bar plus chamfered ribs with real gaps between. */
function picatinny(b, M, { z0, z1, y, w = 0.0208, pitch = 0.0102 }) {
  const len = z1 - z0;
  b.add(M.alu, gChamfer(w, 0.0042, len, 0, y, (z0 + z1) / 2, 0, 0, 0, 0.0006));
  const n = Math.max(1, Math.floor(len / pitch));
  const ribW = 0.0062;
  for (let i = 0; i < n; i++) {
    const z = z0 + pitch * 0.5 + i * pitch;
    // Trapezoidal rib: chamfered top, and deliberately shallow. A full-height
    // picatinny rib is ~3 mm proud, which at viewmodel distance is a 2-pixel
    // comb across the top of the weapon and shimmers under any camera motion.
    // Cutting the relief roughly in half keeps the read and kills the crawl.
    b.add(M.alu, gChamfer(w, 0.0018, ribW, 0, y + 0.0028, z, 0, 0, 0, 0.0007));
  }
  return y + 0.0037; // top of rail
}

/** Aimpoint-style red dot with a coated lens, a tube shadow and a hot dot. */
function redDot(M, { y, z, tube = 0.0158 }) {
  const g = new THREE.Group();
  g.name = 'optic';
  const b = new Batch();

  const len = 0.084;
  // Body: tube plus the boss for the turrets and the battery cap.
  b.add(M.opticBody, gTube(tube, tube - 0.0026, len, 24, 0, y, z));
  // The end bells must be rings, not discs. gRod lathes from radius 0, so
  // using it here plugs both ends of the sight and the player aims at an
  // opaque black disc — the one thing a red dot must never be.
  b.add(M.opticBody, gTube(tube + 0.0028, tube - 0.0026, 0.0075, 24, 0, y, z - len / 2 + 0.004));
  b.add(M.opticBody, gTube(tube + 0.0028, tube - 0.0026, 0.0075, 24, 0, y, z + len / 2 - 0.004));
  // Turret boss. This has to sit strictly BELOW the bore: a box across the
  // tube centre is invisible from outside and blacks out the bottom half of
  // the sight picture the moment the player aims.
  b.add(M.opticBody, gChamfer(0.0235, 0.0130, 0.030, 0, y - tube - 0.0052, z + 0.004, 0, 0, 0, 0.0012));
  // Turrets: elevation on top, windage on the right, both capped and knurled.
  for (const [ax, px, py] of [['y', 0, y + tube + 0.0062], ['x', tube + 0.0062, y]]) {
    b.add(M.opticBody, gRod(0.0072, 0.013, 14, px, py, z + 0.004, ax));
    b.add(M.alu, gRod(0.0058, 0.004, 14, ax === 'y' ? 0 : px + 0.008, ax === 'y' ? py + 0.008 : py, z + 0.004, ax));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const rr = 0.0072;
      if (ax === 'y') b.add(M.opticBody, gBox(0.0008, 0.013, 0.0016, Math.cos(a) * rr, py, z + 0.004 + Math.sin(a) * rr, 0, -a, 0));
    }
  }
  // Battery compartment on the left, also clear of the bore.
  b.add(M.opticBody, gRod(0.0068, 0.011, 14, -tube - 0.0055, y, z + 0.004, 'x'));
  // Mount: quick-detach throw lever clamp.
  b.add(M.opticBody, gChamfer(0.0245, 0.021, 0.044, 0, y - 0.0245, z + 0.002, 0, 0, 0, 0.0012));
  b.add(M.alu, gChamfer(0.0325, 0.0075, 0.050, 0, y - 0.0345, z + 0.002, 0, 0, 0, 0.0010));
  b.add(M.bright, gChamfer(0.0075, 0.014, 0.030, -0.0175, y - 0.030, z + 0.002, 0, 0, 0.18, 0.0008));
  b.add(M.bright, gScrew(0.0026, 0, y - 0.014, z - 0.016, 'y'));
  b.add(M.bright, gScrew(0.0026, 0, y - 0.014, z + 0.020, 'y'));
  // Killflash / sunshade ribs at the objective end.
  for (let i = 0; i < 3; i++) {
    b.add(M.opticBody, gTube(tube + 0.0012, tube - 0.0006, 0.0022, 24, 0, y, z - len / 2 - 0.004 - i * 0.006));
  }
  b.flush(g, 'optic');

  // ---- glass -------------------------------------------------------------
  // A flat tinted disc, and deliberately nothing more.
  //
  // The previous version used a near-mirror MeshPhysicalMaterial with a
  // clearcoat. A flat disc facing the camera reflects the environment probe
  // straight back at the viewer, and at roughness 0.03 that samples a high mip
  // of the PMREM cube, whose six face seams cross in the middle — which is
  // what put a four-bladed pinwheel in the centre of the sight picture.
  //
  // Glass the player has to aim through gets no environment reflection at all.
  // It is a tint, a rim sheen, and the emitter. Nothing else may live in the
  // aperture: everything there is competing with the target.
  const aperture = tube - 0.0028;
  const lensMat = new THREE.MeshBasicMaterial({
    name: 'lens',
    color: 0x22405e, transparent: true, opacity: 0.13,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
  });
  const lensGeo = new THREE.CircleGeometry(aperture, 32);
  const front = new THREE.Mesh(lensGeo, lensMat);
  front.position.set(0, y, z - len / 2 + 0.010);
  front.renderOrder = 4;
  g.add(front);
  const rear = new THREE.Mesh(lensGeo, lensMat);
  rear.position.set(0, y, z + len / 2 - 0.010);
  rear.renderOrder = 4;
  g.add(rear);

  // Coating sheen: a thin additive ring hugging the rim, which is where a real
  // AR coating actually flares. Kept outside the useful aperture so it never
  // washes the middle of the sight picture.
  const ringGeo = new THREE.RingGeometry(aperture * 0.80, aperture, 32, 1);
  {
    const c = ringGeo.attributes.position;
    const col = new Float32Array(c.count * 3);
    for (let i = 0; i < c.count; i++) {
      const r = Math.hypot(c.getX(i), c.getY(i)) / aperture;
      const k = Math.pow(THREE.MathUtils.clamp((r - 0.80) / 0.20, 0, 1), 1.5);
      col[i * 3] = 0.10 * k; col[i * 3 + 1] = 0.22 * k; col[i * 3 + 2] = 0.55 * k;
    }
    ringGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const flare = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.7,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  flare.position.set(0, y, z - len / 2 + 0.0125);
  flare.renderOrder = 5;
  g.add(flare);

  // ---- reticle -----------------------------------------------------------
  // Two additive layers only: a hard dot and a soft halo about four times its
  // radius. The colour is well above 1.0 so it survives the filmic curve and
  // trips the bloom threshold, which is what makes it read as an emitter
  // rather than a red sticker on the glass.
  const dotMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(16.0, 1.2, 0.35),
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: false, toneMapped: true,
  });
  const reticle = new THREE.Group();
  reticle.name = 'reticle';
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.00105, 20), dotMat);
  dot.position.z = 0.0012;
  reticle.add(dot);

  // Halo: vertex-coloured so it falls off smoothly instead of ending on a hard
  // circular edge, which is the giveaway on a cheap red dot.
  const haloGeo = new THREE.CircleGeometry(0.0042, 24);
  {
    const c = haloGeo.attributes.position;
    const col = new Float32Array(c.count * 3);
    for (let i = 0; i < c.count; i++) {
      const r = Math.hypot(c.getX(i), c.getY(i)) / 0.0042;
      const k = Math.pow(1 - r, 2.0);
      col[i * 3] = 2.6 * k; col[i * 3 + 1] = 0.18 * k; col[i * 3 + 2] = 0.05 * k;
    }
    haloGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const haloMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.z = 0.0008;
  reticle.add(halo);

  // The reticle floats at the *front* lens: that is what gives the parallax
  // you expect when your head moves off-axis.
  reticle.position.set(0, y, z - len / 2 + 0.011);
  reticle.renderOrder = 20;
  g.add(reticle);

  g.userData.reticle = reticle;
  g.userData.dotMat = dotMat;
  g.userData.haloMat = haloMat;
  g.userData.sightAxis = y;
  return g;
}

/** STANAG-pattern polymer magazine with a witness window and floor plate. */
function magazine(M, { curve = 0.16, len = 0.155, w = 0.0228, d = 0.040 }) {
  const g = new THREE.Group();
  g.name = 'magazine';
  const b = new Batch();
  const segs = 4;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    const a = curve * t;
    const y = -0.012 - t * len;
    const z = -0.028 + Math.sin(a) * len * 0.62;
    const dd = d * (1 - t * 0.06);
    b.add(M.poly, gChamfer(w, len / segs + 0.010, dd, 0, y, z, a, 0, 0, 0.0012));
    // Reinforcing rib on each side
    b.add(M.poly, gChamfer(w + 0.0016, 0.0035, dd * 0.78, 0, y - 0.006, z, a, 0, 0, 0.0006));
  }
  // Witness window: recessed slot showing brass.
  b.add(M.brass, gChamfer(w * 0.42, 0.030, 0.004, w * 0.5 - 0.0012, -0.075, -0.014, curve * 0.5, 0, 0, 0.0004));
  // Floor plate + base pad
  b.add(M.rubber, gChamfer(w + 0.0035, 0.014, d * 0.98, 0, -0.012 - len - 0.006, -0.028 + Math.sin(curve) * len * 0.62 + 0.004, curve, 0, 0, 0.0018));
  b.add(M.bright, gScrew(0.0018, 0, -0.012 - len - 0.013, -0.020, 'y'));
  // Top: follower and a visible round.
  b.add(M.brass, gRod(0.0028, 0.030, 10, 0, -0.006, -0.030, 'z'));
  b.add(M.bright, gChamfer(w - 0.004, 0.004, d * 0.8, 0, -0.010, -0.030, 0, 0, 0, 0.0006));
  b.flush(g, 'mag');
  return g;
}

/** Collapsible carbine stock on a buffer tube. */
function stockAssembly(M, { z0, y }) {
  const g = new THREE.Group();
  g.name = 'stock';
  const b = new Batch();
  const bodyZ = z0 + 0.058;
  // Shell around the buffer tube
  b.add(M.fde, gChamfer(0.0405, 0.049, 0.096, 0, y - 0.001, bodyZ, 0, 0, 0, 0.0022));
  // Lightening cut on both sides
  b.add(M.poly, gChamfer(0.043, 0.020, 0.052, 0, y + 0.004, bodyZ - 0.004, 0, 0, 0, 0.0016));
  // Cheek weld ridge
  b.add(M.fde, gChamfer(0.030, 0.010, 0.086, 0, y + 0.026, bodyZ, 0, 0, 0, 0.0018));
  // Sling loop cut-out and QD socket
  b.add(M.alu, gTube(0.0055, 0.0032, 0.008, 12, 0.0205, y - 0.004, bodyZ - 0.030, 'x'));
  // Adjustment lever under the tube
  b.add(M.poly, gChamfer(0.014, 0.020, 0.038, 0, y - 0.030, bodyZ + 0.008, 0.25, 0, 0, 0.0012));
  b.add(M.bright, gRod(0.0022, 0.020, 8, 0, y - 0.038, bodyZ + 0.014, 'x'));
  // Butt pad: rubber, angled, with a serrated face
  const padZ = bodyZ + 0.055;
  b.add(M.rubber, gChamfer(0.0435, 0.062, 0.016, 0, y - 0.004, padZ, -0.10, 0, 0, 0.0028));
  for (let i = 0; i < 5; i++) {
    b.add(M.rubber, gChamfer(0.0405, 0.0045, 0.006, 0, y - 0.026 + i * 0.012, padZ + 0.008, -0.10, 0, 0, 0.0008));
  }
  b.flush(g, 'stock');
  return g;
}

// ------------------------------- the carbine --------------------------------

export function buildCarbine(materials) {
  const M = gunMaterials();
  const root = new THREE.Group();
  root.name = 'Carbine';
  const b = new Batch();

  const RAIL_Y = 0.0272;      // top of the receiver flat-top
  const MUZZLE_Z = -0.556;

  // ------------------------------- barrel ---------------------------------
  b.add(M.steel, gRod(0.0094, 0.215, 18, 0, 0, -0.398));            // exposed
  b.add(M.steel, gRod(0.0112, 0.185, 18, 0, 0, -0.200));            // under rail
  b.add(M.steel, gRod(0.0132, 0.020, 18, 0, 0, -0.098));            // barrel nut
  for (let i = 0; i < 14; i++) {                                      // nut splines
    const a = (i / 14) * TAU;
    b.add(M.steel, gBox(0.0026, 0.0032, 0.018, Math.cos(a) * 0.0134, Math.sin(a) * 0.0134, -0.098, 0, 0, a));
  }

  // A2-style flash hider with five prong slots and a crush washer.
  b.add(M.steel, gRod(0.0128, 0.052, 16, 0, 0, MUZZLE_Z + 0.028));
  b.add(M.bright, gTube(0.0136, 0.0104, 0.0035, 16, 0, 0, MUZZLE_Z + 0.056));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.3;
    b.add(M.poly, gBox(0.0042, 0.010, 0.030, Math.cos(a) * 0.0098, Math.sin(a) * 0.0098, MUZZLE_Z + 0.020, 0, 0, a));
  }
  b.add(M.poly, gTube(0.0116, 0.0042, 0.004, 16, 0, 0, MUZZLE_Z + 0.003));   // bore
  b.add(M.steel, gTube(0.0090, 0.0034, 0.010, 16, 0, 0, MUZZLE_Z + 0.008));

  // Low-profile gas block + gas tube running back to the receiver.
  b.add(M.steel, gChamfer(0.0215, 0.0225, 0.030, 0, 0.0028, -0.318, 0, 0, 0, 0.0012));
  b.add(M.bright, gScrew(0.0019, 0.0108, 0.0028, -0.312, 'x'));
  b.add(M.bright, gScrew(0.0019, 0.0108, 0.0028, -0.324, 'x'));
  b.add(M.bright, gRod(0.0031, 0.230, 8, 0, 0.0152, -0.200));

  // --------------------------- handguard + rail ----------------------------
  handguard(b, M, { z0: -0.348, z1: -0.092, r: 0.0238, slots: 4, mat: M.fde });
  const railTop = picatinny(b, M, { z0: -0.352, z1: 0.052, y: RAIL_Y });

  // Angled foregrip + hand stop on the underside.
  const fgZ = -0.238;
  b.add(M.fde, gChamfer(0.0245, 0.060, 0.030, 0, -0.052, fgZ + 0.010, 0.42, 0, 0, 0.0022));
  b.add(M.rubber, gChamfer(0.0255, 0.038, 0.020, 0, -0.062, fgZ + 0.018, 0.42, 0, 0, 0.0016));
  b.add(M.alu, gChamfer(0.020, 0.010, 0.026, 0, -0.028, fgZ + 0.004, 0, 0, 0, 0.0010));
  b.add(M.bright, gScrew(0.0022, 0, -0.0245, fgZ - 0.004, 'y'));

  // Sling QD socket and a short section of webbing stub.
  b.add(M.alu, gTube(0.0055, 0.0030, 0.006, 12, 0.0232, -0.006, -0.300, 'x'));
  b.add(M.strap, gChamfer(0.0035, 0.020, 0.024, 0.0272, -0.014, -0.300, 0.2, 0, 0.3, 0.0006));

  // ---------------------------- upper receiver -----------------------------
  b.add(M.alu, gChamfer(0.0300, 0.0330, 0.176, 0, 0.0092, -0.006, 0, 0, 0, 0.0018));
  b.add(M.aluMarked, gChamfer(0.0308, 0.0225, 0.120, 0, 0.0060, -0.010, 0, 0, 0, 0.0014));
  // Forward assist and brass deflector.
  b.add(M.alu, gRod(0.0056, 0.016, 12, 0.0172, 0.0000, 0.036, 'x'));
  b.add(M.bright, gRod(0.0040, 0.005, 12, 0.0262, 0.0000, 0.036, 'x'));
  b.add(M.alu, gChamfer(0.0105, 0.017, 0.026, 0.0168, 0.0105, 0.050, 0, 0, 0, 0.0016));

  // Ejection port: a recess with a hinged dust cover held open.
  b.add(M.poly, gChamfer(0.0035, 0.0175, 0.046, 0.0152, 0.0060, 0.020, 0, 0, 0, 0.0008));
  b.add(M.bright, gChamfer(0.0030, 0.0150, 0.042, 0.0176, 0.0180, 0.020, 0.0, 0.0, -0.9, 0.0006));
  b.add(M.bright, gRod(0.0022, 0.052, 8, 0.0192, -0.0035, 0.020));
  b.add(M.bright, gSpring(0.0026, 0.010, 5, 6, 0.0192, -0.0035, 0.046));
  // Bolt face visible through the port.
  b.add(M.bright, gRod(0.0074, 0.006, 14, 0.0100, 0.0060, 0.030, 'x'));

  // Takedown / pivot pins.
  b.add(M.bright, gRod(0.0040, 0.031, 12, 0, -0.0090, -0.030, 'x'));
  b.add(M.bright, gRod(0.0040, 0.031, 12, 0, -0.0090, 0.066, 'x'));

  // Rear backup iron sight, folded flat on the rail.
  b.add(M.alu, gChamfer(0.0225, 0.0075, 0.026, 0, railTop + 0.0035, 0.030, 0, 0, 0, 0.0008));
  b.add(M.poly, gChamfer(0.0130, 0.0055, 0.018, 0, railTop + 0.0080, 0.030, 0, 0, 0, 0.0006));
  // Front sight, also folded.
  b.add(M.alu, gChamfer(0.0225, 0.0075, 0.022, 0, railTop + 0.0035, -0.330, 0, 0, 0, 0.0008));
  b.add(M.poly, gChamfer(0.0100, 0.0050, 0.016, 0, railTop + 0.0078, -0.330, 0, 0, 0, 0.0006));

  // ---------------------------- lower receiver -----------------------------
  b.add(M.alu, gChamfer(0.0268, 0.0300, 0.132, 0, -0.0165, 0.006, 0, 0, 0, 0.0018));
  // Magwell, flaring outward with a bevelled mouth.
  b.add(M.alu, gChamfer(0.0300, 0.0225, 0.052, 0, -0.0345, -0.026, 0, 0, 0, 0.0022));
  b.add(M.poly, gChamfer(0.0250, 0.0090, 0.043, 0, -0.0400, -0.026, 0, 0, 0, 0.0012));
  // Mag release button and its fence.
  b.add(M.alu, gRod(0.0052, 0.010, 12, 0.0142, -0.0150, -0.008, 'x'));
  b.add(M.bright, gRod(0.0036, 0.004, 12, 0.0195, -0.0150, -0.008, 'x'));
  // Bolt catch on the left.
  b.add(M.alu, gChamfer(0.0060, 0.0105, 0.036, -0.0150, -0.0130, -0.004, 0, 0, 0, 0.0008));
  b.add(M.bright, gRod(0.0026, 0.008, 10, -0.0175, -0.0130, 0.010, 'x'));

  // Trigger guard: a proper loop rather than a bar.
  b.add(M.alu, gChamfer(0.0088, 0.0058, 0.056, 0, -0.0455, 0.0440, 0, 0, 0, 0.0012));
  b.add(M.alu, gChamfer(0.0088, 0.0260, 0.0068, 0, -0.0340, 0.0182, -0.22, 0, 0, 0.0012));
  b.add(M.alu, gChamfer(0.0088, 0.0110, 0.0090, 0, -0.0248, 0.0225, -0.55, 0, 0, 0.0010));

  // Safety selector with a detent and the two-position lever.
  b.add(M.alu, gRod(0.0058, 0.0300, 12, 0, -0.0240, 0.0520, 'x'));
  b.add(M.alu, gChamfer(0.0190, 0.0062, 0.0110, -0.0210, -0.0270, 0.0470, 0, 0, 0.55, 0.0009));
  b.add(M.alu, gChamfer(0.0190, 0.0062, 0.0110, 0.0210, -0.0270, 0.0470, 0, 0, -0.55, 0.0009));

  // Pistol grip: polymer core, rubber side panels, palm swell, storage cap.
  const gripR = 0.30, gx = 0, gy = -0.0715, gz = 0.0660;
  b.add(M.fde, gChamfer(0.0248, 0.0930, 0.0360, gx, gy, gz, gripR, 0, 0, 0.0030));
  b.add(M.rubber, gChamfer(0.0272, 0.0640, 0.0230, gx, gy - 0.004, gz - 0.0035, gripR, 0, 0, 0.0022));
  b.add(M.fde, gChamfer(0.0262, 0.0180, 0.0330, gx, gy + 0.0430, gz - 0.0130, gripR, 0, 0, 0.0022));  // beavertail
  b.add(M.poly, gChamfer(0.0268, 0.0110, 0.0350, gx, gy - 0.0480, gz + 0.0148, gripR, 0, 0, 0.0024)); // butt cap
  b.add(M.bright, gScrew(0.0022, gx, gy - 0.0530, gz + 0.0165, 'y'));

  // ------------------------------- buffer ----------------------------------
  b.add(M.alu, gRod(0.0152, 0.140, 16, 0, 0.0035, 0.145));
  for (let i = 0; i < 6; i++) {  // castle-nut style notches at the receiver end
    const a = (i / 6) * TAU;
    b.add(M.alu, gBox(0.0030, 0.0035, 0.010, Math.cos(a) * 0.0165, 0.0035 + Math.sin(a) * 0.0165, 0.082, 0, 0, a));
  }
  for (let i = 0; i < 6; i++) {  // stock adjustment detent holes underneath
    b.add(M.poly, gChamfer(0.0060, 0.0035, 0.0060, 0, -0.0115, 0.100 + i * 0.017, 0, 0, 0, 0.0006));
  }
  b.add(M.alu, gTube(0.0170, 0.0140, 0.0100, 16, 0, 0.0035, 0.081));

  b.flush(root, 'carbine');

  // --------------------------- animated sub-groups -------------------------
  // Charging handle (latch + shaft) rides on its own node.
  const charging = new THREE.Group();
  charging.name = 'chargingHandle';
  {
    const cb = new Batch();
    cb.add(M.alu, gChamfer(0.0540, 0.0080, 0.0250, 0, 0.0212, 0.0755, 0, 0, 0, 0.0010));
    cb.add(M.alu, gChamfer(0.0150, 0.0105, 0.0300, -0.0250, 0.0212, 0.0740, 0, 0, 0, 0.0012));
    cb.add(M.poly, gChamfer(0.0060, 0.0075, 0.0180, -0.0290, 0.0212, 0.0720, 0, 0, 0, 0.0008));
    cb.add(M.alu, gChamfer(0.0200, 0.0060, 0.0620, 0, 0.0212, 0.0400, 0, 0, 0, 0.0008));
    cb.add(M.bright, gScrew(0.0018, -0.0200, 0.0252, 0.0755, 'y'));
    cb.flush(charging, 'ch');
  }
  root.add(charging);

  const trigger = new THREE.Group();
  trigger.name = 'trigger';
  {
    const tb = new Batch();
    tb.add(M.bright, gChamfer(0.0052, 0.0195, 0.0075, 0, -0.0300, 0.0355, 0, 0, 0, 0.0008));
    tb.add(M.bright, gChamfer(0.0052, 0.0060, 0.0110, 0, -0.0385, 0.0330, -0.30, 0, 0, 0.0008));
    tb.flush(trigger, 'tr');
  }
  trigger.position.set(0, -0.0140, 0.0130);   // pivot
  trigger.children[0].position.set(0, 0.0140, -0.0130);
  root.add(trigger);

  const mag = magazine(M, { len: 0.140 });
  mag.position.set(0, -0.0360, -0.0100);
  root.add(mag);

  const stock = stockAssembly(M, { z0: 0.140, y: 0.0035 });
  root.add(stock);

  const optic = redDot(M, { y: RAIL_Y + 0.0037 + 0.0245, z: -0.030 });
  root.add(optic);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  root.userData.muzzle = new THREE.Vector3(0, 0, MUZZLE_Z);
  root.userData.ejectPort = new THREE.Vector3(0.021, 0.006, 0.020);
  root.userData.sightHeight = optic.userData.sightAxis;
  root.userData.sightZ = -0.030;
  root.userData.parts = {
    charging, magazine: mag, stock, optic, trigger,
    reticle: optic.userData.reticle,
    dotMat: optic.userData.dotMat,
    haloMat: optic.userData.haloMat,
  };
  // Where the hands go. Solved once here so Hands.js stays weapon-agnostic.
  root.userData.grips = {
    trigger: { pos: new THREE.Vector3(0.0, -0.0580, 0.0620), rake: gripR, radius: 0.0135 },
    support: { pos: new THREE.Vector3(0.0, 0.0000, -0.2320), rake: 0.10, radius: 0.0245 },
    magwell: new THREE.Vector3(0.0, -0.055, -0.026),
    charging: new THREE.Vector3(-0.030, 0.0212, 0.0740),
  };
  return root;
}

// -------------------------------- the PDW -----------------------------------

/** Compact 9 mm PDW: proves the kit, the hands and the anim layer generalise. */
export function buildPDW() {
  const M = gunMaterials();
  const root = new THREE.Group();
  root.name = 'PDW';
  const b = new Batch();

  const RAIL_Y = 0.0250;
  const MUZZLE_Z = -0.372;

  // Barrel + compensator
  b.add(M.steel, gRod(0.0088, 0.120, 16, 0, 0, -0.290));
  b.add(M.steel, gRod(0.0135, 0.046, 14, 0, 0, MUZZLE_Z + 0.024));
  for (let i = 0; i < 4; i++) {
    b.add(M.poly, gBox(0.0055, 0.0110, 0.0055, 0, 0.0092, MUZZLE_Z + 0.010 + i * 0.010));
  }
  b.add(M.poly, gTube(0.0122, 0.0050, 0.004, 16, 0, 0, MUZZLE_Z + 0.003));

  // Slim polymer handguard with a top rail
  handguard(b, M, { z0: -0.300, z1: -0.098, r: 0.0212, slots: 3, mat: M.poly });
  const railTop = picatinny(b, M, { z0: -0.306, z1: 0.040, y: RAIL_Y });

  // Monolithic upper: a squarer, more modern receiver than the carbine.
  b.add(M.alu, gChamfer(0.0330, 0.0360, 0.170, 0, 0.0060, -0.010, 0, 0, 0, 0.0022));
  b.add(M.aluMarked, gChamfer(0.0338, 0.0200, 0.110, 0, 0.0040, -0.012, 0, 0, 0, 0.0014));
  b.add(M.poly, gChamfer(0.0040, 0.0170, 0.040, 0.0170, 0.0060, 0.024, 0, 0, 0, 0.0008));
  b.add(M.bright, gRod(0.0072, 0.006, 14, 0.0120, 0.0060, 0.030, 'x'));

  // Lower with an integral magwell in the grip (9 mm layout)
  b.add(M.poly, gChamfer(0.0300, 0.0290, 0.120, 0, -0.0190, 0.010, 0, 0, 0, 0.0022));
  b.add(M.poly, gChamfer(0.0310, 0.0980, 0.0420, 0, -0.0790, 0.0470, 0.16, 0, 0, 0.0030));
  b.add(M.rubber, gChamfer(0.0330, 0.0620, 0.0250, 0, -0.0820, 0.0330, 0.16, 0, 0, 0.0022));
  b.add(M.poly, gChamfer(0.0330, 0.0130, 0.0450, 0, -0.0330, 0.0430, 0.16, 0, 0, 0.0026));
  b.add(M.alu, gChamfer(0.0092, 0.0058, 0.036, 0, -0.0470, 0.0080, 0, 0, 0, 0.0012));
  b.add(M.alu, gChamfer(0.0092, 0.0250, 0.0062, 0, -0.0350, -0.0080, -0.16, 0, 0, 0.0012));

  // Folding stock
  b.add(M.alu, gChamfer(0.0180, 0.0180, 0.070, 0, 0.0060, 0.115, 0, 0, 0, 0.0016));
  b.add(M.poly, gChamfer(0.0400, 0.0480, 0.060, 0, 0.0020, 0.170, 0, 0, 0, 0.0026));
  b.add(M.rubber, gChamfer(0.0420, 0.0580, 0.014, 0, 0.0000, 0.204, -0.08, 0, 0, 0.0028));

  b.flush(root, 'pdw');

  const charging = new THREE.Group();
  charging.name = 'chargingHandle';
  {
    const cb = new Batch();
    cb.add(M.alu, gChamfer(0.0120, 0.0090, 0.0280, -0.0195, 0.0180, 0.0300, 0, 0, 0, 0.0010));
    cb.add(M.alu, gChamfer(0.0250, 0.0060, 0.0140, -0.0110, 0.0180, 0.0300, 0, 0, 0, 0.0008));
    cb.flush(charging, 'ch');
  }
  root.add(charging);

  const trigger = new THREE.Group();
  trigger.name = 'trigger';
  {
    const tb = new Batch();
    tb.add(M.bright, gChamfer(0.0052, 0.0185, 0.0075, 0, -0.0110, -0.0035, 0, 0, 0, 0.0008));
    tb.flush(trigger, 'tr');
  }
  trigger.position.set(0, -0.0260, 0.0165);
  root.add(trigger);

  const mag = magazine(M, { curve: 0.02, len: 0.115, w: 0.0192, d: 0.030 });
  mag.position.set(0, -0.0230, 0.0470);
  mag.rotation.x = 0.16;
  root.add(mag);

  const optic = redDot(M, { y: RAIL_Y + 0.0037 + 0.0225, z: -0.040, tube: 0.0148 });
  root.add(optic);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  root.userData.muzzle = new THREE.Vector3(0, 0, MUZZLE_Z);
  root.userData.ejectPort = new THREE.Vector3(0.021, 0.006, 0.024);
  root.userData.sightHeight = optic.userData.sightAxis;
  root.userData.sightZ = -0.040;
  root.userData.parts = {
    charging, magazine: mag, stock: null, optic, trigger,
    reticle: optic.userData.reticle,
    dotMat: optic.userData.dotMat,
    haloMat: optic.userData.haloMat,
  };
  root.userData.grips = {
    trigger: { pos: new THREE.Vector3(0.0, -0.0620, 0.0450), rake: 0.16, radius: 0.0155 },
    support: { pos: new THREE.Vector3(0.0, 0.0000, -0.2000), rake: 0.08, radius: 0.0215 },
    magwell: new THREE.Vector3(0.0, -0.045, 0.047),
    charging: new THREE.Vector3(-0.024, 0.0180, 0.0300),
  };
  return root;
}

export const WEAPON_BUILDERS = {
  carbine: buildCarbine,
  pdw: buildPDW,
};
