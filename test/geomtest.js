global.HornCore = require('../src/core.js').HornCore;
const G = require('../src/geom.js').HornGeom;
const H = global.HornCore;
const drv = { Sd: 220, Bl: 12, Cms: 3.4e-4, Rms: 0.59, Mmd: 18.5, Le: 0.3, Re: 5.64 };
const lib = () => drv;
function box(port){
  const d = { W:300, t:18, space:1, eg:2.83, panels:[
    {id:1,x1:-18,y1:-9,x2:318,y2:-9},{id:2,x1:-18,y1:309,x2:318,y2:309},
    {id:3,x1:-9,y1:0,x2:-9,y2:300},{id:4,x1:309,y1:port?40:0,x2:309,y2:300}], paths:[], drivers:[{id:1,x:309,y:180,nx:1,ny:0,key:'x'}]};
  if(port){ d.panels.push({id:5,x1:150,y1:49,x2:300,y2:49}); d.paths.push({id:1,pts:[{x:150,y:20},{x:318,y:20}]}); }
  return d;
}
for (const port of [false,true]){
  const t0=Date.now(); const A = G.analyse(box(port), lib); const t1=Date.now();
  console.log(port?'VENTED':'SEALED', 'analyse ms', t1-t0, 'warnings', A.warnings);
  A.regions.forEach((r,l)=>r&&console.log(' region',l,r.kind,'V(L)=',r.V.toFixed(2), r.Vnet?('net '+r.Vnet.toFixed(2)):'', r.fb?('fb '+r.fb.toFixed(1)):'', r.unused?'unused':''));
  for(const P of A.paths){ const h=P.m.samples.map(s=>s.h); console.log(' path L',P.m.L.toFixed(1),'h min/max',Math.min(...h).toFixed(1),Math.max(...h).toFixed(1),'ends',P.ends.map(e=>e.kind+(e.endCorr?'+ec':''))); }
  console.log(' net nodes',A.net.nodes, 'drivers', A.net.drivers.map(d=>d.front+'/'+d.rear));
  const r = H.sweep(A.net, H.logFreqs(10,500,12));
  console.log(' f  ', r.f.map(x=>x.toFixed(0)).join(' '));
  console.log(' spl', r.spl.map(x=>x.toFixed(1)).join(' '));
  console.log(' ze ', r.ze.map(x=>x.toFixed(1)).join(' '));
  const t2=Date.now(); H.sweep(A.net, H.logFreqs(10,2000,400)); console.log(' 400pt sweep ms', Date.now()-t2);
}
