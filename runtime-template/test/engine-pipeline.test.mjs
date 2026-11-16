import test from 'node:test';
import assert from 'node:assert/strict';
import { answerWithGroq } from '../src/engine.js';
import { silenceDecision } from '../src/silence-policy.js';
import { deriveTurnState } from '../src/turn-state.js';
import { dedupeDraftParagraphs } from '../src/turn-guards.js';

const pkg = { business: { id: 'test-no-side-effects' }, agent: {}, knowledge: { confirmed_facts: [{ id: 'f1', subject: 'Servicio', category: 'general', value: 'Sólo datos confirmados.' }] } };
const llm = { provider: 'openai', apiKey: 'test', baseUrl: 'https://test.invalid/v1', model: 'gpt-6-luna' };

test('el texto final no duplica un párrafo entero devuelto dos veces por el modelo', () => {
  const paragraph = 'Hola, soy el asistente virtual del negocio. La sesión cuesta $38.000.';
  assert.equal(dedupeDraftParagraphs(`${paragraph}\n${paragraph}`), paragraph);
});

test('el pipeline reintenta un vacío y mantiene respuesta cálida intacta', async () => {
  const previous = globalThis.fetch;
  let drafts = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const audit = body.messages[0].content.includes('"sin_respaldo"');
    assert.equal(body.reasoning_effort, 'none');
    return Response.json({ choices: [{ message: { content: audit ? '{"sin_respaldo":false,"detalle":"","promete_aviso":false}' : (++drafts === 1 ? '' : 'Pucha, qué lata. ¿Hace cuánto empezó?') } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  };
  try {
    const reply = await answerWithGroq(pkg, 'Me duele', { llm, requireModel: true });
    assert.equal(reply.text, 'Pucha, qué lata. ¿Hace cuánto empezó?');
    assert.equal(drafts, 2);
    assert.deepEqual(reply.usage, { inputTokens: 30, outputTokens: 15 });
  } finally { globalThis.fetch = previous; }
});

test('un segundo borrador sin respaldo se bloquea en vez de saltarse el auditor', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const audit = body.messages[0].content.includes('"sin_respaldo"');
    return Response.json({ choices: [{ message: { content: audit ? '{"sin_respaldo":true,"detalle":"paradero desconocido","promete_aviso":false}' : 'Francisco ya va en camino.' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  };
  try {
    const reply = await answerWithGroq(pkg, '¿Dónde está?', { llm, requireModel: true });
    assert.doesNotMatch(reply.text, /en camino/);
    assert.ok(reply.ownerAlert);
    assert.equal(reply.confidence, 'safety_blocked');
  } finally { globalThis.fetch = previous; }
});

test('el estado posterior a una mutación impide callarse, pero permite el silencio del dueño', () => {
  const changed = deriveTurnState({ toolTrace: [{ name: 'cancel_appointment', result: { ok: true, action: 'cancelled' } }] });
  assert.equal(silenceDecision({ name: 'no_intervenir', state: changed, allowSilence: true }).result.action, 'confirm_change');
  const state = deriveTurnState({ message: 'Gracias', upcoming: [{ reference: 'x' }] });
  assert.equal(silenceDecision({ name: 'no_intervenir', state, ownerHandled: true, allowSilence: true }).silent, true);
});
