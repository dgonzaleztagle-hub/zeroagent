import test from 'node:test';
import assert from 'node:assert/strict';
import { labelHistory, trailingClientBurst, formatRouterInput, parseRouterVerdict, actionForRoute, resolveDayReferences } from '../src/turn-decision.js';

const u = content => ({ role: 'user', content });
const a = content => ({ role: 'assistant', content });

test('la ráfaga del cliente se agrupa y va marcada como sin responder', () => {
  const events = labelHistory([a('¿Qué te pasó?'), u('Deja consultarte algo'), u('¿puedo hacer sentadillas con mancuernas?')]);
  assert.equal(trailingClientBurst(events).length, 2);
  const input = formatRouterInput({ events, message: 'Muy tullida', nowLabel: 'jueves' });
  assert.match(input, /mensajes sin responder[\s\S]*Deja consultarte algo[\s\S]*mancuernas[\s\S]*último mensaje\): Muy tullida/);
});

test('sin ráfaga previa no hay sección de mensajes sin responder', () => {
  const events = labelHistory([u('hola'), a('Hola, ¿en qué te ayudo?')]);
  assert.equal(trailingClientBurst(events).length, 0);
  assert.doesNotMatch(formatRouterInput({ events, message: 'precio', nowLabel: 'x' }), /sin responder/);
});

test('la alerta cita toda la ráfaga, no solo el último mensaje', () => {
  const verdict = { route: 'consulta_clinica', reason: 'x', burstText: 'Deja consultarte algo / Muy tullida' };
  const action = actionForRoute(verdict, { message: 'Muy tullida', hasBooking: false });
  assert.match(action.ownerAlert, /Deja consultarte algo/);
});

test('parseRouterVerdict rechaza rutas inválidas y acepta JSON con ruido', () => {
  assert.equal(parseRouterVerdict('nada'), null);
  assert.equal(parseRouterVerdict('{"ruta":"inventada"}'), null);
  assert.equal(parseRouterVerdict('ok {"ruta":"otro","motivo":"m"} fin').route, 'otro');
});

test('un día nombrado el miércoles se resuelve contra ese miércoles', () => {
  const lines = resolveDayReferences([{ who: 'FRANCISCO', text: 'Te puedo el sábado a las 9', at: '2026-11-04T12:00:00-03:00' }], { now: new Date('2026-11-07T12:00:00-03:00') });
  assert.match(lines[0], /sábado 7 de noviembre \(HOY\)/);
});

test('"el jueves 26" se resuelve al 26, no al jueves más cercano', () => {
  const lines = resolveDayReferences([{ who: 'CLIENTE', text: 'Agéndame mejor para el jueves 26 a las 12:00 por favor', at: '2026-11-14T12:26:00-03:00' }], { now: new Date('2026-11-14T12:27:00-03:00') });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"jueves 26" es jueves 26 de noviembre/);
});

test('un número que no calza con el día de la semana no se toma como fecha', () => {
  const lines = resolveDayReferences([{ who: 'CLIENTE', text: 'el viernes 10 puedo', at: '2026-11-14T12:26:00-03:00' }], { now: new Date('2026-11-14T12:27:00-03:00') });
  assert.match(lines[0], /"viernes" es viernes 20 de noviembre/);
});
