/**
 * Representación canónica del hilo para clasificadores y auditores.
 * El historial nuevo trae `actor`; las notas se conservan como compatibilidad con replays viejos.
 */
const OWNER_NOTE = /^El siguiente mensaje lo escribió .+\(el dueño\)/;
const AUTOMATIC_NOTE = /^El siguiente mensaje es el saludo automático/;

export function labelThread(history = [], { ownerLabel = 'DUEÑO' } = {}) {
  const events = [];
  let nextActor = '';
  for (const item of history) {
    const actor = String(item?.actor || '').toLowerCase();
    if (item?.role === 'system') {
      if (actor === 'automatic' || AUTOMATIC_NOTE.test(String(item.content || ''))) nextActor = 'automatic';
      else if (actor === 'owner' || OWNER_NOTE.test(String(item.content || ''))) nextActor = 'owner';
      else events.push({ who: 'NOTA', text: item.content, at: item.at });
      continue;
    }
    if (item?.role === 'user') events.push({ who: 'CLIENTE', text: item.content, at: item.at });
    else if (item?.role === 'assistant') {
      const effectiveActor = actor || nextActor;
      const who = effectiveActor === 'owner'
        ? ownerLabel
        : effectiveActor === 'automatic' ? 'SALUDO_AUTOMATICO' : 'ASISTENTE';
      events.push({ who, text: item.content, at: item.at });
    }
    nextActor = '';
  }
  return events;
}
