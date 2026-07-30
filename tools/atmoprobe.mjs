#!/usr/bin/env node
// Non-cumulative bisect of a dark frame, using a readPixels capture rather
// than page.screenshot.
//
// The compositor path is not usable for this: at SwiftShader frame times the
// headless rasteriser hands back partially-updated surfaces, which read as
// "black frame with a correct strip down one edge" and make every luminance
// number meaningless. Driving the loop by hand and reading the default
// framebuffer back in the same task as the draw removes that variable.

import { chromium } from 'playwright';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);
const URL_BASE = args.url || 'http://127.0.0.1:5173/';
const W = parseInt(args.width || '480', 10);
const H = parseInt(args.height || '270', 10);
const OUT = args.out || 'shots/atmo/probe';
mkdirSync(OUT, { recursive: true });

const pre = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath: pre,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 240)); });

await page.goto(`${URL_BASE}?quality=${args.quality || 'medium'}&tod=${args.tod || 'afternoon'}&autostart=1`,
  { waitUntil: 'domcontentloaded', timeout: 240000 });
await page.waitForFunction(() => window.__engine?.running && window.__engine.frame > 3,
  null, { timeout: 300000, polling: 500 });

await page.evaluate(() => {
  const e = window.__engine;
  e.debug.peaceful = true;
  e.player.teleport(0, 0.01, 42);
  e.player.yaw = Math.PI;
  e.player.pitch = -0.05;
  e.stop();
  // Stash defaults so every case starts from the same state.
  const p = e.postfx;
  window.__def = {
    gtao: p.gtao.enabled, godrays: p.godrays.enabled, bloom: p.bloom.enabled,
    exposurePass: p.exposurePass.enabled, autoExp: p.tonemap.uniforms.autoExposure.value,
    exposure: p.tonemap.uniforms.exposure.value,
    contrast: p.tonemap.uniforms.contrast.value,
    vignette: p.tonemap.uniforms.vignette.value,
    envI: e.scene.environmentIntensity,
  };
});

const CASES = {
  'full-chain': '',
  'gtao-off': 'p.gtao.enabled = false;',
  'godrays-off': 'p.godrays.enabled = false;',
  'bloom-off': 'p.bloom.enabled = false;',
  'exposurepass-off': 'p.exposurePass.enabled = false; p.tonemap.uniforms.autoExposure.value = 0;',
  'vignette-off': 'p.tonemap.uniforms.vignette.value = 0;',
  'contrast-1': 'p.tonemap.uniforms.contrast.value = 1;',
  'exposure-x8': 'p.tonemap.uniforms.exposure.value = d.exposure * 8;',
  'shadows-off': 'e.renderer.shadowMap.enabled = false; e.scene.traverse(o=>{if(o.material){(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.needsUpdate=true);}});',
  'no-post': 'p.enabled = false;',
};

const RESET = `
  const e = window.__engine, p = e.postfx, d = window.__def;
  p.enabled = true;
  p.gtao.enabled = d.gtao; p.godrays.enabled = d.godrays; p.bloom.enabled = d.bloom;
  p.exposurePass.enabled = d.exposurePass;
  p.tonemap.uniforms.autoExposure.value = d.autoExp;
  p.tonemap.uniforms.exposure.value = d.exposure;
  p.tonemap.uniforms.contrast.value = d.contrast;
  p.tonemap.uniforms.vignette.value = d.vignette;
  e.scene.environmentIntensity = d.envI;
  e.renderer.shadowMap.enabled = true;
`;

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
    let sum = 0, max = 0;
    const bins = new Array(8).fill(0);
    for (let i = 0; i < px.length; i += 4) {
      const l = (0.2126 * px[i] + 0.7152 * px[i+1] + 0.0722 * px[i+2]) / 255;
      sum += l; if (l > max) max = l;
      bins[Math.min(7, Math.floor(l * 8))]++;
    }
    const n = px.length / 4;
    return { mean: +(sum / n * 255).toFixed(2), max: +(max * 255).toFixed(0),
             bins: bins.map(b => +(b / n).toFixed(3)) };
  })()
`;

const results = {};
for (const [name, change] of Object.entries(CASES)) {
  await page.evaluate(`${RESET}\n${change}`);
  const r = await page.evaluate(CAPTURE);
  results[name] = r;
  console.log(name.padEnd(20), JSON.stringify(r));
}
writeFileSync(`${OUT}/probe.json`, JSON.stringify(results, null, 2));
await browser.close();
