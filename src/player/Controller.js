import * as THREE from 'three';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';
import { settings } from '../core/Settings.js';

// ---------------------------------------------------------------------------
// Capsule-vs-octree player movement with the movement verbs a modern military
// shooter is expected to have: accelerated ground control, air control,
// sprint, tactical sprint, crouch, slide with momentum, jump, and mantling.
// ---------------------------------------------------------------------------

const STAND_HEIGHT = 1.75;
const CROUCH_HEIGHT = 1.05;
const RADIUS = 0.34;
const EYE_OFFSET = -0.16; // eyes sit slightly below the capsule top

const SPEED = {
  walk: 4.3,
  sprint: 6.9,
  tacSprint: 8.4,
  crouch: 2.1,
  ads: 2.4,
  air: 1.6,
};

const GRAVITY = 22.0;
const JUMP_VELOCITY = 6.4;
const GROUND_ACCEL = 62.0;
const AIR_ACCEL = 14.0;
const GROUND_FRICTION = 11.0;
const SLIDE_FRICTION = 1.35;
const SLIDE_MIN_SPEED = 3.2;
const SLIDE_BOOST = 2.6;
const SLIDE_MAX_TIME = 1.15;

export class PlayerController {
  /** @param {THREE.Camera} camera @param {import('three/examples/jsm/math/Octree.js').Octree} collision */
  constructor(camera, collision) {
    this.camera = camera;
    this.collision = collision;

    this.position = new THREE.Vector3(0, 2, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.height = STAND_HEIGHT;
    this.targetHeight = STAND_HEIGHT;
    this.capsule = new Capsule(
      new THREE.Vector3(0, RADIUS, 0),
      new THREE.Vector3(0, STAND_HEIGHT - RADIUS, 0),
      RADIUS,
    );
    this.capsule.start.copy(this.position).setY(this.position.y + RADIUS);
    this.capsule.end.copy(this.position).setY(this.position.y + STAND_HEIGHT - RADIUS);

    this.onGround = false;
    this.crouching = false;
    this.sprinting = false;
    this.tacSprinting = false;
    this.sliding = false;
    this.slideTime = 0;
    this.mantling = null;
    this.lean = 0;         // -1 left, +1 right
    this.leanTarget = 0;
    this.ads = 0;          // 0..1 aim-down-sights blend
    this.wasOnGround = false;
    this.landImpact = 0;   // set on landing, consumed by the camera for a dip

    this.moveDir = new THREE.Vector3();
    this.wishDir = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._scratch = new THREE.Vector3();
  }

  get eyeHeight() {
    return this.height + EYE_OFFSET;
  }

  /** Horizontal speed, used by bob/FOV/audio. */
  get speed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  look(dx, dy) {
    const sens = settings.sensitivity * (1 - this.ads * (1 - settings.adsSensitivityScale));
    this.yaw -= dx * sens;
    this.pitch -= dy * sens * (settings.invertY ? -1 : 1);
    const limit = Math.PI / 2 - 0.015;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    // Keep yaw bounded so long sessions don't lose float precision.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /**
   * @param {number} dt
   * @param {{forward:number,right:number,jump:boolean,sprint:boolean,crouch:boolean,
   *          ads:boolean,leanLeft:boolean,leanRight:boolean}} cmd
   */
  update(dt, cmd) {
    if (this.mantling) {
      this._updateMantle(dt);
      this._syncCamera(dt);
      return;
    }

    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    this.wishDir.set(0, 0, 0)
      .addScaledVector(this._forward, cmd.forward)
      .addScaledVector(this._right, cmd.right);
    if (this.wishDir.lengthSq() > 1) this.wishDir.normalize();

    const wantsSprint = cmd.sprint && cmd.forward > 0.1 && !this.crouching && !cmd.ads;
    this.sprinting = wantsSprint && this.onGround;
    this.tacSprinting = this.sprinting && cmd.tacSprint;

    this._updateStance(dt, cmd);
    this._updateSlide(dt, cmd);

    // ADS blend — instant-ish but smooth; sprinting cancels it.
    const adsTarget = cmd.ads && !this.sprinting && !this.sliding ? 1 : 0;
    const adsRate = adsTarget > this.ads ? 9.5 : 12.0;
    this.ads += (adsTarget - this.ads) * Math.min(1, adsRate * dt);

    this.leanTarget = (cmd.leanLeft ? -1 : 0) + (cmd.leanRight ? 1 : 0);
    if (this.sprinting || this.sliding) this.leanTarget = 0;
    this.lean += (this.leanTarget - this.lean) * Math.min(1, 10 * dt);

    this._accelerate(dt);

    if (cmd.jump && this.onGround && !this.mantling) {
      this.velocity.y = JUMP_VELOCITY;
      this.onGround = false;
      this.sliding = false;
    }

    this.velocity.y -= GRAVITY * dt;

    this._integrate(dt);

    if (cmd.jump && !this.onGround) this._tryMantle();

    this._syncCamera(dt);
  }

  _updateStance(dt, cmd) {
    const wantCrouch = cmd.crouch || this.sliding;
    if (wantCrouch) {
      this.targetHeight = CROUCH_HEIGHT;
      this.crouching = true;
    } else if (this.crouching) {
      // Only stand back up if there is headroom.
      if (this._hasHeadroom(STAND_HEIGHT)) {
        this.targetHeight = STAND_HEIGHT;
        this.crouching = false;
      }
    }
    const rate = this.targetHeight < this.height ? 13 : 9;
    this.height += (this.targetHeight - this.height) * Math.min(1, rate * dt);
  }

  _hasHeadroom(h) {
    const probe = new Capsule(
      this._scratch.copy(this.position).setY(this.position.y + RADIUS).clone(),
      this._scratch.clone().setY(this.position.y + h - RADIUS),
      RADIUS * 0.95,
    );
    return !this.collision.capsuleIntersect(probe);
  }

  _updateSlide(dt, cmd) {
    if (this.sliding) {
      this.slideTime += dt;
      if (!cmd.crouch || this.slideTime > SLIDE_MAX_TIME || this.speed < SLIDE_MIN_SPEED * 0.55 || !this.onGround) {
        this.sliding = false;
      }
    } else if (cmd.crouch && this.onGround && this.speed > SLIDE_MIN_SPEED && this._prevSprint) {
      this.sliding = true;
      this.slideTime = 0;
      // Convert sprint into a forward burst.
      const dir = this._scratch.copy(this.velocity).setY(0);
      if (dir.lengthSq() > 1e-4) {
        dir.normalize();
        this.velocity.addScaledVector(dir, SLIDE_BOOST);
      }
    }
    this._prevSprint = this.sprinting || this.sliding;
  }

  _accelerate(dt) {
    const maxSpeed = this._targetSpeed();
    const accel = this.onGround ? GROUND_ACCEL : AIR_ACCEL;

    if (this.onGround && !this.sliding) {
      // Quake-style friction: scale horizontal velocity toward zero, then add
      // acceleration along the wish direction. Gives crisp stops without the
      // ice-skating of pure damping.
      const sp = this.speed;
      if (sp > 0) {
        const drop = Math.max(sp, 3.0) * GROUND_FRICTION * dt;
        const scale = Math.max(0, sp - drop) / sp;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
    } else if (this.sliding) {
      const sp = this.speed;
      if (sp > 0) {
        const drop = sp * SLIDE_FRICTION * dt;
        const scale = Math.max(0, sp - drop) / sp;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
    }

    if (this.wishDir.lengthSq() < 1e-6) return;
    // Slides ignore steering input except for a little sideways nudge.
    const control = this.sliding ? 0.18 : 1.0;
    const current = this.velocity.x * this.wishDir.x + this.velocity.z * this.wishDir.z;
    const addSpeed = maxSpeed - current;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(accel * maxSpeed * dt * control, addSpeed);
    this.velocity.x += this.wishDir.x * accelSpeed;
    this.velocity.z += this.wishDir.z * accelSpeed;
  }

  _targetSpeed() {
    if (!this.onGround) return SPEED.air + SPEED.walk;
    if (this.sliding) return SPEED.sprint;
    if (this.crouching) return SPEED.crouch;
    if (this.tacSprinting) return SPEED.tacSprint;
    if (this.sprinting) return SPEED.sprint;
    if (this.ads > 0.5) return SPEED.ads;
    return SPEED.walk;
  }

  _integrate(dt) {
    // Substep so fast movement can't tunnel through thin geometry.
    const steps = Math.min(5, Math.max(1, Math.ceil(this.velocity.length() * dt / (RADIUS * 0.5))));
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.position.addScaledVector(this.velocity, sub);
      this._collide();
    }

    this.wasOnGround = this.onGround;
  }

  _collide() {
    this.capsule.start.copy(this.position).setY(this.position.y + RADIUS);
    this.capsule.end.copy(this.position).setY(this.position.y + this.height - RADIUS);

    const hit = this.collision.capsuleIntersect(this.capsule);
    const wasAir = !this.onGround;
    this.onGround = false;

    if (hit) {
      // A contact normal pointing mostly up means we're standing on it.
      this.onGround = hit.normal.y > 0.5;
      if (this.onGround) {
        if (wasAir && this.velocity.y < -4) {
          this.landImpact = Math.min(1, (-this.velocity.y - 4) / 12);
        }
        this.velocity.y = Math.max(0, this.velocity.y);
      } else {
        // Slide along walls: remove the into-surface component.
        const into = this.velocity.dot(hit.normal);
        if (into < 0) this.velocity.addScaledVector(hit.normal, -into);
      }
      this.position.addScaledVector(hit.normal, hit.depth);
    }

    // Safety net: never let the player fall out of the world.
    if (this.position.y < -50) {
      this.position.set(0, 3, 0);
      this.velocity.set(0, 0, 0);
    }
  }

  /** Looks for a ledge at chest height with a clear surface to climb onto. */
  _tryMantle() {
    const fwd = this._forward;
    const origin = this._scratch.copy(this.position);
    const maxLedge = this.position.y + 1.75;
    const minLedge = this.position.y + 0.45;

    // Probe a few heights for the first one where the space ahead is clear.
    for (let h = maxLedge; h > minLedge; h -= 0.18) {
      const probeCentre = new THREE.Vector3()
        .copy(origin)
        .addScaledVector(fwd, RADIUS + 0.42)
        .setY(h + RADIUS + 0.05);
      const probe = new Capsule(
        probeCentre.clone(),
        probeCentre.clone().setY(h + STAND_HEIGHT - RADIUS),
        RADIUS * 0.9,
      );
      if (this.collision.capsuleIntersect(probe)) continue;

      // Space above is clear — confirm there is ground just under it.
      const footProbe = new Capsule(
        probeCentre.clone().setY(h - 0.12),
        probeCentre.clone().setY(h + 0.02),
        RADIUS * 0.9,
      );
      if (!this.collision.capsuleIntersect(footProbe)) continue;

      this.mantling = {
        t: 0,
        duration: 0.42 + (h - this.position.y) * 0.16,
        from: this.position.clone(),
        to: new THREE.Vector3().copy(origin).addScaledVector(fwd, RADIUS + 0.55).setY(h + 0.02),
      };
      this.velocity.set(0, 0, 0);
      return true;
    }
    return false;
  }

  _updateMantle(dt) {
    const m = this.mantling;
    m.t += dt;
    const k = Math.min(1, m.t / m.duration);
    // Rise first, then move forward — reads as pulling yourself over a ledge.
    const up = k < 0.6 ? k / 0.6 : 1;
    const fwd = k < 0.35 ? 0 : (k - 0.35) / 0.65;
    const ease = (x) => x * x * (3 - 2 * x);
    this.position.x = THREE.MathUtils.lerp(m.from.x, m.to.x, ease(fwd));
    this.position.z = THREE.MathUtils.lerp(m.from.z, m.to.z, ease(fwd));
    this.position.y = THREE.MathUtils.lerp(m.from.y, m.to.y, ease(up));
    if (k >= 1) {
      this.mantling = null;
      this.onGround = true;
    }
  }

  _syncCamera(dt) {
    this.camera.position.copy(this.position);
    this.camera.position.y += this.eyeHeight;
    // Lean shifts the eye laterally and rolls the view.
    if (Math.abs(this.lean) > 0.001) {
      this.camera.position.addScaledVector(this._right, this.lean * 0.42);
    }
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = -this.lean * 0.16;
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.mantling = null;
  }
}
