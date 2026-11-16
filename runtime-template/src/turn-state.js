import { labelThread } from './thread.js';
import { dayDiscussed, hourChosenByClient, cancelRequestedByClient } from './consent-guards.js';

// Estado derivado: jamás se presenta como evidencia de una herramienta. Cada elección conserva
// el texto que la originó; la autorización vuelve a comprobar el candidato concreto.
export function deriveTurnState({ history = [], message = '', upcoming = [], toolTrace = [], now = new Date(), timeZone = 'America/Santiago', candidate = {} } = {}) {
  const bringsNewRequest = /\?|\b(tienes|tiene|tienen|hay|cu[aá]nto|precio|valor|agendar|agenda|reservar|otra hora|disponib|horario)\b/i.test(String(message || ''))
    || /(?:^|[\s,.])(verdad|cierto|o no|no es as[ií])\s*[.!]*\s*$/i.test(String(message || ''))
    || /^\s*(qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]l|qui[eé]n|por qu[eé]|se puede|puedo|atiende[ns]?)(?![a-záéíóúñ])/i.test(String(message || ''));
  const postponesConfirmation = /\b(te|le|les)\s+(puedo\s+|podr[ií]a\s+)?(confirm|avis)\w*|\b(confirmo|aviso)\s+(ma[ñn]ana|despu[eé]s|luego|m[aá]s\s+tarde|en\s+la\s+(mañana|tarde|noche))|\bno\s+s[eé]\s+si\s+(voy|puedo|alcanzo)/i.test(String(message || ''))
    && !/confirm\w*\s+(que\s+)?(s[ií]|voy|asisto|ah[ií]\s+estar|nos\s+vemos)(?![a-záéíóúñ])/i.test(String(message || ''));
  const events = labelThread(history);
  const lastSpeaker = [...events].reverse().find(event => !['CLIENTE', 'NOTA'].includes(event.who))?.who || null;
  const lastAssistantText = [...history].reverse().find(item => item.role === 'assistant')?.content || '';
  const offeredHours = [...lastAssistantText.matchAll(/\b\d{1,2}:\d{2}\b/g)].map(match => match[0]);
  const selectedHour = offeredHours.find(time => hourChosenByClient({ time, message, history })) || null;
  const concreteOfferMade = history.some(item => item.role === 'assistant' && /\b\d{1,2}:\d{2}\b|\ba las \d{1,2}\b/i.test(item.content))
    || toolTrace.some(item => item.name === 'get_availability' && item.result?.ok && item.result.available_slots?.length);
  const changedBooking = toolTrace.some(item => item.result?.ok && ['created', 'cancelled', 'rescheduled', 'rescheduled_needs_manual_confirmation'].includes(item.result?.action));
  return {
    bringsNewRequest, postponesConfirmation, concreteOfferMade, changedBooking, selectedHour,
    hasBooking: upcoming.length > 0, lastSpeaker,
    evidence: [...events.filter(event => event.who === 'CLIENTE').map(event => ({ text: event.text, at: event.at })), { text: String(message) }],
    candidate: { ...candidate },
    consent: {
      hour: candidate.time ? hourChosenByClient({ time: candidate.time, message, history }) : null,
      day: candidate.date ? dayDiscussed({ date: candidate.date, message, history, now, timeZone }) : null,
      cancel: cancelRequestedByClient({ message, lastAssistantText })
    }
  };
}
