import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const usePostgres = process.env.STUDIO_DB_BACKEND === 'postgres';
// Contra postgres reutilizamos el único proyecto Supabase de Studio (tiene datos reales de
// franciskom/quiro-demo) — no hay "instalación limpia" posible ahí, así que el cliente de prueba
// usa un id único por corrida y se borra al final en el bloque finally, en vez de descartar todo
// un directorio temporal como hace la rama sqlite.
const clientId = usePostgres ? `qa-barberia-${Date.now()}` : 'qa-barberia';
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'zeroagent-fresh-'));
const databasePath = path.join(temporaryRoot, 'database.sqlite');
const buildRoot = path.join(temporaryRoot, 'builds');
const landingRoot = path.join(temporaryRoot, 'landings');
await mkdir(path.join(landingRoot, clientId), { recursive: true });
await writeFile(path.join(landingRoot, clientId, 'landing.html'), '<!doctype html><title>Barbería QA</title>', 'utf8');
await writeFile(path.join(landingRoot, clientId, '_internal.mjs'), 'throw new Error("no copiar");', 'utf8');

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

const port = await freePort();
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    ...(usePostgres ? {} : { ZEROAGENT_DB_PATH: databasePath }),
    ZEROAGENT_BUILD_ROOT: buildRoot,
    ZEROAGENT_CLIENT_LANDING_ROOT: landingRoot,
    ZEROAGENT_PORT: String(port)
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

async function waitForStudio() {
  // Contra postgres, /api/clients hace el mismo N+1 de siempre pero contra Supabase remoto en vez
  // de SQLite local — cada intento real toma ~2-3s, más que el timeout de 1s pensado para sqlite
  // (que aborta antes de que la respuesta llegue y nunca deja completar un intento).
  const perAttemptTimeoutMs = usePostgres ? 10_000 : 1_000;
  const deadline = Date.now() + (usePostgres ? 30_000 : 20_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Studio terminó antes de iniciar.\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/clients`, { signal: AbortSignal.timeout(perAttemptTimeoutMs) });
      if (response.ok) return response;
    } catch { /* todavía inicializando */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Studio no respondió dentro del plazo.\n${output}`);
}

try {
  const response = await waitForStudio();
  const clients = await response.json();
  assert.ok(Array.isArray(clients), 'GET /api/clients debe responder una lista en una instalación limpia');
  const packsResponse = await fetch(`http://127.0.0.1:${port}/api/vertical-packs`);
  const { packs } = await packsResponse.json();
  assert.ok(packs.filter(pack => pack.status === 'ready').length >= 4, 'deben existir verticales de agenda listas y reutilizables');

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/clients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: clientId, name: 'Barbería QA', niche: 'Barbería', verticalKey: 'barberia' })
  });
  const createBody = await createResponse.text();
  assert.equal(createResponse.status, 201, `crear desde vertical debe funcionar: ${createBody}`);
  const updatedClients = await (await fetch(`http://127.0.0.1:${port}/api/clients`)).json();
  const created = updatedClients.find(client => client.id === clientId);
  assert.equal(created?.vertical?.key, 'barberia', 'el cliente debe conservar la vertical elegida');
  assert.equal(created?.agenda?.enabled, true, 'una vertical de agenda debe habilitar el contrato base');
  assert.deepEqual(created?.agenda?.services, [], 'la vertical no debe inventar servicios del cliente');
  const agendaResponse = await fetch(`http://127.0.0.1:${port}/api/clients/${clientId}/agenda`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: true, timezone: 'America/Santiago', confirmation_mode: 'manual',
      locations: [{ name: 'Local QA', address: 'Dirección QA' }],
      services: [{ name: 'Corte QA', duration_minutes: 30, price_clp: 10000 }],
      resources: [{ name: 'Barbero QA', specialty: 'Barbería', services: ['Corte QA'], location: 'Local QA' }],
      rules: { slot_interval_minutes: 15, minimum_notice_hours: 1, maximum_advance_days: 30 }
    })
  });
  assert.equal(agendaResponse.status, 200, `configurar catálogo explícito debe funcionar: ${await agendaResponse.text()}`);

  const versionResponse = await fetch(`http://127.0.0.1:${port}/api/clients/${clientId}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: '0.0.1', summary: 'Prueba de contrato vertical' })
  });
  const versionBody = await versionResponse.text();
  assert.equal(versionResponse.status, 201, `versionar vertical debe funcionar: ${versionBody}`);
  const version = JSON.parse(versionBody);
  assert.equal(version.package.vertical.key, 'barberia', 'el paquete debe congelar el contrato vertical');
  assert.ok(version.package.solutions.agenda.agent_flow_contract.tools.includes('update_customer_profile'), 'el contrato debe declarar la ingesta de ficha');
  const rejectedApproval = await fetch(`http://127.0.0.1:${port}/api/clients/${clientId}/versions/${version.versionId}/approve`, { method: 'PUT' });
  assert.equal(rejectedApproval.status, 409, 'no se debe aprobar una versión sin pruebas activas');

  const knowledgeResponse = await fetch(`http://127.0.0.1:${port}/api/clients/${clientId}/knowledge-items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'horarios', subject: 'horario de atención', value: 'Atendemos de lunes a viernes de 9 a 18 horas.',
      testQuestion: '¿Cuál es el horario?', expectedBehavior: 'Debe mencionar lunes a viernes de 9 a 18 horas.'
    })
  });
  assert.equal(knowledgeResponse.status, 201, `guardar hecho y regresión debe funcionar: ${await knowledgeResponse.text()}`);
  const readyVersionResponse = await fetch(`http://127.0.0.1:${port}/api/clients/${clientId}/versions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: '0.0.2', summary: 'Versión con calidad comprobada' })
  });
  const readyVersionBody = await readyVersionResponse.json();
  assert.equal(readyVersionResponse.status, 201);
  const approved = await fetch(`http://127.0.0.1:${port}/api/clients/${clientId}/versions/${readyVersionBody.versionId}/approve`, { method: 'PUT' });
  assert.equal(approved.status, 200, `la versión con regresión válida debe aprobarse: ${await approved.text()}`);
  const buildResponse = await fetch(`http://127.0.0.1:${port}/api/clients/${clientId}/versions/${readyVersionBody.versionId}/build-runtime`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'preview' })
  });
  const buildBodyText = await buildResponse.text();
  assert.equal(buildResponse.status, 200, `el build verificado debe completarse: ${buildBodyText}`);
  const buildBody = JSON.parse(buildBodyText);
  const buildMetadata = JSON.parse(await readFile(path.join(buildBody.outputDir, 'BUILD.json'), 'utf8'));
  const verification = JSON.parse(await readFile(path.join(buildBody.outputDir, 'BUILD-VERIFICATION.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(buildBody.outputDir, 'BUILD-MANIFEST.json'), 'utf8'));
  assert.equal(verification.passed, true, 'la suite debe ejecutarse dentro del artefacto');
  assert.ok(buildMetadata.landing_overlay.includes('landing.html'), 'el build debe incorporar la landing propia');
  assert.ok(!manifest.files.some(file => file.path.includes('_internal.mjs')), 'el overlay no debe copiar auxiliares internos');
  assert.ok(!manifest.files.some(file => file.path.startsWith('node_modules/')), 'el build no debe copiar node_modules');
  assert.match(output, /ZeroAgent Backend activo/, 'El arranque debe completar la inicialización');
  console.log(usePostgres
    ? `OK (backend postgres): Studio cargó ${packs.length} verticales y construyó un paquete de barbería sin datos inventados, contra el Supabase real de Studio.`
    : `OK: Studio inició vacío, cargó ${packs.length} verticales y construyó un paquete de barbería sin datos inventados.`);
} finally {
  if (usePostgres && child.exitCode === null) {
    // El backend postgres es el proyecto Supabase real de Studio (franciskom/quiro-demo viven ahí)
    // — a diferencia de la rama sqlite, que descarta un directorio temporal entero, acá hay que
    // borrar explícitamente el cliente de prueba para no dejar basura en datos de producción.
    try {
      await fetch(`http://127.0.0.1:${port}/api/clients/${clientId}`, { method: 'DELETE' });
    } catch { /* si el server ya no responde, no hay nada más que hacer acá */ }
  }
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000))
  ]);
  await rm(temporaryRoot, { recursive: true, force: true });
}
