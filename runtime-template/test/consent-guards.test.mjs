import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelRequestedByClient, hourChosenByClient, modalityEstablished } from '../src/consent-guards.js';

const u = content => ({ role: 'user', content });
const a = content => ({ role: 'assistant', content });

test('cancelar: pide anular de verdad', () => {
  for (const message of ['Quiero cancelar mi hora', 'Anula la hora de mañana por favor', 'cancélala', 'No puedo ir, cancela', 'Necesito anular mi sesión', 'ya no voy a poder ir', 'Cancelo, gracias'])
    assert.equal(cancelRequestedByClient({ message }), true, message);
});

test('cancelar: negaciones, hipótesis y consultas NO anulan', () => {
  for (const message of ['No quiero cancelar la hora, la mantengo', 'No la anules por favor', 'no voy a cancelar',
    'Si necesito cancelar mañana, ¿cómo lo hago?', '¿Puedo cancelar mi hora?', '¿Cómo se anula una sesión?', 'qué pasa si cancelo el mismo día',
    'Mantengo mi hora', 'Por si acaso, ¿se puede cancelar?'])
    assert.equal(cancelRequestedByClient({ message }), false, message);
});

test('cancelar: un sí contesta una oferta de anular, pero no cualquier sí', () => {
  assert.equal(cancelRequestedByClient({ message: 'Sí, por favor', lastAssistantText: '¿Te la anulo?' }), true);
  assert.equal(cancelRequestedByClient({ message: 'Sí, por favor', lastAssistantText: 'Tienes hora mañana a las 17:00.' }), false);
  assert.equal(cancelRequestedByClient({ message: 'Le puedo confirmar mañana en la mañana' }), false);
});

test('hora: la que el cliente escribió', () => {
  assert.equal(hourChosenByClient({ time: '17:00', message: 'a las 5 de la tarde', history: [] }), true);
  assert.equal(hourChosenByClient({ time: '18:30', message: 'las 18:30 me sirve', history: [] }), true);
  assert.equal(hourChosenByClient({ time: '11:00', message: 'Pedro Soto 12.345.678-5 p@x.cl', history: [u('el viernes a las 11'), a('Perfecto, viernes 11:00. Necesito tus datos.')] }), true);
});

test('hora: una lista de alternativas no es una elección', () => {
  const history = [a('Tengo mañana a las 17:00 o 18:00. ¿Cuál te dejo?')];
  assert.equal(hourChosenByClient({ time: '17:00', message: 'Todavía no sé cuál', history }), false);
  assert.equal(hourChosenByClient({ time: '17:00', message: 'sí', history }), false);
  assert.equal(hourChosenByClient({ time: '18:00', message: 'Pedro Soto pedro@x.cl', history }), false);
});

test('hora: sí a UNA sola oferta, o elegir por orden', () => {
  assert.equal(hourChosenByClient({ time: '17:00', message: 'Sí, dale', history: [a('Tengo mañana a las 17:00. ¿Te la dejo?')] }), true);
  assert.equal(hourChosenByClient({ time: '18:00', message: 'Sí', history: [a('Tengo mañana a las 17:00. ¿Te la dejo?')] }), false);
  const list = [a('Tengo 16:00, 18:00 o 20:00. ¿Cuál te dejo?')];
  assert.equal(hourChosenByClient({ time: '18:00', message: 'la segunda', history: list }), true);
  assert.equal(hourChosenByClient({ time: '20:00', message: 'la última', history: list }), true);
  assert.equal(hourChosenByClient({ time: '16:00', message: 'la segunda', history: list }), false);
});

const modalityArgs = { offersBothModes: true, homeVisit: /domicilio|\b(a|en) (mi |la |su |tu )?casa\b/i, mentionsOnsite: text => /\bbox\b/i.test(text) };

test('modalidad: preguntar no es elegir', () => {
  const asked = [u('quiero hora'), a('¿La sesión es en el Box Buin o a domicilio?')];
  assert.equal(modalityEstablished({ ...modalityArgs, history: asked, message: 'Pedro Soto pedro@x.cl' }), false);
  assert.equal(modalityEstablished({ ...modalityArgs, history: asked, message: 'En el box' }), true);
  assert.equal(modalityEstablished({ ...modalityArgs, history: asked, message: 'a domicilio' }), true);
  assert.equal(modalityEstablished({ ...modalityArgs, offersBothModes: false, history: [], message: 'hola' }), true);
});
