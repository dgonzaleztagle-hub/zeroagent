import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answer } from './engine.js';
import { getAgendaToolDefinitions } from './agenda-tools.js';
import { matchExpectedBehavior } from './regression-match.js';

// agent-package.json es un artefacto por-cliente que Studio genera al construir un build — no
// existe en la plantilla suelta. Sin un fallback, `npm test` en runtime-template fallaba con
// ENOENT y no había forma de correr esta prueba sin haber construido un cliente primero. Se usa
// el paquete real si existe (build de un cliente) y si no, el fixture mínimo versionado.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realPackagePath = path.join(root, 'agent-package.json');
const fixturePackagePath = path.join(root, 'agent-package.fixture.json');
const packagePath = await fs.access(realPackagePath).then(() => realPackagePath).catch(() => fixturePackagePath);
if (packagePath === fixturePackagePath) console.log('(usando agent-package.fixture.json — no hay un cliente construido en esta carpeta)');
const packageData = JSON.parse(await fs.readFile(packagePath, 'utf8'));
const tests = packageData.tests || [];
let failures = 0;
for (const test of tests) {
  const result = answer(packageData, test.question);
  const expected = String(test.expected_behavior || '');
  const actual = String(result.text || '');
  // Evaluación determinista en español: compara raíces morfológicas (convenio/convenios,
  // diagnosticar/diagnóstico), conserva polaridad y números, y excluye verbos de redacción
  // como "aclarar" o "indicar" que no constituyen evidencia del contenido esperado.
  const evaluation = matchExpectedBehavior(expected, actual);
  const passed = evaluation.passed;
  console.log(`${passed ? 'PASS' : 'FAIL'} · ${test.question}`);
  if (!passed) {
    console.log(`  esperadas=${evaluation.expectedTerms.join(', ')} · coinciden=${evaluation.matchedTerms.join(', ') || '(ninguna)'} · mínimo=${evaluation.minimumMatches}`);
    console.log(`  respuesta=${actual}`);
    failures++;
  }
}
const agenda = packageData.solutions?.agenda;
if (agenda?.config?.enabled) {
  const requiredTools = ['get_availability', 'get_my_appointment', 'create_appointment', 'cancel_appointment', 'reschedule_appointment', 'update_customer_profile', 'request_human_handoff'];
  const actualTools = getAgendaToolDefinitions(packageData).map(item => item.function.name);
  const declaredTools = agenda.agent_flow_contract?.tools || [];
  for (const name of requiredTools) {
    const passed = actualTools.includes(name) && declaredTools.includes(name);
    console.log(`${passed ? 'PASS' : 'FAIL'} · Agenda tool contract · ${name}`);
    if (!passed) failures++;
  }
  const validContract = agenda.safety?.availability_is_authoritative === true
    && agenda.safety?.no_booking_without_live_availability_check === true
    && agenda.agent_flow_contract?.guarantees?.includes('atomic_mutations');
  console.log(`${validContract ? 'PASS' : 'FAIL'} · Agenda contract · disponibilidad viva y mutaciones atómicas`);
  if (!validContract) failures++;
}
if (failures) process.exitCode = 1;
