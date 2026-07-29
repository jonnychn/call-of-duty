import * as THREE from 'three';

// Diegetic-ish combat HUD. The crosshair gap is driven by the weapon's live
// spread cone so the reticle always tells the truth about accuracy.

export class HUD {
  /** @param {HTMLElement} root @param {import('../core/Engine.js').Engine} engine */
  constructor(root, engine) {
    this.engine = engine;
    this.el = document.createElement('div');
    this.el.innerHTML = `
      <div class="crosshair">
        <i class="v top"></i><i class="v bottom"></i>
        <i class="h left"></i><i class="h right"></i>
        <span class="dot"></span>
      </div>
      <div class="hitmarker"><i style="left:10px;top:0;width:2px;height:22px"></i><i style="top:10px;left:0;height:2px;width:22px"></i></div>
      <div class="vitals">
        <div class="label">Vitals</div>
        <div class="bar"><div></div></div>
      </div>
      <div class="ammo">
        <div class="count"><span class="mag">30</span><span class="reserve">/210</span></div>
        <div class="name">M4A1</div>
      </div>
      <div class="damage-vignette"></div>
      <div class="perf"></div>
    `;
    root.appendChild(this.el);

    this.crosshair = this.el.querySelector('.crosshair');
    this.marks = {
      top: this.el.querySelector('.v.top'),
      bottom: this.el.querySelector('.v.bottom'),
      left: this.el.querySelector('.h.left'),
      right: this.el.querySelector('.h.right'),
    };
    this.dot = this.el.querySelector('.dot');
    this.hitmarker = this.el.querySelector('.hitmarker');
    this.magEl = this.el.querySelector('.mag');
    this.reserveEl = this.el.querySelector('.reserve');
    this.ammoEl = this.el.querySelector('.ammo');
    this.healthBar = this.el.querySelector('.vitals .bar > div');
    this.damageEl = this.el.querySelector('.damage-vignette');
    this.perfEl = this.el.querySelector('.perf');

    this.hitmarkerTime = 0;
    this.health = 100;
    this.damageFlash = 0;
    this._lastAmmo = -1;
  }

  /** @param {boolean} kill @param {boolean} headshot */
  showHitmarker(kill = false, headshot = false) {
    this.hitmarkerTime = kill ? 0.30 : 0.16;
    this.hitmarker.style.setProperty('--hm', kill ? '#ff3b30' : headshot ? '#ffd23b' : '#ffffff');
    this.hitmarker.classList.toggle('kill', kill);
  }

  setHealth(v) {
    this.health = THREE.MathUtils.clamp(v, 0, 100);
    this.healthBar.style.width = `${this.health}%`;
  }

  takeDamage(amount) {
    this.setHealth(this.health - amount);
    this.damageFlash = 1;
  }

  update(dt) {
    const w = this.engine.weapons;
    const player = this.engine.player;

    // Crosshair gap tracks the real cone-of-fire half-angle projected to px.
    const fovRad = THREE.MathUtils.degToRad(this.engine.camera.fov);
    const pxPerRad = window.innerHeight / (2 * Math.tan(fovRad / 2));
    const gap = THREE.MathUtils.clamp(
      Math.tan(THREE.MathUtils.degToRad(w.spread)) * pxPerRad * 0.5, 2, 26,
    );
    this.marks.top.style.top = `${31 - 9 - gap}px`;
    this.marks.bottom.style.top = `${32 + gap}px`;
    this.marks.left.style.left = `${31 - 9 - gap}px`;
    this.marks.right.style.left = `${32 + gap}px`;

    // Hide the reticle while aiming — the optic replaces it — and while
    // sprinting, when you cannot fire accurately anyway.
    const hide = player.ads > 0.55 || player.sprinting || player.sliding;
    this.crosshair.style.opacity = hide ? '0' : '1';

    if (this.hitmarkerTime > 0) {
      this.hitmarkerTime -= dt;
      this.hitmarker.style.opacity = String(Math.min(1, this.hitmarkerTime / 0.1));
    } else {
      this.hitmarker.style.opacity = '0';
    }

    if (w.ammo !== this._lastAmmo) {
      this.magEl.textContent = String(w.ammo);
      this.reserveEl.textContent = `/${w.reserve}`;
      this.ammoEl.classList.toggle('low', w.ammo <= Math.ceil(w.def.magazine * 0.25));
      this._lastAmmo = w.ammo;
    }

    if (this.damageFlash > 0) {
      this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);
      this.damageEl.style.opacity = String(this.damageFlash * 0.9);
      this.engine.postfx.setDamage(this.damageFlash * 0.5 + (1 - this.health / 100) * 0.25);
    } else {
      const low = Math.max(0, 1 - this.health / 45);
      this.damageEl.style.opacity = String(low * 0.55);
      this.engine.postfx.setDamage(low * 0.3);
    }

    if ((this.engine.frame & 15) === 0) {
      this.perfEl.textContent = `${this.engine.fps.toFixed(0)} FPS · ${this.engine.renderer.info.render.calls} draws · ${(this.engine.renderer.info.render.triangles / 1000).toFixed(0)}k tris`;
    }
  }
}
