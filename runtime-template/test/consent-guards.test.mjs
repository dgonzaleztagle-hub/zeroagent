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

test('modalidad: "Siii" a "¿…Box Buin, cierto?" elige la sede; "sí" a una oferta de hora no', () => {
  const confirmQ = [u('Siii'), a('¿La sesión es en el Box Buin, sector El Recurso, cierto? Mantengo mañana a las 09:30.')];
  assert.equal(modalityEstablished({ ...modalityArgs, history: confirmQ, message: 'Siii' }), true);
  const offer = [u('quiero hora'), a('Tengo mañana a las 09:30 en el Box Buin por $38.000. ¿Te la dejo tomada?')];
  assert.equal(modalityEstablished({ ...modalityArgs, history: offer, message: 'Siii' }), false);
  const both = [u('quiero hora'), a('¿La sesión sería en el Box Buin, o a domicilio, cierto?')];
  assert.equal(modalityEstablished({ ...modalityArgs, history: both, message: 'Siii' }), false);
});

// ---------- Preselección de horas (Francisco, 16-10-2026: no repartir 08:00 / 14:00 / 20:00) ----------
import { pickSlotShortlist } from '../src/agenda-tools.js';

const daySlots = [];
for (let minutes = 8 * 60; minutes <= 20 * 60; minutes += 30) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0'); const mm = String(minutes % 60).padStart(2, '0');
  daySlots.push({ at: `2026-10-17T${hh}:${mm}:00-03:00`, hora_local: `${hh}:${mm}` });
}
const at = value => new Date(`2026-10-17T${value}:00-03:00`).getTime();
const hoursOf = picked => picked.map(slot => slot.hora_local);

test('horas: pegadas a un paciente que ya tiene, no repartidas', () => {
  const busy = [{ start: at('10:00'), end: at('11:00') }];
  // Las horas realmente libres no pisan al paciente de 10:00-11:00 (sesión de 60 min).
  const free = daySlots.filter(s => { const start = new Date(s.at).getTime(); return !(start < busy[0].end && start + 3_600_000 > busy[0].start); });
  const picked = hoursOf(pickSlotShortlist(free, { busy }));
  assert.deepEqual(picked, ['09:00', '11:00', '12:00']);
});

test('horas: sin compromisos, seguidas y en franja cómoda (nunca 08:00 ni 20:00)', () => {
  const picked = hoursOf(pickSlotShortlist(daySlots, { busy: [] }));
  assert.deepEqual(picked, ['09:00', '10:00', '11:00']);
});

test('horas: si el día ya está cargado en los extremos, no ofrece el extremo vacío', () => {
  const busy = [{ start: at('09:00'), end: at('18:00') }];
  const picked = hoursOf(pickSlotShortlist(daySlots.filter(s => !(s.hora_local >= '09:00' && s.hora_local < '18:00')), { busy }));
  assert.ok(picked.includes('18:00'), picked.join());
  assert.ok(picked.length <= 3);
});

test('horas: con tres o menos, se ofrecen todas', () => {
  assert.equal(pickSlotShortlist(daySlots.slice(0, 3), { busy: [] }).length, 3);
});

test('applyTimePreference respeta "lo más tarde posible" y "tarde", y no deja el conjunto vacío', async () => {
  const { applyTimePreference } = await import('../src/agenda-tools.js');
  const hours = ['08:00', '09:00', '10:00', '11:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00'].map(h => ({ hora_local: h, at: `2026-10-17T${h}:00Z` }));
  const late = applyTimePreference(hours, 'lo_mas_tarde');
  assert.equal(late.applied, true);
  assert.ok(late.slots.every(s => s.hora_local >= '15:00'));
  assert.ok(applyTimePreference(hours, 'tarde').slots.every(s => s.hora_local >= '14:00' && s.hora_local < '19:00'));
  assert.ok(applyTimePreference(hours, 'manana').slots.every(s => s.hora_local < '13:00'));
  const empty = applyTimePreference(hours.filter(s => s.hora_local < '12:00'), 'noche');
  assert.equal(empty.applied, false);
  assert.equal(empty.slots.length, 4);
});

test('día conversado: "el jueves 26" no autoriza el jueves 19 (Marjorie, 14-11-2026)', async () => {
  const { dayDiscussed } = await import('../src/consent-guards.js');
  const now = new Date('2026-11-14T15:27:00Z');
  const history = [a('El miércoles 25 de noviembre tengo a las 11:00, 14:00 o 16:00. La sesión tiene un valor de $38.000.'), u('Agéndame mejor para el jueves 26 a las 12:00 por favor'), a('¿La sesión del jueves 26 a las 12:00 sería en el Box Buin o a domicilio?')];
  assert.equal(dayDiscussed({ date: '2026-11-19', message: 'Box Buin', history, now }), false);
  assert.equal(dayDiscussed({ date: '2026-11-26', message: 'Box Buin', history, now }), true);
  assert.equal(dayDiscussed({ date: '2026-11-25', message: 'Box Buin', history, now }), true);
});

test('día conversado: hoy, mañana, día de semana sin número y fecha ilegible no bloquean', async () => {
  const { dayDiscussed } = await import('../src/consent-guards.js');
  const now = new Date('2026-11-14T15:27:00Z');
  assert.equal(dayDiscussed({ date: '2026-11-14', message: 'a las 18:00', history: [], now }), true);
  assert.equal(dayDiscussed({ date: '2026-11-15', message: 'mañana a las 10:00', history: [], now }), true);
  assert.equal(dayDiscussed({ date: '2026-11-19', message: 'el jueves a las 10:00', history: [], now }), true);
  assert.equal(dayDiscussed({ date: '2026-11-26', message: 'el jueves a las 10:00', history: [], now }), false);
  assert.equal(dayDiscussed({ date: '', message: 'sí', history: [], now }), true);
  assert.equal(dayDiscussed({ date: '2026-12-03', message: 'ya hice 3 sesiones, dame hora', history: [], now }), false);
  assert.equal(dayDiscussed({ date: '2026-12-03', message: 'el 3 de diciembre a las 10:00', history: [], now }), true);
});

test('un nombre de relleno o un parentesco no cuenta como nombre y apellido', async () => {
  const { executeAgendaTool } = await import('../src/agenda-tools.js');
  const tryName = customer_name => executeAgendaTool({ solutions: {} }, 'create_appointment', { customer_name, date: '2026-11-26', time: '12:00' }, { dryRun: true });
  for (const name of ['No informado', 'Sin nombre', 'mi mamá', 'Paciente Alejandro', 'Cliente WhatsApp', 'Claudia']) assert.equal((await tryName(name)).error, 'name_needs_surname', name);
  for (const name of ['Marjorie Fuentes', 'Paciente Alejandra Farias', 'María de la Paz']) assert.equal((await tryName(name)).ok, true, name);
});
