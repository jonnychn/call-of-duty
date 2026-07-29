import * as THREE from 'three';
import { COLLISION_LAYER } from '../world/Level.js';

// ---------------------------------------------------------------------------
// Firing, ammo, spread, and camera recoil. Hitscan with a spread cone; the
// visual tracer is a separate entity so it can travel at a readable speed
// while the hit itself resolves instantly (what every modern shooter does).
// ---------------------------------------------------------------------------

export class WeaponSystem {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine, def) {
    this.engine = engine;
    this.def = def;
    this.ammo = def.magazine;
    this.reserve = def.reserve;
    this.nextShotTime = 0;
    this.time = 0;
    this.reloading = false;
    this.reloadEnds = 0;
    this.spread = def.spread.hipBase;
    this.shotsFired = 0;
    this.burst = 0;        // shots since the trigger was last released
    this.wasFiring = false;

    // Camera recoil: an offset added on top of the player's aim that decays.
    this.camRecoil = new THREE.Vector2();
    this.camRecoilVel = new THREE.Vector2();
    this.appliedRecoil = new THREE.Vector2();

    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.set(COLLISION_LAYER);
    this.raycaster.far = 400;

    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this.onHit = null;   // (point, normal, object, distance) => void
    this.onFire = null;  // (originWorld, dirWorld, isTracer) => void
  }

  /**
   * Swaps to another weapon definition, playing holster/draw across the cut.
   * Everything downstream (spread, recoil pattern, viewmodel, hand grips) is
   * driven off the def and the model's own anchors, so no other system needs
   * to know which weapon is equipped.
   */
  setWeapon(def) {
    if (!def || def === this.def) return;
    const vm = this.engine.viewmodel;
    vm.startHolster(0.28);
    setTimeout(() => {
      this.def = def;
      this.ammo = def.magazine;
      this.reserve = def.reserve;
      this.spread = def.spread.hipBase;
      this.reloading = false;
      this.burst = 0;
      this.nextShotTime = this.time + 0.1;
      vm.setWeapon(def.id);
      vm.startDraw(0.46);
    }, 280);
  }

  canFire() {
    return !this.reloading && this.ammo > 0 && this.time >= this.nextShotTime;
  }

  startReload() {
    if (this.reloading || this.ammo === this.def.magazine || this.reserve <= 0) return;
    this.reloading = true;
    const empty = this.ammo === 0;
    const dur = empty ? this.def.reloadEmptyTime : this.def.reloadTime;
    this.reloadEnds = this.time + dur;
    // The empty reload runs the longer clip: the bolt is locked back, so the
    // support hand has to come off the mag and rip the charging handle.
    this.engine.viewmodel.startReload(dur, empty);
    this.burst = 0;
  }

  _finishReload() {
    const want = this.def.magazine - this.ammo;
    const take = Math.min(want, this.reserve);
    this.ammo += take;
    this.reserve -= take;
    this.reloading = false;
  }

  update(dt, cmd) {
    this.time += dt;
    const def = this.def;

    if (this.reloading && this.time >= this.reloadEnds) this._finishReload();
    if (cmd.reload) this.startReload();

    const wantFire = def.fireMode === 'auto' ? cmd.firing : cmd.triggerPulled;
    // Releasing the trigger resets the pattern. Recovery is not instant: a
    // quick tap-and-retap keeps some of the climb, so tap-firing is a real
    // trade rather than a free reset.
    if (!cmd.firing) {
      if (this.wasFiring) this.lastReleaseTime = this.time;
      if (this.burst > 0 && this.time - (this.lastReleaseTime ?? 0) > 0.28) this.burst = 0;
    }
    this.wasFiring = !!cmd.firing;

    if (wantFire && this.canFire()) {
      this.fire(cmd.ads);
    } else if (wantFire && !this.reloading && this.ammo === 0) {
      this.startReload();
    }

    // Spread recovers toward the base value for the current stance.
    const player = this.engine.player;
    const moving = Math.min(1, player.speed / 6);
    const base = THREE.MathUtils.lerp(def.spread.hipBase, def.spread.adsBase, cmd.ads)
      * (1 + moving * def.spread.moveScale * (1 - cmd.ads * 0.7))
      * (player.crouching ? 0.72 : 1);
    const max = THREE.MathUtils.lerp(def.spread.hipMax, def.spread.adsMax, cmd.ads);
    this.spread += (base - this.spread) * Math.min(1, def.spread.recover * dt);
    this.spread = THREE.MathUtils.clamp(this.spread, base * 0.6, max);

    this._updateCameraRecoil(dt, cmd);
  }

  _updateCameraRecoil(dt, cmd) {
    const def = this.def;
    // Spring the accumulated kick back toward zero.
    const k = 55, d = 9.5;
    this.camRecoilVel.x += -this.camRecoil.x * k * dt;
    this.camRecoilVel.y += -this.camRecoil.y * k * dt;
    this.camRecoilVel.multiplyScalar(Math.max(0, 1 - d * dt));
    this.camRecoil.x += this.camRecoilVel.x * dt;
    this.camRecoil.y += this.camRecoilVel.y * dt;

    // Apply as a *delta* against the player's aim so the recoil recentres
    // rather than permanently rotating the view.
    const player = this.engine.player;
    const dPitch = this.camRecoil.y - this.appliedRecoil.y;
    const dYaw = this.camRecoil.x - this.appliedRecoil.x;
    player.pitch += dPitch;
    player.yaw += dYaw;
    this.appliedRecoil.copy(this.camRecoil);
  }

  fire(ads = 0) {
    const def = this.def;
    this.ammo--;
    this.shotsFired++;
    this.nextShotTime = this.time + 60 / def.rpm;

    const camera = this.engine.camera;
    camera.getWorldDirection(this._dir);
    this._origin.setFromMatrixPosition(camera.matrixWorld);

    // Spread cone, sampled uniformly over the disc.
    const halfAngle = THREE.MathUtils.degToRad(this.spread);
    if (halfAngle > 1e-5) {
      const r = Math.sqrt(Math.random()) * Math.tan(halfAngle);
      const a = Math.random() * Math.PI * 2;
      const up = Math.abs(this._dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(this._dir, up).normalize();
      const realUp = new THREE.Vector3().crossVectors(right, this._dir).normalize();
      this._dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(realUp, Math.sin(a) * r).normalize();
    }

    // Bloom the cone for the next shot.
    this.spread = Math.min(
      THREE.MathUtils.lerp(def.spread.hipMax, def.spread.adsMax, ads),
      this.spread + def.spread.growth * (1 - ads * 0.55),
    );

    // Camera kick follows the weapon's designed recoil pattern rather than a
    // coin flip. `burst` counts shots since the trigger was last released, so
    // the pattern always starts at index 0 on the first round: the first shot
    // of a burst is dead straight and the climb is repeatable from there.
    // 15% noise keeps it from feeling like the view is on rails.
    const pat = def.pattern;
    const step = pat ? pat[this.burst % pat.length] : [0, 1];
    const jitter = 1 + (Math.random() - 0.5) * 0.30;
    const scale = 1 - ads * 0.35;
    this.camRecoilVel.y += THREE.MathUtils.degToRad(def.camKick.pitch) * step[1] * jitter * 24 * scale;
    this.camRecoilVel.x += THREE.MathUtils.degToRad(def.camKick.yaw) * step[0] * jitter * 26 * scale;

    this.engine.viewmodel.addRecoil(def, this.burst);
    this.burst++;

    const isTracer = this.shotsFired % def.tracerEvery === 0;
    this.onFire?.(this._origin, this._dir, isTracer);

    // Hitscan against the level.
    this.raycaster.set(this._origin, this._dir);
    const hits = this.raycaster.intersectObject(this.engine.level.root, true);
    if (hits.length > 0) {
      const h = hits[0];
      this.onHit?.(h.point, h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : this._dir.clone().negate(), h.object, h.distance);
      return h;
    }
    return null;
  }

  damageAt(distance) {
    const f = this.def.damageFalloff;
    for (let i = 0; i < f.length - 1; i++) {
      if (distance <= f[i + 1][0]) {
        const t = (distance - f[i][0]) / (f[i + 1][0] - f[i][0]);
        return this.def.damage * THREE.MathUtils.lerp(f[i][1], f[i + 1][1], t);
      }
    }
    return this.def.damage * f[f.length - 1][1];
  }
}
