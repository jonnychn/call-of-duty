#!/usr/bin/env node
// Lighting-review shooter. Same idea as shoot.mjs but with a longer
// screenshot timeout (SwiftShader needs it at this pass count), the ability to
// take several time-of-day values in one browser session, and a printed
// luminance histogram so "washed out" is a measurement and not a vibe.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const OUT = args.out || 'shots/atmo';
const URL_BASE = args.url || 'http://127.0.0.1:5173/';
const WIDTH = parseInt(args.width || '1280', 10);
const HEIGHT = parseInt(args.height || '720', 10);
const QUALITY = args.quality || 'high';
const TODS = (args.tod || 'afternoon').split(',');
const POSES_ARG = (args.pose || 'street').split(',');

const POSES = {
  street:     { pos: [0, 1.6, 42], yaw: 180, pitch: -3 },
  alley:      { pos: [-14, 1.6, -12], yaw: 115, pitch: 0 },
  vista:      { pos: [26, 1.6, 58], yaw: 205, pitch: -6 },
  containers: { pos: [-8, 1.6, -14], yaw: 150, pitch: -2 },
  weapon:     { pos: [0, 1.6, 44], yaw: 178, pitch: 2, ads: true },
  sunGlare:   { pos: [0, 1.6, 20], yaw: 236, pitch: 8 },
  ground:     { pos: [4, 1.6, 30], yaw: 190, pitch: -42 },
  wall:       { pos: [-20.5, 1.6, 6], yaw: 90, pitch: 0 },
  // Extra angles for judging shadows and aerial perspective specifically.
  shadowCheck: { pos: [6, 1.6, 26], yaw: 250, pitch: -14 },
  awaySun:     { pos: [0, 1.6, 20], yaw: 56, pitch: 0 },
  skyline:     { pos: [10, 1.6, 50], yaw: 200, pitch: 12 },
};

async function main() {
  await mkdir(OUT, { recursive: true });
  const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || preinstalled || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-lcd-text', '--force-device-scale-factor=1', '--enable-webgl',
           '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  page.setDefaultTimeout(180000);

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${URL_BASE}?quality=${QUALITY}&tod=${TODS[0]}&autostart=1`,
    { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction(
    () => window.__engine && window.__engine.running && window.__engine.frame > 5,
    null, { timeout: 300000, polling: 250 });

  // Prove the shadow rig is actually what we think it is before judging pixels.
  console.log('rig', JSON.stringify(await page.evaluate(() => {
    const a = window.__engine.atmosphere;
    const r = window.__engine.renderer;
    return {
      csm: !!a.csm,
      cascades: a.csm ? a.csm.cascades : 0,
      breaks: a.csm ? a.csm.breaks.map((b) => +b.toFixed(3)) : null,
      maxFar: a.csm ? a.csm.maxFar : null,
      cascadeExtent: a.csm ? a.csm.lights.map((l) => +(l.shadow.camera.right * 2).toFixed(1)) : null,
      shadowMapSize: a.csm ? a.csm.shadowMapSize : a.sun.shadow.mapSize.width,
      shadowsEnabled: r.shadowMap.enabled,
      shadowType: r.shadowMap.type,
      patchedMaterials: a._patched ? a._patched.size : 0,
      toneMapping: r.toneMapping,
      env: !!window.__engine.scene.environment,
    };
  })));

  const written = [];
  for (const tod of TODS) {
    await page.evaluate((t) => window.__engine.atmosphere.apply(t), tod);
    for (const name of POSES_ARG) {
      const pose = POSES[name];
      if (!pose) { console.error('unknown pose', name); continue; }
      await page.evaluate((p) => {
        const e = window.__engine;
        e.debug.peaceful = true;
        e.debug.forceAds = !!p.ads;
        e.player.teleport(p.pos[0], p.pos[1] - 1.59, p.pos[2]);
        e.player.yaw = p.yaw * Math.PI / 180;
        e.player.pitch = p.pitch * Math.PI / 180;
        e.player.velocity.set(0, 0, 0);
        e.hud?.setHealth(100);
      }, pose);

      // Drive the frames by hand with the render loop stopped, then read the
      // default framebuffer back with raw readPixels in the same task as the
      // final draw.
      //
      // Neither page.screenshot() nor canvas.toDataURL() is trustworthy here:
      // SwiftShader takes over a second per frame, the headless compositor
      // hands back partially-rasterised tiles (this is what produced all the
      // "left eighth of the frame, rest black" images), and toDataURL on a
      // context without preserveDrawingBuffer races the presentation clear.
      // readPixels on the default framebuffer has neither problem. It also
      // drops the DOM HUD, which is what we want when judging lighting.
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

      const file = path.join(OUT, `${tod}-${name}.png`);
      await writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      written.push(file);

      // Histogram of the actual canvas pixels: 12 luminance buckets plus the
      // 1st/50th/99th percentile, so contrast claims can be checked.
      const hist = await page.evaluate(async (url) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const s = document.createElement('canvas');
        s.width = 256; s.height = 144;
        const g = s.getContext('2d');
        g.drawImage(img, 0, 0, s.width, s.height);
        const d = g.getImageData(0, 0, s.width, s.height).data;
        const bins = new Array(12).fill(0);
        const lums = [];
        for (let i = 0; i < d.length; i += 4) {
          const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          bins[Math.min(11, Math.floor(l * 12))]++;
          lums.push(l);
        }
        lums.sort((a, b) => a - b);
        const q = (p) => lums[Math.floor(p * (lums.length - 1))];
        const n = lums.length;
        return {
          bins: bins.map((b) => +(b / n).toFixed(3)),
          p01: +q(0.01).toFixed(3), p50: +q(0.50).toFixed(3),
          p99: +q(0.99).toFixed(3), mean: +(lums.reduce((a, b) => a + b, 0) / n).toFixed(3),
        };
      }, dataUrl);
      console.log(`${tod}/${name}`, JSON.stringify(hist));
    }
  }

  // renderer.info auto-resets on every internal render() call, so after a
  // composer frame it only describes the last pass. Freeze it for one tick.
  const stats = await page.evaluate(() => {
    const e = window.__engine, r = e.renderer;
    r.info.autoReset = false;
    r.info.reset();
    e.tick();
    const s = {
      calls: r.info.render.calls, tris: r.info.render.triangles,
      programs: r.info.programs?.length ?? 0,
      textures: r.info.memory.textures, geometries: r.info.memory.geometries,
    };
    r.info.autoReset = true;
    return s;
  });
  console.log('stats', JSON.stringify(stats));
  if (errors.length) {
    console.error(`\n${errors.length} console error(s):`);
    for (const e of errors.slice(0, 12)) console.error('  ', e);
  }
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ stats, errors, written }, null, 2));
  await browser.close();
  process.exit(errors.length ? 2 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
