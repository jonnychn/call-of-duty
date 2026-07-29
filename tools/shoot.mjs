#!/usr/bin/env node
// Screenshot harness for the visual-review loop.
//
//   node tools/shoot.mjs --out shots/ --shots default
//   node tools/shoot.mjs --out shots/ --tod dusk --pose rooftop
//
// Boots the game in headless Chromium with a real GPU-less WebGL2 context
// (SwiftShader), drives the camera to fixed poses, and writes PNGs. Also
// captures console errors so a broken build fails loudly instead of
// producing a black frame.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const OUT = args.out || 'shots';
const URL_BASE = args.url || 'http://127.0.0.1:5173/';
const WIDTH = parseInt(args.width || '1920', 10);
const HEIGHT = parseInt(args.height || '1080', 10);
const QUALITY = args.quality || 'high';
const TOD = args.tod || 'afternoon';
const TIMEOUT = parseInt(args.timeout || '180000', 10);
const SHOT_TIMEOUT = parseInt(args.shotTimeout || '180000', 10);

/**
 * Fixed camera poses. Each is [x, y, z, yawDeg, pitchDeg] plus an optional
 * state override. Chosen to cover the shots a reviewer would actually judge:
 * a street-level sightline, an interior-ish corner, a long vista, weapon detail.
 */
const POSES = {
  street:      { pos: [0, 1.6, 42], yaw: 180, pitch: -3 },
  alley:       { pos: [-14, 1.6, -12], yaw: 115, pitch: 0 },
  vista:       { pos: [26, 1.6, 58], yaw: 205, pitch: -6 },
  containers:  { pos: [-8, 1.6, -14], yaw: 150, pitch: -2 },
  weapon:      { pos: [0, 1.6, 44], yaw: 178, pitch: 2, ads: true },
  sunGlare:    { pos: [0, 1.6, 20], yaw: 236, pitch: 8 },
  ground:      { pos: [4, 1.6, 30], yaw: 190, pitch: -42 },
  wall:        { pos: [-20.5, 1.6, 6], yaw: 90, pitch: 0 },

  // --- level-design poses -------------------------------------------------
  arch:        { pos: [0, 1.6, 56], yaw: 180, pitch: 4 },       // under the gatehouse
  throughArch: { pos: [0, 1.6, 78], yaw: 0, pitch: 2 },         // looking back south
  courtyard:   { pos: [22, 1.6, 47], yaw: 195, pitch: 3 },      // market yard + stair
  shopFront:   { pos: [-4.5, 1.6, 28.4], yaw: 90, pitch: 0 },   // shopfront from the road
  shopIn:      { pos: [-13.5, 1.6, 28.6], yaw: 110, pitch: -2 },// inside the shop
  rooftop:     { pos: [16, 8.2, 24], yaw: 145, pitch: -8 },     // east roof (deck at 6.6 m)
  market:      { pos: [-18, 1.6, 1], yaw: 178, pitch: 2 },      // southern square
  alleyDeep:   { pos: [-24, 1.6, -10.3], yaw: 270, pitch: 0 },  // alley toward the street
  minaret:     { pos: [-2, 1.6, 86], yaw: 165, pitch: 14 },     // far quarter landmark
  terrace:     { pos: [27.5, 8.1, 58], yaw: 215, pitch: -6 },   // courtyard terrace (slab at 6.46 m)

  // --- weapon poses -------------------------------------------------------
  wpnHip:      { pos: [0, 1.6, 44], yaw: 178, pitch: 0 },        // hip framing
  wpnAds:      { pos: [0, 1.6, 44], yaw: 178, pitch: 0, ads: true },
  wpnSky:      { pos: [0, 1.6, 44], yaw: 178, pitch: 26 },       // clean sky backdrop
  wpnSkyAds:   { pos: [0, 1.6, 44], yaw: 178, pitch: 26, ads: true },
  wpnDark:     { pos: [-13.5, 1.6, 28.6], yaw: 110, pitch: -2 }, // interior, low light
};

const SHOT_SETS = {
  default: ['street', 'alley', 'vista', 'containers', 'weapon', 'sunGlare'],
  quick: ['street', 'weapon'],
  materials: ['ground', 'wall', 'containers'],
  level: ['street', 'arch', 'courtyard', 'shopFront', 'shopIn', 'rooftop', 'market', 'alleyDeep'],
  level2: ['throughArch', 'minaret', 'terrace', 'vista', 'alley', 'sunGlare'],
  all: Object.keys(POSES),
};

// ---------------------------------------------------------------------------
// Global render lock.
//
// SwiftShader saturates every core it can reach. Several agents screenshotting
// at once drove this box to load average 23 on 4 cores, at which point a single
// 1000x560 frame took ~3 minutes and some came back part-rendered — which reads
// as a lighting bug and is not one. One run at a time is dramatically faster in
// wall-clock terms than N runs fighting each other, so instances queue here
// rather than competing.
// ---------------------------------------------------------------------------

const LOCK = '/tmp/cod-shoot.lock';
const LOCK_STALE_MS = 15 * 60 * 1000;

async function acquireLock() {
  if (args.nolock) return () => {};
  const started = Date.now();
  for (;;) {
    try {
      // Atomic: fails if the file already exists.
      writeFileSync(LOCK, `${process.pid} ${Date.now()}\n`, { flag: 'wx' });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { unlinkSync(LOCK); } catch { /* already gone */ }
      };
      // A crashed run must not wedge every other agent forever.
      process.on('exit', release);
      process.on('SIGINT', () => { release(); process.exit(130); });
      process.on('SIGTERM', () => { release(); process.exit(143); });
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Reap a lock whose owner died without cleaning up.
      try {
        const [pid, at] = readFileSync(LOCK, 'utf8').trim().split(/\s+/);
        const age = Date.now() - Number(at);
        let alive = true;
        try { process.kill(Number(pid), 0); } catch { alive = false; }
        if (!alive || age > LOCK_STALE_MS) {
          console.log(`[shoot] clearing stale lock from pid ${pid}`);
          unlinkSync(LOCK);
          continue;
        }
      } catch { /* lock vanished under us; just retry */ }

      if (Date.now() - started > LOCK_STALE_MS) {
        throw new Error('timed out waiting for the render lock');
      }
      if (!acquireLock.warned) {
        console.log('[shoot] another render is in progress, queueing...');
        acquireLock.warned = true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const releaseLock = await acquireLock();

  // The sandbox ships a preinstalled Chromium that may not match the revision
  // this Playwright build expects; prefer it over a download when present.
  const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || preinstalled || undefined,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-lcd-text',
      '--force-device-scale-factor=1',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (process.env.VERBOSE) console.log(`[${m.type()}]`, m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  const url = `${URL_BASE}?quality=${QUALITY}&tod=${TOD}&autostart=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  // Wait for the engine to finish baking and start its loop.
  await page.waitForFunction(
    () => window.__engine && window.__engine.running && window.__engine.frame > 5,
    null,
    { timeout: TIMEOUT, polling: 250 },
  );

  const names = SHOT_SETS[args.shots || 'default'] || (args.pose ? [args.pose] : SHOT_SETS.default);
  const written = [];

  for (const name of names) {
    const pose = POSES[name];
    if (!pose) { console.error(`unknown pose ${name}`); continue; }

    await page.evaluate((p) => {
      const e = window.__engine;
      e.debug.peaceful = true;      // no AI, no damage wash over the art
      e.debug.forceAds = !!p.ads;   // the controller owns ads; ask for it properly
      e.player.teleport(p.pos[0], p.pos[1] - 1.59, p.pos[2]);
      e.player.yaw = p.yaw * Math.PI / 180;
      e.player.pitch = p.pitch * Math.PI / 180;
      e.player.velocity.set(0, 0, 0);
      e.hud?.setHealth(100);
    }, pose);

    // Let the ADS blend, exposure adaptation, and shadow re-fit settle. This
    // is wall-clock, and SwiftShader runs at well under 1fps, so it is far
    // more frames than it looks.
    await page.waitForTimeout(pose.ads ? 2500 : 1200);

    const file = path.join(OUT, `${name}.png`);
    // SwiftShader renders the full post chain at well under 1fps, so a frame
    // can take far longer than Playwright's 30s default.
    await page.screenshot({ path: file, timeout: SHOT_TIMEOUT });
    written.push(file);
    console.log('wrote', file);
  }

  const stats = await page.evaluate(() => {
    const e = window.__engine;
    return {
      fps: Math.round(e.fps),
      calls: e.renderer.info.render.calls,
      tris: e.renderer.info.render.triangles,
      programs: e.renderer.info.programs?.length ?? 0,
      quality: e.constructor.name,
    };
  });
  console.log('stats', JSON.stringify(stats));

  if (errors.length) {
    console.error(`\n${errors.length} console error(s):`);
    for (const e of errors.slice(0, 12)) console.error('  ', e);
  }

  await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ stats, errors, written, tod: TOD, quality: QUALITY }, null, 2));
  await browser.close();
  releaseLock();
  process.exit(errors.length ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
