import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJudgeVerdict, formatJudgeInput, judgeConversationStage } from '../src/conversation-judge.js';

test('parseJudgeVerdict lee JSON válido aunque venga con texto alrededor', () => {
  assert.deepEqual(parseJudgeVerdict('Claro: {"etapa":"conversar","orientacion":"pregunta por diagnóstico"}'), { stage: 'conversar', guidance: 'pregunta por diagnóstico' });
  assert.equal(parseJudgeVerdict('{"etapa":"ofrecer","orientacion":""}').stage, 'ofrecer');
});

test('parseJudgeVerdict rechaza etapas inválidas o basura', () => {
  assert.equal(parseJudgeVerdict('{"etapa":"quizá"}'), null);
  assert.equal(parseJudgeVerdict('no es json'), null);
  assert.equal(parseJudgeVerdict(''), null);
});

test('formatJudgeInput incluye historial, mensaje y borrador', () => {
  const text = formatJudgeInput({ history: [{ role: 'user', content: 'Hola' }, { role: 'assistant', content: '¿Qué te molesta?' }], message: 'la espalda', draft: 'Tengo a las 09:00' });
  assert.match(text, /CLIENTE: Hola/);
  assert.match(text, /ASISTENTE: ¿Qué te molesta\?/);
  assert.match(text, /la espalda/);
  assert.match(text, /09:00/);
});

test('judgeConversationStage falla abierto (null) si la red falla', async () => {
  const verdict = await judgeConversationStage({ baseUrl: 'x', apiKey: 'k', model: 'm' }, { history: [], message: 'hola', draft: 'hola' }, { fetchImpl: async () => { throw new Error('red'); } });
  assert.equal(verdict, null);
});
