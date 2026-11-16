import { resolveConversationPolicy } from './conversation-policy.js';
/**
 * Overlay de comportamiento para la vertical Agenda (se agrega SOLO cuando Agenda está activa).
 *
 * Deliberadamente CORTO y liderando con la acción. Medición (llama-3.3-70b vía Groq): un bloque
 * largo y denso en prohibiciones suprime el tool-calling (baja de 8/8 a 0-3/8); una versión lean
 * lo restaura. La curación general (anti-invención, tono, formato, seguridad) vive en base-behavior;
 * aquí sólo van las reglas propias de reservas.
 *
 * Reescrito el 14-09-2026: lo que el runtime ya garantiza (horas ofrecidas = horas consultadas,
 * reservar sólo la hora elegida, encontrar la reserva sin referencia, alternativas cuando un cambio
 * no se puede) salió de acá. Repetirlo como regla no agregaba seguridad y le quitaba soltura.
 */
export const AGENDA_BEHAVIOR = resolveConversationPolicy().agenda_behavior;

export function agendaBehaviorBlock() {
  return AGENDA_BEHAVIOR;
}
