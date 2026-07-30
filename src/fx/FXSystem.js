import * as THREE from 'three';
import { settings } from '../core/Settings.js';

// ---------------------------------------------------------------------------
// Combat visual effects. Everything is pooled and drawn from a small number of
// persistent buffer geometries — allocating per shot would stutter badly at
// 780 rounds per minute.
//
//   MuzzleFlash  additive card + point light, 2-frame life
//   Tracers      stretched billboards travelling at bullet speed
//   Impacts      spark burst + smoke puff + surface-tinted debris
//   Decals       bullet holes projected onto hit geometry
//   Shells       rigid-body brass with bounce
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------ GPU particles ------------------------------

const PARTICLE_VERT = /* glsl */`
  attribute vec3 aVel;
  attribute vec4 aParams;   // x: birth, y: life, z: size, w: drag
  attribute vec4 aColor;
  uniform float uTime;
  uniform float uGravity;
  uniform float uPixelScale;
  varying vec4 vColor;
  varying float vAge;

  void main() {
    float age = (uTime - aParams.x) / aParams.y;
    vAge = age;
    if (age < 0.0 || age > 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);  // cull off-screen
      gl_PointSize = 0.0;
      vColor = vec4(0.0);
      return;
    }
    float t = age * aParams.y;
    // Closed-form integration of velocity with linear drag + gravity.
    float k = aParams.w;
    float decay = (1.0 - exp(-k * t)) / max(k, 1e-4);
    vec3 pos = position + aVel * decay + vec3(0.0, -0.5 * uGravity * t * t, 0.0);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aParams.z * uPixelScale / max(-mv.z, 0.05);
    vColor = aColor;
  }
`;

const PARTICLE_FRAG = /* glsl */`
  varying vec4 vColor;
  varying float vAge;
  uniform int uMode;   // 0 = spark (hot core), 1 = smoke (soft)

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p) * 2.0;
    if (r > 1.0) discard;

    float alpha;
    vec3 col = vColor.rgb;
    if (uMode == 0) {
      // Sparks cool from white-hot to ember red as they age.
      float core = 1.0 - smoothstep(0.0, 0.85, r);
      col = mix(col, vec3(1.0, 0.85, 0.55), (1.0 - vAge) * core * 0.9);
      alpha = core * (1.0 - vAge * vAge);
    } else {
      float soft = pow(1.0 - r, 1.6);
      alpha = soft * (1.0 - vAge) * 0.55;
      col *= 0.85 + 0.3 * (1.0 - vAge);
    }
    gl_FragColor = vec4(col, alpha * vColor.a);
  }
`;

class ParticlePool {
  constructor(capacity, mode, blending) {
    this.capacity = capacity;
    this.cursor = 0;
    this.mode = mode;

    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    this.color = new Float32Array(capacity * 4);
    // Park everything in the past so nothing is alive at frame zero.
    for (let i = 0; i < capacity; i++) this.params[i * 4 + 1] = 1;

    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aParams', new THREE.BufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uGravity: { value: mode === 0 ? 9.0 : -0.6 },  // smoke rises
        uPixelScale: { value: 600 },
        uMode: { value: mode },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.geo = geo;
  }

  spawn(p, v, life, size, color, drag, time) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.params[i * 4] = time;
    this.params[i * 4 + 1] = life;
    this.params[i * 4 + 2] = size;
    this.params[i * 4 + 3] = drag;
    this.color[i * 4] = color.r; this.color[i * 4 + 1] = color.g;
    this.color[i * 4 + 2] = color.b; this.color[i * 4 + 3] = color.a ?? 1;
    this._dirty = true;
  }

  update(time) {
    this.material.uniforms.uTime.value = time;
    if (this._dirty) {
      for (const name of ['position', 'aVel', 'aParams', 'aColor']) {
        this.geo.getAttribute(name).needsUpdate = true;
      }
      this._dirty = false;
    }
  }

  setPixelScale(heightPx, fovDeg) {
    this.material.uniforms.uPixelScale.value =
      heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }
}

// -------------------------------- tracers ----------------------------------

class TracerPool {
  constructor(capacity = 96) {
    this.capacity = capacity;
    this.cursor = 0;
    this.live = [];

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0); // pivot at the tail so scale.y stretches forward
    this.material = new THREE.MeshBasicMaterial({
      color: 0xffcf7a,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = capacity;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this._hidden);
    this.slots = new Array(capacity).fill(null);
  }

  spawn(origin, dir, speed, maxDist) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.slots[i] = {
      pos: origin.clone(),
      dir: dir.clone().normalize(),
      travelled: 0,
      speed,
      maxDist,
    };
  }

  update(dt, camera) {
    let dirty = false;
    for (let i = 0; i < this.capacity; i++) {
      const t = this.slots[i];
      if (!t) continue;
      dirty = true;
      t.travelled += t.speed * dt;
      if (t.travelled >= t.maxDist) {
        this.slots[i] = null;
        this.mesh.setMatrixAt(i, this._hidden);
        continue;
      }
      t.pos.addScaledVector(t.dir, t.speed * dt);

      // Billboard the quad about the tracer's own axis so it always faces
      // the camera edge-on — a flat card would vanish when viewed along it.
      const toCam = this._s.copy(camera.position).sub(t.pos);
      const right = new THREE.Vector3().crossVectors(t.dir, toCam).normalize();
      const up = t.dir;
      const fwd = new THREE.Vector3().crossVectors(right, up).normalize();
      const basis = new THREE.Matrix4().makeBasis(right, up, fwd);
      this._q.setFromRotationMatrix(basis);

      // Fade in over the first few metres so it doesn't pop at the muzzle.
      const len = Math.min(3.2, t.travelled * 1.6);
      this._m.compose(t.pos, this._q, this._s.set(0.045, len, 1));
      this.mesh.setMatrixAt(i, this._m);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// -------------------------------- decals -----------------------------------

class DecalPool {
  constructor(capacity) {
    this.capacity = capacity;
    this.cursor = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.MeshBasicMaterial({
      map: makeBulletHoleTexture(128),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      opacity: 0.92,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this._hidden);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 0, 1);
  }

  place(point, normal, size = 0.09) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this._q.setFromUnitVectors(this._up, normal);
    // Random roll stops repeated holes from looking stamped.
    const roll = new THREE.Quaternion().setFromAxisAngle(normal, Math.random() * Math.PI * 2);
    this._q.premultiply(roll);
    const offset = new THREE.Vector3().copy(point).addScaledVector(normal, 0.006);
    const s = size * (0.75 + Math.random() * 0.5);
    this._m.compose(offset, this._q, new THREE.Vector3(s, s, s));
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

function makeBulletHoleTexture(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const cx = size / 2;

  // Dust ring
  const ring = g.createRadialGradient(cx, cx, size * 0.10, cx, cx, size * 0.48);
  ring.addColorStop(0, 'rgba(30,26,22,0.85)');
  ring.addColorStop(0.45, 'rgba(60,54,48,0.42)');
  ring.addColorStop(1, 'rgba(90,84,78,0)');
  g.fillStyle = ring;
  g.fillRect(0, 0, size, size);

  // Crater — irregular polygon, not a circle
  g.fillStyle = 'rgba(10,9,8,0.96)';
  g.beginPath();
  const n = 11;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = size * (0.10 + Math.random() * 0.045);
    const x = cx + Math.cos(a) * r, y = cx + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();

  // Radial cracks
  g.strokeStyle = 'rgba(24,20,17,0.55)';
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2;
    const len = size * (0.14 + Math.random() * 0.20);
    g.lineWidth = 0.6 + Math.random() * 1.4;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * size * 0.10, cx + Math.sin(a) * size * 0.10);
    g.lineTo(cx + Math.cos(a) * len, cx + Math.sin(a) * len);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ------------------------------ main system --------------------------------

export class FXSystem {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.time = 0;
    this.group = new THREE.Group();
    this.group.name = 'FX';
    engine.scene.add(this.group);

    const budget = settings.particleBudget;
    this.sparks = new ParticlePool(budget, 0, THREE.AdditiveBlending);
    this.smoke = new ParticlePool(Math.floor(budget * 0.6), 1, THREE.NormalBlending);
    this.tracers = new TracerPool(96);
    this.decals = new DecalPool(settings.decalBudget);

    this.group.add(this.sparks.points, this.smoke.points, this.tracers.mesh, this.decals.mesh);

    // Muzzle flash lives in the viewmodel scene so it lights the weapon.
    this.muzzleLight = new THREE.PointLight(0xffb765, 0, 3.5, 2);
    engine.viewmodel.scene.add(this.muzzleLight);
    this.muzzleFlash = this._buildMuzzleFlash();
    engine.viewmodel.scene.add(this.muzzleFlash);
    this.flashTime = -1;

    // A second light in the world so the flash also lights the environment.
    this.worldFlash = new THREE.PointLight(0xffb765, 0, 14, 2);
    engine.scene.add(this.worldFlash);

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._c = { r: 1, g: 1, b: 1, a: 1 };
  }

  _buildMuzzleFlash() {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      map: makeFlashTexture(128),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      color: 0xffd9a0,
    });
    // Two crossed cards plus a forward-facing star.
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), mat);
      m.rotation.z = i * Math.PI / 2;
      m.rotation.y = Math.PI / 2;
      g.add(m);
    }
    const star = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.30), mat);
    g.add(star);
    g.visible = false;
    g.renderOrder = 10;
    return g;
  }

  /** Fired once per shot. `muzzleLocal` is in viewmodel space. */
  onFire(muzzleLocal, worldOrigin, worldDir, isTracer) {
    this.flashTime = this.time;
    this.muzzleFlash.position.copy(muzzleLocal);
    this.muzzleFlash.rotation.z = Math.random() * Math.PI * 2;
    const scale = 0.85 + Math.random() * 0.5;
    this.muzzleFlash.scale.setScalar(scale);
    this.muzzleFlash.visible = true;
    this.muzzleLight.position.copy(muzzleLocal);
    this.muzzleLight.intensity = 9 * scale;

    this.worldFlash.position.copy(worldOrigin).addScaledVector(worldDir, 0.6);
    this.worldFlash.intensity = 26 * scale;

    if (isTracer) {
      this.tracers.spawn(
        this._v.copy(worldOrigin).addScaledVector(worldDir, 0.55),
        worldDir, 340, 200,
      );
    }

    // Muzzle smoke and unburnt powder.
    for (let i = 0; i < 4; i++) {
      const p = this._v.copy(worldOrigin).addScaledVector(worldDir, 0.5 + Math.random() * 0.3);
      const v = this._v2.copy(worldDir).multiplyScalar(2.4 + Math.random() * 2.5);
      v.x += (Math.random() - 0.5) * 1.1;
      v.y += (Math.random() - 0.5) * 1.1 + 0.3;
      v.z += (Math.random() - 0.5) * 1.1;
      this._c.r = 0.55; this._c.g = 0.53; this._c.b = 0.50; this._c.a = 0.32;
      this.smoke.spawn(p, v, 0.55 + Math.random() * 0.5, 26 + Math.random() * 22, this._c, 3.2, this.time);
    }
    for (let i = 0; i < 5; i++) {
      const p = this._v.copy(worldOrigin).addScaledVector(worldDir, 0.5);
      const v = this._v2.copy(worldDir).multiplyScalar(6 + Math.random() * 9);
      v.x += (Math.random() - 0.5) * 3.4;
      v.y += (Math.random() - 0.5) * 3.4;
      v.z += (Math.random() - 0.5) * 3.4;
      this._c.r = 1.0; this._c.g = 0.62; this._c.b = 0.22; this._c.a = 1;
      this.sparks.spawn(p, v, 0.10 + Math.random() * 0.10, 5 + Math.random() * 4, this._c, 7, this.time);
    }
  }

  /** Fired once per bullet impact. */
  onImpact(point, normal, material = 'concrete') {
    this.decals.place(point, normal, material === 'metal' ? 0.06 : 0.10);

    const tint = IMPACT_TINT[material] || IMPACT_TINT.concrete;

    // Spark cone about the surface normal, biased along the reflection.
    const sparkCount = material === 'metal' ? 16 : 7;
    for (let i = 0; i < sparkCount; i++) {
      const v = this._v2.copy(normal).multiplyScalar(2.5 + Math.random() * 5);
      v.x += (Math.random() - 0.5) * 7;
      v.y += (Math.random() - 0.5) * 7;
      v.z += (Math.random() - 0.5) * 7;
      this._c.r = 1.0; this._c.g = 0.70; this._c.b = 0.30; this._c.a = 1;
      this.sparks.spawn(point, v, 0.18 + Math.random() * 0.30, 3.5 + Math.random() * 3.5, this._c, 5, this.time);
    }

    // Dust puff tinted by the surface.
    for (let i = 0; i < 6; i++) {
      const v = this._v2.copy(normal).multiplyScalar(1.2 + Math.random() * 2.2);
      v.x += (Math.random() - 0.5) * 2.4;
      v.y += (Math.random() - 0.5) * 2.0 + 0.5;
      v.z += (Math.random() - 0.5) * 2.4;
      this._c.r = tint[0]; this._c.g = tint[1]; this._c.b = tint[2]; this._c.a = 0.42;
      this.smoke.spawn(point, v, 0.7 + Math.random() * 0.8, 22 + Math.random() * 34, this._c, 2.6, this.time);
    }

    // Heavier debris chips that arc and fall.
    for (let i = 0; i < 4; i++) {
      const v = this._v2.copy(normal).multiplyScalar(2 + Math.random() * 3);
      v.x += (Math.random() - 0.5) * 4;
      v.y += (Math.random() - 0.5) * 3 + 1.5;
      v.z += (Math.random() - 0.5) * 4;
      this._c.r = tint[0] * 0.75; this._c.g = tint[1] * 0.75; this._c.b = tint[2] * 0.75; this._c.a = 0.9;
      this.smoke.spawn(point, v, 0.9 + Math.random(), 5 + Math.random() * 5, this._c, 0.8, this.time);
    }
  }

  update(dt, camera) {
    this.time += dt;

    // Muzzle flash is two frames of screen time — any longer reads as a lamp.
    const age = this.time - this.flashTime;
    if (this.flashTime >= 0 && age < 0.045) {
      const k = 1 - age / 0.045;
      this.muzzleFlash.visible = true;
      this.muzzleLight.intensity = 9 * k;
      this.worldFlash.intensity = 26 * k;
      this.engine.postfx?.setFlash(k * 0.028);
    } else if (this.muzzleFlash.visible) {
      this.muzzleFlash.visible = false;
      this.muzzleLight.intensity = 0;
      this.worldFlash.intensity = 0;
      this.engine.postfx?.setFlash(0);
    }

    this.sparks.update(this.time);
    this.smoke.update(this.time);
    this.tracers.update(dt, camera);
  }

  /** Point sprites are sized in world units; rescale when the viewport changes. */
  setSize(w, h, fov) {
    this.sparks.setPixelScale(h, fov);
    this.smoke.setPixelScale(h, fov);
  }
}

const IMPACT_TINT = {
  concrete: [0.72, 0.70, 0.66],
  sand:     [0.74, 0.64, 0.46],
  metal:    [0.62, 0.63, 0.66],
  wood:     [0.52, 0.40, 0.26],
  flesh:    [0.55, 0.06, 0.06],
};

function makeFlashTexture(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2;
  g.clearRect(0, 0, size, size);

  const core = g.createRadialGradient(cx, cx, 0, cx, cx, size * 0.30);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.35, 'rgba(255,226,160,0.85)');
  core.addColorStop(1, 'rgba(255,150,40,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, size, size);

  // Irregular petals so the flash has a shape rather than being a blob.
  g.globalCompositeOperation = 'lighter';
  const petals = 6;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2 + Math.random() * 0.4;
    const len = size * (0.22 + Math.random() * 0.24);
    const w = size * (0.03 + Math.random() * 0.05);
    g.save();
    g.translate(cx, cx);
    g.rotate(a);
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,240,200,0.9)');
    grad.addColorStop(1, 'rgba(255,140,30,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -w);
    g.lineTo(len, 0);
    g.lineTo(0, w);
    g.closePath();
    g.fill();
    g.restore();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
