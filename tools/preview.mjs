// Serves dist/ under the same base path as GitHub Pages: http://127.0.0.1:4180/userscript-library/
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const { basePath } = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));
const port = Number(process.env.PORT) || 4180;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/' || pathname === basePath.slice(0, -1)) { res.writeHead(302, { Location: basePath }); return res.end(); }
  if (!pathname.startsWith(basePath)) { res.writeHead(404); return res.end('Not found'); }
  let target = path.resolve(dist, '.' + decodeURIComponent(pathname.slice(basePath.length - 1)));
  if (target !== dist && !target.startsWith(dist + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${port}${basePath}`));
