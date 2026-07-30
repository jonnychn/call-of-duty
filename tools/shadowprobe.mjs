#!/usr/bin/env node
// Why is nothing casting at street level? Dumps the cascade rig and then does
// a set of non-cumulative A/B renders at one pose, each isolating one suspect.
//
// Uses the readPixels capture (see atmoshot.mjs) — the compositor path cannot
// be trusted at SwiftShader frame times.

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);
const URL_BASE = args.url || 'http://127.0.0.1:5173/';
const W = parseInt(args.width || '640', 10);
const H = parseInt(args.height || '360', 10);
const OUT = args.out || 'shots/atmo/shadow';
const QUALITY = args.quality || 'high';
mkdirSync(OUT, { recursive: true });

const POSE = { pos: [0, 1.6, 44], yaw: 178, pitch: 26 }; // wpnSky

const pre = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: pre,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 200)); });

await page.goto(`${URL_BASE}?quality=${QUALITY}&tod=${args.tod || 'afternoon'}&autostart=1`,
  { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction(() => window.__engine?.running && window.__engine.frame > 3,
  null, { timeout: 300000, polling: 500 });

await page.evaluate((p) => {
  const e = window.__engine;
  e.debug.peaceful = true;
  e.debug.forceAds = false;
  e.player.teleport(p.pos[0], p.pos[1] - 1.59, p.pos[2]);
  e.player.yaw = p.yaw * Math.PI / 180;
  e.player.pitch = p.pitch * Math.PI / 180;
  e.player.velocity.set(0, 0, 0);
  e.hud?.setHealth(100);
  for (let i = 0; i < 6; i++) e.tick();
  e.stop();
}, POSE);

// --- rig dump --------------------------------------------------------------
console.log('rig', JSON.stringify(await page.evaluate(() => {
  const e = window.__engine, a = e.atmosphere, r = e.renderer;
  let vis = 0, casters = 0, receivers = 0, csmMats = 0, stdMats = 0;
  const mats = new Set();
  e.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.visible) vis++;
    if (o.castShadow) casters++;
    if (o.receiveShadow) receivers++;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || mats.has(m)) continue;
      mats.add(m);
      if (m.isMeshStandardMaterial) stdMats++;
      if (m.defines && m.defines.USE_CSM) csmMats++;
    }
  });
  return {
    meshes: vis, casters, receivers, stdMats, csmMats,
    shadowType: r.shadowMap.type, reversedDepth: !!r.reverseDepthBuffer,
    fovNow: +e.camera.fov.toFixed(2),
    csm: a.csm ? {
      cascades: a.csm.cascades, maxFar: a.csm.maxFar,
      breaks: a.csm.breaks.map((b) => +b.toFixed(3)),
      lightDir: a.csm.lightDirection.toArray().map((v) => +v.toFixed(3)),
      lights: a.csm.lights.map((l) => ({
        extent: +(l.shadow.camera.right - l.shadow.camera.left).toFixed(1),
        near: l.shadow.camera.near, far: l.shadow.camera.far,
        bias: l.shadow.bias, normalBias: l.shadow.normalBias,
        map: !!l.shadow.map, intensity: +l.intensity.toFixed(2),
        pos: l.position.toArray().map((v) => +v.toFixed(1)),
        dist: +l.position.distanceTo(e.camera.position).toFixed(1),
      })),
    } : null,
  };
}, null), null, 2));

const CAPTURE = `
  (async () => {
    const e = window.__engine;
    for (let i = 0; i < 8; i++) { e.tick(); await new Promise(r => requestAnimationFrame(r)); }
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
    for (let y = 0; y < h; y++) id.data.set(px.subarray((h-1-y)*w*4, (h-y)*w*4), y*w*4);
    for (let i = 3; i < id.data.length; i += 4) id.data[i] = 255;
    ctx.putImageData(id, 0, 0);
    // Standard deviation over an 8x8 grid of block means: a frame with cast
    // shadows has far more large-scale luminance variance than a flat one.
    let sum = 0, sum2 = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126*px[i] + 0.7152*px[i+1] + 0.0722*px[i+2];
      sum += l; sum2 += l*l; n++;
    }
    const mean = sum/n;
    return { mean: +mean.toFixed(2), sd: +Math.sqrt(sum2/n - mean*mean).toFixed(2),
             png: cv.toDataURL('image/png') };
  })()
`;

const RESET = `
  const e = window.__engine, r = e.renderer, a = e.atmosphere;
  const d = window.__sdef ||= {
    type: r.shadowMap.type,
    bias: a.csm ? a.csm.lights.map(l => l.shadow.bias) : [],
    nbias: a.csm ? a.csm.lights.map(l => l.shadow.normalBias) : [],
  };
  const recompile = () => e.scene.traverse(o => { if (o.material) (Array.isArray(o.material)?o.material:[o.material]).forEach(m => m.needsUpdate = true); });
  r.shadowMap.enabled = true;
  r.shadowMap.type = d.type;
  if (a.csm) a.csm.lights.forEach((l, i) => { l.shadow.bias = d.bias[i]; l.shadow.normalBias = d.nbias[i]; l.visible = true; });
  recompile();
`;

const CASES = {
  'default': '',
  // BasicShadowMap takes the #else branch, bypassing the PCSS chunk entirely.
  'basic-shadowmap': 'r.shadowMap.type = 0; recompile();',
  'zero-bias': 'a.csm.lights.forEach(l => { l.shadow.bias = 0; l.shadow.normalBias = 0; });',
  'shadows-off': 'r.shadowMap.enabled = false; recompile();',
  'only-cascade0': 'a.csm.lights.forEach((l, i) => { if (i > 0) l.visible = false; }); recompile();',
  'only-far-cascades': 'a.csm.lights.forEach((l, i) => { if (i === 0) l.visible = false; }); recompile();',
};

const results = {};
for (const [name, change] of Object.entries(CASES)) {
  await page.evaluate(`${RESET}\n${change}`);
  const r = await page.evaluate(CAPTURE);
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.png.split(',')[1], 'base64'));
  delete r.png;
  results[name] = r;
  console.log(name.padEnd(20), JSON.stringify(r));
}
writeFileSync(`${OUT}/shadow.json`, JSON.stringify(results, null, 2));
await browser.close();
