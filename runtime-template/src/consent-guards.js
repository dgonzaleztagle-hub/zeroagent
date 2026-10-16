/**
 * Seguros de consentimiento: el modelo propone una acción que no se puede deshacer (agendar,
 * cancelar, reagendar) y el código verifica, con evidencia del propio cliente, que la pidió.
 * Funciones puras (sin LLM ni red) para poder probarlas con casos adversariales.
 *
 * Regla común: una pregunta del asistente o una oferta NO es una elección del cliente. Sólo cuenta
 * lo que el cliente escribió.
 */

const AFFIRM = /^\s*(s[ií]+|dale|ya|ok|okey|bueno|por favor|porfa|confirmo|de acuerdo|claro|ya po|perfecto|listo)(?![a-záéíóúñ])/i;
const CANCEL_WORD = '(?:cancel|anul|elimin|borr|desagend)\\w*';

const normalizeText = value => String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------- Hora elegida ----------

function hourMentions(text, hour, minutes) {
  const hours = [hour, hour > 12 ? hour - 12 : null].filter(value => value != null);
  return hours.some(h => new RegExp(`(^|[^\\d])0?${h}[:.]${minutes}\\b`).test(text)
    || (minutes === '00' && new RegExp(`\\b(a las|las|tipo|como a las)\\s+0?${h}\\b|\\b0?${h}\\s*(hrs?|horas)\\b`, 'i').test(text))
    || (minutes === '30' && new RegExp(`\\b0?${h}\\s*y\\s*media\\b`, 'i').test(text)));
}

function offeredHours(text) {
  return [...new Set([...String(text || '').matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map(item => `${String(item[1]).padStart(2, '0')}:${item[2]}`))];
}

const ORDINALS = [[/\b(primer[ao]?|1ra|1a)\b/i, 0], [/\b(segund[ao]|2da|2a)\b/i, 1], [/\b(tercer[ao]?|3ra|3a)\b/i, 2]];

/**
 * ¿La hora `time` ("HH:MM") la eligió el cliente? Sí si la escribió él (en este mensaje o en uno
 * anterior), si dijo "sí" a una oferta de UNA sola hora, o si eligió por orden ("la segunda") de una
 * lista. Una lista de alternativas ("17:00 o 18:00") contestada con "todavía no sé" no es elección.
 */
export function hourChosenByClient({ time, message, history = [] }) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(time || '').trim());
  if (!match) return true;
  const hour = Number(match[1]); const minutes = match[2];
  const clientTexts = [...history.filter(item => item.role === 'user').map(item => item.content), String(message || '')];
  if (clientTexts.some(text => hourMentions(String(text || ''), hour, minutes))) return true;
  const lastAssistantText = [...history].reverse().find(item => item.role === 'assistant')?.content || '';
  const offered = offeredHours(lastAssistantText);
  const wanted = `${String(hour).padStart(2, '0')}:${minutes}`;
  const text = normalizeText(message);
  if (offered.length === 1 && offered[0] === wanted && AFFIRM.test(text)) return true;
  if (offered.length > 1 && offered.includes(wanted)) {
    const picked = ORDINALS.find(([pattern, index]) => pattern.test(text) && offered[index] === wanted);
    if (picked) return true;
    if (/\b[uú]ltim[ao]\b/i.test(text) && offered[offered.length - 1] === wanted) return true;
  }
  return false;
}

// ---------- Cancelación ----------

/**
 * Una hora se anula sólo si el cliente lo pidió: sin negación ("no quiero cancelar"), sin hipótesis
 * ("si necesito cancelar…", "¿cómo se cancela?") y sin ser una consulta. También vale un "sí" a un
 * "¿te la anulo?" del asistente. Ante la duda, la hora se guarda.
 */
export function cancelRequestedByClient({ message, lastAssistantText = '' }) {
  // Sin tildes: "cancélala" no calza con cancelw* si la é cuenta como otra letra.
  const text = normalizeText(message);
  const wordRe = new RegExp(CANCEL_WORD, 'i');
  const answersOffer = /anul|cancel/i.test(normalizeText(lastAssistantText)) && /\?/.test(lastAssistantText)
    // Sin \b: en JavaScript la "í" no es letra para \b, y "Sí, por favor" nunca calzaba.
    && AFFIRM.test(text);
  if (!wordRe.test(text) && !/\bya no (voy|vamos|ir[eé]|quiero|necesito)(?![a-záéíóúñ])/i.test(text)) return answersOffer;
  // Negación: "no quiero cancelar", "no la anules", "no voy a cancelar". La coma corta el alcance:
  // "no puedo ir, cancela" sí pide cancelar.
  if (new RegExp(`\\bno\\b[^.?!,;]{0,40}\\b${CANCEL_WORD}`, 'i').test(text)) return false;
  if (/\b(mantengo|mantener|mantenga|mant[eé]ng\w*|sigue en pie|sigo (con|yendo))\b/i.test(text) && !/\bya no\b/i.test(text)) return false;
  // Hipótesis o consulta: "si necesito cancelar…", "¿cómo cancelo?", "¿puedo cancelar?", "qué pasa si anulo".
  if (new RegExp(`\\b(si|en caso de|por si|cuando|c[oó]mo|puedo|podr[ií]a|se puede|qu[eé] pasa si|cobran|pol[ií]tica)\\b[^.?!,;]{0,40}\\b${CANCEL_WORD}`, 'i').test(text)) return false;
  if (/\?\s*$/.test(text.trim()) && !/\b(quiero|necesito|voy a|favor)\b/i.test(text)) return false;
  return true;
}

// ---------- Modalidad ----------

/**
 * Cuando el negocio tiene sede y domicilio, la modalidad la tiene que haber dicho el cliente.
 * Que el asistente haya preguntado "¿box o domicilio?" no es una respuesta.
 */
export function modalityEstablished({ offersBothModes, history = [], message, homeVisit, mentionsOnsite }) {
  if (!offersBothModes) return true;
  const clientTexts = [...history.filter(item => item.role === 'user').map(item => item.content), String(message || '')];
  return clientTexts.some(text => homeVisit.test(text) || mentionsOnsite(text));
}

export { normalizeText };
