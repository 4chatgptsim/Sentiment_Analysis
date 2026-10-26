// Unit tests for the snap click detector using synthetic audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/snap-audio.js';

const SnapAudioDetector = globalThis.__snapVanishAudio;
const SR = 48000;

function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

function noise(seconds, level, seed = 1) {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = r() * level;
  return out;
}

// Band-limited noise burst with an instant attack and fast exponential decay,
// like a finger snap (energy mostly 1.5–5 kHz).
function addSnap(buf, atSec, amp = 0.35, tauMs = 9, seed = 3) {
  const r = rng(seed);
  const start = Math.round(atSec * SR);
  let lp = 0, prev = 0;
  for (let i = 0; i < SR * 0.12 && start + i < buf.length; i++) {
    const w = r();
    lp += 0.55 * (w - lp);            // crude low-pass
    const band = lp - prev; prev = lp; // crude high-pass → band-pass
    buf[start + i] += amp * 2.2 * band * Math.exp(-(i / SR) * 1000 / tauMs);
  }
  return buf;
}

// Voiced speech-like sound: harmonics of 140 Hz, slow onset, sustained.
function addVowel(buf, atSec, durSec, amp = 0.3) {
  const start = Math.round(atSec * SR);
  for (let i = 0; i < durSec * SR && start + i < buf.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.04) * Math.min(1, (durSec - t) / 0.05);
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * 140 * h * t) / (h * (h > 5 ? 3 : 1));
    buf[start + i] += amp * env * s * 0.4;
  }
  return buf;
}

// "ssss": sustained high-frequency hiss.
function addHiss(buf, atSec, durSec, amp = 0.15) {
  const r = rng(11);
  const start = Math.round(atSec * SR);
  let prev = 0;
  for (let i = 0; i < durSec * SR && start + i < buf.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.03) * Math.min(1, (durSec - t) / 0.03);
    const w = r();
    buf[start + i] += amp * env * (w - prev); prev = w;
  }
  return buf;
}

// Feed in 1024-sample blocks like the ScriptProcessor does.
function detect(buf, sensitivity = 5) {
  const det = new SnapAudioDetector({ sampleRate: SR, sensitivity });
  const events = [];
  const B = 1024;
  for (let i = 0; i < buf.length; i += B) {
    const block = buf.subarray(i, Math.min(buf.length, i + B));
    const tEnd = ((i + block.length) / SR) * 1000;
    events.push(...det.process(block, tEnd));
  }
  return events;
}

test('detects a snap click in a quiet room', () => {
  const ev = detect(addSnap(noise(2, 0.002), 1.0));
  assert.equal(ev.length, 1);
  assert.ok(Math.abs(ev[0].t - 1000) < 15, `onset time ${ev[0].t}`);
});

test('detects several snaps with accurate timing', () => {
  const buf = noise(4, 0.003);
  [0.8, 1.9, 3.1].forEach((s, i) => addSnap(buf, s, 0.3, 8, 5 + i));
  const ev = detect(buf);
  assert.equal(ev.length, 3);
  ev.forEach((e, i) => assert.ok(Math.abs(e.t - [800, 1900, 3100][i]) < 15));
});

test('detects a quieter snap in a noisier room', () => {
  const ev = detect(addSnap(noise(2, 0.01), 1.2, 0.25));
  assert.equal(ev.length, 1);
});

test('ignores speech-like vowels', () => {
  const buf = noise(3, 0.002);
  addVowel(buf, 0.5, 0.4); addVowel(buf, 1.2, 0.25, 0.5); addVowel(buf, 1.8, 0.6, 0.2);
  assert.equal(detect(buf).length, 0);
});

test('ignores sustained hiss ("sss")', () => {
  assert.equal(detect(addHiss(noise(2, 0.002), 0.6, 0.5)).length, 0);
});

test('ignores steady background noise', () => {
  assert.equal(detect(noise(3, 0.05)).length, 0);
});

test('a snap during speech is still found', () => {
  const buf = noise(3, 0.002);
  addVowel(buf, 0.5, 1.5, 0.08);
  addSnap(buf, 1.3, 0.35);
  const ev = detect(buf);
  assert.equal(ev.length, 1);
  assert.ok(Math.abs(ev[0].t - 1300) < 15);
});

test('lower sensitivity ignores faint clicks that higher sensitivity accepts', () => {
  const buf = addSnap(noise(2, 0.004), 1.0, 0.03);
  assert.equal(detect(buf, 1).length, 0);
  assert.equal(detect(buf, 10).length, 1);
});
