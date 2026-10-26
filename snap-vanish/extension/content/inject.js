// Snap Vanish — page-world hook.
//
// Runs inside the meeting page (Google Meet / Teams / Zoom web) before the
// app's own scripts. It wraps navigator.mediaDevices.getUserMedia so that:
//
//   • the camera track handed to the meeting app is our own track. Normally
//     it is the untouched camera frames (zero-copy passthrough). While the
//     dust effect or the "vanished" state is active, frames are rendered by
//     the Snap Vanish processor (a hidden extension iframe that does all the
//     AI work locally) and the app receives those instead.
//   • microphone tracks can be force-muted while vanished, without the app
//     losing track of its own mute state.
//   • a private copy of the mic is analysed for the snap's click sound.
//
// Nothing is sent anywhere: frames only travel between this page and the
// extension's own iframe inside the same browser tab.
(() => {
  'use strict';
  if (window.__snapVanishHooked) return;
  Object.defineProperty(window, '__snapVanishHooked', { value: true });

  const SnapAudioDetector = globalThis.__snapVanishAudio;
  try { delete globalThis.__snapVanishAudio; } catch { /* ignore */ }

  if (!window.MediaDevices || !MediaDevices.prototype.getUserMedia) return;

  const TO_PAGE = '__snapvanish_to_page';
  const FROM_PAGE = '__snapvanish_from_page';
  const ANALYZE_MAX_W = 960;    // analysis frames (hand tracking + background learning)
  const HAND_ONLY_MIN_SCORE = 0.55;
  const LOG = '[Snap Vanish]';

  const now = () => performance.timeOrigin + performance.now(); // shared clock with the iframe
  // Troubleshooting counters (request them with a {type:'debug'} bridge event).
  const stats = { passthrough: 0, sentAnalyze: 0, sentRender: 0, received: 0, written: 0, staleDropped: 0, frameErrors: 0, repeated: 0, busyDropped: 0 };
  const warn = (...a) => console.warn(LOG, ...a);

  // ---------------------------------------------------------------------------
  // Settings / extension bridge
  // ---------------------------------------------------------------------------
  let settings = null;
  let extBase = null;
  let configured;
  const configuredP = new Promise((r) => (configured = r));

  const toBridge = (msg) => window.dispatchEvent(new CustomEvent(FROM_PAGE, { detail: JSON.stringify(msg) }));

  window.addEventListener(TO_PAGE, (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    if (msg.type === 'config') {
      // The extension URL is accepted once, from the bridge that runs first.
      if (!extBase && typeof msg.extBase === 'string' && msg.extBase.startsWith('chrome-extension://')) extBase = msg.extBase;
      applySettings(msg.settings);
      configured();
    } else if (msg.type === 'settings') {
      applySettings(msg.settings);
    } else if (msg.type === 'snap-now') {
      controller.manualToggle();
    } else if (msg.type === 'debug') {
      toBridge({ type: 'debug', stats, state: controller.state, ready: proc.ready });
    }
  });

  function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    const prev = settings;
    settings = { ...s };
    audioMonitor.setSensitivity(settings.sensitivity);
    proc.post({ type: 'settings', settings });
    if (prev && prev.enabled && !settings.enabled) controller.onDisabled();
    if (prev && prev.muteMic && !settings.muteMic && controller.state !== 'visible') mic.setForced(false);
    status.push();
  }

  // ---------------------------------------------------------------------------
  // Microphone: force-mute without fighting the app's own mute state
  // ---------------------------------------------------------------------------
  const trackProto = MediaStreamTrack.prototype;
  const enabledDesc = Object.getOwnPropertyDescriptor(trackProto, 'enabled');
  const nativeStop = trackProto.stop;
  const nativeClone = trackProto.clone;
  const appEnabled = new WeakMap();

  const mic = {
    tracks: new Set(),
    forced: false,

    manage(track, initial) {
      if (track.kind !== 'audio' || appEnabled.has(track)) return;
      appEnabled.set(track, initial ?? enabledDesc.get.call(track));
      Object.defineProperty(track, 'enabled', {
        configurable: true,
        enumerable: true,
        get() { return appEnabled.get(track); },
        set(v) { appEnabled.set(track, !!v); mic.apply(track); },
      });
      this.tracks.add(track);
      this.apply(track);
      track.addEventListener('ended', () => this.forget(track));
      audioMonitor.attach();
    },

    apply(track) {
      try { enabledDesc.set.call(track, appEnabled.get(track) && !this.forced); } catch { /* ignore */ }
    },

    setForced(on) {
      this.forced = !!on;
      for (const t of this.tracks) this.apply(t);
      status.push();
    },

    forget(track) {
      this.tracks.delete(track);
      audioMonitor.attach();
    },

    liveTracks() {
      return [...this.tracks].filter((t) => t.readyState === 'live');
    },
  };

  // Keep clones of managed mic tracks managed, and notice when the app stops them.
  trackProto.clone = function clone() {
    const c = nativeClone.call(this);
    if (appEnabled.has(this)) mic.manage(c, appEnabled.get(this));
    return c;
  };
  trackProto.stop = function stop() {
    nativeStop.call(this);
    if (mic.tracks.has(this)) mic.forget(this);
  };
  disguise(trackProto.clone, nativeClone);
  disguise(trackProto.stop, nativeStop);

  // Best-effort sync with the meeting's own mute button so its UI matches.
  // Only ever clicks the user's own microphone toggle, and only to flip it into
  // the state we want.
  const nativeMic = {
    find() {
      const host = location.hostname;
      const visible = (el) => el && el.getClientRects().length > 0 && !el.disabled;
      const all = (sel) => [...document.querySelectorAll(sel)].filter(visible);
      let cands = [];
      if (host === 'meet.google.com') {
        cands = all('[data-is-muted][aria-label]').filter((el) => {
          const l = el.getAttribute('aria-label').toLowerCase();
          return /microphone/.test(l) && (/ctrl|⌘|\+\s*d\b/.test(l) || /^turn (on|off) microphone/.test(l));
        });
      } else if (/teams\./.test(host)) {
        cands = all('#microphone-button, button[data-tid="microphone-button"], button[data-track-module-name="muteButton"]');
      } else if (/zoom\./.test(host)) {
        cands = all('button.join-audio-container__btn, button[aria-label^="mute my microphone" i], button[aria-label^="unmute my microphone" i]');
      }
      return cands[0] || null;
    },
    isMuted(btn) {
      if (btn.hasAttribute('data-is-muted')) return btn.getAttribute('data-is-muted') === 'true';
      const l = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
      if (/^(unmute|turn on microphone)/.test(l)) return true;
      if (/^(mute|turn off microphone)/.test(l)) return false;
      return null;
    },
    set(muted) {
      try {
        const btn = this.find();
        if (!btn || this.isMuted(btn) !== !muted) return false;
        btn.click();
        return true;
      } catch {
        return false;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Snap click detection on a private copy of the microphone
  // ---------------------------------------------------------------------------
  const audioMonitor = {
    ctx: null,
    track: null,
    sourceTrack: null,
    nodes: [],
    detector: null,
    lastAudioAt: 0,
    analyser: null,
    analyserBuf: null,
    lastCtxTime: 0,

    attach() {
      const live = mic.liveTracks();
      if (this.track && this.track.readyState === 'live' && live.includes(this.sourceTrack)) return;
      this.detach();
      if (!live.length || !SnapAudioDetector) return;
      try {
        this.sourceTrack = live[0];
        this.track = nativeClone.call(this.sourceTrack);
        enabledDesc.set.call(this.track, true);
        if (!this.ctx || this.ctx.state === 'closed') {
          this.ctx = new AudioContext({ latencyHint: 'interactive' });
          const resume = () => { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); };
          for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, resume, { capture: true, passive: true });
        }
        this.ctx.resume().catch(() => {});
        this.detector = new SnapAudioDetector({ sampleRate: this.ctx.sampleRate, sensitivity: settings ? settings.sensitivity : 5 });
        const src = this.ctx.createMediaStreamSource(new MediaStream([this.track]));
        const sink = this.ctx.createGain();
        sink.gain.value = 0;
        let node;
        try {
          node = this.ctx.createScriptProcessor(1024, 1, 1);
          node.onaudioprocess = (e) => this.feed(e.inputBuffer.getChannelData(0), now() - (this.ctx.baseLatency || 0) * 1000);
          src.connect(node);
          node.connect(sink);
        } catch {
          // No ScriptProcessor: poll an analyser from the video frame loop instead.
          node = this.ctx.createAnalyser();
          node.fftSize = 4096;
          this.analyser = node;
          this.analyserBuf = new Float32Array(node.fftSize);
          this.lastCtxTime = this.ctx.currentTime;
          src.connect(node);
          node.connect(sink);
        }
        sink.connect(this.ctx.destination);
        this.nodes = [src, node, sink];
      } catch (err) {
        warn('mic analysis unavailable', err);
        this.detach();
      }
    },

    detach() {
      for (const n of this.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
      this.nodes = [];
      this.analyser = null;
      if (this.track) { try { nativeStop.call(this.track); } catch { /* ignore */ } }
      this.track = null;
      this.sourceTrack = null;
    },

    feed(samples, tEnd) {
      this.lastAudioAt = now();
      if (!this.detector) return;
      for (const ev of this.detector.process(samples, tEnd)) controller.onAudioSnap(ev);
    },

    poll() {
      if (!this.analyser || !this.ctx || this.ctx.state !== 'running') return;
      const ct = this.ctx.currentTime;
      const fresh = Math.min(this.analyserBuf.length, Math.round((ct - this.lastCtxTime) * this.ctx.sampleRate));
      this.lastCtxTime = ct;
      if (fresh <= 0) return;
      this.analyser.getFloatTimeDomainData(this.analyserBuf);
      this.feed(this.analyserBuf.subarray(this.analyserBuf.length - fresh), now());
    },

    setSensitivity(s) {
      if (this.detector) this.detector.setSensitivity(s);
    },

    get live() {
      return !!(this.track && this.track.readyState === 'live' && this.ctx && this.ctx.state === 'running' && now() - this.lastAudioAt < 1500);
    },
  };

  // ---------------------------------------------------------------------------
  // The processor iframe (extension origin: MediaPipe + WebGL + inpainting)
  // ---------------------------------------------------------------------------
  const proc = {
    iframe: null,
    port: null,
    ready: false,
    loading: false,
    info: {},

    ensure() {
      if (this.iframe && this.iframe.isConnected) return;
      if (!extBase) return;
      this.reset();
      const f = document.createElement('iframe');
      f.src = `${extBase}processor/processor.html`;
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.title = 'Snap Vanish';
      f.style.cssText = 'position:fixed!important;left:0!important;top:0!important;width:2px!important;height:2px!important;' +
        'opacity:0!important;pointer-events:none!important;border:0!important;z-index:-2147483647!important;';
      f.addEventListener('load', () => {
        if (this.iframe !== f) return;
        const ch = new MessageChannel();
        this.port = ch.port1;
        this.port.onmessage = (e) => this.onMessage(e.data);
        this.port.onmessageerror = () => { stats.messageErrors = (stats.messageErrors || 0) + 1; };
        f.contentWindow.postMessage({ type: 'snapvanish-connect' }, extBase.replace(/\/$/, ''), [ch.port2]);
        this.post({ type: 'hello', settings, effect: controller.effectMsg() });
      });
      this.iframe = f;
      this.loading = true;
      (document.documentElement || document).appendChild(f);
      status.push();
    },

    reset() {
      if (this.iframe) { try { this.iframe.remove(); } catch { /* ignore */ } }
      if (this.port) { try { this.port.close(); } catch { /* ignore */ } }
      this.iframe = null;
      this.port = null;
      this.ready = false;
      for (const s of sessions) s.resetInflight();
    },

    post(msg, transfer) {
      if (!this.port) return false;
      try {
        this.port.postMessage(msg, transfer || []);
        return true;
      } catch {
        return false;
      }
    },

    onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'status': {
          const wasReady = this.ready;
          this.info = msg;
          this.ready = !!msg.ready;
          this.loading = !!msg.loading;
          if (this.ready && !wasReady) toast.show('Snap Vanish is ready — snap your fingers to vanish ✨');
          if (msg.error && !this.ready) toast.show(`Snap Vanish couldn't start: ${msg.error}`, 6000);
          status.push();
          break;
        }
        case 'ack':
        case 'frame': {
          const s = sessionById.get(msg.sid);
          if (s) s.onProcessed(msg);
          else if (msg.bmp) msg.bmp.close();
          break;
        }
        case 'visual-snap':
          controller.onVisualSnap(msg);
          break;
        default:
          break;
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Camera sessions
  // ---------------------------------------------------------------------------
  const sessions = new Set();
  const sessionById = new Map();
  let sessionSeq = 0;
  const hasBreakoutBox = typeof window.MediaStreamTrackProcessor === 'function' && typeof window.MediaStreamTrackGenerator === 'function';

  class VideoSession {
    constructor(src) {
      this.id = ++sessionSeq;
      this.src = src;
      this.alive = true;
      this.refs = new Set();
      this.lastWrittenTs = -Infinity;
      this.lastWriteAt = 0;
      this.lastOut = null;
      this.resetInflight();
      if (hasBreakoutBox) this.setupBreakoutBox();
      else this.setupFallback();
      dressTrack(this.output, this);
      src.addEventListener('ended', () => this.stop(true));
      sessions.add(this);
      sessionById.set(this.id, this);
      proc.ensure();
      status.push();
    }

    resetInflight() {
      this.analyzing = false;
      this.rendering = 0;
      this.sentAt = 0;
      this.replyAt = 0;
    }

    setupBreakoutBox() {
      const processor = new MediaStreamTrackProcessor({ track: this.src });
      this.reader = processor.readable.getReader();
      this.output = new MediaStreamTrackGenerator({ kind: 'video' });
      this.writer = this.output.writable.getWriter();
      this.writeFrame = (frame) => this.writer.write(frame).catch(() => { try { frame.close(); } catch { /* ignore */ } });
      this.pump();
    }

    // Older browsers: <video> + requestVideoFrameCallback in, canvas capture out.
    setupFallback() {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([this.src]);
      video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
      (document.documentElement || document).appendChild(video);
      video.play().catch(() => {});
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(0);
      this.output = stream.getVideoTracks()[0];
      this.writeFrame = (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        if (this.output.requestFrame) this.output.requestFrame();
      };
      this.fallbackVideo = video;
      const onFrame = (_now, meta) => {
        if (!this.alive) return;
        try {
          this.onFrame(new VideoFrame(video, { timestamp: Math.round((meta.mediaTime || performance.now() / 1000) * 1e6) }));
        } catch { /* frame not ready */ }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }

    async pump() {
      try {
        while (this.alive) {
          const { value: frame, done } = await this.reader.read();
          if (done) break;
          if (!this.alive) { frame.close(); break; }
          this.onFrame(frame);
        }
      } catch (err) {
        if (this.alive) warn('camera read failed', err);
      }
      this.stop(this.src.readyState === 'ended');
    }

    onFrame(frame) {
      const t = now();
      controller.tick(t);
      audioMonitor.poll();
      if (!proc.iframe || !proc.iframe.isConnected) proc.ensure();
      if (controller.needsRender()) {
        this.renderFrame(frame, t);
        return;
      }
      this.dropHeld();
      stats.passthrough++;
      if (proc.ready && controller.wantsAnalysis(this) && !this.analyzing) this.sendForAnalysis(frame, t);
      else if (this.analyzing && t - this.sentAt > 3000) this.analyzing = false; // lost reply
      this.write(frame);
    }

    sendForAnalysis(frame, t) {
      this.analyzing = true;
      this.sentAt = t;
      stats.sentAnalyze++;
      const ts = frame.timestamp;
      const w = frame.displayWidth, h = frame.displayHeight;
      const scale = Math.min(1, ANALYZE_MAX_W / w);
      const clone = frame.clone();
      createImageBitmap(clone, { resizeWidth: Math.round(w * scale), resizeHeight: Math.round(h * scale), resizeQuality: 'medium' })
        .then((bmp) => {
          clone.close();
          if (!proc.post({ type: 'frame', sid: this.id, ts, t, render: false, bmp, primary: true }, [bmp])) {
            bmp.close();
            this.analyzing = false;
          }
        })
        .catch(() => { clone.close(); this.analyzing = false; });
    }

    renderFrame(frame, t) {
      const ts = frame.timestamp;
      if (this.rendering > 0 && t - this.sentAt > 800 && t - this.replyAt > 800) this.rendering = 0; // replies lost
      if (!proc.ready || this.rendering >= 2) {
        // Processor busy or unavailable. Never leak the live camera while the
        // effect is on: repeat the last processed frame instead.
        frame.close();
        stats.busyDropped++;
        this.repeatLast();
        return;
      }
      this.rendering++;
      stats.sentRender++;
      this.sentAt = t;
      createImageBitmap(frame)
        .then((bmp) => {
          frame.close();
          const primary = controller.primary() === this;
          if (!proc.post({ type: 'frame', sid: this.id, ts, t, render: true, bmp, primary }, [bmp])) {
            bmp.close();
            this.rendering = Math.max(0, this.rendering - 1);
          }
        })
        .catch(() => { frame.close(); this.rendering = Math.max(0, this.rendering - 1); });
    }

    onProcessed(msg) {
      this.replyAt = now();
      if (msg.type === 'ack') { this.analyzing = false; return; }
      this.rendering = Math.max(0, this.rendering - 1);
      if (!msg.bmp) return;
      stats.received++;
      if (!this.alive || msg.ts <= this.lastWrittenTs) { stats.staleDropped++; msg.bmp.close(); return; }
      let vf;
      try {
        vf = new VideoFrame(msg.bmp, { timestamp: msg.ts });
      } catch (err) {
        if (!stats.frameErrors++) warn('could not use processed frame', err);
        msg.bmp.close();
        return;
      }
      msg.bmp.close();
      if (controller.needsRender()) {
        if (this.lastOut) this.lastOut.close();
        this.lastOut = vf.clone();
      }
      this.write(vf);
    }

    // Keep-alive when the processor has stalled: re-send the last processed
    // frame. Its timestamp is bumped by 1 µs only, so it can never make the
    // real processed frames that are still in flight look out of date.
    repeatLast() {
      if (!this.lastOut || now() - this.lastWriteAt < 500) return;
      stats.repeated++;
      try { this.write(new VideoFrame(this.lastOut, { timestamp: this.lastWrittenTs + 1 })); } catch { /* ignore */ }
    }

    dropHeld() {
      if (this.lastOut) { this.lastOut.close(); this.lastOut = null; }
    }

    write(frame) {
      if (!this.alive || frame.timestamp <= this.lastWrittenTs) { frame.close(); return; }
      this.lastWrittenTs = frame.timestamp;
      this.lastWriteAt = now();
      stats.written++;
      this.writeFrame(frame);
    }

    release(track) {
      try { nativeStop.call(track); } catch { /* ignore */ }
      this.refs.delete(track);
      if (!this.refs.size) this.stop(false);
    }

    stop(ended) {
      if (!this.alive) return;
      this.alive = false;
      sessions.delete(this);
      sessionById.delete(this.id);
      try { this.reader && this.reader.cancel().catch(() => {}); } catch { /* ignore */ }
      try { nativeStop.call(this.src); } catch { /* ignore */ }
      try { this.writer && this.writer.close().catch(() => {}); } catch { /* ignore */ }
      if (this.fallbackVideo) { this.fallbackVideo.srcObject = null; this.fallbackVideo.remove(); }
      this.dropHeld();
      proc.post({ type: 'session-end', sid: this.id });
      for (const t of [...this.refs]) {
        try { nativeStop.call(t); } catch { /* ignore */ }
        if (ended) t.dispatchEvent(new Event('ended'));
      }
      this.refs.clear();
      status.push();
    }
  }

  // Make our output track look and behave like the real camera track.
  function dressTrack(track, session) {
    const src = session.src;
    const method = (name, fn) => ({ value: disguise(fn, trackProto[name]), configurable: true, writable: true });
    Object.defineProperties(track, {
      label: { get: () => src.label, configurable: true },
      getSettings: method('getSettings', function getSettings() { return src.getSettings(); }),
      getCapabilities: method('getCapabilities', function getCapabilities() { return src.getCapabilities ? src.getCapabilities() : {}; }),
      getConstraints: method('getConstraints', function getConstraints() { return src.getConstraints(); }),
      applyConstraints: method('applyConstraints', function applyConstraints(c) { return src.applyConstraints(c); }),
      stop: method('stop', function stop() { session.release(track); }),
      clone: method('clone', function clone() {
        const c = nativeClone.call(track);
        dressTrack(c, session);
        return c;
      }),
    });
    session.refs.add(track);
  }

  function disguise(fn, native) {
    if (native) {
      try {
        const str = Function.prototype.toString.call(native);
        Object.defineProperty(fn, 'toString', { value: () => str, configurable: true });
      } catch { /* ignore */ }
    }
    return fn;
  }

  // ---------------------------------------------------------------------------
  // getUserMedia hook
  // ---------------------------------------------------------------------------
  const nativeGUM = MediaDevices.prototype.getUserMedia;
  const hookedGUM = async function getUserMedia(constraints) {
    const stream = await nativeGUM.call(this, constraints);
    try {
      return await wrapStream(stream);
    } catch (err) {
      warn('could not attach to camera, passing it through untouched', err);
      return stream;
    }
  };
  disguise(hookedGUM, nativeGUM);
  Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: hookedGUM, writable: true, configurable: true, enumerable: true });

  async function wrapStream(stream) {
    await Promise.race([configuredP, new Promise((r) => setTimeout(r, 2000))]);
    if (!settings || !settings.enabled || !extBase) return stream;
    for (const t of stream.getAudioTracks()) mic.manage(t);
    const video = stream.getVideoTracks();
    if (!video.length) return stream;
    const out = new MediaStream();
    for (const t of stream.getTracks()) out.addTrack(t.kind === 'video' ? new VideoSession(t).output : t);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Vanish / reappear state machine + snap fusion
  // ---------------------------------------------------------------------------
  const controller = {
    state: 'visible', // visible → vanishing → vanished → appearing → visible
    start: 0,
    duration: 3000,
    cooldownUntil: 0,
    nativeMuted: false,
    visual: [],
    audio: [],
    lastUnheard: 0,

    primary() {
      let p = null;
      for (const s of sessions) if (s.alive && (!p || s.id > p.id)) p = s;
      return p;
    },
    wantsAnalysis(session) {
      return !!(settings && settings.enabled) && this.primary() === session;
    },
    needsRender() {
      return this.state !== 'visible';
    },
    effectMsg() {
      return {
        type: 'effect',
        state: this.state,
        start: this.start,
        duration: this.duration,
        direction: (settings && settings.direction) || 'right',
      };
    },

    setState(state) {
      this.state = state;
      proc.post(this.effectMsg());
      status.push();
    },

    tick(t = now()) {
      if ((this.state === 'vanishing' || this.state === 'appearing') && t >= this.start + this.duration) {
        if (this.state === 'vanishing') {
          this.setState('vanished');
          toast.pin('Vanished 👻 — snap again to come back');
          if (!settings || !settings.enabled) this.appear('disabled'); // switched off mid-snap
        } else {
          this.finishAppear();
        }
      }
    },

    finishAppear() {
      this.setState('visible');
      toast.pin(null);
      if (this.nativeMuted) nativeMic.set(false);
      this.nativeMuted = false;
      if (mic.forced) {
        mic.setForced(false);
        toast.show('You’re back — mic on 🎙️');
      } else {
        toast.show('You’re back ✨');
      }
    },

    vanish(source) {
      if (this.state !== 'visible') return false;
      if (!settings || !settings.enabled) return false;
      if (!this.primary()) { toast.show('Turn your camera on first, then snap.'); return false; }
      if (!proc.ready) { toast.show('Snap Vanish is still loading its AI models…'); return false; }
      this.duration = Math.round((settings.duration || 3) * 1000);
      this.start = now();
      this.cooldownUntil = this.start + this.duration + 600;
      if (settings.muteMic) {
        mic.setForced(true);
        this.nativeMuted = nativeMic.set(true);
      }
      this.setState('vanishing');
      toast.show(settings.muteMic ? 'Snap! Turning to dust… mic muted 🔇' : 'Snap! Turning to dust…');
      console.info(LOG, `vanish (${source})`);
      return true;
    },

    appear(source) {
      if (this.state !== 'vanished') return false;
      this.duration = Math.round(((settings && settings.duration) || 3) * 1000);
      this.start = now();
      this.cooldownUntil = this.start + this.duration + 600;
      if (!this.primary() || !proc.ready) {
        this.finishAppear(); // nothing on camera to animate
      } else {
        this.setState('appearing');
        toast.pin(null);
        toast.show('Snap! Reassembling…');
      }
      console.info(LOG, `appear (${source})`);
      return true;
    },

    toggle(source) {
      if (this.state === 'visible') return this.vanish(source);
      if (this.state === 'vanished') return this.appear(source);
      return false;
    },

    manualToggle() {
      if (this.state === 'vanishing' || this.state === 'appearing') return;
      if ((!settings || !settings.enabled) && this.state === 'visible') { toast.show('Snap Vanish is switched off.'); return; }
      this.toggle('shortcut');
    },

    onDisabled() {
      if (this.state === 'vanished') this.appear('disabled');
    },

    onVisualSnap(ev) {
      if (!settings || !settings.enabled) return;
      console.debug(LOG, 'snap gesture', ev);
      this.visual.push({ ...ev, used: false });
      this.fuse();
    },

    onAudioSnap(ev) {
      console.debug(LOG, 'snap sound', ev);
      this.audio.push({ ...ev, used: false });
      this.fuse();
    },

    fuse() {
      const t = now();
      this.visual = this.visual.filter((v) => !v.used && t - v.t < 2500);
      this.audio = this.audio.filter((a) => !a.used && t - a.t < 1500);
      if (!settings || t < this.cooldownUntil || (this.state !== 'visible' && this.state !== 'vanished')) return;
      const needSound = settings.requireSound && audioMonitor.live;
      for (const v of this.visual) {
        if (!needSound) {
          if (v.score >= HAND_ONLY_MIN_SCORE && v.fast) { v.used = true; this.toggle('hand'); return; }
          continue;
        }
        // The click is usually heard slightly before the video frame shows the
        // finished snap (camera latency); allow generous slack either way.
        const a = this.audio.find((x) => x.t - v.t >= -450 && x.t - v.t <= 250);
        if (a) { v.used = a.used = true; this.toggle('hand+sound'); return; }
      }
    },

    // A clear snap that the mic didn't hear (noise suppression can swallow the
    // click): ask for a second one, and accept two in a row.
    checkUnheard() {
      if (!settings || !settings.enabled || !settings.requireSound || !audioMonitor.live) return;
      const t = now();
      if (t < this.cooldownUntil || (this.state !== 'visible' && this.state !== 'vanished')) return;
      for (const v of this.visual) {
        if (v.used || v.unheardChecked || t - v.t < 500) continue;
        v.unheardChecked = true;
        if (!(v.score >= HAND_ONLY_MIN_SCORE && v.fast)) continue;
        if (this.lastUnheard && v.t - this.lastUnheard > 400 && v.t - this.lastUnheard < 6000) {
          this.lastUnheard = 0;
          v.used = true;
          this.toggle('hand twice');
          return;
        }
        this.lastUnheard = v.t;
        toast.show('Saw your snap but didn’t hear it — snap once more to confirm');
      }
    },
  };

  // Advance the effect timeline even if the camera stops delivering frames.
  setInterval(() => {
    controller.tick();
    controller.checkUnheard();
    if (sessions.size && (!proc.iframe || !proc.iframe.isConnected)) proc.ensure();
  }, 250);

  // ---------------------------------------------------------------------------
  // Status reporting to the popup (via the bridge)
  // ---------------------------------------------------------------------------
  const status = {
    last: '',
    timer: 0,
    push() {
      if (this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = 0;
        const s = {
          hasSession: sessions.size > 0,
          state: controller.state,
          ready: proc.ready,
          loading: proc.loading && !proc.ready,
          error: (proc.info && proc.info.error) || null,
          inpaint: (proc.info && proc.info.inpaint) || null,
          micMuted: mic.forced,
          micListening: audioMonitor.live,
          enabled: !!(settings && settings.enabled),
          host: location.hostname,
        };
        const json = JSON.stringify(s);
        if (json === this.last) return;
        this.last = json;
        toBridge({ type: 'status', status: s });
      }, 50);
    },
  };
  setInterval(() => status.push(), 3000);

  // ---------------------------------------------------------------------------
  // Tiny on-page toast (only visible to you, never part of the video)
  // ---------------------------------------------------------------------------
  const toast = {
    root: null,
    msg: null,
    pinned: null,
    hideTimer: 0,

    mount() {
      if (this.root && this.root.host.isConnected) return true;
      const parent = document.body || document.documentElement;
      if (!parent) return false;
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed!important;left:16px!important;bottom:88px!important;z-index:2147483647!important;pointer-events:none!important;';
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        .wrap{display:flex;flex-direction:column;gap:8px;align-items:flex-start;font:500 13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
        .t{background:rgba(20,16,32,.92);color:#f5f3ff;padding:9px 14px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.35);
           border:1px solid rgba(167,139,250,.35);opacity:0;transform:translateY(6px);transition:opacity .25s,transform .25s;max-width:360px}
        .t.on{opacity:1;transform:none}
        .p{background:linear-gradient(90deg,#4c1d95,#7c3aed);border-color:rgba(253,230,138,.5)}`;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      this.pinned = document.createElement('div');
      this.pinned.className = 't p';
      this.msg = document.createElement('div');
      this.msg.className = 't';
      wrap.append(this.pinned, this.msg);
      root.append(style, wrap);
      parent.appendChild(host);
      this.root = root;
      return true;
    },

    show(text, ms = 3200) {
      if (!this.mount()) return;
      this.msg.textContent = text;
      this.msg.classList.add('on');
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.msg.classList.remove('on'), ms);
    },

    pin(text) {
      if (!this.mount()) return;
      if (text) this.pinned.textContent = text;
      this.pinned.classList.toggle('on', !!text);
    },
  };

  // Everything is initialised; ask the bridge for the settings.
  toBridge({ type: 'hello' });
})();
