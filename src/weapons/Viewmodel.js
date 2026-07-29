import * as THREE from 'three';
import { buildCarbine } from './RifleModel.js';
import { settings } from '../core/Settings.js';

// ---------------------------------------------------------------------------
// The viewmodel lives in its own scene rendered with a narrow-FOV camera after
// the world, so the gun never clips through walls and never changes shape when
// the world FOV moves. All the "feel" lives here: sway, bob, ADS, recoil,
// reload, and the low-ready/sprint poses.
// ---------------------------------------------------------------------------

const HIP_POS = new THREE.Vector3(0.145, -0.135, -0.30);
const HIP_ROT = new THREE.Euler(0.012, 0.055, 0.0);

// ADS position is solved so the optic centre lands on the screen centre.
const ADS_POS = new THREE.Vector3(0.0, -0.0335, -0.185);
const ADS_ROT = new THREE.Euler(0, 0, 0);

const SPRINT_POS = new THREE.Vector3(0.19, -0.185, -0.24);
const SPRINT_ROT = new THREE.Euler(0.32, -0.62, 0.30);

const SLIDE_POS = new THREE.Vector3(0.20, -0.21, -0.22);
const SLIDE_ROT = new THREE.Euler(0.16, -0.30, 0.55);

export class Viewmodel {
  constructor(materials) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.005, 8);

    this.root = new THREE.Group();      // sway/bob container
    this.recoilNode = new THREE.Group(); // recoil is applied here so it composes
    this.weapon = buildCarbine(materials);
    this.recoilNode.add(this.weapon);
    this.root.add(this.recoilNode);
    this.scene.add(this.root);

    // Dedicated three-point rig — the world sun would leave the gun in
    // silhouette whenever the player faces away from it.
    this.key = new THREE.DirectionalLight(0xfff0dd, 2.6);
    this.key.position.set(-0.6, 1.0, 0.55);
    this.fill = new THREE.DirectionalLight(0x93b4e0, 0.85);
    this.fill.position.set(0.9, -0.2, 0.4);
    this.rim = new THREE.DirectionalLight(0xffd9b0, 1.5);
    this.rim.position.set(0.3, 0.4, -1.0);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.35);
    this.scene.add(this.key, this.fill, this.rim, this.ambient);

    // Animation state
    this.bobTime = 0;
    this.swayPos = new THREE.Vector2();
    this.swayVel = new THREE.Vector2();
    this.recoilPos = new THREE.Vector3();
    this.recoilRot = new THREE.Vector3();
    this.recoilVel = new THREE.Vector3();
    this.recoilAngVel = new THREE.Vector3();
    this.kickAccum = 0;

    this.reload = null;
    this.inspect = null;
    this.lastAds = 0;

    this._pos = new THREE.Vector3();
    this._rot = new THREE.Euler();
    this._q = new THREE.Quaternion();
  }

  setEnvironment(envTexture) {
    this.scene.environment = envTexture;
    this.scene.environmentIntensity = 0.55;
  }

  setSize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Muzzle position/direction in the *world* camera's space, for FX spawning. */
  getMuzzleWorld(worldCamera, outPos, outDir) {
    const local = this.weapon.userData.muzzle;
    outPos.copy(local);
    this.weapon.localToWorld(outPos);
    // Viewmodel space is camera space: transform into world via the camera.
    outPos.applyMatrix4(worldCamera.matrixWorld);
    worldCamera.getWorldDirection(outDir);
    return outPos;
  }

  /** Applies an impulse for one shot. */
  addRecoil(weapon) {
    const r = weapon.recoil;
    const spread = (Math.random() - 0.5);
    this.recoilVel.z += r.back;
    this.recoilVel.y += r.rise * 0.35;
    this.recoilVel.x += spread * r.lateral;
    this.recoilAngVel.x -= r.pitch;
    this.recoilAngVel.y += spread * r.yaw;
    this.recoilAngVel.z += spread * r.roll;
    this.kickAccum = Math.min(1, this.kickAccum + 0.35);
  }

  startReload(duration) {
    this.reload = { t: 0, duration };
  }

  /**
   * @param {number} dt
   * @param {import('../player/Controller.js').PlayerController} player
   * @param {{lookDX:number, lookDY:number, firing:boolean}} ctx
   */
  update(dt, player, ctx) {
    const ads = player.ads;
    const sprinting = player.sprinting && player.speed > 3.5;
    const sliding = player.sliding;

    // --------------------------- target pose -------------------------------
    let tp, tr;
    if (sliding) { tp = SLIDE_POS; tr = SLIDE_ROT; }
    else if (sprinting) { tp = SPRINT_POS; tr = SPRINT_ROT; }
    else { tp = HIP_POS; tr = HIP_ROT; }

    this._pos.copy(tp);
    this._rot.set(tr.x, tr.y, tr.z);

    // ADS overrides the hip pose entirely and is not blended with sprint —
    // the controller already suppresses ADS while sprinting.
    if (ads > 0.001) {
      this._pos.lerp(ADS_POS, ads);
      this._rot.set(
        THREE.MathUtils.lerp(this._rot.x, ADS_ROT.x, ads),
        THREE.MathUtils.lerp(this._rot.y, ADS_ROT.y, ads),
        THREE.MathUtils.lerp(this._rot.z, ADS_ROT.z, ads),
      );
    }

    // ------------------------------ sway -----------------------------------
    // Look input pushes the weapon opposite the turn, then springs back.
    const swayScale = (1 - ads * 0.82) * 0.00035;
    this.swayVel.x += -ctx.lookDX * swayScale;
    this.swayVel.y += ctx.lookDY * swayScale;
    const stiffness = 62, damping = 11;
    this.swayVel.x += (-this.swayPos.x * stiffness) * dt;
    this.swayVel.y += (-this.swayPos.y * stiffness) * dt;
    this.swayVel.multiplyScalar(Math.max(0, 1 - damping * dt));
    this.swayPos.x += this.swayVel.x * dt;
    this.swayPos.y += this.swayVel.y * dt;
    this.swayPos.x = THREE.MathUtils.clamp(this.swayPos.x, -0.05, 0.05);
    this.swayPos.y = THREE.MathUtils.clamp(this.swayPos.y, -0.05, 0.05);

    this._pos.x += this.swayPos.x;
    this._pos.y += this.swayPos.y;
    this._rot.y += this.swayPos.x * 1.6;
    this._rot.x += -this.swayPos.y * 1.6;

    // ------------------------------ bob ------------------------------------
    const speed01 = Math.min(1, player.speed / 7.0);
    const bobRate = sprinting ? 11.5 : 8.2;
    if (player.onGround) this.bobTime += dt * bobRate * Math.max(0.15, speed01);
    const bobAmp = speed01 * (1 - ads * 0.88) * (sprinting ? 0.022 : 0.013);
    // Figure-eight: horizontal at half the vertical frequency reads as a walk.
    this._pos.x += Math.sin(this.bobTime) * bobAmp;
    this._pos.y += (Math.cos(this.bobTime * 2) * -0.5 - 0.5) * bobAmp * 0.8;
    this._rot.z += Math.sin(this.bobTime) * bobAmp * 1.2;

    // Idle breathing, most visible while aiming.
    const breathe = Math.sin(performance.now() * 0.0011);
    const breatheAmp = (0.0016 + ads * 0.0011) * (1 - speed01 * 0.7);
    this._pos.y += breathe * breatheAmp;
    this._rot.x += breathe * breatheAmp * 0.6;

    // ---------------------------- landing dip ------------------------------
    if (player.landImpact > 0) {
      this.recoilVel.y -= player.landImpact * 2.2;
      this.recoilAngVel.x += player.landImpact * 3.5;
      player.landImpact = 0;
    }

    // ------------------------------ recoil ---------------------------------
    // Critically-damped-ish spring back to zero.
    const rk = 190, rd = 21;
    this.recoilVel.addScaledVector(this.recoilPos, -rk * dt);
    this.recoilVel.multiplyScalar(Math.max(0, 1 - rd * dt));
    this.recoilPos.addScaledVector(this.recoilVel, dt);

    const ak = 150, ad = 18;
    this.recoilAngVel.addScaledVector(this.recoilRot, -ak * dt);
    this.recoilAngVel.multiplyScalar(Math.max(0, 1 - ad * dt));
    this.recoilRot.addScaledVector(this.recoilAngVel, dt);

    this.kickAccum = Math.max(0, this.kickAccum - dt * 1.6);

    this.recoilNode.position.set(
      this.recoilPos.x * (1 - ads * 0.45),
      this.recoilPos.y * (1 - ads * 0.45),
      this.recoilPos.z,
    );
    this.recoilNode.rotation.set(this.recoilRot.x, this.recoilRot.y, this.recoilRot.z);

    // Bolt reciprocates with the recoil impulse.
    const parts = this.weapon.userData.parts;
    const boltTravel = THREE.MathUtils.clamp(this.recoilPos.z * 2.4, 0, 0.055);
    parts.charging.position.z = boltTravel;
    parts.trigger.rotation.x = -0.15 - (ctx.firing ? 0.35 : 0);

    // ------------------------------ reload ---------------------------------
    if (this.reload) {
      this.reload.t += dt;
      const k = this.reload.t / this.reload.duration;
      this._applyReloadPose(k, parts);
      if (k >= 1) {
        this.reload = null;
        parts.magazine.position.set(0, 0, 0);
        parts.magazine.rotation.set(0, 0, 0);
        parts.magazine.visible = true;
        parts.charging.position.z = 0;
      }
    }

    this.root.position.copy(this._pos);
    this.root.rotation.copy(this._rot);

    // Wider FOV while hip-firing sells speed; tightens for ADS.
    const targetFov = THREE.MathUtils.lerp(58, 42, ads);
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 10 * dt);
      this.camera.updateProjectionMatrix();
    }

    this.lastAds = ads;
  }

  /** Hand-keyed reload: drop mag, insert, seat, charge, return. */
  _applyReloadPose(k, parts) {
    const ease = (x) => x * x * (3 - 2 * x);
    const seg = (a, b) => THREE.MathUtils.clamp((k - a) / (b - a), 0, 1);

    // Weapon cants toward the player and dips.
    const cantIn = ease(seg(0.0, 0.18));
    const cantOut = ease(seg(0.80, 1.0));
    const cant = cantIn - cantOut;
    this._pos.x += cant * 0.045;
    this._pos.y += cant * -0.055;
    this._pos.z += cant * 0.030;
    this._rot.z += cant * 0.55;
    this._rot.y += cant * 0.30;
    this._rot.x += cant * 0.12;

    // Old mag falls out.
    const drop = seg(0.16, 0.36);
    if (drop > 0 && drop < 1) {
      parts.magazine.visible = true;
      parts.magazine.position.y = -drop * 0.35;
      parts.magazine.rotation.x = drop * 0.9;
    } else if (drop >= 1 && k < 0.48) {
      parts.magazine.visible = false;
    }

    // New mag comes up and seats with a snap.
    const insert = seg(0.48, 0.70);
    if (insert > 0) {
      parts.magazine.visible = true;
      const e = ease(insert);
      parts.magazine.position.y = (1 - e) * -0.30;
      parts.magazine.position.z = (1 - e) * 0.05;
      parts.magazine.rotation.x = (1 - e) * 0.35;
      // Overshoot bump as it seats.
      if (insert > 0.9) this._pos.y -= (insert - 0.9) * 0.02;
    }

    // Charging handle pulled and released.
    const charge = seg(0.72, 0.90);
    if (charge > 0 && charge < 1) {
      const c = charge < 0.55 ? charge / 0.55 : 1 - (charge - 0.55) / 0.45;
      parts.charging.position.z = ease(c) * 0.075;
    }
  }
}
