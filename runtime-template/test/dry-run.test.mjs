import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAgendaTool } from '../src/agenda-tools.js';

const service = { name: 'Sesión', duration_minutes: 60, bookable: true, delivery_mode: 'onsite' };
const resource = { name: 'Profesional', services: ['Sesión'] };
const snapshot = { catalog: { services: [service], resources: [resource], locations: [] }, appointments: [] };
const pkg = { solutions: { agenda: { config: { enabled: true, timezone: 'America/Santiago', rules: { minimum_notice_hours: 2, maximum_advance_days: 30 } } } } };
const args = { customer_name: 'Persona Prueba', service: 'Sesión', resource: 'Profesional', date: '2026-11-26', time: '12:00' };
const ctx = { dryRun: true, callerPhone: '+56900000000', now: '2026-11-15T15:00:00Z', agendaSnapshot: snapshot, availableSlots: ['2026-11-26T15:00:00Z'] };

test('dryRun valida identidad, apellido, fecha pasada, aviso mínimo y ocupación', async () => {
  assert.equal((await executeAgendaTool(pkg, 'create_appointment', args, { ...ctx, callerPhone: '' })).error, 'identity_required');
  assert.equal((await executeAgendaTool(pkg, 'create_appointment', { ...args, customer_name: 'Persona' }, ctx)).error, 'name_needs_surname');
  assert.equal((await executeAgendaTool(pkg, 'create_appointment', { ...args, date: '2026-11-14' }, ctx)).error, 'starts_at_in_past');
  assert.equal((await executeAgendaTool(pkg, 'create_appointment', { ...args, date: '2026-11-15', time: '12:30' }, ctx)).error, 'minimum_notice_not_met');
  assert.equal((await executeAgendaTool(pkg, 'create_appointment', args, { ...ctx, availableSlots: [] })).error, 'slot_taken');
  assert.equal((await executeAgendaTool(pkg, 'create_appointment', args, ctx)).action, 'created');
});

test('dryRun nunca ejecuta la RPC de handoff aunque reciba un UUID real', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No debe haber red'); };
  try {
    const result = await executeAgendaTool(pkg, 'request_human_handoff', { reason: 'prueba' }, { ...ctx, conversationId: '00000000-0000-4000-8000-000000000001' });
    assert.equal(result.action, 'handoff_requested');
    assert.equal(result.dry_run, true);
  } finally { globalThis.fetch = oldFetch; }
});
