// Snap Vanish — processor (runs in a hidden extension iframe inside the
// meeting tab). Everything here is local: MediaPipe hand tracking and person
// segmentation, the WebGL dust renderer and MI-GAN room inpainting. Frames
// come in from the page over a private MessageChannel and go straight back.
import { HandLandmarker, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.mjs';
import { SnapGestureDetector } from '../shared/snap-gesture.js';
import { Renderer } from './renderer.js';

const ALLOWED_PARENT = /^https:\/\/(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|([a-z0-9-]+\.)*zoom\.(us|com))$/;
const url = (p) => new URL(p, import.meta.url).href;
const FILESET = {
  wasmLoaderPath: url('../vendor/mediapipe/vision_wasm_internal.js'),
  wasmBinaryPath: url('../vendor/mediapipe/vision_wasm_internal.wasm'),
};

let port = null;
let settings = { enabled: true, sensitivity: 5, direction: 'right' };
let effect = { state: 'visible', start: 0, duration: 3000, direction: 'right' };
let hands = null;
let segmenter = null;
let renderer = null;
let ready = false;
let loadError = null;
const delegates = {};
const gesture = new SnapGestureDetector();
const sessions = new Map();

const inpaint = { worker: null, state: 'loading', busy: false, seq: 0, lastMs: null };
// Counters for troubleshooting (visible from the iframe's devtools console).
// Test hook: report a hand snap as if the hand tracker had seen one (used by
// the end-to-end test; the meeting page cannot reach this cross-origin frame).
globalThis.__snapVanishTest = {
  visualSnap(score = 0.8) {
    post({ type: 'visual-snap', t: performance.timeOrigin + performance.now(), score, fast: true, releaseMs: 33, hand: 'Test' });
  },
};
const stats = globalThis.__snapVanishStats = { analyzed: 0, rendered: 0, segmented: 0, maskMean: 0, lastMode: 0, inpaints: 0, inpaintMs: 0, errors: 0, ms: 0 };

// ----------------------------------------------------------------- messaging
window.addEventListener('message', (e) => {
  if (port || e.source !== window.parent || !ALLOWED_PARENT.test(e.origin)) return;
  if (!e.data || e.data.type !== 'snapvanish-connect' || !e.ports || !e.ports[0]) return;
  port = e.ports[0];
  port.onmessage = (ev) => onMessage(ev.data);
  start();
});

function post(msg, transfer) {
  if (port) port.postMessage(msg, transfer || []);
}

function sendStatus() {
  post({
    type: 'status',
    ready,
    loading: !ready && !loadError,
    error: loadError,
    delegates,
    inpaint: inpaint.state,
    inpaintMs: inpaint.lastMs,
  });
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello':
      if (msg.settings) applySettings(msg.settings);
      if (msg.effect) applyEffect(msg.effect);
      sendStatus();
      break;
    case 'settings':
      applySettings(msg.settings);
      break;
    case 'effect':
      applyEffect(msg);
      break;
    case 'frame':
      processFrame(msg);
      break;
    case 'session-end': {
      const S = sessions.get(msg.sid);
      if (S && renderer) renderer.destroySession(S.gfx);
      sessions.delete(msg.sid);
      break;
    }
    default:
      break;
  }
}

function applySettings(s) {
  if (!s) return;
  settings = { ...settings, ...s };
  gesture.setSensitivity(settings.sensitivity);
}

function applyEffect(e) {
  const starting = e.state === 'vanishing' && effect.start !== e.start;
  const nowVisible = e.state === 'visible' && effect.state !== 'visible';
  effect = { state: e.state, start: e.start, duration: e.duration, direction: e.direction || 'right' };
  for (const S of sessions.values()) {
    if (starting) S.forceInpaint = true;
    if (nowVisible && S.queuedAi) {
      renderer.setAiFill(S.gfx, S.queuedAi, performance.now());
      S.queuedAi = null;
    }
  }
  if (starting) gesture.reset();
}

// ----------------------------------------------------------------- startup
// MediaPipe's GPU delegate is much slower than its WASM/SIMD CPU path when
// WebGL is software-rendered (no GPU, blocklisted driver, remote desktop…).
function hasRealGpu() {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return !/swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

async function createTask(Klass, options) {
  if (!hasRealGpu()) {
    const task = await Klass.createFromOptions(FILESET, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
    return [task, 'CPU'];
  }
  try {
    const task = await Klass.createFromOptions(FILESET, { ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' } });
    return [task, 'GPU'];
  } catch (err) {
    console.warn('[Snap Vanish] GPU delegate unavailable, using CPU', err);
    const task = await Klass.createFromOptions(FILESET, { ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' } });
    return [task, 'CPU'];
  }
}

async function start() {
  sendStatus();
  try {
    renderer = new Renderer();
    [hands, delegates.hands] = await createTask(HandLandmarker, {
      baseOptions: { modelAssetPath: url('../models/hand_landmarker.task') },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    [segmenter, delegates.segmenter] = await createTask(ImageSegmenter, {
      baseOptions: { modelAssetPath: url('../models/selfie_segmenter_landscape.tflite') },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    ready = true;
  } catch (err) {
    console.error('[Snap Vanish] failed to start', err);
    loadError = String((err && err.message) || err).slice(0, 200);
  }
  sendStatus();
  if (ready) startInpainter();
}

function startInpainter() {
  try {
    const w = new Worker(url('./inpaint-worker.js'), { type: 'module' });
    w.onmessage = (e) => onInpaintMessage(e.data);
    w.onerror = (e) => {
      console.warn('[Snap Vanish] inpainting unavailable', e.message);
      inpaint.state = 'unavailable';
      sendStatus();
    };
    inpaint.worker = w;
  } catch (err) {
    console.warn('[Snap Vanish] inpainting unavailable', err);
    inpaint.state = 'unavailable';
    sendStatus();
  }
}

// ----------------------------------------------------------------- frames
let tBase = null;
let lastTs = 0;
function mediapipeTs(t) {
  if (tBase === null) tBase = t - 1;
  let ts = Math.round(t - tBase);
  if (ts <= lastTs) ts = lastTs + 1;
  lastTs = ts;
  return ts;
}

function session(sid, w, h) {
  let S = sessions.get(sid);
  if (S && Math.abs(S.gfx.aspect - w / h) > 0.01) {
    renderer.destroySession(S.gfx); // resolution / aspect change: start over
    S = null;
  }
  if (!S) {
    S = { gfx: renderer.createSession(w, h), learned: 0, learnStart: 0, lastLearn: 0, lastInpaintCheck: 0, lastInpaintAt: 0 };
    sessions.set(sid, S);
  }
  return S;
}

function toHands(res, aspect) {
  const out = [];
  if (!res || !res.landmarks) return out;
  res.landmarks.forEach((lm, i) => {
    const hd = (res.handedness && res.handedness[i]) || (res.handednesses && res.handednesses[i]);
    out.push({
      landmarks: lm,
      world: res.worldLandmarks && res.worldLandmarks[i],
      handedness: hd && hd[0] ? hd[0].categoryName : undefined,
      aspect,
    });
  });
  return out;
}

function segment(bmp, ts) {
  let out = null;
  segmenter.segmentForVideo(bmp, ts, (result) => {
    const masks = result.confidenceMasks;
    if (!masks || !masks.length) return;
    const m = masks[masks.length - 1]; // person confidence
    const f = m.getAsFloat32Array();
    const data = new Uint8Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const v = f[i] * 255;
      data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    out = { data, w: m.width, h: m.height };
  });
  return out;
}

function effectAt(t) {
  const dur = effect.duration / 1000;
  const el = (t - effect.start) / 1000;
  const clamp = (v) => Math.min(dur, Math.max(0, v));
  const base = { duration: dur, direction: effect.direction };
  switch (effect.state) {
    case 'vanishing': return { ...base, mode: 1, t: clamp(el) };
    case 'appearing': return { ...base, mode: 1, t: clamp(dur - el) };
    case 'vanished': return { ...base, mode: 2, t: dur };
    default: return { ...base, mode: 0, t: 0 };
  }
}

// The models run on a ≤640 px copy of the frame: plenty for hands and the
// person mask, and much cheaper than full HD.
const ML_MAX_W = 640;
let mlCanvas = null;
let mlCtx = null;
function mlInput(bmp) {
  if (bmp.width <= ML_MAX_W) return bmp;
  const w = ML_MAX_W, h = Math.round((bmp.height * ML_MAX_W) / bmp.width);
  if (!mlCanvas) {
    mlCanvas = new OffscreenCanvas(w, h);
    mlCtx = mlCanvas.getContext('2d', { alpha: false, desynchronized: true });
  }
  if (mlCanvas.width !== w || mlCanvas.height !== h) { mlCanvas.width = w; mlCanvas.height = h; }
  mlCtx.drawImage(bmp, 0, 0, w, h);
  return mlCanvas;
}

function processFrame(msg) {
  const { sid, bmp, t, render, primary } = msg;
  const reply = { type: render ? 'frame' : 'ack', sid, ts: msg.ts, bmp: null };
  try {
    if (!ready || !bmp) return;
    const S = session(sid, bmp.width, bmp.height);
    const ts = mediapipeTs(t);
    const input = mlInput(bmp);

    const t0 = performance.now();
    if (primary && settings.enabled !== false) {
      const res = hands.detectForVideo(input, ts);
      stats.hands = res.landmarks ? res.landmarks.length : 0;
      const ev = gesture.update(toHands(res, bmp.width / bmp.height), t);
      if (ev) post({ type: 'visual-snap', ...ev });
    }

    // Segment every frame while rendering; ~5-10 fps otherwise (background learning).
    const learnEvery = S.learned > 30 ? 200 : 90;
    if (render || t - S.lastLearn >= learnEvery) {
      const mask = segment(input, ts);
      renderer.uploadFrame(S.gfx, bmp);
      if (mask) {
        stats.segmented++;
        let sum = 0;
        for (let i = 0; i < mask.data.length; i++) sum += mask.data[i];
        stats.maskMean = Math.round(sum / mask.data.length);
        renderer.updateMask(S.gfx, mask, t);
        renderer.learn(S.gfx);
        S.lastLearn = t;
        S.learned++;
        if (!S.learnStart) S.learnStart = t;
      }
    }

    if (render) {
      const eff = effectAt(t);
      if (eff.mode === 1 && S.gfx.snapKey !== effect.start) renderer.snapshot(S.gfx, effect.start);
      reply.bmp = renderer.render(S.gfx, eff, performance.now());
      stats.rendered++;
      stats.lastMode = eff.mode;
    } else {
      stats.analyzed++;
    }
    stats.ms = Math.round(stats.ms * 0.9 + (performance.now() - t0) * 0.1);
    maybeInpaint(sid, S, t);
  } catch (err) {
    stats.errors++;
    console.error('[Snap Vanish] frame failed', err);
  } finally {
    if (bmp) bmp.close();
    post(reply, reply.bmp ? [reply.bmp] : []);
  }
}

// ----------------------------------------------------------------- inpainting
function maybeInpaint(sid, S, t) {
  if (inpaint.state !== 'ready' || inpaint.busy) return;
  const g = S.gfx;
  if (effect.state !== 'visible' && g.aiValid) return; // never swap the room while you're gone
  if (!S.learnStart || t - S.learnStart < 1500) return;
  if (!S.forceInpaint && t - S.lastInpaintCheck < (g.aiValid ? 5000 : 1500)) return;
  S.lastInpaintCheck = t;
  S.forceInpaint = false;

  const rgba = renderer.readPlate(g);
  const n = g.pw * g.ph;
  const hole = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] < 128) { hole[i] = 1; count++; }
  if (count < n * 0.002) return; // the whole room has been seen already
  if (S.lastHole) {
    let fresh = 0, solved = 0;
    for (let i = 0; i < n; i++) {
      if (hole[i] && !S.lastHole[i]) fresh++;
      else if (!hole[i] && S.lastHole[i]) solved++;
    }
    const stale = t - S.lastInpaintAt > 30000;
    if (fresh < n * 0.003 && solved < S.lastHoleCount * 0.15 && !stale) return;
  }
  inpaint.busy = true;
  const id = ++inpaint.seq;
  S.pending = { id, hole, count };
  inpaint.worker.postMessage({ type: 'inpaint', id, sid, w: g.pw, h: g.ph, rgba, hole: hole.slice() }, [rgba.buffer]);
}

function onInpaintMessage(msg) {
  if (msg.type === 'ready') {
    inpaint.state = 'ready';
    sendStatus();
    return;
  }
  if (msg.type === 'error') {
    console.warn('[Snap Vanish] inpainting unavailable:', msg.error);
    inpaint.state = 'unavailable';
    sendStatus();
    return;
  }
  inpaint.busy = false;
  for (const S of sessions.values()) {
    if (!S.pending || S.pending.id !== msg.id) continue;
    if (msg.type === 'result') {
      S.lastHole = S.pending.hole;
      S.lastHoleCount = S.pending.count;
      S.lastInpaintAt = performance.timeOrigin + performance.now();
      inpaint.lastMs = msg.ms;
      stats.inpaints++;
      stats.inpaintMs = msg.ms;
      if (effect.state === 'visible' || !S.gfx.aiValid) renderer.setAiFill(S.gfx, msg.rgba, performance.now());
      else S.queuedAi = msg.rgba;
      sendStatus();
    }
    S.pending = null;
  }
}
