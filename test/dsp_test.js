const HC = require('../src/core.js').HornCore;
const db = (h) => 20 * Math.log10(HC.abs(h));
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
for (const [t, n, at] of [['BW', 2, -3.01], ['BW', 4, -3.01], ['LR', 4, -6.02], ['LR', 8, -6.02], ['BS', 2, -3.01], ['BS', 4, -3.01], ['BS', 8, -3.01], ['BW', 1, -3.01], ['BS', 3, -3.01]]) {
  const lp = { on: true, type: t, order: n, f: 100 };
  const a = db(HC.dspH({ lp }, 100)), b = db(HC.dspH({ hp: lp }, 100));
  const slope = db(HC.dspH({ lp }, 3200)) - db(HC.dspH({ lp }, 6400));
  ok(Math.abs(a - at) < 0.02 && Math.abs(b - at) < 0.02 && Math.abs(slope - 6.02 * n) < 0.3 && Math.abs(db(HC.dspH({ lp }, 1))) < 0.01, `${t}${n}: LP ${a.toFixed(2)} / HP ${b.toFixed(2)} dB at fc, asymptote ${slope.toFixed(1)} dB/oct, DC 0`);
}
// LR4 sums flat (LP + HP in phase)
let worst = 0; for (const f of [20, 50, 100, 200, 500]) { const s = HC.add(HC.dspH({ lp: { on: true, type: 'LR', order: 4, f: 100 } }, f), HC.dspH({ hp: { on: true, type: 'LR', order: 4, f: 100 } }, f)); worst = Math.max(worst, Math.abs(db(s))); }
ok(worst < 1e-6, `LR4 LP+HP sums flat (worst ${worst.toExponential(1)} dB)`);
// Bessel group delay flat-ish: order 4 delay at 0.1 fc vs DC
const pk = { on: true, type: 'pk', f: 50, g: -6, q: 4 };
ok(Math.abs(db(HC.dspH({ peq: [pk] }, 50)) + 6) < 1e-9 && Math.abs(db(HC.dspH({ peq: [pk] }, 5))) < 0.05, 'peak -6 dB at 50 Hz, ~0 far away');
const ls = { on: true, type: 'ls', f: 40, g: 4, q: 0.707 }, hs = { on: true, type: 'hs', f: 40, g: -5, q: 0.707 };
ok(Math.abs(db(HC.dspH({ peq: [ls] }, 2)) - 4) < 0.02 && Math.abs(db(HC.dspH({ peq: [ls] }, 2000))) < 0.02 && Math.abs(db(HC.dspH({ peq: [ls] }, 40)) - 2) < 0.02, 'low shelf +4 dB below, 0 above, half at f');
ok(Math.abs(db(HC.dspH({ peq: [hs] }, 2000)) + 5) < 0.02 && Math.abs(db(HC.dspH({ peq: [hs] }, 2))) < 0.02, 'high shelf -5 dB above, 0 below');
const old = (f) => { const b2 = (s) => HC.inv(HC.add(HC.add(HC.mul(s, s), HC.scl(s, Math.SQRT2)), HC.cx(1))); const s = HC.cx(0, f / 100); const b = b2(s); return HC.mul(b, b); };
let dd = 0; for (const f of [10, 50, 100, 300]) dd = Math.max(dd, HC.abs(HC.sub(old(f), HC.dspH({ lp: { on: true, type: 'LR', order: 4, f: 100 } }, f)))); ok(dd < 1e-9, 'LR4 low-pass identical to the old built-in crossover');
