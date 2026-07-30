import * as THREE from 'three';
import { Enemy, STATE } from './Enemy.js';

// Spawns and drives the hostile force. Enemies are updated on a rotating
// budget: only a slice re-runs expensive line-of-sight raycasts each frame,
// which keeps a 20-strong squad off the frame-time budget.

const LOS_PER_FRAME = 4;

export class AISystem {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.enemies = [];
    this.losCursor = 0;
    this.killCount = 0;
  }

  spawnWave(count = 8) {
    const level = this.engine.level;
    const spots = level.coverPoints.length ? level.coverPoints : [new THREE.Vector3()];
    const player = this.engine.player.position;
    for (let i = 0; i < count; i++) {
      // Spawn out of the player's immediate view but within the arena.
      let p = null;
      for (let attempt = 0; attempt < 24; attempt++) {
        const c = spots[Math.floor(Math.random() * spots.length)];
        const cand = c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4));
        cand.y = 0;
        if (cand.distanceTo(player) > 18) { p = cand; break; }
      }
      if (!p) continue;
      const e = new Enemy(this.engine, p);
      e.mesh.rotation.y = Math.random() * Math.PI * 2;
      this.enemies.push(e);
    }
    return this.enemies.length;
  }

  /** Nearest live enemy whose hit-zone hierarchy contains `object`. */
  enemyForObject(object) {
    let o = object;
    while (o) {
      const found = this.enemies.find((e) => e.mesh === o);
      if (found) return found;
      o = o.parent;
    }
    return null;
  }

  /** All live enemy meshes, for raycasting. */
  hitTargets() {
    return this.enemies.filter((e) => e.alive).map((e) => e.mesh);
  }

  /** Called when the player fires so nearby enemies react to the noise. */
  onNoise(position, radius = 45) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.mesh.position.distanceTo(position) < radius) {
        e.alertness = Math.min(1, e.alertness + 0.6);
        e.lastSeen = position.clone();
        if (e.state === STATE.IDLE) e.setState(STATE.ALERT);
      }
    }
  }

  update(dt) {
    const playerPos = this.engine.camera.position;
    // Stagger the LOS work across frames.
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const doLos = ((i + this.losCursor) % Math.max(1, Math.ceil(this.enemies.length / LOS_PER_FRAME))) === 0;
      e._skipLos = !doLos;
      e.update(dt, playerPos);
    }
    this.losCursor++;

    const dead = this.enemies.filter((e) => !e.alive && e.stateTime > 12);
    for (const e of dead) {
      e.dispose();
      this.enemies.splice(this.enemies.indexOf(e), 1);
    }
  }

  get aliveCount() {
    return this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
  }
}
