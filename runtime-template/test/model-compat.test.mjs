import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletionTuning } from '../src/engine.js';

test('GPT-6 Luna usa function calling compatible con Chat Completions', () => {
  assert.deepEqual(chatCompletionTuning('gpt-6-luna', 0.1), { reasoning_effort: 'none' });
  assert.deepEqual(chatCompletionTuning('gpt-5.6-luna', 0.1), { reasoning_effort: 'none' });
  assert.deepEqual(chatCompletionTuning('gpt-4o-mini', 0.1), { temperature: 0.1 });
});
