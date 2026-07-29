import * as THREE from 'three';
import { WEAPON_BUILDERS } from './RifleModel.js';
import { buildHand, curlHand, poseThumb, aimForearm } from './Hands.js';

// ---------------------------------------------------------------------------
// The viewmodel lives in its own scene rendered with a narrow-FOV camera after
// the world, so the gun never clips through walls and never changes shape when
// the world FOV moves. All the "feel" lives here: sway, bob, ADS, recoil,
// the hand rig, and the reload / inspect / draw clips.
//
// Layout of the transform stack, outermost first:
//
//   root        sway, bob, breathing, pose blend  (hip / ADS / sprint / slide)
//    recoilNode spring-driven kick, decoupled so it composes with everything
//     weapon    the gun; hands are parented here so they ride the recoil
// ---------------------------------------------------------------------------

const HIP_POS = new THREE.Vector3(0.132, -0.128, -0.285);
const HIP_ROT = new THREE.Euler(0.020, 0.070, 0.030);

const SPRINT_POS = new THREE.Vector3(0.175, -0.180, -0.245);
const SPRINT_ROT = new THREE.Euler(0.34, -0.60, 0.34);

const SLIDE_POS = new THREE.Vector3(0.195, -0.205, -0.225);
const SLIDE_ROT = new THREE.Euler(0.16, -0.30, 0.55);

const LOWREADY_POS = new THREE.Vector3(0.140, -0.185, -0.270);
const LOWREADY_ROT = new THREE.Euler(0.46, 0.10, 0.05);

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

const ease = (x) => x * x * (3 - 2 * x);
const easeOut = (x) => 1 - (1 - x) * (1 - x);
const easeIn = (x) => x * x;
/** Overshoot-and-settle. Used anywhere a part is meant to have mass. */
function overshoot(x, amp = 0.14, freq = 9) {
  if (x >= 1) return 1;
  return 1 - Math.pow(1 - x, 2) * Math.cos(x * freq) - amp * Math.pow(1 - x, 3) * Math.sin(x * freq);
}

export class Viewmodel {
  constructor(materials, weaponId = 'carbine') {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.005, 8);

    this.root = new THREE.Group();
    this.recoilNode = new THREE.Group();
    this.root.add(this.recoilNode);
    this.scene.add(this.root);

    this._lightRig();

    this.handL = buildHand(1);
    this.handR = buildHand(-1);

    this.weapon = null;
    this.setWeapon(weaponId);

    // ------------------------------ state ----------------------------------
    this.bobTime = 0;
    this.swayPos = new THREE.Vector2();
    this.swayVel = new THREE.Vector2();
    this.recoilPos = new THREE.Vector3();
    this.recoilRot = new THREE.Vector3();
    this.recoilVel = new THREE.Vector3();
    this.recoilAngVel = new THREE.Vector3();
    this.kickAccum = 0;
    this.boltCycle = 0;     // 0..1 one-shot, drives the reciprocating bolt
    this.firePulse = 0;

    this.clip = null;       // { name, t, dur }
    this.lastAds = 0;
    this.lowReady = 0;
    this.idleTime = 0;

    this._pos = new THREE.Vector3();
    this._rot = new THREE.Euler();
    this._adsPos = new THREE.Vector3();

    // Per-frame hand solve scratch, reused so the loop allocates nothing.
    this._hand = {
      L: { pos: new THREE.Vector3(), palm: new THREE.Vector3(), finger: new THREE.Vector3(), curl: 0, thumb: 0, elbow: new THREE.Vector3(), vis: true },
      R: { pos: new THREE.Vector3(), palm: new THREE.Vector3(), finger: new THREE.Vector3(), curl: 0, thumb: 0, elbow: new THREE.Vector3(), vis: true },
    };

    if (typeof window !== 'undefined') window.__viewmodel = this;
  }

  // -------------------------------------------------------------------------

  _lightRig() {
    // A gun is a near-black object. Without a dedicated rig the world sun puts
    // it in silhouette every time the player turns around, so the viewmodel
    // gets its own four-light setup that never moves relative to the weapon.
    //
    // Key from upper-left-front (the "sun over your shoulder" convention),
    // cool bounce from below-right, and two rims that trace the top edge and
    // the underside so the silhouette separates from any background.
    this.key = new THREE.DirectionalLight(0xfff2e2, 2.1);
    this.key.position.set(-0.75, 1.05, 0.35);

    this.fill = new THREE.DirectionalLight(0x8fb2e6, 0.8);
    this.fill.position.set(1.0, -0.55, 0.45);

    this.rim = new THREE.DirectionalLight(0xffe0bc, 1.9);
    this.rim.position.set(0.55, 0.85, -1.25);

    this.rimLow = new THREE.DirectionalLight(0x9fc4ff, 0.9);
    this.rimLow.position.set(-0.85, -0.70, -0.95);

    // Levels are deliberately conservative: this rig predates the filmic
    // tonemap, and at its original intensities the receiver clipped to flat
    // white and the metal broke into specular speckle at grazing angles.
    // A very soft ambient so the deepest recesses do not crush to pure black.
    this.ambient = new THREE.HemisphereLight(0xa8c4e8, 0x4a4034, 0.40);

    // Kicks with the muzzle flash: FX drives the real flash light, this one
    // just lifts the receiver and the hands for a frame or two.
    this.fireLight = new THREE.PointLight(0xffc98a, 0, 1.2, 2);
    this.fireLight.position.set(0, -0.02, -0.28);

    this.scene.add(this.key, this.fill, this.rim, this.rimLow, this.ambient, this.fireLight);
  }

  /** Swaps the weapon in place, rebuilding the hand attachment. */
  setWeapon(weaponId) {
    if (this.weapon) {
      this.recoilNode.remove(this.weapon);
      this.weapon.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    }
    const build = WEAPON_BUILDERS[weaponId] || WEAPON_BUILDERS.carbine;
    this.weapon = build();
    this.weaponId = weaponId;
    this.recoilNode.add(this.weapon);
    this.weapon.add(this.handL, this.handR);
    this.parts = this.weapon.userData.parts;
    this.grips = this.weapon.userData.grips;

    // The ADS pose puts the optic's optical axis exactly on the screen centre.
    this._adsSolve = new THREE.Vector3(0, -this.weapon.userData.sightHeight, -0.175);
    return this.weapon;
  }

  setEnvironment(envTexture) {
    this.scene.environment = envTexture;
    // The gun is metal: the probe is doing most of the work on the receiver
    // and the optic glass, so it runs much hotter here than in the world.
    this.scene.environmentIntensity = 0.65;
  }

  setSize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Muzzle position/direction in the *world* camera's space, for FX spawning. */
  getMuzzleWorld(worldCamera, outPos, outDir) {
    outPos.copy(this.weapon.userData.muzzle);
    this.weapon.localToWorld(outPos);
    outPos.applyMatrix4(worldCamera.matrixWorld);
    worldCamera.getWorldDirection(outDir);
    return outPos;
  }

  // ------------------------------- events ----------------------------------

  addRecoil(weapon, shotIndex = 0) {
    const r = weapon.recoil;
    // The horizontal component follows the weapon's designed recoil pattern
    // rather than pure noise, so the climb is learnable (see WeaponSystem).
    const pat = weapon.pattern;
    const n = pat ? pat[shotIndex % pat.length] : [0, 1];
    const lateral = n[0] + (Math.random() - 0.5) * 0.25;

    this.recoilVel.z += r.back;
    this.recoilVel.y += r.rise * 0.35;
    this.recoilVel.x += lateral * r.lateral;
    this.recoilAngVel.x -= r.pitch * (0.75 + n[1] * 0.35);
    this.recoilAngVel.y += lateral * r.yaw;
    this.recoilAngVel.z += lateral * r.roll;
    this.kickAccum = Math.min(1, this.kickAccum + 0.35);
    this.boltCycle = 1;
    this.firePulse = 1;
    this.idleTime = 0;
  }

  startReload(duration, empty = false) {
    this.clip = { name: 'reload', t: 0, dur: duration, empty };
    this.idleTime = 0;
  }

  startInspect() {
    if (this.clip) return;
    this.clip = { name: 'inspect', t: 0, dur: 3.1 };
  }

  startDraw(duration = 0.62) {
    this.clip = { name: 'draw', t: 0, dur: duration };
  }

  startHolster(duration = 0.42) {
    this.clip = { name: 'holster', t: 0, dur: duration };
  }

  /** 0..1 — pulls the weapon down out of the aim line without a full sprint. */
  setLowReady(v) { this.lowReadyTarget = v; }

  // ------------------------------- update ----------------------------------

  update(dt, player, ctx) {
    const ads = player.ads;
    const sprinting = player.sprinting && player.speed > 3.5;
    const sliding = player.sliding;

    let tp, tr;
    if (sliding) { tp = SLIDE_POS; tr = SLIDE_ROT; }
    else if (sprinting) { tp = SPRINT_POS; tr = SPRINT_ROT; }
    else { tp = HIP_POS; tr = HIP_ROT; }

    this._pos.copy(tp);
    this._rot.set(tr.x, tr.y, tr.z);

    // Low ready blends on top of the hip pose.
    this.lowReady += ((this.lowReadyTarget || 0) - this.lowReady) * Math.min(1, 7 * dt);
    if (this.lowReady > 0.001 && !sprinting && !sliding) {
      this._pos.lerp(LOWREADY_POS, this.lowReady);
      this._rot.x = THREE.MathUtils.lerp(this._rot.x, LOWREADY_ROT.x, this.lowReady);
      this._rot.y = THREE.MathUtils.lerp(this._rot.y, LOWREADY_ROT.y, this.lowReady);
      this._rot.z = THREE.MathUtils.lerp(this._rot.z, LOWREADY_ROT.z, this.lowReady);
    }

    if (ads > 0.001) {
      // Ease the ADS blend so the last few percent settle rather than snap.
      const a = ease(ads);
      this._adsPos.copy(this._adsSolve);
      this._pos.lerp(this._adsPos, a);
      this._rot.set(
        THREE.MathUtils.lerp(this._rot.x, 0, a),
        THREE.MathUtils.lerp(this._rot.y, 0, a),
        THREE.MathUtils.lerp(this._rot.z, 0, a),
      );
    }

    // ------------------------------ sway -----------------------------------
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
    this._pos.x += Math.sin(this.bobTime) * bobAmp;
    this._pos.y += (Math.cos(this.bobTime * 2) * -0.5 - 0.5) * bobAmp * 0.8;
    this._rot.z += Math.sin(this.bobTime) * bobAmp * 1.2;

    const breathe = Math.sin(performance.now() * 0.0011);
    const breatheAmp = (0.0016 + ads * 0.0011) * (1 - speed01 * 0.7);
    this._pos.y += breathe * breatheAmp;
    this._rot.x += breathe * breatheAmp * 0.6;

    if (player.landImpact > 0) {
      this.recoilVel.y -= player.landImpact * 2.2;
      this.recoilAngVel.x += player.landImpact * 3.5;
      player.landImpact = 0;
    }

    // ------------------------------ recoil ---------------------------------
    const rk = 190, rd = 21;
    this.recoilVel.addScaledVector(this.recoilPos, -rk * dt);
    this.recoilVel.multiplyScalar(Math.max(0, 1 - rd * dt));
    this.recoilPos.addScaledVector(this.recoilVel, dt);

    const ak = 150, ad = 18;
    this.recoilAngVel.addScaledVector(this.recoilRot, -ak * dt);
    this.recoilAngVel.multiplyScalar(Math.max(0, 1 - ad * dt));
    this.recoilRot.addScaledVector(this.recoilAngVel, dt);

    this.kickAccum = Math.max(0, this.kickAccum - dt * 1.6);
    this.firePulse = Math.max(0, this.firePulse - dt * 9);
    this.boltCycle = Math.max(0, this.boltCycle - dt * 14);

    this.recoilNode.position.set(
      this.recoilPos.x * (1 - ads * 0.45),
      this.recoilPos.y * (1 - ads * 0.45),
      this.recoilPos.z,
    );
    this.recoilNode.rotation.set(this.recoilRot.x, this.recoilRot.y, this.recoilRot.z);

    // ---------------------------- moving parts -----------------------------
    const parts = this.parts;
    // Bolt/charging handle: fast rearward, slower return, i.e. a real cycle.
    const bc = this.boltCycle;
    const travel = bc > 0.55 ? (1 - bc) / 0.45 : bc / 0.55;
    parts.charging.position.z = travel * 0.048;
    parts.trigger.rotation.x = -(ctx.firing ? 0.42 : 0.04);

    // Reticle brightness breathes very slightly and dims out of ADS, which is
    // what stops the dot reading as a decal painted on the glass.
    const dotGain = 0.55 + ads * 0.6 + Math.sin(performance.now() * 0.006) * 0.03;
    if (parts.dotMat) {
      parts.dotMat.opacity = dotGain;
      parts.haloMat.opacity = 0.30 + ads * 0.35;
    }

    this.fireLight.intensity = this.firePulse * 9.0;

    // ------------------------------ clips ----------------------------------
    this._resetHandTargets(ads);
    if (this.clip) {
      this.clip.t += dt;
      const k = Math.min(1, this.clip.t / this.clip.dur);
      if (this.clip.name === 'reload') this._reload(k, this.clip.empty);
      else if (this.clip.name === 'inspect') this._inspect(k);
      else if (this.clip.name === 'draw') this._draw(k);
      else if (this.clip.name === 'holster') this._holster(k);
      if (this.clip.t >= this.clip.dur) {
        this.clip = null;
        parts.magazine.position.set(0, 0, 0);
        parts.magazine.rotation.set(0, 0, 0);
        parts.magazine.visible = true;
        parts.charging.position.z = 0;
      }
    } else {
      // Idle: a slow settle in the support hand so the pose is never frozen.
      this.idleTime += dt;
      const s = Math.sin(this.idleTime * 0.9);
      this._hand.L.pos.y += s * 0.0009;
      this._hand.L.curl += s * 0.02;
    }

    this._applyHands();

    this.root.position.copy(this._pos);
    this.root.rotation.copy(this._rot);

    const targetFov = THREE.MathUtils.lerp(58, 40, ads);
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 10 * dt);
      this.camera.updateProjectionMatrix();
    }

    this.lastAds = ads;
  }

  // ------------------------------ hand rig ---------------------------------

  /** Default grip: both hands on the weapon, curls set for a firing grip. */
  _resetHandTargets(ads) {
    const g = this.grips;
    const L = this._hand.L, R = this._hand.R;

    R.pos.copy(g.trigger.pos);
    R.palm.set(-1, 0, 0);
    R.finger.set(0, -Math.sin(g.trigger.rake), -Math.cos(g.trigger.rake));
    R.curl = 0.92;
    R.thumb = 0.55;
    R.elbow.set(0.40, -0.52, 0.76);
    R.radius = g.trigger.radius;
    R.vis = true;

    L.pos.copy(g.support.pos);
    L.palm.set(0, 1, 0);
    L.finger.set(1, 0.10, -0.10).normalize();
    L.curl = 0.86;
    L.thumb = 0.35;
    L.elbow.set(-0.52, -0.46, 0.72);
    L.radius = g.support.radius;
    L.vis = true;

    // Aiming tightens the support grip and pulls the elbow in under the gun.
    if (ads > 0.01) {
      L.curl += ads * 0.06;
      L.elbow.x += ads * 0.22;
      R.elbow.x -= ads * 0.10;
    }
  }

  _applyHands() {
    this._solveHand(this.handL, this._hand.L);
    this._solveHand(this.handR, this._hand.R);
  }

  /**
   * Places a hand from a contact point, a palm direction and a finger
   * direction, all expressed in weapon space, then aims the forearm at the
   * elbow. Building the basis explicitly is far more robust than trying to
   * key Euler angles for a grip by hand.
   */
  _solveHand(hand, t) {
    hand.visible = t.vis;
    if (!t.vis) return;

    _v.copy(t.palm).normalize();
    _v2.copy(t.finger).normalize();
    // Re-orthogonalise so a hand-authored finger direction never shears.
    _v3.crossVectors(_v, _v2).normalize();
    _v2.crossVectors(_v3, _v).normalize();

    _v4.copy(_v).negate();
    _v5.copy(_v2).negate();
    _m.makeBasis(_v3, _v4, _v5);
    hand.quaternion.setFromRotationMatrix(_m);

    // Wrist sits one palm-thickness off the contact surface and a little back
    // along the finger axis, which is where a real palm meets a round grip.
    const off = (t.radius ?? 0.02) + 0.019;
    hand.position.copy(t.pos)
      .addScaledVector(_v, -off)
      .addScaledVector(_v2, -0.031);

    curlHand(hand, t.curl, 0.10);
    poseThumb(hand, t.thumb, t.thumbWrap ?? 0.35);
    aimForearm(hand, t.elbow);
  }

  // ------------------------------- clips -----------------------------------

  /**
   * Reload. Timings are fractions of the clip so tac and empty reloads share
   * one curve. The support hand does all the travel; the weapon cants toward
   * the player and settles with an overshoot rather than sliding back.
   */
  _reload(k, empty) {
    const seg = (a, b) => THREE.MathUtils.clamp((k - a) / (b - a), 0, 1);
    const L = this._hand.L, R = this._hand.R;
    const parts = this.parts;
    const g = this.grips;

    // --- weapon carriage ---------------------------------------------------
    const cant = ease(seg(0.00, 0.14)) - ease(seg(0.84, 1.00));
    this._pos.x += cant * 0.050;
    this._pos.y += cant * -0.052;
    this._pos.z += cant * 0.034;
    this._rot.z += cant * 0.62;
    this._rot.y += cant * 0.34;
    this._rot.x += cant * 0.10;

    // --- right hand stays on the grip, index reaches the mag release --------
    R.curl = 0.92 - seg(0.10, 0.20) * 0.05;
    R.thumb = 0.55;

    // --- support hand: release -> strip -> pouch -> return -> seat ----------
    const toMag = seg(0.02, 0.16);
    const atPouch = seg(0.24, 0.44);
    const back = seg(0.46, 0.64);
    const seat = seg(0.64, 0.76);
    const toCharge = empty ? seg(0.78, 0.86) : 0;
    const home = seg(empty ? 0.90 : 0.80, 1.0);

    // Path: handguard -> magwell -> off-screen low left -> magwell -> handguard
    const P_HG = g.support.pos;
    const P_MAG = g.magwell;
    const P_POUCH = _v3.set(P_MAG.x - 0.14, P_MAG.y - 0.30, P_MAG.z + 0.16);

    L.palm.set(0.15, 1, 0.15).normalize();
    L.finger.set(1, 0.1, -0.1).normalize();
    L.radius = g.support.radius;

    if (home > 0) {
      // Coming back to the handguard, with an overshoot as it slaps home.
      const h = overshoot(home, 0.22, 11);
      L.pos.lerpVectors(P_MAG, P_HG, h);
      L.pos.y += Math.sin(home * Math.PI) * 0.03;
      L.curl = 0.35 + h * 0.5;
      L.palm.set(0.15 * (1 - h), 1, 0.15 * (1 - h)).normalize();
    } else if (toCharge > 0) {
      // Empty reload: the hand snaps up to the charging handle and rips it.
      const c = toCharge < 0.5 ? easeOut(toCharge * 2) : 1;
      L.pos.lerpVectors(P_MAG, g.charging, c);
      L.palm.set(0.4, 0.6, 0.4).normalize();
      L.finger.set(0.6, -0.2, 0.75).normalize();
      L.curl = 0.55 + c * 0.4;
      L.radius = 0.012;
      const pull = toCharge < 0.45 ? easeIn(toCharge / 0.45) : 1 - easeOut((toCharge - 0.45) / 0.55);
      parts.charging.position.z = pull * 0.082;
      if (toCharge > 0.5) this.recoilVel.z += 0.0;
    } else if (seat > 0) {
      // Seating: hand drives the mag up, then the wrist rocks as it locks.
      const s = overshoot(seat, 0.18, 12);
      L.pos.copy(P_MAG);
      L.pos.y -= (1 - s) * 0.075;
      L.pos.z += (1 - s) * 0.030;
      L.curl = 0.75;
      L.radius = 0.016;
      if (seat > 0.82 && seat < 0.95) {
        // The slap. A short sharp impulse on the weapon, not a position jump.
        this.recoilAngVel.x += 0.9;
        this.recoilVel.y -= 0.05;
      }
    } else if (back > 0) {
      const bq = easeOut(back);
      L.pos.lerpVectors(P_POUCH, P_MAG, bq);
      L.pos.y -= Math.sin(back * Math.PI) * 0.05;
      L.curl = 0.8;
      L.radius = 0.016;
    } else if (atPouch > 0) {
      const p = ease(atPouch);
      L.pos.lerpVectors(P_MAG, P_POUCH, p < 0.5 ? p * 2 : 2 - p * 2);
      L.curl = 0.55 + Math.sin(atPouch * Math.PI) * 0.35;
      L.radius = 0.016;
      L.vis = atPouch < 0.42 || atPouch > 0.58;
    } else {
      const m = ease(toMag);
      L.pos.lerpVectors(P_HG, P_MAG, m);
      L.curl = 0.86 - m * 0.4;
      L.radius = THREE.MathUtils.lerp(g.support.radius, 0.016, m);
    }

    // --- the magazine ------------------------------------------------------
    const strip = seg(0.16, 0.30);
    if (seat > 0 || back > 0.55) {
      // New mag: carried in the hand, then driven into the well.
      parts.magazine.visible = true;
      const s = seat > 0 ? overshoot(seat, 0.18, 12) : 0;
      parts.magazine.position.set(
        (1 - s) * (L.pos.x - P_MAG.x) * 0.9,
        (1 - s) * -0.085,
        (1 - s) * 0.038,
      );
      parts.magazine.rotation.set((1 - s) * -0.45, 0, (1 - s) * 0.25);
    } else if (strip > 0) {
      // Old mag is *thrown*: it accelerates downward and tumbles away rather
      // than sliding out on a rail.
      const f = strip * strip;
      parts.magazine.visible = strip < 0.98;
      parts.magazine.position.set(f * -0.05, -f * 0.62, f * 0.10);
      parts.magazine.rotation.set(f * 1.6, f * 0.5, f * -0.9);
    } else {
      parts.magazine.visible = true;
      parts.magazine.position.set(0, 0, 0);
      parts.magazine.rotation.set(0, 0, 0);
    }
    if (atPouch > 0 && back === 0) parts.magazine.visible = false;
  }

  /** Inspect: rotate the weapon into view, check the chamber, check the mag. */
  _inspect(k) {
    const seg = (a, b) => THREE.MathUtils.clamp((k - a) / (b - a), 0, 1);
    const L = this._hand.L, R = this._hand.R;
    const g = this.grips;

    const lift = ease(seg(0.0, 0.18)) - ease(seg(0.85, 1.0));
    this._pos.x += lift * -0.055;
    this._pos.y += lift * 0.020;
    this._pos.z += lift * 0.055;
    this._rot.y += lift * -0.85;
    this._rot.z += lift * -0.30;
    this._rot.x += lift * -0.12;

    // Roll the weapon over to look at the left side, then back.
    const roll = Math.sin(THREE.MathUtils.clamp((k - 0.22) / 0.42, 0, 1) * Math.PI);
    this._rot.z += roll * -0.55;
    this._rot.x += roll * 0.20;

    // Support hand comes off the handguard to tug the charging handle.
    const tug = seg(0.30, 0.48);
    if (tug > 0 && tug < 1) {
      const t = tug < 0.5 ? easeIn(tug * 2) : 1 - easeOut((tug - 0.5) * 2);
      L.pos.lerpVectors(g.support.pos, g.charging, Math.min(1, tug * 2.4));
      L.palm.set(0.4, 0.6, 0.4).normalize();
      L.finger.set(0.6, -0.2, 0.75).normalize();
      L.curl = 0.6 + t * 0.3;
      L.radius = 0.012;
      this.parts.charging.position.z = t * 0.030;
    }
    // Then a slow slide back along the handguard.
    const slide = seg(0.56, 0.86);
    if (slide > 0) {
      L.pos.copy(g.support.pos);
      L.pos.z += Math.sin(slide * Math.PI) * 0.045;
      L.curl = 0.86;
    }
    R.curl = 0.92;
  }

  _draw(k) {
    // Comes up from below with a settle at the top; the muzzle leads.
    const e = overshoot(k, 0.28, 8);
    this._pos.y += (1 - e) * -0.30;
    this._pos.z += (1 - e) * 0.10;
    this._rot.x += (1 - e) * 0.95;
    this._rot.z += (1 - e) * 0.42;
    this._hand.L.curl = 0.4 + e * 0.46;
  }

  _holster(k) {
    const e = easeIn(k);
    this._pos.y += e * -0.30;
    this._rot.x += e * 0.95;
    this._rot.z += e * 0.42;
  }

  dispose() {
    this.weapon?.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }
}
