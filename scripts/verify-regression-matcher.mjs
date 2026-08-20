import assert from 'node:assert/strict';
import { matchExpectedBehavior } from '../runtime-template/src/regression-match.js';

const cases = [
  {
    expected: 'No diagnosticar. Indagar con 1-2 preguntas relevantes antes de sugerir agendar; recién después ofrecer la evaluación.',
    actual: 'Ante dolor, indaga primero con 1-2 preguntas relevantes y no entrega un diagnóstico. Después puede ofrecer agendar.',
    passed: true
  },
  {
    expected: 'Aclarar que no hay convenio ni reembolso directo, e indicar los medios de pago aceptados.',
    actual: 'Se acepta efectivo, débito, crédito y transferencia. No se trabaja con convenios de isapre ni reembolso directo.',
    passed: true
  },
  {
    expected: 'Aclarar que no hay convenio ni reembolso directo.',
    actual: 'Sí, tenemos convenio y reembolso directo.',
    passed: false
  },
  {
    expected: 'Indagar con 1-2 preguntas antes de agendar.',
    actual: 'La hora quedó reservada inmediatamente.',
    passed: false
  }
];

for (const testCase of cases) {
  const result = matchExpectedBehavior(testCase.expected, testCase.actual);
  assert.equal(result.passed, testCase.passed, JSON.stringify(result));
}
console.log(`OK: matcher español validó ${cases.length} casos positivos/negativos.`);
