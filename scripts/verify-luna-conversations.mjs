// Opt-in: LLM_TEST_API_KEY es exclusivamente una credencial autorizada para pruebas.
// No lee .env, no escribe en bases remotas y no tiene acceso a WhatsApp.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { answerTurn } from '../runtime-template/src/engine.js';
import { createFrozenRuntime } from '../runtime-template/test/support/frozen-runtime.mjs';
import { createFrozenAgenda } from '../runtime-template/test/support/frozen-agenda.mjs';

const apiKey = process.env.LLM_TEST_API_KEY;
assert.ok(apiKey, 'Define LLM_TEST_API_KEY; nunca se toma automáticamente la cuenta productiva.');
const llm = { provider: 'openai', model: 'gpt-6-luna', apiKey, baseUrl: 'https://api.openai.com/v1' };
const report = { at: new Date().toISOString(), model: llm.model, mode: 'real-llm-frozen-world-real-tools', calls: 0, input: 0, output: 0, blockedIO: 0, scenarios: [] };
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url) !== `${llm.baseUrl}/chat/completions`) { report.blockedIO++; throw new Error('EXTERNAL_IO_FORBIDDEN'); }
  if (++report.calls > 100 || (report.input * 0.1 + report.output * 0.5) / 1e6 > 0.30) throw new Error('TEST_BUDGET_EXCEEDED');
  const response = await nativeFetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  if (response.ok) {
    const data = await response.clone().json(); report.input += data.usage?.prompt_tokens || 0; report.output += data.usage?.completion_tokens || 0;
  }
  return response;
};
try {
  for (const [business, owner, price] of [['Barbería Norte', 'Camila', 25000], ['Estudio Verde', 'Javiera', 35000]]) {
    const { pkg } = createFrozenRuntime({ business, owner, price });
    const world = createFrozenAgenda(pkg);
    const history = [{ role: 'assistant', content: `Tengo Sesión en Sede Central el jueves 26 de noviembre de 2026 a las 12:00 por $${price}. ¿Te la reservo?` }];
    const scenario = { business, turns: [], failures: [] }; report.scenarios.push(scenario);
    for (const [message, verify] of [
      ['Sí, reserva el día 26 de noviembre de 2026 a las 12:00 en Sede Central. Soy Ana Prueba.', () => {
        assert.equal(world.appointments.filter(a => a.status === 'confirmed').length, 1, 'Debe crear exactamente una cita');
        assert.equal(world.appointments[0].starts_at, '2026-11-26T15:00:00.000Z');
      }],
      ['No la anules. Todavía no sé si podré ir, te confirmo mañana.', () => {
        assert.equal(world.appointments[0]?.status, 'confirmed', 'La duda no cancela');
        assert.equal(world.appointments.length, 1);
      }],
      ['Cámbiame esa reserva al viernes 27 de noviembre de 2026 a las 14:00, en la misma sede.', () => {
        assert.equal(world.appointments.length, 1, 'Reagendar no duplica');
        assert.equal(world.appointments[0]?.starts_at, '2026-11-27T17:00:00.000Z', 'Debe mover la misma cita');
        assert.equal(world.appointments[0]?.status, 'confirmed');
      }],
      ['Ahora sí, cancela mi reserva por favor. No podré asistir.', () => {
        assert.equal(world.appointments[0]?.status, 'cancelled', 'Sólo la solicitud explícita cancela');
      }]
    ]) {
      try {
        const reply = await answerTurn(pkg, message, { llm, history, callerPhone: '+56900000001', now: world.now, requireModel: true, services: world.services });
        const text = [reply.text, reply.followUpText].filter(Boolean).join('\n');
        scenario.turns.push({ message, text, silent: reply.silent, trace: reply.toolTrace, appointments: structuredClone(world.appointments) });
        assert.doesNotMatch(text, /Francisco|Buin|quiropr|kinesi/i, 'No debe filtrar otro negocio');
        if (scenario.turns.length === 3) assert.doesNotMatch(text, /no (?:fue necesario|hubo que|se necesit[oó]) cambiar/i, 'El texto debe reconocer el cambio realizado en este turno');
        verify();
        history.push({ role: 'user', content: message });
        if (text) history.push({ role: 'assistant', content: text });
        console.log(`PASS ${business}: ${scenario.turns.length}`);
      } catch (error) { scenario.failures.push(error.message); console.log(`FAIL ${business}: ${error.message}`); break; }
    }
  }
} finally {
  globalThis.fetch = nativeFetch;
  report.passed = report.blockedIO === 0 && report.scenarios.length === 2 && report.scenarios.every(s => s.failures.length === 0 && s.turns.length === 4);
  const folder = path.resolve(import.meta.dirname, '../storage/vault/certification'); await mkdir(folder, { recursive: true });
  const file = path.join(folder, `luna-conversations-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(file, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(`${report.passed ? 'PASS' : 'FAIL'} Luna multi-turn; calls=${report.calls}; informe=${file}`);
  process.exitCode = report.passed ? 0 : 1;
}
