import { resolveConversationPolicy } from './conversation-policy.js';
import { labelThread } from './thread.js';

/**
 * Decisión del turno antes del modelo conversacional. Lo que el modelo no debería decidir solo
 * se decide acá, con el hilo ya separado por quién habló (cliente / asistente / Francisco):
 *   - consulta_clinica: piden opinión clínica (qué especialista ver, si operarse, qué tienen).
 *     Respuesta fija + aviso al dueño; el asistente nunca aconseja ni desaconseja.
 *   - cita_no_verificada: el cliente da por hecha una cita que el asistente no ofreció ni agendó y
 *     que no está en la agenda. No se confirma ni se niega: aviso al dueño.
 *   - respuesta_a_dueno: lo último pendiente en el hilo lo planteó Francisco y el cliente le
 *     responde a él. El asistente se queda fuera (antes sólo había un silencio de 12 h por reloj).
 *   - reserva / otro: sigue el modelo conversacional, con las fechas ya conversadas resueltas en
 *     código (un "el sábado" dicho el miércoles es el sábado de esa semana, no el de hoy).
 * Si el clasificador falla, no bloquea nada: la ruta es "otro" y el turno sigue como antes.
 */

const clip = (text, max = 400) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const norm = value => String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export const FIXED_REPLIES = resolveConversationPolicy().fixed_replies;

/** Separa el hilo por autor: la nota de sistema que antecede a un mensaje de Francisco lo marca. */
export function labelHistory(history = []) {
  // Las notas son contexto para los jueces, pero no son intervenciones que cierren una ráfaga.
  return labelThread(history).filter(event => event.who !== 'NOTA');
}

function ymdInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const weekdayOfYmd = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const labelOf = ymd => { const [, m, d] = ymd.split('-').map(Number); return `${WEEKDAYS[weekdayOfYmd(ymd)]} ${d} de ${MONTHS[m - 1]}`; };

/**
 * Día del mes escrito junto al día de la semana ("jueves 26", "jueves 26 de noviembre"). Vale sólo
 * si esa fecha cae de verdad en ese día de la semana dentro de los próximos ~2 meses; si no calza
 * ("el jueves 10" dicho por "a las 10"), no se toma como fecha.
 */
function explicitDayOfMonth(text, weekdayName, weekdayIndex, sentYmd) {
  const match = new RegExp(`\\b${weekdayName}\\s+(\\d{1,2})(?![\\d:.]|\\s*(?:hrs?|horas|am|pm|h)\\b)`).exec(text);
  if (!match) return null;
  const day = Number(match[1]);
  if (day < 1 || day > 31) return null;
  for (let offset = 0; offset <= 62; offset += 1) {
    const ymd = addDays(sentYmd, offset);
    if (Number(ymd.slice(8)) === day) return weekdayOfYmd(ymd) === weekdayIndex ? ymd : null;
  }
  return null;
}

/**
 * Cada mensaje con hora se ancla a SU fecha, no a la de hoy: "el sábado" que Francisco escribió el
 * miércoles es el sábado de esa semana. Devuelve las líneas para el prompt (vacío si no hay
 * mensajes con hora o ninguno nombra un día).
 */
export function resolveDayReferences(events, { timeZone = 'America/Santiago', now = new Date(), max = 6 } = {}) {
  const lines = [];
  for (const event of events) {
    if (!event.at || Number.isNaN(Date.parse(event.at))) continue;
    const sentYmd = ymdInZone(new Date(event.at), timeZone);
    const text = norm(event.text);
    const found = [];
    if (/\bhoy\b/.test(text)) found.push({ word: 'hoy', ymd: sentYmd });
    if (/\bmanana\b(?!\s+(en la|a la|temprano))/.test(text) && !/\bpor la manana\b|\bla manana\b/.test(text)) found.push({ word: 'mañana', ymd: addDays(sentYmd, 1) });
    WEEKDAYS.forEach((name, index) => {
      if (!new RegExp(`\\b${norm(name)}\\b`).test(text)) return;
      // "el jueves 26" es el 26, no el jueves más cercano: Marjorie (14-11-2026) pidió "el jueves 26 a
      // las 12:00", esta línea le dijo al modelo que "jueves" era el 19 y la reserva se intentó el 19.
      const numbered = explicitDayOfMonth(text, norm(name), index, sentYmd);
      if (numbered) { found.push({ word: `${name} ${Number(numbered.slice(8))}`, ymd: numbered }); return; }
      let delta = (index - weekdayOfYmd(sentYmd) + 7) % 7;
      if (delta === 0) delta = /\bhoy\b/.test(text) ? 0 : 7;
      found.push({ word: name, ymd: addDays(sentYmd, delta) });
    });
    for (const ref of found) {
      lines.push(`- ${event.who} escribió el ${labelOf(sentYmd)}: "${clip(event.text, 110)}" → "${ref.word}" es ${labelOf(ref.ymd)}${ref.ymd === ymdInZone(now, timeZone) ? ' (HOY)' : ''}`);
    }
  }
  return lines.slice(-max);
}

const ROUTER_SYSTEM = resolveConversationPolicy().router_system;

/** Mensajes seguidos del cliente al final del hilo, sin respuesta de nadie entre ellos. */
export function trailingClientBurst(events, max = 5) {
  const burst = [];
  for (let i = events.length - 1; i >= 0 && events[i].who === 'CLIENTE' && burst.length < max; i--) burst.unshift(events[i]);
  return burst;
}

export function formatRouterInput({ events, message, nowLabel }) {
  const burst = trailingClientBurst(events);
  const lines = events.slice(0, events.length - burst.length).slice(-12).map(event => `${event.who}: ${clip(event.text)}`);
  if (burst.length) lines.push('--- mensajes sin responder ---', ...burst.map(event => `CLIENTE: ${clip(event.text)}`));
  lines.push(`CLIENTE (último mensaje): ${clip(message)}`);
  return `Ahora es ${nowLabel}.\nHilo:\n${lines.join('\n')}`;
}

export function parseRouterVerdict(text) {
  const match = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!match) return null;
  try {
    const verdict = JSON.parse(match[0]);
    const route = String(verdict.ruta || '').toLowerCase();
    if (!['consulta_clinica', 'respuesta_a_dueno', 'cita_no_verificada', 'reserva', 'otro'].includes(route)) return null;
    return { route, reason: clip(verdict.motivo, 200) };
  } catch { return null; }
}

export async function routeTurn(llm, { history, message, nowLabel, policy }, { isGpt5Family = false, fetchImpl = fetch } = {}) {
  try {
    const events = labelThread(history, { ownerLabel: policy?.owner_label || 'DUEÑO' }).filter(event => event.who !== 'NOTA');
    const response = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model, max_completion_tokens: 120,
        ...(isGpt5Family ? { reasoning_effort: 'none' } : { temperature: 0 }),
        messages: [{ role: 'system', content: policy?.router_system || ROUTER_SYSTEM }, { role: 'user', content: formatRouterInput({ events, message, nowLabel }) }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const verdict = parseRouterVerdict(data.choices?.[0]?.message?.content);
    if (!verdict) return null;
    const burstText = [...trailingClientBurst(events).map(event => event.text), message].filter(Boolean).join(' / ');
    return { ...verdict, burstText, usage: { input: Number(data.usage?.prompt_tokens) || 0, output: Number(data.usage?.completion_tokens) || 0 } };
  } catch { return null; }
}

/**
 * Qué hace el código con la ruta. null = sigue el modelo conversacional.
 * @returns {{text:string, silent:boolean, silentReason?:string, ownerAlert:string|null, guard:string}|null}
 */
export function actionForRoute(verdict, { message, hasBooking, policy }) {
  if (!verdict) return null;
  const quoted = `"${clip(verdict.burstText || message, 300)}"`;
  const fixed = policy?.fixed_replies || FIXED_REPLIES;
  if (verdict.route === 'consulta_clinica') {
    return { text: fixed.consulta_clinica, silent: false, ownerAlert: `Consulta profesional del cliente (el asistente no opinó): ${quoted}`, guard: 'route_consulta_clinica' };
  }
  if (verdict.route === 'cita_no_verificada' && !hasBooking) {
    return { text: fixed.cita_no_verificada, silent: false, ownerAlert: `El cliente da por hecha una cita que no figura en la agenda: ${quoted}. Confírmale tú.`, guard: 'route_cita_no_verificada' };
  }
  if (verdict.route === 'respuesta_a_dueno') {
    return { text: '', silent: true, silentReason: 'el cliente responde al dueño', ownerAlert: null, guard: 'route_respuesta_a_dueno' };
  }
  return null;
}
