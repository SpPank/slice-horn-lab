global.HornCore = require('../src/core.js').HornCore;
const G = require('../src/geom.js').HornGeom, H = global.HornCore;
const { design } = require('./th_study.js');
const LIB = window.DRIVER_LIB;
const freqs = H.logFreqs(15, 200, 260);
function run(d, spec) {
  const hr = H.tsToDriver(spec);
  const A = G.analyse(d, () => hr); const r = H.sweep(A.net, freqs);
  let fi = -1, top = Math.max(...r.spl.filter((_, i) => freqs[i] < 120));
  for (let i = 2; i < freqs.length - 2; i++) if (freqs[i] > 20 && r.spl[i] > r.spl[i - 1] && r.spl[i] >= r.spl[i + 1] && r.spl[i] > top - 6) { fi = i; break; }
  const lvl = (f) => r.spl[freqs.findIndex((x) => x >= f)].toFixed(1);
  return `L ${Math.round(A.paths[0].sB - A.paths[0].sA)}mm  hump ${freqs[fi].toFixed(1)} Hz (${r.spl[fi].toFixed(1)} dB)  30Hz ${lvl(30)}  35Hz ${lvl(35)}  40Hz ${lvl(40)}  60Hz ${lvl(60)}  100Hz ${lvl(100)}`;
}
function scaled(s, o = {}) {           // the whole side view scaled by s (path length scales with it)
  const d = design(o);
  d.panels.forEach((p) => { p.x1 *= s; p.y1 *= s; p.x2 *= s; p.y2 *= s; });
  d.drivers.forEach((q) => { q.x *= s; q.y *= s; });
  d.paths = G.autoPaths(d).map((a, i) => ({ id: 200 + i, name: 'A', pts: a.pts, loss: 1 }));
  return d;
}
const sw = LIB.find((d) => d.k === 'PE:B&C 18SW115-4 [sheet]');
console.log('18SW115-4, side view scaled up (same 535 mm width):');
for (const s of [1.0, 1.1, 1.15, 1.2]) console.log(`  x${s.toFixed(2)}  (${Math.round(724 * s)} x ${Math.round(1016 * s)} mm)  `, run(scaled(s), sw));
console.log('18SW115-4, scaled x1.1 and 640 mm wide:', run(scaled(1.1, { W: 640 }), sw));
console.log('\nSame cabinet (724 x 1016 x 535), other 18s:');
for (const k of ['PE:B&C 18DS115 [sheet]', 'PE:B&C 18TBX100', 'MFR:Faital Pro 18XL1600 8Ω', 'MFR:Faital Pro 18HP1060 8Ω', 'PE:Faital Pro 18FH500 (spec sheet)'.replace(' (spec sheet)', ' [sheet]'), 'PE:Eminence NLF18']) {
  const sp = LIB.find((d) => d.k === k) || LIB.find((d) => d.k.startsWith(k.split(' [')[0]));
  if (sp) console.log(`  ${sp.b} ${sp.m}  Fs ${sp.Fs}  `, run(design(), sp));
}
