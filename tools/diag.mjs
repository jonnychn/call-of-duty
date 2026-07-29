#!/usr/bin/env node
// Boot diagnostic. Reports load progress every 2s and distinguishes the two
// failure modes that look identical from the screenshot harness: a thrown
// exception during load, and a main thread blocked by synchronous work.
//
//   node tools/diag.mjs [quality]

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || preinstalled || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 900)));

const quality = process.argv[2] || 'low';
await page.goto(`http://127.0.0.1:5173/?quality=${quality}&autostart=1`, { waitUntil: 'domcontentloaded' });

let ok = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  let s;
  try {
    // If the page's main thread is stuck in a long synchronous block, evaluate
    // never resolves — race it so that shows up as its own diagnosis.
    s = await Promise.race([
      page.evaluate(() => ({
        engine: !!window.__engine,
        running: window.__engine?.running ?? null,
        frame: window.__engine?.frame ?? null,
        status: document.querySelector('.status')?.textContent ?? null,
        pct: document.querySelector('.track > div')?.style.width ?? null,
        err: document.querySelector('.loading pre')?.textContent?.slice(0, 700) ?? null,
      })),
      new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate blocked >4s — main thread busy')), 4000)),
    ]);
  } catch (e) {
    console.log(`${i * 2}s  ${e.message}`);
    continue;
  }
  console.log(`${i * 2}s  ${JSON.stringify(s)}`);
  if (s.err) break;
  if (s.running && s.frame > 5) { console.log('BOOT OK'); ok = true; break; }
}

await browser.close();
process.exit(ok ? 0 : 1);
