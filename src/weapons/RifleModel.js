import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural 5.56 carbine. Built from primitives but detailed enough to read
// as a real weapon at viewmodel distance: free-float rail with slots, A2 flash
// hider, ejection port, charging handle, magwell, adjustable stock, optic.
//
// The model is authored in metres, muzzle-forward along -Z, and returned with
// named sub-objects the animation layer drives (bolt, charging handle, mag).
// ---------------------------------------------------------------------------

function mat(color, roughness, metalness, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness,
    metalness,
    envMapIntensity: 1.2,
    ...extra,
  });
}

function box(m, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  g.position.set(x, y, z);
  g.rotation.set(rx, ry, rz);
  g.castShadow = true;
  return g;
}

function cyl(m, rt, rb, h, seg, x, y, z, axis = 'z') {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  else if (axis === 'x') g.rotateZ(Math.PI / 2);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

export function buildCarbine(materials) {
  const root = new THREE.Group();
  root.name = 'Carbine';

  const steel = materials?.gunmetal || mat(0x2a2c30, 0.42, 1.0);
  const black = mat(0x1b1d20, 0.58, 0.35);
  const polymer = mat(0x232527, 0.72, 0.05);
  const darkPoly = mat(0x18191b, 0.66, 0.05);
  const anodized = mat(0x35383c, 0.34, 1.0);

  // ------------------------------- barrel ---------------------------------
  const barrel = cyl(steel, 0.0092, 0.0105, 0.40, 20, 0, 0.0, -0.30);
  root.add(barrel);

  // Flash hider with prong slots
  const fh = cyl(steel, 0.0125, 0.0125, 0.055, 16, 0, 0, -0.523);
  root.add(fh);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const slot = box(black, 0.004, 0.020, 0.030, Math.cos(a) * 0.010, Math.sin(a) * 0.010, -0.532, 0, 0, a);
    root.add(slot);
  }

  // Gas block + tube
  root.add(box(steel, 0.021, 0.024, 0.030, 0, 0.003, -0.318));
  root.add(cyl(steel, 0.0032, 0.0032, 0.24, 8, 0, 0.0155, -0.20));

  // ------------------------- free-float handguard --------------------------
  const hgLen = 0.255;
  const hgZ = -0.215;
  const hgOuter = 0.0225;
  const rail = new THREE.Group();
  // Octagonal shell built from 8 flats — cheaper and crisper than a cylinder
  // with a normal map at this scale.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const panel = box(anodized, 0.0176, 0.0045, hgLen,
      Math.cos(a) * hgOuter, Math.sin(a) * hgOuter, hgZ, 0, 0, a + Math.PI / 2);
    rail.add(panel);
    // M-LOK style cut-outs
    for (let s = 0; s < 4; s++) {
      const z = hgZ - hgLen / 2 + 0.045 + s * 0.055;
      rail.add(box(darkPoly, 0.0075, 0.0065, 0.026,
        Math.cos(a) * (hgOuter - 0.0022), Math.sin(a) * (hgOuter - 0.0022), z, 0, 0, a + Math.PI / 2));
    }
  }
  // Picatinny top rail: repeated cross-slots along the whole receiver+handguard
  const railTopY = 0.0295;
  const railStartZ = -0.345;
  const railEndZ = 0.045;
  rail.add(box(anodized, 0.021, 0.006, railEndZ - railStartZ, 0, railTopY, (railStartZ + railEndZ) / 2));
  const nSlots = Math.floor((railEndZ - railStartZ) / 0.0102);
  for (let i = 0; i < nSlots; i++) {
    const z = railStartZ + 0.006 + i * 0.0102;
    rail.add(box(black, 0.0206, 0.0044, 0.0050, 0, railTopY + 0.0030, z));
  }
  root.add(rail);

  // -------------------------- upper receiver -------------------------------
  const upper = box(anodized, 0.0295, 0.032, 0.185, 0, 0.005, -0.045);
  root.add(upper);
  // Forward assist + brass deflector
  root.add(cyl(anodized, 0.0055, 0.0055, 0.016, 10, 0.017, 0.0, 0.010, 'x'));
  root.add(box(anodized, 0.010, 0.016, 0.026, 0.0165, 0.008, 0.024));

  // Ejection port (recessed) + dust cover hinge
  root.add(box(black, 0.004, 0.017, 0.045, 0.0152, 0.004, -0.005));
  root.add(cyl(steel, 0.0022, 0.0022, 0.050, 8, 0.019, -0.006, -0.005));

  // Charging handle — animated on reload/chamber
  const charging = new THREE.Group();
  charging.name = 'chargingHandle';
  charging.add(box(anodized, 0.052, 0.0075, 0.026, 0, 0.0175, 0.060));
  charging.add(box(anodized, 0.014, 0.010, 0.030, -0.024, 0.0175, 0.058));
  root.add(charging);

  // -------------------------- lower receiver -------------------------------
  const lower = box(anodized, 0.0265, 0.030, 0.130, 0, -0.021, -0.010);
  root.add(lower);
  // Magwell flares outward toward the bottom
  root.add(box(anodized, 0.0285, 0.020, 0.050, 0, -0.040, -0.036));

  // Magazine — curved STANAG suggested with two segments
  const magGroup = new THREE.Group();
  magGroup.name = 'magazine';
  magGroup.add(box(darkPoly, 0.0225, 0.075, 0.040, 0, -0.075, -0.038, 0.10));
  magGroup.add(box(darkPoly, 0.0225, 0.070, 0.038, 0.0, -0.142, -0.024, 0.24));
  magGroup.add(box(black, 0.0235, 0.006, 0.042, 0, -0.113, -0.032, 0.10));
  root.add(magGroup);

  // Trigger guard + trigger
  root.add(box(anodized, 0.0085, 0.0055, 0.052, 0, -0.049, 0.014));
  root.add(box(anodized, 0.0085, 0.026, 0.006, 0, -0.036, 0.040));
  const trigger = box(steel, 0.005, 0.018, 0.007, 0, -0.043, 0.020, -0.15);
  trigger.name = 'trigger';
  root.add(trigger);

  // Pistol grip, raked back
  const grip = box(polymer, 0.024, 0.095, 0.036, 0, -0.075, 0.058, 0.30);
  root.add(grip);
  root.add(box(darkPoly, 0.026, 0.012, 0.034, 0, -0.118, 0.072, 0.30));

  // Safety selector
  root.add(cyl(steel, 0.006, 0.006, 0.032, 10, 0, -0.030, 0.046, 'x'));
  root.add(box(steel, 0.020, 0.006, 0.010, -0.021, -0.030, 0.042, 0, 0, 0.6));

  // ------------------------------- stock -----------------------------------
  root.add(cyl(anodized, 0.0145, 0.0145, 0.135, 14, 0, 0.004, 0.135));
  const stock = new THREE.Group();
  stock.name = 'stock';
  stock.add(box(polymer, 0.030, 0.048, 0.105, 0, 0.002, 0.155));
  stock.add(box(polymer, 0.034, 0.058, 0.020, 0, -0.004, 0.212));  // butt pad
  stock.add(box(darkPoly, 0.036, 0.062, 0.008, 0, -0.004, 0.223));
  stock.add(box(polymer, 0.026, 0.030, 0.060, 0, -0.030, 0.150));  // cheek riser underside
  root.add(stock);

  // ------------------------------- optic -----------------------------------
  const optic = new THREE.Group();
  optic.name = 'optic';
  const body = cyl(black, 0.0165, 0.0165, 0.088, 20, 0, 0.058, -0.015);
  optic.add(body);
  optic.add(cyl(black, 0.0185, 0.0185, 0.008, 20, 0, 0.058, -0.058));
  optic.add(cyl(black, 0.0185, 0.0185, 0.008, 20, 0, 0.058, 0.028));
  // Mount
  optic.add(box(black, 0.024, 0.026, 0.050, 0, 0.040, -0.015));
  optic.add(box(black, 0.030, 0.008, 0.058, 0, 0.030, -0.015));
  // Turrets
  optic.add(cyl(black, 0.0075, 0.0085, 0.014, 12, 0, 0.075, -0.015, 'y'));
  optic.add(cyl(black, 0.0075, 0.0085, 0.014, 12, 0.017, 0.058, -0.015, 'x'));

  // Lens: dark blue-violet coated glass, and a red dot that only the
  // reticle material emits so it survives tone mapping as a bright point.
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x0a1420, roughness: 0.05, metalness: 0.9,
    envMapIntensity: 2.2,
  });
  optic.add(cyl(lensMat, 0.0152, 0.0152, 0.002, 24, 0, 0.058, -0.055));
  optic.add(cyl(lensMat, 0.0152, 0.0152, 0.002, 24, 0, 0.058, 0.025));

  const dotMat = new THREE.MeshBasicMaterial({
    color: 0xff2a12, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0016, 12), dotMat);
  dot.position.set(0, 0.058, -0.052);
  dot.name = 'reticle';
  optic.add(dot);
  const glowMat = dotMat.clone();
  glowMat.opacity = 0.22;
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.005, 16), glowMat);
  glow.position.set(0, 0.058, -0.0515);
  optic.add(glow);

  root.add(optic);

  // Backup iron sights, folded
  root.add(box(black, 0.010, 0.014, 0.008, 0, 0.038, -0.300));
  root.add(box(black, 0.012, 0.012, 0.008, 0, 0.038, 0.030));

  // Sling swivel + vertical grip
  root.add(cyl(steel, 0.005, 0.005, 0.012, 8, 0.020, -0.008, -0.290, 'x'));
  const foreGrip = box(polymer, 0.024, 0.062, 0.028, 0, -0.048, -0.212, 0.12);
  foreGrip.name = 'foregrip';
  root.add(foreGrip);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // Anchors the animation layer needs.
  root.userData.muzzle = new THREE.Vector3(0, 0, -0.552);
  root.userData.ejectPort = new THREE.Vector3(0.020, 0.004, -0.005);
  root.userData.sightHeight = 0.058; // optic centre, used to align ADS
  root.userData.parts = {
    charging,
    magazine: magGroup,
    stock,
    optic,
    trigger,
    foregrip: foreGrip,
  };

  return root;
}
