import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const report = { id, startedAt: new Date().toISOString(), scope: 'local-offline-and-temporary-sqlite', checks: [], files: [] };
const env = { ...process.env, STUDIO_DB_BACKEND: 'sqlite' };
// Ninguna prueba de certificación necesita credenciales productivas.
for (const key of Object.keys(env)) if (/^(SUPABASE_|ZAVUDEV_|OPENAI_API_KEY$|LLM_API_KEY$|GROQ_API_KEY$)/.test(key)) delete env[key];
const steps = [
  ['runtime-contract', ['src/run-tests.js'], 'runtime-template'],
  ['runtime-tests-and-real-sql', ['--test', 'test/*.test.mjs'], 'runtime-template'],
  ...['agenda-package', 'timezone-parsing', 'mutation-claims', 'customer-records', 'knowledge-regressions', 'regression-matcher', 'local-preview-security', 'studio-fresh-install']
    .map(name => [name, [`scripts/verify-${name}.mjs`], '.'])
];
async function collectSources() {
  const files = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files.push({ file, sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') });
    }
  }
  for (const folder of ['runtime-template/src', 'runtime-template/test', 'runtime-template/supabase', 'runtime-template/public', 'client-policies', 'scripts', 'releases']) await visit(folder);
  for (const file of ['server.js', 'package.json', 'package-lock.json', 'runtime-template/package.json', 'runtime-template/package-lock.json', 'runtime-template/agent-package.json', 'runtime-template/CANDIDATA_LUNA6.md'])
    files.push({ file, sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') });
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
report.files = await collectSources();

for (const [name, args, cwd] of steps) {
  const started = Date.now(); let output = '';
  const exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: path.join(root, cwd), env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', error => { output += error.message; resolve(-1); });
    child.once('close', code => resolve(code ?? -1));
  });
  report.checks.push({ name, exitCode, elapsedMs: Date.now() - started, output });
  console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'} ${name} (${Date.now() - started} ms)`);
  if (exitCode !== 0) console.log(output.slice(-8000));
}

// Verifica que la política cliente, el paquete activo y el snapshot aprobado coinciden.
try {
  const policy = JSON.parse(await readFile(path.join(root, 'client-policies/franciskom.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'runtime-template/agent-package.json'), 'utf8'));
  const fixture = JSON.parse(await readFile(path.join(root, 'runtime-template/test/fixtures/franciskom-policy.json'), 'utf8'));
  assert.deepEqual(policy, fixture);
  if (pkg.business.id === 'franciskom') assert.deepEqual(pkg.agent.conversation_policy, fixture);
  report.checks.push({ name: 'franciskom-policy-snapshots', exitCode: 0 });
} catch (error) { report.checks.push({ name: 'franciskom-policy-snapshots', exitCode: 1, output: error.message }); }

try {
  assert.deepEqual(await collectSources(), report.files, 'El código cambió durante la corrida; repetir la certificación.');
  report.checks.push({ name: 'unchanged-source-during-certification', exitCode: 0 });
} catch (error) { report.checks.push({ name: 'unchanged-source-during-certification', exitCode: 1, output: error.message }); }
report.sourceSha256 = createHash('sha256').update(JSON.stringify(report.files)).digest('hex');
report.finishedAt = new Date().toISOString();
report.passed = report.checks.every(item => item.exitCode === 0);
const outputDir = path.join(root, 'storage/vault/certification'); await mkdir(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `${id}.json`);
await writeFile(outputFile, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.checks.length} gates; SHA256 ${report.sourceSha256}; informe ${outputFile}`);
process.exitCode = report.passed ? 0 : 1;
