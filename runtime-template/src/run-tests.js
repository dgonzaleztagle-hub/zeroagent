import { loadPackage, answer } from './engine.js';
import { getAgendaToolDefinitions } from './agenda-tools.js';

const packageData = await loadPackage();
const tests = packageData.tests || [];
let failures = 0;
for (const test of tests) {
  const result = answer(packageData, test.question);
  const expected = String(test.expected_behavior || '').toLowerCase();
  const actual = String(result.text || '').toLowerCase();
  // El vínculo a un hecho permite trazabilidad, pero no es evidencia de que la
  // respuesta siga siendo correcta: el valor del hecho podría estar corrompido.
  // Una regresión sólo pasa si conserva vocabulario significativo aprobado.
  const expectedTerms = expected.split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 3);
  const passed = expectedTerms.length > 0 && expectedTerms.some(word => actual.includes(word));
  console.log(`${passed ? 'PASS' : 'FAIL'} · ${test.question}`);
  if (!passed) failures++;
}
const agenda = packageData.solutions?.agenda;
if (agenda?.config?.enabled) {
  const requiredTools = ['get_availability', 'get_my_appointment', 'create_appointment', 'cancel_appointment', 'reschedule_appointment', 'request_human_handoff'];
  const actualTools = getAgendaToolDefinitions(packageData).map(item => item.function.name);
  for (const name of requiredTools) {
    const passed = actualTools.includes(name);
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
