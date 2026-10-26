// Snap Vanish — finger-snap gesture detector.
//
// Works on MediaPipe Hand Landmarker output (21 landmarks per hand). A real
// finger snap has a very specific signature that ordinary hand movement and
// typing do not:
//
//   1. "Primed":  the thumb tip is pressed against the middle fingertip pad
//                 while the middle finger is still reaching out (not curled).
//                 This pose is held for at least a couple of frames.
//   2. "Released": within ~1-3 video frames the thumb and middle finger fly
//                 apart AND the middle finger slams down into the palm
//                 (its tip gets much closer to the wrist / base of the thumb).
//
// A flick (middle finger shooting outward), a slow pinch release, waving or
// typing all fail at least one of these checks. The detector reports a
// candidate with a score; the page then confirms it with the snap's click
// sound from the microphone (see snap-audio.js).

const WRIST = 0, THUMB_CMC = 1, THUMB_MCP = 2, THUMB_TIP = 4;
const INDEX_PIP = 6, INDEX_TIP = 8, MIDDLE_MCP = 9, MIDDLE_DIP = 11, MIDDLE_TIP = 12;

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Pose features, normalised by palm length so they are independent of how far
// the hand is from the camera.
export function handFeatures(hand) {
  // Prefer metric world landmarks (true 3D); fall back to image landmarks,
  // corrected for the frame aspect ratio.
  let pts = hand.world;
  if (!pts || pts.length < 21) {
    const ar = hand.aspect || 1;
    pts = hand.landmarks.map((p) => ({ x: p.x * ar, y: p.y, z: (p.z || 0) * ar }));
  }
  const palm = dist(pts[WRIST], pts[MIDDLE_MCP]);
  if (!(palm > 1e-6)) return null;
  const pinchTip = dist(pts[THUMB_TIP], pts[MIDDLE_TIP]) / palm;
  // Thumb pressed anywhere on the last segment of the middle finger counts.
  const pinch = Math.min(pinchTip, dist(pts[THUMB_TIP], pts[MIDDLE_DIP]) / palm);
  const reach = dist(pts[MIDDLE_TIP], pts[WRIST]) / palm;
  const toThumbBase = Math.min(dist(pts[MIDDLE_TIP], pts[THUMB_CMC]), dist(pts[MIDDLE_TIP], pts[THUMB_MCP])) / palm;
  const thumbIndex = Math.min(dist(pts[THUMB_TIP], pts[INDEX_TIP]), dist(pts[THUMB_TIP], pts[INDEX_PIP])) / palm;
  // Image-space position of the middle fingertip (for motion speed).
  const lm = hand.landmarks;
  const ar = hand.aspect || 1;
  const palmImg = Math.hypot((lm[WRIST].x - lm[MIDDLE_MCP].x) * ar, lm[WRIST].y - lm[MIDDLE_MCP].y) || 1e-6;
  return {
    pinch, pinchTip, reach, toThumbBase, thumbIndex,
    tipX: lm[MIDDLE_TIP].x * ar, tipY: lm[MIDDLE_TIP].y, palmImg,
  };
}

// sensitivity 1 (strict) .. 10 (lenient) → threshold scale factor.
export function sensitivityFactor(sensitivity) {
  const s = Math.min(10, Math.max(1, Number(sensitivity) || 5));
  return 0.8 + ((s - 1) * 0.45) / 9; // 0.80 … 1.25
}

export class SnapGestureDetector {
  constructor(opts = {}) {
    this.tracks = new Map();
    this.lastFire = -Infinity;
    this.lastT = null;
    this.frameMs = 33;
    this.setSensitivity(opts.sensitivity ?? 5);
  }

  setSensitivity(sensitivity) {
    const k = sensitivityFactor(sensitivity);
    this.k = k;
    this.t = {
      primedPinch: 0.42 * k,        // thumb ↔ middle pad contact
      primedReach: 1.2 / k,         // middle finger still reaching out
      releasedPinch: 0.62 / k,      // thumb and middle finger now apart
      reachDrop: 0.28 / k,          // middle finger flexed into the palm by at least this
      thumbBase: 0.62 * k,          // …or the tip landed on the base of the thumb
      tipSpeed: 0.3 / k,            // fingertip travel (palm lengths) primed → released
      minPrimedFrames: 2,
      maxReleaseMs: 115 * k,        // the whole release must happen this fast…
      dropoutExtraMs: 110,          // …plus slack when the hand blurs out mid-snap
      minPinchJump: 0.35 / k,       // thumb ↔ middle separation gained during release
      primedMemoryMs: 900,
      refractoryMs: 700,
    };
  }

  // hands: [{ landmarks:[{x,y,z}]x21, world?:[...]x21, handedness?:'Left'|'Right', aspect?:w/h }]
  // tMs:   frame time in ms. Returns null or { t, score, fast, hand }.
  update(hands, tMs) {
    if (this.lastT !== null) {
      const d = tMs - this.lastT;
      if (d > 0 && d < 250) this.frameMs = 0.9 * this.frameMs + 0.1 * d; // typical frame interval
    }
    this.lastT = tMs;
    const seen = new Set();
    let best = null;
    (hands || []).forEach((hand, i) => {
      if (!hand || !hand.landmarks || hand.landmarks.length < 21) return;
      const key = this._trackKey(hand, i, seen);
      seen.add(key);
      const f = handFeatures(hand);
      if (!f) return;
      let tr = this.tracks.get(key);
      if (!tr) { tr = { primed: null, lastSeen: tMs, lastWasPrimed: false, missing: false }; this.tracks.set(key, tr); }
      if (tMs - tr.lastSeen > this.frameMs * 1.6) tr.missing = true; // frames without this hand in between
      tr.lastSeen = tMs;
      const ev = this._step(tr, f, tMs, key);
      if (ev && (!best || ev.score > best.score)) best = ev;
    });
    // Forget hands that are gone for good.
    for (const [key, tr] of this.tracks) {
      if (!seen.has(key) && tMs - tr.lastSeen > 1500) this.tracks.delete(key);
    }
    if (best) {
      this.lastFire = tMs;
      for (const tr of this.tracks.values()) tr.primed = null;
    }
    return best;
  }

  _trackKey(hand, i, seen) {
    const label = hand.handedness || `hand${i}`;
    return seen.has(label) ? `${label}#${i}` : label;
  }

  _step(tr, f, tMs, key) {
    const T = this.t;
    const isPrimed = f.pinch < T.primedPinch && f.reach > T.primedReach;
    if (isPrimed) {
      if (tr.primed && tr.lastWasPrimed && tMs - tr.primed.lastT < 250) {
        const p = tr.primed;
        p.frames += 1;
        p.lastT = tMs;
        p.reach = f.reach; p.pinch = f.pinch;
        p.tipX = f.tipX; p.tipY = f.tipY; p.palmImg = f.palmImg;
        p.minPinch = Math.min(p.minPinch, f.pinch);
      } else {
        tr.primed = { frames: 1, firstT: tMs, lastT: tMs, reach: f.reach, pinch: f.pinch, minPinch: f.pinch,
                      tipX: f.tipX, tipY: f.tipY, palmImg: f.palmImg };
      }
      tr.lastWasPrimed = true;
      tr.missing = false;
      return null;
    }
    tr.lastWasPrimed = false;

    const p = tr.primed;
    if (!p) return null;
    const dt = tMs - p.lastT;
    if (dt > T.primedMemoryMs) { tr.primed = null; return null; }
    if (p.frames < T.minPrimedFrames) return null;
    if (tMs - this.lastFire < T.refractoryMs) return null;

    // Allow at least ~2.5 frame intervals so slow (15 fps) cameras still work.
    let limit = Math.max(T.maxReleaseMs, 2.5 * this.frameMs);
    if (tr.missing) limit += Math.max(T.dropoutExtraMs, this.frameMs * 1.5);
    if (dt > limit) return null; // too slow to be a snap — keep waiting in case it re-primes

    const apart = f.pinchTip > T.releasedPinch && f.pinchTip - p.pinch > T.minPinchJump;
    const reachDrop = p.reach - f.reach;
    const flexed = reachDrop > T.reachDrop || f.toThumbBase < T.thumbBase;
    const outward = f.reach > p.reach + 0.15; // a flick extends the finger instead
    const travel = Math.hypot(f.tipX - p.tipX, f.tipY - p.tipY) / ((p.palmImg + f.palmImg) / 2);
    const moved = travel > T.tipSpeed;
    if (!(apart && flexed && moved) || outward) return null;

    const score =
      0.25 * clamp01((T.primedPinch - p.minPinch) / T.primedPinch) +
      0.25 * clamp01((f.pinchTip - T.releasedPinch) / T.releasedPinch + 0.5) +
      0.3 * clamp01(Math.max(reachDrop / (T.reachDrop * 2), (T.thumbBase - f.toThumbBase) / T.thumbBase)) +
      0.2 * clamp01(1 - dt / limit + 0.3);
    tr.primed = null;
    return { t: tMs, score: Math.round(score * 1000) / 1000, fast: dt <= Math.max(80, 1.6 * this.frameMs), releaseMs: dt, hand: key };
  }

  reset() { this.tracks.clear(); }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
