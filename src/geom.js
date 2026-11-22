/* HornSim geometry — turns a 2-D side view made of panels into an acoustic network.
 *
 *  design = {
 *    W: internal width (mm), t: panel thickness (mm),
 *    panels:     [{id, x1,y1,x2,y2, t?}]          board centre-lines (mm, y up)
 *    boundaries: [{id, x1,y1,x2,y2}]               virtual air dividers (no thickness)
 *    paths:      [{id, pts:[{x,y}], loss, ecStart, ecEnd}]   air paths (centre-lines)
 *    drivers:    [{id, x,y, nx,ny, key, n, wiring, disp}]   driver on a baffle, facing (nx,ny)
 *    chamberOpts:{ [regionKey]: {QL, Qa} }
 *    space, eg, losses ...
 *  }
 *  analyse(design, lib) -> { net, regions, pathInfo, driverInfo, warnings, ... }
 */
(function (root) {
  'use strict';
  const SAMPLE = 8;          // mm between area samples along a path
  const FAN = [-60, -45, -30, -15, 0, 15, 30, 45, 60].map((d) => d * Math.PI / 180);
  const MAXRAY = 6000;

  const len = (x, y) => Math.hypot(x, y);

  // ---------------- corner joints ----------------
  // CUTS: board id -> {1: line, 2: line}; a line {x, y, dx, dy} is where that end of the board is cut.
  let CUTS = new Map();
  function lineHit(ax, ay, adx, ady, l) { // line a + s*(adx,ady) with cut line l
    const den = adx * l.dy - ady * l.dx;
    if (Math.abs(den) < 1e-9) return null;
    const s = ((l.x - ax) * l.dy - (l.y - ay) * l.dx) / den;
    return { x: ax + adx * s, y: ay + ady * s };
  }
  function panelQuad(p, tDef) {
    const t = (p.t || tDef) / 2;
    const dx = p.x2 - p.x1, dy = p.y2 - p.y1, L = len(dx, dy) || 1;
    const ux = dx / L, uy = dy / L, nx = -uy * t, ny = ux * t;
    const q = [
      { x: p.x1 + nx, y: p.y1 + ny }, { x: p.x2 + nx, y: p.y2 + ny },
      { x: p.x2 - nx, y: p.y2 - ny }, { x: p.x1 - nx, y: p.y1 - ny },
    ];
    const cut = p.id != null && CUTS.get(p.id);
    if (cut) {
      const lim = Math.max(6 * t, 40);
      for (const [end, iA, iB, ex, ey] of [[1, 0, 3, p.x1, p.y1], [2, 1, 2, p.x2, p.y2]]) {
        const l = cut[end]; if (!l) continue;
        const a = lineHit(ex + nx, ey + ny, ux, uy, l), b = lineHit(ex - nx, ey - ny, ux, uy, l);
        if (a && b && len(a.x - ex, a.y - ey) < lim && len(b.x - ex, b.y - ey) < lim) { q[iA] = a; q[iB] = b; }
      }
    }
    return q;
  }
  const JOINT_TYPES = ['auto', 'miter', 'square']; // plus 'through:<board id>'
  /** Find board ends that meet at a corner and work out how they are cut.
   *  auto: the board closest to the grid direction runs through to the outside corner; the other butts into
   *  its face, its end cut parallel to that face. Two square boards: the horizontal one runs through. */
  function computeJoints(design) {
    CUTS = new Map();
    const tDef = design.t, out = [], overrides = design.joints || {};
    const tol = 0.75 * tDef + 2;
    const fr = (p) => { const L = len(p.x2 - p.x1, p.y2 - p.y1) || 1; return { L, ux: (p.x2 - p.x1) / L, uy: (p.y2 - p.y1) / L, t: p.t || tDef }; };
    const ends = [];
    for (const p of design.panels) for (const e of [1, 2]) ends.push({ p, e, x: e === 1 ? p.x1 : p.x2, y: e === 1 ? p.y1 : p.y2, fx: e === 1 ? p.x2 : p.x1, fy: e === 1 ? p.y2 : p.y1 });
    const used = new Set();
    const setCut = (id, end, line) => { if (!CUTS.has(id)) CUTS.set(id, {}); CUTS.get(id)[end] = line; };
    const face = (P, f, side) => ({ x: P.x1 - f.uy * side * f.t / 2, y: P.y1 + f.ux * side * f.t / 2, dx: f.ux, dy: f.uy });
    const sideOf = (P, f, x, y) => Math.sign(f.ux * (y - P.y1) - f.uy * (x - P.x1)) || 1;
    const gridDev = (f) => Math.min(Math.abs(f.ux), Math.abs(f.uy)); // 0 = horizontal or vertical
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      const A = ends[i], B = ends[j];
      if (A.p.id === B.p.id || used.has(A.p.id + ':' + A.e) || used.has(B.p.id + ':' + B.e)) continue;
      if (len(A.x - B.x, A.y - B.y) > tol) continue;
      const fa = fr(A.p), fb = fr(B.p);
      if (Math.abs(fa.ux * fb.uy - fa.uy * fb.ux) < 0.15) continue; // (nearly) in line: not a corner
      const ka = A.p.id + ':' + A.e, kb = B.p.id + ':' + B.e, key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      used.add(ka); used.add(kb);
      const type = overrides[key] || 'auto';
      let resolved = type;
      if (type === 'auto') {
        const da = gridDev(fa), db = gridDev(fb);
        let throughA;
        if (Math.abs(da - db) < 0.02) throughA = Math.abs(fa.uy) <= Math.abs(fb.uy); // both equally square: horizontal runs through
        else throughA = da < db;
        resolved = 'through:' + (throughA ? A.p.id : B.p.id);
      }
      const j0 = { key, type, resolved, x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, a: { id: A.p.id, end: A.e }, b: { id: B.p.id, end: B.e } };
      out.push(j0);
      if (resolved === 'square') continue;
      // which face of each board looks toward the other board's body
      const sA = sideOf(A.p, fa, B.fx, B.fy), sB = sideOf(B.p, fb, A.fx, A.fy);
      if (resolved === 'miter') {
        const inner = lineHit(face(A.p, fa, sA).x, face(A.p, fa, sA).y, fa.ux, fa.uy, face(B.p, fb, sB));
        const outer = lineHit(face(A.p, fa, -sA).x, face(A.p, fa, -sA).y, fa.ux, fa.uy, face(B.p, fb, -sB));
        if (!inner || !outer) continue;
        const L = len(outer.x - inner.x, outer.y - inner.y) || 1;
        const line = { x: inner.x, y: inner.y, dx: (outer.x - inner.x) / L, dy: (outer.y - inner.y) / L };
        setCut(A.p.id, A.e, line); setCut(B.p.id, B.e, line);
      } else {
        const tid = +resolved.split(':')[1];
        const T = tid === A.p.id ? A : B, U = T === A ? B : A, ft = T === A ? fa : fb, fu = T === A ? fb : fa;
        const sT = T === A ? sA : sB, sU = T === A ? sB : sA;
        setCut(U.p.id, U.e, face(T.p, ft, sT));   // butting board stops flush against the through board's face
        setCut(T.p.id, T.e, face(U.p, fu, -sU));  // through board runs on to the butting board's outside face
      }
    }
    // T-joints: a board end that lands on the face of another board (away from that board's ends) is cut at the
    // angle of that face, so an angled board sits flush (e.g. a 45° corner deflector between the top and the back)
    for (const U of ends) {
      const ku = U.p.id + ':' + U.e;
      if (used.has(ku)) continue;
      const fu = fr(U.p);
      let best = null;
      for (const T of design.panels) {
        if (T.id === U.p.id) continue;
        const ft = fr(T);
        if (Math.abs(fu.ux * ft.uy - fu.uy * ft.ux) < 0.15) continue;      // running alongside: no T
        const along = (U.x - T.x1) * ft.ux + (U.y - T.y1) * ft.uy;
        const across = (U.x - T.x1) * -ft.uy + (U.y - T.y1) * ft.ux;
        if (along < -1 || along > ft.L + 1) continue;
        if (Math.abs(across) > ft.t / 2 + 0.6 * fu.t + 1) continue;
        if (!best || Math.abs(across) < best.d) best = { T, ft, d: Math.abs(across) };
      }
      if (!best) continue;
      const key = 'T|' + ku, type = overrides[key] || 'auto';
      used.add(ku);
      out.push({ key, type, resolved: type === 'square' ? 'square' : 'flush', tee: true, x: U.x, y: U.y, a: { id: U.p.id, end: U.e }, b: { id: best.T.id, end: 0 } });
      if (type === 'square') continue;
      const sT = sideOf(best.T, best.ft, U.fx, U.fy);                       // the face of T that looks at U's body
      setCut(U.p.id, U.e, face(best.T, best.ft, sT));
    }
    return out;
  }
  function quadEdges(q) { return [[q[0], q[1]], [q[1], q[2]], [q[2], q[3]], [q[3], q[0]]]; }
  function pointInQuad(q, x, y) {
    let sgn = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c !== 0) { const s = c > 0 ? 1 : -1; if (sgn === 0) sgn = s; else if (s !== sgn) return false; }
    }
    return true;
  }
  function raySeg(ox, oy, rx, ry, a, b) {
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = rx * ey - ry * ex;
    if (Math.abs(den) < 1e-12) return Infinity;
    const wx = a.x - ox, wy = a.y - oy;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * ry - wy * rx) / den;
    return (t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9) ? t : Infinity;
  }
  function castRay(walls, ox, oy, rx, ry) {
    let best = Infinity;
    for (const w of walls) {
      // cheap bbox reject
      const t = raySeg(ox, oy, rx, ry, w[0], w[1]);
      if (t < best) best = t;
    }
    return best;
  }

  /** polyline helpers */
  function polyLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += len(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return L; }
  function pointAt(pts, s) {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = len(b.x - a.x, b.y - a.y);
      if (s <= acc + L || i === pts.length - 1) {
        const u = L > 0 ? Math.min(1, Math.max(0, (s - acc) / L)) : 0;
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, tx: (b.x - a.x) / (L || 1), ty: (b.y - a.y) / (L || 1), seg: i - 1 };
      }
      acc += L;
    }
    return { x: pts[0].x, y: pts[0].y, tx: 1, ty: 0, seg: 0 };
  }
  function project(pts, x, y) {
    let best = { d: Infinity, s: 0 }, acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey, L = Math.sqrt(L2);
      let u = L2 > 0 ? ((x - a.x) * ex + (y - a.y) * ey) / L2 : 0; u = Math.max(0, Math.min(1, u));
      const px = a.x + ex * u, py = a.y + ey * u, d = len(x - px, y - py);
      if (d < best.d) best = { d, s: acc + u * L, x: px, y: py };
      acc += L;
    }
    return best;
  }

  /** Measure cross-section height along a path by fanned ray casts to the walls. */
  function measurePath(path, walls, quads) {
    const pts = path.pts, Ltot = polyLength(pts);
    const out = { L: Ltot, samples: [], bad: [] };
    if (pts.length < 2 || Ltot < 1) return out;
    // sample positions: uniform + vertices
    const ss = new Set();
    const n = Math.max(2, Math.ceil(Ltot / SAMPLE));
    for (let i = 0; i <= n; i++) ss.add(+(Ltot * i / n).toFixed(3));
    let acc = 0;
    for (let i = 1; i < pts.length - 1; i++) { acc += len(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); ss.add(+acc.toFixed(3)); }
    const sList = [...ss].sort((a, b) => a - b);
    acc = 0;
    const vertS = [0]; for (let i = 1; i < pts.length; i++) { acc += len(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); vertS.push(acc); }
    for (const s of sList) {
      const P = pointAt(pts, s);
      let tx = P.tx, ty = P.ty;
      // at a vertex use the bisector direction
      const vi = vertS.findIndex((v) => Math.abs(v - s) < 1e-3);
      if (vi > 0 && vi < pts.length - 1) {
        const a = pts[vi - 1], b = pts[vi], c = pts[vi + 1];
        const l1 = len(b.x - a.x, b.y - a.y) || 1, l2 = len(c.x - b.x, c.y - b.y) || 1;
        let bx = (b.x - a.x) / l1 + (c.x - b.x) / l2, by = (b.y - a.y) / l1 + (c.y - b.y) / l2;
        const bl = len(bx, by); if (bl > 1e-6) { tx = bx / bl; ty = by / bl; }
      }
      const nLx = -ty, nLy = tx;
      const inside = quads.some((q) => pointInQuad(q, P.x, P.y));
      const side = (nx, ny) => {
        let best = Infinity;
        for (const f of FAN) {
          const c = Math.cos(f), sn = Math.sin(f);
          const rx = nx * c - ny * sn, ry = nx * sn + ny * c;
          const d = castRay(walls, P.x, P.y, rx, ry);
          if (d < best) best = d;
        }
        return best;
      };
      const dL = side(nLx, nLy), dR = side(-nLx, -nLy);
      // straight-normal hits for drawing / barrier lines
      const dL0 = castRay(walls, P.x, P.y, nLx, nLy), dR0 = castRay(walls, P.x, P.y, -nLx, -nLy);
      out.samples.push({ s, x: P.x, y: P.y, tx, ty, nx: nLx, ny: nLy, dL, dR, dL0, dR0, inside });
      if (inside) out.bad.push(s);
    }
    // repair open sides (no wall within reach) from neighbours
    const S = out.samples;
    const okv = (v) => isFinite(v) && v < MAXRAY;
    for (const key of ['dL', 'dR']) {
      for (let i = 0; i < S.length; i++) {
        if (!okv(S[i][key])) {
          let j = i - 1; while (j >= 0 && !okv(S[j][key])) j--;
          let k = i + 1; while (k < S.length && !okv(S[k][key])) k++;
          S[i][key] = j >= 0 ? S[j][key] : (k < S.length ? S[k][key] : 50);
          S[i].open = true;
        }
      }
    }
    for (const smp of S) { smp.h = smp.inside ? 1 : Math.max(1, smp.dL + smp.dR); }
    return out;
  }

  // ---------------- raster region labelling ----------------
  function makeGrid(design, extraLines, cellOverride) {
    const xs = [], ys = [];
    for (const p of design.panels) { xs.push(p.x1, p.x2); ys.push(p.y1, p.y2); }
    for (const b of design.boundaries || []) { xs.push(b.x1, b.x2); ys.push(b.y1, b.y2); }
    for (const p of design.paths || []) for (const q of p.pts) { xs.push(q.x); ys.push(q.y); }
    if (!xs.length) return null;
    const pad = 80;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const span = Math.max(x1 - x0, y1 - y0);
    const c = cellOverride || Math.max(2, Math.min(8, span / 700));
    const nx = Math.ceil((x1 - x0) / c), ny = Math.ceil((y1 - y0) / c);
    const g = { x0, y0, c, nx, ny, lab: new Int32Array(nx * ny) };
    const tDef = design.t;
    // panels (conservative: expanded by half a cell)
    for (const p of design.panels) {
      const t = (p.t || tDef) + c;
      const dx = p.x2 - p.x1, dy = p.y2 - p.y1, L = len(dx, dy) || 1, ux = dx / L, uy = dy / L;
      const e = c * 0.5;
      const q = panelQuad({ id: p.id, x1: p.x1 - ux * e, y1: p.y1 - uy * e, x2: p.x2 + ux * e, y2: p.y2 + uy * e, t }, t);
      fillQuad(g, q);
    }
    const lines = [...(design.boundaries || []), ...(extraLines || [])];
    for (const b of lines) {
      const dx = b.x2 - b.x1, dy = b.y2 - b.y1, L = len(dx, dy) || 1, ux = dx / L, uy = dy / L, e = c;
      fillQuad(g, panelQuad({ x1: b.x1 - ux * e, y1: b.y1 - uy * e, x2: b.x2 + ux * e, y2: b.y2 + uy * e }, c * 1.6));
    }
    return g;
  }
  function fillQuad(g, q) {
    const minx = Math.min(...q.map((p) => p.x)), maxx = Math.max(...q.map((p) => p.x));
    const miny = Math.min(...q.map((p) => p.y)), maxy = Math.max(...q.map((p) => p.y));
    const i0 = Math.max(0, Math.floor((minx - g.x0) / g.c)), i1 = Math.min(g.nx - 1, Math.ceil((maxx - g.x0) / g.c));
    const j0 = Math.max(0, Math.floor((miny - g.y0) / g.c)), j1 = Math.min(g.ny - 1, Math.ceil((maxy - g.y0) / g.c));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = g.x0 + (i + 0.5) * g.c, y = g.y0 + (j + 0.5) * g.c;
      if (pointInQuad(q, x, y)) g.lab[j * g.nx + i] = -1;
    }
  }
  function cellOf(g, x, y) {
    const i = Math.floor((x - g.x0) / g.c), j = Math.floor((y - g.y0) / g.c);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return -2;
    return j * g.nx + i;
  }
  function flood(g, start, label) {
    if (start < 0 || g.lab[start] !== 0) return 0;
    const st = [start]; g.lab[start] = label; let n = 0;
    while (st.length) {
      const k = st.pop(); n++;
      const i = k % g.nx, j = (k - i) / g.nx;
      if (i > 0 && g.lab[k - 1] === 0) { g.lab[k - 1] = label; st.push(k - 1); }
      if (i < g.nx - 1 && g.lab[k + 1] === 0) { g.lab[k + 1] = label; st.push(k + 1); }
      if (j > 0 && g.lab[k - g.nx] === 0) { g.lab[k - g.nx] = label; st.push(k - g.nx); }
      if (j < g.ny - 1 && g.lab[k + g.nx] === 0) { g.lab[k + g.nx] = label; st.push(k + g.nx); }
    }
    return n;
  }
  function labelAt(g, x, y) { const k = cellOf(g, x, y); return k < 0 ? 1 : g.lab[k]; }

  /** Find the nearest labelled air cell to (x,y) along direction (dx,dy), up to maxd mm. */
  function probe(g, x, y, dx, dy, startd, maxd) {
    for (let d = startd; d <= maxd; d += g.c * 0.5) {
      const l = labelAt(g, x + dx * d, y + dy * d);
      if (l !== -1) return { label: l, x: x + dx * d, y: y + dy * d };
    }
    return { label: -1 };
  }


  /** Map a point inside a path's channel to its position s along the path: pick the sample whose
   *  measured cross-section line passes through the point (handles folded legs lying side by side). */
  function projectToChannel(P, x, y) {
    let best = null;
    for (const q of P.m.samples) {
      const rx = x - q.x, ry = y - q.y;
      const u = rx * q.tx + ry * q.ty, v = rx * q.nx + ry * q.ny;
      const inside = v <= q.dL + 6 && v >= -q.dR - 6;
      const score = Math.abs(u) + (inside ? 0 : 1e6 + Math.abs(v));
      if (!best || score < best.score) best = { score, s: q.s, x: q.x, y: q.y };
    }
    return best || project(P.src.pts, x, y);
  }


  // ---------------- part roles ----------------
  const ROLES = ['baffle', 'top', 'bottom', 'back', 'front', 'horn wall', 'fold divider', 'throat wall', 'mouth lip', 'port wall', 'chamber divider', 'brace', 'deflector', 'cleat / mount', 'other'];
  /** Deduce what each board does from what touches its two faces. Human labels override (handled by the UI). */
  function inferParts(design, ctx) {
    const { g, regions, paths, driverInfo, quads } = ctx;
    const t = design.t;
    // cabinet bounding box + which way is "front" (where sound leaves)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of quads) for (const v of q) { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let fx = 0, fy = 0;
    for (const P of paths) (P.ends || []).forEach((e) => { if (e.kind === 'open') { fx += e.x - cx; fy += e.y - cy; } });
    for (const di of driverInfo) { if (di.front.kind === 'air') { fx += di.nx * 100; fy += di.ny * 100; } if (di.rear.kind === 'air') { fx -= di.nx * 100; fy -= di.ny * 100; } }
    const frontRight = fx >= 0;
    const portPaths = new Set(paths.filter((P) => (P.ends || []).some((e) => e.endCorr)).map((P) => P.src.id));
    const frontChambers = new Set(driverInfo.filter((di) => di.front.kind === 'chamber').map((di) => 'ch' + di.front.label));
    const pathByLabel = new Map(paths.filter((P) => P.label).map((P) => [P.label, P]));
    return design.panels.map((p, idx) => {
      const tp = p.t || t;
      const dx = p.x2 - p.x1, dy = p.y2 - p.y1, L = len(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      const sides = [[], []];
      const pathS = []; // {P, s}
      for (const f of [0.08, 0.25, 0.5, 0.75, 0.92]) {
        const bx = p.x1 + dx * f, by = p.y1 + dy * f;
        [1, -1].forEach((sg, si) => {
          for (const off of [tp / 2 + g.c * 1.5, tp / 2 + g.c * 4, tp / 2 + g.c * 8]) {
            const x = bx + nx * sg * off, y = by + ny * sg * off, l = labelAt(g, x, y);
            if (l === -1) continue;
            if (l === OUT) sides[si].push('out');
            else if (regions[l] && regions[l].kind === 'chamber') sides[si].push('ch' + l);
            else if (pathByLabel.has(l)) { const P = pathByLabel.get(l); sides[si].push('p' + P.src.id); pathS.push({ P, s: projectToChannel(P, x, y).s }); }
            break;
          }
        });
      }
      const has = (si, pre) => sides[si].some((v) => v.startsWith(pre));
      const any = (pre) => has(0, pre) || has(1, pre);
      const outN = sides[0].filter((v) => v === 'out').length + sides[1].filter((v) => v === 'out').length;
      const horiz = Math.abs(uy) < 0.17, vert = Math.abs(ux) < 0.17;
      const mx = (p.x1 + p.x2) / 2, my = (p.y1 + p.y2) / 2;
      let role = 'other', why = '';
      const mounted = driverInfo.some((di) => { const pr = project([{ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }], di.d.x, di.d.y); return pr.d < tp * 0.75; });
      const touchesPort = [...portPaths].some((id) => any('p' + id));
      const pathsTouched = new Set(pathS.map((q) => q.P.src.id));
      if (mounted) { role = 'baffle'; why = 'a driver is mounted on it'; }
      else if (outN >= 3 && (horiz || vert)) {
        if (horiz) { role = my > cy ? 'top' : 'bottom'; why = 'outside skin, ' + (my > cy ? 'upper' : 'lower') + ' edge'; }
        else { const right = mx > cx; role = right === frontRight ? 'front' : 'back'; why = `outside skin, ${right === frontRight ? 'the side sound leaves from' : 'away from the mouth'}`; }
      } else if (touchesPort) { role = 'port wall'; why = 'it lines a vent';
      } else if (pathS.length) {
        const P = pathS[0].P, smin = Math.min(...pathS.map((q) => q.s)), smax = Math.max(...pathS.map((q) => q.s));
        const Ltot = (P.sB - P.sA) || P.m.L;
        const bothPath = has(0, 'p') && has(1, 'p');
        const endOpen = P.ends && P.ends[1] && P.ends[1].kind === 'open';
        if (bothPath && pathsTouched.size === 1) { role = 'fold divider'; why = `path ${P.src.name} runs on both sides (a fold)`; }
        else if (endOpen && smax > P.sA + 0.88 * Ltot && smin > P.sA + 0.6 * Ltot) { role = 'mouth lip'; why = `forms the mouth of path ${P.src.name}`; }
        else if (smin < P.sA + 0.15 * Ltot && smax < P.sA + 0.45 * Ltot) { role = 'throat wall'; why = `lines the first part of path ${P.src.name}`; }
        else { role = 'horn wall'; why = `lines path ${P.src.name}`; }
      } else if (any('ch') && frontChambers.size && [...sides[0], ...sides[1]].some((v) => frontChambers.has(v))) {
        role = 'throat wall'; why = 'it encloses the chamber in front of the driver';
      } else if (any('ch')) {
        const chs = new Set([...sides[0], ...sides[1]].filter((v) => v.startsWith('ch')));
        if (chs.size >= 2) { role = 'chamber divider'; why = 'separates two chambers'; }
        else if (has(0, 'ch') && has(1, 'ch')) { role = 'brace'; why = 'stands inside one chamber'; }
        else if (outN) { role = horiz ? (my > cy ? 'top' : 'bottom') : vert ? ((mx > cx) === frontRight ? 'front' : 'back') : 'other'; why = 'outside skin of a chamber'; }
        else { role = 'other'; why = 'touches one chamber'; }
      } else if (outN) { role = 'deflector'; why = 'only open air touches it'; }
      return { id: p.id, auto: role, why, sides };
    });
  }


  // ---------------- automatic air paths ----------------
  function convexHull(pts) {
    const P = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (P.length < 3) return P;
    const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [], up = [];
    for (const q of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = P.length - 1; i >= 0; i--) { const q = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    up.pop(); lo.pop(); return lo.concat(up);
  }
  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    let idx = -1, dmax = 0;
    const L = len(b.x - a.x, b.y - a.y) || 1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / L;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax <= eps) return [a, b];
    return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
  }
  /** Find the air paths from the boards alone: every opening in the cabinet outline is a mouth/vent;
   *  the path follows the middle of the channel (max clearance) inward to the farthest dead end,
   *  and stops where the channel suddenly widens into a chamber (that makes it a port). */
  function autoPaths(design) {
    if (!design.panels.length) return [];
    computeJoints(design);   // corner cuts must belong to this design
    const quads = design.panels.map((p) => panelQuad(p, design.t));
    const corners = []; quads.forEach((q) => corners.push(...q));
    const hull = convexHull(corners);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const v of corners) { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
    const span = Math.max(x1 - x0, y1 - y0);
    const g = makeGrid({ ...design, paths: [] }, [], Math.max(3, span / 360));
    const N = g.nx * g.ny, c = g.c;
    // inside the cabinet outline?
    const inside = new Uint8Array(N);
    const H = hull.length;
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + (i + 0.5) * c, y = g.y0 + (j + 0.5) * c;
      let ok = true;
      for (let k = 0; k < H && ok; k++) { const a = hull[k], b = hull[(k + 1) % H]; if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < -c * 0.25) ok = false; }
      inside[j * g.nx + i] = ok ? 1 : 0;
    }
    const air = (k) => g.lab[k] === 0 && inside[k];
    // clearance = distance to the nearest board (chamfer transform), in mm
    const clr = new Float32Array(N);
    for (let k = 0; k < N; k++) clr[k] = g.lab[k] === -1 ? 0 : 1e9;
    const D1 = c, D2 = c * Math.SQRT2;
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i; let v = clr[k];
      if (i > 0) v = Math.min(v, clr[k - 1] + D1);
      if (j > 0) { v = Math.min(v, clr[k - g.nx] + D1); if (i > 0) v = Math.min(v, clr[k - g.nx - 1] + D2); if (i < g.nx - 1) v = Math.min(v, clr[k - g.nx + 1] + D2); }
      clr[k] = v;
    }
    for (let j = g.ny - 1; j >= 0; j--) for (let i = g.nx - 1; i >= 0; i--) {
      const k = j * g.nx + i; let v = clr[k];
      if (i < g.nx - 1) v = Math.min(v, clr[k + 1] + D1);
      if (j < g.ny - 1) { v = Math.min(v, clr[k + g.nx] + D1); if (i < g.nx - 1) v = Math.min(v, clr[k + g.nx + 1] + D2); if (i > 0) v = Math.min(v, clr[k + g.nx - 1] + D2); }
      clr[k] = v;
    }
    // openings: inside air touching outside air
    const isOpen = new Uint8Array(N);
    for (let j = 1; j < g.ny - 1; j++) for (let i = 1; i < g.nx - 1; i++) {
      const k = j * g.nx + i; if (!air(k)) continue;
      for (const n of [k - 1, k + 1, k - g.nx, k + g.nx]) if (g.lab[n] === 0 && !inside[n]) { isOpen[k] = 1; break; }
    }
    const clusters = [], seen = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      if (!isOpen[k] || seen[k]) continue;
      const cl = [], st = [k]; seen[k] = 1;
      while (st.length) { const q = st.pop(); cl.push(q); const i = q % g.nx; for (const n of [q - 1, q + 1, q - g.nx, q + g.nx, q - g.nx - 1, q - g.nx + 1, q + g.nx - 1, q + g.nx + 1]) { if (n < 0 || n >= N || seen[n] || !isOpen[n]) continue; const ni = n % g.nx; if (Math.abs(ni - i) > 1) continue; seen[n] = 1; st.push(n); } }
      if (cl.length * c >= 25) clusters.push(cl);
    }
    const nb = [[-1, 0, D1], [1, 0, D1], [0, -1, D1], [0, 1, D1], [-1, -1, D2], [1, -1, D2], [-1, 1, D2], [1, 1, D2]];
    const out = [];
    for (const cl of clusters) {
      // Dijkstra from the opening; stepping costs more near boards, so the route keeps to the middle
      const cost = new Float64Array(N).fill(Infinity), plen = new Float32Array(N), par = new Int32Array(N).fill(-1);
      const heap = [];
      const push = (k, v) => { heap.push([v, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
      for (const k of cl) { cost[k] = 0; push(k, 0); }
      while (heap.length) {
        const [v, k] = pop(); if (v > cost[k]) continue;
        const i = k % g.nx, j = (k - i) / g.nx;
        for (const [di, dj, dl] of nb) {
          const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.ny) continue;
          const n = jj * g.nx + ii; if (!air(n)) continue;
          const w = dl * Math.pow(c / Math.max(c * 0.5, clr[n]), 2);
          if (v + w < cost[n]) { cost[n] = v + w; plen[n] = plen[k] + dl; par[n] = k; push(n, cost[n]); }
        }
      }
      // start: the farthest point along the channel that sits on the centre ridge
      let best = -1, bl = -1;
      for (let k = 0; k < N; k++) {
        if (!isFinite(cost[k]) || clr[k] < 2 * c) continue;
        const i = k % g.nx; let ridge = true;
        for (const [di, dj] of nb) { const n = k + di + dj * g.nx; const ni = i + di; if (ni < 0 || ni >= g.nx || n < 0 || n >= N) continue; if (clr[n] > clr[k] + 0.01) { ridge = false; break; } }
        if (ridge && plen[k] > bl) { bl = plen[k]; best = k; }
      }
      if (best < 0) continue;
      const chain = [];
      for (let k = best; k >= 0; k = par[k]) chain.push(k);
      // chain runs start -> opening. Walk from the opening inward; if the channel gets 2.5x wider than its
      // narrowest point over the last 150 mm, we have left a duct and entered a chamber: the duct is a port.
      const cl2 = chain.map((k) => clr[k]);
      const cum = new Float64Array(chain.length);
      for (let i = chain.length - 2; i >= 0; i--) { const a = chain[i], b = chain[i + 1]; const ai = a % g.nx, bi = b % g.nx; cum[i] = cum[i + 1] + c * Math.hypot(ai - bi, (a - ai) / g.nx - (b - bi) / g.nx); }
      let cut = 0;
      for (let i = chain.length - 1; i >= 0; i--) {
        let m = Infinity, n = 0;
        for (let j = i + 1; j < chain.length && cum[i] - cum[j] <= 150; j++) { m = Math.min(m, cl2[j]); n++; }
        if (n >= 4 && cl2[i] > 2.5 * m) {
          let j = i; while (j < chain.length - 1 && cl2[j] > 1.08 * m + 0.5 * c) j++;
          cut = j; break;
        }
      }
      const kept = chain.slice(cut);
      if (kept.length < 3) continue;
      let pts = kept.map((k) => { const i = k % g.nx, j = (k - i) / g.nx; return { x: g.x0 + (i + 0.5) * c, y: g.y0 + (j + 0.5) * c }; });
      pts = rdp(pts, Math.max(2 * c, 10));
      // run the end a little past the opening so the mouth plane is found
      const a = pts[pts.length - 2], b = pts[pts.length - 1], L = len(b.x - a.x, b.y - a.y) || 1;
      pts[pts.length - 1] = { x: b.x + (b.x - a.x) / L * (2 * c + 6), y: b.y + (b.y - a.y) / L * (2 * c + 6) };
      pts = pts.map((q) => ({ x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 }));
      const ok = cl.reduce((acc, k) => { const i = k % g.nx, j = (k - i) / g.nx; acc.x += g.x0 + (i + 0.5) * c; acc.y += g.y0 + (j + 0.5) * c; return acc; }, { x: 0, y: 0 });
      out.push({ pts, opening: { x: ok.x / cl.length, y: ok.y / cl.length }, port: cut > 0 });
    }
    out.sort((a, b) => a.opening.x - b.opening.x || b.opening.y - a.opening.y);
    return out;
  }

  // ---------------- main analysis ----------------
  const OUT = 1;
  function analyse(design, lib) {
    const warnings = [];
    const W = design.W, tDef = design.t;
    const joints = computeJoints(design);
    const quads = design.panels.map((p) => panelQuad(p, tDef));
    const walls = []; quads.forEach((q) => walls.push(...quadEdges(q)));
    // measure paths
    const paths = (design.paths || []).filter((p) => p.pts && p.pts.length >= 2).map((p) => ({ src: p, m: measurePath(p, walls, quads) }));
    // barrier lines at path ends (cross-sections)
    const barriers = [];
    const pname = (P) => P.src.name || P.src.id;
    for (const P of paths) {
      const S = P.m.samples; if (!S.length) continue;
      P.endInfo = [];
      for (const k of [0, 1]) {
        const smp = k === 0 ? S[0] : S[S.length - 1];
        const dx = k === 0 ? -smp.tx : smp.tx, dy = k === 0 ? -smp.ty : smp.ty;
        // an end that stops right against a board is a closed end: no barrier, the pocket belongs to the path
        const fwd = castRay(walls, smp.x, smp.y, dx, dy);
        if (fwd < Math.max(0.6 * smp.h, 25)) { P.endInfo.push({ closed: true, smp }); continue; }
        // otherwise the end plane is the last sample (walking inwards) that still has boards on both sides
        let j = k === 0 ? 0 : S.length - 1;
        const step = k === 0 ? 1 : -1;
        const ok = (q) => isFinite(q.dL0) && q.dL0 < MAXRAY && isFinite(q.dR0) && q.dR0 < MAXRAY && !q.inside;
        // the end plane must also sit inside the duct: no sudden jump in height compared with ~40 mm further in
        const look = Math.max(3, Math.round(40 / SAMPLE));
        const settled = (jj) => { const q = S[jj + step * look]; if (!q || !ok(q)) return true; return (S[jj].dL0 + S[jj].dR0) <= 1.6 * (q.dL0 + q.dR0); };
        while (j >= 0 && j < S.length && !(ok(S[j]) && settled(j))) j += step;
        if (j < 0 || j >= S.length) j = k === 0 ? 0 : S.length - 1;
        const e = S[j];
        const dl = ok(e) ? e.dL0 : e.dL, dr = ok(e) ? e.dR0 : e.dR;
        barriers.push({ x1: e.x + e.nx * (dl + 3), y1: e.y + e.ny * (dl + 3), x2: e.x - e.nx * (dr + 3), y2: e.y - e.ny * (dr + 3), path: P.src.id });
        P.endInfo.push({ closed: false, smp: e, dx, dy });
      }
      P.sA = P.endInfo[0].closed ? 0 : P.endInfo[0].smp.s;
      P.sB = P.endInfo[1].closed ? P.m.L : P.endInfo[1].smp.s;
      if (P.sB - P.sA < 5) { P.sA = 0; P.sB = P.m.L; }
      if (P.m.bad.length) warnings.push(`Path ${pname(P)} passes through a board — move it into the air channel.`);
    }
    const g = makeGrid(design, barriers);
    const regions = [];
    if (!g) return { empty: true, warnings, quads, paths, barriers };
    // outside
    for (let i = 0; i < g.nx; i++) { flood(g, i, OUT); flood(g, (g.ny - 1) * g.nx + i, OUT); }
    for (let j = 0; j < g.ny; j++) { flood(g, j * g.nx, OUT); flood(g, j * g.nx + g.nx - 1, OUT); }
    // path interiors
    let next = 2;
    for (const P of paths) {
      P.label = 0;
      const S = P.m.samples;
      for (let k = 1; k < S.length - 1; k++) {
        if (S[k].s < P.sA - 1 || S[k].s > P.sB + 1) continue; // the bit of path beyond a mouth plane is outside by design
        const l = labelAt(g, S[k].x, S[k].y);
        if (l === 0) { if (!P.label) P.label = next++; flood(g, cellOf(g, S[k].x, S[k].y), P.label); }
        else if (l === OUT && !P.leakOut) { P.leakOut = true; }
      }
      if (P.label) regions[P.label] = { kind: 'path', path: P.src.id, cells: 0 };
    }
    // remaining enclosed regions -> chambers
    for (let k = 0; k < g.lab.length; k++) {
      if (g.lab[k] === 0) {
        const lab = next++;
        const n = flood(g, k, lab);
        regions[lab] = { kind: 'chamber', cells: n };
      }
    }
    // region stats
    const sx = new Float64Array(next), sy = new Float64Array(next), cnt = new Float64Array(next), edge = new Float64Array(next);
    for (let k = 0; k < g.lab.length; k++) {
      const l = g.lab[k]; if (l < 2) continue;
      const i = k % g.nx, j = (k - i) / g.nx;
      sx[l] += g.x0 + (i + 0.5) * g.c; sy[l] += g.y0 + (j + 0.5) * g.c; cnt[l]++;
      if (i > 0 && g.lab[k - 1] === -1) edge[l]++;
      if (i < g.nx - 1 && g.lab[k + 1] === -1) edge[l]++;
      if (j > 0 && g.lab[k - g.nx] === -1) edge[l]++;
      if (j < g.ny - 1 && g.lab[k + g.nx] === -1) edge[l]++;
    }
    regions.forEach((r, l) => {
      if (!r) return;
      // panels were rasterised half a cell fat: give that strip back (one half-cell per boundary edge)
      r.cells = cnt[l]; r.area = cnt[l] * g.c * g.c + edge[l] * g.c * g.c * 0.5;
      r.cx = sx[l] / (cnt[l] || 1); r.cy = sy[l] / (cnt[l] || 1);
      r.V = r.area * W / 1e6; // litres
      r.label = l;
    });
    for (const P of paths) {
      if (P.leakOut) warnings.push(`Path ${pname(P)}: part of the channel is open to the outside — close the gap or end the path at the opening.`);
      const expected = P.m.samples.reduce((a, s, i, arr) => a + (i ? (s.s - arr[i - 1].s) * (s.h + arr[i - 1].h) / 2 : 0), 0);
      if (P.label && regions[P.label] && regions[P.label].area > expected * 2.2 + 5000) warnings.push(`Path ${pname(P)}: its air region is much larger than the measured channel (leaks into a chamber?).`);
    }

    // ---------- drivers ----------
    const driverInfo = (design.drivers || []).map((d) => {
      const spec = lib(d.key);
      const nl = len(d.nx, d.ny) || 1, nx = d.nx / nl, ny = d.ny / nl;
      const t = tDef;
      const f = probe(g, d.x, d.y, nx, ny, t / 2 + g.c, t / 2 + 200);
      const r = probe(g, d.x, d.y, -nx, -ny, t / 2 + g.c, t / 2 + 200);
      const side = (pr) => {
        if (pr.label === -1) return { kind: 'blocked' };
        if (pr.label === OUT) return { kind: 'air' };
        const reg = regions[pr.label];
        if (!reg) return { kind: 'blocked' };
        if (reg.kind === 'chamber') return { kind: 'chamber', label: pr.label, x: pr.x, y: pr.y };
        const P = paths.find((q) => q.label === pr.label);
        const pj = projectToChannel(P, pr.x, pr.y);
        return { kind: 'path', path: P.src.id, s: pj.s, x: pj.x, y: pj.y };
      };
      const info = { d, spec, front: side(f), rear: side(r), nx, ny };
      if (!spec) warnings.push(`Driver ${d.id}: no driver selected.`);
      if (info.front.kind === 'blocked' || info.rear.kind === 'blocked') warnings.push(`Driver ${d.id}: one side is blocked by a panel.`);
      if (spec && d.disp == null && spec.disp) d._disp = spec.disp;
      return info;
    });

    // ---------- path ends ----------
    for (const P of paths) {
      const pts = P.src.pts, S = P.m.samples;
      const ends = [];
      for (const which of ['start', 'end']) {
        const ei = P.endInfo[which === 'start' ? 0 : 1];
        const smp = ei.smp;
        const dx = which === 'start' ? -smp.tx : smp.tx, dy = which === 'start' ? -smp.ty : smp.ty;
        const pr = ei.closed ? { label: -1 } : probe(g, smp.x, smp.y, dx, dy, g.c * 2.5, g.c * 2.5 + 40);
        let e;
        if (pr.label === -1) e = { kind: 'closed' };
        else if (pr.label === OUT) e = { kind: 'open' };
        else {
          const reg = regions[pr.label];
          if (!reg || pr.label === P.label) e = { kind: 'closed' };
          else if (reg.kind === 'chamber') e = { kind: 'chamber', label: pr.label };
          else {
            const Q = paths.find((q) => q.label === pr.label);
            const pj = projectToChannel(Q, pr.x, pr.y);
            e = { kind: 'path', path: Q.src.id, s: pj.s };
          }
        }
        const ov = which === 'start' ? P.src.startMode : P.src.endMode;
        if (ov === 'closed') e = { kind: 'closed' };
        e.S = smp.h * W / 1e6; e.h = smp.h; e.x = smp.x; e.y = smp.y;
        ends.push(e);
      }
      P.ends = ends;
    }

    // ---------- network ----------
    const nodes = new Map(); // id -> parent (union-find)
    const find = (a) => { while (nodes.get(a) !== a) { nodes.set(a, nodes.get(nodes.get(a))); a = nodes.get(a); } return a; };
    const mk = (a) => { if (!nodes.has(a)) nodes.set(a, a); return a; };
    const unite = (a, b) => { mk(a); mk(b); const ra = find(a), rb = find(b); if (ra !== rb) nodes.set(ra, rb); };
    const splits = new Map(); // path id -> sorted s list
    const byId = new Map(paths.map((P) => [P.src.id, P]));
    const addSplit = (pid, s) => { const P = byId.get(pid); if (P) s = Math.min(P.sB, Math.max(P.sA, s)); if (!splits.has(pid)) splits.set(pid, []); splits.get(pid).push(s); };
    for (const P of paths) { addSplit(P.src.id, P.sA); addSplit(P.src.id, P.sB); }
    for (const di of driverInfo) for (const sd of [di.front, di.rear]) if (sd.kind === 'path') addSplit(sd.path, sd.s);
    for (const P of paths) for (const e of P.ends) if (e.kind === 'path') addSplit(e.path, e.s);
    for (const [pid, list] of splits) {
      list.sort((a, b) => a - b);
      const u = []; for (const s of list) if (!u.length || s - u[u.length - 1] > 1.5) u.push(s); else u[u.length - 1] = u[u.length - 1];
      splits.set(pid, u);
    }
    const nodeAt = (pid, s) => {
      const list = splits.get(pid); let bi = 0, bd = Infinity;
      list.forEach((v, i) => { const d = Math.abs(v - s); if (d < bd) { bd = d; bi = i; } });
      return mk(`P${pid}:${bi}`);
    };
    const chamberNode = (label) => mk(`C${label}`);

    const net = { space: design.space || 1, eg: design.eg != null ? design.eg : 2.83, rg: design.rg || 0, dist: 1, nodes: [], ducts: [], chambers: [], radiators: [], drivers: [], lumped: [], splMode: design.splMode };
    const used = new Set();
    const lossMul = design.losses ? 1 : 0;
    const pathPieces = (P, sA, sB) => {
      const S = P.m.samples.filter((q) => q.s >= sA - 1e-6 && q.s <= sB + 1e-6);
      const pieces = [];
      // decimate: keep points every ~30 mm or where area bends
      const keep = [S[0]];
      for (let i = 1; i < S.length - 1; i++) {
        const last = keep[keep.length - 1];
        if (S[i].s - last.s >= 30 || Math.abs(S[i + 1].h - 2 * S[i].h + S[i - 1].h) > 0.04 * S[i].h) keep.push(S[i]);
      }
      if (S.length > 1) keep.push(S[S.length - 1]);
      for (let i = 1; i < keep.length; i++) {
        const a = keep[i - 1], b = keep[i];
        const L = (b.s - a.s) / 1000; if (L <= 0) continue;
        pieces.push({ type: 'con', S1: a.h * W / 1e6, S2: b.h * W / 1e6, L, P1: 2 * (a.h + W) / 1000, P2: 2 * (b.h + W) / 1000 });
      }
      return pieces;
    };
    for (const P of paths) {
      const list = splits.get(P.src.id);
      for (let i = 1; i < list.length; i++) {
        const a = mk(`P${P.src.id}:${i - 1}`), b = mk(`P${P.src.id}:${i}`);
        const pieces = pathPieces(P, list[i - 1], list[i]);
        if (pieces.length) net.ducts.push({ a, b, pieces, loss: lossMul * (P.src.loss != null ? P.src.loss : 1), path: P.src.id });
        else unite(a, b);
      }
    }
    // path ends
    const chamberPorts = new Map(); // label -> [{S, Leff}]
    for (const P of paths) {
      const list = splits.get(P.src.id);
      P.ends.forEach((e, k) => {
        const nid = mk(`P${P.src.id}:${k === 0 ? 0 : list.length - 1}`);
        e.node = nid;
        if (e.kind === 'open') { net.radiators.push({ node: nid, S: e.S, label: `path ${P.src.id} ${k ? 'end' : 'start'}` }); used.add(nid); }
        else if (e.kind === 'chamber') {
          const reg = regions[e.label];
          const mode = k === 0 ? P.src.ecStart : P.src.ecEnd; // 'auto' | 'on' | 'off'
          const auto = (e.h * W) < 0.5 * Math.pow(reg.area * W, 2 / 3); // narrow duct into big volume
          const on = mode === 'on' || ((!mode || mode === 'auto') && auto);
          e.endCorr = on;
          const cn = chamberNode(e.label);
          if (on) {
            const a = Math.sqrt(e.S / Math.PI), dl = 0.64 * a;
            const S0 = e.S; const rho = (root.HornCore || {}).AIR ? root.HornCore.AIR.rho : 1.205;
            net.lumped.push({ a: cn, b: nid, Z: (w) => ({ r: 0, i: w * rho * dl / S0 }) });
            if (!chamberPorts.has(e.label)) chamberPorts.set(e.label, []);
            chamberPorts.get(e.label).push({ S: e.S, Leff: (P.sB - P.sA) / 1000 + dl + 0.8488 * a, path: P.src.id });
          } else unite(nid, cn);
        } else if (e.kind === 'path') unite(nid, nodeAt(e.path, e.s));
      });
    }
    // drivers
    const air = (root.HornCore && root.HornCore.AIR) || { c: 344, rho: 1.205 };
    const dispByChamber = new Map();
    driverInfo.forEach((di) => {
      if (!di.spec) return;
      const side = (sd) => sd.kind === 'air' ? 'air' : sd.kind === 'chamber' ? chamberNode(sd.label) : sd.kind === 'path' ? nodeAt(sd.path, sd.s) : null;
      const fN = side(di.front), rN = side(di.rear);
      if (!fN || !rN) return;
      net.drivers.push({ front: fN, rear: rN, d: di.spec, n: di.d.n || 1, wiring: di.d.wiring || 'parallel', id: di.d.id });
      const disp = di.d.disp != null ? di.d.disp : 0;
      if (di.rear.kind === 'chamber' && disp) dispByChamber.set(di.rear.label, (dispByChamber.get(di.rear.label) || 0) + disp * (di.d.n || 1));
    });
    // chambers (only those referenced)
    const allRef = new Set();
    for (const [id] of nodes) allRef.add(find(id));
    const opts = design.chamberOpts || {};
    regions.forEach((r, l) => {
      if (!r || r.kind !== 'chamber') return;
      const id = `C${l}`;
      if (!nodes.has(id)) { r.unused = true; return; }
      const Vnet = Math.max(0.01, r.V - (dispByChamber.get(l) || 0));
      r.Vnet = Vnet;
      const ch = { node: id, V: Vnet / 1000 };
      const ports = chamberPorts.get(l);
      if (ports && ports.length) {
        const Ca = ch.V / (air.rho * air.c * air.c);
        const sumSL = ports.reduce((a, p) => a + p.S / p.Leff, 0);
        const fb = air.c / (2 * Math.PI) * Math.sqrt(sumSL / ch.V);
        r.fb = fb;
        const QL = design.QL != null ? design.QL : 7;
        if (QL > 0) { const R = QL / (2 * Math.PI * fb * Ca); net.lumped.push({ a: id, b: 'gnd', Z: () => ({ r: R, i: 0 }) }); }
      }
      if (design.fill && design.fill[l]) ch.Qa = design.fill[l];
      net.chambers.push(ch);
    });
    // finalise node ids via union-find
    const rename = (a) => (a === 'air' || a === 'gnd') ? a : find(a);
    for (const d of net.ducts) { d.a = rename(d.a); d.b = rename(d.b); }
    for (const c of net.chambers) c.node = rename(c.node);
    for (const r of net.radiators) r.node = rename(r.node);
    for (const d of net.drivers) { d.front = rename(d.front); d.rear = rename(d.rear); }
    for (const l of net.lumped) { l.a = rename(l.a); l.b = rename(l.b); }
    const ids = new Set();
    for (const d of net.ducts) { ids.add(d.a); ids.add(d.b); }
    for (const c of net.chambers) ids.add(c.node);
    for (const r of net.radiators) ids.add(r.node);
    for (const d of net.drivers) { if (d.front !== 'air') ids.add(d.front); if (d.rear !== 'air') ids.add(d.rear); }
    for (const l of net.lumped) { ids.add(l.a); if (l.b !== 'gnd') ids.add(l.b); }
    net.nodes = [...ids];
    // drop self-loops
    net.ducts = net.ducts.filter((d) => d.a !== d.b);
    if (!net.drivers.length) warnings.push('Place a driver on a panel to simulate.');
    if (net.drivers.length && !net.radiators.length && !net.drivers.some((d) => d.front === 'air' || d.rear === 'air')) warnings.push('Nothing radiates: no open path end and no driver side facing outside.');

    let parts = [];
    try { parts = inferParts(design, { g, regions, paths, driverInfo, quads }); } catch (e) { warnings.push('Part labelling failed: ' + e.message); }
    return { g, regions, paths, barriers, quads, walls, driverInfo, net, warnings, parts, joints };
  }

  /** Simple numbers for the info panel */
  function summary(design, A) {
    const xs = [], ys = [];
    for (const q of A.quads || []) for (const p of q) { xs.push(p.x); ys.push(p.y); }
    const o = {};
    if (xs.length) {
      o.H = Math.max(...ys) - Math.min(...ys); o.D = Math.max(...xs) - Math.min(...xs); o.Wout = design.W + 2 * design.t;
      o.Vext = o.H * o.D * o.Wout / 1e6;
    }
    o.panels = design.panels.map((p) => ({ id: p.id, L: len(p.x2 - p.x1, p.y2 - p.y1) }));
    return o;
  }

  root.HornGeom = { ROLES, JOINT_TYPES, computeJoints, analyse, autoPaths, summary, panelQuad, polyLength, pointAt, project, pointInQuad, castRay, quadEdges, labelAt };
})(typeof module !== 'undefined' && module.exports ? module.exports : (typeof window !== 'undefined' ? window : globalThis));
