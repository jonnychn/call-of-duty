import * as THREE from 'three';
import { COLLISION_LAYER } from '../world/Level.js';

// ---------------------------------------------------------------------------
// Hostile combatant: a procedurally-built humanoid with a simple articulated
// skeleton, a hit-zone hierarchy (head / torso / limbs), and a behaviour
// state machine — idle, alert, engage, reposition, suppressed, dead.
// ---------------------------------------------------------------------------

export const STATE = {
  IDLE: 'idle',
  ALERT: 'alert',
  ENGAGE: 'engage',
  REPOSITION: 'reposition',
  SUPPRESSED: 'suppressed',
  DEAD: 'dead',
};

const HEAD_MULT = 2.4;
const LIMB_MULT = 0.72;

function m(color, rough = 0.85, metal = 0.0) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

/** Builds a blocky but correctly-proportioned soldier with named hit zones. */
function buildSoldier() {
  const root = new THREE.Group();
  const fatigues = m(0x4a4a3a, 0.92);
  const vest = m(0x2e2f28, 0.78);
  const skin = m(0x8a6a52, 0.74);
  const boots = m(0x1c1a18, 0.68);
  const helmetMat = m(0x33352c, 0.62, 0.1);

  const part = (mat, w, h, d, x, y, z, zone) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.zone = zone;
    return mesh;
  };

  // Hips are the animation root; everything hangs off it.
  const hips = new THREE.Group();
  hips.position.y = 0.94;
  root.add(hips);

  const torso = part(vest, 0.44, 0.56, 0.26, 0, 0.28, 0, 'torso');
  hips.add(torso);
  hips.add(part(fatigues, 0.40, 0.18, 0.24, 0, -0.04, 0, 'torso'));
  // Plate carrier bulk + pouches
  hips.add(part(m(0x24251f, 0.7), 0.40, 0.34, 0.10, 0, 0.32, 0.16, 'torso'));
  for (let i = -1; i <= 1; i++) {
    hips.add(part(m(0x3a3b31, 0.85), 0.11, 0.13, 0.07, i * 0.13, 0.14, 0.17, 'torso'));
  }

  const neck = new THREE.Group();
  neck.position.set(0, 0.58, 0);
  torso.add(neck);
  const head = part(skin, 0.19, 0.23, 0.21, 0, 0.11, 0, 'head');
  neck.add(head);
  neck.add(part(helmetMat, 0.23, 0.13, 0.25, 0, 0.19, -0.005, 'head'));
  neck.add(part(m(0x14161a, 0.3, 0.6), 0.20, 0.06, 0.03, 0, 0.16, 0.11, 'head')); // NVG mount / visor

  const arm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.27, 0.46, 0);
    torso.add(shoulder);
    shoulder.add(part(fatigues, 0.13, 0.30, 0.14, 0, -0.14, 0, 'limb'));
    const elbow = new THREE.Group();
    elbow.position.y = -0.29;
    shoulder.add(elbow);
    elbow.add(part(fatigues, 0.115, 0.28, 0.12, 0, -0.13, 0, 'limb'));
    elbow.add(part(m(0x222218, 0.8), 0.10, 0.09, 0.11, 0, -0.29, 0.02, 'limb'));
    return { shoulder, elbow };
  };

  const leg = (side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.12, -0.10, 0);
    hips.add(hip);
    hip.add(part(fatigues, 0.17, 0.40, 0.18, 0, -0.20, 0, 'limb'));
    const knee = new THREE.Group();
    knee.position.y = -0.41;
    hip.add(knee);
    knee.add(part(fatigues, 0.15, 0.38, 0.16, 0, -0.19, 0, 'limb'));
    knee.add(part(boots, 0.16, 0.11, 0.25, 0, -0.40, 0.04, 'limb'));
    return { hip, knee };
  };

  const leftArm = arm(-1), rightArm = arm(1);
  const leftLeg = leg(-1), rightLeg = leg(1);

  // Rifle held across the chest, parented to the right hand.
  const rifle = new THREE.Group();
  rifle.add(part(m(0x22242a, 0.5, 0.7), 0.05, 0.07, 0.62, 0, 0, -0.16, 'gear'));
  rifle.add(part(m(0x1a1c20, 0.6, 0.3), 0.045, 0.16, 0.09, 0, -0.11, 0.02, 'gear'));
  rifle.position.set(0, -0.30, 0.06);
  rifle.rotation.set(0, 0, 0);
  rightArm.elbow.add(rifle);

  root.userData.rig = { hips, torso, neck, head, leftArm, rightArm, leftLeg, rightLeg, rifle };
  root.userData.muzzle = new THREE.Object3D();
  root.userData.muzzle.position.set(0, 0, -0.48);
  rifle.add(root.userData.muzzle);

  return root;
}

export class Enemy {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine, position) {
    this.engine = engine;
    this.mesh = buildSoldier();
    this.mesh.position.copy(position);
    this.rig = this.mesh.userData.rig;
    engine.scene.add(this.mesh);

    this.health = 100;
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.velocity = new THREE.Vector3();
    this.target = null;
    this.aimAt = new THREE.Vector3();
    this.lastSeen = null;
    this.seesPlayer = false;
    this.nextShot = 0;
    this.burstLeft = 0;
    this.destination = null;
    this.walkPhase = Math.random() * 10;
    this.accuracy = 0.55;
    this.reactionTime = 0.28 + Math.random() * 0.35;
    this.alertness = 0;
    this.ragdoll = null;

    this._ray = new THREE.Raycaster();
    this._ray.layers.set(COLLISION_LAYER);
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  get alive() { return this.state !== STATE.DEAD; }

  /** @returns {number} damage actually applied */
  applyHit(zone, baseDamage, direction) {
    if (!this.alive) return 0;
    const mult = zone === 'head' ? HEAD_MULT : zone === 'limb' ? LIMB_MULT : 1.0;
    const dmg = baseDamage * mult;
    this.health -= dmg;
    this.alertness = 1;
    this.lastSeen = this.engine.camera.position.clone();

    if (this.health <= 0) {
      this._die(direction);
    } else if (this.state === STATE.IDLE) {
      this.setState(STATE.ALERT);
    }
    return dmg;
  }

  _die(direction) {
    this.setState(STATE.DEAD);
    // Lightweight death: fall along the shot direction with a spin, then
    // settle. Cheaper than a full ragdoll and reads correctly at combat range.
    this.ragdoll = {
      t: 0,
      axis: new THREE.Vector3(direction.z, 0, -direction.x).normalize(),
      spin: (Math.random() - 0.5) * 2.2,
      vel: direction.clone().multiplyScalar(1.6).setY(1.2),
    };
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
  }

  /** Line of sight to a world point, ignoring the enemy's own body. */
  canSee(point) {
    const eye = this._v.copy(this.mesh.position).setY(this.mesh.position.y + 1.55);
    const dir = this._v2.copy(point).sub(eye);
    const dist = dir.length();
    if (dist > 90) return false;
    dir.normalize();
    // Field of view — soldiers do not have eyes in the back of their heads.
    const facing = new THREE.Vector3(-Math.sin(this.mesh.rotation.y), 0, -Math.cos(this.mesh.rotation.y));
    const cos = facing.dot(dir);
    const fovCos = this.alertness > 0.5 ? -0.2 : 0.35;
    if (cos < fovCos) return false;

    this._ray.set(eye, dir);
    this._ray.far = dist - 0.4;
    const hits = this._ray.intersectObject(this.engine.level.root, true);
    return hits.length === 0;
  }

  update(dt, playerPos) {
    this.stateTime += dt;

    if (this.state === STATE.DEAD) {
      this._updateDeath(dt);
      return;
    }

    this.seesPlayer = this.canSee(playerPos);
    if (this.seesPlayer) {
      this.lastSeen = playerPos.clone();
      this.alertness = Math.min(1, this.alertness + dt * 2.5);
    } else {
      this.alertness = Math.max(0, this.alertness - dt * 0.25);
    }

    switch (this.state) {
      case STATE.IDLE:
        if (this.alertness > 0.35) this.setState(STATE.ALERT);
        break;
      case STATE.ALERT:
        if (this.stateTime > this.reactionTime && this.seesPlayer) this.setState(STATE.ENGAGE);
        else if (this.alertness <= 0.05) this.setState(STATE.IDLE);
        break;
      case STATE.ENGAGE:
        if (!this.seesPlayer && this.stateTime > 1.4) this.setState(STATE.REPOSITION);
        else this._engage(dt, playerPos);
        break;
      case STATE.REPOSITION:
        this._reposition(dt);
        if (this.seesPlayer) this.setState(STATE.ENGAGE);
        break;
      case STATE.SUPPRESSED:
        if (this.stateTime > 1.8) this.setState(STATE.ENGAGE);
        break;
    }

    this._move(dt);
    this._animate(dt);
  }

  _engage(dt, playerPos) {
    // Face the player.
    const to = this._v.copy(playerPos).sub(this.mesh.position);
    const wantYaw = Math.atan2(-to.x, -to.z);
    this.mesh.rotation.y = angleLerp(this.mesh.rotation.y, wantYaw, Math.min(1, 7 * dt));

    // Strafe rather than standing still.
    if (!this.destination || this.stateTime % 3 < dt) {
      const side = (Math.random() - 0.5) * 6;
      this.destination = this.mesh.position.clone()
        .addScaledVector(new THREE.Vector3(Math.cos(wantYaw), 0, -Math.sin(wantYaw)), side);
    }

    const now = performance.now() / 1000;
    if (this.burstLeft <= 0 && now > this.nextShot) {
      this.burstLeft = 3 + Math.floor(Math.random() * 4);
      this.nextShot = now;
    }
    if (this.burstLeft > 0 && now >= this.nextShot && this.seesPlayer) {
      this._shoot(playerPos);
      this.burstLeft--;
      this.nextShot = now + 0.095;
      if (this.burstLeft === 0) this.nextShot = now + 0.7 + Math.random() * 1.1;
    }
  }

  _shoot(playerPos) {
    const muzzle = this._v.setFromMatrixPosition(this.mesh.userData.muzzle.matrixWorld);
    const dir = this._v2.copy(playerPos).sub(muzzle).normalize();
    // Miss cone shrinks the longer the enemy has had eyes on the player.
    const err = (1 - this.accuracy) * 0.09;
    dir.x += (Math.random() - 0.5) * err;
    dir.y += (Math.random() - 0.5) * err;
    dir.z += (Math.random() - 0.5) * err;
    dir.normalize();
    this.engine.onEnemyFire?.(this, muzzle.clone(), dir.clone());
  }

  _reposition(dt) {
    if (!this.destination || this.mesh.position.distanceToSquared(this.destination) < 1) {
      const cover = this.engine.level.coverPoints;
      this.destination = cover.length
        ? cover[Math.floor(Math.random() * cover.length)].clone()
        : this.mesh.position.clone();
    }
  }

  _move(dt) {
    if (!this.destination) { this.velocity.multiplyScalar(Math.max(0, 1 - 8 * dt)); return; }
    const to = this._v.copy(this.destination).setY(this.mesh.position.y).sub(this.mesh.position);
    const dist = to.length();
    if (dist < 0.5) { this.destination = null; return; }
    to.normalize();
    const speed = this.state === STATE.ENGAGE ? 2.4 : 4.2;
    this.velocity.lerp(to.multiplyScalar(speed), Math.min(1, 5 * dt));
    this.mesh.position.addScaledVector(this.velocity, dt);
    if (this.state !== STATE.ENGAGE) {
      this.mesh.rotation.y = angleLerp(this.mesh.rotation.y, Math.atan2(-this.velocity.x, -this.velocity.z), Math.min(1, 6 * dt));
    }
  }

  _animate(dt) {
    const r = this.rig;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.walkPhase += dt * (2.2 + speed * 1.9);
    const amp = Math.min(1, speed / 3.5);

    const s = Math.sin(this.walkPhase * 2);
    const c = Math.cos(this.walkPhase * 2);
    r.leftLeg.hip.rotation.x = s * 0.62 * amp;
    r.rightLeg.hip.rotation.x = -s * 0.62 * amp;
    r.leftLeg.knee.rotation.x = Math.max(0, -s) * 0.85 * amp;
    r.rightLeg.knee.rotation.x = Math.max(0, s) * 0.85 * amp;
    r.hips.position.y = 0.94 + Math.abs(c) * 0.045 * amp;
    r.hips.rotation.y = s * 0.10 * amp;
    r.torso.rotation.y = -s * 0.12 * amp;

    // Arms: weapon stays shouldered when engaging, swings when moving.
    const ready = this.state === STATE.ENGAGE || this.state === STATE.ALERT ? 1 : 0.25;
    r.rightArm.shoulder.rotation.x = -1.28 * ready - s * 0.22 * amp * (1 - ready);
    r.rightArm.shoulder.rotation.z = -0.34 * ready;
    r.rightArm.elbow.rotation.x = -1.05 * ready;
    r.leftArm.shoulder.rotation.x = -1.20 * ready + s * 0.22 * amp * (1 - ready);
    r.leftArm.shoulder.rotation.z = 0.52 * ready;
    r.leftArm.elbow.rotation.x = -1.30 * ready;

    // Idle breathing when standing still.
    if (amp < 0.05) {
      const b = Math.sin(performance.now() * 0.0013);
      r.torso.rotation.x = b * 0.012;
      r.hips.position.y = 0.94 + b * 0.006;
    }
  }

  _updateDeath(dt) {
    const rd = this.ragdoll;
    if (!rd || rd.t > 1.6) return;
    rd.t += dt;
    rd.vel.y -= 16 * dt;
    this.mesh.position.addScaledVector(rd.vel, dt);
    // Stop at ground level.
    if (this.mesh.position.y < 0.12) {
      this.mesh.position.y = 0.12;
      rd.vel.set(0, 0, 0);
    }
    const k = Math.min(1, rd.t / 0.75);
    const ease = k * k * (3 - 2 * k);
    this.mesh.rotateOnAxis(rd.axis, (Math.PI / 2) * ease * dt / Math.max(dt, 0.016) * dt * 2.0);
    this.mesh.rotation.y += rd.spin * dt * (1 - ease);
    // Limbs go slack.
    const r = this.rig;
    for (const j of [r.leftArm.shoulder, r.rightArm.shoulder, r.leftArm.elbow, r.rightArm.elbow]) {
      j.rotation.x += (0.2 - j.rotation.x) * Math.min(1, 4 * dt);
      j.rotation.z += (0 - j.rotation.z) * Math.min(1, 4 * dt);
    }
    for (const j of [r.leftLeg.hip, r.rightLeg.hip, r.leftLeg.knee, r.rightLeg.knee]) {
      j.rotation.x += (0.1 - j.rotation.x) * Math.min(1, 3 * dt);
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.traverse((o) => {
      if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
    });
  }
}

function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
