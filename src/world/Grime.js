import * as THREE from 'three';

// ---------------------------------------------------------------------------
// The grime layer.
//
// Every facade in this level is a merged slab of one plaster material, and a
// merged slab holds one nearly-uniform value from pavement to parapet. Real
// architecture does not: dirt washes down below every sill, accumulates in
// recesses and at the base where rain splashes back off the ground, and the
// upper storeys bleach in the sun. That vertical value gradient is most of what
// separates a photograph of a building from an extruded box.
//
// Rather than bake it into the textures (which are shared, tiled and owned by
// another agent) or subdivide the walls enough to carry it in vertex colour on
// the walls themselves, it is a separate multiply-blended layer of quads that
// float 2 cm off the surfaces they dirty:
//
//   result = lit_surface * (map * vertexColour)
//
// A vertex colour of 1 is a no-op, so a stain fades out to nothing along the
// quad's own gradient with no per-stain alpha texture. Two triangles per stain,
// merged by chunk like everything else, no depth writes, and it multiplies the
// *lit* result, so a stain in shadow correctly does almost nothing.
// ---------------------------------------------------------------------------

/**
 * Vertical dirt-streak mask. Mostly white with darker runs down the V axis, so
 * a quad stretched down a wall reads as water having run over it repeatedly.
 */
export function streakTexture(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);

  // Long, soft vertical runs.
  let s = 0x9e3779b9;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 90; i++) {
    const x = rnd() * size;
    const w = 1 + rnd() * rnd() * 22;
    const dark = 0.10 + rnd() * 0.42;
    const grad = g.createLinearGradient(x - w, 0, x + w, 0);
    const c = Math.round(255 * (1 - dark));
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(${c},${Math.round(c * 0.97)},${Math.round(c * 0.92)},1)`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    // Runs do not reach the same depth all the way down: taper each one.
    const y0 = rnd() * size * 0.5;
    g.fillRect(x - w, y0, w * 2, size - y0 + 1);
  }
  // Fine speckle so the streaks are not perfectly smooth ramps.
  const id = g.getImageData(0, 0, size, size);
  for (let i = 0; i < id.data.length; i += 4) {
    const n = (rnd() - 0.5) * 26;
    id.data[i] = Math.max(0, Math.min(255, id.data[i] + n));
    id.data[i + 1] = Math.max(0, Math.min(255, id.data[i + 1] + n));
    id.data[i + 2] = Math.max(0, Math.min(255, id.data[i + 2] + n));
  }
  g.putImageData(id, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Low-contrast mottle for contact shading — the dark ring where a wall or a
 * wreck meets the ground, and the underside of a balcony or an awning. Flat
 * gradients read as airbrush; this keeps them dirty.
 */
export function blotchTexture(size = 128) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  let s = 0x1b873593;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < 160; i++) {
    const x = rnd() * size, y = rnd() * size, r = 3 + rnd() * 22;
    const c = Math.round(255 * (1 - (0.06 + rnd() * 0.22)));
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${c},${c},${c},1)`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The multiply layer's material. Unlit on purpose: it is an albedo modulator,
 * not a surface, so it must not pick up its own lighting or be tone-mapped —
 * it has to be a straight multiply against the already-lit, still-linear
 * framebuffer.
 */
export function grimeMaterial(name, tex) {
  const m = new THREE.MeshBasicMaterial({
    map: tex,
    vertexColors: true,
    transparent: true,
    blending: THREE.MultiplyBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  m.name = name;
  m.userData.tile = 1;
  m.userData.grime = true;
  return m;
}
