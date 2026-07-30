import { Engine } from './core/Engine.js';
import { settings } from './core/Settings.js';

const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui-root');

// Allow the screenshot harness and the URL bar to drive quality/time-of-day
// without touching code: ?quality=ultra&tod=dusk&autostart=1
const params = new URLSearchParams(location.search);
if (params.has('quality')) settings.setQuality(params.get('quality'));

const loading = document.createElement('div');
loading.className = 'overlay loading';
loading.innerHTML = `
  <h1>Operation Blackout</h1>
  <div class="track"><div></div></div>
  <div class="status">initialising</div>
`;
uiRoot.appendChild(loading);
const bar = loading.querySelector('.track > div');
const status = loading.querySelector('.status');

const engine = new Engine(canvas);
window.__engine = engine; // handle for the automated visual-review harness

async function boot() {
  await engine.load((p, msg) => {
    bar.style.width = `${Math.round(p * 100)}%`;
    if (msg) status.textContent = msg;
  });

  if (params.has('tod')) engine.atmosphere.apply(params.get('tod'));

  loading.remove();
  showStartScreen();
  engine.start();
}

function showStartScreen() {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <h1>Operation Blackout</h1>
    <div class="sub">Click to deploy</div>
    <div class="keys">
      <b>WASD</b><span>Move</span>
      <b>Shift</b><span>Sprint</span>
      <b>Ctrl / C</b><span>Crouch · Slide</span>
      <b>Space</b><span>Jump · Mantle</span>
      <b>Q / E</b><span>Lean</span>
      <b>LMB / RMB</b><span>Fire · Aim</span>
      <b>R</b><span>Reload</span>
    </div>
    <button>Deploy</button>
  `;
  uiRoot.appendChild(overlay);

  const enter = () => {
    overlay.remove();
    // The audio context can only start from inside a user gesture.
    engine.audio.init();
    engine.input.requestLock();
  };
  overlay.querySelector('button').addEventListener('click', enter);
  overlay.addEventListener('click', enter);

  engine.input.onLockChange = (locked) => {
    if (!locked && !document.querySelector('.overlay')) showStartScreen();
  };

  if (params.get('autostart') === '1') {
    overlay.remove();
  }
}

boot().catch((err) => {
  status.textContent = 'failed to start';
  loading.innerHTML += `<pre style="color:#ff6b6b;font-size:12px;max-width:70vw;white-space:pre-wrap">${String(err && err.stack || err)}</pre>`;
  console.error(err);
});
