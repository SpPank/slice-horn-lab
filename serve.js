// Tiny static server for previewing the app: node serve.js  ->  http://localhost:8765/
const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname;
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/SliceHornLab.html';
  const f = path.join(root, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' }[path.extname(f)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(8765, () => console.log('Slice Horn Lab at http://localhost:8765/'));
