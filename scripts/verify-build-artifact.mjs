import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const argument = process.argv[2];
assert.ok(argument, 'Uso: node scripts/verify-build-artifact.mjs <carpeta-del-build>');
const buildRoot = path.resolve(process.cwd(), argument);
assert.ok((await stat(buildRoot)).isDirectory(), `No existe el build: ${buildRoot}`);

const readJson = async file => JSON.parse(await readFile(path.join(buildRoot, file), 'utf8'));
const [build, installation, agentPackage, manifest, verification] = await Promise.all([
  readJson('BUILD.json'),
  readJson('INSTALLATION.json'),
  readJson('agent-package.json'),
  readJson('BUILD-MANIFEST.json'),
  readJson('BUILD-VERIFICATION.json')
]);

const actualFiles = [];
async function visit(directory, relativeDirectory = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(relativeDirectory, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(absolute, relative);
    else if (entry.isFile() && relative !== 'BUILD-MANIFEST.json') {
      const data = await readFile(absolute);
      actualFiles.push({
        path: relative.split(path.sep).join('/'),
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex')
      });
    }
  }
}
await visit(buildRoot);
actualFiles.sort((a, b) => a.path.localeCompare(b.path));

assert.equal(manifest.algorithm, 'sha256');
assert.deepEqual(actualFiles, manifest.files, 'el contenido del build no coincide con su manifiesto');
const artifactHash = createHash('sha256').update(actualFiles.map(file => `${file.path}:${file.sha256}`).join('\n')).digest('hex');
assert.equal(manifest.artifact_sha256, artifactHash, 'el hash global del artefacto no coincide');
assert.equal(agentPackage.business.id, build.client_id, 'BUILD y agent-package deben pertenecer al mismo cliente');
assert.equal(agentPackage.package_version, build.package_version, 'BUILD y agent-package deben congelar la misma versión');
assert.equal(installation.client_id, build.client_id, 'INSTALLATION debe pertenecer al mismo cliente');
assert.equal(verification.passed, true, 'la suite ejecutada dentro del artefacto debe haber pasado');
assert.ok(actualFiles.some(file => file.path === 'package-lock.json'), 'el artefacto debe incluir package-lock.json para npm ci');
assert.ok(!actualFiles.some(file => file.path.startsWith('node_modules/') || file.path.startsWith('.vercel/')), 'el artefacto fuente no debe copiar dependencias ni estado de deploy');
assert.ok(!actualFiles.some(file => /(^|\/)\.env(\.|$)/.test(file.path) && file.path !== '.env.example'), 'el artefacto no debe contener credenciales .env');

for (const asset of build.landing_overlay || []) {
  assert.ok(actualFiles.some(file => file.path === `public/${asset}`), `falta el asset propio public/${asset}`);
}
if ((build.landing_overlay || []).length) {
  assert.ok(actualFiles.some(file => file.path === 'public/landing.html'), 'un overlay de landing debe proporcionar public/landing.html');
}

console.log(`OK: ${build.client_id} ${build.package_version} (${actualFiles.length} archivos, sha256 ${artifactHash.slice(0, 12)}…).`);
