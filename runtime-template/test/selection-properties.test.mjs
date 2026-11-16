import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateMatchesLatestSelection } from '../src/booking-selection.js';
import { createFrozenRuntime, call } from './support/frozen-runtime.mjs';
const now = new Date('2026-11-16T15:00:00Z');

test('propiedad: una elección posterior invalida todas las combinaciones antiguas', () => {
  let checked = 0;
  for (const oldDay of [19, 20, 21]) for (const oldHour of [9, 10, 11]) {
    const history = [{ role: 'user', content: `El día ${oldDay} a las ${oldHour}:00` }, { role: 'assistant', content: 'Perfecto' }];
    for (const day of [oldDay, 26]) for (const hour of [oldHour, 12]) {
      const verdict = candidateMatchesLatestSelection({ history, message: 'Mejor el día 26 a las 12:00', date: `2026-11-${day}`, time: `${String(hour).padStart(2, '0')}:00`, now });
      assert.equal(verdict.ok, day === 26 && hour === 12);
      checked++;
    }
  }
  assert.equal(checked, 36);
});

test('propiedad: rechazo, alternativa y pregunta nunca equivalen a selección', () => {
  for (const message of ['A las 18:00 no puedo', 'No a las 18:00', 'A las 18:00 no', '¿Tienes a las 18:00?', 'A las 17:00 o a las 18:00, no sé cuál']) {
    assert.equal(candidateMatchesLatestSelection({ message, date: '2026-11-26', time: '18:00', now }).ok, false, message);
  }
});

test('propiedad: los minutos sobreviven tanto a una elección escrita como a aceptar una oferta', () => {
  for (let hour = 0; hour < 24; hour++) for (const minute of [0, 15, 30, 45]) {
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    for (const sep of [':', '.']) {
      const offer = `El día 26 a las ${time.replace(':', sep)}`;
      for (const [history, message] of [[[], offer], [[{ role: 'assistant', content: `${offer}. ¿Te la reservo?` }], 'Siii']]) {
        assert.equal(candidateMatchesLatestSelection({ history, message, date: '2026-11-26', time, now }).ok, true, offer);
        const wrong = `${String(hour).padStart(2, '0')}:${String((minute + 15) % 60).padStart(2, '0')}`;
        assert.equal(candidateMatchesLatestSelection({ history, message, date: '2026-11-26', time: wrong, now }).ok, false, offer);
      }
    }
  }
});

test('una consulta no reserva, pero el sí posterior acepta una oferta única y su fecha', () => {
  const history = [{ role: 'user', content: '¿Hay hora el día 26?' }, { role: 'assistant', content: 'Tengo el día 26 a las 12:00. ¿Te la dejo?' }];
  assert.equal(candidateMatchesLatestSelection({ history, message: 'Sí, por favor', date: '2026-11-26', time: '12:00', now }).ok, true);
  assert.equal(candidateMatchesLatestSelection({ history, message: 'Sí, por favor', date: '2026-12-26', time: '12:00', now }).ok, false);
  assert.equal(candidateMatchesLatestSelection({ history, message: 'Sí, pero todavía no sé si puedo', date: '2026-11-26', time: '12:00', now }).ok, false);
});

test('mañana se ancla al momento del mensaje original, no al día del replay', () => {
  const history = [{ role: 'assistant', content: 'Mañana a las 12:00. ¿Te la dejo?', at: '2026-11-20T15:00:00Z' }];
  assert.equal(candidateMatchesLatestSelection({ history, message: 'Sí', date: '2026-11-21', time: '12:00', now }).ok, true);
  assert.equal(candidateMatchesLatestSelection({ history, message: 'Sí', date: '2026-11-17', time: '12:00', now }).ok, false);
});

test('propiedad: mismo número de día en otro mes/año nunca autoriza otra fecha', () => {
  for (const date of ['2026-10-26', '2026-12-26', '2027-11-26']) {
    assert.equal(candidateMatchesLatestSelection({ message: 'El día 26 de noviembre de 2026 a las 12:00', date, time: '12:00', now }).ok, false);
  }
  for (const [date, time] of [['2026-02-30', '12:00'], ['2026-11-26', '24:00'], ['2026-11-26', '12:99']]) {
    assert.equal(candidateMatchesLatestSelection({ message: 'El día 26 a las 12:00', date, time, now }).ok, false);
  }
});

test('el coordinador bloquea cruces antiguos antes de ejecutar una herramienta', async () => {
  const runtime = createFrozenRuntime();
  const history = [{ role: 'user', content: 'El día 19 a las 11:00' }, { role: 'assistant', content: '¿Te la dejo?' }, { role: 'user', content: 'Mejor el día 26 a las 12:00 en Sede Central' }];
  const reply = await runtime.turn('Soy Persona Prueba', history, [call('create_appointment', { customer_name: 'Persona Prueba', service: 'Sesión', resource: 'Camila', date: '2026-11-19', time: '12:00' }), 'Mantengo el día 26; necesito confirmar los datos de tu hora.']);
  assert.equal(runtime.effects.length, 0);
  assert.equal(runtime.appointments.size, 0);
  assert.ok(reply.toolTrace.some(item => item.result?.action === 'selection_not_current'));
});
