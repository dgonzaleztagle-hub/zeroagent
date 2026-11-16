import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrozenRuntime } from './support/frozen-runtime.mjs';
import { createFrozenAgenda } from './support/frozen-agenda.mjs';

test('la herramienta real crea, detecta duplicados, respeta Calendar congelado y cancela sin red', async () => {
  const { pkg } = createFrozenRuntime();
  const world = createFrozenAgenda(pkg, { busy: [{ start: '2026-11-26T16:00:00Z', end: '2026-11-26T17:00:00Z' }] });
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Una dependencia escapó del banco congelado'); };
  const args = { customer_name: 'Persona Prueba', service: 'Sesión', resource: 'Camila', date: '2026-11-26', time: '12:00', location: 'Sede Central' };
  const ctx = { callerPhone: '+56900000001', now: world.now };
  try {
    const first = await world.services.executeAgendaTool(pkg, 'create_appointment', args, ctx);
    assert.equal(first.action, 'created');
    assert.equal((await world.services.executeAgendaTool(pkg, 'create_appointment', args, ctx)).action, 'already_has_exact_appointment');
    assert.equal((await world.services.executeAgendaTool(pkg, 'create_appointment', { ...args, time: '13:00' }, ctx)).error, 'slot_taken');
    const cancelled = await world.services.executeAgendaTool(pkg, 'cancel_appointment', { reference: first.appointment.reference }, ctx);
    assert.equal(cancelled.action, 'cancelled');
    assert.equal(world.appointments[0].status, 'cancelled');
  } finally { globalThis.fetch = previous; }
});

test('el reloj congelado gobierna también duplicados y cancelaciones al repetir un replay antiguo', async () => {
  const { pkg } = createFrozenRuntime();
  const world = createFrozenAgenda(pkg, { now: '2000-11-16T15:00:00Z' });
  const args = { customer_name: 'Persona Prueba', service: 'Sesión', resource: 'Camila', date: '2000-11-27', time: '12:00', location: 'Sede Central' };
  const ctx = { callerPhone: '+56900000001', now: world.now };
  const first = await world.services.executeAgendaTool(pkg, 'create_appointment', args, ctx);
  assert.equal(first.action, 'created');
  assert.equal((await world.services.executeAgendaTool(pkg, 'create_appointment', args, ctx)).action, 'already_has_exact_appointment');
  assert.equal((await world.services.executeAgendaTool(pkg, 'cancel_appointment', { reference: first.appointment.reference }, ctx)).action, 'cancelled');
});
