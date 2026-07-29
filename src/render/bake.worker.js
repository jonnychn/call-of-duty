import { generateSurface } from './SurfaceGen.js';

self.onmessage = (e) => {
  const { id, name, size, seed, opts } = e.data;
  try {
    const r = generateSurface(name, size, seed, opts || {});
    const transfer = [r.rgb.buffer, r.normal.buffer, r.rough.buffer, r.ao.buffer];
    if (r.metal) transfer.push(r.metal.buffer);
    self.postMessage({ id, ok: true, result: r }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
