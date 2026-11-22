// Tapped-horn tuning study: what moves the response hump? Uses the same engine as the app.
global.HornCore = require('../src/core.js').HornCore;
const G = require('../src/geom.js').HornGeom, H = global.HornCore;
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../SliceHornLab.html', 'utf8');
global.window = {}; eval(html.match(/window.DRIVER_LIB=(.*?);<\/script>/s)[0].replace('</script>', ''));
const LIB = window.DRIVER_LIB;
const spec = LIB.find((d) => d.k === 'PE:B&C 18SW115-4 [sheet]') || LIB.find((d) => /18SW115-4/.test(d.m));
const hr = H.tsToDriver(spec);

function design(o = {}) {
  const W = o.W || 535, t = 18, P = []; let id = 0;
  const p = (x1, y1, x2, y2) => P.push({ id: ++id, x1, y1, x2, y2 });
  const H0 = o.H || 1016, D0 = o.D || 724;
  const top = H0 - 9, tin = H0 - 18;
  p(0, top, D0, top); p(0, 9, D0 - 164, 9); p(D0 - 9, tin, D0 - 9, 164); p(D0 - 164, 9, D0 - 9, 164);
  p(9, tin, 9, 520);
  const s1Top = tin - (o.gapTop1 != null ? o.gapTop1 : 129);            // fold 1 top gap
  p(131.6, 629, 148, s1Top);
  const dBot = tin - (o.divLen != null ? o.divLen : 296);               // divider hanging from the top
  p(o.divX || 304, tin, o.divX || 304, dBot);
  const s2Top = tin - (o.gapTop2 != null ? o.gapTop2 : 187);
  p(480, 330, 500, s2Top);
  p(131.6, 629, 482, 392);
  p(18, 517, 480, 330);
  p(D0 - 126, tin, D0 - 18, tin - 108);
  const f = o.drvF != null ? o.drvF : 0.468;
  const dx = 462, dy = -187, L = Math.hypot(dx, dy);
  const drivers = [{ id: 99, x: 18 + dx * f, y: 517 + dy * f, nx: -dy / L, ny: dx / L, key: 'x', n: 1, wiring: 'parallel' }];
  const d = { W, t, space: 1, eg: 2.83, losses: false, QL: 7, panels: P, boundaries: [], paths: [], drivers };
  d.paths = G.autoPaths(d).map((a, i) => ({ id: 200 + i, name: 'A', pts: a.pts, loss: 1 }));
  return d;
}
const freqs = H.logFreqs(15, 200, 260);
function hump(d) {
  const A = G.analyse(d, () => hr);
  if (!A.net.drivers.length) return null;
  const r = H.sweep(A.net, freqs);
  let bi = 0; for (let i = 0; i < freqs.length; i++) if (freqs[i] < 120 && r.spl[i] > r.spl[bi]) bi = i;
  // first local maximum above 20 Hz (the low hump)
  let fi = -1; for (let i = 2; i < freqs.length - 2; i++) if (freqs[i] > 20 && r.spl[i] > r.spl[i - 1] && r.spl[i] >= r.spl[i + 1] && r.spl[i] > r.spl[bi] - 6) { fi = i; break; }
  const lvl = (f) => r.spl[freqs.findIndex((x) => x >= f)];
  return { L: A.paths[0] ? Math.round(A.paths[0].sB - A.paths[0].sA) : 0, hump: fi >= 0 ? +freqs[fi].toFixed(1) : null, humpDb: fi >= 0 ? +r.spl[fi].toFixed(1) : null,
    at30: +lvl(30).toFixed(1), at35: +lvl(35).toFixed(1), at40: +lvl(40).toFixed(1), at50: +lvl(50).toFixed(1), at80: +lvl(80).toFixed(1), xmax: Math.max(...r.x.filter((_, i) => freqs[i] > 25)).toFixed(2), warn: A.warnings.length };
}
module.exports = { design, hump };
if (require.main === module) {
  console.log('driver', spec.k);
  console.log('base     ', JSON.stringify(hump(design())));
  for (const W of [600, 700]) console.log('W ' + W + '    ', JSON.stringify(hump(design({ W }))));
  for (const f of [0.3, 0.6]) console.log('drvF ' + f + ' ', JSON.stringify(hump(design({ drvF: f }))));
  for (const g of [60, 90]) console.log('gapTop1 ' + g, JSON.stringify(hump(design({ gapTop1: g }))));
  for (const l of [420, 520]) console.log('divLen ' + l, JSON.stringify(hump(design({ divLen: l }))));
  for (const g of [100]) console.log('gapTop2 ' + g, JSON.stringify(hump(design({ gapTop2: g }))));
}
