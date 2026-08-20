import assert from 'node:assert/strict';
import { validateMutationClaims } from '../runtime-template/src/engine.js';

const blockedWithoutEvidence = [
  ['Listo, quedaste para mañana a las 10.', 'create_appointment'],
  ['Ya te anoté para mañana a las 10.', 'create_appointment'],
  ['Tu hora quedó lista para mañana.', 'create_appointment'],
  ['Tu cita está agendada para el viernes.', 'create_appointment'],
  ['Cancelé tu hora de mañana.', 'cancel_appointment'],
  ['Tu reserva fue anulada.', 'cancel_appointment'],
  ['Moví tu hora al viernes.', 'reschedule_appointment'],
  ['Tu cita quedó reprogramada.', 'reschedule_appointment'],
  ['Ya te derivé con Francisco.', 'request_human_handoff'],
  ['Avisé al equipo para que te contacten.', 'request_human_handoff']
];

for (const [text, blockedTool] of blockedWithoutEvidence) {
  const result = validateMutationClaims(text, []);
  assert.equal(result.ok, false, `Se permitió una afirmación mutante sin evidencia: ${text}`);
  assert.equal(result.blockedTool, blockedTool, `Se atribuyó la afirmación al tool incorrecto: ${text}`);
}

const allowedNonClaims = [
  'Puedo revisar horarios para mañana.',
  'Si quieres, intento reservar una hora.',
  'Para cancelar necesito la referencia.',
  'Puedo mover tu hora al viernes.',
  'Todavía no te agendé.',
  'Tu hora aún no está confirmada.',
  'No cancelé tu hora.',
  'No te cancelé la hora.',
  'Aún no le avisé al equipo.',
  'Cuando te agende, recibirás la confirmación.'
];

for (const text of allowedNonClaims) {
  assert.equal(validateMutationClaims(text, []).ok, true, `Se bloqueó una intención, condición o negación: ${text}`);
}

const trace = (name, action, extra = {}) => [{ name, result: { ok: true, action, ...extra } }];

assert.equal(
  validateMutationClaims('Ya te anoté para mañana.', trace('create_appointment', 'created')).ok,
  true,
  'Se bloqueó una creación realmente completada.'
);
assert.equal(
  validateMutationClaims('Tu hora está agendada.', trace('create_appointment', 'already_has_active_appointment')).ok,
  true,
  'Se bloqueó el estado de una reserva activa ya existente.'
);
assert.equal(
  validateMutationClaims('Ya te anoté para mañana.', trace('create_appointment', 'already_has_active_appointment')).ok,
  false,
  'Una reserva preexistente respaldó falsamente que el agente acababa de crearla.'
);
assert.equal(
  validateMutationClaims('Tu hora está agendada.', trace('get_my_appointment', '', { appointments: [{ status: 'confirmed' }] })).ok,
  true,
  'Se bloqueó el estado comprobado mediante consulta de reservas.'
);
assert.equal(
  validateMutationClaims('Tu hora está agendada.', trace('get_my_appointment', '', { appointments: [] })).ok,
  false,
  'Una consulta sin reservas respaldó una reserva inexistente.'
);
assert.equal(
  validateMutationClaims('Cancelé tu hora.', trace('cancel_appointment', 'cancelled')).ok,
  true,
  'Se bloqueó una cancelación realmente completada.'
);
assert.equal(
  validateMutationClaims('Moví tu hora al viernes.', trace('reschedule_appointment', 'rescheduled')).ok,
  true,
  'Se bloqueó un reagendamiento realmente completado.'
);
assert.equal(
  validateMutationClaims('Ya te derivé con el equipo.', trace('request_human_handoff', 'handoff_requested')).ok,
  true,
  'Se bloqueó una derivación realmente completada.'
);

for (const action of ['needs_manual_confirmation', 'not_bookable_here']) {
  assert.equal(
    validateMutationClaims('Tu reserva quedó confirmada.', trace('create_appointment', action)).ok,
    false,
    `${action} respaldó incorrectamente una reserva confirmada.`
  );
}

assert.equal(
  validateMutationClaims('Tu reserva quedó confirmada.', [{ name: 'create_appointment', result: { ok: false, action: 'created' } }]).ok,
  false,
  'Un tool fallido respaldó una reserva confirmada.'
);
assert.equal(
  validateMutationClaims('Tu reserva quedó confirmada.', [{ name: 'create_appointment', result: { ok: true } }]).ok,
  true,
  'Se rompió la compatibilidad con trazas históricas sin campo action.'
);

console.log('PASS mutation claims: estados, acciones exactas, negaciones y casos españoles verificados.');
