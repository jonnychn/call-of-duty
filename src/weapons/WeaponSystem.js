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

  canFire() {
    return !this.reloading && this.ammo > 0 && this.time >= this.nextShotTime;
  }

  startReload() {
    if (this.reloading || this.ammo === this.def.magazine || this.reserve <= 0) return;
    this.reloading = true;
    const dur = this.ammo === 0 ? this.def.reloadEmptyTime : this.def.reloadTime;
    this.reloadEnds = this.time + dur;
    this.engine.viewmodel.startReload(dur);
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

    // Camera kick: mostly up, alternating horizontally so long bursts draw
    // the characteristic wandering climb instead of a straight vertical line.
    const sign = (this.shotsFired % 2 === 0) ? 1 : -1;
    const scale = 1 - ads * 0.35;
    this.camRecoilVel.y += THREE.MathUtils.degToRad(def.camKick.pitch) * 24 * scale;
    this.camRecoilVel.x += THREE.MathUtils.degToRad(def.camKick.yaw) * sign * (0.5 + Math.random()) * 18 * scale;

    this.engine.viewmodel.addRecoil(def);

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
