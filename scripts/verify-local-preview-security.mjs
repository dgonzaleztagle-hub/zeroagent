import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: requestPath }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end();
  });
}

const port = await freePort();
const child = spawn(process.execPath, ['storage/client-landings/franciskom/_static-preview-server.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

try {
  const deadline = Date.now() + 8_000;
  while (!output.includes('preview on') && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Preview terminó antes de iniciar.\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  assert.match(output, new RegExp(`http://127\\.0\\.0\\.1:${port}`), 'el preview debe escuchar sólo en loopback');
  assert.equal((await request(port, '/')).status, 200, 'la landing debe seguir disponible');
  assert.equal((await request(port, '/landing.html?preview=1')).status, 200, 'los query params no deben romper assets válidos');
  assert.equal((await request(port, '/../../../.env')).status, 404, 'debe rechazar traversal literal');
  assert.equal((await request(port, '/%2e%2e/%2e%2e/.env')).status, 404, 'debe rechazar traversal codificado');
  assert.equal((await request(port, '/_static-preview-server.mjs')).status, 404, 'no debe servir código auxiliar');
  console.log('OK: preview local sirve assets públicos y rechaza traversal/dotfiles en loopback.');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000))
  ]);
}
