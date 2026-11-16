import { labelThread } from './thread.js';
const norm = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const weekdays = 'lunes|martes|miercoles|jueves|viernes|sabado|domingo';
const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

function referencedDates(text, at, now, timeZone) {
  const anchor = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at ? new Date(at) : now);
  const [year, month] = anchor.split('-').map(Number);
  const dates = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => match[0]);
  const addDays = offset => new Date(Date.parse(`${anchor}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  if (/\bpasado manana\b/.test(text)) dates.push(addDays(2));
  else if (/\bmanana\b/.test(text) && !/\bpor la manana\b|\ben la manana\b/.test(text)) dates.push(addDays(1));
  if (/\bhoy\b/.test(text)) dates.push(anchor);
  for (const match of text.matchAll(new RegExp(`\\b(?:el\\s+(?:dia\\s+)?|dia\\s+|(?:${weekdays})\\s+)(\\d{1,2})(?![\\d:.])(?:\\s+de\\s+(${months.join('|')}))?(?:\\s+(?:de\\s+)?(20\\d{2}))?`, 'g'))) {
    const day = Number(match[1]);
    let selectedYear = Number(match[3] || year);
    let selectedMonth = match[2] ? months.indexOf(match[2]) + 1 : month;
    let selected = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!match[2] && selected < anchor) {
      selectedMonth += 1;
      if (selectedMonth > 12) { selectedMonth = 1; selectedYear += 1; }
      selected = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    dates.push(selected);
  }
  return dates;
}

/**
 * Evidencia cronológica de la elección. Los datos antiguos no vuelven a autorizar un candidato
 * que el cliente reemplazó. Este intérprete es conservador: alternativas/preguntas/negaciones
 * ambiguas requieren aclaración antes de mutar; la conversación puede seguir libremente.
 */
export function latestBookingSelection(history = [], message = '', { now = new Date(), timeZone = 'America/Santiago' } = {}) {
  const selection = { date: null, hour: null, minute: null, explicit24h: false, ambiguous: false, evidence: null };
  const texts = [...labelThread(history).map(event => ({ role: event.who === 'ASISTENTE' ? 'assistant' : event.who === 'CLIENTE' ? 'user' : 'other', content: event.text, at: event.at })), { role: 'user', content: message }];
  let lastOffer = null;
  for (const event of texts) {
    const raw = event.content;
    const text = norm(raw);
    const hours = [...text.matchAll(/\b(\d{1,2})[:.](\d{2})(?!\d)|\b(?:a\s+)?las\s+(\d{1,2})(?![\d:.])/g)]
      .map(match => ({ hour: Number(match[1] ?? match[3]), minute: Number(match[2] || 0), explicit24h: Boolean(match[1]) }));
    const dates = referencedDates(text, event.at, now, timeZone);
    if (event.role === 'assistant') { lastOffer = { hours, dates }; continue; }
    if (event.role === 'other') { lastOffer = null; continue; }
    const affirmative = /^(?:si+|dale|ya|ok|okey|bueno|perfecto|listo|de acuerdo)(?:[\s,.!]*(?:por favor|porfa|gracias|esa me sirve|esa|me sirve))*[\s,.!]*$/.test(text.trim());
    if (!hours.length && !dates.length && affirmative && lastOffer?.hours.length === 1 && lastOffer.dates.length <= 1) {
      Object.assign(selection, lastOffer.hours[0], { ambiguous: false, evidence: String(raw) });
      if (lastOffer.dates.length) selection.date = lastOffer.dates[0];
      continue;
    }
    if (!hours.length && !dates.length) continue;
    const rejected = /\bno\s+(?:puedo|me sirve|me acomoda|quiero|alcanzo|a\s+las)|\b(?:descarta|imposible|ocupad[oa])\b|\blas\s+\d{1,2}(?::\d{2})?\s+no\b/.test(text);
    const question = /\?/.test(text) && !/\b(?:agenda|reserva|dejame|dejala|tomala)\w*/.test(text);
    selection.evidence = String(raw);
    if (rejected || question || hours.some(item => item.hour > 23 || item.minute > 59) || dates.some(date => !validDate(date)) || new Set(hours.map(item => `${item.hour}:${item.minute}`)).size > 1 || new Set(dates).size > 1) {
      selection.ambiguous = true;
      continue;
    }
    selection.ambiguous = false;
    if (dates.length) selection.date = dates[0];
    if (hours.length) Object.assign(selection, hours[0]);
  }
  return selection;
}

export function candidateMatchesLatestSelection({ history = [], message = '', date, time, now = new Date(), timeZone = 'America/Santiago' }) {
  const selection = latestBookingSelection(history, message, { now, timeZone });
  if (!validDate(String(date || '')) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || '')))
    return { ok: false, reason: 'invalid_candidate', selection };
  if (selection.ambiguous) return { ok: false, reason: 'ambiguous_or_rejected_selection', selection };
  if (selection.date !== null && date !== selection.date)
    return { ok: false, reason: 'day_replaced', selection };
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (selection.hour !== null && match) {
    const hour = Number(match[1]); const minute = Number(match[2]);
    const sameHour = hour === selection.hour || (!selection.explicit24h && hour > 12 && hour - 12 === selection.hour);
    if (!sameHour || minute !== selection.minute) return { ok: false, reason: 'hour_replaced', selection };
  }
  return { ok: true, selection };
}
