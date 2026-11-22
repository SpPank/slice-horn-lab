const H = require('../src/core.js').HornCore;
const { readExport, compare } = require('./validate.js');
const ref = readExport('C:/Hornresp/Export/8coax_all.txt');
const drv = { Sd: 220, Bl: 12, Cms: 3.4e-4, Rms: 0.59, Mmd: 18.5, Le: 0.3, Re: 5.64 };
const rho=1.205,c=344;
function net(ecK, QL, fb) {
  const Ap = 37/1e4, Lpt = 0.1544, a = Math.sqrt(Ap/Math.PI);
  const n = { space:1, eg:2.83, nodes:['rc','pin','pout'], drivers:[{front:'air',rear:'rc',d:drv}],
    chambers:[{node:'rc',V:8.5e-3}], radiators:[{node:'pout',S:Ap,label:'port'}],
    ducts:[{a:'pin',b:'pout',pieces:[{type:'cyl',S1:Ap,S2:Ap,L:Lpt}]}],
    lumped:[{a:'rc',b:'pin',Z:(w)=>H.cx(0,w*rho*ecK*a/Ap)}] };
  if (QL) { const Ca=8.5e-3/(rho*c*c); const R = QL/(2*Math.PI*fb*Ca); n.lumped.push({a:'rc',b:'gnd',Z:()=>H.cx(R,0)}); }
  return n;
}
for (const k of [0, 0.613, 0.732, 0.85]) compare('ec '+k, net(k), ref, 300);
for (const q of [5,7,10,15]) compare('ec .85 QL '+q, net(0.85,q,85), ref, 300);
