# Snap Vanish

A Chrome extension for video calls in the browser (**Google Meet, Microsoft
Teams, Zoom web**). Snap your fingers on camera and you crumble into dust and
blow away, like the snap in *Avengers: Endgame*. The other people in the call
see the empty room where you were sitting, and your mic mutes. Snap again and
the dust flies back, you reappear, and your mic unmutes.

Everything runs locally in your browser. No video or audio is sent anywhere by
the extension.

## Install

1. Download **[`dist/snap-vanish.zip`](dist/snap-vanish.zip)** and unzip it.
   You get a `snap-vanish` folder. Keep it somewhere permanent, because Chrome
   loads the extension from it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `snap-vanish` folder (the one with
   `manifest.json` in it).
4. Pin **Snap Vanish** from the puzzle-piece menu.
5. Open your call in the browser. If the tab was already open, reload it once.
   Turn your camera on. When *"Snap Vanish is ready"* appears in the corner,
   snap your fingers.

Backup trigger: **Alt+Shift+S**, or **Snap now** in the popup. You can change
the shortcut at `chrome://extensions/shortcuts`.

## Popup

| Control | What it does |
|---|---|
| On/off switch | Turns the whole extension on or off. Takes effect the next time your camera starts. |
| Snap now / Snap back | Same as snapping your fingers. |
| Snap sensitivity | 1 (strict) to 10 (easy). Changes both the hand-pose thresholds and the click-sound thresholds. |
| Dust duration | 1.5–6 s for the crumble and reassemble animation. |
| Dust direction | Which way the wind blows the dust: left, up, down or right. |
| Mute my mic while I'm vanished | On by default. |
| Confirm snaps with the click sound | On by default. Turn it off if your mic doesn't pick up your snaps. |

## How it works

```
Meeting page (Meet / Teams / Zoom)                       Hidden extension iframe (same tab)
──────────────────────────────────                       ──────────────────────────────────
getUserMedia() ──► Snap Vanish wraps the camera track      MediaPipe Hand Landmarker ─► snap-pose detector
   │                                                       MediaPipe Selfie Segmenter ─► person mask
   ├─ normal: camera frames go straight through            Room memory (WebGL): learns every part of
   │          (copy sent to iframe for hand tracking)          the room the camera has ever seen
   ├─ snap:   frames rendered by the iframe ◄───────────── MI-GAN (ONNX Runtime, WASM worker) paints
   │          (dust particles + empty room)                    in the parts it has never seen
   └─ mic:    forced mute + private copy analysed           WebGL2 dust: ~160k particles from your pixels
              for the snap's click sound
```

* **Snap detection.** MediaPipe tracks 21 points on each hand. A snap is
  detected only when the thumb is held pressed against the middle fingertip
  for a couple of frames, and then within about 1–3 frames the thumb and
  middle finger fly apart *and* the middle finger slams into the palm. Waving,
  typing, pinching and flicking don't match that pattern. When a mic is
  available, the snap must also be confirmed by a short, sharp, high-pitched
  click heard within a fraction of a second. If the mic misses the click
  (meeting apps turn on noise suppression), you'll see *"Saw your snap but
  didn't hear it"*. Snap once more and two clear snaps in a row count. If no
  mic is available, a stricter hand-only check is used.
* **Empty room.** A person-segmentation model separates you from the
  background. While you're visible, every bit of room the camera sees is
  remembered (a "clean plate"). The parts that were always behind you are
  filled in by **MI-GAN**, an image-inpainting network trained on room and
  scene photos. It runs in a background worker ahead of time, so the empty
  room is ready the moment you snap. While you're gone, the rest of the room
  stays live video, and you are replaced by the room wherever you move.
* **Dust.** At the snap your pixels are frozen and turned into particles. The
  body crumbles from the downwind edge in noisy patches. The flakes keep their
  colour, darken to ash, swirl and blow away. Reappearing runs the same
  simulation backwards onto where you are now.
* **Mic.** The real mic track is disabled at the source while you're vanished,
  so the meeting only gets silence. The meeting app still sees its own mute
  state unchanged. Snap Vanish also presses the meeting's own mute button (Meet,
  Teams, Zoom) so its UI matches, and it un-presses the button only if it was
  the one that pressed it.
* **Fail-safe.** While the effect is on, raw camera frames are never passed
  through. If the processor stalls, the last processed frame is repeated.

## Privacy

* All models and runtimes are bundled in the extension (`vendor/`, `models/`).
  Nothing is downloaded or uploaded at run time, and the extension makes no
  network requests.
* Video frames only travel between the meeting tab and the extension's own
  iframe inside that same tab.
* The click-sound detector listens to a private copy of the microphone. It
  only measures loudness and pitch locally and never records or sends audio.
* Permissions: `storage` only (for your settings). Content scripts run only on
  `meet.google.com`, `teams.microsoft.com`, `teams.live.com`,
  `teams.cloud.microsoft`, `*.zoom.us` and `*.zoom.com`.

## Tips and limitations

* Snap with your hand clearly in view, 20–60 cm from the camera. Hold the
  ready pose for a moment, then snap.
* For the most convincing empty room, move around a little early in the call
  so the camera sees what's behind you. Areas it has never seen are AI
  inpainted. That looks plausible, but it is a guess.
* Turn off the meeting app's own background blur/replace.
* A GPU makes everything smooth. On machines without hardware graphics,
  MediaPipe falls back to the CPU and the effect runs at a lower frame rate.
* If you turn the extension on while your camera is already running, turn the
  camera off and on once in the meeting.
* Meeting apps change their pages often. If an app's mute button can't be
  found, your mic is still muted at the source, but the app's mic icon won't
  change.
* Needs Chrome 116 or newer.

## Development

```bash
cd snap-vanish
bash scripts/fetch-vendor.sh   # downloads MediaPipe, ONNX Runtime and the 3 models into extension/
npm test                       # unit tests: snap gesture + snap sound detectors
NODE_PATH="$(npm root -g)" npm run test:e2e   # Chromium + extension + fake camera on a strict-CSP fake Meet page
bash scripts/build-zip.sh      # → dist/snap-vanish.zip
```

`extension/` is the unpacked extension. The large third-party files
(`extension/vendor`, `extension/models`) are not committed; the fetch script
downloads them, and they are included in the zip.

| Path | Purpose |
|---|---|
| `extension/content/inject.js` | Page hook: getUserMedia wrapper, video pipeline, mic mute, snap fusion, on-page toasts |
| `extension/content/bridge.js` | Relays settings and commands between the extension and the page hook |
| `extension/processor/processor.js` | Hidden iframe: MediaPipe tasks, per-session state, inpainting scheduler |
| `extension/processor/renderer.js` | WebGL2: mask dilation, room memory, room fill, compositing, dust particles |
| `extension/processor/inpaint-worker.js` | MI-GAN inpainting with ONNX Runtime Web (WASM) |
| `extension/shared/snap-gesture.js` | Hand-landmark snap detector |
| `extension/shared/snap-audio.js` | Click-sound detector |
| `extension/popup/` | Popup UI |
| `extension/background.js` | Keyboard shortcut, routes "Snap now" to the tab with the camera |

Third-party licences: see `extension/THIRD_PARTY_NOTICES.md`.
