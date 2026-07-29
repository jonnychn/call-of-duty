import * as THREE from 'three';
import { Batch, gBox, gChamfer, gCyl, gRod, gTube, gunMaterials } from './GunKit.js';

// ---------------------------------------------------------------------------
// Procedural gloved hands and forearms.
//
// Local frame for a hand: the wrist is the origin, fingers point along -Z, the
// palm faces -Y, and +X is the thumb side for a LEFT hand (the right hand is
// the same construction with x mirrored, which keeps winding order correct
// without a negative scale).
//
// Each finger is two rigid segments on two hinge groups, which is enough to
// read as a real hand wrapping a grip while staying at ~11 draw calls a hand.
// ---------------------------------------------------------------------------

const FINGERS = [
  // name,     xOffset, length scale, base z, splay
  ['index',  0.0255, 1.00, -0.0455, -0.05],
  ['middle', 0.0075, 1.06, -0.0490, -0.01],
  ['ring',  -0.0105, 0.99, -0.0470, 0.03],
  ['pinky', -0.0275, 0.86, -0.0420, 0.09],
];

function segment(M, mat, w, h, len, pad = true) {
  const b = new Batch();
  b.add(mat, gChamfer(w, h, len, 0, 0, -len / 2, 0, 0, 0, Math.min(w, h) * 0.30));
  // Knuckle pad on the back of the segment.
  if (pad) b.add(mat, gChamfer(w * 0.82, h * 0.34, len * 0.62, 0, h * 0.42, -len * 0.42, 0, 0, 0, Math.min(w, h) * 0.22));
  else b.add(mat, gChamfer(w * 0.72, h * 0.30, len * 0.30, 0, h * 0.40, -len * 0.10, 0, 0, 0, Math.min(w, h) * 0.20));
  const g = new THREE.Group();
  b.flush(g, 'seg');
  return g;
}

/** @param {1|-1} side  +1 = left hand, -1 = right hand. */
export function buildHand(side = 1) {
  const M = gunMaterials();
  const hand = new THREE.Group();
  hand.name = side > 0 ? 'handL' : 'handR';

  const S = side;
  const b = new Batch();

  // ------------------------------- palm ----------------------------------
  b.add(M.glove, gChamfer(0.086, 0.0335, 0.098, 0, 0, -0.030, 0, 0, 0, 0.0085));
  // Thenar (thumb muscle) swell.
  b.add(M.glove, gChamfer(0.030, 0.030, 0.052, S * 0.031, -0.002, -0.014, 0, S * -0.12, 0, 0.0090));
  // Hard knuckle plate across the back of the hand.
  b.add(M.gloveHard, gChamfer(0.080, 0.0090, 0.062, 0, 0.0155, -0.040, 0, 0, 0, 0.0026));
  for (let i = 0; i < 4; i++) {
    b.add(M.gloveHard, gRod(0.0090, 0.0060, 10, S * (0.0255 - i * 0.018), 0.0180, -0.0620, 'y'));
  }
  // Stitched seam down the back and a reinforced palm patch.
  b.add(M.gloveHard, gChamfer(0.0040, 0.0035, 0.070, 0, 0.0160, -0.030, 0, 0, 0, 0.0008));
  b.add(M.gloveHard, gChamfer(0.062, 0.0060, 0.060, 0, -0.0155, -0.030, 0, 0, 0, 0.0022));

  // ------------------------------ wrist / cuff -----------------------------
  b.add(M.glove, gChamfer(0.070, 0.0330, 0.036, 0, 0.0005, 0.014, 0, 0, 0, 0.0090));
  b.add(M.gloveHard, gChamfer(0.076, 0.0380, 0.016, 0, 0.0005, 0.034, 0, 0, 0, 0.0040));
  // Velcro closure tab standing slightly proud.
  b.add(M.strap, gChamfer(0.030, 0.0090, 0.026, S * 0.030, 0.0060, 0.034, 0, 0, S * 0.25, 0.0018));

  b.flush(hand, 'hand');

  // ------------------------------- forearm ---------------------------------
  // The forearm hangs off its own hinge at the wrist. A support hand on a
  // handguard has ~70 degrees of wrist bend; without this joint the arm would
  // shoot straight out sideways, which is the classic procedural-hand tell.
  const forearm = new THREE.Group();
  forearm.name = 'forearm';
  {
    const fb = new Batch();
    const arm = gRod(0.0400, 0.150, 14, 0, 0, 0.100);
    arm.scale(1.0, 0.86, 1.0);
    fb.add(M.sleeve, arm);
    const arm2 = gRod(0.0530, 0.170, 14, 0, 0, 0.250);
    arm2.scale(1.0, 0.88, 1.0);
    fb.add(M.sleeve, arm2);
    // Cuff band where the sleeve meets the glove, plus an elbow pad.
    fb.add(M.strap, gTube(0.0435, 0.0375, 0.022, 14, 0, 0, 0.036));
    fb.add(M.strap, gTube(0.0490, 0.0430, 0.016, 14, 0, 0, 0.166));
    fb.add(M.gloveHard, gChamfer(0.055, 0.020, 0.090, 0, 0.040, 0.250, 0, 0, 0, 0.0060));
    // Seam down the length of the sleeve.
    fb.add(M.strap, gChamfer(0.0060, 0.0060, 0.250, S * 0.036, -0.014, 0.180, 0, 0, 0, 0.0012));
    fb.flush(forearm, 'arm');
  }
  hand.add(forearm);

  // ------------------------------- fingers ---------------------------------
  const fingers = {};
  for (const [name, x, ls, z, splay] of FINGERS) {
    const w = name === 'pinky' ? 0.0165 : 0.0190;
    const h = name === 'pinky' ? 0.0170 : 0.0195;

    const prox = new THREE.Group();
    prox.name = `${name}P`;
    prox.position.set(S * x, 0.0015, z);
    prox.rotation.y = S * splay;
    prox.add(segment(M, M.glove, w, h, 0.040 * ls));

    const dist = new THREE.Group();
    dist.name = `${name}D`;
    dist.position.set(0, 0, -0.040 * ls);
    // Fingertip: the glove is cut back, so this segment is bare and warm —
    // the only skin tone on screen, and the thing that stops the hands
    // disappearing into the weapon.
    const tip = segment(M, name === 'pinky' ? M.glove : M.skin, w * 0.90, h * 0.90, 0.036 * ls, false);
    dist.add(tip);
    prox.add(dist);

    hand.add(prox);
    fingers[name] = { prox, dist, len: 0.040 * ls };
  }

  // -------------------------------- thumb ----------------------------------
  const thumbP = new THREE.Group();
  thumbP.name = 'thumbP';
  thumbP.position.set(S * 0.0400, -0.0035, -0.0180);
  thumbP.rotation.set(0.10, S * 0.95, S * 0.30);
  thumbP.add(segment(M, M.glove, 0.0215, 0.0215, 0.040));
  const thumbD = new THREE.Group();
  thumbD.name = 'thumbD';
  thumbD.position.set(0, 0, -0.040);
  thumbD.add(segment(M, M.skin, 0.0195, 0.0195, 0.034, false));
  thumbP.add(thumbD);
  hand.add(thumbP);

  hand.userData = { side: S, fingers, forearm, thumb: { prox: thumbP, dist: thumbD } };
  hand.userData.rest = {
    thumbP: thumbP.rotation.clone(),
  };
  return hand;
}

const CURL_ORDER = ['index', 'middle', 'ring', 'pinky'];

/**
 * Curls the fingers. `amount` 0 = flat, 1 = fully closed fist.
 * `stagger` offsets each finger so the closing motion ripples rather than
 * snapping as one rigid claw — the single cheapest thing that makes a
 * procedural hand look animated instead of posed.
 */
export function curlHand(hand, amount, stagger = 0.12, spread = 0) {
  const f = hand.userData.fingers;
  const S = hand.userData.side;
  for (let i = 0; i < CURL_ORDER.length; i++) {
    const k = THREE.MathUtils.clamp(amount - i * stagger + stagger * 1.5, 0, 1.25);
    const seg = f[CURL_ORDER[i]];
    seg.prox.rotation.x = -k * 1.05;
    seg.dist.rotation.x = -k * 1.25;
    seg.prox.rotation.y = S * (FINGERS[i][4] + spread * (i - 1.5) * 0.12);
  }
}

const _fz = new THREE.Vector3(0, 0, 1);
const _fd = new THREE.Vector3();
const _fq = new THREE.Quaternion();

/**
 * Points the forearm at the elbow. `dir` is the direction from the wrist to
 * the elbow expressed in the hand's PARENT space; it is converted into the
 * hand's own frame so the wrist bend is independent of how the hand is
 * oriented on the weapon.
 */
export function aimForearm(hand, dir) {
  _fq.copy(hand.quaternion).invert();
  _fd.copy(dir).normalize().applyQuaternion(_fq);
  hand.userData.forearm.quaternion.setFromUnitVectors(_fz, _fd);
}

export function poseThumb(hand, curl, wrapOver = 0) {
  const t = hand.userData.thumb;
  const S = hand.userData.side;
  const rest = hand.userData.rest.thumbP;
  t.prox.rotation.set(rest.x - wrapOver * 0.55, rest.y - S * wrapOver * 0.45, rest.z);
  t.dist.rotation.x = -curl * 0.85;
}
