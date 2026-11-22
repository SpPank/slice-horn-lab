const H = require('../src/core.js').HornCore;
const fs=require('fs');
const lines = fs.readFileSync('C:/Hornresp/Export/8coax_all.txt','utf8').split(/\r?\n/).filter(l=>/^\d/.test(l)).map(l=>l.split('\t').map(Number)).filter(v=>v[0]<=300);
const drv = { Sd: 220, Bl: 12, Cms: 3.4e-4, Rms: 0.59, Mmd: 18.5, Le: 0.3, Re: 5.64 };
const rho=1.205,c=344, Ap=37/1e4, Lpt=0.1544, a=Math.sqrt(Ap/Math.PI), V=8.5e-3, Ca=V/(rho*c*c);
// ref impedance extrema
let zmin=1e9,fmin=0; for(const v of lines){ if(v[0]>50&&v[0]<120&&v[5]<zmin){zmin=v[5];fmin=v[0];} }
console.log('ref Ze min', zmin.toFixed(3),'@',fmin.toFixed(2));
function err(ecK,QL,mode){
  const Leff = Lpt + ecK*a + 0.8488*a; // inner + outer (baffled) for fb
  const fb = c/(2*Math.PI)*Math.sqrt(Ap/(V*Leff));
  const R = QL>0? QL/(2*Math.PI*fb*Ca):1e12;
  const n = { space:1, eg:2.83, nodes:['rc','pin','pout'], drivers:[{front:'air',rear:'rc',d:drv}],
    chambers:[{node:'rc',V}], radiators:[{node:'pout',S:Ap,label:'port'}],
    ducts:[{a:'pin',b:'pout',pieces:[{type:'cyl',S1:Ap,S2:Ap,L:Lpt}]}],
    lumped:[{a:'rc',b:'gnd',Z:()=>H.cx(R,0)}] };
  if(ecK>0) n.lumped.push({a:'rc',b:'pin',Z:(w)=>H.cx(0,w*rho*ecK*a/Ap)}); else { n.nodes=['rc','pout']; n.ducts[0].a='rc'; }
  if(mode) n.splMode=mode;
  const P=H.prepare(n); let e=0,es=0,ex=0;
  for(const v of lines){ const s=H.solveAt(P,v[0]); const z=H.abs(s.Zin); e+=((z-v[5])/v[5])**2; es+=(20*Math.log10(H.abs(s.pff)/2e-5)-v[4])**2; ex=Math.max(ex,Math.abs(20*Math.log10(H.abs(s.pff)/2e-5)-v[4]));}
  return [Math.sqrt(e/lines.length)*100, Math.sqrt(es/lines.length), ex];
}
let best=null;
for(let ec=0;ec<=1.3;ec+=0.01) for(const QL of [0,3,4,5,6,7,8,9,10,12,15,20,30,50,100]){ const [e]=err(ec,QL); if(!best||e<best.e) best={ec,QL,e}; }
console.log('best', best, err(best.ec,best.QL), err(best.ec,best.QL,'pressure'));
// refine: leak R referenced to an arbitrary frequency fr
function err2(ecK,fr){
  const R = 7/(2*Math.PI*fr*Ca);
  const n = { space:1, eg:2.83, nodes:['rc','pin','pout'], drivers:[{front:'air',rear:'rc',d:drv}],
    chambers:[{node:'rc',V}], radiators:[{node:'pout',S:Ap,label:'port'}],
    ducts:[{a:'pin',b:'pout',pieces:[{type:'cyl',S1:Ap,S2:Ap,L:Lpt}]}],
    lumped:[{a:'rc',b:'gnd',Z:()=>H.cx(R,0)},{a:'rc',b:'pin',Z:(w)=>H.cx(0,w*rho*ecK*a/Ap)}] };
  const P=H.prepare(n); let e=0;
  for(const v of lines){ const s=H.solveAt(P,v[0]); const z=H.abs(s.Zin); e+=((z-v[5])/v[5])**2; }
  return Math.sqrt(e/lines.length)*100;
}
let b2=null; for(let ec=0.55;ec<=0.75;ec+=0.0025) for(let fr=60;fr<=100;fr+=0.5){const e=err2(ec,fr); if(!b2||e<b2.e)b2={ec,fr,e};}
console.log('refined',b2, 'Helmholtz fb w/ ec+0.8488:', (c/(2*Math.PI)*Math.sqrt(Ap/(V*(Lpt+(b2.ec+0.8488)*a)))).toFixed(2), 'w/ 2*ec:',(c/(2*Math.PI)*Math.sqrt(Ap/(V*(Lpt+(2*b2.ec)*a)))).toFixed(2), 'a=',a);
