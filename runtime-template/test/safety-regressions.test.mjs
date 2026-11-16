import test from 'node:test';
import assert from 'node:assert/strict';
import { hourChosenByClient, dayDiscussed, cancelRequestedByClient } from '../src/consent-guards.js';
import { labelThread } from '../src/thread.js';
import { labelHistory, trailingClientBurst } from '../src/turn-decision.js';
import { answerWithGroq } from '../src/engine.js';

test('una hora rechazada no autoriza reservarla, incluso si fue aceptada antes', () => {
  assert.equal(hourChosenByClient({ time: '18:00', message: 'A las 18:00 no puedo' }), false);
  assert.equal(hourChosenByClient({ time: '18:00', history: [{ role: 'user', content: 'A las 18:00 por favor' }], message: 'A las 18:00 no me sirve' }), false);
  assert.equal(hourChosenByClient({ time: '18:00', history: [{ role: 'user', content: 'A las 18:00 no puedo' }], message: 'Ahora sí puedo a las 18:00' }), true);
});

test('hoy y mañana necesitan evidencia del día, no basta con ser próximos', () => {
  const now = new Date('2026-11-15T15:00:00Z');
  assert.equal(dayDiscussed({ date: '2026-11-16', message: 'Solo quiero el precio', now }), false);
  assert.equal(dayDiscussed({ date: '2026-11-15', message: 'a las 18:00', now }), false);
  assert.equal(dayDiscussed({ date: '2026-11-15', message: 'hoy a las 18:00', now }), true);
  assert.equal(dayDiscussed({ date: '2026-11-17', message: 'mañana a las 18:00', now }), false);
});

test('un sí a mantener O anular no elige cancelar', () => {
  assert.equal(cancelRequestedByClient({ message: 'Sí, por favor', lastAssistantText: '¿Te la mantengo o te la anulo?' }), false);
  assert.equal(cancelRequestedByClient({ message: 'Sí, por favor', lastAssistantText: '¿Te la anulo?' }), true);
});

test('autor explícito prevalece y una nota no rompe la ráfaga pendiente', () => {
  assert.equal(labelThread([{ role: 'system', actor: 'owner', content: 'nota' }, { role: 'assistant', actor: 'assistant', content: 'bot' }])[0].who, 'ASISTENTE');
  assert.equal(trailingClientBurst(labelHistory([{ role: 'user', content: '¿Qué tratamiento recomiendas?' }, { role: 'system', content: 'Nota interna' }])).length, 1);
});

test('un canal que exige modelo rechaza fallback incluso con preview_local mal configurado', async () => {
  const previous = process.env.RUNTIME_MODE;
  process.env.RUNTIME_MODE = 'preview_local';
  try {
    await assert.rejects(answerWithGroq({}, 'hola', { requireModel: true, llm: { provider: 'openai', apiKey: '', baseUrl: '', model: '' } }), /no está configurado/);
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_MODE;
    else process.env.RUNTIME_MODE = previous;
  }
});
