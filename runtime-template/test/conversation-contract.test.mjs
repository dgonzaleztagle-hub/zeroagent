import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrozenRuntime, call } from './support/frozen-runtime.mjs';

const chosen = [{ role: 'user', content: 'El día 26 de noviembre a las 12:00 en Sede Central. Soy Persona Prueba.' }];
const booking = owner => ({ customer_name: 'Persona Prueba', service: 'Sesión', resource: owner, location: 'Sede Central', date: '2026-11-26', time: '12:00' });

test('conversación completa: crear, cerrar en silencio y cancelar sólo con petición clara', async () => {
  const runtime = createFrozenRuntime();
  const first = await runtime.turn('Agéndala por favor', chosen, [call('create_appointment', booking('Camila')), 'Tu hora quedó agendada.']);
  assert.equal(runtime.appointments.size, 1);
  const history = [...chosen, { role: 'user', content: 'Agéndala por favor' }, { role: 'assistant', content: first.text }];
  const thanks = await runtime.turn('Gracias', history, []);
  assert.equal(thanks.silent, true);
  const ambiguous = await runtime.turn('Sí, por favor', [...history, { role: 'assistant', content: '¿Te la mantengo o te la anulo?' }], [call('cancel_appointment'), 'Tu hora sigue guardada.']);
  assert.equal(runtime.appointments.size, 1);
  assert.ok(ambiguous.toolTrace.some(item => item.result?.action === 'kept_booking'));
  await runtime.turn('Anula mi hora por favor', history, [call('cancel_appointment'), call('no_intervenir'), 'Tu hora quedó anulada.']);
  assert.equal(runtime.appointments.size, 0);
  assert.equal(runtime.effects.filter(item => item.name === 'cancel_appointment').length, 1);
});

test('fallo del proveedor: no hay respuesta inventada ni mutaciones', async () => {
  const runtime = createFrozenRuntime();
  runtime.failProvider({ message: 'Sin créditos', code: 'insufficient_quota' });
  await assert.rejects(runtime.turn('Quiero una hora', [], []), error => error.status === 429 && error.code === 'insufficient_quota');
  assert.equal(runtime.effects.length, 0);
  assert.equal(runtime.appointments.size, 0);
});

test('rechazo de agenda: un borrador falso no confirma una reserva que no existe', async () => {
  const runtime = createFrozenRuntime(); runtime.failTool('slot_taken');
  const reply = await runtime.turn('Agéndala', chosen, [call('create_appointment', booking('Camila')), 'Tu hora quedó agendada.', 'Esa hora se ocupó; necesitamos buscar otra.']);
  assert.equal(runtime.appointments.size, 0);
  assert.ok(reply.toolTrace.some(item => item.result?.guard === 'unsupported_mutation_claim'));
  assert.doesNotMatch(reply.text, /quedó agendada/);
});

test('dos negocios y dos teléfonos mantienen agendas independientes', async () => {
  for (const [business, owner, price] of [['Taller Azul', 'Camila', 25000], ['Estudio Verde', 'Andrés', 42000]]) {
    const runtime = createFrozenRuntime({ business, owner, price });
    for (const phone of ['+56900000001', '+56900000002']) await runtime.turn('Reserva por favor', chosen, [call('create_appointment', booking(owner)), 'Tu hora quedó agendada.'], phone);
    assert.equal(runtime.appointments.size, 2);
    assert.deepEqual(new Set(runtime.effects.map(item => item.phone)), new Set(['+56900000001', '+56900000002']));
  }
});
