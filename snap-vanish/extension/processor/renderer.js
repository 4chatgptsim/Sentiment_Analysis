// Snap Vanish — WebGL2 renderer.
//
// Per camera session it keeps:
//   • a soft, dilated person mask (with a short memory so fast motion never
//     leaves a visible trail),
//   • a learned "clean plate" of the room: every time a part of the room is
//     visible (not covered by you) it is remembered; alpha = confidence,
//   • the AI-inpainted plate (MI-GAN, computed in a worker) for the parts of
//     the room that were never seen,
//   • a snapshot of you at the moment of the snap, which is turned into
//     ~150k dust particles.
//
// Texture convention: row 0 = top of the image = uv.y 0 everywhere; only the
// final pass to the canvas flips.

const VS_QUAD = `#version 300 es
in vec2 aPos;
uniform float uFlip;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  if (uFlip > 0.5) vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s / 0.9375;
}
uniform vec4 uBox;     // person bounding box in uv (minX, minY, maxX, maxY)
uniform vec2 uDir;     // wind direction in uv space (y down)
uniform float uSpan;   // seconds over which the body crumbles
uniform float uAspect; // width / height
uniform float uSeed;
// When (seconds after the snap) this point of the body turns to dust:
// downwind edge first, in noisy patches, like the movie.
float releaseTime(vec2 uv) {
  vec2 c = 0.5 * (uBox.xy + uBox.zw);
  vec2 hs = max(0.5 * (uBox.zw - uBox.xy), vec2(0.05));
  vec2 p = clamp((uv - c) / hs, -1.5, 1.5);
  float g = clamp(0.5 - 0.5 * dot(p, uDir), 0.0, 1.0);
  float n = fbm(vec2(uv.x * uAspect, uv.y) * 7.0 + uSeed);
  return clamp(0.62 * g + 0.55 * (n - 0.5) + 0.2, 0.0, 1.0) * uSpan;
}`;

const FS_COPY = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uTex; out vec4 o;
void main() { o = texture(uTex, vUv); }`;

// Dilate the raw segmentation and keep a decaying memory of previous masks.
const FS_MASK = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uRaw, uPrev;
uniform vec2 uRadius;
uniform float uDecay, uHasPrev;
out vec4 o;
void main() {
  float m = texture(uRaw, vUv).r;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    vec2 d = vec2(cos(a), sin(a));
    m = max(m, texture(uRaw, vUv + d * uRadius).r);
    m = max(m, texture(uRaw, vUv + d * uRadius * 0.5).r);
  }
  float prev = (texture(uPrev, vUv).r - uDecay) * uHasPrev;
  o = vec4(max(m, prev), 0.0, 0.0, 1.0);
}`;

// Learn the empty room wherever it is visible.
const FS_LEARN = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPlate, uFrame, uMask;
uniform vec2 uRadius;
uniform float uRate;
out vec4 o;
void main() {
  vec4 P = texture(uPlate, vUv);
  vec3 c = texture(uFrame, vUv).rgb;
  float m = texture(uMask, vUv).r;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982;
    m = max(m, texture(uMask, vUv + vec2(cos(a), sin(a)) * uRadius).r);
  }
  float bg = 1.0 - smoothstep(0.03, 0.2, m);
  float rate = bg * max(uRate, 1.0 - P.a);
  P.rgb = mix(P.rgb, c, rate);
  P.a = P.a + (1.0 - P.a) * bg * 0.45;
  o = P;
}`;

const FS_PREMUL = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uPlate; out vec4 o;
void main() {
  vec4 P = texture(uPlate, vUv);
  float w = smoothstep(0.3, 0.7, P.a);
  o = vec4(P.rgb * w, w);
}`;

// Final "empty room": learned plate where known, AI fill (or a smooth
// pull-push fill while the AI result is not ready yet) where never seen.
const FS_ROOM = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPlate, uPremul, uAi;
uniform float uAiMix, uLevels;
out vec4 o;
vec3 pushPull(vec2 uv) {
  vec3 col = vec3(0.0); float rem = 1.0;
  for (int l = 1; l < 12; l++) {
    if (float(l) > uLevels) break;
    vec4 s = textureLod(uPremul, uv, float(l));
    float a = clamp(s.a * 3.0, 0.0, 1.0);
    col += rem * a * (s.rgb / max(s.a, 1e-4));
    rem *= 1.0 - a;
  }
  return col + rem * vec3(0.45);
}
void main() {
  vec4 P = texture(uPlate, vUv);
  vec3 fill = pushPull(vUv);
  if (uAiMix > 0.0) fill = mix(fill, texture(uAi, vUv).rgb, uAiMix);
  o = vec4(mix(fill, P.rgb, smoothstep(0.35, 0.85, P.a)), 1.0);
}`;

const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uFrame, uMask, uRoom;
uniform int uMode;   // 0 = you, 1 = crumbling / reassembling, 2 = vanished
uniform float uT;    // effect clock in seconds (runs backwards when reappearing)
out vec4 o;
${NOISE}
void main() {
  vec3 live = texture(uFrame, vUv).rgb;
  float m = smoothstep(0.12, 0.5, texture(uMask, vUv).r);
  vec3 room = texture(uRoom, vUv).rgb;
  float hide = 0.0, rim = 0.0;
  if (uMode == 2) {
    hide = m;
  } else if (uMode == 1) {
    float rel = releaseTime(vUv);
    float e = smoothstep(rel, rel + 0.1, uT);
    hide = m * e;
    rim = m * (1.0 - e) * smoothstep(rel - 0.35, rel, uT) * smoothstep(0.0, 0.25, uT);
  }
  vec3 col = mix(live, room, hide);
  col = mix(col, col * vec3(0.5, 0.43, 0.38), rim * 0.85);
  o = vec4(col, 1.0);
}`;

const VS_DUST = `#version 300 es
in vec2 aCell;
in vec4 aRnd;
uniform sampler2D uSnap, uSnapMask;
uniform float uT, uDur, uPx;
uniform vec2 uCell;
out vec4 vCol;
${NOISE}
void main() {
  vec2 uv = aCell + (aRnd.xy - 0.5) * uCell;
  float m = texture(uSnapMask, uv).r;
  float rel = releaseTime(uv);
  float age = uT - rel;
  float life = max(0.5, uDur - rel) * (0.7 + 0.3 * aRnd.z);
  float k = age / life;
  if (m < 0.5 || age <= 0.0 || k >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vCol = vec4(0.0);
    return;
  }
  vec3 c = texture(uSnap, uv).rgb;
  // Flakes peel off, catch the wind and accelerate, swirling a little and
  // lifting like ash.
  float speed = 0.08 + 0.24 * aRnd.w;
  vec2 vel = uDir * speed + vec2(0.0, -0.05) + (aRnd.xy - 0.5) * 0.05;
  vec2 disp = vel * age + uDir * (0.12 + 0.12 * aRnd.z) * age * age;
  float swirl = 6.2831853 * vnoise(uv * 4.0 + vec2(age * 0.7, uSeed));
  disp += vec2(cos(swirl), sin(swirl)) * 0.04 * age;
  vec2 p = uv + vec2(disp.x / uAspect, disp.y);
  // Keep their real colour at first, then burn down to grey-brown ash.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 ash = mix(vec3(0.27, 0.24, 0.21), vec3(0.55, 0.5, 0.45), l);
  vCol = vec4(mix(c * 0.92, ash, smoothstep(0.15, 0.75, k)), (1.0 - smoothstep(0.5, 1.0, k)) * 0.95);
  gl_PointSize = uPx * (1.1 + 1.8 * aRnd.w) * (1.0 - 0.5 * k);
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}`;

const FS_DUST = `#version 300 es
precision highp float;
in vec4 vCol; out vec4 o;
void main() {
  float d = length(gl_PointCoord - 0.5);
  o = vec4(vCol.rgb, vCol.a * smoothstep(0.5, 0.25, d));
}`;

const DIRS = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] };
const PLATE_MAX_W = 960;
const TARGET_PARTICLES = 160000;

export class Renderer {
  constructor() {
    this.canvas = new OffscreenCanvas(16, 16);
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.disable(gl.DEPTH_TEST);

    this.p = {
      copy: this.program(VS_QUAD, FS_COPY),
      mask: this.program(VS_QUAD, FS_MASK),
      learn: this.program(VS_QUAD, FS_LEARN),
      premul: this.program(VS_QUAD, FS_PREMUL),
      room: this.program(VS_QUAD, FS_ROOM),
      composite: this.program(VS_QUAD, FS_COMPOSITE),
      dust: this.program(VS_DUST, FS_DUST),
    };

    this.quad = gl.createVertexArray();
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const prog of Object.values(this.p)) {
      const loc = gl.getAttribLocation(prog.prog, 'aPos');
      if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); }
    }
    gl.bindVertexArray(null);
    this.dustGrids = new Map();
    this.fbo = gl.createFramebuffer();
  }

  // ---------------------------------------------------------------- helpers
  program(vsSrc, fsSrc) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
    const uni = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      uni[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return { prog, uni };
  }

  texture(w, h, internal, format, type, { mip = false, filter } = {}) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const levels = mip ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : (filter || gl.LINEAR));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t.w = w; t.h = h; t.levels = levels; t.format = format; t.type = type;
    return t;
  }

  // Mutable texture (re-specified on upload; used for camera frames / masks).
  dynTexture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t.w = 0; t.h = 0;
    return t;
  }

  target(tex) {
    const gl = this.gl;
    if (tex) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, tex.w, tex.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  draw(prog, textures, uniforms = {}, out = null, flip = 0) {
    const gl = this.gl;
    this.target(out);
    gl.useProgram(prog.prog);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(prog.uni[name], unit++);
    }
    this.setUniforms(prog, { uFlip: flip, ...uniforms });
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  setUniforms(prog, uniforms) {
    const gl = this.gl;
    for (const [name, v] of Object.entries(uniforms)) {
      const loc = prog.uni[name];
      if (loc === undefined || loc === null) continue;
      if (typeof v === 'number') {
        if (name === 'uMode') gl.uniform1i(loc, v); else gl.uniform1f(loc, v);
      } else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 4) gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
    }
  }

  // ---------------------------------------------------------------- sessions
  createSession(w, h) {
    const gl = this.gl;
    const pw = Math.min(PLATE_MAX_W, w);
    const ph = Math.max(2, Math.round((pw * h) / w));
    const S = {
      aspect: w / h,
      pw, ph,
      frame: this.dynTexture(),
      maskRaw: this.dynTexture(),
      maskAcc: null, maskAcc2: null, maskW: 0, maskH: 0, hasMask: false,
      plate: this.texture(pw, ph, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE),
      plate2: this.texture(pw, ph, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE),
      premul: this.texture(pw, ph, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, { mip: true }),
      room: this.texture(pw, ph, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE),
      ai: this.texture(pw, ph, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE),
      aiValid: false, aiFadeStart: 0,
      snap: null, snapMask: this.dynTexture(),
      box: [0.3, 0.15, 0.7, 1.0],
      snapKey: null,
      lastMaskT: 0,
    };
    // Start with an empty (zero-confidence) plate.
    for (const t of [S.plate, S.plate2]) {
      this.target(t);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return S;
  }

  destroySession(S) {
    const gl = this.gl;
    for (const k of ['frame', 'maskRaw', 'maskAcc', 'maskAcc2', 'plate', 'plate2', 'premul', 'room', 'ai', 'snap', 'snapMask']) {
      if (S[k]) gl.deleteTexture(S[k]);
    }
  }

  resetPlate(S) {
    const gl = this.gl;
    for (const t of [S.plate, S.plate2]) {
      this.target(t);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    S.aiValid = false;
  }

  uploadFrame(S, bitmap) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, S.frame);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    S.frame.w = bitmap.width;
    S.frame.h = bitmap.height;
  }

  // mask: { data: Uint8Array (0..255 person confidence), w, h }
  updateMask(S, mask, tMs) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, S.maskRaw);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.w, mask.h, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data);
    S.maskRaw.w = mask.w; S.maskRaw.h = mask.h;
    if (!S.maskAcc || S.maskW !== mask.w || S.maskH !== mask.h) {
      if (S.maskAcc) { gl.deleteTexture(S.maskAcc); gl.deleteTexture(S.maskAcc2); }
      S.maskAcc = this.texture(mask.w, mask.h, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
      S.maskAcc2 = this.texture(mask.w, mask.h, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
      S.maskW = mask.w; S.maskH = mask.h;
      S.hasMask = false;
    }
    const dt = S.lastMaskT ? Math.min(1, (tMs - S.lastMaskT) / 1000) : 1;
    S.lastMaskT = tMs;
    const r = 0.035;
    this.draw(this.p.mask, { uRaw: S.maskRaw, uPrev: S.maskAcc }, {
      uRadius: [r / S.aspect, r], uDecay: 3.0 * dt, uHasPrev: S.hasMask ? 1 : 0,
    }, S.maskAcc2);
    [S.maskAcc, S.maskAcc2] = [S.maskAcc2, S.maskAcc];
    S.hasMask = true;
    S.lastRawMask = mask;
  }

  learn(S, rate = 0.15) {
    if (!S.hasMask) return;
    const r = 0.03;
    this.draw(this.p.learn, { uPlate: S.plate, uFrame: S.frame, uMask: S.maskAcc }, {
      uRadius: [r / S.aspect, r], uRate: rate,
    }, S.plate2);
    [S.plate, S.plate2] = [S.plate2, S.plate];
  }

  // Read the learned plate (RGBA, rows top-down) for inpainting.
  readPlate(S) {
    const gl = this.gl;
    this.target(S.plate);
    const out = new Uint8Array(S.pw * S.ph * 4);
    gl.readPixels(0, 0, S.pw, S.ph, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  setAiFill(S, rgba, tMs) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, S.ai);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, S.pw, S.ph, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    if (!S.aiValid) S.aiFadeStart = tMs;
    S.aiValid = true;
  }

  buildRoom(S, tMs) {
    const gl = this.gl;
    this.draw(this.p.premul, { uPlate: S.plate }, {}, S.premul);
    gl.bindTexture(gl.TEXTURE_2D, S.premul);
    gl.generateMipmap(gl.TEXTURE_2D);
    const aiMix = S.aiValid ? Math.min(1, (tMs - S.aiFadeStart) / 600) : 0;
    this.draw(this.p.room, { uPlate: S.plate, uPremul: S.premul, uAi: S.ai }, {
      uAiMix: aiMix, uLevels: S.premul.levels - 1,
    }, S.room);
  }

  // Freeze you (pixels + person mask) at the moment of the snap.
  snapshot(S, key) {
    const gl = this.gl;
    if (!S.snap || S.snap.w !== S.frame.w || S.snap.h !== S.frame.h) {
      if (S.snap) gl.deleteTexture(S.snap);
      S.snap = this.texture(S.frame.w, S.frame.h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    }
    this.draw(this.p.copy, { uTex: S.frame }, {}, S.snap);
    const m = S.lastRawMask;
    if (m) {
      gl.bindTexture(gl.TEXTURE_2D, S.snapMask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, m.w, m.h, 0, gl.RED, gl.UNSIGNED_BYTE, m.data);
      S.box = maskBox(m) || S.box;
    }
    S.snapKey = key;
    S.seed = Math.random() * 100;
  }

  dustGrid(w, h) {
    const step = Math.max(1.25, Math.sqrt((w * h) / TARGET_PARTICLES));
    const gw = Math.round(w / step), gh = Math.round(h / step);
    const key = `${gw}x${gh}`;
    let g = this.dustGrids.get(key);
    if (g) return g;
    const gl = this.gl;
    const n = gw * gh;
    const cells = new Float32Array(n * 2);
    const rnd = new Float32Array(n * 4);
    let s = 1234567;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let y = 0, i = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++, i++) {
        cells[i * 2] = (x + 0.5) / gw;
        cells[i * 2 + 1] = (y + 0.5) / gh;
        rnd[i * 4] = r(); rnd[i * 4 + 1] = r(); rnd[i * 4 + 2] = r(); rnd[i * 4 + 3] = r() * r();
      }
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const prog = this.p.dust.prog;
    const bind = (data, name, size) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind(cells, 'aCell', 2);
    bind(rnd, 'aRnd', 4);
    gl.bindVertexArray(null);
    g = { vao, n, step, cell: [1 / gw, 1 / gh] };
    this.dustGrids.set(key, g);
    return g;
  }

  // effect: { mode: 0|1|2, t (seconds on the effect clock), duration (s), direction }
  render(S, effect, tMs) {
    const gl = this.gl;
    const w = S.frame.w, h = S.frame.h;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const shared = {
      uBox: S.box,
      uDir: DIRS[effect.direction] || DIRS.right,
      uSpan: effect.duration * 0.62,
      uAspect: S.aspect,
      uSeed: S.seed || 0,
    };
    if (effect.mode !== 0 && !S.hasMask) {
      // No person mask yet: never show the raw camera while the effect is on.
      this.target(null);
      gl.clearColor(0.08, 0.08, 0.09, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return this.canvas.transferToImageBitmap();
    }
    if (effect.mode !== 0) {
      this.buildRoom(S, tMs);
      this.draw(this.p.composite, { uFrame: S.frame, uMask: S.maskAcc, uRoom: S.room }, {
        ...shared, uMode: effect.mode, uT: effect.t,
      }, null, 1);
    } else {
      this.draw(this.p.copy, { uTex: S.frame }, {}, null, 1);
    }
    if (effect.mode === 1 && S.snap) {
      const g = this.dustGrid(w, h);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const prog = this.p.dust;
      gl.useProgram(prog.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, S.snap);
      gl.uniform1i(prog.uni.uSnap, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, S.snapMask);
      gl.uniform1i(prog.uni.uSnapMask, 1);
      this.setUniforms(prog, {
        ...shared, uT: effect.t, uDur: effect.duration, uPx: g.step * 1.15, uCell: g.cell,
      });
      gl.bindVertexArray(g.vao);
      gl.drawArrays(gl.POINTS, 0, g.n);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
    return this.canvas.transferToImageBitmap();
  }
}

// Bounding box (uv) of the person in a raw confidence mask.
export function maskBox(m) {
  let minX = m.w, minY = m.h, maxX = -1, maxY = -1;
  for (let y = 0; y < m.h; y++) {
    const row = y * m.w;
    for (let x = 0; x < m.w; x++) {
      if (m.data[row + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return [minX / m.w, minY / m.h, (maxX + 1) / m.w, (maxY + 1) / m.h];
}
