// Snap Vanish — AI room inpainting worker.
// Runs MI-GAN (Picsart AI Research, MIT licence) with ONNX Runtime Web
// entirely on this computer to paint in the parts of the room that were
// hidden behind you.
import * as ort from '../vendor/ort/ort.wasm.bundle.min.mjs';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;

const MODEL_URL = new URL('../models/migan_pipeline_v2.onnx', import.meta.url).href;
let session = null;

async function init() {
  try {
    session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    postMessage({ type: 'ready' });
  } catch (err) {
    postMessage({ type: 'error', error: String((err && err.message) || err) });
  }
}

// Grow the hole a little: inpainting looks best when the mask fully covers
// the soft edge around the person.
function dilate(hole, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = hole[row + k];
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = tmp[k * w + x];
      out[y * w + x] = v;
    }
  }
  return out;
}

async function inpaint({ id, w, h, rgba, hole }) {
  const n = w * h;
  const grown = dilate(hole, w, h, 3);
  const img = new Uint8Array(3 * n);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    img[i] = rgba[i * 4];
    img[n + i] = rgba[i * 4 + 1];
    img[2 * n + i] = rgba[i * 4 + 2];
    mask[i] = grown[i] ? 0 : 255; // MI-GAN: 255 = known, 0 = fill in
  }
  const t0 = performance.now();
  const out = await session.run({
    image: new ort.Tensor('uint8', img, [1, 3, h, w]),
    mask: new ort.Tensor('uint8', mask, [1, 1, h, w]),
  });
  const res = out[session.outputNames[0]].data;
  const result = new Uint8Array(4 * n);
  for (let i = 0; i < n; i++) {
    result[i * 4] = res[i];
    result[i * 4 + 1] = res[n + i];
    result[i * 4 + 2] = res[2 * n + i];
    result[i * 4 + 3] = 255;
  }
  postMessage({ type: 'result', id, rgba: result, ms: Math.round(performance.now() - t0) }, [result.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'inpaint') return;
  if (!session) {
    postMessage({ type: 'failed', id: msg.id, error: 'model not loaded' });
    return;
  }
  try {
    await inpaint(msg);
  } catch (err) {
    postMessage({ type: 'failed', id: msg.id, error: String((err && err.message) || err) });
  }
};

init();
