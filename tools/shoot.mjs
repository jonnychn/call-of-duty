#!/usr/bin/env node
// Screenshot harness for the visual-review loop.
//
//   node tools/shoot.mjs --out shots/ --shots default
//   node tools/shoot.mjs --out shots/ --tod dusk --pose rooftop
//   node tools/shoot.mjs --out shots/ --pose street --build
//
// Use --build while other agents are editing: it snapshots the app to a temp
// dir and serves that, so HMR cannot reload the page out from under the run.
//
// Boots the game in headless Chromium with a real GPU-less WebGL2 context
// (SwiftShader), drives the camera to fixed poses, and writes PNGs. Also
// captures console errors so a broken build fails loudly instead of
// producing a black frame.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import path from 'node:path';

// A bare flag is `true`. The previous version wrote `arr[i+1]?.startsWith('--')
// ? true : arr[i+1]`, which yields `undefined` — i.e. falsy — for a flag that
// happens to be the LAST argument, because there is no next element to test.
// So `--build`, `--dom` and `--nolock` silently did nothing in that position.
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (!a.startsWith('--')) return acc;
    const next = arr[i + 1];
    acc.push([a.slice(2), next === undefined || next.startsWith('--') ? true : next]);
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

  // --- material close-ups -------------------------------------------------
  // Nose-to-nose framings, ~1-2 m from the surface. The `materials` set looks
  // at whole walls and floors, which judges tiling and value range but cannot
  // judge whether the micro detail survives at the distance a player actually
  // fights at.
  matBrick:    { pos: [-8.9, 1.5, 37.2], yaw: 270, pitch: 0 },   // brick facade, +x face
  matRoad:     { pos: [0, 1.15, 21.4], yaw: 180, pitch: -46 },   // road + painted markings
  matGravel:   { pos: [-18, 1.15, 2.5], yaw: 178, pitch: -52 },  // market gravel
  matPave:     { pos: [4, 1.15, 31], yaw: 190, pitch: -55 },     // pavement concrete
  matWood:     { pos: [-11.3, 1.25, 25.6], yaw: 245, pitch: -12 }, // shop timber
  matTarp:     { pos: [-8.2, 1.5, 28.4], yaw: 268, pitch: 26 },  // awning canvas underside
  matGlass:    { pos: [-5.2, 1.6, 28.4], yaw: 268, pitch: 4 },   // shopfront glazing
  matRust:     { pos: [-8.4, 1.4, -13.6], yaw: 150, pitch: -4 }, // container / steel

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
  matClose: ['matBrick', 'matRoad', 'matGravel', 'matPave', 'matWood', 'matTarp', 'matGlass', 'matRust'],
  level: ['street', 'arch', 'courtyard', 'shopFront', 'shopIn', 'rooftop', 'market', 'alleyDeep'],
  level2: ['throughArch', 'minaret', 'terrace', 'vista', 'alley', 'sunGlare'],
  weapons: ['wpnHip', 'wpnAds', 'wpnSky', 'wpnSkyAds', 'wpnDark'],
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

/** Places the camera and forces review-mode state for one pose. */
async function applyPose(page, pose) {
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
}

/** Waits for the engine to be up, e.g. after an HMR reload wiped the context. */
async function waitForEngine(page) {
  await page.waitForFunction(
    () => window.__engine && window.__engine.frame > 2,
    null,
    { timeout: TIMEOUT, polling: 250 },
  );
}

/**
 * Captures one frame.
 *
 * Neither `page.screenshot()` nor `canvas.toDataURL()` is trustworthy here.
 * SwiftShader takes about a second per frame, and the headless compositor
 * hands back partially-rasterised tiles — that is the source of every
 * "left edge is correct, rest of the frame is black" image, which reads as a
 * catastrophic lighting bug and is purely a capture artefact. It also poisons
 * any luminance measured from the result.
 *
 * So: stop the render loop, drive frames by hand, and read the default
 * framebuffer with raw `gl.readPixels` in the same task as the final draw.
 * The HUD is a DOM overlay and is therefore absent from these captures, which
 * is what you want when judging lighting; pass `--dom` for a screenshot that
 * includes it (and accept the tearing).
 */
async function capture(page, file, pose) {
  if (args.dom) {
    await page.screenshot({ path: file, timeout: SHOT_TIMEOUT });
    return;
  }
  // Several agents edit source while runs are in flight, and every Vite HMR
  // reload destroys the execution context mid-capture. Retry a few times —
  // though under continuous editing the dev server cannot be made reliable at
  // all, which is what --build is for.
  for (let attempt = 1; ; attempt++) {
    try {
      return await captureOnce(page, file, pose);
    } catch (e) {
      const transient = /Execution context was destroyed|Target closed|Most likely the page has been closed/i.test(String(e));
      if (!transient || attempt >= 4) {
        if (transient) {
          throw new Error(
            'page kept reloading mid-capture (HMR). Another agent is editing '
            + 'source. Re-run with --build for a frozen snapshot that cannot reload.',
          );
        }
        throw e;
      }
      console.log(`[shoot] page reloaded mid-capture (HMR); retry ${attempt}/3`);
      await waitForEngine(page);
      await applyPose(page, pose);
    }
  }
}

async function captureOnce(page, file, pose) {
  const dataUrl = await page.evaluate(async (frames) => {
    const e = window.__engine;
    e.stop();
    for (let i = 0; i < frames; i++) {
      e.tick();
      await new Promise((r) => requestAnimationFrame(r));
    }
    e.tick();

    const gl = e.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    // readPixels is bottom-up; flip into an ImageData and force alpha opaque.
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const id = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      id.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    }
    for (let i = 3; i < id.data.length; i += 4) id.data[i] = 255;
    ctx.putImageData(id, 0, 0);
    return cv.toDataURL('image/png');
  }, pose.ads ? 26 : 18);

  await writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  // The loop was stopped for the capture; restart it for the next pose.
  await page.evaluate(() => window.__engine.start());
}

/**
 * Builds a frozen snapshot of the app into a temp dir and serves it, so no
 * amount of concurrent source editing can reload the page mid-run. This is the
 * only reliable way to review while other agents are working; the dev server's
 * HMR will otherwise destroy the execution context at random.
 *
 * Returns { url, stop }.
 */
async function startFrozenServer() {
  const { execFile, spawn } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const outDir = `/tmp/cod-frozen-${process.pid}`;

  console.log('[shoot] building frozen snapshot...');
  await promisify(execFile)('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: process.cwd(), maxBuffer: 1 << 24,
  });

  const port = 4300 + (process.pid % 500);
  const child = spawn('npx', ['vite', 'preview', '--outDir', outDir, '--port', String(port), '--strictPort'], {
    cwd: process.cwd(), stdio: 'ignore', detached: false,
  });
  const url = `http://127.0.0.1:${port}/`;

  // Wait for the preview server to answer rather than guessing at a delay.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[shoot] frozen snapshot on ${url}`);
  return {
    url,
    stop: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const releaseLock = await acquireLock();
  const frozen = args.build ? await startFrozenServer() : null;
  const baseUrl = frozen ? frozen.url : URL_BASE;

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

  // A missing favicon is not a build failure. Left unfiltered it was the only
  // console error in every clean run, so the harness exited non-zero and
  // reported failure on runs that had rendered perfectly — the kind of false
  // signal that teaches you to ignore real ones.
  //
  // The 404 is suppressed by URL, not by message text: Chromium's console text
  // for a failed request does not name the resource, so a text filter broad
  // enough to catch it ("Failed to load resource ... 404") would equally
  // swallow a genuinely missing module. index.html now ships an inline icon so
  // the request should not happen at all; this is belt and braces.
  const errors = [];
  const benignUrls = new Set();
  page.on('response', (r) => {
    if (r.status() === 404 && /favicon/i.test(r.url())) benignUrls.add(r.url());
  });
  page.on('requestfailed', (r) => {
    if (!/favicon/i.test(r.url())) errors.push(`request failed: ${r.url()}`);
  });
  let sawResourceError = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') {
      // Count bare resource errors; reconciled against benignUrls below.
      if (/Failed to load resource/i.test(m.text())) sawResourceError++;
      else errors.push(m.text());
    }
    if (process.env.VERBOSE) console.log(`[${m.type()}]`, m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  const url = `${baseUrl}?quality=${QUALITY}&tod=${TOD}&autostart=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  // Wait for the engine to finish baking and start its loop.
  await page.waitForFunction(
    () => window.__engine && window.__engine.running && window.__engine.frame > 5,
    null,
    { timeout: TIMEOUT, polling: 250 },
  );

  // --pose wins over --shots, and neither falls through to the default set when
  // it was asked for explicitly. The old expression looked up
  // SHOT_SETS[args.shots || 'default'] first, which always matched, so --pose
  // was silently ignored and every single-pose request rendered all six of the
  // default set — minutes of SwiftShader time per invocation, for one image.
  const names = args.pose
    ? String(args.pose).split(',').map((s) => s.trim()).filter(Boolean)
    : (SHOT_SETS[args.shots] || SHOT_SETS.default);
  const written = [];

  for (const name of names) {
    const pose = POSES[name];
    if (!pose) { console.error(`unknown pose ${name}`); continue; }

    await applyPose(page, pose);

    // Let the ADS blend, exposure adaptation, and shadow re-fit settle. This
    // is wall-clock, and SwiftShader runs at well under 1fps, so it is far
    // more frames than it looks.
    await page.waitForTimeout(pose.ads ? 2500 : 1200);

    const file = path.join(OUT, `${name}.png`);
    await capture(page, file, pose);
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

  // Any resource error beyond the ones we matched to a benign URL is real.
  const unexplained = sawResourceError - benignUrls.size;
  if (unexplained > 0) {
    errors.push(`${unexplained} unexplained resource load failure(s) — run with VERBOSE=1 to see them`);
  }

  if (errors.length) {
    console.error(`\n${errors.length} console error(s):`);
    for (const e of errors.slice(0, 12)) console.error('  ', e);
  }

  await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ stats, errors, written, tod: TOD, quality: QUALITY }, null, 2));
  await browser.close();
  frozen?.stop();
  releaseLock();
  process.exit(errors.length ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
