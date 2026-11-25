/* Slice Horn Lab — 3-D viewports in plain WebGL (no libraries).
   World axes follow Rhino: X = across the cabinet width, Y = the side view's horizontal axis, Z = up.
   So the side-view drawing is Rhino's Right view, and the cabinet's mouth (drawn on the left) faces Front. */
(function (root) {
  'use strict';
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // ---------------------------------------------------------------- meshes
  // t = triangles (x y z nx ny nz per vertex, flat-shaded), l = edge lines (x y z per vertex)
  function Mesh() { this.t = []; this.l = []; }
  Mesh.prototype.tri = function (a, b, c) { const n = norm(cross(sub(b, a), sub(c, a))); for (const p of [a, b, c]) this.t.push(p[0], p[1], p[2], n[0], n[1], n[2]); };
  Mesh.prototype.quad = function (a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); };
  Mesh.prototype.line = function (a, b) { this.l.push(a[0], a[1], a[2], b[0], b[1], b[2]); };
  Mesh.prototype.add = function (m) { for (const v of m.t) this.t.push(v); for (const v of m.l) this.l.push(v); return this; };

  /** poly = [[x, y], ...] in side-view coordinates (convex), extruded across the width from X = x0 to x1 */
  function prism(poly, x0, x1) {
    const m = new Mesh(), n = poly.length, A = poly.map((p) => [x0, p[0], p[1]]), B = poly.map((p) => [x1, p[0], p[1]]);
    for (let i = 1; i < n - 1; i++) { m.tri(A[0], A[i], A[i + 1]); m.tri(B[0], B[i], B[i + 1]); }
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; m.quad(A[i], A[j], B[j], B[i]); m.line(A[i], A[j]); m.line(B[i], B[j]); m.line(A[i], B[i]); }
    return m;
  }

  /** A rectangle (s0..s1 along the board, x0..x1 across the width) with round holes, as triangles. P(s, x) -> world point. */
  function rectWithHoles(m, P, s0, s1, x0, x1, hs) {
    const plain = () => m.quad(P(s0, x0), P(s1, x0), P(s1, x1), P(s0, x1));
    if (!hs.length) { plain(); return; }
    if (hs.length > 1) {   // split between two holes, along the board or across it, until each piece has one hole
      for (const k of ['s', 'x']) {
        const srt = hs.slice().sort((a, b) => a[k] - b[k]);
        for (let i = 0; i < srt.length - 1; i++) {
          const lo = Math.max(...srt.slice(0, i + 1).map((h) => h[k] + h.r)), hi = Math.min(...srt.slice(i + 1).map((h) => h[k] - h.r));
          if (hi <= lo) continue;
          const cut = (lo + hi) / 2, a = srt.slice(0, i + 1), b = srt.slice(i + 1);
          if (k === 's') { rectWithHoles(m, P, s0, cut, x0, x1, a); rectWithHoles(m, P, cut, s1, x0, x1, b); }
          else { rectWithHoles(m, P, s0, s1, x0, cut, a); rectWithHoles(m, P, s0, s1, cut, x1, b); }
          return;
        }
      }
      plain(); return;
    }
    const h = hs[0], N = 48, angs = [];
    for (let i = 0; i < N; i++) angs.push(i / N * 2 * Math.PI);
    for (const [cs, cx] of [[s0, x0], [s1, x0], [s1, x1], [s0, x1]]) { let a = Math.atan2(cx - h.x, cs - h.s); if (a < 0) a += 2 * Math.PI; angs.push(a); }
    angs.sort((a, b) => a - b);
    const edge = (a) => {
      const c = Math.cos(a), s = Math.sin(a); let t = Infinity;
      if (c > 1e-9) t = Math.min(t, (s1 - h.s) / c); if (c < -1e-9) t = Math.min(t, (s0 - h.s) / c);
      if (s > 1e-9) t = Math.min(t, (x1 - h.x) / s); if (s < -1e-9) t = Math.min(t, (x0 - h.x) / s);
      return P(h.s + c * t, h.x + s * t);
    };
    const circ = (a) => P(h.s + h.r * Math.cos(a), h.x + h.r * Math.sin(a));
    for (let i = 0; i < angs.length; i++) {
      const a0 = angs[i], a1 = angs[(i + 1) % angs.length];
      if (Math.abs(a1 - a0) < 1e-9) continue;
      m.quad(circ(a0), circ(a1), edge(a1), edge(a0));
    }
  }

  /** A board: q = its four corners in the side view (q0 -> q1 and q3 -> q2 are the two faces), extruded from x0 to x1.
   *  holes = [{ x, y, cx, r }]: driver cutouts, centred at (x, y) in the side view and cx across the width. */
  function board(q, x0, x1, holes) {
    if (!holes || !holes.length) return prism(q, x0, x1);
    const L = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) || 1, ux = (q[1][0] - q[0][0]) / L, uy = (q[1][1] - q[0][1]) / L;
    const faces = [[q[0], q[1]], [q[3], q[2]]].map(([a, b]) => ({ a, len: Math.hypot(b[0] - a[0], b[1] - a[1]) }));
    const P = (f, s, x) => [x, f.a[0] + ux * s, f.a[1] + uy * s];
    const hs = [], pad = 2;
    for (const h of holes) {
      const s = faces.map((f) => (h.x - f.a[0]) * ux + (h.y - f.a[1]) * uy);
      if (s.every((v, i) => v - h.r > pad && v + h.r < faces[i].len - pad) && h.cx - h.r > x0 + pad && h.cx + h.r < x1 - pad) hs.push({ s, cx: h.cx, r: h.r });
    }
    if (!hs.length) return prism(q, x0, x1);
    const m = new Mesh();
    faces.forEach((f, fi) => rectWithHoles(m, (s, x) => P(f, s, x), 0, f.len, x0, x1, hs.map((h) => ({ s: h.s[fi], x: h.cx, r: h.r }))));
    const N = 48;
    for (const h of hs) for (let i = 0; i < N; i++) {   // the cutout's wall and its two rims
      const a0 = i / N * 2 * Math.PI, a1 = (i + 1) / N * 2 * Math.PI;
      const at = (fi, a) => P(faces[fi], h.s[fi] + h.r * Math.cos(a), h.cx + h.r * Math.sin(a));
      const pa0 = at(0, a0), pa1 = at(0, a1), pb0 = at(1, a0), pb1 = at(1, a1);
      m.quad(pa0, pa1, pb1, pb0); m.line(pa0, pa1); m.line(pb0, pb1);
    }
    const A = q.map((p) => [x0, p[0], p[1]]), B = q.map((p) => [x1, p[0], p[1]]);
    m.quad(A[0], A[3], B[3], B[0]); m.quad(A[1], A[2], B[2], B[1]);
    m.quad(A[0], A[1], A[2], A[3]); m.quad(B[0], B[1], B[2], B[3]);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; m.line(A[i], A[j]); m.line(B[i], B[j]); m.line(A[i], B[i]); }
    return m;
  }

  /** Surface of revolution (a driver). prof = [[r, v], ...]: radius and distance along the axis; c = [x, y] is the axis
   *  origin in the side view, n = [nx, ny] its direction there, cx its position across the width. */
  function revolve(prof, c, n, cx, segs) {
    const m = new Mesh(), S = segs || 40, nl = Math.hypot(n[0], n[1]) || 1, nx = n[0] / nl, ny = n[1] / nl, ux = ny, uy = -nx;
    const P = (r, v, a) => { const cr = r * Math.cos(a), sr = r * Math.sin(a); return [cx + sr, c[0] + ux * cr + nx * v, c[1] + uy * cr + ny * v]; };
    for (let k = 0; k < prof.length - 1; k++) {
      const r0 = prof[k][0], v0 = prof[k][1], r1 = prof[k + 1][0], v1 = prof[k + 1][1];
      if (r0 < 1e-6 && r1 < 1e-6) continue;
      for (let i = 0; i < S; i++) {
        const a0 = i / S * 2 * Math.PI, a1 = (i + 1) / S * 2 * Math.PI;
        if (r0 < 1e-6) m.tri(P(0, v0, 0), P(r1, v1, a0), P(r1, v1, a1));
        else if (r1 < 1e-6) m.tri(P(r0, v0, a0), P(r0, v0, a1), P(0, v1, 0));
        else m.quad(P(r0, v0, a0), P(r0, v0, a1), P(r1, v1, a1), P(r1, v1, a0));
      }
    }
    for (let k = 0; k < prof.length; k++) {   // rim circles at both ends and wherever the outline turns sharply
      const r = prof[k][0], v = prof[k][1]; if (r < 1e-6) continue;
      let sharp = k === 0 || k === prof.length - 1;
      if (!sharp) {
        const a = Math.atan2(prof[k][1] - prof[k - 1][1], prof[k][0] - prof[k - 1][0]), b = Math.atan2(prof[k + 1][1] - prof[k][1], prof[k + 1][0] - prof[k][0]);
        let d = Math.abs(a - b); if (d > Math.PI) d = 2 * Math.PI - d; sharp = d > 0.6;
      }
      if (sharp) for (let i = 0; i < S; i++) m.line(P(r, v, i / S * 2 * Math.PI), P(r, v, (i + 1) / S * 2 * Math.PI));
    }
    return m;
  }

  /** convex hull of [[x, y], ...] (the side panels' outline) */
  function hull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 1e-6) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 1e-6) up.pop(); up.push(q); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  // ---------------------------------------------------------------- 4 x 4 matrices (column-major)
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
    return o;
  }
  function invert(a) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7], a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1 / det;
    const o = new Float32Array(16);
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det; o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det; o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det; o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det; o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  }
  function xf(m, x, y, z) {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
  }

  // ---------------------------------------------------------------- viewport
  const VS = 'attribute vec3 aPos; attribute vec3 aNor; uniform mat4 uMVP; uniform mat4 uView; varying vec3 vN; void main() { vN = mat3(uView) * aNor; gl_Position = uMVP * vec4(aPos, 1.0); }';
  const FS = 'precision mediump float; varying vec3 vN; uniform vec4 uCol; uniform float uLit; void main() { float d = abs(normalize(vN).z); gl_FragColor = vec4(uCol.rgb * mix(1.0, 0.45 + 0.55 * d, uLit), uCol.a); }';
  const VIEWS = {
    Perspective: [-0.96, 0.44, false], Top: [-Math.PI / 2, Math.PI / 2, true], Bottom: [-Math.PI / 2, -Math.PI / 2, true],
    Front: [-Math.PI / 2, 0, true], Back: [Math.PI / 2, 0, true], Right: [0, 0, true], Left: [Math.PI, 0, true],
  };
  const FOV = 32 * Math.PI / 180;

  function create(canvas) {
    let gl = null;
    try { gl = canvas.getContext('webgl', { antialias: true, alpha: false }) || canvas.getContext('experimental-webgl', { antialias: true, alpha: false }); } catch (e) { gl = null; }
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const aPos = gl.getAttribLocation(prog, 'aPos'), aNor = gl.getAttribLocation(prog, 'aNor');
    const uMVP = gl.getUniformLocation(prog, 'uMVP'), uView = gl.getUniformLocation(prog, 'uView'), uCol = gl.getUniformLocation(prog, 'uCol'), uLit = gl.getUniformLocation(prog, 'uLit');

    const cam = { t: [0, 0, 0], yaw: VIEWS.Perspective[0], pitch: VIEWS.Perspective[1], dist: 3000, ortho: false, scale: 1000, name: 'Perspective' };
    let objs = [], box = null, mode = 'shaded';
    let theme = { bg: [0.93, 0.93, 0.92], grid: [0.8, 0.82, 0.8], sel: [0.17, 0.34, 0.79], gridStep: 100 };
    const gridBuf = gl.createBuffer(), axisBuf = gl.createBuffer(); let gridN = 0;

    const css = () => [Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)];
    function resize() {
      const dpr = window.devicePixelRatio || 1, w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
    }
    function bounds(keys) {
      let b = null;
      for (const o of objs) {
        if (keys && !keys.has(o.key)) continue;
        for (let i = 0; i < o.t.length; i += 6) {
          if (!b) b = [o.t[i], o.t[i + 1], o.t[i + 2], o.t[i], o.t[i + 1], o.t[i + 2]];
          for (let k = 0; k < 3; k++) { if (o.t[i + k] < b[k]) b[k] = o.t[i + k]; if (o.t[i + k] > b[k + 3]) b[k + 3] = o.t[i + k]; }
        }
      }
      return b;
    }
    const radius = () => (box ? Math.max(100, Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 2) : 1000);

    function setScene(list, th) {
      if (th) theme = Object.assign({}, theme, th);
      for (const o of objs) { gl.deleteBuffer(o.tb); gl.deleteBuffer(o.lb); }
      objs = list.map((o) => {
        const t = new Float32Array(o.mesh.t), l = new Float32Array(o.mesh.l), tb = gl.createBuffer(), lb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, tb); gl.bufferData(gl.ARRAY_BUFFER, t, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, lb); gl.bufferData(gl.ARRAY_BUFFER, l, gl.STATIC_DRAW);
        return { key: o.key, color: o.color, edge: o.edge, alpha: o.alpha == null ? 1 : o.alpha, sel: !!o.sel, nopick: !!o.nopick, t, l, tb, lb };
      });
      box = bounds();
      // construction-plane grid on Z = 0, sized to the model, with the X (red) and Y (green) axes from the origin
      const b = box || [0, 0, 0, 1000, 1000, 1000], st = theme.gridStep || 100, pad = Math.max(300, 0.35 * Math.max(b[3] - b[0], b[4] - b[1]));
      const gx0 = Math.floor((Math.min(0, b[0]) - pad) / st) * st, gx1 = Math.ceil((b[3] + pad) / st) * st, gy0 = Math.floor((Math.min(0, b[1]) - pad) / st) * st, gy1 = Math.ceil((b[4] + pad) / st) * st;
      const g = [];
      for (let x = gx0; x <= gx1 + 1e-6; x += st) g.push(x, gy0, 0, x, gy1, 0);
      for (let y = gy0; y <= gy1 + 1e-6; y += st) g.push(gx0, y, 0, gx1, y, 0);
      gridN = g.length / 3;
      gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, axisBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, gx1, 0, 0, 0, 0, 0, 0, gy1, 0]), gl.STATIC_DRAW);
    }

    function basis() {
      const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      const d = [cp * cy, cp * sy, sp], r = [-sy, cy, 0];
      return { d, r, u: cross(d, r) };
    }
    function mats() {
      const { d, r, u } = basis(), [cw, ch] = css(), asp = cw / ch, R = radius();
      const back = cam.ortho ? R * 4 + Math.hypot(...sub(cam.t, box ? [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2] : [0, 0, 0])) : cam.dist;
      const eye = [cam.t[0] + d[0] * back, cam.t[1] + d[1] * back, cam.t[2] + d[2] * back];
      const view = new Float32Array([r[0], u[0], d[0], 0, r[1], u[1], d[1], 0, r[2], u[2], d[2], 0, -dot(r, eye), -dot(u, eye), -dot(d, eye), 1]);
      let proj;
      if (cam.ortho) {
        const n = 1, f = back * 2, s = cam.scale;
        proj = new Float32Array([1 / (s * asp), 0, 0, 0, 0, 1 / s, 0, 0, 0, 0, -2 / (f - n), 0, 0, 0, -(f + n) / (f - n), 1]);
      } else {
        const n = Math.max(1, cam.dist * 0.02), f = cam.dist + R * 6, k = 1 / Math.tan(FOV / 2);
        proj = new Float32Array([k / asp, 0, 0, 0, 0, k, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]);
      }
      return { view, mvp: mul(proj, view) };
    }
    const upp = () => (cam.ortho ? 2 * cam.scale : 2 * cam.dist * Math.tan(FOV / 2)) / css()[1];   // world units per CSS pixel at the target

    function lines(buf, n, col, a) {
      if (!n) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 12, 0);
      gl.disableVertexAttribArray(aNor); gl.vertexAttrib3f(aNor, 0, 0, 1);
      gl.uniform1f(uLit, 0); gl.uniform4f(uCol, col[0], col[1], col[2], a);
      gl.drawArrays(gl.LINES, 0, n);
    }
    function tris(o, a) {
      if (!o.t.length) return;
      const c = o.sel ? [0, 1, 2].map((i) => o.color[i] * 0.4 + theme.sel[i] * 0.6) : o.color;
      gl.bindBuffer(gl.ARRAY_BUFFER, o.tb);
      gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(aNor); gl.vertexAttribPointer(aNor, 3, gl.FLOAT, false, 24, 12);
      gl.uniform1f(uLit, 1); gl.uniform4f(uCol, c[0], c[1], c[2], a);
      gl.drawArrays(gl.TRIANGLES, 0, o.t.length / 6);
    }
    function render() {
      resize();
      const w = canvas.width, h = canvas.height; if (!w || !h) return;
      gl.viewport(0, 0, w, h);
      gl.clearColor(theme.bg[0], theme.bg[1], theme.bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const M = mats();
      gl.useProgram(prog); gl.uniformMatrix4fv(uMVP, false, M.mvp); gl.uniformMatrix4fv(uView, false, M.view);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.BLEND); gl.depthMask(true);
      lines(gridBuf, gridN, theme.grid, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, axisBuf); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 12, 0);
      gl.disableVertexAttribArray(aNor); gl.vertexAttrib3f(aNor, 0, 0, 1); gl.uniform1f(uLit, 0);
      gl.uniform4f(uCol, 0.78, 0.25, 0.22, 1); gl.drawArrays(gl.LINES, 0, 2);
      gl.uniform4f(uCol, 0.2, 0.6, 0.28, 1); gl.drawArrays(gl.LINES, 2, 2);
      const solid = mode !== 'wireframe', aOf = (o) => (mode === 'ghosted' ? Math.min(o.alpha, 0.3) : o.alpha);
      const edgeCol = (o) => (o.sel ? theme.sel : o.edge);
      if (solid) {
        gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
        for (const o of objs) if (aOf(o) >= 1) tris(o, 1);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }
      for (const o of objs) if (!solid || aOf(o) >= 1) lines(o.lb, o.l.length / 3, edgeCol(o), 1);
      if (solid) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
        for (const o of objs) { const a = aOf(o); if (a < 1) tris(o, a); }
        for (const o of objs) { const a = aOf(o); if (a < 1) lines(o.lb, o.l.length / 3, edgeCol(o), Math.min(1, a + 0.4)); }
        gl.depthMask(true); gl.disable(gl.BLEND);
      }
    }

    /** frame everything, or only the objects whose keys are in the set */
    function fit(keys) {
      const b = (keys && keys.size ? bounds(keys) : null) || box; if (!b) return;
      const R = Math.max(60, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2), [cw, ch] = css(), asp = Math.min(1, cw / ch);
      cam.t = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
      cam.dist = R / Math.sin(FOV / 2) / asp * 1.08; cam.scale = R / asp * 1.1;
      cam.auto = !(keys && keys.size);   // framed on everything: the app re-fits on a resize until the user pans or zooms
    }
    function setView(name) {
      const v = VIEWS[name]; if (!v) return false;
      cam.yaw = v[0]; cam.pitch = v[1]; cam.ortho = v[2]; cam.name = name; fit(); return true;
    }
    function orbit(dx, dy) { cam.yaw -= dx * 0.008; cam.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, cam.pitch + dy * 0.008)); }
    function pan(dx, dy) { const { r, u } = basis(), k = upp(); cam.auto = false; for (let i = 0; i < 3; i++) cam.t[i] += (-r[i] * dx + u[i] * dy) * k; }
    /** f < 1 zooms in; (px, py) = the point (CSS px in the canvas) that stays put */
    function zoom(f, px, py) {
      const { r, u } = basis(), [cw, ch] = css(), k = upp(), ox = (px == null ? 0 : px - cw / 2) * k, oy = (py == null ? 0 : ch / 2 - py) * k;
      cam.auto = false;
      if (cam.ortho) cam.scale = Math.max(5, Math.min(1e6, cam.scale * f)); else cam.dist = Math.max(20, Math.min(1e6, cam.dist * f));
      for (let i = 0; i < 3; i++) cam.t[i] += (r[i] * ox + u[i] * oy) * (1 - f);
    }
    /** key of the nearest pickable object under the pixel, or null */
    function pick(px, py) {
      const [cw, ch] = css(), inv = invert(mats().mvp); if (!inv) return null;
      const nx = 2 * px / cw - 1, ny = 1 - 2 * py / ch, o0 = xf(inv, nx, ny, -1), d = sub(xf(inv, nx, ny, 1), o0);
      let best = null, bt = Infinity;
      for (const o of objs) {
        if (o.nopick) continue;
        const t = o.t;
        for (let i = 0; i < t.length; i += 18) {
          const a = [t[i], t[i + 1], t[i + 2]], e1 = [t[i + 6] - a[0], t[i + 7] - a[1], t[i + 8] - a[2]], e2 = [t[i + 12] - a[0], t[i + 13] - a[1], t[i + 14] - a[2]];
          const p = cross(d, e2), det = dot(e1, p); if (Math.abs(det) < 1e-12) continue;
          const s = sub(o0, a), u = dot(s, p) / det; if (u < 0 || u > 1) continue;
          const q = cross(s, e1), v = dot(d, q) / det; if (v < 0 || u + v > 1) continue;
          const tt = dot(e2, q) / det; if (tt > 0 && tt < bt) { bt = tt; best = o.key; }
        }
      }
      return best;
    }
    return {
      cam, setScene, render, resize, fit, setView, orbit, pan, zoom, pick,
      get mode() { return mode; }, set mode(v) { mode = v; },
      get count() { return objs.length; },
    };
  }

  root.Horn3D = { create, Mesh, prism, board, revolve, hull, VIEWS: Object.keys(VIEWS) };
})(typeof window !== 'undefined' ? window : globalThis);
