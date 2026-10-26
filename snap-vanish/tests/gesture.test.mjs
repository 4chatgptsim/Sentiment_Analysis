// Unit tests for the hand-tracking snap detector using synthetic hand poses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapGestureDetector, handFeatures } from '../extension/shared/snap-gesture.js';

const ASPECT = 16 / 9;

// Rough metric hand (metres), palm facing the camera, fingers pointing up (-y).
const OPEN = [
  [0, 0, 0],                                                  // 0 wrist
  [-0.03, -0.02, 0], [-0.05, -0.045, 0], [-0.065, -0.065, 0], [-0.075, -0.085, 0], // thumb
  [-0.025, -0.09, 0], [-0.028, -0.13, 0], [-0.03, -0.155, 0], [-0.031, -0.175, 0], // index
  [0, -0.095, 0], [0, -0.14, 0], [0, -0.168, 0], [0, -0.19, 0],                     // middle
  [0.022, -0.09, 0], [0.024, -0.13, 0], [0.025, -0.155, 0], [0.026, -0.172, 0],     // ring
  [0.04, -0.08, 0], [0.045, -0.11, 0], [0.047, -0.128, 0], [0.05, -0.145, 0],       // pinky
];

function pose(edits) {
  const p = OPEN.map((v) => v.slice());
  for (const [i, v] of Object.entries(edits)) p[i] = v;
  return p;
}

const CURLED_RING_PINKY = {
  14: [0.024, -0.11, -0.03], 15: [0.022, -0.085, -0.04], 16: [0.02, -0.07, -0.025],
  18: [0.044, -0.095, -0.025], 19: [0.042, -0.075, -0.03], 20: [0.04, -0.065, -0.02],
};

// Thumb pressed against the middle fingertip, middle finger still reaching out.
const PRIMED = pose({
  ...CURLED_RING_PINKY,
  10: [0, -0.135, -0.02], 11: [-0.01, -0.15, -0.045], 12: [-0.025, -0.14, -0.06],
  3: [-0.05, -0.1, -0.035], 4: [-0.03, -0.135, -0.055],
});

// Middle finger slammed into the base of the thumb, thumb slid over to the index.
const RELEASED = pose({
  ...CURLED_RING_PINKY,
  10: [0, -0.12, -0.03], 11: [0, -0.09, -0.04], 12: [-0.015, -0.06, -0.025],
  3: [-0.06, -0.1, -0.03], 4: [-0.05, -0.13, -0.03],
});

// Middle finger shot outward (a flick), thumb away.
const FLICKED = pose({
  ...CURLED_RING_PINKY,
  4: [-0.045, -0.11, -0.04],
});

function hand(world, { dx = 0, dy = 0, handedness = 'Right' } = {}) {
  const S = 3; // metres → normalised image units
  return {
    handedness,
    aspect: ASPECT,
    world: world.map(([x, y, z]) => ({ x, y, z })),
    landmarks: world.map(([x, y, z]) => ({ x: 0.5 + dx + (x * S) / ASPECT, y: 0.7 + dy + y * S, z: z * S })),
  };
}

function lerpPose(a, b, t) {
  return a.map((v, i) => v.map((c, j) => c + (b[i][j] - c) * t));
}

// Feeds a list of frames ([] = no hand visible) at a fixed fps.
function run(frames, { fps = 30, sensitivity = 5, t0 = 1000 } = {}) {
  const det = new SnapGestureDetector({ sensitivity });
  const events = [];
  frames.forEach((f, i) => {
    const ev = det.update(f, t0 + (i * 1000) / fps);
    if (ev) events.push(ev);
  });
  return events;
}

const repeat = (frame, n) => Array.from({ length: n }, () => frame);

test('pose features look like a snap', () => {
  const p = handFeatures(hand(PRIMED));
  const r = handFeatures(hand(RELEASED));
  assert.ok(p.pinch < 0.2, `primed pinch ${p.pinch}`);
  assert.ok(p.reach > 1.4, `primed reach ${p.reach}`);
  assert.ok(r.pinchTip > 0.7, `released pinch ${r.pinchTip}`);
  assert.ok(r.reach < 0.9, `released reach ${r.reach}`);
});

test('detects a real snap (primed → released in one frame)', () => {
  const ev = run([...repeat([hand(OPEN)], 5), ...repeat([hand(PRIMED)], 6), [hand(RELEASED)], ...repeat([hand(RELEASED)], 5)]);
  assert.equal(ev.length, 1);
  assert.ok(ev[0].score > 0.5, `score ${ev[0].score}`);
  assert.ok(ev[0].fast);
});

test('detects a snap with one motion-blurred intermediate frame', () => {
  const mid = lerpPose(PRIMED, RELEASED, 0.35);
  const ev = run([...repeat([hand(PRIMED)], 6), [hand(mid)], [hand(RELEASED)]]);
  assert.equal(ev.length, 1);
});

test('detects a snap when the hand drops out for a frame mid-snap', () => {
  const ev = run([...repeat([hand(PRIMED)], 6), [], [hand(RELEASED)]]);
  assert.equal(ev.length, 1);
});

test('detects at 15 fps', () => {
  const ev = run([...repeat([hand(PRIMED)], 4), [hand(RELEASED)]], { fps: 15 });
  assert.equal(ev.length, 1);
});

test('works for either hand and with two hands in view', () => {
  const left = (w) => hand(w, { handedness: 'Left', dx: -0.25 });
  const ev = run([
    ...repeat([left(OPEN), hand(PRIMED)], 5),
    [left(OPEN), hand(RELEASED)],
  ]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].hand, 'Right');
  const ev2 = run([...repeat([left(PRIMED)], 5), [left(RELEASED)]]);
  assert.equal(ev2.length, 1);
});

test('ignores a slow pinch release (normal hand movement)', () => {
  const frames = [...repeat([hand(PRIMED)], 6)];
  for (let i = 1; i <= 14; i++) frames.push([hand(lerpPose(PRIMED, RELEASED, i / 14))]);
  assert.equal(run(frames).length, 0);
});

test('ignores a flick (finger shoots outward instead of into the palm)', () => {
  assert.equal(run([...repeat([hand(PRIMED)], 6), [hand(FLICKED)], ...repeat([hand(FLICKED)], 4)]).length, 0);
});

test('ignores release without a held primed pose', () => {
  assert.equal(run([...repeat([hand(OPEN)], 5), [hand(PRIMED)], [hand(RELEASED)]]).length, 0);
});

test('ignores a primed pose that vanishes and comes back released much later', () => {
  assert.equal(run([...repeat([hand(PRIMED)], 6), ...repeat([], 12), [hand(RELEASED)]]).length, 0);
});

test('ignores typing-like jitter and waving', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const frames = [];
  for (let i = 0; i < 600; i++) {
    // Relaxed, half-curled hand low in the frame with jittery fingers.
    const relaxed = lerpPose(OPEN, RELEASED, 0.4 + 0.3 * Math.sin(i / 7)).map((v) => [v[0] + rnd() * 0.012, v[1] + rnd() * 0.012, v[2] + rnd() * 0.012]);
    frames.push([hand(relaxed, { dx: Math.sin(i / 9) * 0.2, dy: 0.15 })]);
  }
  for (let i = 0; i < 90; i++) frames.push([hand(OPEN, { dx: Math.sin(i / 3) * 0.3 })]);
  assert.equal(run(frames).length, 0);
});

test('refractory period stops double triggers', () => {
  const snap = [...repeat([hand(PRIMED)], 4), [hand(RELEASED)]];
  assert.equal(run([...snap, ...snap]).length, 1);
  assert.equal(run([...snap, ...repeat([hand(OPEN)], 30), ...snap]).length, 2);
});

test('sensitivity changes how strict the release has to be', () => {
  const sloppy = lerpPose(PRIMED, RELEASED, 0.8);
  const frames = [...repeat([hand(PRIMED)], 5), [hand(sloppy)]];
  assert.equal(run(frames, { sensitivity: 1 }).length, 0);
  assert.equal(run(frames, { sensitivity: 10 }).length, 1);
});
