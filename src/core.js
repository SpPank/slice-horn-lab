/* HornSim core — 1-D acoustic network solver (Hornresp-class model)
 *
 * Model (same physics family as Hornresp):
 *  - Ducts / horn segments: exact plane-wave (Webster) two-port matrices for
 *    cylindrical, conical and exponential segments. Linear-taper (constant
 *    width, slice-built) segments are built from many short conical pieces.
 *  - Chambers: lumped acoustic compliances V/(rho c^2).
 *  - Driver: Thiele-Small electro-mechanical two-port (Re, Le, Bl, Mmd, Cms,
 *    Rms, Sd) solved as a Norton source between its front and rear nodes.
 *  - Mouths / vents / direct radiators: rigid circular piston in a baffle
 *    (Struve/Bessel radiation impedance), image-scaled for 4pi/2pi/1pi/0.5pi.
 *  - Lossless by default (as Hornresp). Optional Kirchhoff visco-thermal wall
 *    losses per duct, and optional chamber absorption.
 *  - SPL from the summed volume velocity of all radiators at 1 m.
 *
 * Units inside the solver are SI. Works in the browser and in Node.
 */
(function (root) {
  'use strict';

  const AIR = { c: 344, rho: 1.205, mu: 1.81e-5, gamma: 1.4, Pr: 0.71 };

  // ---------- complex arithmetic (objects {r,i}) ----------
  const cx = (r, i = 0) => ({ r, i });
  const add = (a, b) => ({ r: a.r + b.r, i: a.i + b.i });
  const sub = (a, b) => ({ r: a.r - b.r, i: a.i - b.i });
  const mul = (a, b) => ({ r: a.r * b.r - a.i * b.i, i: a.r * b.i + a.i * b.r });
  const scl = (a, s) => ({ r: a.r * s, i: a.i * s });
  const div = (a, b) => {
    const d = b.r * b.r + b.i * b.i;
    return { r: (a.r * b.r + a.i * b.i) / d, i: (a.i * b.r - a.r * b.i) / d };
  };
  const inv = (a) => div(cx(1), a);
  const neg = (a) => ({ r: -a.r, i: -a.i });
  const abs = (a) => Math.hypot(a.r, a.i);
  const arg = (a) => Math.atan2(a.i, a.r);
  const cexp = (a) => { const e = Math.exp(a.r); return { r: e * Math.cos(a.i), i: e * Math.sin(a.i) }; };
  const csqrt = (a) => {
    const m = abs(a); if (m === 0) return cx(0);
    const r = Math.sqrt((m + a.r) / 2), i = Math.sign(a.i || 1) * Math.sqrt(Math.max(0, (m - a.r) / 2));
    return { r, i };
  };
  const ccos = (a) => ({ r: Math.cos(a.r) * Math.cosh(a.i), i: -Math.sin(a.r) * Math.sinh(a.i) });
  const csin = (a) => ({ r: Math.sin(a.r) * Math.cosh(a.i), i: Math.cos(a.r) * Math.sinh(a.i) });
  const J = cx(0, 1);

  // 2x2 complex matrices as [a,b,c,d]
  const mmul = (X, Y) => [
    add(mul(X[0], Y[0]), mul(X[1], Y[2])), add(mul(X[0], Y[1]), mul(X[1], Y[3])),
    add(mul(X[2], Y[0]), mul(X[3], Y[2])), add(mul(X[2], Y[1]), mul(X[3], Y[3])),
  ];
  const minv = (X) => {
    const det = sub(mul(X[0], X[3]), mul(X[1], X[2]));
    return [div(X[3], det), div(neg(X[1]), det), div(neg(X[2]), det), div(X[0], det)];
  };
  const IDENT = [cx(1), cx(0), cx(0), cx(1)];

  // ---------- Bessel / Struve for piston radiation ----------
  function besselJ0(x) {
    const ax = Math.abs(x);
    if (ax < 8) {
      const y = x * x;
      const a1 = 57568490574.0 + y * (-13362590354.0 + y * (651619640.7 + y * (-11214424.18 + y * (77392.33017 + y * (-184.9052456)))));
      const a2 = 57568490411.0 + y * (1029532985.0 + y * (9494680.718 + y * (59272.64853 + y * (267.8532712 + y))));
      return a1 / a2;
    }
    const z = 8 / ax, y = z * z, xx = ax - 0.785398164;
    const a1 = 1 + y * (-0.1098628627e-2 + y * (0.2734510407e-4 + y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
    const a2 = -0.1562499995e-1 + y * (0.1430488765e-3 + y * (-0.6911147651e-5 + y * (0.7621095161e-6 - y * 0.934935152e-7)));
    return Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * a1 - z * Math.sin(xx) * a2);
  }
  function besselJ1(x) {
    const ax = Math.abs(x);
    if (ax < 8) {
      const y = x * x;
      const a1 = x * (72362614232.0 + y * (-7895059235.0 + y * (242396853.1 + y * (-2972611.439 + y * (15704.48260 + y * (-30.16036606))))));
      const a2 = 144725228442.0 + y * (2300535178.0 + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
      return a1 / a2;
    }
    const z = 8 / ax, y = z * z, xx = ax - 2.356194491;
    const a1 = 1 + y * (0.183105e-2 + y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * (-0.240337019e-6))));
    const a2 = 0.04687499995 + y * (-0.2002690873e-3 + y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
    const ans = Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * a1 - z * Math.sin(xx) * a2);
    return x < 0 ? -ans : ans;
  }
  function struveH1(x) {
    if (x < 16) { // power series
      let sum = 0, term;
      // H1(x) = sum_k (-1)^k (x/2)^(2k+2) / (Gamma(k+3/2) Gamma(k+5/2))
      // Gamma(3/2)=sqrt(pi)/2, Gamma(5/2)=3 sqrt(pi)/4
      term = (x / 2) * (x / 2) / ((Math.sqrt(Math.PI) / 2) * (3 * Math.sqrt(Math.PI) / 4));
      for (let k = 0; k < 80; k++) {
        sum += term;
        term *= -(x / 2) * (x / 2) / ((k + 1.5) * (k + 2.5));
        if (Math.abs(term) < 1e-17 * Math.abs(sum) && k > 3) break;
      }
      return sum;
    }
    // Aarts & Janssen (2003) approximation, accurate for large x
    return 2 / Math.PI - besselJ0(x) + (16 / Math.PI - 5) * Math.sin(x) / x + (12 - 36 / Math.PI) * (1 - Math.cos(x)) / (x * x);
  }
  /** Acoustic radiation impedance of a baffled circular piston of area S.
   *  m = 2pi/Omega image factor (4pi:0.5, 2pi:1, 1pi:2, 0.5pi:4). */
  function zRad(S, omega, m, air = AIR) {
    const Se = S * m;                       // area of the mirrored piston
    const a = Math.sqrt(Se / Math.PI);
    const x = 2 * (omega / air.c) * a;
    let R, X;
    if (x < 1e-6) { R = x * x / 8; X = 4 * x / (3 * Math.PI); }
    else { R = 1 - 2 * besselJ1(x) / x; X = 2 * struveH1(x) / x; }
    const z0 = air.rho * air.c / Se;
    return cx(m * z0 * R, m * z0 * X);       // seen by the real mouth
  }

  // ---------- duct segment two-ports ----------
  /** Kirchhoff visco-thermal attenuation per metre for area S, perimeter P. */
  function wallAlpha(omega, S, P, air = AIR) {
    if (!P || !S) return 0;
    const nu = air.mu / air.rho;
    return (P / (2 * S)) * Math.sqrt(omega * nu / 2) / air.c * (1 + (air.gamma - 1) / Math.sqrt(air.Pr));
  }

  /** ABCD of one segment. seg = {type:'cyl'|'con'|'exp', S1, S2, L, P1?, P2?}
   *  lossMul: multiplier on Kirchhoff losses (0 = lossless). */
  function segABCD(seg, omega, lossMul, air = AIR) {
    const k0 = omega / air.c;
    const L = seg.L;
    if (L <= 0) return IDENT;
    const Sm = 0.5 * (seg.S1 + seg.S2);
    let alpha = 0;
    if (lossMul > 0) {
      const Pm = 0.5 * ((seg.P1 || 0) + (seg.P2 || 0)) || 2 * Math.sqrt(Math.PI * Sm);
      alpha = lossMul * wallAlpha(omega, Sm, Pm, air);
    }
    alpha += 1e-7 * k0; // tiny loss keeps exact resonances non-singular
    const k = cx(k0 + alpha, -alpha);
    const kr = div(k, cx(k0));                 // k'/k
    const rhoE = scl(mul(kr, kr), air.rho);    // effective density
    const jwr = mul(cx(0, omega), rhoE);       // j w rho'
    let type = seg.type;
    if (type !== 'exp' && Math.abs(seg.S2 / seg.S1 - 1) < 1e-6) type = 'cyl';
    if (type === 'exp' && Math.abs(Math.log(seg.S2 / seg.S1)) < 1e-9) type = 'cyl';

    if (type === 'cyl') {
      const kL = scl(k, L);
      const Zc = div(scl(mul(kr, cx(1)), air.rho * air.c), cx(seg.S1)); // rho c k'/k / S
      const c = ccos(kL), s = csin(kL);
      return [c, mul(J, mul(Zc, s)), div(mul(J, s), Zc), c];
    }

    let Mfun;
    if (type === 'con') {
      const r1 = Math.sqrt(seg.S1), r2 = Math.sqrt(seg.S2);
      const x0 = L * r1 / (r2 - r1);          // apex distance (negative if contracting)
      const S0 = seg.S1;
      Mfun = (xl) => {
        const x = x0 + xl;
        const S = S0 * (x / x0) * (x / x0);
        const e1 = cexp(mul(neg(J), scl(k, xl))), e2 = cexp(mul(J, scl(k, xl)));
        const f1 = scl(e1, 1 / x), f2 = scl(e2, 1 / x);
        const d1 = mul(f1, sub(mul(neg(J), k), cx(1 / x)));
        const d2 = mul(f2, sub(mul(J, k), cx(1 / x)));
        const g = div(cx(-S), jwr); // U = S * (-1/(j w rho)) dp/dx
        return [f1, f2, mul(g, d1), mul(g, d2)];
      };
    } else { // exponential
      const m = Math.log(seg.S2 / seg.S1) / L;
      let beta = csqrt(sub(mul(k, k), cx(m * m / 4)));
      if (abs(beta) < 1e-9) beta = cx(1e-9);
      const g1 = sub(cx(-m / 2), mul(J, beta)), g2 = add(cx(-m / 2), mul(J, beta));
      Mfun = (xl) => {
        const S = seg.S1 * Math.exp(m * xl);
        const f1 = cexp(scl(g1, xl)), f2 = cexp(scl(g2, xl));
        const g = div(cx(-S), jwr);
        return [f1, f2, mul(g, mul(g1, f1)), mul(g, mul(g2, f2))];
      };
    }
    return mmul(Mfun(0), minv(Mfun(L)));
  }

  function chainABCD(pieces, omega, lossMul, air) {
    let T = IDENT;
    for (const p of pieces) T = mmul(T, segABCD(p, omega, lossMul, air));
    return T;
  }

  // ---------- driver ----------
  /** Convert published T/S parameters to the Hornresp-style set.
   *  in: {Fs, Qes, Qms, Vas(L), Re, Le(mH), Sd(cm2), Mms(g)?, Bl?, Xmax(mm)}  */
  function tsToDriver(t, air = AIR) {
    const Sd = t.Sd / 1e4, ws = 2 * Math.PI * t.Fs;
    let Cms, Mms;
    // Published Mms is usually the most reliable mass figure (Hornresp's driver tool uses it too)
    if (t.Mms > 0) {
      Mms = t.Mms / 1000; Cms = 1 / (ws * ws * Mms);
    } else if (t.Vas > 0) {
      Cms = (t.Vas / 1000) / (air.rho * air.c * air.c * Sd * Sd);
      Mms = 1 / (ws * ws * Cms);
    }
    const Rms = ws * Mms / t.Qms;
    const Bl = t.Bl > 0 ? t.Bl : Math.sqrt(ws * Mms * t.Re / t.Qes);
    const a = Math.sqrt(Sd / Math.PI);
    const Mair = 2 * (8 / 3) * air.rho * a * a * a; // both-side air load (Hornresp Mmd)
    return { Sd: t.Sd, Bl, Cms, Rms, Mmd: (Mms - Mair) * 1000, Le: t.Le || 0, Re: t.Re, Xmax: t.Xmax || 0, Pmax: t.Pmax || 0, adv: t.adv };
  }
  /** Inverse: Hornresp set -> T/S for display. */
  function driverToTS(d, air = AIR) {
    const Sd = d.Sd / 1e4, a = Math.sqrt(Sd / Math.PI);
    const Mms = d.Mmd / 1000 + 2 * (8 / 3) * air.rho * a * a * a;
    const ws = 1 / Math.sqrt(Mms * d.Cms);
    return {
      Fs: ws / (2 * Math.PI), Qms: ws * Mms / d.Rms, Qes: ws * Mms * d.Re / (d.Bl * d.Bl),
      Qts: 1 / (1 / (ws * Mms / d.Rms) + 1 / (ws * Mms * d.Re / (d.Bl * d.Bl))),
      Vas: d.Cms * air.rho * air.c * air.c * Sd * Sd * 1000, Mms: Mms * 1000,
    };
  }
  /** Blocked voice-coil impedance: traditional Re + jwLe, or the semi-inductance model when given. */
  function voiceCoilZ(c, w) {
    if (!c.semi) return cx(c.Re, w * c.Le);
    const s = c.semi;
    let Y = cx(0);                                     // admittance of the parallel group (zero values = element absent)
    if (s.Le > 0) Y = add(Y, inv(cx(0, w * s.Le)));
    if (s.Ke > 0) { const r = Math.sqrt(w) * s.Ke * Math.SQRT1_2; Y = add(Y, inv(cx(r, r))); }   // Ke*sqrt(jw): 45 deg
    if (s.Rss > 0) Y = add(Y, cx(1 / s.Rss));
    const par = (Y.r === 0 && Y.i === 0) ? cx(0) : inv(Y);
    return add(cx(s.Rep, w * s.Leb), par);
  }
  /** Composite of N identical drivers (series or parallel wired). */
  function compositeDriver(d, n, wiring) {
    n = Math.max(1, n | 0);
    const ser = wiring === 'series';
    const ez = (v) => (ser ? v * n : v / n);            // electrical impedances: series adds, parallel divides
    const a = d.adv || {};
    const out = {
      Sd: d.Sd * n / 1e4, Bl: ser ? d.Bl * n : d.Bl, Cms: d.Cms / n, Rms: d.Rms * n, Mmd: d.Mmd * n / 1000,
      Le: ez(d.Le) / 1000, Re: ez(d.Re),
    };
    // Semi-inductance voice-coil model (Thorborg & Futtrup): Re' + jwLeb + [ jwLe || Ke*sqrt(jw) || Rss ]
    if (a.semi) out.semi = { Rep: ez(a.Rep || d.Re), Leb: ez(a.Leb || 0) / 1000, Le: ez(a.Le2 || 0) / 1000, Ke: ez(a.Ke || 0), Rss: ez(a.Rss || 0) };
    // Frequency-dependent damping: Rms (FDD) plus 1/(w*Ams) on the mechanical side
    if (a.fdd) { out.fdd = { Ams: (a.Ams || 0) / n }; if (a.Rms2 > 0) out.Rms = a.Rms2 * n; }
    return out;
  }

  // ---------- network ----------
  /**
   * net = {
   *   space: m factor (1 = 2pi), eg: volts, rg: ohms, dist: m,
   *   nodes: [ids...] (strings),
   *   ducts:   [{a, b, pieces:[seg...], loss}],
   *   chambers:[{node, V (m3), Qa?}],
   *   radiators:[{node, S (m2), label}],
   *   drivers: [{front:node|'air', rear:node|'air', d:{Hornresp set}, n, wiring}],
   *   lumped:  [{a, b, Z: (omega)=>complex}]   (optional series elements e.g. end corrections, b may be 'gnd')
   * }
   */
  function prepare(net) {
    const idx = new Map();
    net.nodes.forEach((n, i) => idx.set(n, i));
    let N = net.nodes.length;
    const drivers = net.drivers.map((dr) => {
      const c = compositeDriver(dr.d, dr.n || 1, dr.wiring);
      let f = dr.front, r = dr.rear;
      const o = { c, raw: dr };
      // 'air' sides get their own radiating node
      o.fi = f === 'air' ? (o.fAir = true, N++) : idx.get(f);
      o.ri = r === 'air' ? (o.rAir = true, N++) : idx.get(r);
      return o;
    });
    const ducts = net.ducts.map((d) => ({ ...d, ai: idx.get(d.a), bi: idx.get(d.b) }));
    const chambers = (net.chambers || []).map((c) => ({ ...c, ni: idx.get(c.node) }));
    const radiators = (net.radiators || []).map((r) => ({ ...r, ni: idx.get(r.node) }));
    for (const o of drivers) {
      if (o.fAir) radiators.push({ ni: o.fi, S: o.c.Sd, label: 'driver front', sign: 1 });
      if (o.rAir) radiators.push({ ni: o.ri, S: o.c.Sd, label: 'driver rear', sign: 1 });
    }
    const lumped = (net.lumped || []).map((l) => ({ ...l, ai: idx.get(l.a), bi: l.b === 'gnd' ? -1 : idx.get(l.b) }));
    for (const x of [...ducts, ...chambers, ...radiators, ...lumped]) {
      if (x.ai === undefined && x.ni === undefined) throw new Error('bad node reference');
    }
    return { N, idx, drivers, ducts, chambers, radiators, lumped, net };
  }

  function solveLinear(A, b, n) {
    // Gaussian elimination with partial pivoting (complex), in place
    for (let c = 0; c < n; c++) {
      let p = c, best = abs(A[c][c]);
      for (let r = c + 1; r < n; r++) { const v = abs(A[r][c]); if (v > best) { best = v; p = r; } }
      if (best === 0) { A[c][c] = cx(1e-30); }
      if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; [b[p], b[c]] = [b[c], b[p]]; }
      const piv = A[c][c];
      for (let r = c + 1; r < n; r++) {
        const f = div(A[r][c], piv);
        if (f.r === 0 && f.i === 0) continue;
        for (let k = c; k < n; k++) A[r][k] = sub(A[r][k], mul(f, A[c][k]));
        b[r] = sub(b[r], mul(f, b[c]));
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s = sub(s, mul(A[r][k], x[k]));
      x[r] = div(s, A[r][r]);
    }
    return x;
  }

  /** Solve one frequency. Returns pressures, driver states, radiated flows. */
  function solveAt(P, f, opts = {}) {
    const air = opts.air || AIR;
    const net = P.net, w = 2 * Math.PI * f, N = P.N;
    const eg = opts.eg != null ? opts.eg : (net.eg != null ? net.eg : 2.83);
    const m = net.space || 1;
    const A = Array.from({ length: N }, () => Array.from({ length: N }, () => cx(0)));
    const b = Array.from({ length: N }, () => cx(0));
    const addY = (i, j, y) => { A[i][j] = add(A[i][j], y); };

    for (const d of P.ducts) {
      const T = chainABCD(d.pieces, w, d.loss || 0, air);
      const B = T[1];
      const y11 = div(T[3], B), y12 = neg(inv(B)), y22 = div(T[0], B);
      addY(d.ai, d.ai, y11); addY(d.ai, d.bi, y12); addY(d.bi, d.ai, y12); addY(d.bi, d.bi, y22);
    }
    for (const c of P.chambers) {
      const Ca = c.V / (air.rho * air.c * air.c);
      let y = cx(0, w * Ca);
      if (c.Qa) y = add(y, cx(w * Ca / c.Qa)); // absorption: G = wC/Q
      addY(c.ni, c.ni, y);
    }
    const radZ = P.radiators.map((r) => zRad(r.S, w, m, air));
    P.radiators.forEach((r, i) => addY(r.ni, r.ni, inv(radZ[i])));
    for (const l of P.lumped) {
      const y = inv(l.Z(w));
      addY(l.ai, l.ai, y);
      if (l.bi >= 0) { addY(l.bi, l.bi, y); addY(l.ai, l.bi, neg(y)); addY(l.bi, l.ai, neg(y)); }
    }
    const dstate = P.drivers.map((o) => {
      const c = o.c;
      const Ze = add(cx(net.rg || 0), voiceCoilZ(c, w));
      let Zm = cx(c.Rms, w * c.Mmd - 1 / (w * c.Cms));
      if (c.fdd && c.fdd.Ams > 0) Zm = add(Zm, cx(1 / (w * c.fdd.Ams)));
      const Zmt = add(Zm, div(cx(c.Bl * c.Bl), Ze));
      const Is = div(cx(c.Sd * c.Bl * eg), mul(Ze, Zmt));
      const Yd = div(cx(c.Sd * c.Sd), Zmt);
      addY(o.fi, o.fi, Yd); addY(o.ri, o.ri, Yd); addY(o.fi, o.ri, neg(Yd)); addY(o.ri, o.fi, neg(Yd));
      b[o.fi] = add(b[o.fi], Is); b[o.ri] = sub(b[o.ri], Is);
      return { Ze, Zmt, c };
    });

    const p = solveLinear(A, b, N);

    let Itot = cx(0);
    const drv = P.drivers.map((o, k) => {
      const { Ze, Zmt, c } = dstate[k];
      const dp = sub(p[o.fi], p[o.ri]);
      const u = div(sub(div(cx(c.Bl * eg), Ze), scl(dp, c.Sd)), Zmt); // cone velocity
      const i = div(sub(cx(eg), scl(u, c.Bl)), Ze);
      Itot = add(Itot, i);
      return { u, i, x: div(u, cx(0, w)), pf: p[o.fi], pr: p[o.ri] };
    });
    let Utot = cx(0);
    const dist = net.dist || 1;
    const Omega = 2 * Math.PI / m;
    const Rlf = air.rho * w * w / (Omega * air.c); // low-frequency radiation resistance
    let pff = cx(0), pmono = cx(0);
    const rad = P.radiators.map((r, i) => {
      const U = div(p[r.ni], radZ[i]);
      Utot = add(Utot, U);
      // monopole pressure of this radiator (rms if eg is rms)
      const pm = scl(mul(cx(0, w * air.rho), U), 1 / (Omega * dist));
      pmono = add(pmono, pm);
      // Hornresp "power response": scale so |p|^2 = rho c W / (Omega r^2), W = |U|^2 Re(Zrad)
      pff = add(pff, scl(pm, Math.sqrt(Math.max(0, radZ[i].r) / Rlf)));
      return { U, S: r.S, label: r.label, W: abs(U) * abs(U) * radZ[i].r };
    });
    if (net.splMode === 'pressure') pff = pmono;
    const Zin = div(cx(eg), Itot);
    return { f, p, drv, rad, Utot, pff, Zin, Itot };
  }

  function logFreqs(f0, f1, n) {
    const out = []; for (let i = 0; i < n; i++) out.push(f0 * Math.pow(f1 / f0, i / (n - 1))); return out;
  }

  /** Sweep; returns arrays convenient for plotting. */
  function sweep(net, freqs, opts = {}) {
    const P = prepare(net);
    const res = { f: freqs, spl: [], phase: [], ze: [], zePh: [], x: [], vel: [], pff: [], zin: [], drvX: [], radV: [] };
    for (const f of freqs) {
      const s = solveAt(P, f, opts);
      res.pff.push(s.pff);
      res.spl.push(20 * Math.log10(abs(s.pff) / 2e-5 + 1e-30));
      res.phase.push(arg(s.pff) * 180 / Math.PI);
      res.zin.push(s.Zin);
      res.ze.push(abs(s.Zin));
      res.zePh.push(arg(s.Zin) * 180 / Math.PI);
      res.drvX.push(s.drv.map((d) => abs(d.x) * 1000 * Math.SQRT2)); // peak mm (eg rms)
      res.radV.push(s.rad.map((r) => abs(r.U) / r.S * Math.SQRT2)); // peak particle velocity m/s
      res.x.push(s.drv.length ? Math.max(...s.drv.map((d) => abs(d.x) * 1000 * Math.SQRT2)) : 0);
    }
    res.radLabels = P.radiators.map((r) => r.label || 'radiator');
    return res;
  }

  // ---------------------------------------------------------------- DSP filters (analog prototypes)
  const poleCache = {};
  function butterPoles(n) { const P = []; for (let k = 1; k <= n; k++) { const a = Math.PI * (2 * k + n - 1) / (2 * n); P.push(cx(Math.cos(a), Math.sin(a))); } return P; }
  /** Bessel low-pass poles for order n, normalised to -3 dB at 1 rad/s (roots of the reverse Bessel polynomial). */
  function besselPoles(n) {
    const fact = (k) => { let v = 1; for (let i = 2; i <= k; i++) v *= i; return v; };
    const a = []; for (let k = 0; k <= n; k++) a.push(fact(2 * n - k) / (Math.pow(2, n - k) * fact(k) * fact(n - k)));
    const c = a.map((v) => v / a[n]);                                  // monic
    const ev = (z) => { let r = cx(1); for (let k = n - 1; k >= 0; k--) r = add(mul(r, z), cx(c[k])); return r; };
    let z = []; for (let k = 0; k < n; k++) z.push(mul(cx(Math.pow(c[0], 1 / n)), cexp(cx(0, 2 * Math.PI * (k + 0.25) / n))));
    for (let it = 0; it < 500; it++) {                                 // Durand-Kerner
      let delta = 0;
      z = z.map((zi, i) => { let d = cx(1); z.forEach((zj, j) => { if (j !== i) d = mul(d, sub(zi, zj)); }); const step = div(ev(zi), d); delta = Math.max(delta, abs(step)); return sub(zi, step); });
      if (delta < 1e-14) break;
    }
    const mag = (w) => { let h = cx(1); for (const p of z) h = mul(h, div(scl(p, -1), sub(cx(0, w), p))); return abs(h); };
    let lo = 0.01, hi = 100; for (let i = 0; i < 100; i++) { const m = Math.sqrt(lo * hi); if (mag(m) > Math.SQRT1_2) lo = m; else hi = m; }
    const w3 = Math.sqrt(lo * hi);
    return z.map((p) => scl(cx(p.r < 0 ? p.r : -Math.abs(p.r), p.i), 1 / w3));
  }
  /** unit-cutoff low-pass prototype poles. type: 'BW' Butterworth (-3 dB), 'LR' Linkwitz-Riley (-6 dB, even order), 'BS' Bessel (-3 dB) */
  function protoPoles(type, n) {
    n = Math.max(1, Math.min(8, n | 0)); if (type === 'LR' && n % 2) n += 1;
    const key = type + n; if (poleCache[key]) return poleCache[key];
    const P = type === 'LR' ? butterPoles(n / 2).concat(butterPoles(n / 2)) : type === 'BS' ? besselPoles(n) : butterPoles(n);
    return (poleCache[key] = P);
  }
  /** high-pass / low-pass section: {on, type, order, f} */
  function passH(fl, f, high) {
    let H = cx(1); const s = cx(0, f / fl.f);
    for (const p of protoPoles(fl.type, fl.order)) {
      if (high) { const ps = mul(p, s); H = mul(H, div(scl(ps, -1), sub(cx(1), ps))); }   // s -> 1/s
      else H = mul(H, div(scl(p, -1), sub(s, p)));
    }
    return H;
  }
  /** parametric band: {on, type: 'pk' | 'ls' | 'hs', f, g (dB), q} — analog (RBJ-style) biquads */
  function peqH(b, f) {
    const A = Math.pow(10, b.g / 40), q = b.q > 0 ? b.q : 0.707, s = cx(0, f / b.f), s2 = mul(s, s);
    if (b.type === 'ls') { const k = Math.sqrt(A) / q; return scl(div(add(add(s2, scl(s, k)), cx(A)), add(add(scl(s2, A), scl(s, k)), cx(1))), A); }
    if (b.type === 'hs') { const k = Math.sqrt(A) / q; return scl(div(add(add(scl(s2, A), scl(s, k)), cx(1)), add(add(s2, scl(s, k)), cx(A))), A); }
    return div(add(add(s2, scl(s, A / q)), cx(1)), add(add(s2, scl(s, 1 / (A * q))), cx(1)));
  }
  /** whole DSP chain {hp, lp, peq: [...], gain} at frequency f */
  function dspH(d, f) {
    let H = cx(1); if (!d) return H;
    if (d.hp && d.hp.on && d.hp.f > 0) H = mul(H, passH(d.hp, f, true));
    if (d.lp && d.lp.on && d.lp.f > 0) H = mul(H, passH(d.lp, f, false));
    for (const b of d.peq || []) if (b.on && b.f > 0 && b.g) H = mul(H, peqH(b, f));
    if (d.gain) H = scl(H, Math.pow(10, d.gain / 20));
    return H;
  }

  root.HornCore = {
    AIR, cx, add, sub, mul, div, inv, abs, arg, scl, cexp, zRad, voiceCoilZ, segABCD, chainABCD, tsToDriver, driverToTS,
    compositeDriver, prepare, solveAt, sweep, logFreqs, besselJ1, struveH1, protoPoles, dspH,
  };
})(typeof module !== 'undefined' && module.exports ? (module.exports = {}, module.exports) : (typeof window !== 'undefined' ? window : globalThis));
