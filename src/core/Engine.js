import * as THREE from 'three';
import { settings, onSettingsChange } from './Settings.js';
import { Input } from './Input.js';
import { Atmosphere } from '../render/Atmosphere.js';
import { PostFX } from '../render/PostFX.js';
import { MaterialLibrary } from '../render/Materials.js';
import { Level } from '../world/Level.js';
import { PlayerController } from '../player/Controller.js';
import { Viewmodel } from '../weapons/Viewmodel.js';
import { WEAPONS } from '../weapons/WeaponDefs.js';
import { WeaponSystem } from '../weapons/WeaponSystem.js';
import { HUD } from '../ui/HUD.js';
import { FXSystem } from '../fx/FXSystem.js';
import { AudioSystem } from '../audio/AudioSystem.js';
import { AISystem } from '../ai/AISystem.js';

const MAX_DT = 1 / 20; // clamp so an alt-tab doesn't teleport the player

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.running = false;
    this.frame = 0;
    this.accumFps = 0;
    this.fps = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,        // SMAA in the post chain handles this
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio * 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = settings.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.06, 900);
    this.scene.add(this.camera);

    this.input = new Input(canvas);
    this.materials = new MaterialLibrary();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._unsubSettings = onSettingsChange(() => this.applySettings());
  }

  async load(onProgress) {
    onProgress?.(0.02, 'baking materials');
    await this.materials.load((p, name) => onProgress?.(0.02 + p * 0.72, `baking ${name}`));

    onProgress?.(0.76, 'building level');
    this.level = new Level(this.materials);
    this.scene.add(this.level.build());

    onProgress?.(0.84, 'lighting');
    this.atmosphere = new Atmosphere(this.scene, this.renderer);

    onProgress?.(0.90, 'player');
    this.player = new PlayerController(this.camera, this.level.collision);
    const spawn = this.level.spawnPoints[0];
    this.player.teleport(spawn.x, spawn.y, spawn.z);
    this.player.yaw = Math.PI;

    onProgress?.(0.93, 'weapons');
    this.viewmodel = new Viewmodel(this.materials.materials);
    this.viewmodel.setEnvironment(this.scene.environment);
    this.weapons = new WeaponSystem(this, WEAPONS.carbine);

    onProgress?.(0.96, 'compiling shaders');
    this.postfx = new PostFX(this.renderer, this.scene, this.camera);
    this.postfx.attachViewmodel(this.viewmodel.scene, this.viewmodel.camera);

    this.fx = new FXSystem(this);
    this.audio = new AudioSystem();
    this.ai = new AISystem(this);
    this.ai.spawnWave(10);

    this.hud = new HUD(document.getElementById('ui-root'), this);
    this._wireCombat();

    this.resize();
    // Warm the shader cache so the first frames don't hitch.
    this.renderer.compile(this.scene, this.camera);
    this.renderer.compile(this.viewmodel.scene, this.viewmodel.camera);

    onProgress?.(1.0, 'ready');
  }

  /**
   * Connects the weapon system to FX, audio, and damage. Kept in one place so
   * the firing pipeline reads top-to-bottom: shot -> effects -> hit -> damage.
   */
  _wireCombat() {
    const muzzleLocal = new THREE.Vector3();
    const worldOrigin = new THREE.Vector3();

    this.weapons.onFire = (origin, dir, isTracer) => {
      muzzleLocal.copy(this.viewmodel.weapon.userData.muzzle);
      this.viewmodel.weapon.localToWorld(muzzleLocal); // viewmodel space
      worldOrigin.copy(origin);
      this.fx.onFire(muzzleLocal, worldOrigin, dir, isTracer);
      this.audio.gunshot(0);
      this.ai.onNoise(this.player.position, 55);
    };

    this.weapons.onHit = (point, normal, object, distance) => {
      const surface = classifySurface(object);
      this.fx.onImpact(point, normal, surface);
      this.audio.impact(surface, distance);
    };

    // Enemy hits are resolved separately: the weapon raycasts level geometry,
    // so we re-cast against enemy bodies and take whichever is closer.
    const enemyRay = new THREE.Raycaster();
    enemyRay.far = 400;
    const origWeaponFire = this.weapons.fire.bind(this.weapons);
    this.weapons.fire = (ads) => {
      const levelHit = origWeaponFire(ads);
      const targets = this.ai.hitTargets();
      if (targets.length === 0) return levelHit;
      enemyRay.set(this.weapons._origin, this.weapons._dir);
      const hits = enemyRay.intersectObjects(targets, true);
      if (hits.length === 0) return levelHit;
      const h = hits[0];
      if (levelHit && levelHit.distance < h.distance) return levelHit;

      const enemy = this.ai.enemyForObject(h.object);
      if (!enemy) return levelHit;
      const zone = h.object.userData.zone || 'torso';
      const dmg = enemy.applyHit(zone, this.weapons.damageAt(h.distance), this.weapons._dir);
      this.fx.onImpact(h.point, this.weapons._dir.clone().negate(), 'flesh');
      this.audio.impact('flesh', h.distance);
      this.hud?.showHitmarker(!enemy.alive, zone === 'head');
      if (!enemy.alive) this.ai.killCount++;
      return h;
    };

    this.onEnemyFire = (enemy, muzzle, dir) => {
      this.fx.tracers.spawn(muzzle, dir, 320, 160);
      this.audio.gunshot(enemy.mesh.position.distanceTo(this.player.position));
      // Resolve against the player as a capsule approximation.
      const toPlayer = new THREE.Vector3().copy(this.camera.position).sub(muzzle);
      const along = toPlayer.dot(dir);
      if (along <= 0) return;
      const perp = toPlayer.clone().addScaledVector(dir, -along).length();
      if (perp < 0.42) this.hud?.takeDamage(9 + Math.random() * 7);
    };
  }

  applySettings() {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio * 2));
    this.renderer.toneMappingExposure = settings.exposure;
    this.camera.fov = settings.fov;
    this.camera.updateProjectionMatrix();
    this.atmosphere?.configureShadowCamera(settings.shadowDistance);
    this.postfx?.applySettings();
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewmodel?.setSize(w, h);
    this.postfx?.setSize(w, h);
    this.fx?.setSize(w, h, this.camera.fov);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      this.tick();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  tick() {
    const dt = Math.min(MAX_DT, this.clock.getDelta());
    this.frame++;
    this.accumFps += (1 / Math.max(dt, 1e-4) - this.accumFps) * 0.06;
    this.fps = this.accumFps;

    const [lookDX, lookDY] = this.input.consumeLook();
    if (this.input.locked) this.player.look(lookDX, lookDY);

    const i = this.input;
    const cmd = {
      forward: (i.down('KeyW') ? 1 : 0) - (i.down('KeyS') ? 1 : 0),
      right: (i.down('KeyD') ? 1 : 0) - (i.down('KeyA') ? 1 : 0),
      jump: i.pressed('Space'),
      sprint: i.down('ShiftLeft') || i.down('ShiftRight'),
      tacSprint: i.down('ShiftLeft') && i.pressed('KeyW'),
      crouch: i.down('ControlLeft') || i.down('KeyC'),
      ads: i.mouseDown(2),
      leanLeft: i.down('KeyQ'),
      leanRight: i.down('KeyE'),
    };

    this.player.update(dt, cmd);
    this.weapons.update(dt, {
      firing: i.mouseDown(0),
      triggerPulled: i.clicked(0),
      reload: i.pressed('KeyR'),
      ads: this.player.ads,
    });
    this.viewmodel.update(dt, this.player, {
      lookDX, lookDY,
      firing: i.mouseDown(0) && this.weapons.canFire(),
    });

    this.ai.update(dt);
    this.fx.update(dt, this.camera);
    this.atmosphere.update(this.camera);
    this._footsteps(dt);

    // Sprint/ADS FOV shaping — the classic speed cue.
    const targetFov = settings.fov
      * THREE.MathUtils.lerp(1, settings.adsFovScale, this.player.ads)
      * (this.player.sprinting ? 1.055 : 1.0)
      * (this.player.sliding ? 1.085 : 1.0);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 9 * dt);
    this.camera.updateProjectionMatrix();

    this.hud?.update(dt);
    this.postfx.render(dt);

    this.input.endFrame();
  }

  /** Fires a step sound each time the viewmodel's bob cycle bottoms out. */
  _footsteps(dt) {
    const p = this.player;
    if (!p.onGround || p.speed < 0.6) { this._stepPhase = 0; return; }
    const rate = p.sprinting ? 2.55 : p.crouching ? 1.2 : 1.85;
    this._stepPhase = (this._stepPhase || 0) + dt * rate * Math.min(1.6, p.speed / 4.3);
    if (this._stepPhase >= 1) {
      this._stepPhase -= 1;
      this.audio.footstep('sand', p.sprinting ? 1.0 : p.crouching ? 0.35 : 0.7);
    }
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this._unsubSettings?.();
    this.input.dispose();
    this.postfx?.dispose();
    this.atmosphere?.dispose();
    this.materials.dispose();
    this.renderer.dispose();
  }
}

/**
 * Maps a hit mesh to an impact-effect surface class. Materials carry their
 * own name from the library, so this stays a lookup rather than a guess.
 */
function classifySurface(object) {
  const name = object?.material?.name || '';
  if (name.includes('container') || name.includes('Metal') || name.includes('Steel') || name.includes('gunmetal')) return 'metal';
  if (name.includes('sand')) return 'sand';
  if (name.includes('road') || name.includes('concrete') || name.includes('plaster')) return 'concrete';
  return 'concrete';
}
