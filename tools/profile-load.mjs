#!/usr/bin/env node
// Load-time profiler. Boots the game headless and reports, per quality preset:
//
//   * wall time to a rendered frame, and the in-page timeline of each phase
//   * material bake wall time vs summed worker CPU vs main-thread time
//   * every main-thread long task (>50 ms), so a stall can be attributed to a
//     phase rather than guessed at
//   * texture memory, counted from the actual GPU formats and deduped by
//     backing image (Texture.clone() shares the image, so counting texture
//     objects triple-counts every tiled variant)
//   * clone integrity: any scene material carrying an RG8 normal map but no
//     detail hook would shade with a garbage normal
//
//   node tools/profile-load.mjs high
//
// Unlike shoot.mjs this renders nothing, so it is safe to run while the frame
// is broken.

import { chromium } from 'playwright';

const quality = process.argv[2] || 'high';
const url = `http://127.0.0.1:5173/?quality=${quality}&autostart=1`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.addInitScript(() => {
  window.__lt = [];
  window.__t0 = performance.now();
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push({ s: +e.startTime.toFixed(1), d: +e.duration.toFixed(1) });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__ltErr = String(e); }
  window.__marks = [];
  for (const k of ['log', 'info', 'warn', 'error']) {
    const o = console[k].bind(console);
    console[k] = (...a) => { window.__marks.push({ t: +performance.now().toFixed(0), m: a.map(String).join(' ').slice(0, 200) }); o(...a); };
  }
});

const logs = [];
const T0 = Date.now();
page.on('console', (m) => logs.push(`+${String(Date.now() - T0).padStart(6)}ms ${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

const nav0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__engine && window.__engine.frame > 3, null, { timeout: 240000 });
const wall = Date.now() - nav0;

const info = await page.evaluate(() => {
  const e = window.__engine;
  const r = e.renderer;
  let texBytes = 0; const seen = new Set(); const per = {};
  const acct = (t, owner) => {
    if (!t || !t.isTexture || seen.has(t.uuid)) return;
    // Texture.clone() shares .image; count image identity, not texture identity
    const img = t.image;
    if (!img || seen.has(img)) return;
    seen.add(img); seen.add(t.uuid);
    // three r180: RedFormat 1028, RGFormat 1030, RGBFormat 1022, RGBAFormat 1023
    const ch = { 1028: 1, 1030: 2, 1022: 3, 1023: 4 }[t.format] ?? 4;
    const b = (img.width || 0) * (img.height || 0) * ch * (t.generateMipmaps ? 4 / 3 : 1);
    texBytes += b;
    per[owner] = (per[owner] || 0) + b;
  };
  for (const [k, m] of Object.entries(e.materials.materials)) {
    for (const s of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap', 'emissiveMap']) acct(m[s], k);
    acct(m.detailMap, 'detail:' + k);
  }
  // Clone integrity: every material actually in the scene must still carry the
  // detail hook. A clone that lost onBeforeCompile reads the RG8 normal map's
  // empty blue channel as Z and shades with a garbage normal.
  const bad = [];
  const seenMat = new Set();
  e.scene.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of ms) {
      if (!m || seenMat.has(m.uuid)) continue;
      seenMat.add(m.uuid);
      const isLib = m.normalMap && m.normalMap.format === 1030;
      if (isLib && !(m.detailMap && m.userData.detailParams)) bad.push(m.name || m.uuid);
    }
  });

  return {
    cloneBad: bad,
    cloneChecked: seenMat.size,
    matStats: e.materials.stats,
    rendererInfo: { textures: r.info.memory.textures, geometries: r.info.memory.geometries, programs: r.info.programs.length },
    texMB: +(texBytes / 1048576).toFixed(2),
    per: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, +(v / 1048576).toFixed(2)])),
    longTasks: window.__lt,
    marks: window.__marks,
    ltErr: window.__ltErr,
    tReady: +(performance.now() - window.__t0).toFixed(0),
  };
});

const lt = info.longTasks || [];
lt.sort((a, b) => b.d - a.d);
console.log('=== quality:', quality, '===');
console.log('wall (nav -> frame>3):', wall, 'ms; in-page tReady:', info.tReady, 'ms');
console.log('materials.stats:', JSON.stringify(info.matStats));
console.log('clone integrity: checked', info.cloneChecked, 'scene materials; RG8-normal materials missing detail hook:', JSON.stringify(info.cloneBad));
console.log('texture MB (image-unique):', info.texMB);
console.log('per-material MB:', JSON.stringify(info.per));
console.log('renderer.info:', JSON.stringify(info.rendererInfo));
console.log('longtasks total:', lt.reduce((a, b) => a + b.d, 0).toFixed(0), 'ms over', lt.length, 'tasks');
console.log('top longtasks:', JSON.stringify(lt.slice(0, 12)));
console.log('ltErr:', info.ltErr);
console.log('--- in-page timeline (ms since page start) ---');
for (const m of info.marks || []) console.log(`+${String(m.t).padStart(6)}  ${m.m}`);
console.log('--- console ---');
for (const l of logs.slice(0, 40)) console.log(l);

await browser.close();
