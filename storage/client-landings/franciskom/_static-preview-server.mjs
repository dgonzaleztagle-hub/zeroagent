import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const rootPrefix = `${root}${path.sep}`;
const host = '127.0.0.1';
const port = Number(process.env.PORT || 5540);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function resolvePublicFile(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl || '/', 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname === '/') pathname = '/landing.html';
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some(segment => segment === '..' || segment.startsWith('.'))) return null;
  const file = path.resolve(root, segments.join(path.sep));
  if (file !== root && !file.startsWith(rootPrefix)) return null;
  if (!types[path.extname(file).toLowerCase()]) return null;
  return file;
}

http.createServer((req, res) => {
  const file = resolvePublicFile(req.url);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
    return res.end('not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': types[path.extname(file).toLowerCase()],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(data);
  });
}).listen(port, host, () => console.log(`preview on http://${host}:${port}`));
