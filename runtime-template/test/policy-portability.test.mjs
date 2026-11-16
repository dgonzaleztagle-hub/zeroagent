import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolveConversationPolicy, normalizeConversationPolicy } from '../src/conversation-policy.js';
import { getAgendaToolDefinitions } from '../src/agenda-tools.js';
import { createFrozenRuntime } from './support/frozen-runtime.mjs';

test('los prompts predeterminados son genéricos para barbería, taller y estudio', () => {
  for (const business of ['Barbería Norte', 'Taller Azul', 'Estudio Verde']) {
    const policy = resolveConversationPolicy({ business: { display_name: business, description: 'servicios de este negocio' }, agent: { owner_name: 'Camila' } });
    for (const field of ['base_behavior', 'agenda_behavior', 'router_system', 'judge_system', 'audit_system'])
      assert.doesNotMatch(policy[field], /Francisco|Buin|kinesi|quiropr|diagn[oó]stic/i, `${business}: ${field}`);
    assert.equal(policy.owner_label, 'DUEÑO');
  }
});

test('el prompt real y las herramientas de un negocio nuevo no filtran otra marca ni sede', async () => {
  const runtime = createFrozenRuntime({ business: 'Barbería Norte', owner: 'Camila' });
  await runtime.turn('¿Qué servicios ofrecen?', [], ['Tenemos una sesión de atención. ¿Qué necesitas?']);
  const request = runtime.requests[0];
  assert.match(request.messages[0].content, /Barbería Norte/);
  assert.doesNotMatch(JSON.stringify(request), /Francisco|Buin|kinesi|quiropr/i);
  const availability = getAgendaToolDefinitions(runtime.pkg, runtime.catalog).find(item => item.function.name === 'get_availability');
  assert.deepEqual(availability.function.parameters.properties.location.enum, ['Sede Central']);
});

test('el paquete de Francisco conserva los prompts aprobados sin convertirlos en defaults globales', async () => {
  const stored = JSON.parse(await fs.readFile(new URL('fixtures/franciskom-policy.json', import.meta.url), 'utf8'));
  const pkg = { agent: { conversation_policy: stored } };
  const resolved = resolveConversationPolicy(pkg);
  for (const field of ['base_behavior', 'agenda_behavior', 'router_system', 'judge_system', 'audit_system']) assert.equal(resolved[field], stored[field]);
  assert.equal(resolved.owner_name, 'Francisco');
});

test('políticas inválidas se rechazan y las válidas se copian sin compartir estado mutable', () => {
  for (const value of [[], 'texto', { owner_name: 42 }, { service_preferences: [{ when: '[', service: 'x' }] }]) assert.throws(() => normalizeConversationPolicy(value));
  const original = { owner_name: 'Camila', external_place_words: ['otra sede'] };
  const copy = normalizeConversationPolicy(original); copy.external_place_words.push('x');
  assert.equal(original.external_place_words.length, 1);
});
