// End-to-end test: loads the unpacked extension into Chromium, serves a fake
// "Google Meet" page (strict CSP + Trusted Types, like the real one) on
// https://meet.google.com via request interception, feeds a fake camera from
// a portrait photo, then vanishes and reappears and checks what the meeting
// would receive.
//
//   NODE_PATH="$(npm root -g)" node tests/e2e/run-e2e.mjs [--ext extension-dir] [--image portrait.jpg] [--out dir]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const EXT = path.resolve(args.ext || path.join(ROOT, 'extension'));
const OUT = path.resolve(args.out || fs.mkdtempSync(path.join(os.tmpdir(), 'snapvanish-e2e-')));
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- fake media
function makeMedia() {
  const video = path.join(OUT, 'camera.y4m');
  if (!fs.existsSync(video)) {
    let image = args.image;
    if (!image) {
      image = path.join(OUT, 'portrait.jpg');
      execFileSync('curl', ['-fsSL', '-o', image, 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg']);
    }
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', image,
      '-vf', 'crop=820:461:0:110,scale=1280:720,format=yuv420p', '-frames:v', '40', '-r', '30', video]);
  }
  // 3 s of room tone with one finger-snap-like click at 1.5 s.
  const audio = path.join(OUT, 'mic.wav');
  const sr = 48000, n = sr * 3;
  const pcm = new Int16Array(n);
  let s = 3, lp = 0, prev = 0;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    let v = rnd() * 0.002;
    const k = i - sr * 1.5;
    if (k >= 0 && k < sr * 0.12) {
      lp += 0.55 * (rnd() - lp);
      const band = lp - prev; prev = lp;
      v += 0.35 * 2.2 * band * Math.exp(-(k / sr) * 1000 / 9);
    }
    pcm[i] = Math.max(-32767, Math.min(32767, v * 32767));
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + n * 2, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(audio, Buffer.concat([header, Buffer.from(pcm.buffer)]));
  return { video, audio };
}

const MEET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fake Meet</title></head>
<body style="margin:0;background:#202124">
  <video id="self" muted playsinline style="display:block;width:640px;height:360px;background:#000"></video>
  <button id="mic" data-is-muted="false" aria-label="Turn off microphone (ctrl + d)">mic</button>
  <script nonce="n0nce">
    const mic = document.getElementById('mic');
    mic.addEventListener('click', () => {
      const muted = mic.getAttribute('data-is-muted') !== 'true';
      mic.setAttribute('data-is-muted', String(muted));
      mic.setAttribute('aria-label', (muted ? 'Turn on' : 'Turn off') + ' microphone (ctrl + d)');
      for (const t of window.__stream.getAudioTracks()) t.enabled = !muted;
    });
    (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
      window.__stream = stream;
      const v = document.getElementById('self');
      v.srcObject = stream;
      await v.play();
      window.__ready = true;
    })().catch((e) => { window.__error = String(e); });
  </script>
</body></html>`;

const CSP = "script-src 'nonce-n0nce' 'strict-dynamic' 'report-sample'; object-src 'none'; base-uri 'self'; " +
  "require-trusted-types-for 'script'; frame-src 'self' https://*.google.com; worker-src 'self'";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function grab(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.locator('#self').screenshot({ path: file });
  return file;
}

// Mean colour of a region of what the meeting receives (the <video> element).
async function regionStats(page, rx, ry, rw, rh) {
  return page.evaluate(([rx, ry, rw, rh]) => {
    const v = document.getElementById('self');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0);
    const d = g.getImageData(rx * c.width, ry * c.height, rw * c.width, rh * c.height).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)];
  }, [rx, ry, rw, rh]);
}

async function main() {
  const media = makeMedia();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapvanish-profile-'));
  const context = await chromium.launchPersistentContext(userData, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 900, height: 600 },
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${media.video}`,
      `--use-file-for-fake-audio-capture=${media.audio}`,
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  });
  const logs = [];
  const results = { ok: true, checks: [] };
  const check = (name, pass, detail) => {
    results.checks.push({ name, pass, detail });
    if (!pass) results.ok = false;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${JSON.stringify(detail)}` : ''}`);
  };

  try {
    await context.route('https://meet.google.com/**', (route) => route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP },
      body: MEET_PAGE,
    }));
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    check('service worker running', !!sw);

    const page = await context.newPage();
    page.on('console', (m) => logs.push(`[page:${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    context.on('page', (p) => p.on('console', (m) => logs.push(`[ext] ${m.text()}`)));
    await page.goto('https://meet.google.com/abc-defg-hij');
    await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 20000 });
    check('getUserMedia works on a strict-CSP page', await page.evaluate(() => !window.__error), await page.evaluate(() => window.__error));

    const track = await page.evaluate(() => {
      const t = window.__stream.getVideoTracks()[0];
      return { ctor: t.constructor.name, label: t.label, settings: t.getSettings(), state: t.readyState };
    });
    check('meeting gets Snap Vanish track that looks like the camera', track.ctor !== 'MediaStreamTrack' && track.settings.width === 1280 && !!track.label, track);

    // Wait for the processor iframe to load its models.
    const t0 = Date.now();
    let status = null;
    while (Date.now() - t0 < 120000) {
      status = await sw.evaluate(async () => Object.values((await chrome.storage.session.get('sessions')).sessions || {})[0] || null);
      if (status && (status.status.ready || status.status.error)) break;
      await sleep(500);
    }
    check('AI models loaded in the processor iframe', !!(status && status.status.ready), status && status.status);
    if (!status || !status.status.ready) throw new Error('processor not ready');

    // Let it learn the room and run the AI inpainting once.
    const t1 = Date.now();
    while (Date.now() - t1 < 90000) {
      status = await sw.evaluate(async () => Object.values((await chrome.storage.session.get('sessions')).sessions || {})[0] || null);
      if (status.status.inpaint === 'ready') break;
      await sleep(500);
    }
    check('inpainting model loaded', status.status.inpaint === 'ready', status.status.inpaint);
    await sleep(8000); // first inpainting pass (single-threaded WASM)

    await grab(page, '0-before');
    const faceBefore = await regionStats(page, 0.45, 0.15, 0.12, 0.2);
    const wallBefore = await regionStats(page, 0.02, 0.05, 0.1, 0.3);

    // Snap via the keyboard-shortcut path (service worker → tab).
    const snap = await sw.evaluate(() => snapNow());
    check('shortcut/popup "Snap now" reaches the meeting tab', snap.ok, snap);
    await sleep(900);
    await grab(page, '1-vanishing-0.9s');
    await sleep(900);
    await grab(page, '2-vanishing-1.8s');
    const mid = await page.evaluate(() => {
      const t = window.__stream.getAudioTracks()[0];
      const real = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled').get.call(t);
      return { appSees: t.enabled, real, button: document.getElementById('mic').getAttribute('data-is-muted') };
    });
    check('mic is muted while vanishing', mid.real === false, mid);
    check('meeting UI mute button was switched to muted', mid.button === 'true', mid.button);
    await sleep(2200);
    await grab(page, '3-vanished');
    const faceGone = await regionStats(page, 0.45, 0.15, 0.12, 0.2);
    const wallGone = await regionStats(page, 0.02, 0.05, 0.1, 0.3);
    const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    check('your face is gone from the outgoing video', diff(faceBefore, faceGone) > 60, { faceBefore, faceGone });
    check('the room around you stays live and unchanged', diff(wallBefore, wallGone) < 25, { wallBefore, wallGone });
    const procFrame = page.frames().find((f) => f.url().includes('processor/processor.html'));
    console.log('processor stats', procFrame ? await procFrame.evaluate(() => globalThis.__snapVanishStats) : 'no processor frame');
    const sv = await sw.evaluate(async () => Object.values((await chrome.storage.session.get('sessions')).sessions || {})[0]);
    check('status reports vanished', sv.status.state === 'vanished', sv.status.state);

    // Popup UI while vanished.
    const extId = new URL(sw.url()).host;
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 340, height: 640 });
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await sleep(1200);
    await popup.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });
    check('popup shows the vanished state', /vanished/i.test(await popup.locator('#statusTitle').textContent()), await popup.locator('#statusTitle').textContent());
    await popup.close();
    await page.bringToFront();

    // Snap back.
    await sw.evaluate(() => snapNow());
    await sleep(1500);
    await grab(page, '4-reappearing-1.5s');
    await sleep(2500);
    await grab(page, '5-back');
    const faceBack = await regionStats(page, 0.45, 0.15, 0.12, 0.2);
    check('you are back', diff(faceBefore, faceBack) < 20, { faceBefore, faceBack });
    const end = await page.evaluate(() => {
      const t = window.__stream.getAudioTracks()[0];
      const real = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled').get.call(t);
      return { appSees: t.enabled, real, button: document.getElementById('mic').getAttribute('data-is-muted') };
    });
    check('mic is unmuted again', end.real === true && end.button === 'false', end);

    // Snap-sound detector heard the clicks in the fake mic (they loop every 3 s).
    check('snap sound detector hears clicks from the mic', logs.some((l) => l.includes('snap sound')), undefined);

    // Fusion: a hand snap right after a heard click toggles; one that isn't
    // heard asks for a second snap, and two in a row toggle.
    const pageState = () => page.evaluate(() => new Promise((res) => {
      const on = (e) => { const m = JSON.parse(e.detail); if (m.type === 'debug') { window.removeEventListener('__snapvanish_from_page', on); res(m.state); } };
      window.addEventListener('__snapvanish_from_page', on);
      window.dispatchEvent(new CustomEvent('__snapvanish_to_page', { detail: JSON.stringify({ type: 'debug' }) }));
    }));
    const procFrame2 = page.frames().find((f) => f.url().includes('processor/processor.html'));
    const nextClick = () => new Promise((res) => {
      const h = (m) => { if (m.text().includes('snap sound')) { page.off('console', h); res(); } };
      page.on('console', h);
    });
    await sleep(1500);
    await nextClick();
    await procFrame2.evaluate(() => globalThis.__snapVanishTest.visualSnap());
    await sleep(400);
    check('hand snap + click sound together → vanish', (await pageState()) === 'vanishing', undefined);
    await sleep(4000); // finish vanishing + cooldown
    await nextClick();
    await sleep(1100);  // well away from any click
    await procFrame2.evaluate(() => globalThis.__snapVanishTest.visualSnap());
    await sleep(900);
    check('hand snap without a click is not enough on its own', (await pageState()) === 'vanished', undefined);
    await procFrame2.evaluate(() => globalThis.__snapVanishTest.visualSnap());
    await sleep(900);
    check('two clear hand snaps in a row → come back', (await pageState()) === 'appearing', undefined);
    await sleep(3500);

    // Turning the camera off stops the real camera.
    const stopped = await page.evaluate(() => {
      for (const t of window.__stream.getTracks()) t.stop();
      return window.__stream.getVideoTracks()[0].readyState;
    });
    check('stopping the track ends it', stopped === 'ended', stopped);
  } catch (err) {
    results.ok = false;
    console.error('ERROR', err);
  } finally {
    fs.writeFileSync(path.join(OUT, 'console.log'), logs.join('\n'));
    await context.close();
  }
  console.log(`\nScreenshots and logs: ${OUT}`);
  console.log(results.ok ? 'E2E PASSED' : 'E2E FAILED');
  process.exit(results.ok ? 0 : 1);
}

main();
