import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverAutomatic } from '../src/automatic-delivery.js';

test('pausa: cada salida y seguimiento vuelve a leer el control antes de enviar', async () => {
  const sent = []; let mode = 'active'; let reads = 0;
  const dependencies = { readControl: async () => { reads++; return { control: { mode } }; }, send: async (...args) => sent.push(args) };
  await deliverAutomatic(dependencies, '+56900000001', 'Primera respuesta', { idempotencyKey: 'first' });
  mode = 'paused';
  await assert.rejects(deliverAutomatic(dependencies, '+56900000001', 'Seguimiento'), /PAUSED/);
  assert.equal(reads, 2); assert.equal(sent.length, 1);
});

test('pausa o falla del control: cero mensajes aunque el modelo haya generado texto', async () => {
  for (const readControl of [async () => ({ control: { mode: 'paused' } }), async () => ({}), async () => { throw new Error('DB caída'); }]) {
    let sends = 0;
    await assert.rejects(deliverAutomatic({ readControl, send: async () => { sends++; } }, 'phone', 'Texto generado'));
    assert.equal(sends, 0);
  }
});
