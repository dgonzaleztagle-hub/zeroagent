// Guardas deterministas del turno: lo que se puede decidir o comprobar en código no se le deja
// al modelo. Mismo criterio que Rishi en Rishtedar (una sola salida con guardas, fechas resueltas
// en código): la auditoría de franciskom del 08-10-2026 encontró que casi todas las fallas en
// producción eran de cosas que el modelo decidía solo y nadie revisaba — día de la semana mal
// puesto, texto interno repetido al paciente, respuestas a un "gracias" o a un sticker.

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function ymdInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function weekdayOfYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysBetween(fromYmd, toYmd) {
  const toUtc = ymd => { const [y, m, d] = String(ymd).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(toYmd) - toUtc(fromYmd)) / 86_400_000);
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// "hoy jueves 8 de octubre", "mañana viernes 9 de octubre", "el lunes 12 de octubre". La etiqueta
// sale de acá, nunca del modelo: con sólo "2026-10-09" en la mano, el modelo escribió "mañana
// viernes" un miércoles (franciskom, 07-10-2026).
export function dayLabel(ymd, timeZone = 'America/Santiago', now = new Date()) {
  const today = ymdInZone(now, timeZone);
  const offset = daysBetween(today, ymd);
  const [, m, d] = String(ymd).split('-').map(Number);
  const weekday = WEEKDAYS[weekdayOfYmd(ymd)];
  const base = `${weekday} ${d} de ${MONTHS[m - 1]}`;
  if (offset === 0) return `hoy ${base}`;
  if (offset === 1) return `mañana ${base}`;
  return `el ${base}`;
}

// Tabla de los próximos días para el prompt, igual que la de Rishi: el modelo no calcula qué día
// cae cada fecha, la lee.
export function upcomingDaysTable(timeZone = 'America/Santiago', days = 8, now = new Date()) {
  const rows = [];
  for (let offset = 0; offset < days; offset += 1) {
    const ymd = ymdInZone(new Date(now.getTime() + offset * 86_400_000), timeZone);
    rows.push(`${ymd} = ${dayLabel(ymd, timeZone, now)}`);
  }
  return rows.join('\n');
}

// Corrige "mañana viernes" cuando mañana no es viernes. Si el día nombrado cae dentro de la
// próxima semana, se reemplaza el relativo por "el viernes": el día de la semana es lo que el
// modelo copió de la herramienta, el relativo es lo que inventó.
export function fixRelativeDays(text, timeZone = 'America/Santiago', now = new Date()) {
  const today = ymdInZone(now, timeZone);
  const todayIdx = weekdayOfYmd(today);
  let fixed = String(text || '');
  const pattern = /\b(hoy|ma[ñn]ana)(,)?\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/gi;
  const corrections = [];
  fixed = fixed.replace(pattern, (match, relative, comma, weekday) => {
    const expected = /^hoy$/i.test(relative) ? todayIdx : (todayIdx + 1) % 7;
    const named = WEEKDAYS.findIndex(name => normalize(name) === normalize(weekday));
    if (named === expected) return match;
    corrections.push(match);
    const capital = /^[A-ZÁÉÍÓÚÑ]/.test(relative);
    return `${capital ? 'El' : 'el'} ${weekday}`;
  });
  return { text: fixed, corrections };
}

const COURTESY_TOKENS = new Set([
  'ok', 'oka', 'okas', 'oki', 'okis', 'okey', 'okay', 'okk', 'dale', 'ya', 'yap', 'yaa', 'yapo', 'listo', 'lista', 'listos', 'perfecto', 'perfecta',
  'gracias', 'muchas', 'mil', 'grax', 'graciass', 'graciasss', 'vale', 'bueno', 'buena', 'genial', 'super', 'bkn', 'bacan', 'igualmente', 'igual',
  'de', 'nada', 'nos', 'vemos', 'saludos', 'abrazo', 'bendiciones', 'si', 'sii', 'siii', 'sip', 'claro', 'entendido', 'entiendo', 'oh', 'ah', 'aa', 'aah',
  'excelente', 'amable', 'muy', 'tu', 'tb', 'tambien', 'hasta', 'luego', 'pronto', 'chao', 'chau', 'adios', 'que', 'estes', 'bien', 'cuidate', 'besos',
  'jaja', 'jajaja', 'jajajaja', 'jeje', 'xd', 'lol', 'top', 'buenisimo', 'buenisima', 'okidoki', 'nomas', 'no', 'mas', 'po', 'pues', 'oye',
  'hola', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches', 'feliz', 'fin', 'semana', 'finde', 'atento', 'atenta', 'quedo', 'ti', 'usted', 'ustedes', 'le', 'te', 'lo', 'agradezco', 'agradecida', 'agradecido'
]);

// Un saludo abre conversación, no la cierra: "Buenos días" o "Hola Francisco" esperan respuesta.
// Sólo es cortesía si además agradece o se despide ("Buenas noches, gracias").
const GREETING_TOKENS = new Set(['hola', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tardes', 'noches', 'oye']);
const CLOSING_TOKENS = new Set(['igual', 'tarde', 'noche', 'feliz', 'semana', 'finde', 'gracias', 'grax', 'graciass', 'graciasss', 'agradezco', 'agradecida', 'agradecido', 'igualmente', 'chao', 'chau', 'adios', 'vemos', 'luego', 'cuidate', 'saludos', 'abrazo', 'bendiciones', 'besos', 'ok', 'oka', 'okey', 'okay', 'dale', 'listo', 'perfecto', 'perfecta']);

// Cortesía pura: no pide nada, no pregunta nada. Después de la cortesía el bot no tiene nada que
// decir — contestarla es lo que armaba los loops de "de nada / igualmente" (franciskom, 07-10).
export function isCourtesyOnly(message) {
  const raw = String(message || '').trim();
  if (!raw) return true;
  if (/\?/.test(raw)) return false;
  const words = normalize(raw).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map(word => (/^(ja|je|ha){2,}j?a?$/.test(word) ? 'jaja' : word));
  if (!words.length) return true;
  if (words.length > 8) return false;
  if (words.some(word => GREETING_TOKENS.has(word)) && !words.some(word => CLOSING_TOKENS.has(word))) return false;
  const isCourtesy = word => COURTESY_TOKENS.has(word) || /^(j+a+)+$/.test(word);
  // Un nombre propio suelto ("Gracias Francisco", "Ok Carmen") no cambia nada: se tolera una sola
  // palabra fuera de la lista si en el original va con mayúscula y el resto es cortesía.
  const unknown = words.filter(word => !isCourtesy(word));
  if (!unknown.length) return true;
  if (unknown.length > 1 || unknown.length === words.length) return false;
  return new RegExp(`(^|[^\p{L}])[A-ZÁÉÍÓÚÑ]${unknown[0].slice(1)}`, 'u').test(raw.normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

// Saludo pelado: "Buenos días", "Hola Francisco, cómo está?". Si el saludo automático de WhatsApp
// Business ya lo contestó (y preguntó qué le pasa), el bot no tiene nada que agregar en ese turno.
const BARE_GREETING_TOKENS = new Set([...GREETING_TOKENS, 'holi', 'que', 'tal', 'como', 'esta', 'estas', 'estan', 'usted', 'don', 'dona', 'doctor', 'doctora', 'profe', 'senor', 'senora', 'bien', 'y', 'tu']);
export function isBareGreeting(message) {
  const raw = String(message || '');
  const words = normalize(raw).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const known = word => BARE_GREETING_TOKENS.has(word) || /^hola+$/.test(word);
  if (!words.length || words.length > 7 || !words.some(word => GREETING_TOKENS.has(word) || /^hola+$/.test(word))) return false;
  // Se tolera un nombre propio suelto ("Hola Francisco"), igual que en isCourtesyOnly.
  const unknown = words.filter(word => !known(word));
  if (!unknown.length) return true;
  return unknown.length === 1 && new RegExp(`(^|[^\\p{L}])[A-ZÁÉÍÓÚÑ]${unknown[0].slice(1)}`, 'u').test(raw.normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

function shingles(text, size) {
  const words = normalize(text).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let index = 0; index + size <= words.length; index += 1) set.add(words.slice(index, index + size).join(' '));
  return set;
}

// Lenguaje de bastidores que nunca va hacia el paciente: hablar del agente, del sistema, de
// herramientas o de instrucciones es justo lo que delató el texto filtrado del 07-10-2026.
const BACKSTAGE = /\b(el agente|al agente|del agente|el sistema (deriva|marca|bloquea)|herramienta|no_intervenir|responder_textual|system prompt|instrucci[oó]n(es)? (interna|del sistema)|nota del sistema|regla interna|franjas? de riesgo|el bot no debe|no debe confirmar)\b/i;

// Detecta si el borrador repite texto interno: 7 palabras seguidas iguales a una regla interna o
// a las directivas del negocio bastan, porque el lenguaje natural casi nunca coincide tan largo
// por azar. Devuelve qué disparó la guarda para registrarlo.
export function detectInternalLeak(text, internalSources = []) {
  const draft = String(text || '');
  if (!draft.trim()) return null;
  const backstage = BACKSTAGE.exec(draft);
  if (backstage) return { kind: 'backstage_language', match: backstage[0] };
  const draftShingles = shingles(draft, 7);
  if (!draftShingles.size) return null;
  for (const source of internalSources) {
    const sourceShingles = shingles(source?.text || source, 7);
    for (const item of draftShingles) {
      if (sourceShingles.has(item)) return { kind: 'internal_text', match: item, source: source?.id || 'internal' };
    }
  }
  return null;
}

// Mismo mensaje dos veces seguidas: el paciente lo lee como un bot trabado (Carmen, 08-10-2026,
// recibió la misma frase con un minuto de diferencia).
export function repeatsLastAgentMessage(text, history = []) {
  const last = [...history].reverse().find(item => item?.role === 'assistant')?.content || '';
  if (!last || !text) return false;
  const a = shingles(text, 6); const b = shingles(last, 6);
  if (!a.size || !b.size) return normalize(text).trim() === normalize(last).trim();
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / a.size >= 0.6;
}

// Frase ya dicha antes en el hilo, aunque el resto del mensaje sea nuevo: "Francisco prefiere no
// aventurarse…" salía en cada turno (Carmen y Ariel, 08-10-2026) y repeatsLastAgentMessage no lo
// veía porque el mensaje completo cambiaba. Se saca la frase repetida; las que traen la pregunta o
// las horas se quedan siempre, porque son las que mueven la conversación.
export function dropRepeatedSentences(text, history = []) {
  const said = new Set();
  for (const item of history) if (item?.role === 'assistant') for (const shingle of shingles(item.content, 5)) said.add(shingle);
  const sentences = String(text || '').split(/(?<=[.!;])\s+|\n+/).filter(part => part.trim());
  if (!said.size || sentences.length < 2) return { text, dropped: [] };
  const repeated = sentence => {
    if (/\?|\d{1,2}:\d{2}/.test(sentence)) return false;
    const own = shingles(sentence, 5);
    if (own.size < 2) return false;
    let shared = 0;
    for (const shingle of own) if (said.has(shingle)) shared += 1;
    return shared / own.size >= 0.6;
  };
  const dropped = [];
  const kept = [];
  let afterDrop = true;
  for (const sentence of sentences) {
    if (repeated(sentence)) { dropped.push(sentence); afterDrop = true; continue; }
    // La frase que queda después de una que se sacó empieza oración: "…mensaje; lo importante…".
    kept.push(afterDrop ? sentence.charAt(0).toUpperCase() + sentence.slice(1) : sentence);
    afterDrop = false;
  }
  if (!dropped.length || !kept.length) return { text, dropped: [] };
  return { text: kept.join(' ').replace(/;(\s|$)/g, (match, space, offset, all) => (offset === all.length - 1 ? '.' : match)).trim(), dropped };
}
