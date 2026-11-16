import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditVerdict } from '../src/grounding-judge.js';

test('auditor acepta una afirmación respaldada', () => {
  assert.deepEqual(parseAuditVerdict('{"sin_respaldo":false,"detalle":"","promete_aviso":false}'), {
    unsupported: false, detail: '', promisesNotice: false
  });
});

test('auditor bloquea sin_respaldo sin exigir un campo que el prompt no pide', () => {
  assert.equal(parseAuditVerdict('{"sin_respaldo":true,"detalle":"afirma una cita inexistente","promete_aviso":false}').unsupported, true);
});

test('auditor falla abierto ante JSON inválido', () => {
  assert.equal(parseAuditVerdict('esto no es json'), null);
});
