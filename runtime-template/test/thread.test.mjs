import test from 'node:test';
import assert from 'node:assert/strict';
import { labelThread } from '../src/thread.js';

test('etiqueta cliente, bot y dueño con actor explícito', () => {
  assert.deepEqual(labelThread([
    { role: 'user', actor: 'client', content: 'Hola' },
    { role: 'assistant', actor: 'owner', content: 'Hola, ¿cómo sigues?' },
    { role: 'user', actor: 'client', content: 'Mejor' }
  ]).map(x => x.who), ['CLIENTE', 'FRANCISCO', 'CLIENTE']);
});

test('mantiene compatibilidad con la nota histórica de Francisco', () => {
  assert.equal(labelThread([
    { role: 'system', content: 'El siguiente mensaje lo escribió Francisco (el dueño) en persona desde su WhatsApp, no tú.' },
    { role: 'assistant', content: 'Nos vemos a las 12' }
  ])[0].who, 'FRANCISCO');
});

test('distingue saludo automático y conserva notas', () => {
  const events = labelThread([
    { role: 'system', actor: 'automatic', content: 'El siguiente mensaje es el saludo automático' },
    { role: 'assistant', actor: 'automatic', content: 'Gracias por escribir' },
    { role: 'system', content: 'El dueño ya atendió esta conversación.' }
  ]);
  assert.deepEqual(events.map(x => x.who), ['SALUDO_AUTOMATICO', 'NOTA']);
});
