import { generateSurface, generateDetailNormal } from './SurfaceGen.js';

self.onmessage = (e) => {
  const { id, kind, name, size, seed, opts } = e.data;
  try {
    if (kind === 'detail') {
      // Micro-normal tile: one buffer, no albedo or ORM.
      const o = opts || {};
      const r = generateDetailNormal(name, size, seed, o.worldSize, o.amplitude);
      self.postMessage({ id, ok: true, result: r }, [r.normal.buffer]);
      return;
    }
    const r = generateSurface(name, size, seed, opts || {});
    // Albedo, tangent-space normal, and packed ORM — three buffers, all
    // transferred rather than copied so a 1024² set costs nothing to hand back.
    self.postMessage({ id, ok: true, result: r }, [r.rgb.buffer, r.normal.buffer, r.orm.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
