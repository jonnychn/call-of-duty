#!/usr/bin/env node
// Bisects a black frame. Each case is applied to a FRESH state (the previous
// case is undone first), so the luminance numbers are directly comparable —
// a cumulative probe makes every row after the first meaningless.

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));
mkdirSync('shots/probe', { recursive: true });

const browser = await chromium.launch({
  executablePath: preinstalled,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 400)));

await page.goto('http://127.0.0.1:5173/?quality=medium&autostart=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__engine?.running && window.__engine.frame > 5, null, { timeout: 240000, polling: 500 });

await page.evaluate(() => {
  const e = window.__engine;
  e.debug.peaceful = true;
  e.player.teleport(0, 0.01, 42);
  e.player.yaw = Math.PI;
  e.player.pitch = -0.05;
});

function meanLuma(file) {
  const png = PNG.sync.read(readFileSync(file));
  let sum = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    sum += 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
  }
  return sum / (png.data.length / 4);
}

// Each entry restores defaults first, then applies exactly one change.
const RESET = `
  const e = window.__engine, p = e.postfx;
  p.enabled = true;
  for (const pass of p.composer.passes) pass.enabled = true;
  if (p.gtao) p.gtao.enabled = e.constructor && true;
  if (p.tonemap) p.tonemap.uniforms.autoExposure.value = p._autoDefault ??= p.tonemap.uniforms.autoExposure.value;
`;

const cases = {
  'full-chain': '',
  'autoexposure-off': 'p.tonemap.uniforms.autoExposure.value = 0.0;',
  'godray-off': 'p.godray.enabled = false;',
  'exposurepass-off': 'p.composer.passes.find(x => x.constructor.name === "ExposurePass").enabled = false;',
  'smaa-off': 'p.smaa.enabled = false;',
  'no-post-at-all': 'p.enabled = false;',
};

for (const [name, change] of Object.entries(cases)) {
  await page.evaluate(`${RESET}\n${change}`);
  await page.waitForTimeout(2500);
  const file = `shots/probe/${name}.png`;
  await page.screenshot({ path: file, timeout: 180000 });
  console.log(`${name.padEnd(20)} meanLuma=${meanLuma(file).toFixed(2)}`);
}

const state = await page.evaluate(() => {
  const u = window.__engine.postfx.tonemap?.uniforms || {};
  return {
    autoExposure: u.autoExposure?.value,
    exposure: u.exposure?.value,
    adaptMin: u.adaptMin?.value,
    adaptMax: u.adaptMax?.value,
    hasAdaptTex: !!u.tAdapt?.value,
    rendererExposure: window.__engine.renderer.toneMappingExposure,
  };
});
console.log('tonemap', JSON.stringify(state));

await browser.close();
