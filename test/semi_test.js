const H = require('../src/core.js').HornCore;
const base = { Sd: 855, Bl: 23, Cms: 8.14e-5, Rms: 10.86, Mmd: 215, Le: 1.6, Re: 5.1 };
// 1) semi model with only Re' and Leb must equal the traditional model
const c0 = H.compositeDriver(base, 1, 'parallel');
const c1 = H.compositeDriver({ ...base, adv: { semi: true, Rep: 5.1, Leb: 1.6, Le2: 0, Ke: 0, Rss: 0 } }, 1, 'parallel');
let maxd = 0; for (const f of [20, 100, 1000, 5000]) { const w = 2 * Math.PI * f; const a = H.voiceCoilZ(c0, w), b = H.voiceCoilZ(c1, w); maxd = Math.max(maxd, Math.hypot(a.r - b.r, a.i - b.i)); }
console.log('reduces to traditional: max |dZ| =', maxd.toExponential(2), 'ohm');
// 2) example set (Infinity 122.7W, diysubwoofers.org): independent complex arithmetic
const ex = { Rep: 4.507, Leb: 1.540, Le2: 6.652, Ke: 0.344, Rss: 150.761 };
const c2 = H.compositeDriver({ ...base, Re: 4.507, adv: { semi: true, ...ex } }, 1, 'parallel');
function ref(f) {           // Ze = Re' + jwLeb + 1/(1/(jwLe) + 1/(Ke*sqrt(jw)) + 1/Rss), done by hand
  const w = 2 * Math.PI * f, sq = Math.sqrt(w / 2);         // sqrt(jw) = sqrt(w/2)*(1+j)
  const zl = [0, w * ex.Le2 / 1000], zk = [ex.Ke * sq, ex.Ke * sq];
  const inv = ([a, b]) => [a / (a * a + b * b), -b / (a * a + b * b)];
  const y = [inv(zl)[0] + inv(zk)[0] + 1 / ex.Rss, inv(zl)[1] + inv(zk)[1]];
  const zp = inv(y); return [ex.Rep + zp[0], w * ex.Leb / 1000 + zp[1]];
}
for (const f of [20, 100, 500, 1000, 5000, 10000]) {
  const z = H.voiceCoilZ(c2, 2 * Math.PI * f), r = ref(f);
  console.log(`f ${String(f).padStart(5)} Hz  |Ze| ${Math.hypot(z.r, z.i).toFixed(3)} ohm  phase ${(Math.atan2(z.i, z.r) * 180 / Math.PI).toFixed(1)} deg   ref ${Math.hypot(...r).toFixed(3)}   traditional Re+jwLe(8.2mH) ${Math.hypot(4.507, 2 * Math.PI * f * 0.008192).toFixed(2)}`);
}
// 3) Ke alone: magnitude slope -> 3 dB/oct at high f
const c3 = H.compositeDriver({ ...base, adv: { semi: true, Rep: 0.001, Leb: 0, Le2: 0, Ke: 0.5, Rss: 0 } }, 1, 'parallel');
const m = (f) => Math.hypot(H.voiceCoilZ(c3, 2 * Math.PI * f).r, H.voiceCoilZ(c3, 2 * Math.PI * f).i);
console.log('semi-inductor alone: slope', (20 * Math.log10(m(4000) / m(2000))).toFixed(2), 'dB/oct (expect 3.01), phase', (Math.atan2(H.voiceCoilZ(c3, 1e4).i, H.voiceCoilZ(c3, 1e4).r) * 180 / Math.PI).toFixed(1), 'deg (expect 45)');
// 4) FDD: impedance peak height falls when resonance is lowered (mass added) — the effect the paper describes
const net = (mm, fdd) => ({ space: 0.5, eg: 2.83, nodes: [], ducts: [], chambers: [], radiators: [], drivers: [{ front: 'air', rear: 'air', d: { ...base, Mmd: mm, adv: fdd ? { fdd: true, Rms2: 6, Ams: 2e-4 } : undefined } }] });
for (const fdd of [false, true]) {
  const peaks = [215, 400].map((mm) => { const r = H.sweep(net(mm, fdd), H.logFreqs(10, 200, 400)); const i = r.ze.indexOf(Math.max(...r.ze)); return `${r.f[i].toFixed(1)} Hz ${r.ze[i].toFixed(1)} ohm`; });
  console.log((fdd ? 'FDD   ' : 'plain ') + 'impedance peak, normal / extra mass:', peaks.join('  ->  '));
}
