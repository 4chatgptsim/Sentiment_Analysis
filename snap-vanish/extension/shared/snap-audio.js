// Snap Vanish — finger-snap click detector for microphone audio.
//
// Used only to *confirm* a snap seen by the hand tracker. A snap click is a
// very short, sharp, mostly high-frequency transient that dies away within a
// few tens of milliseconds. Speech (slow onsets, sustained, low-frequency),
// "sss" sounds (sustained) and background hum don't qualify.
//
// Loaded as a plain script into the page (no modules there), so it publishes
// itself on globalThis under a private name that the content script picks up
// and removes again.
(function (root) {
  'use strict';

  const HOP_SEC = 0.002;        // energy envelope resolution
  const LOOKAHEAD_SEC = 0.075;  // need to see the decay before deciding
  const RING = 512;

  function dbRatio(a, b) { return 10 * Math.log10((a + 1e-14) / (b + 1e-14)); }

  class SnapAudioDetector {
    constructor(opts = {}) {
      this.sr = opts.sampleRate || 48000;
      this.hop = Math.max(16, Math.round(this.sr * HOP_SEC));
      this.hopMs = (this.hop / this.sr) * 1000;
      this.look = Math.ceil(LOOKAHEAD_SEC / HOP_SEC);
      this.hp = new Float64Array(RING);
      this.full = new Float64Array(RING);
      this.time = new Float64Array(RING);
      this.count = 0;        // hops written
      this.evaluated = 0;    // hops evaluated
      this.accHp = 0; this.accFull = 0; this.accN = 0;
      this.noise = 1e-9;
      this.blockUntil = -Infinity;
      this.lastLevelDb = -120;
      this._initFilter(1500);
      this.setSensitivity(opts.sensitivity ?? 5);
    }

    setSensitivity(sensitivity) {
      const s = Math.min(10, Math.max(1, Number(sensitivity) || 5));
      const u = (s - 5) / 5; // -0.8 … +1
      this.cfg = {
        aboveNoiseDb: 20 - 6 * u,   // how far above the room's noise floor
        attackDb: 11 - 3 * u,       // jump vs. the previous ~20 ms
        minLevelDb: -50 - 8 * u,    // absolute level (dBFS power, high band)
        decayDb: 10 - 3 * u,        // must fall this much within ~60 ms
        hfRatio: 0.22 - 0.06 * u,   // share of energy above ~1.5 kHz
        refractoryMs: 180,
      };
    }

    _initFilter(fc) {
      // 2nd-order Butterworth high-pass (RBJ cookbook).
      const w0 = (2 * Math.PI * fc) / this.sr;
      const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
      const a0 = 1 + alpha;
      this.b0 = (1 + cos) / 2 / a0; this.b1 = -(1 + cos) / a0; this.b2 = this.b0;
      this.a1 = (-2 * cos) / a0; this.a2 = (1 - alpha) / a0;
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
    }

    // samples: Float32Array (mono, -1..1). tEndMs: wall-clock time (ms) of
    // the last sample. Returns an array of { t, strength } snap events.
    process(samples, tEndMs) {
      const events = [];
      const n = samples.length;
      const msPerSample = 1000 / this.sr;
      for (let i = 0; i < n; i++) {
        const x = samples[i];
        const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
        this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
        this.accHp += y * y; this.accFull += x * x; this.accN++;
        if (this.accN === this.hop) {
          const idx = this.count % RING;
          this.hp[idx] = this.accHp / this.hop;
          this.full[idx] = this.accFull / this.hop;
          this.time[idx] = tEndMs - (n - 1 - i) * msPerSample - this.hopMs / 2;
          this.count++;
          this.accHp = this.accFull = 0; this.accN = 0;
          this._trackNoise(this.hp[idx]);
          this.lastLevelDb = 10 * Math.log10(this.hp[idx] + 1e-14);
          while (this.evaluated < this.count - this.look) {
            const ev = this._evaluate(this.evaluated);
            if (ev) events.push(ev);
            this.evaluated++;
          }
        }
      }
      return events;
    }

    _trackNoise(e) {
      // Minimum-statistics style floor: drops fast, rises slowly (~3 dB/s).
      if (e < this.noise) this.noise = Math.max(1e-12, 0.7 * this.noise + 0.3 * e);
      else this.noise *= 1.0015;
    }

    _e(arr, k) { return arr[((k % RING) + RING) % RING]; }

    _mean(arr, from, to) {
      let s = 0, c = 0;
      for (let k = from; k <= to; k++) { if (k < 0 || k >= this.count) continue; s += this._e(arr, k); c++; }
      return c ? s / c : 0;
    }

    _evaluate(k) {
      if (k < 12) return null;
      const C = this.cfg;
      const t = this._e(this.time, k);
      if (t < this.blockUntil) return null;
      const e = this._e(this.hp, k);
      const hopsPerMs = 1 / this.hopMs;
      // Must be the first hop of the burst (local onset), not its tail.
      const before = this._mean(this.hp, k - Math.round(24 * hopsPerMs), k - Math.round(6 * hopsPerMs));
      if (dbRatio(e, before) < C.attackDb) return null;
      if (10 * Math.log10(e + 1e-14) < C.minLevelDb) return null;
      // Peak of the burst within the next ~8 ms.
      let peak = e;
      for (let j = 1; j <= Math.round(8 * hopsPerMs); j++) peak = Math.max(peak, this._e(this.hp, k + j));
      if (dbRatio(peak, Math.max(this.noise, before)) < C.aboveNoiseDb) return null;
      // Fast decay: 35–65 ms later the click must be mostly gone.
      const tail = this._mean(this.hp, k + Math.round(35 * hopsPerMs), k + Math.round(65 * hopsPerMs));
      if (dbRatio(peak, tail) < C.decayDb) return null;
      // Mostly high-frequency energy.
      let hpSum = 0, fullSum = 0;
      for (let j = 0; j <= Math.round(12 * hopsPerMs); j++) { hpSum += this._e(this.hp, k + j); fullSum += this._e(this.full, k + j); }
      if (hpSum / (fullSum + 1e-14) < C.hfRatio) return null;
      this.blockUntil = t + C.refractoryMs;
      return { t, strength: Math.round(dbRatio(peak, Math.max(this.noise, before)) * 10) / 10 };
    }
  }

  root.__snapVanishAudio = SnapAudioDetector;
})(typeof globalThis !== 'undefined' ? globalThis : this);
