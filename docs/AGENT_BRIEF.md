# Agent brief — Operation Blackout

A browser FPS in Three.js aiming at modern Call of Duty production values.
Read this fully before touching code.

## Hard constraints

- **No external art assets.** No downloaded textures, models, HDRIs, audio
  files, or fonts. Everything is generated at runtime in code. This is the
  core constraint of the project — do not work around it.
- **Three.js `0.180.0`**, ES modules, Vite. No new npm dependencies without a
  very good reason.
- **Stay inside your assigned files.** Other agents are editing this repo at
  the same time. Touching a file you do not own will cause a conflict and
  lose someone's work. If you need a change in a file you don't own, note it
  in your final report instead of making it.
- **Runtime cost matters.** Target 60 fps at 1080p on a mid-range discrete
  GPU. The screenshot harness runs on SwiftShader (software rasteriser) and
  will report ~20 fps no matter what you do — do not use that number to judge
  performance. Judge it by draw calls, triangle count, texture memory, and
  per-frame allocations.

## Running and screenshotting

The dev server is already running on `http://127.0.0.1:5173`. If it isn't:

```bash
npm run dev   # background it
```

Take screenshots with the harness:

```bash
node tools/shoot.mjs --out shots/mine --shots default --width 1600 --height 900
node tools/shoot.mjs --out shots/mine --pose street --tod dusk
node tools/shoot.mjs --out shots/mine --shots all --quality ultra
```

Poses live in `tools/shoot.mjs` — add your own if you need a specific angle.
Available time-of-day values: `dawn morning noon afternoon dusk night`.

**Always read your screenshots back with the Read tool and look at them.**
A change you cannot see is a change you cannot claim. The harness exits
non-zero and prints console errors if anything threw — a silent black frame
is always a bug, never a style choice.

## What "AAA" means here, concretely

Judge your work against these, not against "does it run":

1. **Value range.** Real scenes have deep shadows and bright highlights in the
   same frame. Flat mid-grey everywhere is the single most common tell of an
   amateur render.
2. **Silhouette and occlusion.** Every surface should be broken up by
   something — trim, bevels, props, decals. Long unbroken flat planes read as
   a prototype.
3. **Grounding.** Objects need contact shadows and ambient occlusion where
   they meet other surfaces, or they look pasted on.
4. **Texel density consistency.** A wall and the floor next to it should have
   visibly similar detail scale. Mismatched tiling is very obvious.
5. **Colour discipline.** Pick a palette and hold it. CoD leans on a narrow,
   desaturated range with one or two saturated accents (muzzle flash, sky,
   a single hero colour).
6. **Motion.** Nothing in a AAA game snaps. Everything eases, overshoots,
   settles, or has secondary motion.

## Architecture map

```
src/core/       Engine (frame loop, wiring), Input, Settings (quality presets)
src/render/     Noise, SurfaceGen (pure texture synthesis), TextureBaker
                (worker pool + three wrapper), Materials, Atmosphere, PostFX
src/world/      Level (geometry, props, collision octree)
src/player/     Controller (capsule movement)
src/weapons/    RifleModel (procedural gun), Viewmodel (pose/sway/recoil),
                WeaponSystem (firing, spread, ammo), WeaponDefs (stats)
src/fx/         FXSystem (particles, tracers, decals, muzzle flash)
src/ai/         Enemy (soldier + state machine), AISystem (squad)
src/audio/      AudioSystem (procedural WebAudio)
src/ui/         HUD, style.css
tools/          shoot.mjs screenshot harness
```

`src/core/Engine.js` is shared and owned by the coordinator. If your system
needs new wiring there, say so in your report rather than editing it.

## Reporting

End with: what you changed, what it looks like now (specific, not "improved"),
what you measured (draw calls / triangles / bake time), and anything you had
to leave undone or that needs a change in a file you don't own.
