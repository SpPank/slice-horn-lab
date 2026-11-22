// Compare HornCore against Hornresp exports in C:\Hornresp\Export
const fs = require('fs');
const H = require('../src/core.js').HornCore;

function readExport(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^\d/.test(l));
  return lines.map((l) => { const v = l.split('\t').map(Number); return { f: v[0], spl: v[4], ze: v[5], xd: v[6], ph: v[7], delay: v[10] }; });
}

function compare(name, net, ref, fmax = 500, opts = {}) {
  const pts = ref.filter((r) => r.f <= fmax);
  const P = H.prepare(net);
  let eS = 0, eZ = 0, eX = 0, worst = null;
  const rows = [];
  for (const r of pts) {
    const s = H.solveAt(P, r.f, opts);
    const spl = 20 * Math.log10(H.abs(s.pff) / 2e-5);
    const ze = H.abs(s.Zin);
    const xd = H.abs(s.drv[0].x) * 1000 * Math.SQRT2;
    const dS = spl - r.spl, dZ = (ze - r.ze) / r.ze * 100, dX = (xd - r.xd) / r.xd * 100;
    eS = Math.max(eS, Math.abs(dS)); eZ = Math.max(eZ, Math.abs(dZ)); eX = Math.max(eX, Math.abs(dX));
    if (!worst || Math.abs(dS) > Math.abs(worst.dS)) worst = { f: r.f, dS, spl, ref: r.spl };
    rows.push([r.f, spl, r.spl, ze, r.ze, xd, r.xd]);
  }
  console.log(`${name}: max |dSPL| ${eS.toFixed(3)} dB, max dZe ${eZ.toFixed(2)} %, max dXd ${eX.toFixed(2)} %  (worst SPL @ ${worst.f.toFixed(1)} Hz: ${worst.spl.toFixed(2)} vs ${worst.ref.toFixed(2)})`);
  return rows;
}

const flhDrv = { Sd: 855, Bl: 23, Cms: 8.14e-5, Rms: 10.86, Mmd: 215, Le: 1.6, Re: 5.1 };
function flh(S1, S2, L, Vrc, Vtc, Lrc, Atc, rcTube) {
  const net = {
    space: 1, eg: 2.83, nodes: ['tc', 'th', 'mouth', 'rc'],
    ducts: [{ a: 'th', b: 'mouth', pieces: [{ type: 'exp', S1: S1 / 1e4, S2: S2 / 1e4, L: L / 100 }] }],
    chambers: [], radiators: [{ node: 'mouth', S: S2 / 1e4, label: 'mouth' }],
    drivers: [{ front: 'tc', rear: 'rc', d: flhDrv, n: 1 }],
  };
  if (Atc > 0 && rcTube) {
    // throat chamber as a short cylinder of area Atc
    net.ducts.push({ a: 'tc', b: 'th', pieces: [{ type: 'cyl', S1: Atc / 1e4, S2: Atc / 1e4, L: (Vtc / Atc) / 100 }] });
  } else {
    net.nodes = net.nodes.filter((n) => n !== 'th'); net.ducts[0].a = 'tc';
    net.chambers.push({ node: 'tc', V: Vtc / 1e6 });
  }
  if (rcTube && Lrc > 0) {
    net.nodes.push('rcEnd');
    net.ducts.push({ a: 'rc', b: 'rcEnd', pieces: [{ type: 'cyl', S1: Vrc / 1000 / (Lrc / 100), S2: Vrc / 1000 / (Lrc / 100), L: Lrc / 100 }] });
  } else net.chambers.push({ node: 'rc', V: Vrc / 1000 });
  return net;
}

const v1 = readExport('C:/Hornresp/Export/flh_v1.txt');
const v2 = readExport('C:/Hornresp/Export/flh_v2.txt');
compare('FLH v1 lumped chambers', flh(280, 2100, 340, 50, 2300, 30, 855, false), v1);
compare('FLH v1 tube chambers  ', flh(280, 2100, 340, 50, 2300, 30, 855, true), v1);
compare('FLH v2 lumped chambers', flh(465, 1100, 250, 57, 2000, 30, 855, false), v2);
compare('FLH v2 tube chambers  ', flh(465, 1100, 250, 57, 2000, 30, 855, true), v2);
module.exports = { readExport, compare };
