import { generateSurface } from './SurfaceGen.js';

self.onmessage = (e) => {
  const { id, name, size, seed, opts } = e.data;
  try {
    const r = generateSurface(name, size, seed, opts || {});
    // Albedo, tangent-space normal, and packed ORM — three buffers, all
    // transferred rather than copied so a 2048² set costs nothing to hand back.
    self.postMessage({ id, ok: true, result: r }, [r.rgb.buffer, r.normal.buffer, r.orm.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
