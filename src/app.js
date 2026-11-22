/* Slice Horn Lab — editor + charts. Depends on HornCore, HornGeom, DRIVER_LIB. */
(function () {
  'use strict';
  const HC = window.HornCore, HG = window.HornGeom;
  const $ = (id) => document.getElementById(id);
  const cv = $('cv'), ctx = cv.getContext('2d');
  const chartCv = $('chart'), cctx = chartCv.getContext('2d');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hyp = Math.hypot;
  const LS = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };

  // ---------------------------------------------------------------- driver library
  const LIB = (window.DRIVER_LIB || []).slice();
  const LIBMAP = new Map(LIB.map((d) => [d.k, d]));
  function specOf(key) { return (design.custom && design.custom[key]) || LIBMAP.get(key) || null; }
  const hrCache = new Map();
  function hrOf(key) {
    const s = specOf(key); if (!s) return null;
    const sig = JSON.stringify(s);
    if (hrCache.has(sig)) return hrCache.get(sig);
    let hr = null;
    try { hr = HC.tsToDriver(s); if (!isFinite(hr.Bl) || !isFinite(hr.Cms) || hr.Mmd <= 0) hr = null; } catch (e) { hr = null; }
    if (hr) { hr.Pe = s.Pe || 0; hr.Xmax = s.Xmax || 0; }
    hrCache.set(sig, hr); return hr;
  }
  /** Cabinet width (the extrusion, into the screen) allowed by the biggest driver: at least its frame + 2", at most 2 x its
   *  frame, and a new design starts at frame + 3". (Minimum: frame + 1".) */
  const IN = 25.4;
  function widthRange(d) {
    d = d || design;
    const keys = (d.drivers || []).map((q) => q.key).concat(d.driverKey ? [d.driverKey] : []);
    const dia = Math.max(0, ...keys.map((k) => driverDims(k).outer).filter(isFinite)) || 460;
    return { dia, min: Math.round(dia + 1 * IN), def: Math.round(dia + 3 * IN), max: Math.round(2 * dia) };
  }
  function clampWidth(note) {
    const r = widthRange(), w0 = design.W;
    design.W = Math.min(r.max, Math.max(r.min, design.W));
    if (note && design.W !== w0) flash(`Cabinet width set to ${toU(design.W)} ${snapMode().unit}: it has to stay between the driver + 1" and 2 x the driver.`);
  }
  function driverDims(key) {
    const s = specOf(key) || {}; const d = s.dims || {};
    const Dc = 2 * Math.sqrt((s.Sd || 855) / Math.PI) * 10; // effective cone dia mm
    const outer = d.outer_dia || Dc * 1.2;
    return {
      outer, cutout: d.cutout_dia || outer * 0.9, depth: d.depth_total || outer * 0.47,
      mag: d.magnet_dia || outer * 0.55, magDepth: d.magnet_depth || outer * 0.15, flange: d.flange_thickness || 10, cone: Dc,
      measured: !!(s.dims && s.dims.outer_dia),
    };
  }
  const label = (s) => s ? `${s.b} ${s.m}` : '—';

  // ---------------------------------------------------------------- design + history
  const DEFAULT_DRIVER = LIBMAP.has('WinISD:B&C 15BG100') ? 'WinISD:B&C 15BG100' : (LIB[0] && LIB[0].k);
  let design;
  const undo = [], redo = [];
  function snapshot() { return JSON.stringify(design); }
  function commit() { undo.push(snapshot()); if (undo.length > 120) undo.shift(); redo.length = 0; }
  function doUndo() { if (!undo.length) return; redo.push(snapshot()); design = JSON.parse(undo.pop()); sel = []; changed(); renderSnap(); }
  function doRedo() { if (!redo.length) return; undo.push(snapshot()); design = JSON.parse(redo.pop()); sel = []; changed(); renderSnap(); }
  const nid = () => (design.seq = (design.seq || 0) + 1);
  // ---------------------------------------------------------------- curved boards (bent-ply arcs)
  // design.arcs = [{ id, a, m, b }]: a and b are the ends of the board's centre-line, m a point it passes through.
  // Each arc is turned into short straight segments (design.panels with p.arc = arc id), about one every 7.5 degrees,
  // so the air paths, chambers, collisions and the simulation treat it like any other board.
  function circle3(a, m, b) {
    const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
    if (Math.abs(d) < 1e-6) return null;
    const a2 = a.x * a.x + a.y * a.y, m2 = m.x * m.x + m.y * m.y, b2 = b.x * b.x + b.y * b.y;
    const x = (a2 * (m.y - b.y) + m2 * (b.y - a.y) + b2 * (a.y - m.y)) / d, y = (a2 * (b.x - m.x) + m2 * (a.x - b.x) + b2 * (m.x - a.x)) / d;
    const r = Math.hypot(a.x - x, a.y - y);
    return r > 1e5 ? null : { x, y, r };
  }
  function arcGeom(arc) {
    const c = circle3(arc.a, arc.m, arc.b);
    if (!c) return { c: null, t0: 0, sweep: 0, len: Math.hypot(arc.b.x - arc.a.x, arc.b.y - arc.a.y) };
    const norm = (v) => { while (v <= -Math.PI) v += 2 * Math.PI; while (v > Math.PI) v -= 2 * Math.PI; return v; };
    const t0 = Math.atan2(arc.a.y - c.y, arc.a.x - c.x);
    let sw = norm(Math.atan2(arc.b.y - c.y, arc.b.x - c.x) - t0); const sm = norm(Math.atan2(arc.m.y - c.y, arc.m.x - c.x) - t0);
    if (!(Math.sign(sm) === Math.sign(sw) && Math.abs(sm) < Math.abs(sw))) sw = sw > 0 ? sw - 2 * Math.PI : sw + 2 * Math.PI;   // the way round that passes m
    return { c, t0, sweep: sw, len: Math.abs(sw) * c.r };
  }
  function arcPts(arc) {
    const g = arcGeom(arc);
    if (!g.c) return [{ ...arc.a }, { ...arc.b }];
    const n = Math.max(2, Math.min(48, Math.ceil(Math.abs(g.sweep) / (7.5 * Math.PI / 180))));
    const out = [];
    for (let i = 0; i <= n; i++) { const t = g.t0 + g.sweep * i / n; out.push({ x: g.c.x + g.c.r * Math.cos(t), y: g.c.y + g.c.r * Math.sin(t) }); }
    out[0] = { ...arc.a }; out[n] = { ...arc.b };
    return out;
  }
  /** the point halfway round an arc (where its bend handle sits) */
  function arcMid(arc) { const g = arcGeom(arc); if (!g.c) return { x: (arc.a.x + arc.b.x) / 2, y: (arc.a.y + arc.b.y) / 2 }; const t = g.t0 + g.sweep / 2; return { x: g.c.x + g.c.r * Math.cos(t), y: g.c.y + g.c.r * Math.sin(t) }; }
  const rr2 = (v) => Math.round(v * 100) / 100;
  function syncArcsIn(d) {
    const arcs = d.arcs || [], live = new Set(arcs.map((a) => a.id));
    if (d.panels.some((q) => q.arc && !live.has(q.arc))) d.panels = d.panels.filter((q) => !q.arc || live.has(q.arc));
    for (const arc of arcs) {
      const pts = arcPts(arc);
      let segs = d.panels.filter((q) => q.arc === arc.id).sort((u, v) => u.seg - v.seg);
      if (segs.length !== pts.length - 1) {
        d.panels = d.panels.filter((q) => q.arc !== arc.id); segs = [];
        for (let i = 0; i < pts.length - 1; i++) { const q = { id: (d.seq = (d.seq || 0) + 1), arc: arc.id, seg: i }; segs.push(q); d.panels.push(q); }
      }
      segs.forEach((q, i) => { q.x1 = rr2(pts[i].x); q.y1 = rr2(pts[i].y); q.x2 = rr2(pts[i + 1].x); q.y2 = rr2(pts[i + 1].y); q.t = arc.t || undefined; q.role = arc.role || undefined; });
    }
  }
  const ARC = (d, ax, ay, mx, my, bx, by) => { (d.arcs = d.arcs || []).push({ id: ++d.seq, a: { x: ax, y: ay }, m: { x: mx, y: my }, b: { x: bx, y: by } }); };
  function nextPathName() { const used = new Set(design.paths.map((p) => p.name)); for (let i = 0; i < 26; i++) { const n = String.fromCharCode(65 + i); if (!used.has(n)) return n; } return 'P' + nid(); }

  // ---------------------------------------------------------------- presets
  function baseDesign(name) {
    return { name, W: 500, t: 18, snap: 'in01', showLabels: true, material: 'birch', space: 1, eg: 2.83, ref1W: true, losses: false, QL: 7,
      xover: { on: true, lp: 100, hp: 0 }, panels: [], arcs: [], boundaries: [], paths: [], drivers: [], custom: {}, seq: 0, driverKey: DEFAULT_DRIVER, autoCenter: true, autoPaths: true, autoMute: [] };
  }
  function P(d, x1, y1, x2, y2) { d.panels.push({ id: ++d.seq, x1, y1, x2, y2 }); }
  function shell(d, x0, y0, x1, y1, opts = {}) { // inner rectangle, panels outside it
    const t = d.t, h = t / 2;
    if (!opts.noBottom) P(d, x0 - t, y0 - h, x1 + t, y0 - h);
    if (!opts.noTop) P(d, x0 - t, y1 + h, x1 + t, y1 + h);
    if (!opts.noLeft) P(d, x0 - h, y0, x0 - h, y1);
    if (!opts.noRight) P(d, x1 + h, y0, x1 + h, y1);
  }
  const DEF = window.DEFAULT_PROJECT || null;   // the shipped starting project (data/default_design.json)
  /** Turn a design so its horn mouth / port faces left (x = min): mirror it if the mouth is on the right, rotate it a
   *  quarter turn if the mouth is on the top or bottom. Boards, drivers (position, facing, mount side) and hand-drawn paths
   *  all move together; automatic paths are re-found afterwards. */
  function faceLeft(d) {
    if (!d.panels.length) return;
    let ends;
    try { ends = HG.autoPaths(d).map((a) => a.pts[a.pts.length - 1]).filter(Boolean); } catch (e) { return; }
    if (!ends.length) return;
    const xs = d.panels.flatMap((p) => [p.x1, p.x2]), ys = d.panels.flatMap((p) => [p.y1, p.y2]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const vote = { left: 0, right: 0, bottom: 0, top: 0 };
    for (const e of ends) { const dist = { left: e.x - x0, right: x1 - e.x, bottom: e.y - y0, top: y1 - e.y }; vote[Object.keys(dist).sort((a, b) => dist[a] - dist[b])[0]]++; }
    const side = Object.keys(vote).sort((a, b) => vote[b] - vote[a])[0];
    if (side === 'left') return;
    let T, N, flip = false;
    if (side === 'right') { T = (x, y) => [x0 + x1 - x, y]; N = (nx, ny) => [-nx, ny]; flip = true; }
    else if (side === 'top') { T = (x, y) => [x0 + (y1 - y), y0 + (x - x0)]; N = (nx, ny) => [-ny, nx]; }      // quarter turn anticlockwise
    else { T = (x, y) => [x0 + (y - y0), y0 + (x1 - x)]; N = (nx, ny) => [ny, -nx]; }                         // quarter turn clockwise
    for (const p of d.panels) { [p.x1, p.y1] = T(p.x1, p.y1); [p.x2, p.y2] = T(p.x2, p.y2); }
    for (const q of d.drivers) { [q.x, q.y] = T(q.x, q.y); [q.nx, q.ny] = N(q.nx, q.ny); if (q.mount && flip) q.mount.side = -q.mount.side; }
    for (const q of d.paths || []) { q.pts = q.pts.map((v) => { const [x, y] = T(v.x, v.y); return { x, y }; }); if (q.opening) { const [x, y] = T(q.opening.x, q.opening.y); q.opening = { x, y }; } }
    (d.boundaries || []).forEach((b) => { [b.x1, b.y1] = T(b.x1, b.y1); [b.x2, b.y2] = T(b.x2, b.y2); });
    (d.arcs || []).forEach((g) => { for (const k of ['a', 'm', 'b']) { const [x, y] = T(g[k].x, g[k].y); g[k] = { x, y }; } });
  }
  /** Mogale Super Scooper (18" and 21"): every board is worked out from the drawing's own dimensions (g, in mm, y up from the
   *  outside bottom), as centre-lines that end where the joints are, and each joint is set the way Mogale cuts it. */
  function buildScooper(d, g, key) {
    const t = 18, h = 9, D = g.D, H = g.H, rad = Math.PI / 180;
    const U = (ax, ay, bx, by) => { const L = Math.hypot(bx - ax, by - ay); return { x: ax, y: ay, ux: (bx - ax) / L, uy: (by - ay) / L }; };   // line from a toward b
    const off = (l, k) => ({ ...l, x: l.x - l.uy * k, y: l.y + l.ux * k });                                                                    // moved k to the left of its direction
    const X = (a, b) => { const den = a.ux * b.uy - a.uy * b.ux, k = ((b.x - a.x) * b.uy - (b.y - a.y) * b.ux) / den; return [a.x + a.ux * k, a.y + a.uy * k]; };
    const vert = (x) => ({ x, y: 0, ux: 0, uy: 1 }), horiz = (y) => ({ x: 0, y, ux: 1, uy: 0 }), r1 = (v) => Math.round(v * 10) / 10;
    const B = (a, b) => { d.panels.push({ id: ++d.seq, x1: r1(a[0]), y1: r1(a[1]), x2: r1(b[0]), y2: r1(b[1]) }); return d.seq; };
    d.W = g.W; d.panels = []; d.arcs = []; d.seq = 0; d.joints = {};
    B([0, H - h], [D, H - h]); B([0, h], [D, h]); B([D - h, H - t], [D - h, t]);                 // top, bottom, back
    // the V under the chamber: its lower faces meet at the vertex (g.vx, g.vy)
    const vlLow = U(g.rec, g.baffleBot, g.vx, g.vy), vrLow = U(g.vx, g.vy, g.cx, g.cy), vlC = off(vlLow, h), vrC = off(vrLow, h), vrUp = off(vrLow, t);
    const Jb = X(vlC, vert(g.rec + h)), Jv = X(vlC, vrC);
    // the wedge: outer faces from its top corners; the right board's outer face runs on down the end of the V
    const wrOut = U(g.wrx, g.wry, g.cx, g.cy), wrC = off(wrOut, -h), wrIn = off(wrOut, -t);
    const a = g.wlLean * rad, wlOut = { x: g.wlx, y: g.wly, ux: -Math.sin(a), uy: -Math.cos(a) }, wlC = off(wlOut, h), wlIn = off(wlOut, t);
    const Jw = X(vrC, wrC), topPl = U(g.wlx, g.wly, g.wrx, g.wry), capC = off(topPl, -h);
    const baffle = B([g.rec + h, H - t], Jb), vl = B(Jb, Jv), vr = B(Jv, Jw);                    // baffle (set back g.rec), V left, V right
    // chamber wall and the two-piece hook at its foot
    const wall = B([g.wall + h, H - t], [g.wall + h, g.wallBot]);
    const tip = g.tip || X(U(g.wall, g.hookTop, g.wall - 1, g.hookTop - Math.tan(g.hook1 * rad)), U(g.wall, g.wallBot, g.wall - 1, g.wallBot + Math.tan(g.hook2 * rad)));
    const h1C = off(U(g.wall, g.hookTop, tip[0], tip[1]), h), h2C = off(U(g.wall, g.wallBot, tip[0], tip[1]), -h), Jh = X(h1C, h2C);
    const hook1 = B(X(h1C, vert(g.wall)), Jh), hook2 = B(Jh, X(h2C, vert(g.wall)));
    // 45 deg corner deflectors: the long face looks into the horn
    const cl = off(U(g.wall + t, g.clY, g.clX, H - t), h), cr = off(U(g.crX, H - t, D - t, g.crY), h);
    B(X(cl, vert(g.wall + t)), X(cl, horiz(H - t))); B(X(cr, horiz(H - t)), X(cr, vert(D - t)));
    // wedge boards (the right one first, so its foot pairs with the end of the V), then the cap that fits between their tops
    const wr = B(X(wrC, topPl), Jw), wl = B([g.wlx + h * Math.cos(a), g.wly - h * Math.sin(a)], X(wlC, vrUp)), cap = B(X(capC, wlIn), X(capC, wrIn));
    // the scoop: inner radius g.rIn about (g.acx, g.acy), from the back panel round to the floor
    const R = g.rIn + h, ax = D - t, ay = g.acy - Math.sqrt(R * R - (ax - g.acx) ** 2), bx = g.acx + Math.sqrt(R * R - (g.acy - t) ** 2);
    const tm = (Math.atan2(ay - g.acy, ax - g.acx) + Math.atan2(t - g.acy, bx - g.acx)) / 2;
    ARC(d, r1(ax), r1(ay), r1(g.acx + R * Math.cos(tm)), r1(g.acy + R * Math.sin(tm)), r1(bx), t);
    // joints, as on the mitre-angle sheet
    const J = (ia, ib, type) => { const j = HG.computeJoints(d).find((q) => !q.tee && ((q.a.id === ia && q.b.id === ib) || (q.a.id === ib && q.b.id === ia))); if (j) d.joints[j.key] = type; };
    J(baffle, vl, 'miter');                 // baffle foot on the V (41 / 19 deg)
    J(vl, vr, 'through:' + vl);             // left V board runs through, right one butts under it (38 / 38 deg)
    J(vr, wr, 'through:' + vr);             // wedge sits on the V (36 deg); the V's end follows the wedge's outer face (36 deg)
    J(hook1, hook2, 'miter');               // hook tip
    J(hook2, wall, 'butt:' + wall);         // hook closes onto the wall's foot; the wall stays square
    J(cap, wl, 'butt:' + wl); J(cap, wr, 'butt:' + wr);   // cap fits between the wedge boards
    d.driverKey = key;
    d.drivers.push({ id: ++d.seq, x: g.rec + h, y: g.drvY, nx: -1, ny: 0, key, n: 1, wiring: 'parallel' });
  }
  function makePreset(kind) {
    if (kind === 'default' && DEF) return Object.assign(baseDesign(DEF.design.name), JSON.parse(JSON.stringify(DEF.design)));
    const key = design ? design.driverKey : DEFAULT_DRIVER;
    const d = baseDesign({ th18sbm: '18in Tapped Horn (Speaker Box Maker)', h1850: '1850 Folded Horn (Rog Mogale)', skram: 'SKRAM 21in (Josh Ricci)', skhorn: 'Skhorn 2x21in (Josh Ricci)', bc118: 'BC118 (All_1)', scooper: 'Super Scooper 18in (Rog Mogale)', scooper21: 'Super Scooper 21in (Rog Mogale)', gsub: 'G Sub 2x18in (Rog Mogale)', h186: '186 Horn (Rog Mogale)', hd15: 'HD 15 Horn (Rog Mogale)', s12bp: 'S12BP (B&C Speakers)', s21hl: 'S21HL (B&C Speakers)', s218bp: 'S218BP (B&C Speakers)', x1: 'X1 (Rog Mogale)', th: 'Tapped horn', flh: 'Front-loaded horn', vented: 'Vented box', sealed: 'Sealed box', blank: 'Untitled' }[kind]);
    d.driverKey = key; if (design) { d.snap = design.snap; d.labelsAlways = design.labelsAlways; d.mirror = design.mirror; }
    if (design && design.custom && design.custom[key]) d.custom[key] = JSON.parse(JSON.stringify(design.custom[key]));   // a design-local driver travels with it
    else if (!specOf(key) && key !== DEFAULT_DRIVER) d.driverKey = DEFAULT_DRIVER;
    const t = d.t, h = t / 2;
    const drv = (x, y, nx, ny) => d.drivers.push({ id: ++d.seq, x, y, nx, ny, key: d.driverKey, n: 1, wiring: 'parallel' });
    if (kind === 'sealed') {
      d.W = 420; shell(d, 0, 0, 420, 520); drv(420 + h, 260, 1, 0);
    } else if (kind === 'vented') {
      d.W = 460; d.panels = [];
      P(d, -t, -h, 520 + t, -h); P(d, -t, 640 + h, 520 + t, 640 + h); P(d, -h, 0, -h, 640); P(d, 520 + h, 60, 520 + h, 640);
      P(d, 170, 60 + h, 520, 60 + h); // slot-port shelf
      d.paths.push({ id: ++d.seq, name: 'A', pts: [{ x: 170, y: 30 }, { x: 520 + t, y: 30 }], loss: 1 });
      drv(520 + h, 380, 1, 0);
    } else if (kind === 'sealed' || kind === 'blank') {
      // nothing
    } else if (kind === 'th') {
      // 3-leg tapped horn, internal 1150 high x 640 deep, W 500
      d.W = 500; const H = 1150, D = 640;
      P(d, -t, -h, D + t, -h);                 // floor
      P(d, -t, H + h, 400, H + h);             // top (legs 1-2 only, leg 3 opens up)
      P(d, -h, 0, -h, H);                      // back wall
      P(d, D + h, 0, D + h, H + t);            // front wall
      P(d, 95, 0, 165, H - 190);               // divider 1 (tapered)
      P(d, 400 - h, H + t, 360, 230);          // divider 2 from top down
      d.paths.push({ id: ++d.seq, name: 'A', pts: [{ x: 45, y: 25 }, { x: 70, y: H - 95 }, { x: 250, y: H - 95 }, { x: 250, y: 115 }, { x: 510, y: 115 }, { x: 520, y: H + t + 4 }], loss: 1 });
      // driver on divider 1, front into leg 1 near the throat, rear into leg 2
      const ux = (165 - 95), uy = H - 190, L = hyp(ux, uy), u = 330 / L;
      drv(95 + ux * u, uy * u, -uy / L, ux / L);
    } else if (kind === 'flh') {
      d.W = 520; const t2 = t;
      // rear chamber (left), baffle at x=300, throat chamber, horn flaring to the right
      P(d, -t2, -h, 300, -h); P(d, -t2, 600 + h, 300, 600 + h); P(d, -h, 0, -h, 600);
      P(d, 300 + h, -t2, 300 + h, 600 + t2);   // baffle
      P(d, 300 + t2, 0, 440, 255 - h);         // compression chamber lower wall (from the box corner: clears any 18" frame)
      P(d, 300 + t2, 600, 440, 345 + h);       // compression chamber upper wall
      P(d, 440, 255 - h, 1400, 40);            // horn lower wall
      P(d, 440, 345 + h, 1400, 560);           // horn upper wall
      d.paths.push({ id: ++d.seq, name: 'A', pts: [{ x: 440, y: 300 }, { x: 1405, y: 300 }], loss: 1 });
      drv(300 + h, 300, 1, 0);
    } else if (kind === 'h1850' || kind === 'h186') {
      // 1850 folded horn — design by Rog Mogale (speakerplans.com, 2002; plans allow building up to 4 cabs for personal use).
      // Traced from the published side view: 750 deep x 956 high, 18 mm boards, 600 internal width. Open braces omitted.
      d.W = 600; d.panels = []; d.seq = 0;
      P(d, 0, 947, 750, 947); P(d, 0, 9, 750, 9); P(d, 741, 938, 741, 18); P(d, 9, 938, 9, 496);   // top, bottom, back, front (to 460 from top)
      P(d, 20, 938, 40, 806); P(d, 40, 806, 190, 496);                                             // front diagonal horn wall
      P(d, 190, 846, 732, 906);                                                                   // baffle
      P(d, 190, 846, 340, 616); P(d, 340, 616, 732, 654);                                         // inner diagonal, rear-chamber floor
      P(d, 340, 616, 567, 536); P(d, 567, 536, 732, 378);                                         // second fold wall
      P(d, 190, 496, 470, 295); P(d, 732, 150, 660, 18);                                          // lower fold wall, corner deflector
      const bl = Math.hypot(542, 60);
      const k1850 = kind === 'h186' ? (['WinISD:Precision Devices PD.186'].find((k) => LIBMAP.has(k)) || key) : (LIBMAP.has('WinISD:PrecisionDevices PD.1850') ? 'WinISD:PrecisionDevices PD.1850' : key);   // the 186 Horn is the same cabinet for a PD 186
      d.driverKey = k1850;
      d.drivers.push({ id: ++d.seq, x: 455, y: 875.3, nx: -60 / bl, ny: 542 / bl, key: k1850, n: 1, wiring: 'parallel' });
    }
    if (kind === 'th18sbm') {
      // 18" tapped horn — design by Speaker Box Maker (YouTube), traced from the published SketchUp views.
      // 724 deep x 1016 high, 18 mm boards, 535 internal width. Braces parallel to the sides are omitted.
      d.W = 535; d.panels = []; d.seq = 0;
      P(d, 0, 1007, 724, 1007); P(d, 0, 9, 560, 9); P(d, 715, 998, 715, 164); P(d, 560, 9, 715, 164);   // top, bottom, back, 159 chamfer
      P(d, 9, 998, 9, 520);                                                                            // front, down to the driver baffle
      P(d, 131.6, 629, 148, 869); P(d, 304, 998, 304, 702); P(d, 480, 330, 500, 811);                  // fold boards
      P(d, 131.6, 629, 482, 392);                                                                      // throat roof (406 mm board)
      P(d, 18, 517, 480, 330);                                                                         // driver baffle
      P(d, 598, 998, 706, 890);                                                                        // top-back corner board
      const k18 = ['PE:B&C 18DS115 [sheet]', 'PE:B&C 18DS115', 'WinISD:B&C 18SW115-4'].find((k) => LIBMAP.has(k)) || key;
      d.driverKey = k18;
      d.drivers.push({ id: ++d.seq, x: 234, y: 429.6, nx: 0.375, ny: 0.927, key: k18, n: 1, wiring: 'parallel' });
    }
    if (kind === 'skram') {
      // SKRAM 21" sub — design by Josh Ricci (ZOD Audio), plans shared via TinkerandParty. From the published
      // "Basic panel layout" sheet and the 3-D STEP model, sliced at mid-width. 812.8 deep x 914.4 high x 609.6 wide,
      // 18 mm panels, 573.6 internal width. Front (mouth + vents) on the left. Windowed braces, hatch braces and the
      // 3 vent dividers (they only split the vent width) are omitted.
      d.W = 573.6; d.panels = []; d.seq = 0;
      P(d, 0, 905.4, 812.8, 905.4); P(d, 0, 9, 812.8, 9);            // top, bottom
      P(d, 803.8, 896.4, 803.8, 18);                                   // back (hatch side)
      P(d, 9, 896.4, 9, 354.4);                                        // front panel above the mouth
      P(d, 0, 162, 659.8, 162);                                        // vent panel H: 135 mm vents underneath, open at both ends
      P(d, 285.8, 171, 285.8, 791);                                    // driver baffle G
      P(d, 18, 782, 276.8, 782);                                       // turn cap K (closes the front chamber's top)
      P(d, 204.5, 171, 152.9, 652);                                    // 6° turn panel F
      const k21 = ['PE:B&C 21DS115 [sheet]', 'PE:B&C 21DS115 8Ω', 'PE:B&C 21DS115 4Ω', 'PE:B&C 21SW152'].find((k) => LIBMAP.has(k)) || key;
      d.driverKey = k21;
      d.drivers.push({ id: ++d.seq, x: 285.8, y: 450, nx: -1, ny: 0, key: k21, n: 1, wiring: 'parallel', mountStyle: 'rear' });
    }
    if (kind === 'skhorn') {
      // Skhorn 2x21" sub — design by Josh Ricci (ZOD Audio), plans hosted by JW Sound with his permission. Sliced from the
      // published 3-D STEP model. 812.8 deep x 1371.6 high x 609.6 wide, 18 mm panels (12 mm port boards), 573.6 internal
      // width. Two mirrored halves: the opposed drivers fire into a shared wedge throat that turns out to a horn mouth at
      // each end of the front; each rear chamber is vented by a 3" slot along the end panel (three vents per side in the
      // real cab: the vent braces only split the width). Windowed braces and hatch braces are omitted.
      d.W = 573.6; d.panels = []; d.seq = 0;
      P(d, 0, 9, 794.8, 9); P(d, 0, 1364.6, 794.8, 1364.6);          // bottom, top (end panels)
      P(d, 804.8, 0, 804.8, 1373.6);                                     // back (hatch side)
      P(d, 9, 282.1, 9, 1105.8);                                         // front panel between the two horn mouths
      P(d, 0, 101.3, 557, 101.3); P(d, 0, 1272.4, 557, 1272.4);          // port boards (12 mm): 3" vents along the end panels
      d.panels[d.panels.length - 1].t = 12; d.panels[d.panels.length - 2].t = 12;
      P(d, 199.8, 101.3, 150.3, 567.9); P(d, 199.8, 1272.4, 150.8, 810.2);   // rear-chamber walls / horn path inner walls
      P(d, 150.3, 567.9, 795.8, 631.8); P(d, 150.8, 810.2, 795.8, 737.8);    // driver baffles G (the wedge throat between them)
      const k21 = ['PE:B&C 21DS115 [sheet]', 'PE:B&C 21DS115 8Ω', 'PE:B&C 21DS115 4Ω', 'PE:B&C 21SW152'].find((k) => LIBMAP.has(k)) || key;
      d.driverKey = k21;
      d.drivers.push({ id: ++d.seq, x: 473, y: 599.9, nx: -0.0985, ny: 0.9951, key: k21, n: 1, wiring: 'parallel' });
      d.drivers.push({ id: ++d.seq, x: 473.3, y: 774, nx: -0.1116, ny: -0.9938, key: k21, n: 1, wiring: 'parallel' });
    }
    if (kind === 'bc118') {
      // BC118: a one-driver half of Tom Danley's BC218, designed by All_1 on diyaudio.com ("Boundary control BC subwoofer
      // BC218/2 Design" thread), traced from his dimensioned side view. 1500 x 750 outside, 750 wide (714 inside), 18 mm.
      // The 18SW115 hangs under the lower baffle and fires up into a 28 mm compression slot, which runs down to the floor,
      // turns 180 deg up round the end of the board above, runs back up-left under the top fold, wraps over its left end
      // and expands to the mouth on the right face. The real cab's "half-moon" exit can't be drawn in 2-D (nor modelled in
      // Hornresp), so the mouth here is the plain right face.
      d.W = 714; d.panels = []; d.seq = 0;
      P(d, 0, 741, 1500, 741); P(d, 0, 9, 1500, 9); P(d, 9, 732, 9, 18);        // top, bottom, closed left end
      P(d, 190.8, 538.3, 1021.2, 333.7); P(d, 1021.2, 333.7, 1469.3, 18);     // top fold board (two pieces)
      P(d, 18, 381.8, 976.4, 206.5); P(d, 976.4, 206.5, 1164.8, 72.7);        // slot roof (stops short of the floor)
      P(d, 18, 336.3, 944.3, 127.3); P(d, 944.3, 127.3, 1065.4, 18);          // driver baffle (two pieces)
      P(d, 1223.5, 18, 1223.5, 180); P(d, 1163, 18, 1214.5, 103);             // closing board + 100 mm brace (dead pocket)
      const k18 = ['PE:B&C 18SW115', 'PE:B&C 18SW115-4 [sheet]', 'WinISD:B&C 18SW115-4'].find((k) => LIBMAP.has(k)) || key;
      d.driverKey = k18;
      d.drivers.push({ id: ++d.seq, x: 254.2, y: 283, nx: 0.22, ny: 0.9755, key: k18, n: 1, wiring: 'parallel', mountStyle: 'rear' });
    }
    if (kind === 'scooper') {
      // Super Scooper 18": Rog Mogale's rear-loaded scoop horn (speakerplans.com), every board from his side view, panel
      // lengths, flare angles and mitre angles. 760 deep x 1220 high x 636 wide (600 inside), 18 mm birch ply.
      // Baffle set back 36 mm; lined chamber behind it; the horn leaves under the chamber wall (past its two-piece hook),
      // climbs between the wall and the wedge (3 deg), turns over the wedge under the two 45 deg deflectors, drops down the
      // back (14 deg) and sweeps round the 550 mm-radius scoop to the 639 mm mouth. Horn length 2.22 m, cutoff 38 Hz;
      // Mogale says to high-pass at about 30 Hz. The blue braces on his drawing are left out (they don't close the air).
      buildScooper(d, { D: 760, H: 1220, W: 600, rec: 36, baffleBot: 657, vx: 250, vy: 534, cx: 460, cy: 620, wall: 256, wallBot: 717, hookTop: 817, hook1: 45, hook2: 18,
        clY: 1094, clX: 382, crX: 631, crY: 1091, wlx: 443, wly: 1028, wlLean: 3, wrx: 554, wry: 1023, acx: 191, acy: 566, rIn: 550, drvY: 949 },
        ['WinISD:PrecisionDevices PD.1850'].find((k) => LIBMAP.has(k)) || key);
    }
    if (kind === 'scooper21') {
      // Super Scooper 21": the 21" version (speakerplans.com), same construction from its own drawing: 798 deep x 1320 high
      // x 636 wide (600 inside). Flares 2 deg and 12 deg, 574 mm-radius scoop, 700 mm mouth. Horn length 2.44 m, cutoff 35 Hz.
      buildScooper(d, { D: 798, H: 1320, W: 600, rec: 36, baffleBot: 700, vx: 287, vy: 567, cx: 496, cy: 653, wall: 294, wallBot: 747, hookTop: 853, tip: [188, 797],
        clY: 1192, clX: 421, crX: 667, crY: 1189, wlx: 483, wly: 1120, wlLean: 2.5, wrx: 591, wry: 1116, acx: 209, acy: 586, rIn: 574, drvY: 1010 },
        ['WinISD:Precision Devices PD.2150'].find((k) => LIBMAP.has(k)) || key);
    }
    if (kind === 'gsub') {
      // G Sub: Rog Mogale (speakerplans.com, 2001). Dual 18" vented box, 536 x 1100 x 670 (500 inside), baffle recessed 34 mm,
      // 464 x 120 slot port between the drivers, 193 mm deep. 2 x PD 186: -3 dB at 36.9 Hz.
      d.W = 500; d.panels = []; d.seq = 0;
      P(d, 0, 1091, 670, 1091); P(d, 0, 9, 670, 9); P(d, 661, 1082, 661, 18);  // top, bottom, back
      P(d, 43, 1082, 43, 628); P(d, 43, 472, 43, 18);                          // baffle above and below the port
      P(d, 34, 619, 227, 619); P(d, 34, 481, 227, 481);                        // slot port boards (120 high, 193 deep)
      const kg = ['WinISD:Precision Devices PD.186'].find((k) => LIBMAP.has(k)) || key;
      d.driverKey = kg;
      d.drivers.push({ id: ++d.seq, x: 43, y: 838, nx: -1, ny: 0, key: kg, n: 1, wiring: 'parallel' });
      d.drivers.push({ id: ++d.seq, x: 43, y: 262, nx: -1, ny: 0, key: kg, n: 1, wiring: 'parallel' });
    }
    if (kind === 'hd15') {
      // HD 15 Horn: Rog Mogale (speakerplans.com, 2001), as reworked here: 618 deep x 578 high, front fully open as the mouth.
      // The 15" on a slanted 414 mm baffle fires up the throat beside the back wall, over a flat 45 deg former (one board in
      // place of the 395 mm-radius curve) and out the front; its rear sits in the sealed triangle under the former.
      d.W = 436; d.panels = []; d.seq = 0;
      P(d, 0, 569, 618, 569); P(d, 15, 9, 618, 9); P(d, 609, 560, 609, 18);    // top, bottom, back
      P(d, 506, 560, 600, 459);                                                 // corner deflector
      P(d, 20, 18, 474, 468);                                                   // the former, one flat board
      P(d, 399.8, 397.8, 566, 18);                                              // driver baffle
      const kh = ['PE:Eminence Kappa Pro-15LF2', 'WinISD:Eminence Kappa PRO 15LF'].find((k) => LIBMAP.has(k)) || key;
      d.driverKey = kh;
      d.drivers.push({ id: ++d.seq, x: 484.6, y: 204.1, nx: 0.9159, ny: 0.4013, key: kh, n: 1, wiring: 'parallel', mountStyle: 'rear' });
    }
    if (kind === 's12bp') {
      // S12BP: B&C Speakers suggested design, 6th-order bandpass for one 12". Drawn from B&C's dimensioned TOP view (the
      // layout is in the horizontal plane, so the cabinet height is the extrusion): 450 wide x 650 deep x 400 high, 15 mm
      // birch ply. The driver sits on a cross baffle 230 mm back; the front chamber vents through a 60 mm centre port 130
      // deep, the rear chamber through two 30 mm side ports running 450 mm back along the sides. Plan: 12BG76 8 ohm (our
      // closest is the 12BG100). DSP from B&C: HPF 40 Hz BW24, LPF 80 Hz LR24, PEQ +6/44, -4/113, -15/327.
      d.W = 370; d.t = 15; d.panels = []; d.seq = 0;
      P(d, 0, 7.5, 650, 7.5); P(d, 0, 442.5, 650, 442.5); P(d, 642.5, 15, 642.5, 435);   // sides, back
      P(d, 0, 53.5, 450, 53.5); P(d, 0, 396.5, 450, 396.5);                             // side-port boards (30 mm ports, 450 long)
      P(d, 237.5, 61, 237.5, 389);                                                       // baffle
      P(d, 22.5, 61, 22.5, 180); P(d, 22.5, 270, 22.5, 389);                             // front panels, recessed 15
      P(d, 15, 187.5, 130, 187.5); P(d, 15, 262.5, 130, 262.5);                          // centre port (60 wide, 130 deep)
      const k12 = ['PE:B&C 12BG76', 'PE:B&C 12BG100'].find((k) => LIBMAP.has(k)) || key;
      d.driverKey = k12;
      d.drivers.push({ id: ++d.seq, x: 237.5, y: 225, nx: -1, ny: 0, key: k12, n: 1, wiring: 'parallel', mountStyle: 'rear' });
      d.dsp = { hp: { on: true, type: 'BW', order: 4, f: 40 }, lp: { on: true, type: 'LR', order: 4, f: 80 }, gain: 0,
        peq: [{ on: true, type: 'pk', f: 44, g: 6, q: 3 }, { on: true, type: 'pk', f: 113, g: -4, q: 3 }, { on: true, type: 'pk', f: 327, g: -15, q: 6 },
          { on: false, type: 'pk', f: 50, g: 0, q: 2 }, { on: false, type: 'pk', f: 63, g: 0, q: 2 }, { on: false, type: 'pk', f: 80, g: 0, q: 2 }] };
    }
    if (kind === 'x1') {
      // X1: Rog Mogale (speakerplans.com, 2004), 6th-order bandpass for one 18". 800 deep x 770 high x 606 wide (570 inside).
      // The driver is fitted from the back access panel under a slanted baffle and fires up into the upper chamber, which
      // vents through the 120 mm slot along the top (open at the front; the shelf is taken to stop 120 mm short of the back
      // so the slot reaches the chamber); the lower chamber vents through the 120 mm bottom slot, 417 long. Mogale: 31-119 Hz
      // with a P.Audio SD-18; our closest 18" is the B&C 18SW115.
      d.W = 570; d.panels = []; d.seq = 0;
      P(d, 0, 761, 800, 761); P(d, 0, 9, 800, 9); P(d, 791, 752, 791, 18);     // top, bottom, back (closed)
      P(d, 0, 623, 662, 623);                                                   // shelf under the top slot
      P(d, 9, 614, 9, 156);                                                     // front panel between the two slots
      P(d, 0, 147, 417, 147);                                                   // bottom slot roof (417 long)
      P(d, 270, 614, 782, 405);                                                 // slanted driver baffle (540)
      const kx = ['PE:B&C 18SW115', 'PE:B&C 18SW115-4 [sheet]'].find((k) => LIBMAP.has(k)) || key;
      d.driverKey = kx;
      d.drivers.push({ id: ++d.seq, x: 526, y: 509.5, nx: 0.378, ny: 0.926, key: kx, n: 1, wiring: 'parallel', mountStyle: 'rear' });
    }
    if (kind === 's21hl') {
      // S21HL: B&C Speakers suggested design, front-loaded folded horn for one 21". Drawn from B&C's dimensioned TOP view
      // (DXF sheet 01; the layout is in the horizontal plane, so the cabinet height is the extrusion): 1000 x 1000 x 800 high,
      // 18 mm birch ply, 764 inside. The 21DS115 is front-mounted on the slanted baffle P (fitted through the 600 x 600
      // window in the double access side D+E) and fires into the tapering wedge throat between P and that side. The horn
      // runs out of the wedge, round the 149 corner board L, up beside the back B, round the 230 corner board M, along the
      // side C over the pentagonal rear chamber (P, F, G, H, I, ~200 L) and out of the whole open face (946 x 764 mouth).
      // Mirrored so the mouth is on the left. The two O shelves in the horn (they cut its height by 36 mm) and the N chamber
      // braces are omitted; P is 21 mm in B&C's model, drawn 18 here with its throat face where B&C put it.
      d.W = 764; d.panels = []; d.seq = 0;
      P(d, 991, 0, 991, 1000);                                     // B back (1000, full depth)
      P(d, 982, 991, 0, 991);                                      // C horn side panel (982), butts into B
      P(d, 982, 18, 0, 18); d.panels[d.panels.length - 1].t = 36;  // D external + E internal access panels (36), butt into B
      P(d, 982, 128.6, 889.4, 36);                                 // L corner board (149 face) at back / access side
      P(d, 982, 832.1, 832.1, 982);                                // M corner board (230 face) at back / C
      P(d, 794.4, 209.1, 707.5, 701.5);                            // F chamber wall (500), foot flush with P's throat face
      P(d, 700.4, 690.3, 413.7, 613.5);                            // G chamber wall (300), butts into F
      P(d, 413.7, 613.5, 169.3, 369.1);                            // H chamber wall (350), mitred to G and I
      P(d, 169.3, 369.1, 48.1, 36);                                // I chamber wall (369), down to the access side at the mouth
      P(d, 784.1, 215.7, 113.5, 36);                               // P driver baffle (740/660, 15 deg to the access side)
      const k21 = ['PE:B&C 21DS115 4Ω', 'PE:B&C 21DS115 [sheet]', 'PE:B&C 21DS115 8Ω'].find((k) => LIBMAP.has(k)) || key;
      d.driverKey = k21;
      d.drivers.push({ id: ++d.seq, x: 459, y: 128.6, nx: 0.2588, ny: -0.9659, key: k21, n: 1, wiring: 'parallel' });
      d.dsp = { hp: { on: true, type: 'BW', order: 4, f: 28 }, lp: { on: true, type: 'BW', order: 4, f: 100 }, gain: 4,
        peq: [{ on: true, type: 'pk', f: 35, g: 6, q: 1 }, { on: true, type: 'pk', f: 60, g: 3, q: 3 }, { on: true, type: 'pk', f: 105, g: 3, q: 6 }, { on: true, type: 'pk', f: 130, g: -6, q: 3 }, { on: false, type: 'pk', f: 80, g: 0, q: 2 }, { on: false, type: 'pk', f: 100, g: 0, q: 2 }] };
    }
    if (kind === 's218bp') {
      // S218BP: B&C Speakers suggested design, 6th-order bandpass, 2 x 18DS115 8 ohm, 15 mm birch ply, 1200 W x 800 D x 520 H outside.
      // Drawn as the TOP view (x = depth from the open front, y = across the width); extrusion = 520 - 2 x 15 = 490. No front panel.
      // Each driver is rear-mounted on a baffle running front-to-back 140 mm in from its side panel. The cone fires outward into a
      // 140 x 470 side chamber (~32 L each) that runs forward into a 92 mm side port (~300 mm long) exiting at the front corners.
      // Both motors share one rear chamber (~270 L gross): both front "U" boxes behind the recessed front boards plus the back-centre
      // region. It vents through the centre hourglass mid port (~280 mouth, 163 throat, ~495 long) that exits mid-front.
      // Board positions come from the routed base grooves (DXF 03). Omitted because they barely change the airspace: the 2+2 side-port
      // and 2 mid-port horizontal shelves, the front-chamber shelves, the 125 mm vertical stub on each mid-port wall (VerticalChamber-Reinf),
      // the 40 mm back-centre strips, and the access-panel support/reinforcement frame.
      // Not modelled (1-D limit): B&C's mandatory 160 H x 35 mm slot in each mid-port wall at the MidReflex-1/-2 joint (x ~347).
      // This slot leaks the port's middle into the rear chamber.
      d.W = 490; d.t = 15; d.panels = []; d.seq = 0;
      P(d, 0, 7.5, 800, 7.5);            // left side panel, full depth
      P(d, 0, 1192.5, 800, 1192.5);      // right side panel, full depth
      P(d, 792.5, 15, 792.5, 1185);      // back panel (access panel sits flush in it), between the side-panel faces
      // ---- left half ----
      P(d, 73.1, 114.5, 315, 114.5);     // side-port inner wall (SideReflex): 92 mm side port y 15..107, runs back to Chamber-2's rear face
      P(d, 307.5, 122, 307.5, 155);      // Chamber-2 jog: steps the channel from 92 (port) to 140 (front chamber)
      P(d, 300, 162.5, 785, 162.5);      // driver baffle (490 long), ends on the back-panel face
      P(d, 73.1, 114.5, 27.5, 160.1);    // 45 deg side-port bend (SideReflexBend), corner of the front U box
      P(d, 27.5, 160.1, 27.5, 451.9);    // front board of the U box, recessed 20 mm behind the front face
      P(d, 27.5, 451.9, 180, 510.9);     // mid-port wall 1, flares from the mouth (MidReflex-3)
      P(d, 180, 510.9, 347.1, 510.9);    // mid-port wall 2, straight throat (163.2 clear), MidReflex-2
      P(d, 347.1, 510.9, 495, 453.6);    // mid-port wall 3, flares out to the rear-chamber mouth (MidReflex-1)
      // ---- right half (mirror, y -> 1200 - y) ----
      P(d, 73.1, 1085.5, 315, 1085.5);   // side-port inner wall
      P(d, 307.5, 1078, 307.5, 1045);    // Chamber-2 jog
      P(d, 300, 1037.5, 785, 1037.5);    // driver baffle
      P(d, 73.1, 1085.5, 27.5, 1039.9);  // 45 deg side-port bend
      P(d, 27.5, 1039.9, 27.5, 748.1);   // front board of the U box
      P(d, 27.5, 748.1, 180, 689.1);     // mid-port wall 1 (mouth flare)
      P(d, 180, 689.1, 347.1, 689.1);    // mid-port wall 2 (throat)
      P(d, 347.1, 689.1, 495, 746.4);    // mid-port wall 3 (rear flare)
      // hand-drawn air paths (the automatic finder misses the two side ports in this layout): the mid port out of the shared
      // rear chamber, and each front chamber running into its side port
      d.autoPaths = false;
      d.paths = [
        { id: ++d.seq, name: 'A', pts: [{ x: 490, y: 600 }, { x: 347, y: 600 }, { x: 180, y: 600 }, { x: -4, y: 600 }], loss: 1 },
        { id: ++d.seq, name: 'B', pts: [{ x: 775, y: 85 }, { x: 320, y: 85 }, { x: 300, y: 61 }, { x: -4, y: 61 }], loss: 1 },
        { id: ++d.seq, name: 'C', pts: [{ x: 775, y: 1115 }, { x: 320, y: 1115 }, { x: 300, y: 1139 }, { x: -4, y: 1139 }], loss: 1 },
      ];
      const k18 = ['PE:B&C 18DS115 8Ω', 'PE:B&C 18DS115 [sheet]', 'PE:B&C 18DS115'].find((k) => LIBMAP.has(k)) || key;
      d.driverKey = k18;
      // Hole centre is 250 from the baffle's front (rabbeted) end, so x = 550. The driver spans x 320..780 and the motor reaches
      // about y 405 (left) / 795 (right), clear of the mid-port walls (which end at x 495). Cones face the side walls.
      d.drivers.push({ id: ++d.seq, x: 550, y: 162.5, nx: 0, ny: -1, key: k18, n: 1, wiring: 'parallel', mountStyle: 'rear' });
      d.drivers.push({ id: ++d.seq, x: 550, y: 1037.5, nx: 0, ny: 1, key: k18, n: 1, wiring: 'parallel', mountStyle: 'rear' });
      d.dsp = { hp: { on: true, type: 'BW', order: 4, f: 29 }, lp: { on: true, type: 'LR', order: 4, f: 80 }, gain: 0,
        peq: [{ on: true, type: 'pk', f: 33, g: 3, q: 3 }, { on: false, type: 'pk', f: 40, g: 0, q: 2 }, { on: false, type: 'pk', f: 50, g: 0, q: 2 }, { on: false, type: 'pk', f: 63, g: 0, q: 2 }, { on: false, type: 'pk', f: 80, g: 0, q: 2 }, { on: false, type: 'pk', f: 100, g: 0, q: 2 }] };
    }
    if (['th', 'flh', 'vented', 'sealed', 'blank'].includes(kind)) d.W = widthRange(d).def;   // starting templates: driver + 3"
    syncArcsIn(d);
    if (kind !== 'default') faceLeft(d);   // every preset's mouth faces the drawing's left; the View switch turns them all together
    if (kind === 'blank') d.drivers = [];
    d.paths.forEach((q) => { q.auto = true; });
    return d;
  }

  // ---------------------------------------------------------------- view
  const view = { k: 0.5, tx: 0, ty: 0, w: 1, h: 1, dpr: 1 };
  // MX = -1 shows the cabinet from the other side (mirror left/right); the design itself is unchanged
  const MX = () => (design && design.mirror ? -1 : 1);
  function w2s(x, y) { return [MX() * x * view.k + view.tx, -y * view.k + view.ty]; }
  function s2w(sx, sy) { return [MX() * (sx - view.tx) / view.k, -(sy - view.ty) / view.k]; }
  function fit() {
    const xs = [], ys = [];
    for (const p of design.panels) { xs.push(p.x1, p.x2); ys.push(p.y1, p.y2); }
    for (const p of design.paths) for (const q of p.pts) { xs.push(q.x); ys.push(q.y); }
    if (!xs.length) { xs.push(-200, 1000); ys.push(-200, 800); }
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    // leave room for the overall dimension lines (left and above, 10 % out) and the hint bar along the top
    const bw = Math.max(100, x1 - x0), bh = Math.max(100, y1 - y0), pad = 60;
    view.k = Math.min((view.w - 2 * pad - 40) / (1.14 * bw), (view.h - 150) / (1.14 * bh));
    view.tx = view.w / 2 + 0.06 * bw * view.k - MX() * (x0 + x1) / 2 * view.k;
    view.ty = view.h / 2 + 0.06 * bh * view.k + 12 + (y0 + y1) / 2 * view.k;
  }
  function resize() {
    const r = cv.getBoundingClientRect(); view.dpr = window.devicePixelRatio || 1;
    const first = view.w <= 1;
    view.w = r.width; view.h = r.height;
    cv.width = Math.round(r.width * view.dpr); cv.height = Math.round(r.height * view.dpr);
    if (first) fit();
    const cr = chartCv.getBoundingClientRect();
    chartCv.width = Math.round(cr.width * view.dpr); chartCv.height = Math.round(cr.height * view.dpr);
    draw(); drawChart();
  }

  // ---------------------------------------------------------------- theme colours
  let C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['bg', 'panel', 'raised', 'ink', 'muted', 'line', 'grid', 'grid2', 'accent', 'driver', 'air', 'chamber', 'warn', 'bad', 'ok', 'birch', 'birch-edge', 'birch-ply', 'mdf', 'mdf-edge'])
      C[k] = cs.getPropertyValue('--' + k).trim();
    C.font = cs.getPropertyValue('--font-ui'); C.mono = cs.getPropertyValue('--font-data');
    regionImg = null;
  }
  function rgba(hex, a) {
    let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function rgbArr(hex) { let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  // ---------------------------------------------------------------- units
  // Grid / units: 1" or 0.1" (inches), cm or mm. The grid step is also the rounding increment for lengths.
  const SNAPS = { in1: { step: 25.4, unit: 'in', label: '1"' }, in01: { step: 2.54, unit: 'in', label: '0.1"' }, cm: { step: 10, unit: 'cm', label: 'cm' }, mm: { step: 1, unit: 'mm', label: 'mm' } };
  const snapMode = () => SNAPS[design.snap] || SNAPS.in01;
  const unit = () => snapMode().unit;
  const gridStep = () => snapMode().step;
  const isIn = () => unit() === 'in';
  const UDIV = { in: 25.4, cm: 10, mm: 1 }, UDP = { in: 2, cm: 1, mm: 0 }, USUF = { in: '"', cm: ' cm', mm: ' mm' };
  function fmtL(mm, dp) {
    if (!isFinite(mm)) return '—';
    const u = unit(); let v = (mm / UDIV[u]).toFixed(dp != null ? dp : UDP[u]);
    if (u === 'in' && dp == null) v = String(+v);
    return v + USUF[u];
  }
  function toU(mm) { const u = unit(); return +(mm / UDIV[u]).toFixed(u === 'mm' ? 1 : 2); }
  const roundStep = (mm) => Math.round(mm / gridStep()) * gridStep();
  function parseL(str) {
    str = String(str).trim().toLowerCase();
    const frac = (s) => s.split(/\s+/).reduce((a, part) => { if (part.includes('/')) { const [n, d] = part.split('/'); return a + (+n) / (+d); } return a + (+part); }, 0);
    if (/(in|")$/.test(str)) return frac(str.replace(/(in|")$/, '').trim()) * 25.4;
    if (/mm$/.test(str)) return +str.replace(/mm$/, '');
    if (/cm$/.test(str)) return +str.replace(/cm$/, '') * 10;
    const v = frac(str); return v * UDIV[unit()];
  }

  // ---------------------------------------------------------------- analysis + simulation
  let A = null, R = null, T = null, gen = 0, pins = [];
  const libFn = (key) => hrOf(key);
  function analyse() {
    try { A = HG.analyse(design, libFn); } catch (e) { console.error(e); A = { warnings: ['Geometry error: ' + e.message], quads: design.panels.map((p) => HG.panelQuad(p, design.t)), paths: [], regions: [] }; }
    regionImg = null;
    simulate();
  }
  const FREQS = HC.logFreqs(10, 2000, 420);
  const PEQ_F = [25, 32, 40, 50, 63, 80];
  function dspOf(d) {
    if (!d.dsp) {
      const xo = d.xover || {};
      d.dsp = { hp: { on: !!(xo.on && xo.hp > 0), type: 'LR', order: 4, f: xo.hp || 25 }, lp: { on: !!(xo.on && xo.lp > 0), type: 'LR', order: 4, f: xo.lp || 100 },
        peq: PEQ_F.map((f) => ({ on: false, type: 'pk', f, g: 0, q: 2 })), gain: 0 };
      delete d.xover;
    }
    return d.dsp;
  }
  const dspActive = () => { const d = dspOf(design); return d.hp.on || d.lp.on || d.peq.some((b) => b.on && b.g) || !!d.gain; };
  function xoverH(f) { return HC.dspH(dspOf(design), f); }
  /** re-apply the DSP chain to the stored raw response (no acoustic re-solve) */
  function applyDsp() {
    if (!R || !R.Hraw) return;
    const F = R.f.map((f) => xoverH(f));
    R.H = R.Hraw.map((h, i) => HC.mul(h, F[i]));
    R.spl = R.H.map((h) => 20 * Math.log10(HC.abs(h) / 2e-5 + 1e-20));
    R.x = R.xRaw.map((v, i) => v * HC.abs(F[i]));
    R.vel = R.velRaw.map((a, i) => a.map((v) => v * HC.abs(F[i])));
    R.gd = groupDelay(R.f, R.H);
    gen++; T = null; if (['step', 'decay'].includes(tab)) scheduleTransient();   // cancel any time-response job using the old filters
  }
  function simulate() {
    gen++; T = null;
    if (!A || !A.net || !A.net.drivers.length) { R = null; refreshSide(); return; }
    const net = A.net;
    if (!net.radiators.length && !net.drivers.some((d) => d.front === 'air' || d.rear === 'air')) { R = null; refreshSide(); return; }
    let Pp;
    try { Pp = HC.prepare(net); } catch (e) { R = null; A.warnings.push('Network error: ' + e.message); refreshSide(); return; }
    const out = { f: FREQS, spl: [], splRaw: [], H: [], Hraw: [], velRaw: [], ze: [], zePh: [], x: [], xRaw: [], vel: [], ra: [], xa: [], W: [] };
    const drv0 = net.drivers[0];
    const hr0 = HC.compositeDriver(drv0.d, drv0.n || 1, drv0.wiring);
    for (const f of FREQS) {
      const s = HC.solveAt(Pp, f);
      const F = xoverH(f), aF = HC.abs(F);
      const p = HC.mul(s.pff, F);
      out.H.push(p); out.Hraw.push(s.pff);
      out.splRaw.push(20 * Math.log10(HC.abs(s.pff) / 2e-5 + 1e-20));
      out.spl.push(20 * Math.log10(HC.abs(p) / 2e-5 + 1e-20));
      out.ze.push(HC.abs(s.Zin)); out.zePh.push(HC.arg(s.Zin) * 180 / Math.PI);
      const xr = Math.max(...s.drv.map((d) => HC.abs(d.x))) * 1000 * Math.SQRT2;
      out.xRaw.push(xr); out.x.push(xr * aF);
      const vr = s.rad.map((r) => HC.abs(r.U) / r.S * Math.SQRT2); out.velRaw.push(vr); out.vel.push(vr.map((v) => v * aF));
      const d0 = s.drv[0];
      const Zf = HC.div(d0.pf, HC.scl(d0.u, hr0.Sd));
      const zn = HC.scl(Zf, hr0.Sd / (HC.AIR.rho * HC.AIR.c));
      out.ra.push(zn.r); out.xa.push(zn.i);
    }
    out.radLabels = Pp.radiators.map((r) => r.label);
    // group delay
    out.gd = groupDelay(out.f, out.H);
    // max SPL
    const spec = specOf(design.drivers[0] && design.drivers[0].key) || {};
    const n = design.drivers.reduce((a, d) => a + (d.n || 1), 0);
    const Pe = (spec.Pe || 0) * n, Xmax = spec.Xmax || 0, eg = design.eg || 2.83;
    const Rec = hr0.Re;
    out.maxTh = []; out.maxX = []; out.maxSpl = [];
    for (let i = 0; i < FREQS.length; i++) {
      const vTh = Pe > 0 ? Math.sqrt(Pe * Rec) : Infinity;
      const vX = Xmax > 0 ? eg * Xmax / Math.max(1e-9, out.xRaw[i]) : Infinity;
      const base = out.splRaw[i] - 20 * Math.log10(eg);
      out.maxTh.push(isFinite(vTh) ? base + 20 * Math.log10(vTh) : NaN);
      out.maxX.push(isFinite(vX) ? base + 20 * Math.log10(vX) : NaN);
      out.maxSpl.push(base + 20 * Math.log10(Math.min(vTh, vX)));
    }
    out.Pe = Pe; out.Xmax = Xmax; out.n = n; out.Re = Rec; out.eg = eg;
    R = out;
    const e1 = +Math.sqrt(Rec).toFixed(4);   // reference drive: 1 W into Re
    if (!design.ref1W) { shiftTarget(20 * Math.log10(e1 / eg)); design.ref1W = true; }   // older designs kept the target at their own voltage
    if (e1 !== eg) { scaleR(e1 / eg); design.eg = e1; }
    refreshSide();
    if (['step', 'decay'].includes(tab)) scheduleTransient();
  }
  // ---- drive level: the model is linear, so a new power just rescales every response (no re-solve)
  const fmtW = (w) => w >= 1000 ? (+(w / 1000).toPrecision(w >= 10000 ? 3 : 2)) + ' kW' : w >= 10 ? Math.round(w) + ' W' : (+w.toPrecision(2)) + ' W';
  let pwrW = 1;   // SPL-tab power, view only: every stored result is at 1 W into Re
  const egAt = (W) => Math.sqrt(W * (R && R.Re ? R.Re : 8));
  const driveLabel = (W) => (R && R.Re ? `${fmtW(W)} (${egAt(W).toFixed(2)} V)` : `${design.eg} V`);
  const pdB = () => (tab === 'spl' ? 10 * Math.log10(pwrW) : 0);
  function shiftTarget(dB) { if (design.target && dB) design.target.pts = design.target.pts.map((q) => [q[0], +(q[1] + dB).toFixed(2)]); }
  /** the model is linear: a new drive voltage just rescales every response */
  function scaleR(k) {
    const dB = 20 * Math.log10(k);
    R.spl = R.spl.map((v) => v + dB); R.splRaw = R.splRaw.map((v) => v + dB); R.H = R.H.map((h) => HC.scl(h, k)); if (R.Hraw) R.Hraw = R.Hraw.map((h) => HC.scl(h, k)); if (R.velRaw) R.velRaw = R.velRaw.map((a) => a.map((v) => v * k));
    R.x = R.x.map((v) => v * k); R.xRaw = R.xRaw.map((v) => v * k); R.vel = R.vel.map((a) => a.map((v) => v * k)); R.eg *= k;
  }
  /** peak excursion as a fraction of Xmax (null without Xmax) */
  const overRatio = (k) => (R && R.Xmax ? R.x.map((v) => v * k / R.Xmax) : null);
  /** frequency runs where the cone passes Xmax, edges interpolated on the log axis */
  function overBands(f, r) {
    const out = []; let start = null;
    const cross = (i) => { const t = (1 - r[i - 1]) / ((r[i] - r[i - 1]) || 1e-9); return f[i - 1] * Math.pow(f[i] / f[i - 1], clamp(t, 0, 1)); };
    for (let i = 0; i < f.length; i++) {
      const o = r[i] > 1;
      if (o && start == null) start = i ? cross(i) : f[0];
      if (!o && start != null) { out.push([start, cross(i)]); start = null; }
    }
    if (start != null) out.push([start, f[f.length - 1]]);
    return out;
  }
  function powerStatus() {
    if (!R) return '';
    const W = pwrW, bits = [`${egAt(W).toFixed(1)} V into ${R.Re.toFixed(2)} Ω`];
    const r = overRatio(Math.sqrt(W));
    if (!r) bits.push(`<span style="color:${C.warn}">set the driver's Xmax to see over-excursion</span>`);
    else {
      const [f0, f1] = fRange(), runs = overBands(R.f, r).filter(([a, b]) => b >= f0 && a <= f1);
      const pk = Math.max(...r.filter((_, i) => R.f[i] >= f0 && R.f[i] <= f1));
      const hz = (v) => (v < 100 ? v.toFixed(0) : (+v.toPrecision(2)).toFixed(0));
      bits.push(runs.length ? `<span style="color:${C.bad}">over Xmax ${runs.map(([a, b]) => `${hz(Math.max(a, f0))}–${hz(Math.min(b, f1))}`).join(', ')} Hz · peak ${(pk * R.Xmax).toFixed(1)} mm (${pk.toFixed(1)}× Xmax)</span>`
        : `<span style="color:${C.ok || C.accent}">within Xmax · peak ${(pk * R.Xmax).toFixed(1)} of ${R.Xmax} mm</span>`);
    }
    if (R.Pe && W > R.Pe * 1.0001) bits.push(`<span style="color:${C.warn}">above the ${fmtW(R.Pe)} rating</span>`);
    return bits.join(' · ');
  }
  /** The low response hump: first local maximum above 20 Hz that is within 6 dB of the top of the curve (< 150 Hz). */
  function humpOf(f, spl) {
    const top = Math.max(...spl.filter((_, i) => f[i] > 20 && f[i] < 100));   // bass region only (upper horn peaks ignored)
    for (let i = 2; i < f.length - 2; i++) if (f[i] > 20 && f[i] < 150 && spl[i] > spl[i - 1] && spl[i] >= spl[i + 1] && spl[i] > top - 8) return { f: f[i], db: spl[i] };
    return null;
  }
  const TUNE_F = HC.logFreqs(15, 160, 160);
  /** The response peak nearest (on a log scale) to a predicted frequency, so tuning follows the same hump. */
  function peakNear(f, spl, fn) {
    let best = null;
    for (let i = 1; i < f.length - 1; i++) {
      if (f[i] < 16 || !(spl[i] > spl[i - 1] && spl[i] >= spl[i + 1])) continue;
      const d = Math.abs(Math.log(f[i] / fn));
      if (d < Math.log(1.7) && (!best || d < best.d)) best = { f: f[i], db: spl[i], d };
    }
    return best;
  }
  function humpFor(d, near) {
    try {
      const AA = HG.analyse(d, libFn); if (!AA.net || !AA.net.drivers.length) return null;
      const Pp = HC.prepare(AA.net), spl = TUNE_F.map((f) => 20 * Math.log10(HC.abs(HC.solveAt(Pp, f).pff) / 2e-5 + 1e-20));
      return near ? peakNear(TUNE_F, spl, near) : humpOf(TUNE_F, spl);
    } catch (e) { return null; }
  }
  /** Quantize a design in place: every board angle to a multiple of `deg`, every end to the `mm` grid,
   *  keeping joints joined. One weighted least-squares solve (angles, corner joints and T-joints are stiff
   *  constraints, original positions are soft), then rounding. Returns { moved, angErr, boards }. */
  function quantizeIn(d, mm = 1, deg = 5) {
    (d.arcs || []).forEach((g) => { for (const k of ['a', 'm', 'b']) g[k] = { x: Math.round(g[k].x / mm) * mm, y: Math.round(g[k].y / mm) * mm }; });   // curved boards: ends and bend on the grid
    const segs = [...d.panels.filter((q) => !q.arc), ...(d.boundaries || [])];
    const N = segs.length * 2, n = 2 * N; if (!segs.length) return { moved: 0, angErr: 0, boards: 0 };
    const P0 = []; segs.forEach((q) => P0.push([q.x1, q.y1], [q.x2, q.y2]));
    const M = Array.from({ length: n }, () => new Float64Array(n)), r = new Float64Array(n);
    const eq = (terms, b, w) => { for (const [i, a] of terms) { r[i] += w * a * b; for (const [j, c] of terms) M[i][j] += w * a * c; } };
    const STIFF = 1e4, tol = 0.75 * (d.t || 18) + 2;
    const th = segs.map((q) => { const a = Math.atan2(q.y2 - q.y1, q.x2 - q.x1) * 180 / Math.PI; return Math.round(a / deg) * deg * Math.PI / 180; });
    const nrm = (k) => [-Math.sin(th[k]), Math.cos(th[k])];
    P0.forEach(([x, y], k) => { eq([[2 * k, 1]], x, 1); eq([[2 * k + 1, 1]], y, 1); });          // stay close to where it was
    segs.forEach((q, k) => {                                                                        // board direction = snapped angle
      if (hyp(q.x2 - q.x1, q.y2 - q.y1) < 5) return;
      const [nx, ny] = nrm(k), a = 4 * k, b = 4 * k + 2;
      eq([[b, nx], [b + 1, ny], [a, -nx], [a + 1, -ny]], 0, STIFF);
    });
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {                                     // corner joints stay joined
      if ((i >> 1) === (j >> 1)) continue;
      const dx = P0[i][0] - P0[j][0], dy = P0[i][1] - P0[j][1];
      if (hyp(dx, dy) > tol) continue;
      const tiny = hyp(dx, dy) < 0.6;
      eq([[2 * i, 1], [2 * j, -1]], tiny ? 0 : dx, STIFF); eq([[2 * i + 1, 1], [2 * j + 1, -1]], tiny ? 0 : dy, STIFF);
    }
    for (let i = 0; i < N; i++) segs.forEach((q, k) => {                                              // T-joints stay on their board
      if ((i >> 1) === k) return;
      const [px, py] = P0[i], vx = q.x2 - q.x1, vy = q.y2 - q.y1, L2 = vx * vx + vy * vy; if (L2 < 25) return;
      const u = ((px - q.x1) * vx + (py - q.y1) * vy) / L2; if (u < 0.02 || u > 0.98) return;
      if (hyp(px - q.x1, py - q.y1) <= tol || hyp(px - q.x2, py - q.y2) <= tol) return;
      const [nx, ny] = nrm(k), off = nx * (px - q.x1) + ny * (py - q.y1);
      if (Math.abs(off) > tol) return;
      eq([[2 * i, nx], [2 * i + 1, ny], [4 * k, -nx], [4 * k + 1, -ny]], off, STIFF);
    });
    // Gaussian elimination with partial pivoting
    for (let c = 0; c < n; c++) {
      let pv = c; for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[pv][c])) pv = i;
      if (pv !== c) { [M[c], M[pv]] = [M[pv], M[c]]; [r[c], r[pv]] = [r[pv], r[c]]; }
      const piv = M[c][c] || 1e-12;
      for (let i = c + 1; i < n; i++) { const f = M[i][c] / piv; if (!f) continue; for (let j = c; j < n; j++) M[i][j] -= f * M[c][j]; r[i] -= f * r[c]; }
    }
    const X = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) { let v = r[i]; for (let j = i + 1; j < n; j++) v -= M[i][j] * X[j]; X[i] = v / (M[i][i] || 1e-12); }
    const q = (v) => +(Math.round(v / mm) * mm).toFixed(3);
    let moved = 0, angErr = 0;
    segs.forEach((g, k) => {
      const x1 = q(X[4 * k]), y1 = q(X[4 * k + 1]), x2 = q(X[4 * k + 2]), y2 = q(X[4 * k + 3]);
      moved = Math.max(moved, hyp(x1 - g.x1, y1 - g.y1), hyp(x2 - g.x2, y2 - g.y2));
      Object.assign(g, { x1, y1, x2, y2 });
      if (hyp(x2 - x1, y2 - y1) >= 5) { let e = Math.abs(Math.atan2(y2 - y1, x2 - x1) - th[k]) * 180 / Math.PI; e = Math.min(e, Math.abs(360 - e)); angErr = Math.max(angErr, e); }
    });
    // polish: nudge each joint corner (all ends sitting on it move together) by at most one step to land angles closer
    const errOf = (k) => { const g = segs[k]; if (hyp(g.x2 - g.x1, g.y2 - g.y1) < 5) return 0; let e = Math.abs(Math.atan2(g.y2 - g.y1, g.x2 - g.x1) - th[k]) * 180 / Math.PI; return Math.min(e, Math.abs(360 - e)); };
    const groups = new Map(); segs.forEach((g, k) => { for (const e of [1, 2]) { const key = g['x' + e] + ',' + g['y' + e]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push([g, e, k]); } });
    for (const list of groups.values()) list.base = [list[0][0]['x' + list[0][1]], list[0][0]['y' + list[0][1]]];
    for (let pass = 0; pass < 4; pass++) for (const list of groups.values()) {
      const ks = [...new Set(list.map((z) => z[2]))], cost = () => ks.reduce((a, k) => a + errOf(k) ** 2, 0);
      const set = (x, y) => list.forEach(([g, e]) => { g['x' + e] = x; g['y' + e] = y; });
      const [bx, by] = list.base, cx0 = list[0][0]['x' + list[0][1]], cy0 = list[0][0]['y' + list[0][1]];
      let best = [cx0, cy0], bc = cost() - 1e-9;
      for (const dx of [-mm, 0, mm]) for (const dy of [-mm, 0, mm]) {
        const x = q(bx + dx), y = q(by + dy); set(x, y); const c = cost(); if (c < bc) { bc = c; best = [x, y]; }
      }
      set(best[0], best[1]);
    }
    angErr = 0; segs.forEach((g, k) => { angErr = Math.max(angErr, errOf(k)); });
    for (const pth of d.paths || []) if (!pth.auto) pth.pts = pth.pts.map((v) => ({ x: q(v.x), y: q(v.y) }));
    return { moved, angErr, boards: segs.length };
  }
  function quantizeBuild(mm, deg) {
    commit();
    const res = quantizeIn(design, mm, deg);
    changed();
    flash(`Quantized ${res.boards} boards to ${mm} mm / ${deg}°: biggest move ${res.moved.toFixed(1)} mm, angles within ${res.angErr.toFixed(2)}° of the ${deg}° steps (mm rounding). Ctrl+Z undoes it.`);
    return res;
  }
  function scaledCopy(k) {
    const d = JSON.parse(JSON.stringify(design));
    let x0 = Infinity, y0 = Infinity; for (const p of d.panels) { x0 = Math.min(x0, p.x1, p.x2); y0 = Math.min(y0, p.y1, p.y2); }
    const S = (x, y) => [x0 + (x - x0) * k, y0 + (y - y0) * k];
    for (const p of d.panels) { [p.x1, p.y1] = S(p.x1, p.y1); [p.x2, p.y2] = S(p.x2, p.y2); }
    for (const b of d.boundaries) { [b.x1, b.y1] = S(b.x1, b.y1); [b.x2, b.y2] = S(b.x2, b.y2); }
    for (const g of d.arcs || []) for (const k of ['a', 'm', 'b']) { const [x, y] = S(g[k].x, g[k].y); g[k] = { x, y }; }
    for (const q of d.drivers) { [q.x, q.y] = S(q.x, q.y); }
    for (const pa of d.paths) pa.pts = pa.pts.map((v) => { const [x, y] = S(v.x, v.y); return { x, y }; });
    if (d.autoPaths) { const found = HG.autoPaths(d); const manual = d.paths.filter((q) => !q.auto); d.paths = [...manual, ...found.map((a, i) => ({ id: 9000 + i, name: String.fromCharCode(65 + i), pts: a.pts, loss: 1, auto: true }))]; }
    return d;
  }
  /** Resize the whole side view (boards, drivers, paths; board thickness and width unchanged) until the hump
   *  lands on the target. Longer folds = lower hump. */
  function tuneHump(target) {
    const h0 = R && humpOf(R.f, R.splRaw);
    if (!h0) { flash('No response hump found to tune.'); return; }
    // the hump frequency goes roughly as 1 / size: aim directly, then correct, always tracking the SAME peak
    let best = null, k = clamp(h0.f / target, 0.6, 1.6);
    for (let it = 0; it < 6; it++) {
      const h = humpFor(scaledCopy(k), h0.f / k);
      if (!h) break;
      if (!best || Math.abs(h.f - target) < Math.abs(best.h.f - target)) best = { k, h };
      if (Math.abs(h.f - target) < 0.3) break;
      k = clamp(k * h.f / target, 0.6, 1.6);
    }
    HG.computeJoints(design);   // the trial copies used the same board ids
    if (!best) { flash('Could not tune this design by resizing.'); draw(); return; }
    commit();
    const d = scaledCopy(best.k);
    design.panels = d.panels; design.arcs = d.arcs || []; design.boundaries = d.boundaries; design.paths = d.paths; design.drivers = d.drivers;
    design.drivers.forEach((q) => { if (q.mount === null) delete q.mount; });
    fit(); changed();
    const sz = HG.summary(design, A);
    flash(`Resized ×${best.k.toFixed(3)}: hump ${h0.f.toFixed(1)} → ${best.h.f.toFixed(1)} Hz. Outside now ${fmtL(sz.D)} deep × ${fmtL(sz.H)} high (width unchanged).`);
  }
  // ======================= virtual tuning: target curve + auto-tune re-design =======================
  // design.target = { pts: [[f, dB], ...], keepSize: bool, level: bool }  (dB values are absolute SPL @ 2.83 V)
  function targetAt(f) {
    const P = design.target && design.target.pts; if (!P || P.length < 2) return NaN;
    const q = P.slice().sort((a, b) => a[0] - b[0]);
    if (f <= q[0][0]) return q[0][1];
    if (f >= q[q.length - 1][0]) return q[q.length - 1][1];
    for (let i = 1; i < q.length; i++) if (f <= q[i][0]) { const t = Math.log(f / q[i - 1][0]) / Math.log(q[i][0] / q[i - 1][0]); return q[i - 1][1] + t * (q[i][1] - q[i - 1][1]); }
    return NaN;
  }
  /** Shape-only mode: the target is drawn shifted onto the response (best-fit level), so shapes compare directly. */
  function targetOffset() {
    if (!design.target || design.target.level || !R) return 0;
    const [lo, hi] = targetBand(); let s2 = 0, n = 0;
    R.f.forEach((x, i) => { if (x >= lo && x <= hi) { s2 += R.splRaw[i] - targetAt(x); n++; } });
    return n ? s2 / n : 0;
  }
  function targetBand() { const q = design.target.pts.map((p) => p[0]); return [Math.min(...q), Math.max(...q)]; }
  function targetFromCurrent() {
    if (!R) return;
    const lv = (f) => { const i = R.f.findIndex((x) => x >= f); const a = Math.max(0, i - 3), b = Math.min(R.f.length - 1, i + 3); let s2 = 0; for (let j = a; j <= b; j++) s2 += R.splRaw[j]; return s2 / (b - a + 1); };
    design.target = Object.assign({ keepSize: true, level: false }, design.target || {}, { pts: [25, 32, 40, 50, 63, 80, 100, 125].map((f) => [f, +lv(f).toFixed(1)]) });
  }
  function targetFlat() {
    if (!R) return;
    const band = R.f.map((v, i) => [v, R.splRaw[i]]).filter(([v]) => v >= 40 && v <= 120).map((b) => b[1]).sort((a, b) => a - b);
    const ref = +band[Math.floor(band.length / 2)].toFixed(1);
    design.target = Object.assign({ keepSize: true, level: false }, design.target || {}, { pts: [[30, ref], [40, ref], [60, ref], [80, ref], [100, ref]] });
  }
  /** RMS dB miss between a response and the target over the target's band (shape only: the level offset is free). */
  function targetError(f, spl) {
    const [lo, hi] = targetBand(); const e = [];
    f.forEach((x, i) => { if (x >= lo && x <= hi) e.push(spl[i] - targetAt(x)); });
    if (!e.length) return NaN;
    const off = design.target.level ? 0 : e.reduce((a, b) => a + b, 0) / e.length;
    return Math.sqrt(e.reduce((a, b) => a + (b - off) * (b - off), 0) / e.length);
  }
  // --- pure edits on a design copy (same rules as the editor: joints stay joined, drivers ride on their baffle)
  function slideBoardIn(d, pid, dist) {
    if (!dist) return;
    const P = d.panels.find((q) => q.id === pid); if (!P) return;
    const L = hyp(P.x2 - P.x1, P.y2 - P.y1) || 1, ux = (P.x2 - P.x1) / L, uy = (P.y2 - P.y1) / L, nx = -uy, ny = ux, tP = P.t || d.t, tol = 3;
    const moves = [];
    for (const Q of d.panels) {
      if (Q === P) continue;
      for (const end of [1, 2]) {
        const ex = end === 1 ? Q.x1 : Q.x2, ey = end === 1 ? Q.y1 : Q.y2, ox = end === 1 ? Q.x2 : Q.x1, oy = end === 1 ? Q.y2 : Q.y1;
        const along = (ex - P.x1) * ux + (ey - P.y1) * uy, across = (ex - P.x1) * nx + (ey - P.y1) * ny, tQ = Q.t || d.t;
        if (along < -tQ / 2 - tol || along > L + tQ / 2 + tol || Math.abs(across) > tP / 2 + tol) continue;
        const ql = hyp(ex - ox, ey - oy) || 1, qx = (ex - ox) / ql, qy = (ey - oy) / ql, dot = qx * nx + qy * ny;
        moves.push([Q, end, Math.abs(dot) < 0.15 ? nx * dist : qx * dist / dot, Math.abs(dot) < 0.15 ? ny * dist : qy * dist / dot]);
      }
    }
    // own ends that butt into other boards slide along them
    const endFix = [];
    for (const end of [1, 2]) {
      const ex = end === 1 ? P.x1 : P.x2, ey = end === 1 ? P.y1 : P.y2;
      for (const B of d.panels) {
        if (B === P) continue;
        const Bl = hyp(B.x2 - B.x1, B.y2 - B.y1) || 1, bux = (B.x2 - B.x1) / Bl, buy = (B.y2 - B.y1) / Bl, bnx = -buy, bny = bux;
        const al = (ex - B.x1) * bux + (ey - B.y1) * buy, ac = (ex - B.x1) * bnx + (ey - B.y1) * bny;
        if (al < -tol || al > Bl + tol || Math.abs(ac) > (B.t || d.t) / 2 + tol) continue;
        if (Math.abs(ux * bnx + uy * bny) < 0.15) continue;
        endFix.push({ end, bx: B.x1, by: B.y1, bnx, bny, off: ac }); break;
      }
    }
    const bx0 = P.x1 + nx * dist, by0 = P.y1 + ny * dist;
    const endPt = (end) => {
      const e = endFix.find((q) => q.end === end);
      if (!e) return end === 1 ? [P.x1 + nx * dist, P.y1 + ny * dist] : [P.x2 + nx * dist, P.y2 + ny * dist];
      const t = (e.off - ((bx0 - e.bx) * e.bnx + (by0 - e.by) * e.bny)) / (ux * e.bnx + uy * e.bny);
      return [bx0 + ux * t, by0 + uy * t];
    };
    const [a1, b1] = endPt(1), [a2, b2] = endPt(2);
    for (const [Q, end, mx, my] of moves) { if (end === 1) { Q.x1 += mx; Q.y1 += my; } else { Q.x2 += mx; Q.y2 += my; } }
    P.x1 = a1; P.y1 = b1; P.x2 = a2; P.y2 = b2;
  }
  function syncDriversIn(d) {
    for (const q of d.drivers) {
      if (!q.mount) continue; const p = d.panels.find((r) => r.id === q.mount.pid); if (!p) continue;
      const L = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1, nx = -(p.y2 - p.y1) / L, ny = (p.x2 - p.x1) / L;
      q.x = p.x1 + (p.x2 - p.x1) * q.mount.f; q.y = p.y1 + (p.y2 - p.y1) * q.mount.f; q.nx = nx * q.mount.side; q.ny = ny * q.mount.side;
    }
  }
  function regenPathsIn(d) {
    if (!d.autoPaths) return;
    const manual = d.paths.filter((q) => !q.auto);
    d.paths = [...manual, ...HG.autoPaths(d).map((a, i) => ({ id: 9000 + i, name: String.fromCharCode(65 + manual.length + i), pts: a.pts, loss: 1, auto: true }))];
  }
  let tuneJob = null;
  var tdrag = null;
  function autoTune() {
    if (tuneJob) return;
    if (!design.target || design.target.pts.length < 2) { flash('Set a target curve first (From current or Flat), then drag its handles.'); return; }
    if (!design.drivers.length) { flash('Mount a driver first.'); return; }
    design.drivers.forEach((q) => { if (q.mount === undefined) mountDriver(q); });
    const keepSize = design.target.keepSize !== false;
    const shell = new Set(['top', 'bottom', 'back', 'front']);
    const base = JSON.parse(JSON.stringify(design));
    const params = [];
    for (const p of design.panels) if (!p.arc && !(keepSize && shell.has(roleOf(p)))) params.push({ kind: 'slide', id: p.id, v: 0, step: 24, lo: -260, hi: 260 });
    for (const q of design.drivers) if (q.mount) params.push({ kind: 'drv', id: q.id, v: q.mount.f, step: 0.08, lo: 0.08, hi: 0.92 });
    if (!keepSize) params.push({ kind: 'scale', v: 0, step: 0.05, lo: -0.35, hi: 0.45 });
    const [lo, hi] = targetBand();
    const fr = HC.logFreqs(lo, hi, 34);
    const build = (x) => {
      const d = JSON.parse(JSON.stringify(base));
      const sc = x.find((q) => q.kind === 'scale');
      if (sc && sc.v) {
        const k = Math.exp(sc.v); let x0 = Infinity, y0 = Infinity; d.panels.forEach((p) => { x0 = Math.min(x0, p.x1, p.x2); y0 = Math.min(y0, p.y1, p.y2); });
        d.panels.forEach((p) => { p.x1 = x0 + (p.x1 - x0) * k; p.x2 = x0 + (p.x2 - x0) * k; p.y1 = y0 + (p.y1 - y0) * k; p.y2 = y0 + (p.y2 - y0) * k; });
        (d.arcs || []).forEach((g) => { for (const kk of ['a', 'm', 'b']) g[kk] = { x: x0 + (g[kk].x - x0) * k, y: y0 + (g[kk].y - y0) * k }; });
        d.boundaries.forEach((p) => { p.x1 = x0 + (p.x1 - x0) * k; p.x2 = x0 + (p.x2 - x0) * k; p.y1 = y0 + (p.y1 - y0) * k; p.y2 = y0 + (p.y2 - y0) * k; });
        d.paths.forEach((pa) => { pa.pts = pa.pts.map((v) => ({ x: x0 + (v.x - x0) * k, y: y0 + (v.y - y0) * k })); });
      }
      for (const q of x) if (q.kind === 'slide') slideBoardIn(d, q.id, q.v);
      for (const q of x) if (q.kind === 'drv') { const dr = d.drivers.find((r) => r.id === q.id); if (dr && dr.mount) dr.mount.f = q.v; }
      syncDriversIn(d); regenPathsIn(d);
      return d;
    };
    const cost = (d) => {
      let pen = 0;
      for (const p of d.panels) if (hyp(p.x2 - p.x1, p.y2 - p.y1) < 2 * (p.t || d.t)) pen += 20;
      let AA;
      try { AA = HG.analyse(d, libFn); } catch (e) { return { c: 1e9 }; }
      if (!AA.net || !AA.net.drivers.length) return { c: 1e9 };
      pen += 4 * AA.warnings.length;
      if (d.autoPaths && base.paths.length && !AA.paths.length) pen += 60;
      for (const q of d.drivers) if (driverHits(q, d.panels, d.drivers)) pen += 15;
      const Pp = HC.prepare(AA.net);
      const spl = fr.map((f) => 20 * Math.log10(HC.abs(HC.solveAt(Pp, f).pff) / 2e-5 + 1e-20));
      const err = targetError(fr, spl);
      return { c: err + pen, err, pen };
    };
    commit();
    const x = params.map((q) => ({ ...q }));
    let cur = cost(build(x)); const start = cur;
    tuneJob = { stop: false, evals: 1, best: cur, start, x };
    let order = [], oi = 0, improved = false, shown = 0;
    const MAX = 420, t0 = performance.now();
    const status = () => { const el = $('tuneStatus'); if (el) el.textContent = `Trying designs… ${tuneJob.evals} tried · target miss ${isFinite(start.err) ? start.err.toFixed(2) : '–'} → ${isFinite(cur.err) ? cur.err.toFixed(2) : '–'} dB${cur.pen ? ' (+penalties)' : ''}`; };
    const show = () => { const d = build(x); design.panels = d.panels; design.arcs = d.arcs || []; design.boundaries = d.boundaries; design.paths = d.paths; design.drivers = d.drivers; changed(); shown = tuneJob.evals; };
    const finish = (why) => {
      HG.computeJoints(design);
      show();
      const msg = `Auto-tune ${why}: target miss ${start.err.toFixed(2)} → ${cur.err.toFixed(2)} dB RMS after ${tuneJob.evals} designs (${((performance.now() - t0) / 1000).toFixed(0)} s). Undo reverts it.`;
      tuneJob = null; refreshLegend(); flash(msg); const el = $('tuneStatus'); if (el) el.textContent = msg;
    };
    const step = () => {
      if (!tuneJob) return;
      if (tuneJob.stop) return finish('stopped');
      const tEnd = performance.now() + 60;
      while (performance.now() < tEnd) {
        if (oi >= order.length) {                       // new pass: random order; shrink steps after a pass with no gain
          if (order.length && !improved) { let any = false; x.forEach((q) => { q.step /= 2; if ((q.kind === 'slide' && q.step >= 2) || (q.kind !== 'slide' && q.step >= 0.006)) any = true; }); if (!any) return finish('converged'); }
          order = x.map((_, i) => i).sort(() => Math.random() - 0.5); oi = 0; improved = false;
        }
        const q = x[order[oi++]];
        for (const sg of [1, -1]) {
          const old = q.v, nv = clamp(old + sg * q.step, q.lo, q.hi);
          if (nv === old) continue;
          q.v = nv; const c2 = cost(build(x)); tuneJob.evals++;
          if (c2.c < cur.c - 1e-3) { cur = c2; improved = true; break; }
          q.v = old;
        }
        if (tuneJob.evals >= MAX) return finish('finished');
      }
      status();
      if (tuneJob.evals - shown > 30) show();
      setTimeout(step, 0);
    };
    refreshLegend(); status(); setTimeout(step, 30);
  }
  function groupDelay(f, H) {
    const ph = H.map((h) => Math.atan2(h.i, h.r));
    for (let i = 1; i < ph.length; i++) { let d = ph[i] - ph[i - 1]; while (d > Math.PI) { ph[i] -= 2 * Math.PI; d -= 2 * Math.PI; } while (d < -Math.PI) { ph[i] += 2 * Math.PI; d += 2 * Math.PI; } }
    return f.map((_, i) => { const a = Math.max(0, i - 1), b = Math.min(f.length - 1, i + 1); return -(ph[b] - ph[a]) / (2 * Math.PI * (f[b] - f[a])) * 1000; });
  }

  // transient (linear grid + IFFT), computed in slices so the UI stays live
  function fft(re, im, invFlag) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = 2 * Math.PI / len * (invFlag ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (invFlag) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  let tTimer = null;
  function scheduleTransient() {
    clearTimeout(tTimer);
    if (!A || !A.net || !A.net.drivers.length) return;
    const myGen = gen;
    tTimer = setTimeout(() => {
      const N = 8192, fs = 4096, df = fs / N, half = N / 2, fTop = 1200;
      const Pp = HC.prepare(A.net);
      const Hre = new Float64Array(N), Him = new Float64Array(N);
      let k = 1;
      const step = () => {
        if (myGen !== gen) return;
        const end = Math.min(half, k + 300);
        for (; k < end; k++) {
          const f = k * df;
          if (f > fTop) break;
          const s = HC.solveAt(Pp, f);
          let p = HC.mul(s.pff, xoverH(f));
          const taper = f > 800 ? 0.5 * (1 + Math.cos(Math.PI * (f - 800) / (fTop - 800))) : 1;
          Hre[k] = p.r * taper; Him[k] = p.i * taper;
        }
        if (k < half && k * df <= fTop) { setTimeout(step, 0); return; }
        for (let i = 1; i < half; i++) { Hre[N - i] = Hre[i]; Him[N - i] = -Him[i]; }
        const re = Float64Array.from(Hre), im = Float64Array.from(Him);
        fft(re, im, true);
        const ir = Array.from(re);
        const stp = []; let acc = 0; for (const v of ir) { acc += v; stp.push(acc); }
        T = { fs, N, ir, step: stp };
        T.csd = computeCSD(ir, fs);
        drawChart(); refreshLegend();
      };
      step();
    }, 120);
  }
  function computeCSD(ir, fs) {
    const NF = 8192, slices = [], tStep = 0.002, nSl = 60, win = Math.round(0.4 * fs);
    let ref = 0;
    for (let s = 0; s < nSl; s++) {
      const t0 = Math.round(s * tStep * fs);
      const re = new Float64Array(NF), im = new Float64Array(NF);
      for (let i = 0; i < win && t0 + i < ir.length; i++) {
        const w = i > win * 0.7 ? 0.5 * (1 + Math.cos(Math.PI * (i - win * 0.7) / (win * 0.3))) : 1;
        re[i] = ir[t0 + i] * w;
      }
      fft(re, im, false);
      const mag = new Float64Array(NF / 2);
      for (let i = 0; i < NF / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
      if (s === 0) ref = Math.max(...mag.slice(1, Math.round(400 / (fs / NF))));
      slices.push(mag);
    }
    return { slices, ref, df: fs / NF, tStep };
  }

  // ---------------------------------------------------------------- tools / interaction state
  const TOOLS = [
    { id: 'select', key: 'V', name: 'Select & move', icon: '<path d="M5 3l12 8-5 1 3 6-2 1-3-6-4 4z" fill="currentColor"/>' },
    { id: 'panel', key: 'P', name: 'Panel (3/4" board)', icon: '<rect x="3" y="9" width="18" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>' },
    { id: 'arc', key: 'C', name: 'Curved board (bent ply)', icon: '<path d="M4 19 C5 9, 11 5, 20 5" fill="none" stroke="currentColor" stroke-width="3"/>' },
    { id: 'box', key: 'R', name: 'Box shell', icon: '<rect x="4" y="4" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3"/>' },
    { id: 'path', key: 'A', name: 'Air path', icon: '<path d="M4 18 C4 6, 12 6, 12 12 S 20 18, 20 6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/><path d="M17 7l3-2 1 4" fill="none" stroke="currentColor" stroke-width="2"/>' },
    { id: 'driver', key: 'D', name: 'Driver', icon: '<path d="M4 6h3l6 4v4l-6 4H4z M13 10h4v4h-4z" fill="none" stroke="currentColor" stroke-width="2"/>' },
    { id: 'boundary', key: 'B', name: 'Air divider (closes a chamber, no wood)', icon: '<path d="M4 20L20 4" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/>' },
  ];
  let tool = 'select', sel = [], hover = null, drag = null, draft = null, mouse = { x: 0, y: 0, wx: 0, wy: 0 }, snapInfo = null, align = 'center', spaceDown = false;
  const HINTS = {
    select: 'Drag a board end and the ends joined to it follow (Shift: that end only) · middle = move · between = slide sideways · right-click a corner (joint) or a driver (mounting) · Shift-drag box-selects · Del deletes',
    panel: 'Click-drag (or click, click) to draw a board · snaps to corners, faces and grid · X switches which face you draw · Shift frees the angle',
    arc: 'Click the start of the curved board, click its end, then move to bend it and click · drag its ends or the round middle handle later · Esc cancels',
    box: 'Drag the outside corners of the cabinet · four boards are placed inside that outline',
    path: 'Click through the middle of the air channel from the throat/closed end to the mouth · Enter or double-click to finish · Esc cancels',
    driver: 'Click on a board to mount a driver there · it faces the side you clicked · F flips it',
    boundary: 'Draw a line that seals off a chamber without adding wood (e.g. to split one volume into two)',
  };
  function setTool(t) { tool = t; draft = null; renderTools(); $('hint').textContent = HINTS[t]; draw(); }
  function renderTools() {
    const el = $('tools');
    el.innerHTML = TOOLS.map((t) => `<button class="${tool === t.id ? 'on' : ''}" data-tool="${t.id}" title="${t.name} (${t.key})" aria-label="${t.name}"><svg viewBox="0 0 24 24">${t.icon}</svg></button>`).join('') +
      '<hr><button data-act="fit" title="Zoom to fit (0)" aria-label="Zoom to fit"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>' +
      `<button data-act="autopath" class="${design && design.autoPaths ? 'on' : ''}" title="Find air paths automatically (${design && design.autoPaths ? 'on' : 'off'})" aria-label="Automatic air paths"><svg viewBox="0 0 24 24"><path d="M4 19c3-9 6-12 16-14" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/><path d="M15 15l2 2 4-5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="4" cy="19" r="2" fill="currentColor"/></svg></button>` +
      '<button data-act="center" title="Centre all paths in their channels" aria-label="Centre paths"><svg viewBox="0 0 24 24"><path d="M3 5h18M3 19h18M6 12h12" stroke="currentColor" stroke-width="2"/></svg></button>' +
      `<button data-act="help" class="helpbtn ${helpOpen ? 'on' : ''}" title="How to use it (?)" aria-label="Help" aria-expanded="${helpOpen}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.2 9.3a2.9 2.9 0 1 1 4.3 2.5c-.9.5-1.5 1.1-1.5 2.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.3" fill="currentColor"/></svg></button>`;
    el.querySelectorAll('[data-tool]').forEach((b) => b.onclick = () => setTool(b.dataset.tool));
    el.querySelector('[data-act=fit]').onclick = () => { fit(); draw(); };
    el.querySelector('[data-act=autopath]').onclick = () => { commit(); design.autoPaths = !design.autoPaths; design.autoMute = []; renderTools(); changed(); flash(design.autoPaths ? 'Air paths are found automatically from the boards.' : 'Automatic air paths off — draw paths with the path tool (A).'); };
    el.querySelector('[data-act=center]').onclick = () => { commit(); design.paths.forEach(centerPath); changed(); };
    el.querySelector('[data-act=help]').onclick = () => setHelp(!helpOpen);
  }
  // ---- help panel (slides out over the left of the drawing)
  let helpOpen = false;
  function setHelp(on) {
    helpOpen = !!on; $('helpPanel').hidden = !helpOpen; LS.set('shl.helpSeen', '1');
    const b = document.querySelector('#tools [data-act=help]'); if (b) { b.classList.toggle('on', helpOpen); b.setAttribute('aria-expanded', String(helpOpen)); }
    if (helpOpen) $('helpPanel').querySelector('.helpbody').scrollTop = 0;
  }

  // ---------------------------------------------------------------- snapping
  function quadsOf(exclude) {
    return design.panels.filter((p) => !exclude || !exclude.has(p.id)).map((p) => ({ p, q: HG.panelQuad(p, design.t) }));
  }
  function nearestOnSeg(px, py, a, b) {
    const ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
    let u = L2 ? ((px - a.x) * ex + (py - a.y) * ey) / L2 : 0; u = clamp(u, 0, 1);
    return { x: a.x + ex * u, y: a.y + ey * u, u };
  }
  function lineIntersect(p, d, a, b) { // line p + t d with segment a-b
    const ex = b.x - a.x, ey = b.y - a.y, den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-9) return null;
    const wx = a.x - p.x, wy = a.y - p.y, u = (wx * d.y - wy * d.x) / den;
    if (u < -1e-6 || u > 1 + 1e-6) return null;
    return { x: a.x + ex * u, y: a.y + ey * u };
  }
  function snap(wx, wy, opt = {}) {
    const tol = 11 / view.k, g = gridStep();
    const quads = quadsOf(opt.exclude);
    let best = null;
    const consider = (x, y, kind, pri) => { const d = hyp(x - wx, y - wy); if (d < tol && (!best || pri < best.pri || (pri === best.pri && d < best.d))) best = { x, y, kind, pri, d }; };
    if (!opt.noObjects) {
      for (const { p, q } of quads) { for (const c of q) consider(c.x, c.y, 'corner', 0); consider(p.x1, p.y1, 'end', 0); consider(p.x2, p.y2, 'end', 0); consider((p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2, 'mid', 1); }
      for (const b of design.boundaries) { consider(b.x1, b.y1, 'end', 0); consider(b.x2, b.y2, 'end', 0); }
    }
    if (best) return best;
    // orthogonal lock from an anchor
    let ortho = null;
    if (opt.from && !opt.free) {
      // a narrow magnetic band, not a wide cone: the cursor has to sit within ~5 screen px of the straight (0/45/90 deg)
      // line AND within 2.5 deg of it, so a long board leaves the lock with a small sideways nudge (Alt turns it off)
      const dx = wx - opt.from.x, dy = wy - opt.from.y, ang = Math.atan2(dy, dx), st = Math.PI / 4;
      const a2 = Math.round(ang / st) * st, ux = Math.cos(a2), uy = Math.sin(a2);
      const off = Math.abs(dx * uy - dy * ux) * view.k;
      if (off < 5 && Math.abs(ang - a2) < 2.5 * Math.PI / 180) ortho = { x: ux, y: uy };
    }
    if (!opt.noObjects) {
      for (const { q } of quads) for (const [a, b] of HG.quadEdges(q)) {
        if (ortho) { const ip = lineIntersect(opt.from, ortho, a, b); if (ip) consider(ip.x, ip.y, 'face', 2); }
        const n = nearestOnSeg(wx, wy, a, b); consider(n.x, n.y, 'face', 3);
      }
    }
    if (best) return best;
    if (ortho) {
      const dx = wx - opt.from.x, dy = wy - opt.from.y; let L = dx * ortho.x + dy * ortho.y;
      L = Math.round(L / g) * g;
      return { x: opt.from.x + ortho.x * L, y: opt.from.y + ortho.y * L, kind: 'ortho' };
    }
    if (opt.from && !opt.noRound) {
      const dx = wx - opt.from.x, dy = wy - opt.from.y, L0 = hyp(dx, dy) || 1, L = Math.max(g, Math.round(L0 / g) * g);
      return { x: opt.from.x + dx / L0 * L, y: opt.from.y + dy / L0 * L, kind: 'length' };
    }
    return { x: Math.round(wx / g) * g, y: Math.round(wy / g) * g, kind: 'grid' };
  }

  // ---------------------------------------------------------------- hit testing
  function hit(wx, wy) {
    const tol = 8 / view.k;
    // handles of selected things first
    for (const s of sel) {
      if (s.t === 'arc') { const g = (design.arcs || []).find((q) => q.id === s.id); if (g) { const mm = arcMid(g); for (const [k, v] of [['a', g.a], ['b', g.b], ['m', mm]]) if (hyp(v.x - wx, v.y - wy) < tol * 1.3) return { t: 'arcpt', id: g.id, k }; } }
      if (s.t === 'panel') { const p = design.panels.find((q) => q.id === s.id); if (!p) continue; if (hyp(p.x1 - wx, p.y1 - wy) < tol) return { t: 'pend', id: p.id, end: 1 }; if (hyp(p.x2 - wx, p.y2 - wy) < tol) return { t: 'pend', id: p.id, end: 2 }; }
      if (s.t === 'boundary') { const p = design.boundaries.find((q) => q.id === s.id); if (!p) continue; if (hyp(p.x1 - wx, p.y1 - wy) < tol) return { t: 'bend', id: p.id, end: 1 }; if (hyp(p.x2 - wx, p.y2 - wy) < tol) return { t: 'bend', id: p.id, end: 2 }; }
    }
    for (const p of design.paths) for (let i = 0; i < p.pts.length; i++) if (hyp(p.pts[i].x - wx, p.pts[i].y - wy) < tol) return { t: 'vert', id: p.id, i };
    { // board / divider ends anywhere near the pointer (nearest wins, so the right end of a corner gets picked)
      let best = null;
      for (const g of design.arcs || []) for (const k of ['a', 'b']) { const d = hyp(g[k].x - wx, g[k].y - wy); if (d < tol && (!best || d < best.d)) best = { t: 'arcpt', id: g.id, k, d }; }
      for (const [t, list] of [['pend', design.panels.filter((q) => !q.arc)], ['bend', design.boundaries]]) for (const p of list) for (const end of [1, 2]) {
        const d = hyp((end === 1 ? p.x1 : p.x2) - wx, (end === 1 ? p.y1 : p.y2) - wy);
        if (d < tol && (!best || d < best.d)) best = { t, id: p.id, end, zone: 'end', d };
      }
      if (best) { delete best.d; return best; }
    }
    // the wood itself always grabs the board (so a baffle can be moved even where its woofer is drawn);
    // a driver is grabbed by its cone, basket or magnet, off the board
    const onWood = design.panels.some((p) => HG.pointInQuad(HG.panelQuad({ ...p, t: (p.t || design.t) + 2 / view.k }, design.t), wx, wy));
    if (!onWood) for (const d of design.drivers) {
      if (hyp(d.x - wx, d.y - wy) < Math.max(tol * 2, 30)) return { t: 'driver', id: d.id };
      // anywhere on the drawn driver body (cone, basket, magnet) grabs it too
      const loc = driverLocal(d);
      if (loc.outline ? inPoly(driverWorld(d, loc.outline), wx, wy) : [loc.flange, loc.basket, loc.magnet, loc.cone].some((a) => HG.pointInQuad(driverWorld(d, a), wx, wy))) return { t: 'driver', id: d.id };
    }
    for (const p of design.paths) for (let i = 1; i < p.pts.length; i++) { const n = nearestOnSeg(wx, wy, p.pts[i - 1], p.pts[i]); if (hyp(n.x - wx, n.y - wy) < tol * 0.8) return { t: 'path', id: p.id, seg: i }; }
    for (const b of design.boundaries) { const n = nearestOnSeg(wx, wy, { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }); if (hyp(n.x - wx, n.y - wy) < tol) return { t: 'boundary', id: b.id }; }
    for (let i = design.panels.length - 1; i >= 0; i--) {
      const p = design.panels[i]; const q = HG.panelQuad({ ...p, t: (p.t || design.t) + 6 / view.k }, design.t);
      if (!HG.pointInQuad(q, wx, wy)) continue;
      if (p.arc) return { t: 'arc', id: p.arc };
      // zones along the board: ends (free end move), centre 35–65 % (free move), the rest (slide perpendicular)
      const L = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1, u = ((wx - p.x1) * (p.x2 - p.x1) + (wy - p.y1) * (p.y2 - p.y1)) / (L * L);
      const Lpx = L * view.k, endPx = Math.min(Lpx * 0.15, 40);
      if (u * Lpx <= Math.max(endPx, 8)) return { t: 'pend', id: p.id, end: 1, zone: 'end' };
      if ((1 - u) * Lpx <= Math.max(endPx, 8)) return { t: 'pend', id: p.id, end: 2, zone: 'end' };
      if (Lpx < 60 || (u >= 0.35 && u <= 0.65)) return { t: 'panel', id: p.id, zone: 'center' };
      return { t: 'panel', id: p.id, zone: 'perp', u };
    }
    return null;
  }
  const isSel = (t, id) => sel.some((s) => s.t === t && s.id === id);

  // ---------------------------------------------------------------- path centring
  function centerPath(p) {
    const quads = design.panels.map((q) => HG.panelQuad(q, design.t));
    const walls = []; quads.forEach((q) => walls.push(...HG.quadEdges(q)));
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < p.pts.length; i++) {
        const a = p.pts[Math.max(0, i - 1)], b = p.pts[i], c = p.pts[Math.min(p.pts.length - 1, i + 1)];
        let tx, ty;
        if (i === 0) { tx = c.x - b.x; ty = c.y - b.y; } else if (i === p.pts.length - 1) { tx = b.x - a.x; ty = b.y - a.y; }
        else { const l1 = hyp(b.x - a.x, b.y - a.y) || 1, l2 = hyp(c.x - b.x, c.y - b.y) || 1; tx = (b.x - a.x) / l1 + (c.x - b.x) / l2; ty = (b.y - a.y) / l1 + (c.y - b.y) / l2; }
        const tl = hyp(tx, ty) || 1; tx /= tl; ty /= tl;
        const nx = -ty, ny = tx;
        if (quads.some((q) => HG.pointInQuad(q, b.x, b.y))) continue;
        const dl = HG.castRay(walls, b.x, b.y, nx, ny), dr = HG.castRay(walls, b.x, b.y, -nx, -ny);
        if (isFinite(dl) && isFinite(dr) && dl < 4000 && dr < 4000) { const sh = (dl - dr) / 2; b.x += nx * sh; b.y += ny * sh; b.x = Math.round(b.x * 10) / 10; b.y = Math.round(b.y * 10) / 10; }
      }
    }
  }

  // ---------------------------------------------------------------- pointer handling
  function pt(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('pointerdown', (e) => {
    try { cv.setPointerCapture(e.pointerId); } catch (err) { }
    const [sx, sy] = pt(e), [wx, wy] = s2w(sx, sy);
    mouse = { x: sx, y: sy, wx, wy };
    closeCtx();
    if (e.button === 1 || e.button === 2 || spaceDown) { drag = { kind: 'pan', sx, sy, tx: view.tx, ty: view.ty, click: true, button: e.button }; return; }
    if (tool === 'select') {
      const h = hit(wx, wy);
      if (!h) {
        if (e.shiftKey) drag = { kind: 'marquee', wx, wy, x2: wx, y2: wy };
        else { sel = []; drag = { kind: 'pan', sx, sy, tx: view.tx, ty: view.ty, click: true }; refreshSide(); }
        draw(); return;
      }
      commit();
      if (h.t === 'arcpt') { sel = [{ t: 'arc', id: h.id }]; drag = { kind: 'arcpt', id: h.id, k: h.k }; refreshSide(); draw(); return; }
      if (h.t === 'arc') { sel = [{ t: 'arc', id: h.id }]; const g = design.arcs.find((q) => q.id === h.id); drag = { kind: 'arcmove', id: h.id, wx, wy, orig: JSON.parse(JSON.stringify(g)), moved: false }; refreshSide(); draw(); return; }
      if (h.t === 'pend' || h.t === 'bend') {
        const st = h.t === 'pend' ? 'panel' : 'boundary';
        if (!isSel(st, h.id)) { sel = [{ t: st, id: h.id }]; refreshSide(); }
        const arr0 = h.t === 'pend' ? design.panels : design.boundaries, p0 = arr0.find((q) => q.id === h.id);
        const ex = h.end === 1 ? p0.x1 : p0.x2, ey = h.end === 1 ? p0.y1 : p0.y2;
        drag = { kind: h.t, id: h.id, end: h.end, ex, ey, joints: jointEnds(h.t, h.id, h.end) }; return;
      }
      if (h.t === 'panel' && h.zone === 'perp') { sel = [{ t: 'panel', id: h.id }]; drag = startPerp(h.id, wx, wy); refreshSide(); draw(); return; }
      if (h.t === 'vert') { sel = [{ t: 'path', id: h.id }]; drag = { kind: 'vert', id: h.id, i: h.i }; refreshSide(); return; }
      if (h.t === 'driver') { if (!isSel('driver', h.id)) sel = e.shiftKey ? [...sel, { t: 'driver', id: h.id }] : [{ t: 'driver', id: h.id }]; const dd = design.drivers.find((q) => q.id === h.id), gl = hyp(dd.nx, dd.ny) || 1;
        const along = ((wx - dd.x) * dd.nx + (wy - dd.y) * dd.ny) / gl;           // + = in front of the cone
        const snap0 = { x: dd.x, y: dd.y, nx: dd.nx, ny: dd.ny, mount: dd.mount ? { ...dd.mount } : dd.mount };
        drag = { kind: 'driver', id: h.id, rel: along > 0 ? -1 : 1, flipped: false, good: snap0, bad: null }; refreshSide(); return; }
      const t = h.t;
      if (!isSel(t, h.id)) sel = e.shiftKey ? [...sel, { t, id: h.id }] : [{ t, id: h.id }];
      drag = { kind: 'move', wx, wy, orig: JSON.parse(JSON.stringify({ panels: design.panels, paths: design.paths, drivers: design.drivers, boundaries: design.boundaries })), moved: false };
      refreshSide(); draw(); return;
    }
    if (tool === 'panel' || tool === 'boundary') {
      const s = snap(wx, wy);
      if (!draft) draft = { kind: tool, x1: s.x, y1: s.y, x2: s.x, y2: s.y, down: true };
      else { finishLine(); }
      draw(); return;
    }
    if (tool === 'arc') {
      if (!draft) { const s = snap(wx, wy); draft = { kind: 'arc', stage: 1, a: { x: s.x, y: s.y }, b: { x: s.x, y: s.y } }; }
      else if (draft.stage === 1) { if (hyp(draft.b.x - draft.a.x, draft.b.y - draft.a.y) * view.k > 10) { draft.stage = 2; draft.m = { x: (draft.a.x + draft.b.x) / 2, y: (draft.a.y + draft.b.y) / 2 }; } }
      else {
        commit(); const g = { id: nid(), a: draft.a, m: draft.m, b: draft.b }; (design.arcs = design.arcs || []).push(g);
        draft = null; sel = [{ t: 'arc', id: g.id }]; changed();
        const G = arcGeom(g); flash(G.c ? `Curved board: radius ${fmtL(G.c.r)}, ${(Math.abs(G.sweep) * 180 / Math.PI).toFixed(0)}° — drag its ends or the round middle handle to reshape it.` : 'That came out straight — drag the round middle handle sideways to bend it.');
      }
      draw(); return;
    }
    if (tool === 'box') { const s = snap(wx, wy, { noObjects: true }); draft = { kind: 'box', x1: s.x, y1: s.y, x2: s.x, y2: s.y }; return; }
    if (tool === 'path') {
      const s = snap(wx, wy, { noObjects: true, from: draft && draft.pts[draft.pts.length - 1], free: e.shiftKey });
      if (!draft) draft = { kind: 'path', pts: [{ x: s.x, y: s.y }] };
      else {
        const last = draft.pts[draft.pts.length - 1];
        if (hyp(last.x - s.x, last.y - s.y) < 3 / view.k) { finishPath(); return; }
        draft.pts.push({ x: s.x, y: s.y });
      }
      draw(); return;
    }
    if (tool === 'driver') { placeDriver(wx, wy); return; }
  });
  cv.addEventListener('pointermove', (e) => {
    const [sx, sy] = pt(e), [wx, wy] = s2w(sx, sy);
    mouse = { x: sx, y: sy, wx, wy };
    if (drag) {
      if (drag.kind === 'pan') { view.tx = drag.tx + sx - drag.sx; view.ty = drag.ty + sy - drag.sy; if (hyp(sx - drag.sx, sy - drag.sy) > 3) drag.click = false; draw(); return; }
      if (drag.kind === 'marquee') { drag.x2 = wx; drag.y2 = wy; draw(); return; }
      if (drag.kind === 'pend' || drag.kind === 'bend') {
        const arr = drag.kind === 'pend' ? design.panels : design.boundaries;
        const p = arr.find((q) => q.id === drag.id);
        const other = drag.end === 1 ? { x: p.x2, y: p.y2 } : { x: p.x1, y: p.y1 };
        // ends joined at this corner move together; holding Shift pulls this end loose on its own
        const together = !e.shiftKey && drag.joints.length;
        const excl = new Set([p.id, ...(together ? drag.joints.filter((j) => j.kind === 'pend').map((j) => j.id) : [])]);
        const s = snap(wx, wy, { from: other, exclude: excl, free: e.altKey });
        if (drag.end === 1) { p.x1 = r2(s.x); p.y1 = r2(s.y); } else { p.x2 = r2(s.x); p.y2 = r2(s.y); }
        const dx = together ? s.x - drag.ex : 0, dy = together ? s.y - drag.ey : 0;
        for (const j of drag.joints) {
          const q = (j.kind === 'pend' ? design.panels : design.boundaries).find((r) => r.id === j.id); if (!q) continue;
          if (j.end === 1) { q.x1 = r2(j.x + dx); q.y1 = r2(j.y + dy); } else { q.x2 = r2(j.x + dx); q.y2 = r2(j.y + dy); }
        }
        drag.loose = !!(e.shiftKey && drag.joints.length);
        snapInfo = s; liveChanged(); return;
      }
      if (drag.kind === 'arcpt') {
        const g = design.arcs.find((q) => q.id === drag.id); if (!g) return;
        if (drag.k === 'm') {   // bend handle: the arc passes through the cursor
          const s = snap(wx, wy, { noObjects: true }); g.m = { x: rr2(s.x), y: rr2(s.y) };
        } else {
          const excl = new Set(design.panels.filter((q) => q.arc === g.id).map((q) => q.id));
          const mid0 = arcMid(g), s = snap(wx, wy, { exclude: excl, from: drag.k === 'a' ? g.b : g.a, free: e.altKey });
          g[drag.k] = { x: rr2(s.x), y: rr2(s.y) }; g.m = mid0; snapInfo = s;   // ends move, the bend stays put
        }
        liveChanged(); return;
      }
      if (drag.kind === 'arcmove') {
        const g = design.arcs.find((q) => q.id === drag.id); if (!g) return;
        const gs = gridStep(); let dx = Math.round((wx - drag.wx) / gs) * gs, dy = Math.round((wy - drag.wy) / gs) * gs;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        for (const k of ['a', 'm', 'b']) g[k] = { x: drag.orig[k].x + dx, y: drag.orig[k].y + dy };
        drag.moved = drag.moved || dx || dy; liveChanged(); return;
      }
      if (drag.kind === 'vert') {
        const p = design.paths.find((q) => q.id === drag.id);
        const prev = p.pts[drag.i - 1] || p.pts[drag.i + 1];
        const s = snap(wx, wy, { noObjects: true, from: prev, free: e.shiftKey });
        p.pts[drag.i] = { x: s.x, y: s.y }; p.auto = false; liveChanged(); return;
      }
      if (drag.kind === 'driver') {
        const d = design.drivers.find((q) => q.id === drag.id), before = Math.sign(d.nx * 1e3 + d.ny);
        moveDriverTo(d, wx, wy, true, drag.rel);
        drag.bad = driverHits(d);
        if (!drag.bad) drag.good = { x: d.x, y: d.y, nx: d.nx, ny: d.ny, mount: d.mount ? { ...d.mount } : d.mount };
        if (drag.bad) flash(`The driver would cut into ${partNames().get(drag.bad.id) || 'a board'} — let go and it returns to the last spot where it fits.`);
        else if (Math.sign(d.nx * 1e3 + d.ny) !== before) flash('Basket moved to the other side of the board — the cone now fires the other way.');
        liveChanged(); return;
      }
      if (drag.kind === 'perp') { applyPerp(drag, wx, wy); liveChanged(); return; }
      if (drag.kind === 'move') {
        const g = gridStep();
        let dx = Math.round((wx - drag.wx) / g) * g, dy = Math.round((wy - drag.wy) / g) * g;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        const o = drag.orig;
        for (const s of sel) {
          if (s.t === 'panel') { const p = design.panels.find((q) => q.id === s.id), q = o.panels.find((q) => q.id === s.id); if (p && q) { p.x1 = q.x1 + dx; p.x2 = q.x2 + dx; p.y1 = q.y1 + dy; p.y2 = q.y2 + dy; } }
          if (s.t === 'boundary') { const p = design.boundaries.find((q) => q.id === s.id), q = o.boundaries.find((q) => q.id === s.id); if (p && q) { p.x1 = q.x1 + dx; p.x2 = q.x2 + dx; p.y1 = q.y1 + dy; p.y2 = q.y2 + dy; } }
          if (s.t === 'path') { const p = design.paths.find((q) => q.id === s.id), q = o.paths.find((q) => q.id === s.id); if (p && q) { p.pts = q.pts.map((v) => ({ x: v.x + dx, y: v.y + dy })); if (dx || dy) p.auto = false; } }
          if (s.t === 'driver') { const p = design.drivers.find((q) => q.id === s.id), q = o.drivers.find((q) => q.id === s.id); if (p && q) { p.x = q.x + dx; p.y = q.y + dy; if (!sel.some((t) => t.t === 'panel' && p.mount && t.id === p.mount.pid)) mountDriver(p); } }
        }
        drag.moved = drag.moved || dx || dy;
        liveChanged(); return;
      }
    }
    if (draft) {
      if (draft.kind === 'panel' || draft.kind === 'boundary') { const s = snap(wx, wy, { from: { x: draft.x1, y: draft.y1 }, free: e.shiftKey }); draft.x2 = s.x; draft.y2 = s.y; snapInfo = s; draw(); return; }
      if (draft.kind === 'box') { const s = snap(wx, wy, { noObjects: true }); draft.x2 = s.x; draft.y2 = s.y; draw(); return; }
      if (draft.kind === 'arc') { if (draft.stage === 1) { const s = snap(wx, wy, { from: draft.a, free: e.shiftKey }); draft.b = { x: s.x, y: s.y }; snapInfo = s; } else { const s = snap(wx, wy, { noObjects: true }); draft.m = { x: s.x, y: s.y }; } draw(); return; }
      if (draft.kind === 'path') { const s = snap(wx, wy, { noObjects: true, from: draft.pts[draft.pts.length - 1], free: e.shiftKey }); draft.cur = s; draw(); return; }
    }
    if (tool === 'panel' || tool === 'boundary') snapInfo = snap(wx, wy); else snapInfo = null;
    const h = tool === 'select' ? hit(wx, wy) : null;
    hover = h; cv.style.cursor = cursorFor(h);
    draw();
  });
  cv.addEventListener('pointerup', (e) => {
    if (drag) {
      if (drag.kind === 'marquee') {
        const x0 = Math.min(drag.wx, drag.x2), x1 = Math.max(drag.wx, drag.x2), y0 = Math.min(drag.wy, drag.y2), y1 = Math.max(drag.wy, drag.y2);
        const inside = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
        sel = [];
        design.panels.forEach((p) => { if (inside(p.x1, p.y1) && inside(p.x2, p.y2)) sel.push({ t: 'panel', id: p.id }); });
        design.boundaries.forEach((p) => { if (inside(p.x1, p.y1) && inside(p.x2, p.y2)) sel.push({ t: 'boundary', id: p.id }); });
        design.paths.forEach((p) => { if (p.pts.every((q) => inside(q.x, q.y))) sel.push({ t: 'path', id: p.id }); });
        design.drivers.forEach((p) => { if (inside(p.x, p.y)) sel.push({ t: 'driver', id: p.id }); });
        refreshSide();
      } else if (drag.kind === 'move' && !drag.moved) { undo.pop(); }
      else if (drag.kind === 'arcmove' && !drag.moved) { undo.pop(); }
      else if (drag.kind === 'arcpt' || drag.kind === 'arcmove') { changed(); }
      else if (drag.kind === 'perp' && !drag.moved) { undo.pop(); }
      else if (drag.kind === 'driver' && drag.bad) {
        const d = design.drivers.find((q) => q.id === drag.id);
        if (d && drag.good) Object.assign(d, drag.good);
        drag = null; changed(); flash('Moved back to the last position where the driver fits.'); return;
      }
      else if (drag.kind === 'pan' && drag.button === 2 && drag.click) { const [sx, sy] = pt(e); drag = null; openJointMenu(sx, sy); return; }
      else if (drag.kind === 'driver' || drag.kind === 'move' || drag.kind === 'pend' || drag.kind === 'vert' || drag.kind === 'bend' || drag.kind === 'perp') { if (drag.kind === 'vert' && design.autoCenter) { /* keep manual position */ } changed(); }
      drag = null; snapInfo = null; draw(); return;
    }
    if (draft && (draft.kind === 'panel' || draft.kind === 'boundary') && draft.down) {
      draft.down = false;
      if (hyp(draft.x2 - draft.x1, draft.y2 - draft.y1) > 4 / view.k) finishLine();
      draw(); return;
    }
    if (draft && draft.kind === 'box') {
      const x0 = Math.min(draft.x1, draft.x2), x1 = Math.max(draft.x1, draft.x2), y0 = Math.min(draft.y1, draft.y2), y1 = Math.max(draft.y1, draft.y2);
      draft = null;
      if (x1 - x0 > 3 * design.t && y1 - y0 > 3 * design.t) {
        commit(); const t = design.t, h = t / 2;
        const add = (a, b, c, d) => design.panels.push({ id: nid(), x1: a, y1: b, x2: c, y2: d });
        add(x0, y0 + h, x1, y0 + h); add(x0, y1 - h, x1, y1 - h); add(x0 + h, y0 + t, x0 + h, y1 - t); add(x1 - h, y0 + t, x1 - h, y1 - t);
        changed();
      }
      draw();
    }
  });
  cv.addEventListener('dblclick', (e) => {
    const [sx, sy] = pt(e), [wx, wy] = s2w(sx, sy);
    if (tool === 'path' && draft) { finishPath(); return; }
    if (tool === 'select') {
      const h = hit(wx, wy);
      if (h && h.t === 'path') { commit(); const p = design.paths.find((q) => q.id === h.id); const n = nearestOnSeg(wx, wy, p.pts[h.seg - 1], p.pts[h.seg]); p.pts.splice(h.seg, 0, { x: Math.round(n.x), y: Math.round(n.y) }); changed(); }
    }
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [sx, sy] = pt(e), [wx, wy] = s2w(sx, sy);
    const f = Math.exp(-e.deltaY * 0.0015);
    view.k = clamp(view.k * f, 0.03, 20);
    view.tx = sx - MX() * wx * view.k; view.ty = sy + wy * view.k;
    draw();
  }, { passive: false });

  function finishLine() {
    const d = draft; draft = null;
    if (hyp(d.x2 - d.x1, d.y2 - d.y1) < 5) return;
    commit();
    if (d.kind === 'boundary') { design.boundaries.push({ id: nid(), x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 }); changed(); return; }
    let { x1, y1, x2, y2 } = d;
    if (align !== 'center') { // drawn line is a face: shift centre-line by t/2 to the chosen side
      const L = hyp(x2 - x1, y2 - y1), nx = -(y2 - y1) / L, ny = (x2 - x1) / L, s = (align === 'left' ? 1 : -1) * design.t / 2;
      x1 += nx * s; x2 += nx * s; y1 += ny * s; y2 += ny * s;
    }
    const p = { id: nid(), x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2) };
    design.panels.push(p); sel = [{ t: 'panel', id: p.id }]; changed();
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  function finishPath() {
    const d = draft; draft = null;
    if (!d || d.pts.length < 2) { draw(); return; }
    commit();
    const p = { id: nid(), name: nextPathName(), pts: d.pts, loss: 1 };
    if (design.autoCenter) centerPath(p);
    design.paths.push(p); sel = [{ t: 'path', id: p.id }]; changed();
  }
  function nearestPanel(wx, wy) {
    let best = null;
    for (const p of design.panels) { const n = nearestOnSeg(wx, wy, { x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }); const d = hyp(n.x - wx, n.y - wy); if (!best || d < best.d) best = { p, n, d }; }
    return best;
  }
  // rel: when dragging, +1 if the pointer holds the basket side, -1 if it holds the cone side. Pulling the pointer
  // clearly across the board puts the basket (and magnet) on that side, flipping which way the cone fires.
  function moveDriverTo(d, wx, wy, keepFacing, rel) {
    let b = nearestPanel(wx, wy); if (!b) { d.x = wx; d.y = wy; return; }
    // while dragging, stay on the current board unless the pointer is clearly nearer another one
    const own = rel && d.mount && design.panels.find((q) => q.id === d.mount.pid);
    if (own && b.p.id !== own.id) {
      const n = nearestOnSeg(wx, wy, { x: own.x1, y: own.y1 }, { x: own.x2, y: own.y2 }), dOwn = hyp(n.x - wx, n.y - wy);
      if (dOwn < 2.5 * b.d + (own.t || design.t) * 3) b = { p: own, n, d: dOwn };
    }
    const p = b.p, L = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1, nx = -(p.y2 - p.y1) / L, ny = (p.x2 - p.x1) / L;
    d.x = r1(b.n.x); d.y = r1(b.n.y);
    if (keepFacing) {
      const s = Math.sign(nx * d.nx + ny * d.ny) || 1; d.nx = nx * s; d.ny = ny * s;
      if (rel) {
        const sd = (wx - b.n.x) * nx + (wy - b.n.y) * ny;                     // pointer's side of the board
        if (Math.abs(sd) > (p.t || design.t) / 2 + 10 / view.k) { const basket = Math.sign(sd) * rel; d.nx = -nx * basket; d.ny = -ny * basket; }
      }
    }
    else { const s = Math.sign((wx - b.n.x) * nx + (wy - b.n.y) * ny) || 1; d.nx = nx * s; d.ny = ny * s; }
    mountDriver(d);
  }
  // A driver is attached to the board it sits on: {pid, f = fraction along the board, side = which face it fires from}.
  // Its position is re-derived from that board after every edit, so moving or re-sizing the baffle carries the driver.
  function mountDriver(d) {
    let best = null;
    for (const p of design.panels) { const n = nearestOnSeg(d.x, d.y, { x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }); const dd = hyp(n.x - d.x, n.y - d.y); if (!best || dd < best.d) best = { p, n, d: dd }; }
    if (!best || best.d > (best.p.t || design.t) * 0.75 + 2) { d.mount = null; return; }
    const p = best.p, L = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1, nx = -(p.y2 - p.y1) / L, ny = (p.x2 - p.x1) / L;
    d.mount = { pid: p.id, f: clamp(hyp(best.n.x - p.x1, best.n.y - p.y1) / L, 0, 1), side: Math.sign(nx * d.nx + ny * d.ny) || 1 };
  }
  function syncDrivers() {
    for (const d of design.drivers) {
      if (d.mount === undefined) mountDriver(d);           // older designs and presets: attach once
      if (!d.mount) continue;
      const p = design.panels.find((q) => q.id === d.mount.pid);
      if (!p) { d.mount = null; continue; }
      const L = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1, nx = -(p.y2 - p.y1) / L, ny = (p.x2 - p.x1) / L;
      d.x = Math.round((p.x1 + (p.x2 - p.x1) * d.mount.f) * 100) / 100; d.y = Math.round((p.y1 + (p.y2 - p.y1) * d.mount.f) * 100) / 100;
      d.nx = nx * d.mount.side; d.ny = ny * d.mount.side;
    }
  }
  function placeDriver(wx, wy) {
    const b = nearestPanel(wx, wy);
    if (!b || b.d > 120 / view.k + design.t) { flash('Click on (or next to) a board to mount the driver.'); return; }
    commit();
    const d = { id: nid(), x: 0, y: 0, nx: 1, ny: 0, key: design.driverKey, n: 1, wiring: 'parallel' };
    moveDriverTo(d, wx, wy, false);
    design.drivers.push(d); sel = [{ t: 'driver', id: d.id }]; changed();
  }

  // ---------------------------------------------------------------- joint menu (right-click a corner)
  let ctxEl = null;
  function closeCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
  function setMount(d, style) {
    commit(); const prev = d.mountStyle; d.mountStyle = style === 'rear' ? 'rear' : undefined;
    const hb = driverHits(d);
    if (hb) { d.mountStyle = prev; undo.pop(); flash(`That way it would cut into ${hitName(hb)}, so it was left as it was.`); refreshSide(); draw(); return; }
    changed();
  }
  function openDriverMenu(d, sx, sy) {
    closeCtx();
    const spec = specOf(d.key) || {}, rear = d.mountStyle === 'rear';
    const opts = [['front', 'Front mount · flange on the face the cone fires from', !rear], ['rear', 'Rear mount · fitted from inside, fires through the cutout', rear], ['flip', 'Basket to the other side of the board (F)', false]];
    ctxEl = document.createElement('div'); ctxEl.className = 'ctxmenu'; ctxEl.setAttribute('role', 'menu');
    ctxEl.innerHTML = `<div class="ctxhead">Driver · ${esc(spec.m || 'driver')}</div>` + opts.map(([v, t, on]) => `<button role="menuitemradio" aria-checked="${on}" data-v="${v}">${v === 'flip' ? '⇅ ' : on ? '● ' : '○ '}${esc(t)}</button>`).join('');
    $('board').appendChild(ctxEl);
    const bw = $('board').clientWidth, bh = $('board').clientHeight;
    ctxEl.style.left = Math.min(sx + 6, bw - ctxEl.offsetWidth - 8) + 'px'; ctxEl.style.top = Math.min(sy + 6, bh - ctxEl.offsetHeight - 8) + 'px';
    ctxEl.querySelectorAll('button').forEach((b) => b.onclick = () => {
      closeCtx();
      if (b.dataset.v === 'flip') {
        commit(); d.nx = -d.nx; d.ny = -d.ny; if (d.mount) d.mount.side = -d.mount.side;
        const hb = driverHits(d); if (hb) { undo.pop(); d.nx = -d.nx; d.ny = -d.ny; if (d.mount) d.mount.side = -d.mount.side; flash(`Flipped, it would cut into ${hitName(hb)}, so it was left as it was.`); draw(); return; }
        changed(); return;
      }
      setMount(d, b.dataset.v);
    });
  }
  function openJointMenu(sx, sy) {
    closeCtx();
    { const [wx, wy] = s2w(sx, sy), h = hit(wx, wy); if (h && h.t === 'driver') { const d = design.drivers.find((q) => q.id === h.id); if (d) { sel = [{ t: 'driver', id: d.id }]; refreshSide(); openDriverMenu(d, sx, sy); return; } } }
    const joints = (A && A.joints) || [];
    let best = null;
    const [wx0, wy0] = s2w(sx, sy);
    for (const j of joints) {
      const [x, y] = w2s(j.x, j.y), d = hyp(x - sx, y - sy), dw = hyp(j.x - wx0, j.y - wy0);
      if ((d < 22 || dw < 1.5 * design.t) && (!best || d < best.d)) best = { j, d };
    }
    if (!best) { flash('Right-click on a corner where two boards meet to choose how they join.'); return; }
    const j = best.j, names = partNames();
    const na = names.get(j.a.id) || 'Board', nb = names.get(j.b.id) || 'Board';
    const autoWho = j.tee ? nb : j.type === 'auto' ? names.get(+j.resolved.split(':')[1]) : null;
    let autoTxt = autoWho;
    if (!autoTxt) { // what auto would pick, for the label
      const tmp = { ...design, joints: { ...(design.joints || {}) } }; delete tmp.joints[j.key];
      const r = HG.computeJoints(tmp).find((q) => q.key === j.key); HG.computeJoints(design);
      autoTxt = r ? names.get(+r.resolved.split(':')[1]) : '?';
    }
    const opts = j.tee ? [
      ['auto', `Auto · end cut flush to ${nb}`],
      ['square', 'Square end'],
    ] : [
      ['auto', `Auto · ${autoTxt} runs through`],
      ['through:' + j.a.id, `${na} runs through, ${nb} butts`],
      ['through:' + j.b.id, `${nb} runs through, ${na} butts`],
      ['butt:' + j.a.id, `${nb} butts onto ${na} (${na} keeps a square end)`],
      ['butt:' + j.b.id, `${na} butts onto ${nb} (${nb} keeps a square end)`],
      ['miter', 'Miter (both cut on the bisector)'],
      ['square', 'Square ends (boards overlap)'],
    ];
    ctxEl = document.createElement('div'); ctxEl.className = 'ctxmenu'; ctxEl.setAttribute('role', 'menu');
    ctxEl.innerHTML = `<div class="ctxhead">Joint · ${esc(na)} + ${esc(nb)}</div>` + opts.map(([v, t]) => `<button role="menuitemradio" aria-checked="${j.type === v}" data-v="${esc(v)}">${j.type === v ? '● ' : '○ '}${esc(t)}</button>`).join('');
    $('board').appendChild(ctxEl);
    const bw = $('board').clientWidth, bh = $('board').clientHeight;
    ctxEl.style.left = Math.min(sx + 6, bw - ctxEl.offsetWidth - 8) + 'px'; ctxEl.style.top = Math.min(sy + 6, bh - ctxEl.offsetHeight - 8) + 'px';
    ctxEl.querySelectorAll('button').forEach((b) => b.onclick = () => {
      commit(); design.joints = design.joints || {};
      if (b.dataset.v === 'auto') delete design.joints[j.key]; else design.joints[j.key] = b.dataset.v;
      closeCtx(); changed();
    });
    jointHi = j; draw();
  }
  let jointHi = null;
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
  document.addEventListener('pointerdown', (e) => { if (ctxEl && !ctxEl.contains(e.target) && e.target !== cv) { closeCtx(); draw(); } });

  // ---------------------------------------------------------------- corner joints
  /** Other board / divider ends that meet this end at a corner (centre-line ends within about half a board
   *  thickness: covers ends snapped to the same point, to a board's corner, or the box tool's lapped corners). */
  function jointEnds(kind, id, end) {
    const arr = kind === 'pend' ? design.panels : design.boundaries, p = arr.find((q) => q.id === id);
    if (!p) return [];
    const ex = end === 1 ? p.x1 : p.x2, ey = end === 1 ? p.y1 : p.y2;
    const tol = 0.75 * design.t + 4 / view.k;
    const out = [];
    for (const [k, list] of [['pend', design.panels], ['bend', design.boundaries]]) {
      for (const q of list) {
        if (k === kind && q.id === id) continue;
        for (const e2 of [1, 2]) {
          const x = e2 === 1 ? q.x1 : q.x2, y = e2 === 1 ? q.y1 : q.y2;
          if (hyp(x - ex, y - ey) <= tol) out.push({ kind: k, id: q.id, end: e2, x, y });
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- perpendicular slide (keeps joints connected)
  function startPerp(id, wx, wy) {
    const P = design.panels.find((q) => q.id === id);
    const L = hyp(P.x2 - P.x1, P.y2 - P.y1) || 1, ux = (P.x2 - P.x1) / L, uy = (P.y2 - P.y1) / L, nx = -uy, ny = ux;
    const tP = P.t || design.t, tol = 2 + 4 / view.k;
    const orig = JSON.parse(JSON.stringify({ panels: design.panels, drivers: design.drivers }));
    // other boards whose ends touch this one: they stretch along their own direction to stay joined
    const joined = [];
    for (const Q of design.panels) {
      if (Q.id === id) continue;
      for (const end of [1, 2]) {
        const ex = end === 1 ? Q.x1 : Q.x2, ey = end === 1 ? Q.y1 : Q.y2, ox = end === 1 ? Q.x2 : Q.x1, oy = end === 1 ? Q.y2 : Q.y1;
        const along = (ex - P.x1) * ux + (ey - P.y1) * uy, across = (ex - P.x1) * nx + (ey - P.y1) * ny;
        const tQ = Q.t || design.t;
        if (along < -tQ / 2 - tol || along > L + tQ / 2 + tol || Math.abs(across) > tP / 2 + tol) continue;
        const ql = hyp(ex - ox, ey - oy) || 1;
        joined.push({ id: Q.id, end, qx: (ex - ox) / ql, qy: (ey - oy) / ql });
      }
    }
    // this board's own ends that butt into other boards: they slide along those boards
    const ends = [];
    for (const end of [1, 2]) {
      const ex = end === 1 ? P.x1 : P.x2, ey = end === 1 ? P.y1 : P.y2;
      for (const B of design.panels) {
        if (B.id === id) continue;
        const q = HG.panelQuad({ ...B, t: (B.t || design.t) + 2 * tol }, design.t);
        const Bl = hyp(B.x2 - B.x1, B.y2 - B.y1) || 1, bux = (B.x2 - B.x1) / Bl, buy = (B.y2 - B.y1) / Bl;
        const ext = { x1: B.x1 - bux * tol, y1: B.y1 - buy * tol, x2: B.x2 + bux * tol, y2: B.y2 + buy * tol, t: (B.t || design.t) + 2 * tol };
        if (!HG.pointInQuad(HG.panelQuad(ext, design.t), ex, ey) && !HG.pointInQuad(q, ex, ey)) continue;
        const bnx = -buy, bny = bux;
        if (Math.abs(ux * bnx + uy * bny) < 0.15) continue; // running parallel: nothing to slide along
        ends.push({ end, bx: B.x1, by: B.y1, bnx, bny, off: (ex - B.x1) * bnx + (ey - B.y1) * bny });
        break;
      }
    }
    const drivers = design.drivers.filter((d) => HG.project([{ x: P.x1, y: P.y1 }, { x: P.x2, y: P.y2 }], d.x, d.y).d < tP * 0.75).map((d) => d.id);
    return { kind: 'perp', id, wx, wy, nx, ny, ux, uy, orig, joined, ends, drivers, moved: false, d: 0 };
  }
  function applyPerp(dr, wx, wy) {
    const g = gridStep();
    const d = Math.round(((wx - dr.wx) * dr.nx + (wy - dr.wy) * dr.ny) / g) * g;
    dr.d = d; dr.moved = dr.moved || d !== 0;
    const O = dr.orig, P = design.panels.find((q) => q.id === dr.id), P0 = O.panels.find((q) => q.id === dr.id);
    const sx = dr.nx * d, sy = dr.ny * d;
    // shift the whole board, then keep any end that butts into another board on that board's face
    const bx0 = P0.x1 + sx, by0 = P0.y1 + sy;
    const endPt = (end) => {
      const e = dr.ends.find((q) => q.end === end);
      if (!e) return end === 1 ? [P0.x1 + sx, P0.y1 + sy] : [P0.x2 + sx, P0.y2 + sy];
      const t = (e.off - ((bx0 - e.bx) * e.bnx + (by0 - e.by) * e.bny)) / (dr.ux * e.bnx + dr.uy * e.bny);
      return [bx0 + dr.ux * t, by0 + dr.uy * t];
    };
    const [ax, ay] = endPt(1), [cx2, cy2] = endPt(2);
    P.x1 = r2(ax); P.y1 = r2(ay); P.x2 = r2(cx2); P.y2 = r2(cy2);
    for (const j of dr.joined) { // boards joined to this one stretch along their own direction
      const Q = design.panels.find((q) => q.id === j.id), Q0 = O.panels.find((q) => q.id === j.id);
      const dot = j.qx * dr.nx + j.qy * dr.ny;
      let mx, my;
      if (Math.abs(dot) < 0.15) { mx = sx; my = sy; } else { const lam = d / dot; mx = j.qx * lam; my = j.qy * lam; }
      if (j.end === 1) { Q.x1 = r2(Q0.x1 + mx); Q.y1 = r2(Q0.y1 + my); } else { Q.x2 = r2(Q0.x2 + mx); Q.y2 = r2(Q0.y2 + my); }
    }
    for (const id of dr.drivers) { const D = design.drivers.find((q) => q.id === id), D0 = O.drivers.find((q) => q.id === id); D.x = r2(D0.x + sx); D.y = r2(D0.y + sy); }
  }
  function cursorFor(h) {
    if (!h) return tool === 'select' ? 'default' : 'crosshair';
    if (h.t === 'panel' && h.zone === 'perp') {
      const p = design.panels.find((q) => q.id === h.id); const L = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1;
      // board normal on screen (y flipped), folded to 0..180°
      let a = Math.atan2((p.x2 - p.x1) / L * -1, MX() * -(p.y2 - p.y1) / L) * 180 / Math.PI; // screen angle of (nx, -ny)
      a = ((a % 180) + 180) % 180;
      return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize';
    }
    if (h.t === 'pend' || h.t === 'bend' || h.t === 'vert') return 'crosshair';
    if (h.t === 'driver') return 'grab';
    return 'move';
  }

  // ---------------------------------------------------------------- keyboard
  window.addEventListener('keydown', (e) => {
    if (/input|select|textarea/i.test(document.activeElement.tagName)) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'd') { e.preventDefault(); duplicate(); return; }
    if (k === ' ') { spaceDown = true; return; }
    if (k === '?') { setHelp(!helpOpen); return; }
    if (k === '/') { e.preventDefault(); $('drvSearch').focus(); return; }
    if (k === 'Escape' && helpOpen) { setHelp(false); return; }
    if (k === 'Escape') { draft = null; drag = null; if (tool !== 'select') setTool('select'); else { sel = []; refreshSide(); } draw(); return; }
    if (k === 'Enter' && draft && draft.kind === 'path') { finishPath(); return; }
    if (k === 'Delete' || k === 'Backspace') { deleteSel(); return; }
    if (k === '0') { fit(); draw(); return; }
    if (k.toLowerCase() === 'x' && tool === 'panel') { align = align === 'center' ? 'left' : align === 'left' ? 'right' : 'center'; flash('Drawing ' + (align === 'center' ? 'the board centre-line' : `the ${align} face of the board`)); draw(); return; }
    if (k.toLowerCase() === 'f') { const ds = sel.filter((s) => s.t === 'driver'); if (ds.length) { commit(); ds.forEach((s) => { const d = design.drivers.find((q) => q.id === s.id); d.nx = -d.nx; d.ny = -d.ny; if (d.mount) d.mount.side = -d.mount.side; }); changed(); } return; }
    if (k.startsWith('Arrow') && sel.length) {
      e.preventDefault(); commit(); const st = e.shiftKey ? 10 : 1; const dx = k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0, dy = k === 'ArrowDown' ? -st : k === 'ArrowUp' ? st : 0;
      for (const s of sel) {
        if (s.t === 'panel' || s.t === 'boundary') { const p = (s.t === 'panel' ? design.panels : design.boundaries).find((q) => q.id === s.id); p.x1 += dx; p.x2 += dx; p.y1 += dy; p.y2 += dy; }
        if (s.t === 'path') design.paths.find((q) => q.id === s.id).pts.forEach((v) => { v.x += dx; v.y += dy; });
        if (s.t === 'driver') { const d = design.drivers.find((q) => q.id === s.id); d.x += dx; d.y += dy; if (!sel.some((t) => t.t === 'panel' && d.mount && t.id === d.mount.pid)) mountDriver(d); }
      }
      changed(); return;
    }
    const t = TOOLS.find((t) => t.key === k.toUpperCase());
    if (t && !e.ctrlKey && !e.metaKey) setTool(t.id);
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });
  function deleteSel() {
    if (!sel.length) return; commit();
    for (const s of sel) {
      if (s.t === 'panel') design.panels = design.panels.filter((p) => p.id !== s.id);
      if (s.t === 'arc') { design.arcs = (design.arcs || []).filter((g) => g.id !== s.id); design.panels = design.panels.filter((p) => p.arc !== s.id); }
      if (s.t === 'boundary') design.boundaries = design.boundaries.filter((p) => p.id !== s.id);
      if (s.t === 'path') { const gone = design.paths.find((p) => p.id === s.id); if (gone && gone.auto && gone.opening) (design.autoMute = design.autoMute || []).push(gone.opening); design.paths = design.paths.filter((p) => p.id !== s.id); }
      if (s.t === 'driver') design.drivers = design.drivers.filter((p) => p.id !== s.id);
    }
    sel = []; changed();
  }
  function duplicate() {
    if (!sel.length) return; commit(); const off = 50, ns = [];
    for (const s of sel) {
      if (s.t === 'panel') { const p = { ...design.panels.find((q) => q.id === s.id), id: nid() }; p.x1 += off; p.x2 += off; design.panels.push(p); ns.push({ t: 'panel', id: p.id }); }
      if (s.t === 'path') { const o = design.paths.find((q) => q.id === s.id); const p = { ...o, id: nid(), name: nextPathName(), pts: o.pts.map((v) => ({ x: v.x + off, y: v.y })) }; design.paths.push(p); ns.push({ t: 'path', id: p.id }); }
      if (s.t === 'driver') { const p = { ...design.drivers.find((q) => q.id === s.id), id: nid() }; p.x += off; design.drivers.push(p); ns.push({ t: 'driver', id: p.id }); }
    }
    sel = ns; changed();
  }

  // ---------------------------------------------------------------- change plumbing
  let saveTimer = null, liveRaf = 0;
  // Air paths found from the boards (HornGeom.autoPaths). Hand-drawn or hand-edited paths are never replaced.
  let lastAuto = 0;
  function regenAutoPaths() {
    try { HG.computeJoints(design); } catch (e) { }
    if (!design.autoPaths) return;
    lastAuto = performance.now();
    let found = [];
    try { found = HG.autoPaths(design); } catch (e) { console.error(e); return; }
    const manual = design.paths.filter((p) => !p.auto), old = design.paths.filter((p) => p.auto);
    const mute = design.autoMute || [];
    const endOf = (pts) => pts[pts.length - 1];
    const fresh = [];
    for (const a of found) {
      const e = endOf(a.pts);
      if (manual.some((m) => [m.pts[0], endOf(m.pts)].some((q) => hyp(q.x - e.x, q.y - e.y) < 120))) continue;
      if (mute.some((q) => hyp(q.x - a.opening.x, q.y - a.opening.y) < 120)) continue;
      let prev = null, bd = 250;
      for (const o of old) { const oe = endOf(o.pts), d = hyp(oe.x - e.x, oe.y - e.y); if (d < bd && !fresh.some((f) => f.id === o.id)) { bd = d; prev = o; } }
      const q = prev ? { ...prev, pts: a.pts, opening: a.opening } : { id: nid(), name: null, pts: a.pts, loss: 1, auto: true, opening: a.opening };
      fresh.push(q);
    }
    design.paths = [...manual, ...fresh];
    fresh.forEach((q) => { if (!q.name) q.name = nextPathName(); });
  }
  function changed() { syncArcsIn(design); syncDrivers(); regenAutoPaths(); analyse(); draw(); refreshSide(); clearTimeout(saveTimer); saveTimer = setTimeout(() => LS.set('shl.design', JSON.stringify(design)), 400); }
  function liveChanged() { if (liveRaf) return; liveRaf = requestAnimationFrame(() => { liveRaf = 0; syncArcsIn(design); syncDrivers(); if (design.autoPaths && performance.now() - lastAuto > 180 && !(drag && drag.kind === 'vert')) regenAutoPaths(); analyse(); draw(); }); }
  let flashTimer = null;
  function flash(msg) { const h = $('hint'); h.textContent = msg; h.style.color = 'var(--accent)'; clearTimeout(flashTimer); flashTimer = setTimeout(() => { h.style.color = ''; h.textContent = HINTS[tool]; }, 2600); }

  // ---------------------------------------------------------------- drawing the board
  let regionImg = null;
  function pathColor(i) { const hues = [C.air, '#8a5cc7', '#c27c0e', '#2b8a3e', '#c2255c']; return hues[i % hues.length]; }
  function buildRegionImg() {
    if (!A || !A.g) return null;
    const g = A.g, off = document.createElement('canvas'); off.width = g.nx; off.height = g.ny;
    const octx = off.getContext('2d'), img = octx.createImageData(g.nx, g.ny);
    const colOf = new Map();
    A.regions.forEach((r, l) => {
      if (!r) return;
      if (r.kind === 'chamber') colOf.set(l, r.unused ? [...rgbArr(C.muted), 34] : [...rgbArr(C.chamber), 46]);
      else { const pi = A.paths.findIndex((p) => p.label === l); colOf.set(l, [...rgbArr(pathColor(Math.max(0, pi))), 46]); }
    });
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
      const l = g.lab[j * g.nx + i]; const c = colOf.get(l); if (!c) continue;
      const o = ((g.ny - 1 - j) * g.nx + i) * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = c[3];
    }
    octx.putImageData(img, 0, 0);
    return off;
  }
  function draw() {
    const W = view.w, H = view.h;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    drawGrid();
    // air regions
    if (A && A.g) {
      if (!regionImg) regionImg = buildRegionImg();
      const g = A.g; const [sxa, sy] = w2s(g.x0, g.y0 + g.ny * g.c), [sxb] = w2s(g.x0 + g.nx * g.c, 0), sx = Math.min(sxa, sxb);
      ctx.imageSmoothingEnabled = view.k * g.c < 3;
      if (MX() < 0) { ctx.save(); ctx.translate(sx + g.nx * g.c * view.k, sy); ctx.scale(-1, 1); ctx.drawImage(regionImg, 0, 0, g.nx * g.c * view.k, g.ny * g.c * view.k); ctx.restore(); }
      else ctx.drawImage(regionImg, sx, sy, g.nx * g.c * view.k, g.ny * g.c * view.k);
    }
    // panels
    const mat = design.material === 'mdf' ? { f: C.mdf, e: C['mdf-edge'] } : { f: C.birch, e: C['birch-edge'] };
    for (const p of design.panels) {
      const q = HG.panelQuad(p, design.t);
      ctx.beginPath(); q.forEach((v, i) => { const [x, y] = w2s(v.x, v.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath();
      ctx.fillStyle = mat.f; ctx.fill();
      if (design.material !== 'mdf' && view.k * design.t > 14) { // ply layers
        ctx.save(); ctx.clip(); ctx.strokeStyle = C['birch-ply']; ctx.lineWidth = 0.6;
        const L = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1, nx = -(p.y2 - p.y1) / L, ny = (p.x2 - p.x1) / L, plies = 13;
        for (let k = 1; k < plies; k++) { const o = -design.t / 2 + design.t * k / plies; const [a, b] = w2s(p.x1 + nx * o, p.y1 + ny * o), [c, d] = w2s(p.x2 + nx * o, p.y2 + ny * o); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); }
        ctx.restore();
      }
      ctx.beginPath(); q.forEach((v, i) => { const [x, y] = w2s(v.x, v.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath();
      const s = isSel('panel', p.id), hv = hover && hover.t === 'panel' && hover.id === p.id;
      ctx.strokeStyle = s ? C.accent : hv ? C.ink : mat.e; ctx.lineWidth = s ? 2 : 1; ctx.stroke();
      if (s) { for (const [x, y] of [w2s(p.x1, p.y1), w2s(p.x2, p.y2)]) { ctx.fillStyle = C.raised; ctx.strokeStyle = C.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.stroke(); } }
    }
    // board labels: name when hovering a board's middle, length when hovering elsewhere on it, and live lengths of
    // every board being changed (dragged end + all boards joined there, a sideways slide, a slider)
    {
      const show = new Map(); // panel id -> 'name' | 'len'
      if (design.labelsAlways) design.panels.forEach((p) => show.set(p.id, 'name'));
      if (drag && (drag.kind === 'pend')) { show.set(drag.id, 'len'); (drag.joints || []).forEach((j) => { if (j.kind === 'pend' && !(drag.loose)) show.set(j.id, 'len'); }); }
      else if (drag && drag.kind === 'perp') { show.set(drag.id, 'len'); drag.joined.forEach((j) => show.set(j.id, 'len')); }
      else if (drag && drag.kind === 'move') sel.forEach((q) => { if (q.t === 'panel') show.set(q.id, 'len'); });
      else if (sliding) sel.forEach((q) => { if (q.t === 'panel') show.set(q.id, 'len'); });
      else if (!drag && tool === 'select' && hover) {
        if (hover.t === 'panel') show.set(hover.id, hover.zone === 'center' ? 'name' : 'len');
        if (hover.t === 'pend') { show.set(hover.id, 'len'); jointEnds('pend', hover.id, hover.end).forEach((j) => { if (j.kind === 'pend') show.set(j.id, 'len'); }); }
      }
      if (show.size) {
        const names = partNames();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const p of design.panels) {
          const what = show.get(p.id); if (!what) continue;
          const [a, b] = w2s(p.x1, p.y1), [c, d] = w2s(p.x2, p.y2);
          const isLen = what === 'len';
          const txt = isLen ? fmtL(hyp(p.x2 - p.x1, p.y2 - p.y1), isIn() ? 2 : undefined) : names.get(p.id);
          ctx.font = `600 ${isLen ? 11.5 : 10.5}px ${isLen ? C.mono : C.font}`;
          const tw = ctx.measureText(txt).width;
          let ang = Math.atan2(d - b, c - a); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
          const off = ((p.t || design.t) / 2) * view.k + 9, nx = Math.sin(ang), ny = -Math.cos(ang);
          ctx.save(); ctx.translate((a + c) / 2 + nx * off, (b + d) / 2 + ny * off); ctx.rotate(ang);
          ctx.fillStyle = rgba(C.raised, 0.92); ctx.strokeStyle = isLen ? C.accent : C.line; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-tw / 2 - 5, -8, tw + 10, 16, 4) : ctx.rect(-tw / 2 - 5, -8, tw + 10, 16); ctx.fill(); ctx.stroke();
          ctx.fillStyle = isLen ? C.accent : C.ink; ctx.fillText(txt, 0, 0.5); ctx.restore();
        }
        ctx.textBaseline = 'alphabetic';
      }
    }
    // boundaries
    for (const b of design.boundaries) {
      const [a, c] = w2s(b.x1, b.y1), [d, e] = w2s(b.x2, b.y2);
      ctx.setLineDash([6, 4]); ctx.strokeStyle = isSel('boundary', b.id) ? C.accent : C.chamber; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a, c); ctx.lineTo(d, e); ctx.stroke(); ctx.setLineDash([]);
    }
    // region labels
    if (A && A.regions) A.regions.forEach((r) => {
      if (!r || r.kind !== 'chamber' || r.unused) return;
      const [x, y] = w2s(r.cx, r.cy);
      tag(`${(r.Vnet || r.V).toFixed(1)} L${r.fb ? ` · fb ${r.fb.toFixed(0)} Hz` : ''}`, x, y, C.chamber, true);
    });
    // paths
    if (A && A.paths) A.paths.forEach((P, pi) => drawPath(P, pi));
    design.paths.forEach((p) => { if (!A || !A.paths || !A.paths.some((q) => q.src.id === p.id)) drawPolyline(p.pts, C.air, true); });
    // drivers
    for (const d of design.drivers) drawDriver(d);
    // selected curved boards: centre-line, end handles and the round bend handle
    for (const s0 of sel) if (s0.t === 'arc') { const g = (design.arcs || []).find((q) => q.id === s0.id); if (g) drawArcSel(g); }
    // draft
    if (draft) drawDraft();
    if (snapInfo && (tool === 'panel' || tool === 'boundary' || drag)) {
      const [x, y] = w2s(snapInfo.x, snapInfo.y); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5;
      if (snapInfo.kind === 'corner' || snapInfo.kind === 'end') ctx.strokeRect(x - 5, y - 5, 10, 10);
      else if (snapInfo.kind === 'face' || snapInfo.kind === 'mid') { ctx.beginPath(); ctx.moveTo(x - 6, y + 5); ctx.lineTo(x, y - 6); ctx.lineTo(x + 6, y + 5); ctx.closePath(); ctx.stroke(); }
      else { ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke(); }
    }
    // hover hints for the three grab zones on a board
    const hz = drag && drag.kind === 'perp' ? { t: 'panel', id: drag.id, zone: 'perp' } : (tool === 'select' && !drag ? hover : null);
    if (hz && hz.t === 'panel' && hz.zone === 'perp') {
      const p = design.panels.find((q) => q.id === hz.id);
      if (p) {
        const L = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1, nx = -(p.y2 - p.y1) / L, ny = (p.x2 - p.x1) / L;
        const pr = HG.project([{ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }], drag ? mouse.wx : mouse.wx, drag ? mouse.wy : mouse.wy);
        const [cx0, cy0] = w2s(pr.x, pr.y), vx = MX() * nx, vy = -ny, a = 22;
        ctx.strokeStyle = C.accent; ctx.fillStyle = C.accent; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx0 - vx * a, cy0 - vy * a); ctx.lineTo(cx0 + vx * a, cy0 + vy * a); ctx.stroke();
        for (const sg of [1, -1]) { const tx = cx0 + vx * a * sg, ty = cy0 + vy * a * sg; ctx.beginPath(); ctx.moveTo(tx + vx * 6 * sg, ty + vy * 6 * sg); ctx.lineTo(tx - vy * 5, ty + vx * 5); ctx.lineTo(tx + vy * 5, ty - vx * 5); ctx.closePath(); ctx.fill(); }
        if (drag && drag.kind === 'perp') tag(`${drag.d >= 0 ? '+' : '−'}${fmtL(Math.abs(drag.d))}${drag.joined.length ? ` · ${drag.joined.length} joined board${drag.joined.length > 1 ? 's' : ''} follow` : ''}`, cx0 + 26, cy0 - 26, C.accent);
      }
    }
    // end handles: the grabbed end, plus rings on every end joined to it (they move together unless Shift is held)
    const endHint = drag && (drag.kind === 'pend' || drag.kind === 'bend') ? { t: drag.kind, id: drag.id, end: drag.end, joints: drag.joints, loose: drag.loose } : (hz && (hz.t === 'pend' || hz.t === 'bend') ? { ...hz, joints: jointEnds(hz.t, hz.id, hz.end), loose: !!(window.event && window.event.shiftKey) } : null);
    if (endHint) {
      const p = (endHint.t === 'pend' ? design.panels : design.boundaries).find((q) => q.id === endHint.id);
      if (p) {
        const [x, y] = w2s(endHint.end === 1 ? p.x1 : p.x2, endHint.end === 1 ? p.y1 : p.y2);
        ctx.strokeStyle = C.accent; ctx.fillStyle = C.raised; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.stroke();
        for (const j of endHint.joints || []) {
          const q = (j.kind === 'pend' ? design.panels : design.boundaries).find((r) => r.id === j.id); if (!q) continue;
          const [jx, jy] = w2s(j.end === 1 ? q.x1 : q.x2, j.end === 1 ? q.y1 : q.y2);
          ctx.strokeStyle = endHint.loose ? C.muted : C.accent; ctx.lineWidth = 1.5; ctx.setLineDash(endHint.loose ? [2, 2] : []);
          ctx.beginPath(); ctx.arc(jx, jy, 9, 0, 7); ctx.stroke(); ctx.setLineDash([]);
        }
        if (drag && endHint.joints && endHint.joints.length) tag(endHint.loose ? 'Shift: this end only' : `moving ${endHint.joints.length + 1} joined ends`, x + 12, y - 16, endHint.loose ? C.muted : C.accent);
      }
    }
    if (ctxEl && jointHi) { const [x, y] = w2s(jointHi.x, jointHi.y); ctx.strokeStyle = C.accent; ctx.lineWidth = 2; ctx.setLineDash([3, 2]); ctx.beginPath(); ctx.arc(x, y, 12, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    if (drag && drag.kind === 'marquee') { const [a, b] = w2s(drag.wx, drag.wy), [c, d] = w2s(drag.x2, drag.y2); ctx.setLineDash([4, 3]); ctx.strokeStyle = C.accent; ctx.strokeRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b)); ctx.setLineDash([]); }
    drawOverallDims();
    drawScale();
    renderStatus();
  }
  function drawGrid() {
    const W = view.w, H = view.h;
    const u = unit();
    const steps = (u === 'in' ? [0.1, 0.5, 1, 6, 12, 48] : u === 'cm' ? [1, 5, 10, 50, 100] : [1, 5, 10, 50, 100, 500]).map((v) => v * UDIV[u]).filter((v) => v >= gridStep() - 1e-9);
    let minor = steps.find((s) => s * view.k >= 8) || steps[steps.length - 1];
    const major = steps.find((s) => s > minor * 1.01 && s * view.k >= 40) || minor * 10;
    const [xa, y1] = s2w(0, 0), [xb, y0] = s2w(W, H), x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
    for (const [step, col] of [[minor, C.grid], [major, C.grid2]]) {
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { const [sx] = w2s(x, 0); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, H); }
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) { const [, sy] = w2s(0, y); ctx.moveTo(0, Math.round(sy) + 0.5); ctx.lineTo(W, Math.round(sy) + 0.5); }
      ctx.stroke();
    }
  }
  /** Overall outside height (left of the cabinet, set out by 10 % of its width) and width (above it, set out by
   *  10 % of its height), in inches, plus the working unit when that is not inches. */
  function drawOverallDims() {
    if (!design.panels.length || design.hideDims) return;
    let wx0 = Infinity, wx1 = -Infinity, wy0 = Infinity, wy1 = -Infinity;
    for (const p of design.panels) for (const v of HG.panelQuad(p, design.t)) { wx0 = Math.min(wx0, v.x); wx1 = Math.max(wx1, v.x); wy0 = Math.min(wy0, v.y); wy1 = Math.max(wy1, v.y); }
    const H = wy1 - wy0, Wd = wx1 - wx0;
    const [sa] = w2s(wx0, 0), [sb] = w2s(wx1, 0), [, top] = w2s(0, wy1), [, bot] = w2s(0, wy0);
    const left = Math.min(sa, sb), right = Math.max(sa, sb);
    const txt = (mm) => `${(mm / 25.4).toFixed(2)}"` + (isIn() ? '' : `  (${fmtL(mm)})`);
    ctx.save();
    ctx.strokeStyle = C.muted; ctx.fillStyle = C.muted; ctx.lineWidth = 1;
    const arrow = (x, y, dx, dy) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dx * 7 - dy * 3, y - dy * 7 + dx * 3); ctx.lineTo(x - dx * 7 + dy * 3, y - dy * 7 - dx * 3); ctx.closePath(); ctx.fill(); };
    const label = (t, x, y, rot) => {
      ctx.save(); ctx.translate(x, y); if (rot) ctx.rotate(-Math.PI / 2);
      ctx.font = `600 12px ${C.mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const w = ctx.measureText(t).width; ctx.fillStyle = C.bg; ctx.fillRect(-w / 2 - 5, -9, w + 10, 18);
      ctx.fillStyle = C.ink; ctx.fillText(t, 0, 0.5); ctx.restore();
    };
    // height, to the left
    const xd = left - Math.max(18, 0.10 * (right - left));
    ctx.beginPath(); ctx.moveTo(left - 4, top); ctx.lineTo(xd - 6, top); ctx.moveTo(left - 4, bot); ctx.lineTo(xd - 6, bot); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(xd, top); ctx.lineTo(xd, bot); ctx.stroke(); arrow(xd, top, 0, -1); arrow(xd, bot, 0, 1);
    label(txt(H), xd, (top + bot) / 2, true);
    // width, above
    const yd = top - Math.max(18, 0.10 * (bot - top));
    ctx.strokeStyle = C.muted; ctx.fillStyle = C.muted;
    ctx.beginPath(); ctx.moveTo(left, top - 4); ctx.lineTo(left, yd - 6); ctx.moveTo(right, top - 4); ctx.lineTo(right, yd - 6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(left, yd); ctx.lineTo(right, yd); ctx.stroke(); arrow(left, yd, -1, 0); arrow(right, yd, 1, 0);
    label(txt(Wd), (left + right) / 2, yd, false);
    ctx.restore();
  }
  function drawScale() {
    const target = 120 / view.k; const nice = isIn() ? [1, 2, 6, 12, 24, 48].map((v) => v * 25.4) : [10, 20, 50, 100, 200, 500, 1000, 2000];
    const scaleTxt = (L) => isIn() ? `${(L / 25.4).toFixed(0)}"` : unit() === 'cm' ? `${L / 10} cm` : `${L} mm`;
    const L = nice.find((v) => v >= target) || nice[nice.length - 1];
    const x = view.w - 20 - L * view.k, y = view.h - 18;
    ctx.strokeStyle = C.muted; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + L * view.k, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.moveTo(x + L * view.k, y - 4); ctx.lineTo(x + L * view.k, y + 4); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.font = `11px ${C.mono}`; ctx.textAlign = 'center'; ctx.fillText(scaleTxt(L), x + L * view.k / 2, y - 6);
  }
  function tag(text, x, y, col, center) {
    ctx.font = `600 11px ${C.font}`; const w = ctx.measureText(text).width + 10;
    const bx = center ? x - w / 2 : x, by = y - 9;
    ctx.fillStyle = rgba(C.raised, 0.9); ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, w, 18, 4) : ctx.rect(bx, by, w, 18); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + 5, y + 0.5); ctx.textBaseline = 'alphabetic';
  }
  function drawPolyline(pts, col, dashed) {
    ctx.strokeStyle = col; ctx.lineWidth = 2; if (dashed) ctx.setLineDash([7, 5]);
    ctx.beginPath(); pts.forEach((v, i) => { const [x, y] = w2s(v.x, v.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
  }
  function drawPath(P, pi) {
    const p = P.src, col = pathColor(pi), S = P.m.samples, selected = isSel('path', p.id);
    // cross-section ticks
    ctx.strokeStyle = rgba(col, selected ? 0.55 : 0.32); ctx.lineWidth = 1;
    const every = Math.max(1, Math.round(30 / (view.k * 8)));
    ctx.beginPath();
    S.forEach((s, i) => { if (i % every) return; const [a, b] = w2s(s.x + s.nx * s.dL, s.y + s.ny * s.dL), [c, d] = w2s(s.x - s.nx * s.dR, s.y - s.ny * s.dR); ctx.moveTo(a, b); ctx.lineTo(c, d); });
    ctx.stroke();
    drawPolyline(p.pts, col, true);
    // arrows along the path
    ctx.fillStyle = col;
    for (let s = 120; s < P.m.L - 40; s += 260) {
      const q = HG.pointAt(p.pts, s); const [x, y] = w2s(q.x, q.y); const a = Math.atan2(-q.ty, MX() * q.tx);
      ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    // vertices
    p.pts.forEach((v, i) => { const [x, y] = w2s(v.x, v.y); ctx.fillStyle = selected ? col : C.raised; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, selected ? 5 : 3.5, 0, 7); ctx.fill(); ctx.stroke(); });
    // end markers + labels
    if (P.ends) P.ends.forEach((e, k) => {
      const [x, y] = w2s(e.x, e.y);
      const word = e.kind === 'open' ? 'mouth' : e.kind === 'closed' ? 'closed' : e.kind === 'chamber' ? (e.endCorr ? 'port → chamber' : '→ chamber') : '→ joins ' + nameOf(e.path);
      const txt = `${p.name}${k ? ' end' : ' start'} · ${word} · ${(e.S * 1e4).toFixed(0)} cm²`;
      if (e.kind === 'open' || hotVert(p, k === 0 ? 0 : p.pts.length - 1)) tag(txt, x + 8, y + (k ? -14 : 14), col);
    });
    p.pts.forEach((v, i) => { if (i === 0 || i === p.pts.length - 1 || !hotVert(p, i)) return; const smp = S.reduce((a, s) => (Math.abs(s.x - v.x) + Math.abs(s.y - v.y) < Math.abs(a.x - v.x) + Math.abs(a.y - v.y) ? s : a), S[0]); const [x, y] = w2s(v.x, v.y); tag(`${(smp.h * design.W / 100).toFixed(0)} cm²`, x + 8, y, col); });
  }
  // a path point is "hot" while the pointer is over it or it is being dragged: only then show its readout
  const hotVert = (p, i) => (drag && drag.kind === 'vert' && drag.id === p.id && drag.i === i) || (!drag && hover && hover.t === 'vert' && hover.id === p.id && hover.i === i);
  const nameOf = (pid) => (design.paths.find((p) => p.id === pid) || {}).name || '?';
  /** Driver body in local coordinates. Front mount: flange on the baffle face the cone fires from, basket through
   *  the cutout. Rear mount: driver fitted from the inside, flange against the opposite face, firing out through
   *  the cutout (the whole driver sits one board thickness further back). */
  /** 'neo' or 'ferrite': the listing says so when it can (build.js), otherwise the makers' model naming decides. */
  function magType(s) {
    if (!s) return 'ferrite';
    if (s.mag) return s.mag;
    const b = String(s.b || '').toLowerCase(), m = String(s.m || '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
    if (/neodym|\bneo\b/i.test(m)) return 'neo';
    if (/beyma/.test(b)) return /nd\b/i.test(m) ? 'neo' : 'ferrite';
    if (/lavoce/.test(b)) return /^[a-z]{2}n/i.test(m) ? 'neo' : 'ferrite';
    if (/eminence/.test(b)) return /lite|neo/i.test(m) ? 'neo' : 'ferrite';
    if (/b&c/.test(b)) return /^\d+\s*(n|ds|bg|ipal)/i.test(m) ? 'neo' : 'ferrite';
    if (/faital/.test(b)) return /^\d+\s*(xl|rs|rw|nrb|hx)/i.test(m) ? 'neo' : 'ferrite';
    return 'ferrite';
  }
  /** a neodymium driver's side profile from its sizes: basket tapering in to a compact motor (z from the flange face, radius) */
  function neoProfile(dm) {
    const R = dm.outer / 2, rc = Math.max(dm.cutout / 2, R * 0.8), D = dm.depth, fl = Math.max(6, dm.flange);
    const rm = Math.max(0.2 * R, Math.min(dm.mag / 2, 0.3 * R));
    return [[0, R], [fl, R], [fl, rc], [D * 0.5, rm * 1.55], [D * 0.6, rm * 1.15], [D * 0.66, rm], [D * 0.95, rm], [D, rm * 0.82]];
  }
  function driverLocal(d) {
    const dm = driverDims(d.key), t = design.t, rear = d.mountStyle === 'rear';
    const fl = Math.max(4, dm.flange * 0.6);
    const mp = rear ? -t / 2 : t / 2;                    // mounting face the flange is screwed to
    const front = rear ? mp - fl : mp;                    // where the cone opens
    const back = mp - dm.depth;                           // back of the magnet (depth from the mounting face)
    const R = dm.outer / 2, rc = dm.cone / 2, rm = dm.mag / 2;
    const basketTop = rear ? mp - fl : -t / 2;            // where the basket leaves the board
    // traced side profile from the technical drawing: [[z from flange face, radius], ...]
    const spec = specOf(d.key) || {}, mt = magType(spec);
    let outline = null, pf = null;
    // neo: the traced outline from its drawing, else one built from its sizes; ferrite: the block-magnet drawing (below)
    const prof = mt === 'neo' ? (spec.prof && spec.prof.length > 3 ? spec.prof : neoProfile(dm)) : null;
    if (prof) {
      const pr = prof, Rp = Math.max(...pr.map((q) => q[1]));
      const flz = (pr.find((q) => q[1] < 0.95 * Rp) || [0])[0];
      const v = (z) => rear ? -t / 2 - z : t / 2 + flz - z;   // flange's back face on the board (front mount) / its front face (rear mount)
      const right = pr.map(([z, r]) => [r, v(z)]), left = pr.slice().reverse().map(([z, r]) => [-r, v(z)]);
      outline = right.concat(left);
      pf = { R: Rp, depth: pr[pr.length - 1][0], flz, front: v(flz), back: v(pr[pr.length - 1][0]) };
    }
    return {
      dm, rear, mp, outline, pf,
      front: pf ? pf.front : front, back: pf ? pf.back : back, R: pf ? pf.R : R, rc, rm,
      flange: rear ? [[-R, mp - fl], [R, mp - fl], [R, mp], [-R, mp]] : [[-R, mp], [R, mp], [R, mp + fl], [-R, mp + fl]],
      cone: [[-rc, front - 4], [rc, front - 4], [rc * 0.28, back + dm.magDepth + dm.depth * 0.12], [-rc * 0.28, back + dm.magDepth + dm.depth * 0.12]],
      basket: [[-dm.cutout / 2, basketTop], [dm.cutout / 2, basketTop], [rm * 0.85, back + dm.magDepth], [-rm * 0.85, back + dm.magDepth]],
      magnet: [[-rm, back], [rm, back], [rm, back + dm.magDepth], [-rm, back + dm.magDepth]],
    };
  }
  function driverWorld(d, arr) {
    const L = hyp(d.nx, d.ny) || 1, nx = d.nx / L, ny = d.ny / L, ux = ny, uy = -nx;
    return arr.map(([u, v]) => ({ x: d.x + ux * u + nx * v, y: d.y + uy * u + ny * v }));
  }
  function convexOverlap(A, B, eps) { // separating-axis test for two convex polygons
    for (const P of [A, B]) for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], nx = -(b.y - a.y), ny = b.x - a.x, l = hyp(nx, ny) || 1;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const q of A) { const v = (q.x * nx + q.y * ny) / l; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
      for (const q of B) { const v = (q.x * nx + q.y * ny) / l; b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
      if (a1 <= b0 + eps || b1 <= a0 + eps) return false;
    }
    return true;
  }
  function inPoly(P, x, y) {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[i], b = P[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }
  function segCross(a, b, c, d) {
    const d1 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x), d2 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
    const d3 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x), d4 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
    return d1 * d2 < -1e-6 && d3 * d4 < -1e-6;
  }
  function polyOverlap(A, B) { // any polygons (outline may be concave); touching does not count
    for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) if (segCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    const ca = A.reduce((o, q) => ({ x: o.x + q.x / A.length, y: o.y + q.y / A.length }), { x: 0, y: 0 });
    const cb = B.reduce((o, q) => ({ x: o.x + q.x / B.length, y: o.y + q.y / B.length }), { x: 0, y: 0 });
    return inPoly(B, ca.x, ca.y) || inPoly(A, cb.x, cb.y);
  }
  function driverShapesWorld(d) {
    const loc = driverLocal(d);
    return loc.outline ? [driverWorld(d, loc.outline)] : [loc.flange, loc.basket, loc.magnet].map((a) => driverWorld(d, a));
  }
  /** The board (other than its own baffle) or the other driver that a driver's body cuts into, or null.
   *  A driver hit is returned as { driver, label } so messages can name it. */
  function driverHits(d, panels, drivers) {
    panels = panels || design.panels;
    const shapes = driverShapesWorld(d);
    const own = d.mount ? d.mount.pid : (nearestPanel(d.x, d.y) || {}).p?.id;
    for (const p of panels) {
      if (p.id === own) continue;
      const q = HG.panelQuad(p, design.t);
      if (shapes.some((sh) => polyOverlap(sh, q))) return p;
    }
    for (const o of drivers || design.drivers) {
      if (o === d || o.id === d.id) continue;
      const os = driverShapesWorld(o);
      if (shapes.some((sh) => os.some((q) => polyOverlap(sh, q)))) return { driver: o, label: 'the ' + ((specOf(o.key) || {}).m || 'other driver') };
    }
    return null;
  }
  const hitName = (hb) => (hb && hb.label) || partNames().get(hb && hb.id) || 'a board';
  function drawDriver(d) {
    const dm = driverDims(d.key), t = design.t;
    const L = hyp(d.nx, d.ny) || 1, nx = d.nx / L, ny = d.ny / L, ux = ny, uy = -nx; // u along panel, n = front
    const P = (u, v) => w2s(d.x + ux * u + nx * v, d.y + uy * u + ny * v);
    const poly = (arr, fill, stroke, lw = 1.2) => { ctx.beginPath(); arr.forEach(([u, v], i) => { const [x, y] = P(u, v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); } };
    const s = isSel('driver', d.id);
    const hitBoard = (drag && drag.kind === 'driver' && drag.id === d.id) ? drag.bad : driverHits(d);
    const col = hitBoard ? C.bad : s ? C.accent : C.driver;
    const loc = driverLocal(d), front = loc.front, R = loc.R, rc = loc.rc;
    if (loc.outline) {   // exact side silhouette traced from the technical drawing
      poly(loc.outline, hitBoard ? rgba(C.bad, 0.35) : rgba(C.ink, 0.22), hitBoard ? C.bad : rgba(C.ink, 0.75), 1.2);
      const pf = loc.pf, cb = pf.front - Math.min(pf.depth * 0.55, pf.depth - 20);
      poly([[-rc, pf.front - 2], [rc, pf.front - 2], [rc * 0.3, cb], [-rc * 0.3, cb]], rgba(col, hitBoard ? 0.4 : 0.26), col, 1.4);   // cone
    } else {
      poly(loc.flange, hitBoard ? rgba(C.bad, 0.85) : rgba(C.ink, 0.75), null);                       // flange
      poly(loc.cone, rgba(col, hitBoard ? 0.45 : 0.28), col, 1.6);                                       // cone
      poly(loc.basket, null, hitBoard ? C.bad : rgba(C.ink, 0.55), 1);                                   // basket
      poly(loc.magnet, hitBoard ? rgba(C.bad, 0.85) : rgba(C.ink, 0.8), null);                           // magnet
    }
    // facing arrow, from the board face the cone fires out of
    const [ax, ay] = P(0, t / 2 + 14), [bx, by] = P(0, t / 2 + 50);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    const ang = Math.atan2(by - ay, bx - ax); ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(bx + 7 * Math.cos(ang), by + 7 * Math.sin(ang)); ctx.lineTo(bx + 6 * Math.cos(ang + 2.4), by + 6 * Math.sin(ang + 2.4)); ctx.lineTo(bx + 6 * Math.cos(ang - 2.4), by + 6 * Math.sin(ang - 2.4)); ctx.fill();
    // anchors
    const di = A && A.driverInfo && A.driverInfo.find((q) => q.d.id === d.id);
    if (di) {
      for (const [sd, dash] of [[di.front, []], [di.rear, [4, 3]]]) {
        if (sd.kind !== 'path') continue;
        const [x0, y0] = w2s(d.x, d.y), [x1, y1] = w2s(sd.x, sd.y);
        ctx.setLineDash(dash); ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x1, y1, 4, 0, 7); ctx.fill();
      }
    }
    const spec = specOf(d.key);
    // name label kept inside the woofer: centred in the cone, running along the baffle, shrunk to fit its width
    {
      const name = `${spec ? spec.m : 'no driver'}${d.n > 1 ? ' ×' + d.n : ''}`;
      const [cx0, cy0] = P(0, front - dm.depth * 0.3);
      const [ax, ay] = P(-1, 0), [bx, by] = P(1, 0);
      let ang = Math.atan2(by - ay, bx - ax); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
      const availW = rc * 1.25 * view.k, availH = dm.depth * 0.28 * view.k;
      let fs = Math.min(13, availH * 0.7);
      ctx.font = `600 ${fs}px ${C.font}`;
      const tw = ctx.measureText(name).width;
      if (tw > availW) fs = fs * availW / tw;
      if (fs >= 7) {
        ctx.save(); ctx.translate(cx0, cy0); ctx.rotate(ang);
        ctx.font = `600 ${fs}px ${C.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3; ctx.strokeStyle = rgba(C.raised, 0.85); ctx.strokeText(name, 0, 0);
        ctx.fillStyle = s ? C.accent : C.ink; ctx.fillText(name, 0, 0);
        ctx.restore(); ctx.textBaseline = 'alphabetic';
      }
    }
  }
  function drawArcBand(pts, fill, stroke) {
    const w = design.t * view.k;
    ctx.save(); ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    ctx.beginPath(); pts.forEach((v, i) => { const [x, y] = w2s(v.x, v.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (fill) { ctx.strokeStyle = fill; ctx.lineWidth = w; ctx.stroke(); }
    if (stroke) { ctx.setLineDash([4, 3]); ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); }
    ctx.restore();
  }
  function drawArcSel(g) {
    const pts = arcPts(g), G = arcGeom(g), mm = arcMid(g);
    drawArcBand(pts, null, C.accent);
    ctx.fillStyle = C.accent; ctx.strokeStyle = C.raised; ctx.lineWidth = 1.5;
    for (const v of [g.a, g.b]) { const [x, y] = w2s(v.x, v.y); ctx.fillRect(x - 4.5, y - 4.5, 9, 9); ctx.strokeRect(x - 4.5, y - 4.5, 9, 9); }
    { const [x, y] = w2s(mm.x, mm.y); ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.stroke(); }
    if (G.c) { const [x, y] = w2s(mm.x, mm.y); tag(`R ${fmtL(G.c.r)} · ${(Math.abs(G.sweep) * 180 / Math.PI).toFixed(0)}°`, x + 12, y - 12, C.accent); }
  }
  function drawDraft() {
    const d = draft;
    if (d.kind === 'arc') {
      const pts = d.stage === 1 ? [d.a, d.b] : arcPts({ a: d.a, m: d.m, b: d.b });
      drawArcBand(pts, rgba(C.birch, 0.7), C.accent);
      const end = pts[pts.length - 1], [x, y] = w2s(end.x, end.y);
      if (d.stage === 1) tag(`${fmtL(hyp(d.b.x - d.a.x, d.b.y - d.a.y))} · now click the other end`, x + 12, y - 12, C.accent);
      else { const G = arcGeom({ a: d.a, m: d.m, b: d.b }); tag(G.c ? `R ${fmtL(G.c.r)} · ${(Math.abs(G.sweep) * 180 / Math.PI).toFixed(0)}° · click to place` : 'move sideways to bend', x + 12, y - 12, C.accent); }
      return;
    }
    if (d.kind === 'panel') {
      let { x1, y1, x2, y2 } = d;
      if (align !== 'center') { const L = hyp(x2 - x1, y2 - y1) || 1, nx = -(y2 - y1) / L, ny = (x2 - x1) / L, s = (align === 'left' ? 1 : -1) * design.t / 2; x1 += nx * s; x2 += nx * s; y1 += ny * s; y2 += ny * s; }
      const q = HG.panelQuad({ x1, y1, x2, y2 }, design.t);
      ctx.beginPath(); q.forEach((v, i) => { const [x, y] = w2s(v.x, v.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath();
      ctx.fillStyle = rgba(C.birch, 0.7); ctx.fill(); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.stroke();
      const [a, b] = w2s(d.x1, d.y1), [c, e] = w2s(d.x2, d.y2); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, e); ctx.stroke(); ctx.setLineDash([]);
      const ang = Math.atan2(d.y2 - d.y1, d.x2 - d.x1) * 180 / Math.PI;
      tag(`${fmtL(hyp(d.x2 - d.x1, d.y2 - d.y1))} · ${ang.toFixed(1)}°`, c + 12, e - 12, C.accent);
    } else if (d.kind === 'boundary') {
      const [a, b] = w2s(d.x1, d.y1), [c, e] = w2s(d.x2, d.y2); ctx.setLineDash([6, 4]); ctx.strokeStyle = C.chamber; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, e); ctx.stroke(); ctx.setLineDash([]);
    } else if (d.kind === 'box') {
      const [a, b] = w2s(d.x1, d.y1), [c, e] = w2s(d.x2, d.y2);
      ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.strokeRect(Math.min(a, c), Math.min(b, e), Math.abs(c - a), Math.abs(e - b));
      tag(`${fmtL(Math.abs(d.x2 - d.x1))} × ${fmtL(Math.abs(d.y2 - d.y1))} outside`, Math.max(a, c) + 8, Math.min(b, e), C.accent);
    } else if (d.kind === 'path') {
      const pts = d.cur ? [...d.pts, d.cur] : d.pts; drawPolyline(pts, C.air, true);
      pts.forEach((v) => { const [x, y] = w2s(v.x, v.y); ctx.fillStyle = C.air; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 7); ctx.fill(); });
    }
  }
  function renderStatus() {
    const el = $('status'); if (!el) return;
    const chips = [];
    if (A && A.quads && A.quads.length) {
      const s = HG.summary(design, A);
      chips.push(`<span class="chip dims">Outside ${fmtL(s.D)} deep × ${fmtL(s.H)} high × ${fmtL(s.Wout)} wide · ${(s.Vext).toFixed(0)} L</span>`);
    }
    if (tool === 'panel') chips.push(`<span class="chip">Drawing: ${align === 'center' ? 'centre-line' : align + ' face'} (X)</span>`);
    for (const w of (A && A.warnings) || []) chips.push(`<span class="chip warn">${esc(w)}</span>`);
    if (!drag) for (const d of design.drivers) { const hb = driverHits(d); if (hb) chips.push(`<span class="chip warn">${esc((specOf(d.key) || {}).m || 'Driver')} cuts into ${esc(hitName(hb))} — move it, rear-mount it, or flip the basket.</span>`); }
    el.innerHTML = chips.join('');
  }
  // ---- part roles & names (auto-deduced in HornGeom.inferParts; a human choice in panel.role / panel.name wins)
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function partInfo(id) { return (A && A.parts && A.parts.find((q) => q.id === id)) || null; }
  function roleOf(p) { if (p.role) return p.role; const pi = partInfo(p.id); return pi ? pi.auto : 'other'; }
  function partNames() {
    const map = new Map(), counts = {}, seen = {};
    design.panels.forEach((p) => { const r = roleOf(p); counts[r] = (counts[r] || 0) + 1; });
    design.panels.forEach((p) => {
      const r = roleOf(p); seen[r] = (seen[r] || 0) + 1;
      map.set(p.id, p.name || (cap(r) + (counts[r] > 1 ? ' ' + seen[r] : '')));
    });
    return map;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------------------------------------------------------- charts
  const TABS = [
    { id: 'spl', name: 'SPL' }, { id: 'imp', name: 'Impedance' }, { id: 'exc', name: 'Excursion' }, { id: 'load', name: 'Cone load' },
    { id: 'gd', name: 'Group delay' }, { id: 'step', name: 'Step / impulse' }, { id: 'decay', name: 'Decay' }, { id: 'vel', name: 'Air velocity' },
    { id: 'max', name: 'Max SPL' }, { id: 'area', name: 'Flare' },
  ];
  let tab = LS.get('shl.tab') || (window.DEFAULT_PROJECT && window.DEFAULT_PROJECT.ui && window.DEFAULT_PROJECT.ui.tab) || 'spl', chartCfg = null, chartHover = null;
  const fRange = () => { const r = design.fRange || [20, 1000]; return [Math.max(20, r[0]), r[1]]; };
  function renderTabs() {
    $('tabs').innerHTML = TABS.map((t) => `<button class="${t.id === tab ? 'on' : ''}" data-tab="${t.id}">${t.name}</button>`).join('');
    $('tabs').querySelectorAll('button').forEach((b) => b.onclick = () => { tab = b.dataset.tab; LS.set('shl.tab', tab); renderTabs(); if (['step', 'decay'].includes(tab) && !T) scheduleTransient(); drawChart(); refreshLegend(); });
  }
  function seriesFor() {
    if (!R) return null;
    const f = R.f, [f0, f1] = fRange();
    const base = { xlog: true, xmin: f0, xmax: f1, series: [] };
    if (tab === 'spl') {
      const dB = pdB(), ov = overRatio(Math.sqrt(pwrW)), up = (a) => a.map((v) => v + dB);
      base.yLabel = `dB SPL @ 1 m, ${driveLabel(pwrW)}`; base.series.push({ x: f, y: up(R.spl), color: C.accent, width: 2.2, label: 'This design', over: ov });
      if (ov) base.bands = overBands(f, ov);
      if (dspActive()) base.series.push({ x: f, y: up(R.splRaw), color: C.accent, width: 1, dash: [4, 3], label: 'Unfiltered' });
      pins.forEach((p, i) => base.series.unshift({ x: p.f, y: up(p.spl), color: pinCol(i), width: 1.4, label: p.name }));
      if (design.target && design.target.pts.length >= 2) {
        const [tl, th] = targetBand(), tf = HC.logFreqs(tl, th, 60);
        const toff = tdrag ? tdrag.off : targetOffset() + dB;
        base.series.push({ x: tf, y: tf.map((x) => targetAt(x) + toff), color: C.warn, width: 2, dash: [7, 4], label: design.target.level ? 'Target' : 'Target (shape)' });
        base.handles = design.target.pts.map((p) => ({ f: p[0], db: p[1] + toff }));
      }
      const m = Math.max(...R.spl.filter((_, i) => f[i] >= f0 && f[i] <= f1).map((v) => v + dB), ...(design.target ? design.target.pts.map((p) => p[1] + dB) : [])); base.ymax = Math.ceil((m + 4) / 5) * 5; base.ymin = base.ymax - 50;
      if (dspActive() && showDspCurve) {
        const xs = HC.logFreqs(Math.max(5, f0), f1, 240);
        base.series2 = { x: xs, y: xs.map((x) => 20 * Math.log10(HC.abs(xoverH(x)) + 1e-12)), color: C.ok, label: 'DSP filter', unit: ' dB',
          min: -40, max: 10, ticks: [-40, -30, -20, -10, 0, 10], width: 1.6, dash: [], zero: true, legend: 'DSP filter (right axis)' };
      }
    } else if (tab === 'imp') {
      base.yLabel = 'Ω'; base.series.push({ x: f, y: R.ze, color: C.accent, width: 2, label: '|Ze|' });
      base.series2 = { x: f, y: R.zePh, color: C.muted, label: 'phase (°)', min: -90, max: 90 };
      pins.forEach((p, i) => base.series.unshift({ x: p.f, y: p.ze, color: pinCol(i), width: 1.2, label: p.name }));
      base.ymin = 0;
    } else if (tab === 'exc') {
      const kx = Math.sqrt(pwrW), ov = overRatio(kx);
      base.yLabel = `mm peak @ ${driveLabel(pwrW)}`; base.series.push({ x: f, y: R.x.map((v) => v * kx), color: C.accent, width: 2, label: 'Cone excursion', over: ov });
      if (ov) base.bands = overBands(f, ov);
      if (R.Xmax) base.hlines = [{ y: R.Xmax, color: C.bad, label: `Xmax ${R.Xmax} mm` }];
      pins.forEach((p, i) => base.series.unshift({ x: p.f, y: p.x.map((v) => v * kx), color: pinCol(i), width: 1.2, label: p.name }));
      base.ymin = 0;
    } else if (tab === 'load') {
      base.yLabel = 'normalised to ρc/Sd'; base.series.push({ x: f, y: R.ra, color: C.accent, width: 2, label: 'Resistance Ra' }, { x: f, y: R.xa, color: C.driver, width: 1.5, label: 'Reactance Xa' });
    } else if (tab === 'gd') {
      base.yLabel = 'ms'; base.series.push({ x: f, y: R.gd, color: C.accent, width: 2, label: 'Group delay' });
      pins.forEach((p, i) => p.gd && base.series.unshift({ x: p.f, y: p.gd, color: pinCol(i), width: 1.2, label: p.name }));
      const vals = R.gd.filter((_, i) => f[i] >= Math.max(f0, 15) && f[i] <= f1); base.ymin = Math.min(0, Math.floor(Math.min(...vals) / 5) * 5); base.ymax = Math.max(10, Math.ceil(Math.max(...vals) / 5) * 5);
    } else if (tab === 'vel') {
      base.yLabel = `m/s peak @ ${driveLabel(pwrW)}`;
      R.radLabels.forEach((lb, k) => base.series.push({ x: f, y: R.vel.map((v) => v[k] * Math.sqrt(pwrW)), color: k ? C.driver : C.accent, width: 2, label: prettyRad(lb) }));
      base.hlines = [{ y: 17, color: C.warn, label: '17 m/s port-noise guide' }]; base.ymin = 0;
    } else if (tab === 'max') {
      base.yLabel = 'dB SPL @ 1 m';
      base.series.push({ x: f, y: R.maxSpl, color: C.accent, width: 2.4, label: 'Max SPL' });
      if (R.Pe) base.series.push({ x: f, y: R.maxTh, color: C.warn, width: 1, dash: [4, 3], label: `Thermal (${R.Pe} W)` });
      if (R.Xmax) base.series.push({ x: f, y: R.maxX, color: C.bad, width: 1, dash: [4, 3], label: `Xmax (${R.Xmax} mm)` });
      pins.forEach((p, i) => p.max && base.series.unshift({ x: p.f, y: p.max, color: pinCol(i), width: 1.2, label: p.name }));
      const m = Math.max(...R.maxSpl.filter((v, i) => isFinite(v) && f[i] >= f0 && f[i] <= f1)); base.ymax = Math.ceil((m + 4) / 5) * 5; base.ymin = base.ymax - 40;
      if (!R.Pe && !R.Xmax) base.note = 'Set Pe and Xmax for the driver to see limits.';
    } else if (tab === 'area') {
      base.xlog = false; base.xLabel = 'distance along path (cm)'; base.yLabel = 'cross-section (cm²)'; base.xmin = 0; base.ymin = 0;
      let xmax = 10;
      (A.paths || []).forEach((P, i) => { const xs = P.m.samples.map((s) => s.s / 10), ys = P.m.samples.map((s) => s.h * design.W / 100); xmax = Math.max(xmax, ...xs); base.series.push({ x: xs, y: ys, color: pathColor(i), width: 2, label: `Path ${P.src.name}` }); });
      base.xmax = xmax;
      base.vlines = [];
      (A.driverInfo || []).forEach((di) => { for (const [sd, w] of [[di.front, 'front'], [di.rear, 'rear']]) if (sd.kind === 'path') base.vlines.push({ x: sd.s / 10, color: C.driver, label: `${w}` }); });
    } else if (tab === 'step') {
      if (!T) return { pending: true };
      base.xlog = false; base.xLabel = 'ms'; base.xmin = 0; base.xmax = design.tMax || 100; base.yLabel = 'normalised';
      const n = Math.round(base.xmax / 1000 * T.fs), t = [], st = [], ir = [];
      const ms = Math.max(...T.step.slice(0, n).map(Math.abs)) || 1, mi = Math.max(...T.ir.slice(0, n).map(Math.abs)) || 1;
      for (let i = 0; i < n; i++) { t.push(i / T.fs * 1000); st.push(T.step[i] / ms); ir.push(T.ir[i] / mi); }
      base.series.push({ x: t, y: ir, color: C.muted, width: 1, label: 'Impulse' }, { x: t, y: st, color: C.accent, width: 2.2, label: 'Step' });
      base.ymin = -1.1; base.ymax = 1.1;
    } else if (tab === 'decay') {
      if (!T) return { pending: true };
      return { heat: true };
    }
    return base;
  }
  const prettyRad = (lb) => { const m = /path (\d+) (start|end)/.exec(lb || ''); if (m) { const p = design.paths.find((q) => q.id === +m[1]); return `Path ${p ? p.name : '?'} ${m[2] === 'end' ? 'mouth' : 'start'}`; } return lb === 'driver front' ? 'Cone (front)' : lb === 'driver rear' ? 'Cone (rear)' : lb; };
  const pinCol = (i) => ['#8a96a0', '#b08a5a', '#8a72b5', '#5f9e8a', '#b56f80'][i % 5];

  function niceTicks(a, b, n) { const span = b - a, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0))); const st = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || mag * 10; const out = []; for (let v = Math.ceil(a / st) * st; v <= b + 1e-9; v += st) out.push(+v.toFixed(10)); return out; }

  /** Log-frequency axis labels: decade lines show their full value (10, 100, 1k), every other gridline just its
   *  leading digit 2–9. Placed by priority (decades, 5, 2, 3, then the rest); a label that would touch one already
   *  placed is dropped, so narrow charts show fewer digits and wide ones show them all. */
  function drawLogLabels(c, f0, f1, X, y) {
    const items = [];
    for (let d = Math.pow(10, Math.floor(Math.log10(f0))); d <= f1; d *= 10) for (let m = 1; m <= 9; m++) {
      const v = d * m; if (v < f0 * 0.999 || v > f1 * 1.001) continue;
      const decade = m === 1;
      const txt = decade ? (v >= 1000 ? v / 1000 + 'k' : String(v)) : String(m);
      items.push({ v, txt, decade, pri: decade ? 0 : m === 5 ? 1 : m === 2 ? 2 : m === 3 ? 3 : 4 + m });
    }
    items.sort((a, b) => a.pri - b.pri || a.v - b.v);
    const placed = [], pad = 4;
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    for (const it of items) {
      c.font = `${it.decade ? '600 ' : ''}10.5px ${C.mono}`;
      const w = c.measureText(it.txt).width, x = X(it.v), a = x - w / 2 - pad, b = x + w / 2 + pad;
      if (placed.some((q) => a < q.b && b > q.a)) continue;
      placed.push({ a, b });
      c.fillStyle = it.decade ? C.ink : C.muted; c.fillText(it.txt, x, y);
    }
    c.font = `10.5px ${C.mono}`; c.fillStyle = C.muted;
  }
  function drawChart() {
    const W = chartCv.width / view.dpr, H = chartCv.height / view.dpr; if (!W) return;
    const c = cctx; c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    c.fillStyle = C.raised; c.fillRect(0, 0, W, H);
    const cfg = seriesFor(); chartCfg = cfg;
    c.font = `12px ${C.font}`; c.fillStyle = C.muted; c.textAlign = 'center';
    if (!cfg) {
      const msg = !design.drivers.length ? 'Mount a driver on a board (D) to see the response.' : (A && A.warnings && A.warnings.find((w) => /Nothing radiates|blocked/.test(w))) || 'Draw boards, an air path and a driver to see the response.';
      c.fillText(msg, W / 2, H / 2); return;
    }
    if (cfg.pending) { c.fillText('Computing time response…', W / 2, H / 2); return; }
    if (cfg.heat) { drawDecay(c, W, H); return; }
    const L = 46, Rr = cfg.series2 ? 40 : 14, Tp = 12, B = 30, pw = W - L - Rr, ph = H - Tp - B;
    let ymin = cfg.ymin, ymax = cfg.ymax;
    if (ymin == null || ymax == null) {
      let lo = Infinity, hi = -Infinity;
      for (const s of cfg.series) s.x.forEach((x, i) => { if (x >= cfg.xmin && x <= cfg.xmax && isFinite(s.y[i])) { lo = Math.min(lo, s.y[i]); hi = Math.max(hi, s.y[i]); } });
      (cfg.hlines || []).forEach((h) => { hi = Math.max(hi, h.y * 1.1); });
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (ymin == null) ymin = lo - (hi - lo) * 0.05; if (ymax == null) ymax = hi + (hi - lo) * 0.08 + 1e-9;
    }
    const X = (x) => L + (cfg.xlog ? Math.log(x / cfg.xmin) / Math.log(cfg.xmax / cfg.xmin) : (x - cfg.xmin) / (cfg.xmax - cfg.xmin)) * pw;
    const Y = (y) => Tp + (1 - (y - ymin) / (ymax - ymin)) * ph;
    cfg.X = X; cfg.Y = Y; cfg.L = L; cfg.pw = pw; cfg.Tp = Tp; cfg.ph = ph; cfg.ymin = ymin; cfg.ymax = ymax;
    // grid
    c.strokeStyle = C.line; c.lineWidth = 1; c.fillStyle = C.muted; c.font = `10.5px ${C.mono}`;
    const xt = cfg.xlog ? [10, 100, 1000, 10000].filter((v) => v >= cfg.xmin && v <= cfg.xmax) : niceTicks(cfg.xmin, cfg.xmax, 8);
    if (cfg.xlog) { c.beginPath(); for (let d = 10; d <= cfg.xmax; d *= 10) for (let m = 1; m < 10; m++) { const v = d * m; if (v < cfg.xmin || v > cfg.xmax) continue; c.moveTo(X(v) + 0.5, Tp); c.lineTo(X(v) + 0.5, Tp + ph); } c.globalAlpha = 0.45; c.stroke(); c.globalAlpha = 1; }
    c.beginPath(); xt.forEach((v) => { c.moveTo(Math.round(X(v)) + 0.5, Tp); c.lineTo(Math.round(X(v)) + 0.5, Tp + ph); }); c.stroke();
    if (cfg.xlog) drawLogLabels(c, cfg.xmin, cfg.xmax, X, H - B + 14);
    else { c.textAlign = 'center'; xt.forEach((v) => c.fillText(String(v), X(v), H - B + 14)); }
    const yt = niceTicks(ymin, ymax, 6);
    c.beginPath(); yt.forEach((v) => { c.moveTo(L, Math.round(Y(v)) + 0.5); c.lineTo(L + pw, Math.round(Y(v)) + 0.5); }); c.stroke();
    c.textAlign = 'right'; yt.forEach((v) => c.fillText(Math.abs(v) >= 100 ? v.toFixed(0) : +v.toFixed(2), L - 5, Y(v) + 3.5));
    c.textAlign = 'left'; c.font = `11px ${C.font}`; c.fillText(cfg.yLabel || '', L + 4, Tp + 12);
    c.textAlign = 'right'; c.fillText(cfg.xLabel || 'Hz', L + pw - 4, H - B + 26 > H ? H - 2 : H - B + 26);
    c.save(); c.beginPath(); c.rect(L, Tp, pw, ph); c.clip();
    (cfg.hlines || []).forEach((h) => { c.strokeStyle = h.color; c.setLineDash([5, 4]); c.lineWidth = 1.2; c.beginPath(); c.moveTo(L, Y(h.y)); c.lineTo(L + pw, Y(h.y)); c.stroke(); c.setLineDash([]); c.fillStyle = h.color; c.textAlign = 'right'; c.fillText(h.label, L + pw - 4, Y(h.y) - 4); });
    (cfg.vlines || []).forEach((h) => { c.strokeStyle = h.color; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(X(h.x), Tp); c.lineTo(X(h.x), Tp + ph); c.stroke(); c.setLineDash([]); c.fillStyle = h.color; c.textAlign = 'left'; c.fillText(h.label, X(h.x) + 3, Tp + 24); });
    (cfg.bands || []).forEach(([a, b]) => { const x0 = X(Math.max(a, cfg.xmin)), x1 = X(Math.min(b, cfg.xmax)); if (x1 <= x0) return; c.fillStyle = C.bad; c.globalAlpha = 0.1; c.fillRect(x0, Tp, x1 - x0, ph); c.globalAlpha = 1; });
    if (cfg.series2) {
      const s2 = cfg.series2, Y2 = (y) => Tp + (1 - (y - s2.min) / (s2.max - s2.min)) * ph;
      if (s2.zero) { c.strokeStyle = s2.color; c.globalAlpha = 0.35; c.setLineDash([2, 4]); c.lineWidth = 1; c.beginPath(); c.moveTo(L, Y2(0)); c.lineTo(L + pw, Y2(0)); c.stroke(); c.globalAlpha = 1; }
      c.strokeStyle = s2.color; c.lineWidth = s2.width || 1; c.setLineDash(s2.dash || [2, 3]); c.beginPath(); let st = false; s2.x.forEach((x, i) => { if (x < cfg.xmin || x > cfg.xmax) return; const px = X(x), py = Y2(s2.y[i]); st ? c.lineTo(px, py) : c.moveTo(px, py); st = true; }); c.stroke(); c.setLineDash([]);
    }
    for (const s of cfg.series) {
      c.strokeStyle = s.color; c.lineWidth = s.width || 1.5; c.setLineDash(s.dash || []); c.beginPath(); let st = false;
      s.x.forEach((x, i) => { const y = s.y[i]; if (x < cfg.xmin * 0.98 || x > cfg.xmax * 1.02 || !isFinite(y)) { st = false; return; } const px = X(x), py = Y(y); st ? c.lineTo(px, py) : c.moveTo(px, py); st = true; });
      c.stroke(); c.setLineDash([]);
      if (s.over) {   // red wherever the cone is past Xmax (crossings interpolated)
        c.strokeStyle = C.bad; c.lineWidth = (s.width || 1.5) + 0.8; c.beginPath();
        for (let i = 1; i < s.x.length; i++) {
          const r0 = s.over[i - 1], r1 = s.over[i];
          if ((r0 <= 1 && r1 <= 1) || !isFinite(s.y[i]) || !isFinite(s.y[i - 1])) continue;
          const tc = (1 - r0) / ((r1 - r0) || 1e-9), t0 = r0 > 1 ? 0 : tc, t1 = r1 > 1 ? 1 : tc;
          const ax = X(s.x[i - 1]), bx = X(s.x[i]), ay = Y(s.y[i - 1]), by = Y(s.y[i]);
          c.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0); c.lineTo(ax + (bx - ax) * t1, ay + (by - ay) * t1);
        }
        c.stroke();
      }
    }
    if (cfg.handles) for (const h of cfg.handles) {   // EQ-style target handles
      const px = X(h.f), py = Y(h.db); c.fillStyle = C.raised; c.strokeStyle = C.warn; c.lineWidth = 2; c.beginPath(); c.arc(px, py, 6, 0, 7); c.fill(); c.stroke();
    }
    c.restore();
    if (cfg.series2) { const s2 = cfg.series2; c.fillStyle = s2.unit ? s2.color : C.muted; c.textAlign = 'left'; c.font = `10.5px ${C.mono}`; (s2.ticks || [-90, -45, 0, 45, 90]).forEach((v) => c.fillText(v + (s2.unit ? '' : '°'), L + pw + 4, Tp + (1 - (v - s2.min) / (s2.max - s2.min)) * ph + 3.5)); if (s2.unit) c.fillText('dB', L + pw + 4, Tp + ph + 16); }
    if (cfg.note) { c.fillStyle = C.muted; c.textAlign = 'center'; c.font = `12px ${C.font}`; c.fillText(cfg.note, L + pw / 2, Tp + ph / 2); }
    if (chartHover && chartHover.x >= L && chartHover.x <= L + pw) {
      const px = chartHover.x; c.strokeStyle = C.muted; c.lineWidth = 1; c.beginPath(); c.moveTo(px + 0.5, Tp); c.lineTo(px + 0.5, Tp + ph); c.stroke();
      const xv = cfg.xlog ? cfg.xmin * Math.pow(cfg.xmax / cfg.xmin, (px - L) / pw) : cfg.xmin + (px - L) / pw * (cfg.xmax - cfg.xmin);
      const lines = [`${cfg.xlog ? xv.toFixed(xv < 100 ? 1 : 0) + ' Hz' : xv.toFixed(1) + ' ' + (cfg.xLabel || '')}`];
      for (const s of cfg.series.slice().reverse()) { let bi = 0, bd = Infinity; s.x.forEach((x, i) => { const d = Math.abs(x - xv); if (d < bd) { bd = d; bi = i; } }); const v = s.y[bi]; if (isFinite(v)) { lines.push(`${s.label}: ${Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2)}${s.over && tab === 'spl' ? ` · ${(s.over[bi] * R.Xmax).toFixed(1)} mm${s.over[bi] > 1 ? ' OVER' : ''}` : ''}`); const py = Y(v); if (py >= Tp && py <= Tp + ph) { c.fillStyle = s.color; c.beginPath(); c.arc(px, py, 3, 0, 7); c.fill(); } } }
      if (cfg.series2 && cfg.series2.unit) { const s2 = cfg.series2; let bi = 0, bd = Infinity; s2.x.forEach((x, i) => { const d = Math.abs(Math.log(x / xv)); if (d < bd) { bd = d; bi = i; } }); const v = s2.y[bi]; lines.push(`${s2.label}: ${v >= 0 ? '+' : ''}${v.toFixed(1)}${s2.unit}`); const py = Tp + (1 - (v - s2.min) / (s2.max - s2.min)) * ph; if (py >= Tp && py <= Tp + ph) { c.fillStyle = s2.color; c.beginPath(); c.arc(px, py, 3, 0, 7); c.fill(); } }
      c.font = `11px ${C.mono}`; const w = Math.max(...lines.map((l) => c.measureText(l).width)) + 12, h = lines.length * 15 + 6;
      const bx = px + 10 + w > L + pw ? px - 10 - w : px + 10;
      c.fillStyle = rgba(C.panel, 0.95); c.strokeStyle = C.line; c.fillRect(bx, Tp + 4, w, h); c.strokeRect(bx + 0.5, Tp + 4.5, w, h);
      c.fillStyle = C.ink; c.textAlign = 'left'; lines.forEach((l, i) => c.fillText(l, bx + 6, Tp + 18 + i * 15));
    }
  }
  function drawDecay(c, W, H) {
    const csd = T.csd, L = 46, Rr = 14, Tp = 12, B = 30, pw = W - L - Rr, ph = H - Tp - B;
    const f0 = Math.max(10, fRange()[0]), f1 = Math.min(500, fRange()[1]);
    const nT = csd.slices.length, img = c.createImageData(Math.max(1, Math.floor(pw * view.dpr)), Math.max(1, Math.floor(ph * view.dpr)));
    const ramp = (v) => { // v 0..1 -> perceptual-ish blue-teal-yellow
      const stops = [[16, 24, 48], [33, 84, 160], [31, 143, 134], [214, 196, 72], [252, 245, 210]];
      const x = clamp(v, 0, 1) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), t = x - i;
      return stops[i].map((a, k) => a + (stops[i + 1][k] - a) * t);
    };
    const floor = 40;
    for (let py = 0; py < img.height; py++) {
      const ts = (py / img.height) * (nT - 1), si = Math.floor(ts);
      const sl = csd.slices[si];
      for (let px = 0; px < img.width; px++) {
        const f = f0 * Math.pow(f1 / f0, px / img.width), bi = Math.round(f / csd.df);
        const db = 20 * Math.log10((sl[bi] || 1e-12) / csd.ref);
        const col = ramp((db + floor) / floor), o = (py * img.width + px) * 4;
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
      }
    }
    c.putImageData(img, Math.round(L * view.dpr), Math.round(Tp * view.dpr));
    c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    c.fillStyle = C.muted; c.font = `10.5px ${C.mono}`; c.textAlign = 'center';
    drawLogLabels(c, f0, f1, (v) => L + Math.log(v / f0) / Math.log(f1 / f0) * pw, H - B + 14);
    c.textAlign = 'right'; const tMax = (nT - 1) * csd.tStep * 1000;
    for (let t = 0; t <= tMax; t += 20) c.fillText(t + ' ms', L - 4, Tp + t / tMax * ph + 3.5);
    c.textAlign = 'right'; c.font = `11px ${C.font}`; c.fillText('Hz · colour = level re. first slice (0 to −40 dB)', L + pw, H - 4);
  }
  const chartInv = (px, py) => { const c = chartCfg; return [c.xmin * Math.pow(c.xmax / c.xmin, (px - c.L) / c.pw), c.ymin + (1 - (py - c.Tp) / c.ph) * (c.ymax - c.ymin)]; };
  const nearHandle = (px, py) => { const c = chartCfg; if (!c || !c.handles) return -1; let bi = -1, bd = 12; c.handles.forEach((h, i) => { const d = hyp(c.X(h.f) - px, c.Y(h.db) - py); if (d < bd) { bd = d; bi = i; } }); return bi; };
  chartCv.addEventListener('pointerdown', (e) => {
    if (tab !== 'spl' || !design.target || tuneJob) return;
    const r = chartCv.getBoundingClientRect(), i = nearHandle(e.clientX - r.left, e.clientY - r.top);
    if (i < 0) return;
    try { chartCv.setPointerCapture(e.pointerId); } catch (err) { }
    commit(); tdrag = { i, off: targetOffset() + pdB() }; e.preventDefault();
  });
  chartCv.addEventListener('pointerup', () => { if (tdrag) { tdrag = null; LS.set('shl.design', JSON.stringify(design)); refreshLegend(); stats(); } });
  chartCv.addEventListener('dblclick', (e) => {
    if (tab !== 'spl' || !design.target || !chartCfg || tuneJob) return;
    const r = chartCv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, i = nearHandle(px, py);
    commit();
    if (i >= 0) { if (design.target.pts.length > 2) design.target.pts.splice(i, 1); }
    else if (px > chartCfg.L && px < chartCfg.L + chartCfg.pw) { const [f, db] = chartInv(px, py); design.target.pts.push([+f.toFixed(1), +(db - targetOffset() - pdB()).toFixed(1)]); design.target.pts.sort((a, b) => a[0] - b[0]); }
    drawChart(); stats();
  });
  chartCv.addEventListener('pointermove', (e) => {
    const r = chartCv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    if (tdrag && chartCfg) {
      const P = design.target.pts, [f, db] = chartInv(px, py), i = tdrag.i;
      const fl = i > 0 ? P[i - 1][0] * 1.04 : chartCfg.xmin, fh = i < P.length - 1 ? P[i + 1][0] / 1.04 : chartCfg.xmax;
      P[i] = [+clamp(f, fl, fh).toFixed(1), +(db - tdrag.off).toFixed(1)];
      chartHover = { x: chartCfg.X(P[i][0]), y: py }; drawChart(); return;   // keep the readout on the dragged handle
    }
    chartCv.style.cursor = tab === 'spl' && nearHandle(px, py) >= 0 ? 'grab' : 'default';
    chartHover = { x: px, y: py }; drawChart();
  });
  chartCv.addEventListener('pointerleave', () => { chartHover = null; drawChart(); });

  let showDspCurve = LS.get('shl.dspCurve') !== '0';
  const DSP_TYPES = [['BW', 'Butterworth'], ['LR', 'Linkwitz-Riley'], ['BS', 'Bessel']];
  const DSP_PEQ = [['pk', 'Peak'], ['ls', 'Low shelf'], ['hs', 'High shelf']];
  function dspBarHtml() {
    const d = dspOf(design);
    const opt = (list, v) => list.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
    const pass = (id, lab, fl) => `<div class="dspc ${fl.on ? 'on' : ''}" data-k="${id}">
        <label class="row"><input type="checkbox" data-f="on" ${fl.on ? 'checked' : ''}><b>${lab}</b></label><select data-f="type">${opt(DSP_TYPES, fl.type)}</select>
        <select data-f="order">${[1, 2, 3, 4, 6, 8].filter((n) => fl.type !== 'LR' || n % 2 === 0).map((n) => `<option value="${n}" ${n === fl.order ? 'selected' : ''}>${6 * n} dB/oct</option>`).join('')}</select>
        <span class="dspf"><input type="text" data-f="f" value="${fl.f}">Hz</span></div>`;
    const band = (b, i) => `<div class="dspc ${b.on && b.g ? 'on' : ''}" data-k="peq" data-i="${i}">
        <label class="row"><input type="checkbox" data-f="on" ${b.on ? 'checked' : ''}><b>PEQ ${i + 1}</b></label><select data-f="type">${opt(DSP_PEQ, b.type)}</select>
        <span class="dspf"><input type="text" data-f="f" value="${b.f}">Hz</span><span class="dspf"><input type="text" data-f="g" value="${b.g}">dB</span><span class="dspf">Q<input type="text" data-f="q" value="${b.q}"></span></div>`;
    return `<div class="dspbar"><div class="dsphead"><span class="tunettl">DSP</span><button id="dspFlat" title="Zero all six PEQ bands">Flat EQ</button><button id="dspOff" title="Bypass every filter">Bypass all</button><label class="row note"><input type="checkbox" id="dspCurve" ${showDspCurve ? 'checked' : ''}> curve</label></div>
      <div class="dspgrid">${pass('hp', 'HPF', d.hp)}${pass('lp', 'LPF', d.lp)}${d.peq.map(band).join('')}</div></div>`;
  }
  function dspChanged() { applyDsp(); refreshSide(); clearTimeout(saveTimer); saveTimer = setTimeout(() => LS.set('shl.design', JSON.stringify(design)), 400); }
  function bindDspBar() {
    document.querySelectorAll('.dspc').forEach((card) => card.querySelectorAll('[data-f]').forEach((el) => {
      el.onchange = () => {
        const d = dspOf(design), k = card.dataset.k, o = k === 'peq' ? d.peq[+card.dataset.i] : d[k], f = el.dataset.f;
        commit();
        if (f === 'on') o.on = el.checked;
        else if (f === 'type') { o.type = el.value; if (o.type === 'LR' && o.order % 2) o.order += 1; }
        else if (f === 'order') o.order = +el.value;
        else {
          const v = parseFloat(el.value); if (!isFinite(v)) { el.value = o[f]; return; }
          o[f] = f === 'f' ? clamp(v, 5, 20000) : f === 'q' ? clamp(v, 0.1, 30) : clamp(v, -30, 30);
          if (!o.on && (k !== 'peq' || (f === 'g' && o.g))) o.on = true;     // editing a value switches the filter on
        }
        dspChanged();
      };
      if (el.type === 'text') el.onkeydown = (e) => {   // arrow keys nudge: Hz by 1/12 octave, dB by 0.5, Q by 0.1
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault();
        const up = e.key === 'ArrowUp', v = parseFloat(el.value) || 0, f = el.dataset.f;
        el.value = f === 'f' ? +(v * Math.pow(2, (up ? 1 : -1) / 12)).toFixed(1) : f === 'g' ? +(v + (up ? 0.5 : -0.5)).toFixed(1) : +Math.max(0.1, v + (up ? 0.1 : -0.1)).toFixed(2);
        el.onchange(); const again = document.querySelector(`.dspc[data-k="${card.dataset.k}"]${card.dataset.i != null ? `[data-i="${card.dataset.i}"]` : ''} [data-f="${f}"]`); if (again) again.focus();
      };
    }));
    if ($('dspCurve')) $('dspCurve').onchange = (e) => { showDspCurve = e.target.checked; LS.set('shl.dspCurve', showDspCurve ? '1' : '0'); drawChart(); refreshLegend(); };
    if ($('dspFlat')) $('dspFlat').onclick = () => { commit(); dspOf(design).peq.forEach((b) => { b.g = 0; b.on = false; }); dspChanged(); };
    if ($('dspOff')) $('dspOff').onclick = () => { commit(); const d = dspOf(design); d.hp.on = d.lp.on = false; d.peq.forEach((b) => { b.on = false; }); dspChanged(); };
  }
  function refreshLegend() {
    const cfg = chartCfg, el = $('legend');
    const parts = [];
    if (cfg && cfg.series) cfg.series.slice().reverse().forEach((s) => parts.push(`<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`));
    if (cfg && cfg.series2 && cfg.series2.legend) parts.push(`<span><i style="background:${cfg.series2.color}"></i>${cfg.series2.legend}</span>`);
    if (cfg && cfg.bands) parts.push(`<span><i style="background:${C.bad}"></i>Over Xmax</span>`);
    if (tab === 'decay') parts.push('<span>Long bright streaks = ringing (pipe or chamber resonance).</span>');
    if (tab === 'step') parts.push(`<span>${dspActive() ? 'Through the DSP filters' : 'Unfiltered (DSP off)'} · time from amplifier.</span>`);
    const pc = $('pwrCol'), showP = !!(R && R.Re), pwrTab = ['spl', 'exc', 'vel'].includes(tab);   // always on the left; it changes SPL, excursion and air velocity
    pc.hidden = !showP;
    if (showP) {
      if (!$('pwrRange')) pc.innerHTML = `<span class="pttl">Power</span>
        <span class="pnum"><input type="text" id="pwrNum" title="Type a wattage (2.5k works)">W</span>
        <div class="ptrack"><input type="range" id="pwrRange" min="0" max="4" step="0.005" title="Amplifier power into Re, 1 W to 10 kW (log scale). Applies to SPL, Excursion and Air velocity.">
          <div class="pticks"><span>10k</span><span>1k</span><span>100</span><span>10</span><span>1</span></div></div>`;
      $('pwrRange').value = Math.log10(pwrW).toFixed(3); $('pwrNum').value = +pwrW.toPrecision(3);
      pc.classList.toggle('idle', !pwrTab); pc.title = pwrTab ? '' : 'Power has no effect on this tab (the model is linear); it applies to SPL, Excursion and Air velocity.';
      if (pwrTab) parts.push(`<div class="pwrstat"><b>Power ${fmtW(pwrW)}</b> · <span id="pwrStat">${powerStatus()}</span></div>`);
    }
    parts.push(`<span style="flex:1"></span><button id="pinBtn" title="Keep this curve as a grey overlay to compare against">Pin curve</button>${pins.length ? '<button id="clrPins">Clear pins</button>' : ''}`);
    const dspTabs = ['spl', 'exc', 'gd', 'step', 'decay', 'vel'];
    parts.push(`<select id="fRangeSel" aria-label="Frequency range"><option value="20,500">20–500 Hz</option><option value="20,1000">20–1k Hz</option><option value="20,2000">20–2k Hz</option></select>`);
    const lower = [];   // DSP bar and target live at the top of the scrolling part of the panel
    if (R && dspTabs.includes(tab)) lower.push(dspBarHtml());
    if (tab === 'spl') {
      const T = design.target, run = !!tuneJob;
      lower.push(`<div class="tunebar"><span class="tunettl">Target</span>
        <button id="tgCur" ${run ? 'disabled' : ''} title="Put handles on the current response, then drag them">From current</button>
        <button id="tgFlat" ${run ? 'disabled' : ''}>Flat</button>
        ${T ? `<button id="tgClear" ${run ? 'disabled' : ''}>Clear</button>
        <label class="row"><input type="checkbox" id="tgKeep" ${T.keepSize !== false ? 'checked' : ''} ${run ? 'disabled' : ''}> keep outside size</label>
        <label class="row"><input type="checkbox" id="tgLevel" ${T.level ? 'checked' : ''} ${run ? 'disabled' : ''}> match level too</label>
        ${run ? '<button id="tgStop">Stop</button>' : '<button id="tgRun" class="primary" title="Redesign the cabinet to follow the target">Auto-tune re-design</button>'}` : '<span class="note">Drag the orange handles like EQ points; double-click to add or remove one.</span>'}
        <span id="tuneStatus" class="note">${T && R ? `Target miss now ${targetError(R.f, R.splRaw).toFixed(2)} dB RMS` : ''}</span></div>`);
    }
    el.innerHTML = parts.join('');
    $('legend2').innerHTML = lower.join(''); $('legend2').hidden = !lower.length;
    if ($('tgCur')) $('tgCur').onclick = () => { commit(); targetFromCurrent(); drawChart(); refreshLegend(); };
    if ($('tgFlat')) $('tgFlat').onclick = () => { commit(); targetFlat(); drawChart(); refreshLegend(); };
    if ($('tgClear')) $('tgClear').onclick = () => { commit(); design.target = null; drawChart(); refreshLegend(); };
    if ($('tgKeep')) $('tgKeep').onchange = (e) => { design.target.keepSize = e.target.checked; };
    if ($('tgLevel')) $('tgLevel').onchange = (e) => { design.target.level = e.target.checked; refreshLegend(); };
    if ($('tgRun')) $('tgRun').onclick = () => autoTune();
    if ($('tgStop')) $('tgStop').onclick = () => { if (tuneJob) tuneJob.stop = true; };
    const pr = $('pwrRange');
    if (pr) {
      const setW = (W, fromSlider) => {
        pwrW = clamp(W, 1, 10000);
        $('pwrNum').value = +pwrW.toPrecision(3); if (!fromSlider) pr.value = Math.log10(pwrW).toFixed(3);
        if ($('pwrStat')) $('pwrStat').innerHTML = powerStatus(); const b = document.querySelector('.pwrstat b'); if (b) b.textContent = 'Power ' + fmtW(pwrW); drawChart();
      };
      pr.oninput = () => setW(+Math.pow(10, +pr.value).toPrecision(2), true);
      $('pwrNum').onchange = (e) => { const v = parseFloat(String(e.target.value).replace(/k/i, 'e3')); if (v > 0) setW(v, false); };
    }
    bindDspBar();
    const fr = $('fRangeSel'); fr.value = fRange().join(','); fr.onchange = () => { design.fRange = fr.value.split(',').map(Number); drawChart(); };
    $('pinBtn').onclick = () => { if (!R) return; pins.push({ name: `${design.name} #${pins.length + 1}`, f: R.f, spl: R.spl.slice(), ze: R.ze.slice(), x: R.x.slice(), gd: R.gd.slice(), max: R.maxSpl.slice() }); if (pins.length > 5) pins.shift(); drawChart(); refreshLegend(); };
    if ($('clrPins')) $('clrPins').onclick = () => { pins = []; drawChart(); refreshLegend(); };
  }

  function stats() {
    const el = $('stats'); const items = [];
    if (R) {
      const f = R.f, band = f.map((v, i) => [v, R.spl[i]]).filter(([v]) => v >= 10 && v <= 300);
      const mx = Math.max(...band.map((b) => b[1]));
      const pass = band.filter((b) => b[1] > mx - 10).map((b) => b[1]).sort((a, b) => a - b);
      const ref = pass[Math.floor(pass.length / 2)];
      const lowX = (db) => { for (let i = 0; i < band.length; i++) if (band[i][1] >= ref - db) return band[i][0]; return NaN; };
      items.push(['Passband level', `${ref.toFixed(1)} dB`], ['−3 dB / −6 dB', `${lowX(3).toFixed(0)} / ${lowX(6).toFixed(0)} Hz`]);
      const hu = humpOf(R.f, R.splRaw); if (hu) items.push(['Low hump', `${hu.f.toFixed(1)} Hz · ${hu.db.toFixed(1)} dB`]);
      const xm = Math.max(...R.x.filter((_, i) => f[i] >= 15 && f[i] <= 300)); items.push([`Peak excursion`, `${xm.toFixed(2)} mm`]);
      const zmin = Math.min(...R.ze.filter((_, i) => f[i] <= 500)); items.push(['Min impedance', `${zmin.toFixed(2)} Ω`]);
      const ms = R.maxSpl.filter((v, i) => isFinite(v) && f[i] >= 40 && f[i] <= 100); if (ms.length && (R.Pe || R.Xmax)) items.push(['Max SPL 40–100 Hz', `${Math.min(...ms).toFixed(1)} dB`]);
    }
    if (A && A.paths && A.paths.length) { const P = A.paths[0]; items.push([`Path ${P.src.name} length`, fmtL(P.m.L)]); const e = P.ends; if (e) items.push([`Path ${P.src.name} start → end`, `${(e[0].S * 1e4).toFixed(0)} → ${(e[1].S * 1e4).toFixed(0)} cm²`]); }
    if (A && A.regions) A.regions.forEach((r) => { if (r && r.kind === 'chamber' && !r.unused) items.push(['Chamber', `${r.Vnet.toFixed(1)} L${r.fb ? ' · ' + r.fb.toFixed(0) + ' Hz' : ''}`]); });
    el.innerHTML = items.slice(0, 9).map(([a, b]) => `<div><span>${esc(a)}</span><b title="${esc(b)}">${esc(b)}</b></div>`).join('');
    el.hidden = !items.length;
  }

  // ---------------------------------------------------------------- inspector
  function numIn(id, val, attrs = '') { return `<input class="num" id="${id}" type="text" inputmode="decimal" value="${val}" ${attrs}>`; }

  // ---- sliders: live while dragging (no inspector rebuild), one undo step per drag
  let sliding = false;
  const r2 = (v) => Math.round(v * 100) / 100;
  function sliderRow(id, labelTxt, val, min, max, step, isAngle) {
    const shown = isAngle ? val.toFixed(1) : toU(val);
    return `<div class="sl"><label for="${id}">${labelTxt}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><input class="num" id="${id}_t" type="text" inputmode="decimal" value="${shown}" aria-label="${labelTxt || 'value'}"><span class="u">${isAngle ? '°' : USUF[unit()].trim()}</span></div>`;
  }
  function bindSlider(id, apply, isAngle, root) {
    const r = (root || document).querySelector('#' + CSS.escape(id)), tbox = (root || document).querySelector('#' + CSS.escape(id + '_t'));
    if (!r) return;
    const start = () => { if (!sliding) { commit(); sliding = true; } };
    r.addEventListener('pointerdown', start); r.addEventListener('keydown', start);
    r.addEventListener('input', () => { start(); const v = +r.value; apply(isAngle ? v : roundStep(v)); if (tbox) tbox.value = isAngle ? v.toFixed(1) : toU(roundStep(v)); liveChanged(); });
    r.addEventListener('change', () => { sliding = false; changed(); });
    if (tbox) tbox.addEventListener('change', () => { commit(); apply(isAngle ? +tbox.value : parseL(tbox.value)); changed(); });
  }
  function pivotOf(p) { const g = design.growFrom || 'start'; return g === 'end' ? { x: p.x2, y: p.y2, f: 1 } : g === 'center' ? { x: (p.x1 + p.x2) / 2, y: (p.y1 + p.y2) / 2, f: 0.5 } : { x: p.x1, y: p.y1, f: 0 }; }
  function setPanelLength(p, Lnew) {
    Lnew = Math.max(gridStep(), Lnew);
    const L = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1, ux = (p.x2 - p.x1) / L, uy = (p.y2 - p.y1) / L, pv = pivotOf(p);
    p.x1 = r2(pv.x - ux * Lnew * pv.f); p.y1 = r2(pv.y - uy * Lnew * pv.f); p.x2 = r2(p.x1 + ux * Lnew); p.y2 = r2(p.y1 + uy * Lnew);
  }
  function setPanelAngle(p, deg) {
    const L = hyp(p.x2 - p.x1, p.y2 - p.y1), a = deg * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a), pv = pivotOf(p);
    p.x1 = r2(pv.x - ux * L * pv.f); p.y1 = r2(pv.y - uy * L * pv.f); p.x2 = r2(p.x1 + ux * L); p.y2 = r2(p.y1 + uy * L);
  }
  // driver position along the board it sits on
  function driverBoard(d) {
    const mp = d.mount && design.panels.find((q) => q.id === d.mount.pid);
    if (mp) { const L = hyp(mp.x2 - mp.x1, mp.y2 - mp.y1) || 1; return { p: mp, L, u: d.mount.f * L }; }
    const b = nearestPanel(d.x, d.y); if (!b) return null; const p = b.p, L = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1; return { p, L, u: hyp(b.n.x - p.x1, b.n.y - p.y1) };
  }
  function setDriverPos(d, u) {
    const b = driverBoard(d); if (!b) return; const p = b.p; u = clamp(u, 0, b.L);
    d.x = r2(p.x1 + (p.x2 - p.x1) / b.L * u); d.y = r2(p.y1 + (p.y2 - p.y1) / b.L * u);
    if (d.mount) d.mount.f = u / b.L; else mountDriver(d);
  }
  function partsList() {
    const names = partNames();
    const arcRows = (design.arcs || []).map((g, i) => { const G = arcGeom(g); return `<div class="prow"><button class="pname" data-aid="${g.id}" title="Select curved board ${i + 1}">Curved board ${i + 1}</button><span class="note">${G.c ? 'R ' + fmtL(G.c.r) + ' · ' + (Math.abs(G.sweep) * 180 / Math.PI).toFixed(0) + '° · ' : ''}${fmtL(G.len)} long</span></div>`; });
    const rows = design.panels.filter((p) => !p.arc).map((p) => {
      const L = hyp(p.x2 - p.x1, p.y2 - p.y1);
      return `<div class="prow"><button class="pname" data-pid="${p.id}" title="Select ${esc(names.get(p.id))}">${esc(names.get(p.id))}${p.role ? '' : ' <span class="auto">auto</span>'}</button>${sliderRow('pl' + p.id, '', L, gridStep(), Math.max(L * 2, L + 600), gridStep())}</div>`;
    });
    const drows = design.drivers.map((d) => {
      const b = driverBoard(d); if (!b) return '';
      return `<div class="prow"><button class="pname" data-did="${d.id}">Driver on ${esc(names.get(b.p.id))}</button>${sliderRow('dp' + d.id, '', b.u, 0, b.L, gridStep())}</div>`;
    });
    return { html: rows.join('') + arcRows.join('') + drows.join(''), wire: (root) => {
      design.panels.filter((p) => !p.arc).forEach((p) => bindSlider('pl' + p.id, (v) => setPanelLength(p, v), false, root));
      root.querySelectorAll('[data-aid]').forEach((b) => b.onclick = () => { sel = [{ t: 'arc', id: +b.dataset.aid }]; refreshSide(); draw(); });
      design.drivers.forEach((d) => bindSlider('dp' + d.id, (v) => setDriverPos(d, v), false, root));
      root.querySelectorAll('[data-pid]').forEach((b) => b.onclick = () => { sel = [{ t: 'panel', id: +b.dataset.pid }]; refreshSide(); draw(); });
      root.querySelectorAll('[data-did]').forEach((b) => b.onclick = () => { sel = [{ t: 'driver', id: +b.dataset.did }]; refreshSide(); draw(); });
    } };
  }
  /** Cabinet width (the dimension into the screen) lives in the pinned top of the side panel, so it is always in reach. */
  function widthBar() {
    const el = $('widthBar'); if (!el) return;
    const wr = widthRange(), u = snapMode().unit;
    const out = design.W < wr.min ? `Narrower than the driver + 1" (${toU(wr.min)} ${u}); moving the slider brings it into range.`
      : design.W > wr.max ? `Wider than 2 × the driver (${toU(wr.max)} ${u}); moving the slider brings it into range.` : '';
    el.title = 'Inside width of the cabinet: how far the side view extends into the screen. The driver sets the limits: its frame + 1" up to 2 × its frame. A new design starts at frame + 3".';
    el.innerHTML = sliderRow('dsWs', 'Cabinet width', design.W, wr.min, wr.max, snapMode().step) +
      `<span class="wrange${out ? ' warn' : ''}" id="wRange">${out || `outside ${toU(design.W + 2 * design.t)} · range ${toU(wr.min)}–${toU(wr.max)} ${u}`}</span>`;
    bindSlider('dsWs', (v) => {
      const r = widthRange(); design.W = Math.min(r.max, Math.max(r.min, v));
      const t = $('wRange'); if (t) { t.className = 'wrange'; t.textContent = `outside ${toU(design.W + 2 * design.t)} · range ${toU(r.min)}–${toU(r.max)} ${snapMode().unit}`; }
    }, false, el);
  }
  function refreshSide() { drawChart(); refreshLegend(); stats(); if (!sliding) { widthBar(); inspector(); } }
  function inspector() {
    const el = $('insp'); let h = '';
    const one = sel.length === 1 ? sel[0] : null;
    if (one && one.t === 'panel') {
      const p = design.panels.find((q) => q.id === one.id); if (!p) { sel = []; return inspector(); }
      const names = partNames(), pi = partInfo(p.id);
      const L = hyp(p.x2 - p.x1, p.y2 - p.y1), ang = Math.atan2(p.y2 - p.y1, p.x2 - p.x1) * 180 / Math.PI;
      const mx = (p.x1 + p.x2) / 2, my = (p.y1 + p.y2) / 2, span = Math.max(600, L);
      h += `<h3>${esc(names.get(p.id))} <span class="pill">${fmtL(L)} × ${fmtL(design.W)} × ${fmtL(p.t || design.t, isIn() ? 3 : 1)}</span></h3>
        <div class="grid2">
          <label>Name <input type="text" id="pName" value="${esc(p.name || '')}" placeholder="${esc(names.get(p.id))}"></label>
          <label>Role <select id="pRole"><option value="">Auto (${esc(pi ? pi.auto : '—')})</option>${HG.ROLES.map((r) => `<option value="${r}">${cap(r)}</option>`).join('')}</select></label>
        </div>
        <div class="note">${pi ? `Deduced: <b>${esc(cap(pi.auto))}</b>, because ${esc(pi.why || 'nothing else matched')}.` : ''} ${p.role ? 'Your label overrides that.' : 'Pick a role to override it.'}</div>
        ${sliderRow('slLen', 'Length', L, gridStep(), Math.max(L * 2, L + 600), gridStep())}
        <div class="row note">Length and angle change from <select id="growFrom"><option value="start">the start end</option><option value="center">the middle</option><option value="end">the far end</option></select></div>
        ${sliderRow('slAng', 'Angle', ang, -180, 180, 0.5, true)}
        ${sliderRow('slMx', 'Move left / right', mx, mx - span, mx + span, gridStep())}
        ${sliderRow('slMy', 'Move down / up', my, my - span, my + span, gridStep())}
        <div class="grid2"><label>Thickness (blank = ${fmtL(design.t, isIn() ? 3 : 1)}) ${numIn('pT', p.t ? toU(p.t) : '')}</label></div>
        <div class="note">You can type 3/4in, 19mm, 2.5cm or 1 1/2" in any box. Sliders step by the grid (${snapMode().label}).</div>
        <div class="row"><button id="pDel">Delete board</button></div>`;
      el.innerHTML = h;
      $('pRole').value = p.role || ''; $('growFrom').value = design.growFrom || 'start';
      $('pRole').onchange = (e) => { commit(); p.role = e.target.value || undefined; changed(); };
      $('pName').onchange = (e) => { commit(); p.name = e.target.value.trim() || undefined; changed(); };
      $('growFrom').onchange = (e) => { design.growFrom = e.target.value; };
      bindSlider('slLen', (v) => setPanelLength(p, v));
      bindSlider('slAng', (v) => setPanelAngle(p, v), true);
      bindSlider('slMx', (v) => { const d = v - (p.x1 + p.x2) / 2; p.x1 = r2(p.x1 + d); p.x2 = r2(p.x2 + d); });
      bindSlider('slMy', (v) => { const d = v - (p.y1 + p.y2) / 2; p.y1 = r2(p.y1 + d); p.y2 = r2(p.y2 + d); });
      $('pT').onchange = (e) => { commit(); const v = e.target.value.trim(); p.t = v ? parseL(v) : undefined; changed(); };
      $('pDel').onclick = deleteSel; return;
    }
    if (one && one.t === 'arc') {
      const g = (design.arcs || []).find((q) => q.id === one.id); if (!g) { sel = []; return inspector(); }
      const G = arcGeom(g), deg = Math.abs(G.sweep) * 180 / Math.PI, chord = hyp(g.b.x - g.a.x, g.b.y - g.a.y), tt = g.t || design.t;
      const n = (design.arcs || []).indexOf(g) + 1, plies = Math.ceil(tt / 3);
      h += `<h3>Curved board ${n} <span class="pill">${G.c ? 'R ' + fmtL(G.c.r) + ' · ' + deg.toFixed(0) + '°' : 'straight'}</span></h3>
        <div class="note">Centre-line length <b>${fmtL(G.len)}</b> (the ply's bent length), chord ${fmtL(chord)}, ${fmtL(tt, isIn() ? 3 : 1)} thick × ${fmtL(design.W)} wide.
          Make it from ${plies} × 3 mm bending ply glued over formers, or ${Math.max(2, Math.round(G.len / 150))} or more 18 mm formers cut to the curve across the width.</div>
        ${G.c ? sliderRow('slArcR', 'Radius', G.c.r, Math.max(chord / 2 + 1, 10), Math.max(chord * 3, G.c.r * 2), gridStep()) : ''}
        <div class="grid2"><label>Thickness (blank = ${fmtL(design.t, isIn() ? 3 : 1)}) ${numIn('arcT', g.t ? toU(g.t) : '')}</label>
          <label>Role <select id="arcRole"><option value="">Auto</option>${HG.ROLES.map((r) => `<option value="${r}">${cap(r)}</option>`).join('')}</select></label></div>
        <div class="row"><button id="arcFlip">Bend the other way</button><button id="arcStraight">Make it straight</button><button id="arcDel">Delete curved board</button></div>
        <div class="note">Drag the square end handles to move its ends, the round handle to bend it, or the board itself to move it. It's simulated as ${Math.max(1, arcPts(g).length - 1)} short straight pieces.</div>`;
      el.innerHTML = h;
      $('arcRole').value = g.role || '';
      $('arcRole').onchange = (e) => { commit(); g.role = e.target.value || undefined; changed(); };
      $('arcT').onchange = (e) => { commit(); const v = e.target.value.trim(); g.t = v ? parseL(v) : undefined; changed(); };
      const setR = (r) => {   // keep the ends, put the bend point on the same side at the new radius
        const cx = (g.a.x + g.b.x) / 2, cy = (g.a.y + g.b.y) / 2, half = hyp(g.b.x - g.a.x, g.b.y - g.a.y) / 2; r = Math.max(r, half + 0.5);
        const mm = arcMid(g), ux = -(g.b.y - g.a.y) / (2 * half), uy = (g.b.x - g.a.x) / (2 * half), side = Math.sign((mm.x - cx) * ux + (mm.y - cy) * uy) || 1;
        const big = Math.abs(arcGeom(g).sweep) > Math.PI, sag = big ? r + Math.sqrt(r * r - half * half) : r - Math.sqrt(r * r - half * half);
        g.m = { x: rr2(cx + ux * side * sag), y: rr2(cy + uy * side * sag) };
      };
      if (G.c) bindSlider('slArcR', setR);
      $('arcFlip').onclick = () => { commit(); const cx = (g.a.x + g.b.x) / 2, cy = (g.a.y + g.b.y) / 2, mm = arcMid(g); g.m = { x: rr2(2 * cx - mm.x), y: rr2(2 * cy - mm.y) }; changed(); };
      $('arcStraight').onclick = () => { commit(); design.panels.push({ id: nid(), x1: g.a.x, y1: g.a.y, x2: g.b.x, y2: g.b.y, t: g.t }); design.arcs = design.arcs.filter((q) => q.id !== g.id); sel = []; changed(); };
      $('arcDel').onclick = deleteSel; return;
    }
    if (one && one.t === 'path') {
      const p = design.paths.find((q) => q.id === one.id); if (!p) { sel = []; return inspector(); }
      const P = A && A.paths && A.paths.find((q) => q.src.id === p.id);
      const ends = P && P.ends ? P.ends : [];
      const endTxt = (e) => !e ? '—' : e.kind === 'open' ? '<span class="pill air">radiates (mouth)</span>' : e.kind === 'closed' ? '<span class="pill">closed</span>' : e.kind === 'chamber' ? `<span class="pill ch">into chamber${e.endCorr ? ' + end correction' : ''}</span>` : `<span class="pill path">joins path ${nameOf(e.path)}</span>`;
      h += `<h3>Air path ${esc(p.name)} <span class="pill path">${P ? fmtL(P.m.L) : ''}</span></h3>
        <div class="note">Start: ${endTxt(ends[0])} ${ends[0] ? (ends[0].S * 1e4).toFixed(0) + ' cm²' : ''}<br>End: ${endTxt(ends[1])} ${ends[1] ? (ends[1].S * 1e4).toFixed(0) + ' cm²' : ''}</div>
        <div class="grid2">
          <label>Name <input type="text" id="pathName" value="${esc(p.name)}"></label>
          <label>Wall-loss multiplier ${numIn('pathLoss', p.loss != null ? p.loss : 1)}</label>
          <label>Start end correction <select id="ecS"><option value="auto">auto</option><option value="on">on</option><option value="off">off</option></select></label>
          <label>End end correction <select id="ecE"><option value="auto">auto</option><option value="on">on</option><option value="off">off</option></select></label>
        </div>
        <div class="note">${p.auto ? '<b>Found automatically</b> from the boards; it re-routes whenever you move a board. Dragging one of its points makes it yours.' : '<b>Drawn by hand</b>; the program will not change it.'}</div>
        <div class="row">${p.auto ? '<button id="pathKeep">Keep this shape</button>' : (design.autoPaths ? '<button id="pathAuto">Let the program route it</button>' : '')}</div>
        <div class="row"><button id="pathCenter">Centre in channel</button><button id="pathRev">Reverse direction</button><button id="pathDel">Delete path</button></div>
        <div class="note">The cross-section is measured every 8 mm by casting rays from the centre-line to the nearest boards on each side, × the internal width (${fmtL(design.W)}). An end that sits in a narrow duct opening into a larger chamber gets Hornresp's inner end correction (auto). Loss multiplier only applies when wall losses are on.</div>`;
      el.innerHTML = h;
      $('ecS').value = p.ecStart || 'auto'; $('ecE').value = p.ecEnd || 'auto';
      $('ecS').onchange = (e) => { commit(); p.ecStart = e.target.value; changed(); };
      $('ecE').onchange = (e) => { commit(); p.ecEnd = e.target.value; changed(); };
      $('pathName').onchange = (e) => { commit(); p.name = e.target.value || p.name; changed(); };
      $('pathLoss').onchange = (e) => { commit(); p.loss = +e.target.value || 0; changed(); };
      $('pathCenter').onclick = () => { commit(); centerPath(p); changed(); };
      $('pathRev').onclick = () => { commit(); p.pts.reverse(); changed(); };
      if ($('pathKeep')) $('pathKeep').onclick = () => { commit(); p.auto = false; changed(); };
      if ($('pathAuto')) $('pathAuto').onclick = () => { commit(); p.auto = true; changed(); };
      $('pathDel').onclick = deleteSel; return;
    }
    if (one && one.t === 'driver') {
      const d = design.drivers.find((q) => q.id === one.id); if (!d) { sel = []; return inspector(); }
      const s = specOf(d.key) || {}, di = A && A.driverInfo && A.driverInfo.find((q) => q.d.id === d.id);
      const side = (sd) => !sd ? '—' : sd.kind === 'air' ? '<span class="pill air">open air</span>' : sd.kind === 'chamber' ? `<span class="pill ch">chamber ${A.regions[sd.label] ? A.regions[sd.label].Vnet.toFixed(1) + ' L' : ''}</span>` : sd.kind === 'path' ? `<span class="pill path">path ${nameOf(sd.path)} at ${fmtL(sd.s)}</span>` : '<span class="pill bad">blocked by a board</span>';
      const ts = HC.driverToTS(hrOf(d.key) || { Sd: 855, Mmd: 200, Cms: 1e-4, Rms: 5, Re: 5, Bl: 20 });
      const fields = [['Fs', 'Hz'], ['Qes', ''], ['Qms', ''], ['Vas', 'L'], ['Re', 'Ω'], ['Le', 'mH'], ['Sd', 'cm²'], ['Mms', 'g'], ['Bl', 'T·m'], ['Xmax', 'mm'], ['Pe', 'W']];
      h += `<h3>Driver <span class="pill">${esc(label(s))}</span></h3>
        <div class="note">Front → ${side(di && di.front)} &nbsp; Rear → ${side(di && di.rear)}</div>
        <div class="grid2">
          <label>Count at this spot ${numIn('dN', d.n || 1)}</label>
          <label>Wiring <select id="dWire"><option value="parallel">parallel</option><option value="series">series</option></select></label>
          <label>Displacement subtracted (L) ${numIn('dDisp', d.disp != null ? d.disp : '')}</label>
          <label>Mounting <select id="dMount"><option value="front">Front mount (flange on the firing face)</option><option value="rear">Rear mount (fitted from inside)</option></select></label>
          <label>Source <input type="text" value="${esc(s.src || 'custom')}" disabled></label>
        </div>
        ${(() => { const b = driverBoard(d); return b ? sliderRow('dPos', 'Position on ' + esc(partNames().get(b.p.id)), b.u, 0, b.L, gridStep()) : ''; })()}
        <div class="row"><button id="dFlip" title="Or drag the woofer's basket across the board">Basket to other side (F)</button><button id="dUse">Use this driver for new drivers</button><button id="dDel">Delete</button>${s.user ? '<button id="dForget" title="Remove it from your User drivers (designs that use it keep their copy)">Forget imported driver</button>' : ''}</div>
        <table class="ts"><tbody>${fields.map(([k, u]) => `<tr><td>${k}${u ? ' (' + u + ')' : ''}</td><td><input id="ts_${k}" type="text" value="${s[k] != null ? s[k] : ''}"></td></tr>`).join('')}</tbody></table>
        ${(() => { const a = s.adv || {}; const f = (id, lab, v) => `<tr><td>${lab}</td><td><input id="${id}" type="text" value="${v != null ? v : ''}"></td></tr>`;
          return `<details class="adv" ${a.semi || a.fdd ? 'open' : ''}><summary>Advanced driver model (Hornresp)</summary>
          <label class="row note"><input type="checkbox" id="advSemi" ${a.semi ? 'checked' : ''}> Semi-inductance voice coil (Thorborg &amp; Futtrup)</label>
          <table class="ts"><tbody>${f('adv_Rep', "Re' (Ω)", a.Rep)}${f('adv_Leb', 'Leb free (mH)', a.Leb)}${f('adv_Le2', 'Le bound (mH)', a.Le2)}${f('adv_Ke', 'Ke (sH)', a.Ke)}${f('adv_Rss', 'Rss (Ω)', a.Rss)}</tbody></table>
          <label class="row note"><input type="checkbox" id="advFdd" ${a.fdd ? 'checked' : ''}> Frequency-dependent damping (FDD)</label>
          <table class="ts"><tbody>${f('adv_Rms2', 'Rms FDD (N·s/m)', a.Rms2)}${f('adv_Ams', 'Ams (m/N)', a.Ams)}</tbody></table>
          <div class="note">Voice coil: Ze = Re' + jωLeb + [ jωLe ∥ Ke√(jω) ∥ Rss ]. FDD adds 1/(ω·Ams) to the cone's damping. A zero value leaves that element out. These come from a Hornresp file or an impedance-curve fit; with the boxes unticked the plain Re + Le model is used.</div></details>`; })()}
        <div class="note">Simulated with Mmd ${hrOf(d.key) ? hrOf(d.key).Mmd.toFixed(1) : '—'} g · Cms ${hrOf(d.key) ? hrOf(d.key).Cms.toExponential(3) : '—'} m/N · Rms ${hrOf(d.key) ? hrOf(d.key).Rms.toFixed(2) : '—'} kg/s · Qts ${ts.Qts.toFixed(3)}. Editing a value makes a design-local copy of this driver. ${s.prof ? 'Body outline traced from the manufacturer\'s technical drawing.' : driverDims(d.key).measured ? 'Body size from the drawing / spec sheet dimensions (no traceable side view).' : 'Body shape estimated from Sd (no drawing data).'}</div>`;
      el.innerHTML = h;
      $('dWire').value = d.wiring || 'parallel';
      $('dMount').value = d.mountStyle === 'rear' ? 'rear' : 'front';
      $('dMount').onchange = (e) => { setMount(d, e.target.value); };
      bindSlider('dPos', (v) => setDriverPos(d, v));
      $('dN').onchange = (e) => { commit(); d.n = Math.max(1, parseInt(e.target.value) || 1); changed(); };
      $('dWire').onchange = (e) => { commit(); d.wiring = e.target.value; changed(); };
      $('dDisp').onchange = (e) => { commit(); const v = e.target.value.trim(); d.disp = v === '' ? undefined : +v; changed(); };
      $('dFlip').onclick = () => { commit(); d.nx = -d.nx; d.ny = -d.ny; if (d.mount) d.mount.side = -d.mount.side; changed(); };
      $('dUse').onclick = () => { design.driverKey = d.key; setPickerText(); flash('New drivers will use ' + label(s)); };
      $('dDel').onclick = deleteSel;
      if ($('dForget')) $('dForget').onclick = () => { LS.set(USER_KEY, JSON.stringify(loadUserDrivers().filter((x) => x.k !== d.key))); const i = LIB.findIndex((x) => x.k === d.key); if (i >= 0) LIB.splice(i, 1); LIBMAP.delete(d.key); flash('Removed from your User drivers; this design keeps its copy.'); inspector(); };
      const editable = () => {   // copy-on-write: edits make a design-local copy of the driver
        let key = d.key;
        if (!design.custom[key]) { const copy = JSON.parse(JSON.stringify({ ...s, src: 'edited', k: 'custom:' + (s.b || '') + ' ' + (s.m || 'driver') + ' (edited)' })); key = copy.k; design.custom[key] = copy; for (const q of design.drivers) if (q.key === d.key) q.key = key; }
        return design.custom[key];
      };
      const advSet = (k, v) => { commit(); const e = editable(); e.adv = { ...(e.adv || {}) }; e.adv[k] = v; changed(); };
      $('advSemi').onchange = (e) => { const ed = editable(); if (e.target.checked && !(ed.adv && ed.adv.Rep)) { advSet('Rep', ed.Re); advSet('Leb', ed.Le || 0); } advSet('semi', e.target.checked); };
      $('advFdd').onchange = (e) => advSet('fdd', e.target.checked);
      for (const k of ['Rep', 'Leb', 'Le2', 'Ke', 'Rss', 'Rms2', 'Ams']) $('adv_' + k).onchange = (e) => advSet(k, e.target.value === '' ? undefined : +e.target.value);
      for (const [k] of fields) $('ts_' + k).onchange = (e) => {
        commit();
        let key = d.key;
        if (!design.custom[key]) { const copy = { ...s, src: 'edited', k: 'custom:' + (s.b || '') + ' ' + (s.m || 'driver') + ' (edited)' }; key = copy.k; design.custom[key] = copy; for (const q of design.drivers) if (q.key === d.key) q.key = key; }
        design.custom[key][k] = e.target.value === '' ? undefined : +e.target.value;
        if (k === 'Vas' || k === 'Fs') { /* keep Mms consistent with Vas when user edits compliance */ if (k === 'Vas') design.custom[key].Mms = undefined; }
        changed();
      };
      return;
    }
    if (sel.length > 1) { el.innerHTML = `<h3>${sel.length} items selected</h3><div class="note">Drag to move them together, arrow keys nudge 1 mm (Shift: 10 mm), Ctrl+D duplicates, Del deletes.</div>`; return; }
    // parts list (every board as a slider), then design settings
    const pl = partsList();
    h += `<h3>Parts <label class="row" style="text-transform:none;letter-spacing:0;font-weight:500"><input type="checkbox" id="showLbl"> always show names</label></h3>
      <div class="parts">${pl.html || '<div class="note">No boards yet. Pick the board tool (P) and drag a line on the grid.</div>'}</div>
      <div class="note">Slide to change a board's length (it grows from its start end; select a board for angle, position and which end it grows from). Hover a board's middle for its name, anywhere else on it for its length. Names marked <span class="auto">auto</span> were worked out from the drawing; click one and choose a role to override.</div>`;
    h += `<h3>Design <span class="pill">${esc(design.name)}</span></h3>
      <div class="grid2">
        <label>Name <input type="text" id="dsName" value="${esc(design.name)}"></label>
        <label>Board thickness ${numIn('dsT', toU(design.t))}</label>
        <label>Material <select id="dsMat"><option value="birch">Baltic birch</option><option value="mdf">MDF</option></select></label>
        <label>Radiation space <select id="dsSpace"><option value="0.5">4π free space</option><option value="1">2π on the floor</option><option value="2">1π floor + wall</option><option value="4">½π corner</option></select></label>
        <label>Vent leakage QL ${numIn('dsQL', design.QL)}</label>
        <label>Quantize the build (mm · degrees) <span class="row" style="flex-wrap:nowrap">${numIn('dsQmm', design.qMm || 1)}${numIn('dsQdeg', design.qDeg || 5)}<button id="dsQuant" title="Round every board end to the mm grid and every board angle to the degree step, keeping joints joined">Quantize</button></span></label>
        <label>Move the low hump to (Hz) <span class="row" style="flex-wrap:nowrap">${numIn('dsHump', design.humpTarget || 35)}<button id="dsTune" title="Resize the side view (boards, path, driver) until the hump lands here">Tune</button></span></label>
        <label>Wall friction losses <select id="dsLoss"><option value="0">off (Hornresp)</option><option value="1">on (Kirchhoff)</option></select></label>
      </div>
      <label class="row note"><input type="checkbox" id="dsAutoPath"> Find air paths automatically from the boards (mouths and vents)</label>
      <label class="row note"><input type="checkbox" id="dsAuto"> Centre hand-drawn paths in their channel</label>
      <div class="note">Responses are at 1 W into Re (${(+design.eg).toFixed(2)} V); use the Power slider on the SPL tab for louder drive. Model: plane-wave horn segments, lumped chambers, piston radiation, power-response SPL — the same model as Hornresp (validated against your 15BG100 horn exports to 0.00 dB).</div>
      <div class="note"><b>Keys</b> <span class="kbd">V</span> select <span class="kbd">P</span> board <span class="kbd">R</span> box <span class="kbd">A</span> air path <span class="kbd">D</span> driver <span class="kbd">B</span> divider <span class="kbd">X</span> board face <span class="kbd">F</span> flip driver <span class="kbd">0</span> fit <span class="kbd">Ctrl Z</span> undo · right-drag or Space-drag pans · wheel zooms</div>`;
    el.innerHTML = h;
    pl.wire(el);
    $('showLbl').checked = !!design.labelsAlways; $('showLbl').onchange = (e) => { design.labelsAlways = e.target.checked; draw(); };
    $('dsMat').value = design.material; $('dsSpace').value = String(design.space); $('dsLoss').value = design.losses ? '1' : '0'; $('dsAuto').checked = !!design.autoCenter;
    const on = (id, fn) => $(id).onchange = (e) => { commit(); fn(e.target); changed(); };
    on('dsName', (t) => design.name = t.value || 'Untitled');
    on('dsT', (t) => design.t = Math.max(3, parseL(t.value)));
    on('dsMat', (t) => design.material = t.value);
    on('dsSpace', (t) => design.space = +t.value);
    on('dsQL', (t) => design.QL = +t.value || 0);
    on('dsLoss', (t) => design.losses = t.value === '1');
    $('dsQuant').onclick = () => { const mm = Math.max(0.1, +$('dsQmm').value || 1), dg = Math.max(0.5, +$('dsQdeg').value || 5); design.qMm = mm; design.qDeg = dg; quantizeBuild(mm, dg); };
    $('dsTune').onclick = () => { const v = +$('dsHump').value; if (v > 10 && v < 200) { design.humpTarget = v; tuneHump(v); } };
    on('dsAuto', (t) => design.autoCenter = t.checked);
    $('dsAutoPath').checked = !!design.autoPaths;
    on('dsAutoPath', (t) => { design.autoPaths = t.checked; design.autoMute = []; renderTools(); });
  }

  // ---------------------------------------------------------------- driver picker
  function setPickerText() { const s = specOf(design.driverKey); $('drvSearch').value = s ? label(s) : ''; }
  const BRANDS = { bc: /^B&C/i, eminence: /^Eminence/i, faital: /^Faital/i, lavoce: /^Lavoce/i, celestion: /^Celestion/i, beyma: /^Beyma/i };
  const nominal = (d) => {
    if (d.size) return +d.size;
    const dc = 2 * Math.sqrt((d.Sd || 0) / Math.PI) / 2.54;   // effective cone dia, inches
    return [6.5, 8, 10, 12, 15, 18, 21].reduce((a, b) => Math.abs(b * 0.82 - dc) < Math.abs(a * 0.82 - dc) ? b : a, 8);
  };
  const squash = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');   // "B&C 18SW115-4" -> "bc18sw1154"
  const TS_GET = { fs: (d) => d.Fs, qts: (d) => (d.Qes && d.Qms ? d.Qes * d.Qms / (d.Qes + d.Qms) : d.Qts), qes: (d) => d.Qes, qms: (d) => d.Qms, vas: (d) => d.Vas,
    xmax: (d) => d.Xmax, pe: (d) => d.Pe, re: (d) => d.Re, sd: (d) => d.Sd, bl: (d) => d.Bl, mms: (d) => d.Mms, le: (d) => d.Le };
  /** One search word -> a test on a driver. A word can be text (brand or model; case, spaces and punctuation don't
   *  matter), a size (18" or 18in), an impedance (8ohm), neo / ferrite, or a T/S limit (fs<35, xmax>=10, qts<0.4, pe>1000). */
  function searchTest(tok) {
    let m;
    if ((m = /^(fs|qts|qes|qms|vas|xmax|pe|re|sd|bl|mms|le)(<=|>=|<|>|=)(\d*\.?\d+)$/.exec(tok))) {
      const get = TS_GET[m[1]], op = m[2], v = +m[3];
      return { kind: 'ts', test: (d) => { const x = get(d); return x != null && isFinite(x) && (op === '<' ? x < v : op === '<=' ? x <= v : op === '>' ? x > v : op === '>=' ? x >= v : Math.abs(x - v) <= Math.max(0.5, v * 0.02)); } };
    }
    if ((m = /^(\d+(?:\.\d+)?)(?:"|”|''|in|inch)$/.exec(tok))) { const n = +m[1]; return { kind: 'size', test: (d) => Math.abs(nominal(d) - n) < 0.6 }; }
    if ((m = /^(\d+)(?:ohms?|ω|r)$/.exec(tok))) {
      const n = +m[1], re = new RegExp('(^|[^0-9])' + n + '\\s*Ω');
      return { kind: 'ohm', test: (d) => re.test(d.m || '') || (!/Ω/.test(d.m || '') && d.Re >= n * 0.58 && d.Re <= n * 0.98) };
    }
    if (/^(neo|neodymium)$/.test(tok)) return { kind: 'mag', test: (d) => magType(d) === 'neo' };
    if (/^(ferrite|ceramic)$/.test(tok)) return { kind: 'mag', test: (d) => magType(d) === 'ferrite' };
    const sq = squash(tok);
    if (!sq) return { kind: 'none', test: () => true };
    const asSize = /^(8|10|12|15|18|21|24)$/.test(tok) ? +tok : 0;
    return { kind: 'text', sq, test: (d) => squash(`${d.b} ${d.m} ${d.src || ''}`).includes(sq) || (asSize && Math.round(nominal(d)) === asSize) };
  }
  function pickerList(q) {
    const seenK = new Set(), all = [...Object.values(design.custom || {}), ...LIB].filter((d) => d && !seenK.has(d.k) && seenK.add(d.k));
    const tests = q.toLowerCase().replace(/\s*(<=|>=|<|>|=)\s*/g, '$1').split(/\s+/).filter(Boolean).map(searchTest);
    const brand = $('drvBrand').value, size = $('drvSize').value;
    let res = all.filter((d) => tests.every((t) => t.test(d)));
    if (brand === 'user') res = res.filter((d) => d.user || /^User import/.test(d.src || ''));
    else if (brand) res = res.filter((d) => BRANDS[brand].test(d.b || '') && /^PE|datasheet/.test(d.src || ''));   // Parts Express + manufacturer sheets
    if (size === 'all8') res = res.filter((d) => nominal(d) >= 8 && nominal(d) <= 24);
    else if (size) res = res.filter((d) => Math.round(nominal(d)) === +size);
    const rank = (d) => (/^PE|datasheet/.test(d.src || '') ? 0 : /WinISD/.test(d.src || '') ? 1 : 2);
    const rank2 = (d) => (d.user ? -1 : rank(d));
    const words = tests.filter((t) => t.kind === 'text').map((t) => t.sq);
    const rel = (d) => { if (!words.length) return 0; const mdl = squash(d.m); return words.some((w) => mdl.startsWith(w)) ? 0 : words.some((w) => mdl.includes(w)) ? 1 : 2; };   // model matches before brand / source matches
    const byName = (a, b) => (a.b + a.m).localeCompare(b.b + b.m);
    res.sort(brand || size || tests.some((t) => t.kind !== 'text') ? (a, b) => rel(a) - rel(b) || nominal(a) - nominal(b) || rank2(a) - rank2(b) || byName(a, b) : (a, b) => rel(a) - rel(b) || rank2(a) - rank2(b) || byName(a, b));
    pickTotal = res.length;
    return res.slice(0, brand || tests.length ? 400 : 80);
  }
  let pickTotal = 0;
  let pickHi = 0, pickRes = [];
  function showPicker() {
    const q = $('drvSearch').value;
    pickRes = pickerList(q === label(specOf(design.driverKey)) ? '' : q);
    const el = $('drvList'), cur = specOf(design.driverKey);
    const srcTag = (d) => (d.user || /^User import/.test(d.src || '') ? 'yours' : /spec sheet/.test(d.src || '') ? 'spec sheet' : /product page/.test(d.src || '') ? 'Parts Express' : /datasheet/.test(d.src || '') ? 'maker' : /WinISD/.test(d.src || '') ? 'WinISD' : (d.src || ''));
    const num = (v, dp) => (v == null || !isFinite(v) ? '' : (+v).toFixed(dp));
    const row = (d, i) => `<div class="${i === pickHi ? 'hi' : ''}${d.k === design.driverKey ? ' cur' : ''}" data-i="${i}" title="${esc(d.src || '')}"><span>${esc(d.b)} ${esc(d.m)}${d.prof ? ' <span class="auto" title="Outline traced from the technical drawing">drawing</span>' : ''}</span>` +
      `<small>${nominal(d)}"${d.Fs ? ' · Fs ' + num(d.Fs, 0) : ''}${d.Xmax ? ' · Xmax ' + num(d.Xmax, d.Xmax < 10 ? 1 : 0) : ''}${d.Pe ? ' · ' + num(d.Pe, 0) + ' W' : ''} · ${esc(srcTag(d))}</small></div>`;
    const more = pickTotal > pickRes.length ? ` (showing ${pickRes.length})` : '';
    el.innerHTML = `<div class="pickhead"><span>${pickTotal} driver${pickTotal === 1 ? '' : 's'}${more}${$('drvBrand').value === 'user' ? ' · imported by you' : ''}</span><span>${cur ? 'now: ' + esc(label(cur)) : ''}</span></div>` +
      `<div class="pickhead tips">Type a model, brand or size · also <b>18" neo</b> · <b>8ohm</b> · <b>fs&lt;35</b> · <b>xmax&gt;10</b> · <b>qts&lt;0.4</b> · <b>pe&gt;1000</b></div>` +
      (pickRes.map(row).join('') || `<div class="pickhead">No driver matches that. Try fewer words${$('drvBrand').value || $('drvSize').value ? ', set Brand and Size back to All,' : ''} or use Import driver… to add your own.</div>`);
    el.hidden = false;
    // drop the list straight down from the search box, kept inside the window
    const pr = el.parentElement.getBoundingClientRect(), sr = $('drvSearch').parentElement.getBoundingClientRect(), lw = Math.min(600, innerWidth - 16);
    el.style.left = Math.max(8 - pr.left, Math.min(sr.left - pr.left, innerWidth - 8 - lw - pr.left)) + 'px';
    el.style.top = (sr.bottom - pr.top + 3) + 'px';
    const hi = el.querySelector('.hi'); if (hi && hi.scrollIntoView) hi.scrollIntoView({ block: 'nearest' });
    el.querySelectorAll('[data-i]').forEach((n) => n.onmousedown = (e) => { e.preventDefault(); choose(pickRes[+n.dataset.i]); });
  }
  function choose(d) {
    if (!d) return;
    design.driverKey = d.k;
    const targets = sel.filter((s) => s.t === 'driver');
    commit();
    const apply = targets.length ? targets.map((s) => design.drivers.find((q) => q.id === s.id)) : design.drivers;
    apply.forEach((q) => { if (q) q.key = d.k; });
    clampWidth(true);
    $('drvList').hidden = true; setPickerText(); $('drvSearch').blur(); changed();
  }
  $('drvSearch').addEventListener('focus', () => { $('drvSearch').value = ''; pickHi = 0; showPicker(); });   // empty box = the placeholder says what you can type
  for (const id of ['drvBrand', 'drvSize']) $(id).addEventListener('change', () => { pickHi = 0; $('drvSearch').value = ''; $('drvSearch').focus(); showPicker(); });
  $('drvSearch').addEventListener('input', () => { pickHi = 0; showPicker(); });
  $('drvSearch').addEventListener('blur', () => setTimeout(() => { $('drvList').hidden = true; setPickerText(); }, 120));
  $('drvSearch').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { pickHi = Math.min(pickRes.length - 1, pickHi + 1); showPicker(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { pickHi = Math.max(0, pickHi - 1); showPicker(); e.preventDefault(); }
    if (e.key === 'Enter') choose(pickRes[pickHi]);
    if (e.key === 'Escape') $('drvSearch').blur();
  });

  // ---------------------------------------------------------------- file menu / modals
  function modal(html, wire) {
    const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div class="box" role="dialog" aria-modal="true">${html}<div class="row" style="justify-content:flex-end"><button data-close>Close</button></div></div>`;
    document.body.appendChild(m);
    const close = () => m.remove();
    m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
    m.querySelectorAll('[data-close]').forEach((b) => b.onclick = close);
    if (wire) wire(m, close);
    return m;
  }
  // Inside the claude.ai viewer files go through the downloads capability; opened locally, a normal download link.
  let dlNs = null;
  if (window.claude && window.claude.use) window.claude.use('downloads').then((ns) => { dlNs = ns; }).catch(() => { });
  async function download(name, text, type) {
    if (window.claude && window.claude.use) {
      if (!dlNs) { flash('Saving files is not available in this view. Use "Copy" instead.'); return; }
      const allowed = /\.(json|csv|txt|md|svg|html)$/i.test(name);
      const fname = allowed ? name : name + '.txt';
      try { await dlNs.save({ filename: fname, data: text }); if (!allowed) flash(`Saved as ${fname} — rename it to ${name}.`); }
      catch (e) { if (e && e.code !== 'declined') flash('Could not save the file here (' + (e && e.code) + ').'); }
      return;
    }
    try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); } catch (e) { }
  }
  function copyText(text, btn) {
    const done = () => { if (btn) { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = o, 1400); } };
    try { navigator.clipboard.writeText(text).then(done, () => { }); } catch (e) { }
  }
  const fileSafe = (s) => (s || 'design').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
  $('btnFile').onclick = () => modal(`
    <h3 style="margin:0">File</h3>
    <div class="row"><button id="mSave" class="primary">Download design (.json)</button><button id="mCopy">Copy design JSON</button><button id="mOpen">Open .json / import .wdr…</button></div>
    <div class="row"><button id="mDxf">Download side profile (.dxf)</button><button id="mCut">Cut list</button><button id="mReport">Hornresp cross-check numbers</button><button id="mCsv">Download response (.csv)</button></div>
    <label class="note">Paste a design JSON here to load it:</label><textarea id="mPaste" placeholder='{"name": ...}'></textarea>
    <div class="row"><button id="mLoadPaste">Load pasted design</button></div>
    <div class="note">Your work also autosaves in this browser. Driver files: WinISD .wdr files can be imported and are added to this design.</div>`, (m, close) => {
    m.querySelector('#mSave').onclick = () => download(fileSafe(design.name) + '.json', JSON.stringify(design, null, 1), 'application/json');
    m.querySelector('#mCopy').onclick = (e) => copyText(JSON.stringify(design), e.target);
    m.querySelector('#mOpen').onclick = () => { $('fileIn').click(); close(); };
    m.querySelector('#mDxf').onclick = () => download(fileSafe(design.name) + '_profile.dxf', toDXF(), 'application/dxf');
    m.querySelector('#mCut').onclick = () => { close(); cutList(); };
    m.querySelector('#mReport').onclick = () => { close(); report(); };
    m.querySelector('#mCsv').onclick = () => download(fileSafe(design.name) + '_response.csv', toCSV(), 'text/csv');
    m.querySelector('#mLoadPaste').onclick = () => { try { const d = JSON.parse(m.querySelector('#mPaste').value); loadDesign(d); close(); } catch (e) { m.querySelector('#mPaste').style.borderColor = 'var(--bad)'; } };
  });
  $('fileIn').onchange = async (e) => {
    for (const f of e.target.files) {
      const text = await f.text();
      if (/\.wdr$/i.test(f.name) || /^\s*\[Driver\]/.test(text)) { const d = parseWdr(text); if (d) { commit(); design.custom[d.k] = d; design.driverKey = d.k; setPickerText(); changed(); flash('Imported ' + label(d)); } }
      else { try { loadDesign(JSON.parse(text)); } catch (err) { flash('That file is not a Slice Horn Lab design.'); } }
    }
    e.target.value = '';
  };
  function parseWdr(text) {
    const kv = {}; text.split(/\r?\n/).forEach((l) => { const m = /^([^=]+)=(.*)$/.exec(l); if (m) kv[m[1].trim()] = m[2].trim(); });
    if (!kv.Fs) return null;
    const n = (k, s = 1) => kv[k] != null && kv[k] !== '' ? +kv[k] * s : undefined;
    return { k: `custom:${kv.Brand} ${kv.Model}`, b: kv.Brand || '', m: kv.Model || 'driver', src: 'imported .wdr', Fs: n('Fs'), Qes: n('Qes'), Qms: n('Qms'), Vas: n('Vas', 1000), Re: n('Re'), Le: n('Le', 1000), Sd: n('Sd', 1e4), Mms: n('Mms', 1000), Bl: n('BL'), Xmax: n('Xmax', 1000), Pe: n('Pe') };
  }

  // ======================= driver import (WinISD / Hornresp / spec-sheet PDF or text) =======================
  const USER_KEY = 'shl.userDrivers';
  function loadUserDrivers() { try { return JSON.parse(LS.get(USER_KEY) || '[]'); } catch (e) { return []; } }
  function registerUser(d) {
    d.user = true;
    const i = LIB.findIndex((x) => x.k === d.k); if (i >= 0) LIB[i] = d; else LIB.push(d);
    LIBMAP.set(d.k, d);
  }
  const num = (v) => { if (v == null) return undefined; const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : undefined; };
  function draftFromWdr(text) {
    const w = parseWdr(text); if (!w) return null;
    return { brand: w.b, model: w.m, Fs: w.Fs, Re: w.Re, Le: w.Le, Qms: w.Qms, Qes: w.Qes, Vas: w.Vas, Sd: w.Sd, Mms: w.Mms, Bl: w.Bl, Xmax: w.Xmax, Pe: w.Pe, from: 'WinISD .wdr' };
  }
  function draftFromHornresp(text, fname) {
    const kv = {};
    text.split(/\r?\n/).forEach((l) => { const m = /^\s*([A-Za-z][A-Za-z0-9' ]*?)\s*=\s*([-+0-9.Ee]+)\s*$/.exec(l); if (m && !(m[1].trim() in kv)) kv[m[1].trim()] = +m[2]; });
    if (!(kv.Sd > 0 && kv.Bl > 0 && kv.Cms > 0 && kv.Mmd > 0 && kv.Re > 0)) return null;
    const ts = HC.driverToTS({ Sd: kv.Sd, Bl: kv.Bl, Cms: kv.Cms, Rms: kv.Rms || 1, Mmd: kv.Mmd, Re: kv.Re, Le: kv.Le || 0 });
    // advanced sections: in both Hornresp record and driver files the order is Re', Leb, Le, Ke, Rss, then Rms, Ams
    const seq = []; text.split(/\r?\n/).forEach((l) => { const mm = /^\s*([A-Za-z][A-Za-z0-9' -]*?)\s*=\s*([-+0-9.Ee]+)\s*$/.exec(l); if (mm) seq.push([mm[1].trim(), +mm[2]]); });
    const ia = seq.findIndex((q) => q[0] === "Re'");
    const after = (name, from) => { for (let i = from; i < seq.length; i++) if (seq[i][0] === name) return [seq[i][1], i]; return [undefined, from]; };
    let adv;
    if (ia >= 0) {
      const [Rep, i1] = [seq[ia][1], ia], [Leb, i2] = after('Leb', i1), [Le2, i3] = after('Le', i2), [Ke, i4] = after('Ke', i3), [Rss, i5] = after('Rss', i4), [Rms2, i6] = after('Rms', i5), [Ams] = after('Ams', i6);
      const flag = (re) => { const mm = re.exec(text); return mm ? +mm[1] === 1 : null; };
      const semiFlag = flag(/Semi-?Inductance(?: Model Flag)?\s*=\s*([01])/i), fddFlag = flag(/(?:Damping Model Flag|^\s*Damping)\s*=\s*([01])/im);
      adv = { Rep, Leb, Le2, Ke, Rss, Rms2, Ams, semi: semiFlag != null ? semiFlag : Rep > 0 && (Ke > 0 || Le2 > 0 || Leb > 0), fdd: fddFlag != null ? fddFlag : Ams > 0 };
      if (!(adv.semi || adv.fdd) && !(Rep > 0 || Ams > 0)) adv = undefined;
    }
    const cm = /^\s*Comment\s*=\s*(.+)$/m.exec(text), first = text.split(/\r?\n/).find((l) => l.trim() && !/=/.test(l));
    const name = (cm && cm[1].trim()) || (first && first.trim()) || fname.replace(/\.[^.]+$/, '');
    return { brand: '', model: name, Fs: +ts.Fs.toFixed(2), Re: kv.Re, Le: kv.Le, Qms: +ts.Qms.toFixed(3), Qes: +ts.Qes.toFixed(3), Vas: +ts.Vas.toFixed(1), Sd: kv.Sd, Mms: +ts.Mms.toFixed(2), Bl: kv.Bl,
      Xmax: kv.Xmax, Pe: kv.Pmax, from: 'Hornresp', ...(adv ? { Rep: adv.Rep, Leb: adv.Leb, Le2: adv.Le2, Ke: adv.Ke, Rss: adv.Rss, Rms2: adv.Rms2, Ams: adv.Ams, semi: adv.semi, fdd: adv.fdd } : {}),
      notes: ['Fs, Qms, Qes, Vas and Mms worked out from Hornresp’s Sd, Bl, Cms, Rms, Mmd.'].concat(adv && (adv.semi || adv.fdd) ? [`Advanced model imported: ${[adv.semi && 'semi-inductance', adv.fdd && 'frequency-dependent damping'].filter(Boolean).join(' + ')}.`] : []) };
  }
  /** Pick a T/S table out of spec-sheet text (PDF text layer or pasted). Units are converted; every value goes to review. */
  function draftFromSpecText(text, fname) {
    const T = text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ');
    const N = '([0-9]+(?:[.,][0-9]+)?)';
    const find = (re) => { const m = re.exec(T); return m ? m : null; };
    const d = { from: 'spec sheet', notes: [] };
    let m;
    if ((m = find(new RegExp('\\b(?:Fs|F\\s?s|Resonan(?:ce|t) frequency|Free air resonance)\\b[^0-9\\n]{0,40}?' + N + '\\s*Hz', 'i')))) d.Fs = num(m[1]);
    if ((m = find(new RegExp('\\b(?:Re|R\\s?e|DC resistance|D\\.?C\\.? resistance)\\b[^0-9\\n]{0,30}?' + N + '\\s*(?:Ω|ohms?|Ohm)', 'i')))) d.Re = num(m[1]);
    if ((m = find(new RegExp('\\bQ\\s?ms\\b[^0-9\\n]{0,20}?' + N, 'i')))) d.Qms = num(m[1]);
    if ((m = find(new RegExp('\\bQ\\s?es\\b[^0-9\\n]{0,20}?' + N, 'i')))) d.Qes = num(m[1]);
    if ((m = find(new RegExp('\\bQ\\s?ts\\b[^0-9\\n]{0,20}?' + N, 'i')))) d.Qts = num(m[1]);
    if ((m = find(new RegExp('\\bV\\s?as\\b[^0-9\\n]{0,40}?' + N + '\\s*(l\\b|lt|lit(?:er|re)s?|dm3|dm³|dm\\b|ft3|ft³|ft\\b|cu\\.?\\s*ft|cubic\\s*f|m3|m³)', 'i')))) {   // bare dm/ft: superscript 3 split off by the PDF
      const v = num(m[1]), u = m[2].toLowerCase(); d.Vas = /ft|cubic/.test(u) ? v * 28.3168 : /m3|m³/.test(u) && !/dm/.test(u) ? v * 1000 : v;
    }
    if ((m = find(new RegExp('\\b(?:Sd|S\\s?d|Effective (?:piston|radiating|cone) area|Piston area)\\b[^0-9\\n]{0,40}?' + N + '\\s*(cm2|cm²|cm\\^2|cm\\b|sq\\.?\\s*cm|m2|m²|in2|in²|sq\\.?\\s*in)', 'i')))) {   // bare cm: superscript 2 split off
      const v = num(m[1]), u = m[2].toLowerCase(); d.Sd = /in/.test(u) ? v * 6.4516 : /cm/.test(u) ? v : v * 1e4;
    }
    // subscripted labels (B&C: big "V"/"S", small "as"/"d" on another baseline): fall back to the unit
    if (d.Vas == null && (m = find(new RegExp('\\bV(?:\\s*as)?\\b[^0-9\\n]{0,12}?' + N + '\\s*(dm3|dm³|lit(?:er|re)s?|ft3|ft³)', 'i')))) { const v = num(m[1]); d.Vas = /ft/i.test(m[2]) ? v * 28.3168 : v; }
    if (d.Sd == null && (m = find(new RegExp('\\bS(?:\\s*d)?\\b[^0-9\\n]{0,12}?' + N + '\\s*(cm2|cm²|m2|m²|in2|in²)', 'i')))) { const v = num(m[1]), u = m[2].toLowerCase(); d.Sd = /in/.test(u) ? v * 6.4516 : /cm/.test(u) ? v : v * 1e4; }
    if ((m = find(new RegExp('\\b(?:Mms|M\\s?ms|Moving mass)\\b[^0-9\\n]{0,40}?' + N + '\\s*(kg|g\\b|gr|grams?)', 'i')))) { const v = num(m[1]); d.Mms = /kg/i.test(m[2]) ? v * 1000 : v; }
    if ((m = find(new RegExp('\\b(?:BL|B\\s?L|Bl|B\\s?x\\s?L|Force factor)\\b[^0-9\\n]{0,40}?' + N + '\\s*(?:T\\s?[·.x*]?\\s?m|Tm|N/A|Wb/m)', 'i')))) d.Bl = num(m[1]);
    if ((m = find(new RegExp('\\b(?:Le|L\\s?e|Voice coil inductance|Inductance)\\b[^0-9\\n]{0,40}?' + N + '\\s*mH', 'i')))) d.Le = num(m[1]);
    if ((m = find(new RegExp('\\b(?:X\\s?max|Maximum linear excursion|Linear excursion)\\b[^0-9\\n]{0,50}?' + N + '\\s*mm', 'i')))) d.Xmax = num(m[1]);
    if ((m = find(new RegExp('(?:AES|continuous|nominal|rated|RMS)\\s*power(?:\\s*handling)?(?:\\s*\\([^)]*\\))?[^0-9\\n]{0,40}?' + N + '\\s*W', 'i')))) d.Pe = num(m[1]);
    if ((m = find(new RegExp('(?:overall|outside|outer|total)\\s*diameter[^0-9\\n]{0,30}?' + N + '\\s*mm', 'i')))) d.outer = num(m[1]);
    if ((m = find(new RegExp('(?:baffle\\s*)?cut-?\\s?out(?:\\s*diameter)?(?:\\s*\\(front\\))?[^0-9\\n]{0,30}?' + N + '\\s*mm', 'i')))) d.cutout = num(m[1]);
    // "Depth" at the start of a row (mounting info), not "winding depth" / "gap depth"
    if ((m = find(new RegExp('(?:^|\\n)[ \\t]*(?:overall\\s*|total\\s*|mounting\\s*)?depth\\b[^0-9\\n]{0,30}?' + N + '\\s*mm', 'i')) || find(new RegExp('(?:overall|total)\\s*depth[^0-9\\n]{0,30}?' + N + '\\s*mm', 'i')))) d.depth = num(m[1]);
    const sz = /\b(6\.5|8|10|12|15|18|21)\s*(?:"|”|''|-?\s*inch|in\b)/i.exec(T) || /\b(8|10|12|15|18|21)(?=[A-Z])/.exec(fname || '');
    if (sz) d.size = num(sz[1]);
    const brands = ['B&C', 'Eminence', 'Faital', 'Beyma', 'RCF', '18 Sound', 'Precision Devices', 'Celestion', 'JBL', 'Lavoce', 'Dayton', 'Ciare', 'BMS', 'PHL', 'Acoustic Elegance', 'Peavey', 'Sica'];
    d.brand = brands.find((b) => T.toLowerCase().includes(b.toLowerCase())) || '';
    d.model = (fname || 'Imported driver').replace(/\.[^.]+$/, '').replace(/^[0-9-]+--?/, '').replace(/[-_]+/g, ' ').replace(/\b(spec|sheet|datasheet|technical|drawing|mfr)\b/gi, '').replace(/\s+/g, ' ').trim();
    const got = ['Fs', 'Re', 'Qms', 'Qes', 'Qts', 'Vas', 'Sd', 'Mms', 'Bl', 'Le', 'Xmax'].filter((k) => d[k] != null);
    d.notes.push(`Read ${got.length} of 11 T/S values from the text${got.length < 6 ? ' — check the fields below' : ''}.`);
    return d;
  }
  let pdfjsReady = null;
  function loadPdfJs() {
    if (pdfjsReady) return pdfjsReady;
    const add = (src) => new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(el); });
    const B = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
    pdfjsReady = add(B + 'pdf.worker.min.js').then(() => add(B + 'pdf.min.js')).then(() => {
      const lib = window['pdfjs-dist/build/pdf']; lib.GlobalWorkerOptions.workerSrc = B + 'pdf.worker.min.js'; return lib;
    });
    return pdfjsReady;
  }
  async function pdfText(file) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    // spec tables are laid out in columns (all labels, then all values), so rebuild rows from positions:
    // items at the same height are one row, read left to right ("Re ... 4.6 Ω")
    let out = '';
    for (let i = 1; i <= Math.min(doc.numPages, 6); i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      const items = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ s: it.str.trim(), x: it.transform[4], y: it.transform[5], h: Math.abs(it.transform[3]) || 8 }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const rows = [];
      for (const it of items) {
        const r = rows.find((q) => Math.abs(q.y - it.y) < Math.max(3, 0.6 * it.h));
        if (r) r.items.push(it); else rows.push({ y: it.y, items: [it] });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) out += r.items.sort((a, b) => a.x - b.x).map((q) => q.s).join(' ') + '\n';
      out += '\n';
    }
    return out;
  }
  async function draftFromFile(f) {
    if (/\.pdf$/i.test(f.name)) return draftFromSpecText(await pdfText(f), f.name);
    const text = await f.text();
    if (/\.wdr$/i.test(f.name) || /^\s*\[Driver\]/.test(text)) return draftFromWdr(text);
    const hr = draftFromHornresp(text, f.name); if (hr) return hr;
    return draftFromSpecText(text, f.name);
  }
  const IMPORT_FIELDS = [['brand', 'Brand', ''], ['model', 'Model', ''], ['size', 'Nominal size', 'in'], ['Fs', 'Fs', 'Hz'], ['Re', 'Re', 'Ω'], ['Le', 'Le', 'mH'], ['Qms', 'Qms', ''], ['Qes', 'Qes', ''], ['Qts', 'Qts', ''],
    ['Vas', 'Vas', 'L'], ['Sd', 'Sd', 'cm²'], ['Mms', 'Mms', 'g'], ['Bl', 'BL', 'T·m'], ['Xmax', 'Xmax', 'mm'], ['Pe', 'Power (AES)', 'W'], ['outer', 'Frame diameter', 'mm'], ['cutout', 'Cutout', 'mm'], ['depth', 'Depth', 'mm'],
    ['Rep', "Re' semi-ind.", 'Ω'], ['Leb', 'Leb free', 'mH'], ['Le2', 'Le bound', 'mH'], ['Ke', 'Ke', 'sH'], ['Rss', 'Rss', 'Ω'], ['Rms2', 'Rms FDD', 'N·s/m'], ['Ams', 'Ams', 'm/N']];
  function openImport() {
    modal(`<h3 style="margin:0">Import a driver</h3>
      <div class="note">WinISD <b>.wdr</b>, Hornresp driver or record <b>.txt</b>, a manufacturer <b>spec sheet PDF</b>, or the spec text pasted below. You can check and fix every value before it is saved to your <b>User</b> drivers.</div>
      <div class="row"><button id="impPick" class="primary">Choose file…</button><input type="file" id="impFile" accept=".wdr,.txt,.pdf,.csv,.dat" hidden><span id="impMsg" class="note"></span></div>
      <textarea id="impPaste" placeholder="…or paste the spec table text here (e.g. Fs 36 Hz, Re 5.1 Ω, Qms 5, Qes 0.49, Vas 83 L, Sd 855 cm², BL 23.9 Tm)" style="min-height:90px"></textarea>
      <div class="row"><button id="impRead">Read pasted text</button></div>
      <div id="impForm"></div>`, (m, close) => {
      const show = (d) => {
        if (!d) { m.querySelector('#impMsg').textContent = 'No driver data found in that file.'; return; }
        if (d.Qts && d.Qms && !d.Qes) d.Qes = +(1 / (1 / d.Qts - 1 / d.Qms)).toFixed(3);
        const f = m.querySelector('#impForm');
        f.innerHTML = `<h3 style="margin:6px 0 0">Check the values <span class="pill">${esc(d.from)}</span></h3>
          ${(d.notes || []).map((n) => `<div class="note">${esc(n)}</div>`).join('')}
          <div class="grid2">${IMPORT_FIELDS.map(([k, lab, u]) => `<label>${lab}${u ? ' (' + u + ')' : ''}<input type="text" data-k="${k}" value="${d[k] != null ? esc(String(typeof d[k] === 'number' ? +d[k].toFixed(4) : d[k])) : ''}"></label>`).join('')}</div>
          <div id="impCheck" class="note"></div>
          <div class="row"><button id="impSave" class="primary">Save to my drivers</button></div>`;
        const read = () => { const o = { from: d.from, semi: d.semi, fdd: d.fdd }; f.querySelectorAll('[data-k]').forEach((i) => { const k = i.dataset.k, v = i.value.trim(); o[k] = ['brand', 'model'].includes(k) ? v : num(v); }); if (o.Qts && o.Qms && !o.Qes) o.Qes = 1 / (1 / o.Qts - 1 / o.Qms); return o; };
        const check = () => {
          const o = read(), miss = ['Fs', 'Re', 'Sd'].filter((k) => !(o[k] > 0));
          if (!(o.Qes > 0)) miss.push('Qes (or Qts + Qms)');
          if (!(o.Qms > 0)) miss.push('Qms');
          if (!(o.Vas > 0) && !(o.Mms > 0)) miss.push('Vas or Mms');
          const el = f.querySelector('#impCheck');
          if (miss.length) { el.innerHTML = `<b>Still needed:</b> ${miss.join(', ')}`; return null; }
          let note = '';
          if (o.Qts && o.Qes && o.Qms) { const q = 1 / (1 / o.Qes + 1 / o.Qms); if (Math.abs(q - o.Qts) / o.Qts > 0.05) note += ` Qts ${o.Qts} does not match Qes/Qms (${q.toFixed(3)}).`; }
          el.innerHTML = 'All the values needed for the simulation are present.' + (note ? ' <b>Check:</b>' + esc(note) : '');
          return o;
        };
        f.querySelectorAll('[data-k]').forEach((i) => i.addEventListener('input', check)); check();
        f.querySelector('#impSave').onclick = () => {
          const o = check(); if (!o) return;
          const model = o.model || 'Imported driver', brand = o.brand || 'User';
          const e = { k: 'user:' + brand + ' ' + model, b: brand, m: model, src: 'User import (' + o.from + ')', Fs: o.Fs, Qes: o.Qes, Qms: o.Qms, Vas: o.Vas, Re: o.Re, Le: o.Le, Sd: o.Sd, Mms: o.Mms, Bl: o.Bl, Xmax: o.Xmax, Pe: o.Pe, size: o.size,
            dims: o.outer ? { outer_dia: o.outer, cutout_dia: o.cutout, depth_total: o.depth } : undefined,
            adv: (o.Rep > 0 || o.Ams > 0) ? { Rep: o.Rep, Leb: o.Leb, Le2: o.Le2, Ke: o.Ke, Rss: o.Rss, Rms2: o.Rms2, Ams: o.Ams, semi: o.semi != null ? !!o.semi : o.Rep > 0, fdd: o.fdd != null ? !!o.fdd : o.Ams > 0 } : undefined };
          Object.keys(e).forEach((k) => e[k] === undefined && delete e[k]);
          try { const hr = HC.tsToDriver(e); if (!(hr.Mmd > 0) || !isFinite(hr.Bl)) throw 0; } catch (err) { f.querySelector('#impCheck').innerHTML = '<b>These values do not make a working driver</b> (check Sd, Mms/Vas and Qes).'; return; }
          const list = loadUserDrivers().filter((x) => x.k !== e.k); list.push(e); LS.set(USER_KEY, JSON.stringify(list));
          registerUser(e);
          commit(); design.custom = design.custom || {}; design.custom[e.k] = { ...e }; design.driverKey = e.k;
          sel.filter((q) => q.t === 'driver').forEach((q) => { const dr = design.drivers.find((r) => r.id === q.id); if (dr) dr.key = e.k; });
          $('drvBrand').value = 'user'; setPickerText(); changed(); close();
          flash(`Saved ${brand} ${model} to your User drivers.`);
        };
      };
      m.querySelector('#impPick').onclick = () => m.querySelector('#impFile').click();
      m.querySelector('#impFile').onchange = async (ev) => {
        const file = ev.target.files[0]; if (!file) return;
        m.querySelector('#impMsg').textContent = /\.pdf$/i.test(file.name) ? 'Reading the PDF…' : 'Reading…';
        try { show(await draftFromFile(file)); m.querySelector('#impMsg').textContent = file.name; }
        catch (err) { m.querySelector('#impMsg').textContent = 'Could not read that file: ' + err.message; }
      };
      m.querySelector('#impRead').onclick = () => { const t = m.querySelector('#impPaste').value; if (t.trim()) show(draftFromHornresp(t, 'pasted') || draftFromSpecText(t, 'Pasted driver')); };
    });
  }

  function loadDesign(d) {
    if (!d || !Array.isArray(d.panels)) throw new Error('bad');
    commit(); design = Object.assign(baseDesign('Untitled'), d); if (!SNAPS[design.snap]) design.snap = design.units === 'in' ? 'in01' : 'mm'; sel = []; fit(); changed(); setPickerText(); renderSnap(); renderViewSide();
  }
  function toDXF() {
    const out = ['0', 'SECTION', '2', 'ENTITIES'];
    const line = (a, b, layer) => out.push('0', 'LINE', '8', layer, '10', a.x.toFixed(3), '20', a.y.toFixed(3), '30', '0', '11', b.x.toFixed(3), '21', b.y.toFixed(3), '31', '0');
    HG.computeJoints(design);
    for (const p of design.panels) { const q = HG.panelQuad(p, design.t); for (let i = 0; i < 4; i++) line(q[i], q[(i + 1) % 4], 'PANELS'); }
    for (const p of design.paths) for (let i = 1; i < p.pts.length; i++) line(p.pts[i - 1], p.pts[i], 'AIRPATH');
    out.push('0', 'ENDSEC', '0', 'EOF');
    return out.join('\n');
  }
  function cutList() {
    const names = partNames();
    HG.computeJoints(design);
    const rows = design.panels.filter((p) => !p.arc).map((p) => {
      const q = HG.panelQuad(p, design.t), L0 = hyp(p.x2 - p.x1, p.y2 - p.y1) || 1, nx = -(p.y2 - p.y1) / L0, ny = (p.x2 - p.x1) / L0;
      const e1 = hyp(q[1].x - q[0].x, q[1].y - q[0].y), e2 = hyp(q[2].x - q[3].x, q[2].y - q[3].y);
      const bev = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l = hyp(dx, dy) || 1; return Math.round(Math.acos(Math.min(1, Math.abs(dx * nx + dy * ny) / l)) * 180 / Math.PI * 2) / 2; };
      return { L: Math.max(e1, e2), t: p.t || design.t, name: names.get(p.id), role: roleOf(p), b1: bev(q[0], q[3]), b2: bev(q[1], q[2]) };
    });
    const groups = new Map(); rows.forEach((r) => { const k = r.role + '|' + r.L.toFixed(1) + '|' + r.t + '|' + [r.b1, r.b2].sort().join('/'); const g = groups.get(k); if (g) { g.n++; g.names.push(r.name); } else groups.set(k, { ...r, n: 1, names: [r.name] }); });
    const s = A ? HG.summary(design, A) : null;
    const order = HG.ROLES;
    const lines = [...groups.values()].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || b.L - a.L).map((g) => `${g.names.join(', ').padEnd(26)} ${String(g.n).padStart(2)} ×  ${fmtL(g.L, isIn() ? 3 : 1).padStart(10)}  ×  ${fmtL(design.W, isIn() ? 3 : 1)}   (${fmtL(g.t, isIn() ? 3 : 1)} board)${g.b1 || g.b2 ? `   ends cut ${g.b1}° / ${g.b2}°` : ''}`);
    (design.arcs || []).forEach((g, i) => { const G = arcGeom(g), tt = g.t || design.t; lines.push(`${('Curved board ' + (i + 1)).padEnd(26)}  1 ×  ${fmtL(G.len, isIn() ? 3 : 1)} bent length × ${fmtL(design.W, 1)}, ${G.c ? 'radius ' + fmtL(G.c.r, 1) + ' (centre-line), ' + (Math.abs(G.sweep) * 180 / Math.PI).toFixed(0) + '°' : 'straight'} — ${Math.ceil(tt / 3)} × 3 mm bending ply over formers`); });
    if (s) lines.push('', ` 2 ×  side panels, outline ${fmtL(s.D, 1)} × ${fmtL(s.H, 1)} (trace the profile from the DXF)`);
    const area = (rows.reduce((a, r) => a + r.L * design.W, 0) + (design.arcs || []).reduce((a, g) => a + arcGeom(g).len * design.W, 0)) / 1e6 + (s ? 2 * s.D * s.H / 1e6 : 0);
    modal(`<h3 style="margin:0">Cut list · ${esc(design.name)}</h3><pre>${esc(lines.join('\n'))}</pre><div class="note">Lengths are long-point lengths after the corner joints are cut. "Ends cut" gives each end's bevel from square (0° = square cut); change a joint by right-clicking the corner. Total sheet area ≈ ${area.toFixed(2)} m² (${(area / 2.977).toFixed(2)} of a 4×8 sheet, before kerf and waste).</div>`);
  }
  function report() {
    if (!A || !A.net) return;
    const n = A.net, L = [];
    L.push(`Design: ${design.name}   Ang = ${({ 0.5: '4.0', 1: '2.0', 2: '1.0', 4: '0.5' })[design.space]} x Pi   Eg = ${design.eg} V`, '');
    n.drivers.forEach((d) => { const h = d.d; L.push(`Driver ${label(specOf(design.drivers.find((q) => q.id === d.id).key))} x${d.n} (${d.wiring})`, `  Sd = ${h.Sd.toFixed(2)} cm²  Bl = ${h.Bl.toFixed(2)}  Cms = ${h.Cms.toExponential(2)}  Rms = ${h.Rms.toFixed(2)}  Mmd = ${h.Mmd.toFixed(2)} g  Le = ${h.Le.toFixed(2)} mH  Re = ${h.Re.toFixed(2)}`, `  front → ${d.front}   rear → ${d.rear}`); });
    L.push('');
    for (const P of A.paths) {
      L.push(`Path ${P.src.name}: length ${(P.m.L / 10).toFixed(1)} cm, ends: ${P.ends.map((e) => e.kind).join(' → ')}`);
      // Hornresp-style breakdown at the drawn vertices (Par = linear-area segments)
      const vs = []; let acc = 0; P.src.pts.forEach((v, i) => { if (i) acc += hyp(v.x - P.src.pts[i - 1].x, v.y - P.src.pts[i - 1].y); const smp = P.m.samples.reduce((a, s) => Math.abs(s.s - acc) < Math.abs(a.s - acc) ? s : a, P.m.samples[0]); vs.push({ s: acc, S: smp.h * design.W / 100 }); });
      vs.forEach((v, i) => L.push(`  S${i + 1} = ${v.S.toFixed(1)} cm²${i ? `   L${i}${i + 1} = ${((v.s - vs[i - 1].s) / 10).toFixed(2)} cm (Par)` : ''}`));
    }
    L.push('');
    A.regions.forEach((r) => { if (r && r.kind === 'chamber' && !r.unused) L.push(`Chamber ${r.label}: ${r.Vnet.toFixed(2)} L${r.fb ? `, Helmholtz ${r.fb.toFixed(1)} Hz` : ''}`); });
    L.push('', 'Areas at bends are measured, so they will not match a hand-entered Hornresp model exactly; use these numbers as the starting point for a Hornresp record.');
    modal(`<h3 style="margin:0">Hornresp cross-check</h3><pre>${esc(L.join('\n'))}</pre><div class="row"><button id="rCopy">Copy</button></div>`, (m) => m.querySelector('#rCopy').onclick = (e) => copyText(L.join('\n'), e.target));
  }
  function toCSV() {
    if (!R) return '';
    const rows = ['freq_Hz,spl_dB,spl_unfiltered_dB,ze_ohm,ze_phase_deg,excursion_mm,group_delay_ms,max_spl_dB'];
    R.f.forEach((f, i) => rows.push([f.toFixed(3), R.spl[i].toFixed(3), R.splRaw[i].toFixed(3), R.ze[i].toFixed(4), R.zePh[i].toFixed(2), R.x[i].toFixed(4), R.gd[i].toFixed(3), isFinite(R.maxSpl[i]) ? R.maxSpl[i].toFixed(2) : ''].join(',')));
    return rows.join('\n');
  }

  // ---------------------------------------------------------------- side panel width (drag the splitter)
  const mainEl = document.querySelector('.main'), splitter = $('splitter');
  const SIDE_DEFAULT = 440;
  function setSideWidth(px, save) {
    const total = mainEl.getBoundingClientRect().width;
    const w = Math.round(clamp(px, 300, Math.max(320, total - 46 - 8 - 280)));
    mainEl.style.setProperty('--side-w', w + 'px');
    if (splitter) splitter.setAttribute('aria-valuenow', String(w));
    if (save) LS.set('shl.sideW', String(w));
    return w;
  }
  if (splitter) {
    const saved = +LS.get('shl.sideW') || (DEF && DEF.ui && DEF.ui.sideW);
    if (saved) setSideWidth(saved, false);
    let sd = null;
    splitter.addEventListener('pointerdown', (e) => {
      try { splitter.setPointerCapture(e.pointerId); } catch (err) { }
      sd = { x: e.clientX, w: $('insp').closest('.side').getBoundingClientRect().width };
      splitter.classList.add('drag'); e.preventDefault();
    });
    splitter.addEventListener('pointermove', (e) => { if (sd) setSideWidth(sd.w - (e.clientX - sd.x), false); });
    const end = () => { if (!sd) return; sd = null; splitter.classList.remove('drag'); setSideWidth(parseFloat(getComputedStyle(mainEl).getPropertyValue('--side-w')), true); };
    splitter.addEventListener('pointerup', end); splitter.addEventListener('pointercancel', end);
    splitter.addEventListener('dblclick', () => setSideWidth(SIDE_DEFAULT, true));
    splitter.addEventListener('keydown', (e) => {
      const cur = parseFloat(getComputedStyle(mainEl).getPropertyValue('--side-w')) || SIDE_DEFAULT, st = e.shiftKey ? 80 : 20;
      if (e.key === 'ArrowLeft') { setSideWidth(cur + st, true); e.preventDefault(); }
      if (e.key === 'ArrowRight') { setSideWidth(cur - st, true); e.preventDefault(); }
    });
    window.addEventListener('resize', () => setSideWidth(parseFloat(getComputedStyle(mainEl).getPropertyValue('--side-w')) || SIDE_DEFAULT, false));
  }

  function renderViewSide() {
    const el = $('viewSeg'); if (!el) return;
    el.innerHTML = [['left', 'Left'], ['right', 'Right']].map(([k, v]) => `<button class="${(design.mirror ? 'right' : 'left') === k ? 'on' : ''}" data-side="${k}" title="Look at the cabinet from its ${v.toLowerCase()} side">${v}</button>`).join('');
    el.querySelectorAll('button').forEach((b) => b.onclick = () => {
      const want = b.dataset.side === 'right'; if (!!design.mirror === want) return;
      const cx = view.w / 2, [wx] = s2w(cx, 0);      // keep the same spot in the middle of the screen
      design.mirror = want; view.tx = cx - MX() * wx * view.k;
      regionImg = null; renderViewSide(); draw(); LS.set('shl.design', JSON.stringify(design));
    });
  }
  function renderSnap() {
    const el = $('snapSeg');
    el.innerHTML = Object.entries(SNAPS).map(([k, v]) => `<button class="${design.snap === k ? 'on' : ''}" data-snap="${k}" title="Snap and round to ${v.label}">${v.label}</button>`).join('');
    el.querySelectorAll('button').forEach((b) => b.onclick = () => { design.snap = b.dataset.snap; renderSnap(); draw(); refreshSide(); LS.set('shl.design', JSON.stringify(design)); });
  }

  // ---------------------------------------------------------------- boot
  $('preset').onchange = (e) => { if (!e.target.value) return; commit(); design = makePreset(e.target.value); e.target.value = ''; sel = []; fit(); changed(); setPickerText(); renderSnap(); renderViewSide(); renderViewSide(); };
  $('btnUndo').onclick = doUndo; $('btnRedo').onclick = doRedo;
  const saved = LS.get('shl.design');
  try { design = saved ? Object.assign(baseDesign('Untitled'), JSON.parse(saved)) : null; } catch (e) { design = null; }
  if (!design) design = makePreset(DEF ? 'default' : 'th');
  if (!SNAPS[design.snap]) design.snap = design.units === 'in' ? 'in01' : 'mm';
  if (design.showLabels == null) design.showLabels = true;
  if (design.autoPaths == null) design.autoPaths = true;
  readColors();
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const reTheme = () => { readColors(); draw(); drawChart(); };
  mq.addEventListener ? mq.addEventListener('change', reTheme) : mq.addListener(reTheme);
  new MutationObserver(reTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  loadUserDrivers().forEach(registerUser);
  $('helpClose').onclick = () => setHelp(false);
  if (!LS.get('shl.helpSeen')) setTimeout(() => setHelp(true), 300);   // first visit: show how it works
  Object.values(design.custom || {}).forEach((d) => { if (d && /^user:/.test(d.k || '') && !LIBMAP.has(d.k)) registerUser({ ...d }); });
  $('drvImport').onclick = openImport;
  renderTools(); renderTabs(); setTool('select'); setPickerText(); renderSnap(); renderViewSide();
  new ResizeObserver(resize).observe($('board'));
  new ResizeObserver(() => { const cr = chartCv.getBoundingClientRect(); chartCv.width = Math.round(cr.width * view.dpr); chartCv.height = Math.round(cr.height * view.dpr); drawChart(); }).observe(chartCv);
  analyse(); resize();
  window.SHL = { quantizeBuild, quantizeIn, get design() { return design; }, get A() { return A; }, get R() { return R; }, changed, w2s, s2w, hit: (x, y) => hit(...s2w(x, y)), moveDriverTo, driverHits, get drag() { return drag; } };
})();
