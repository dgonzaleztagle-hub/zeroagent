import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAgendaTool, getAgendaToolDefinitions, literalReplies } from './agenda-tools.js';
import { getAgendaDashboard, listUpcomingAppointmentsForPhone } from './agenda.js';
import { BASE_BEHAVIOR } from './base-behavior.js';
import { cancelRequestedByClient as cancelRequestedByClientGuard, hourChosenByClient as hourChosenByClientGuard, modalityEstablished as modalityEstablishedGuard } from './consent-guards.js';
import { AGENDA_BEHAVIOR } from './agenda-behavior.js';
import { liveInjectedFacts } from './business-data.js';
import { judgeConversationStage } from './conversation-judge.js';
import { detectInternalLeak, dropRepeatedSentences, fixRelativeDays, isCourtesyOnly, repeatsLastAgentMessage, upcomingDaysTable } from './turn-guards.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function llmConfiguration() {
  const provider = process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'groq');
  if (provider === 'openai') return { provider, apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '', baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), model: process.env.LLM_MODEL || 'gpt-4o-mini' };
  if (provider === 'compatible') return { provider, apiKey: process.env.LLM_API_KEY || '', baseUrl: String(process.env.LLM_BASE_URL || '').replace(/\/$/, ''), model: process.env.LLM_MODEL || '' };
  return { provider: 'groq', apiKey: process.env.LLM_API_KEY || process.env.GROQ_API_KEY || '', baseUrl: (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''), model: process.env.LLM_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' };
}

export async function loadPackage() {
  return JSON.parse(await fs.readFile(path.join(root, 'agent-package.json'), 'utf8'));
}

function words(value = '') {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(word => word.length > 2);
}

export function answer(packageData, message) {
  const queryWords = words(message);
  const facts = packageData.knowledge?.confirmed_facts || [];
  const best = facts.map(fact => {
    const haystack = words(`${fact.category} ${fact.subject} ${fact.value}`);
    return { fact, score: queryWords.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0) };
  }).sort((a, b) => b.score - a.score)[0];

  if (best?.score > 0) {
    return { text: best.fact.value, confidence: 'confirmed', source: best.fact.subject, handoff: false };
  }
  return {
    text: packageData.agent?.policy?.unknown_fact_behavior === 'admit_unknown_and_offer_handoff'
      ? 'No tengo ese dato confirmado en este momento. Puedo pedir que el equipo te contacte para responderte con precisión.'
      : 'No cuento con información confirmada para responder eso.',
    confidence: 'unknown', source: null, handoff: true
  };
}

const APPOINTMENT_NOUN = '(?:reserva|hora|cita|atencion|turno)';
const APPOINTMENT_REFERENCE = `(?:(?:tu|la|esa|esta)\\s+)?${APPOINTMENT_NOUN}`;
const COMPLETED_BOOKING_STATE = '(?:confirmad[ao]s?|agendad[ao]s?|reservad[ao]s?|cread[ao]s?|registrad[ao]s?|list[ao]s?)';
const IMMEDIATE_NEGATION = '(?<!no )(?<!nunca )';

function claimPattern(source) {
  return new RegExp(source, 'i');
}

const MUTATION_CLAIMS = [
  {
    tool: 'create_appointment',
    evidence: 'created',
    patterns: [
      claimPattern(`${IMMEDIATE_NEGATION}\\bte\\s+(?:agende|reserve|anote|registre)\\b`),
      claimPattern(`${IMMEDIATE_NEGATION}\\b(?:agende|reserve|anote|registre|agendamos|reservamos|anotamos|registramos)\\s+(?:tu|la|esa)\\s+${APPOINTMENT_NOUN}\\b`),
      claimPattern(`${IMMEDIATE_NEGATION}\\bte\\s+deje\\b.{0,30}\\b(?:agendad[ao]|reservad[ao]|anotad[ao]|registrad[ao])\\b`),
      claimPattern(`${IMMEDIATE_NEGATION}\\bquedaste\\b.{0,35}\\b(?:para|agendad[ao]|reservad[ao]|anotad[ao]|confirmad[ao])\\b`)
    ]
  },
  {
    tool: 'cancel_appointment',
    evidence: 'cancelled',
    patterns: [
      claimPattern(`\\b${APPOINTMENT_REFERENCE}\\b(?!.{0,30}\\b(?:no|nunca)\\b).{0,60}\\b(?:cancelad[ao]s?|anulad[ao]s?|dad[ao]s? de baja)\\b`),
      claimPattern(`${IMMEDIATE_NEGATION}\\bte\\s+(?:cancele|anule)\\s+(?:(?:tu|la|esa)\\s+)?${APPOINTMENT_NOUN}\\b`),
      claimPattern(`${IMMEDIATE_NEGATION}\\b(?:cancele|anule)\\s+(?:tu|la|esa)\\s+${APPOINTMENT_NOUN}\\b`),
      claimPattern(`${IMMEDIATE_NEGATION}\\b(?:di|dimos) de baja\\b.{0,30}\\b${APPOINTMENT_NOUN}\\b`)
    ]
  },
  {
    tool: 'reschedule_appointment',
    evidence: 'rescheduled',
    patterns: [
      claimPattern(`\\b${APPOINTMENT_REFERENCE}\\b(?!.{0,30}\\b(?:no|nunca)\\b).{0,60}\\b(?:reagendad[ao]s?|reprogramad[ao]s?|movid[ao]s?|cambiad[ao]s?|modificad[ao]s?)\\b`),
      claimPattern(`${IMMEDIATE_NEGATION}\\bte\\s+(?:movi|cambie|reagende|reprograme|modifique)\\s+(?:(?:tu|la|esa)\\s+)?${APPOINTMENT_NOUN}\\b`),
      claimPattern(`${IMMEDIATE_NEGATION}\\b(?:movi|cambie|reagende|reprograme|modifique)\\s+(?:tu|la|esa)\\s+${APPOINTMENT_NOUN}\\b`)
    ]
  },
  {
    tool: 'request_human_handoff',
    evidence: 'handoff',
    patterns: [
      claimPattern(`${IMMEDIATE_NEGATION}\\bte\\s+(?:derive|escale|pase|traspase|comunique)\\b.{0,60}\\b(?:equipo|persona|humano|humana|francisco)\\b`),
      claimPattern(`${IMMEDIATE_NEGATION}\\b(?:derive|escale|pase|traspase)\\b.{0,60}\\b(?:tu caso|tu consulta|la conversacion)\\b`),
      claimPattern(`${IMMEDIATE_NEGATION}\\b(?:avise|notifique)\\b.{0,60}\\b(?:equipo|persona|humano|humana|francisco)\\b`),
      claimPattern(`\\b(?:tu caso|tu consulta|la conversacion)\\b(?!.{0,30}\\b(?:no|nunca)\\b).{0,60}\\b(?:derivad[ao]|escalad[ao]|traspasad[ao])\\b`),
      claimPattern(`\\b(?:el equipo|francisco|una persona|un humano|una humana)\\b(?!.{0,30}\\b(?:no|nunca)\\b).{0,60}\\b(?:avisad[ao]|notificad[ao])\\b`),
      // La promesa en futuro es el mismo problema que la afirmación en pasado: "voy a avisarle a
      // Francisco" sin llamar la herramienta deja al cliente esperando a alguien que nunca supo
      // de él. Medido el 12-09-2026 sobre un cliente dudando: el modelo anunciaba el aviso en el
      // texto y no ejecutaba nada, 3 de 3 veces.
      claimPattern(`\\bvoy a (?:avisar|avisarle|derivar|derivarte|escalar|pasar|traspasar|comunicar)\\b.{0,60}\\b(?:equipo|persona|humano|humana|dueno|francisco)\\b`),
      claimPattern(`\\b(?:le avisare|le aviso|les aviso|avisare)\\b.{0,60}\\b(?:equipo|persona|dueno|francisco)\\b`)
    ]
  },
  {
    tool: 'create_appointment',
    evidence: 'appointment',
    patterns: [
      claimPattern(`\\b${APPOINTMENT_REFERENCE}\\b(?!.{0,30}\\b(?:no|nunca)\\b).{0,60}\\b${COMPLETED_BOOKING_STATE}\\b`),
      claimPattern(`\\b${APPOINTMENT_REFERENCE}\\b(?!.{0,30}\\b(?:no|nunca)\\b).{0,35}\\bquedo\\b.{0,35}\\bpara\\b`)
    ]
  }
];

function normalizedClaimText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function patternMatchesCompletedClaim(pattern, text) {
  const match = pattern.exec(text);
  if (!match) return false;
  const prefix = text.slice(Math.max(0, match.index - 32), match.index);
  // Evita que una variante del patrón empiece en el verbo y se salte "no te/no le".
  if (/\b(?:no|nunca)\s+(?:(?:te|le|lo|la|se)\s+)?$/.test(prefix)) return false;
  // "cuando/si/que te agende" expresa condición o intención, no una acción completada.
  if (/\b(?:cuando|si|que)\s+(?:te\s+)?$/.test(prefix)) return false;
  return true;
}

// Un turno que cambió la reserva nunca termina callado: tras anular una hora de verdad, el guard
// de repetición llevó al modelo a no_intervenir y el paciente no supo que se la anularon
// (replay 11-10-2026).
export function changedBookingThisTurn(toolTrace) {
  return successfulAction(toolTrace, 'cancel_appointment', ['cancelled'])
    || successfulAction(toolTrace, 'reschedule_appointment', ['rescheduled', 'rescheduled_needs_manual_confirmation'])
    || successfulAction(toolTrace, 'create_appointment', ['created']);
}

// Texto determinista para cuando el modelo no logra redactar la confirmación de un cambio hecho.
function bookingChangeNotice(toolTrace) {
  const last = [...toolTrace].reverse().find(item => item?.result?.ok === true
    && ['cancel_appointment', 'reschedule_appointment', 'create_appointment'].includes(item?.name)
    && ['cancelled', 'rescheduled', 'rescheduled_needs_manual_confirmation', 'created'].includes(item.result.action));
  if (!last) return '';
  const when = last.result.cuando_local || last.result.appointment?.cuando_local || '';
  if (last.result.action === 'cancelled') return `Tu hora${when ? ` del ${when}` : ''} quedó anulada.`;
  if (last.result.action === 'created') return `Tu hora quedó agendada${when ? ` para el ${when}` : ''}.`;
  return `Tu hora quedó cambiada${when ? ` para el ${when}` : ''}.`;
}

function successfulAction(toolTrace, tool, allowedActions) {
  return toolTrace.some(item => {
    if (item?.name !== tool || item.result?.ok !== true) return false;
    const action = String(item.result?.action || '').trim();
    // Compatibilidad con trazas anteriores a `action`; el runtime actual siempre la informa.
    return !action || allowedActions.includes(action);
  });
}

function claimHasEvidence(claim, toolTrace, appointmentOnFile = false) {
  if (claim.evidence === 'created') return successfulAction(toolTrace, 'create_appointment', ['created']);
  if (claim.evidence === 'cancelled') return successfulAction(toolTrace, 'cancel_appointment', ['cancelled']);
  if (claim.evidence === 'rescheduled') return successfulAction(toolTrace, 'reschedule_appointment', ['rescheduled']);
  // Decir "le avisé al equipo" es cierto tanto si traspasó la conversación como si sólo pidió el
  // aviso blando al dueño: las dos herramientas son evidencia válida de esa afirmación.
  if (claim.evidence === 'handoff') {
    return successfulAction(toolTrace, 'request_human_handoff', ['handoff_requested'])
      || successfulAction(toolTrace, 'avisar_al_dueno', ['owner_alerted']);
  }
  if (claim.evidence === 'appointment') {
    if (successfulAction(toolTrace, 'create_appointment', ['created', 'already_has_active_appointment'])) return true;
    if (successfulAction(toolTrace, 'reschedule_appointment', ['rescheduled'])) return true;
    // "Tu hora sigue agendada" con la hora en el contexto del turno es cierto. Sin esto, tras negarse
    // a anular, el paciente recibía "No pude confirmar esa operación de forma segura" (replay 11-10-2026).
    if (appointmentOnFile) return true;
    return toolTrace.some(item => item?.name === 'get_my_appointment'
      && item.result?.ok === true
      && Array.isArray(item.result.appointments)
      && item.result.appointments.length > 0);
  }
  return false;
}

export function validateMutationClaims(text, toolTrace = [], { appointmentOnFile = false } = {}) {
  const normalizedText = normalizedClaimText(text);
  const trace = Array.isArray(toolTrace) ? toolTrace : [];
  const unsupported = MUTATION_CLAIMS.find(claim => claim.patterns.some(pattern => patternMatchesCompletedClaim(pattern, normalizedText))
    && !claimHasEvidence(claim, trace, appointmentOnFile && !successfulAction(trace, 'cancel_appointment', ['cancelled'])));
  if (!unsupported) return { ok: true, text };
  // El texto de respaldo tiene que hablar de lo que el modelo afirmó sin evidencia, no de "tu
  // reserva" siempre: caso real (franciskom, 10-09-2026) una paciente preguntó si Francisco
  // atiende en Santiago, el modelo dijo de más sobre avisarle al equipo, y ella recibió "no hice
  // cambios en tu reserva", que no tenía nada que ver con lo que había preguntado.
  const blockedText = unsupported.tool === 'request_human_handoff'
    ? 'Todavía no dejé ese aviso. ¿Quieres que le pida al equipo que te escriba?'
    : 'No pude confirmar esa operación de forma segura. No hice cambios en tu reserva. Puedo volver a intentarlo o pedir ayuda al equipo.';
  return { ok: false, blockedTool: unsupported.tool, text: blockedText };
}

export async function answerWithGroq(packageData, message, context = {}) {
  const fallback = answer(packageData, message);
  // El runtime cloud puede resolver una cuenta administrada o BYOK por negocio y pasarla
  // por contexto. Studio/playground conserva la configuración local por variables de entorno.
  const llm = context.llm || llmConfiguration();
  const allowDeterministicFallback = context.allowDeterministicFallback === true || process.env.RUNTIME_MODE === 'preview_local';
  if (!llm.apiKey || !llm.baseUrl || !llm.model) {
    if (allowDeterministicFallback) return { ...fallback, provider: 'deterministic', usage: { inputTokens: 0, outputTokens: 0 } };
    throw new Error('El proveedor LLM del runtime no está configurado.');
  }

  const bakedFacts = packageData.knowledge?.confirmed_facts || [];
  // Datos/Info que el propio dueño cargó desde su consola: van primero porque son la fuente
  // más reciente (no esperaron rebuild), y no pasaron por curación de Daniel+Claude como sí
  // pasan las confirmed_facts horneadas — ver business-data.js.
  const liveFacts = await liveInjectedFacts(packageData).catch(() => null);
  // Si el negocio ya tiene su conocimiento en la base (za_knowledge_facts), esa es la única fuente:
  // los hechos horneados en el paquete quedan sólo como respaldo para un negocio sin Supabase o
  // para cuando la consulta falla. Mezclar ambas fuentes es lo que dejó vivo un hecho obsoleto.
  const dbHasKnowledge = Array.isArray(liveFacts) && liveFacts.some(fact => fact.from_knowledge_table);
  const allFacts = dbHasKnowledge ? liveFacts : [...(liveFacts || []), ...bakedFacts];
  // Un hecho "internal" es criterio para decidir, no algo que se le dice al cliente. Va en un
  // bloque aparte y además alimenta la guarda de filtración: el 07-10-2026 una regla interna
  // redactada como instrucción ("el agente no debe confirmar…") le llegó textual a un paciente.
  const internalFacts = allFacts.filter(fact => fact.visibility === 'internal');
  const facts = allFacts.filter(fact => fact.visibility !== 'internal');
  // Enfoque generalista: la relevancia NO se decide contando coincidencias de palabras (una batería de
  // keywords descarta preguntas bien hechas con otro fraseo). Le entregamos al modelo el conocimiento
  // confirmado y su razonamiento curado decide qué aplica. Se acota por costo, nunca por coincidencia léxica.
  const MAX_FACTS = 60;
  const exactTest = (packageData.tests || []).find(test =>
    String(test.question || '').trim().toLowerCase() === String(message || '').trim().toLowerCase()
  );
  const exactFact = facts.find(fact => fact.id === exactTest?.knowledge_item_id);
  const orderedFacts = [...new Map([exactFact, ...facts].filter(Boolean).map(fact => [fact.id, fact])).values()];
  const selectedFacts = orderedFacts.slice(0, MAX_FACTS);
  const truncatedFacts = orderedFacts.length > MAX_FACTS;
  const factsContext = selectedFacts.map((fact, index) =>
    `${index + 1}. [${fact.category}] ${fact.subject}: ${fact.value}`
  ).join('\n') + (truncatedFacts ? '\n(Hay más conocimiento confirmado no listado aquí; si la respuesta podría depender de un dato ausente, ofrece derivar en vez de suponer.)' : '');
  if (!selectedFacts.length && !getAgendaToolDefinitions(packageData).length) return { ...fallback, provider: 'deterministic', usage: { inputTokens: 0, outputTokens: 0 } };

  try {
    const agendaEnabled = getAgendaToolDefinitions(packageData).length > 0;
    // 'system' está permitido dentro del historial a propósito: conversations.js inserta ahí una
    // nota cuando parte de la conversación la atendió el dueño por fuera del canal.
    const history = Array.isArray(context.history) ? context.history.slice(-20).filter(item => ['user', 'assistant', 'system'].includes(item?.role) && typeof item.content === 'string') : [];
    // Compuerta antes del modelo: un "gracias", "ok" o "jaja" que no responde a una pregunta del
    // agente no pide nada, y contestarlo era lo que armaba los loops de cortesía (07-10-2026). Si el
    // último mensaje del agente sí preguntaba algo, el "ok" puede ser la respuesta y pasa al modelo.
    const lastAgentMessage = [...history].reverse().find(item => item.role === 'assistant')?.content || '';
    // Sin un mensaje previo del agente no hay nada que cerrar: el primer contacto siempre se contesta.
    // Un "?" del agente no basta para dejar pasar la cortesía: "Ok, gracias" no contesta un "¿en qué te
    // puedo ayudar?" (Consuelo, 07-10-2026). Sólo cuenta como respuesta si el agente ofreció algo
    // concreto — "Ok gracias" a "¿te dejo el viernes a las 18:00?" es un sí y tiene que llegar al modelo.
    const mayAnswerAgent = /\?/.test(lastAgentMessage) && (/te (la |lo )?(dejo|agendo|reservo|anoto)|cu[aá]l (te|prefieres)|te (acomoda|sirve)|confirm|\d{1,2}(:\d{2})?\s*(hrs?|h)\b|\d{1,2}:\d{2}/i.test(lastAgentMessage)
      || !/\b(gracias|grax|agradezco|agradecid[oa]|igualmente|chao|chau|adi[oó]s|nos vemos|saludos|cu[ií]date)\b/i.test(message));
    // Un mensaje sin letras (un emoji suelto, "👍", "😍") es una reacción: se calla aunque el bot no
    // haya hablado antes en el hilo. Sin esto, un "😍" que respondía a algo de Francisco recibió
    // "¡Qué lindo! ¿Te gustaría agendar una sesión?" (08-10-2026, primer mensaje del hilo).
    const reactionOnly = !/\p{L}/u.test(String(message || ''));
    if ((lastAgentMessage || reactionOnly) && isCourtesyOnly(message) && !mayAnswerAgent) {
      return {
        text: '', silent: true, silentReason: 'cortesía sin pregunta pendiente',
        confidence: 'deliberate_silence', source: [], handoff: false, ownerAlert: null,
        provider: 'gate', model: 'gate', usage: { inputTokens: 0, outputTokens: 0 }, toolTrace: [{ name: 'guard', result: { ok: true, guard: 'courtesy_gate' } }]
      };
    }
    // El modelo no tiene noción propia de "hoy": sin esto, adivina la fecha (se vio devolver
    // 2023 sobre un mensaje de 2026) y razona mal "hoy/mañana/este finde". Se ancla SIEMPRE a la
    // zona horaria del negocio (Chile por defecto) para no repetir el problema de servidores/LLM
    // que asumen UTC u otro huso — mismo criterio que ya se aplica al resto de fechas de Agenda.
    const staticAgendaConfig = packageData.solutions?.agenda?.config || {};
    // El catálogo que ve el modelo tiene que ser el mismo que usan las herramientas al ejecutar
    // (getAgendaDashboard, live desde Supabase si el negocio ya migró) — usar el paquete estático
    // acá describía servicios/recursos "horneados" en el último build aprobado, así que un servicio
    // agregado directo en Supabase (sin pasar por un nuevo build) nunca aparecía en las
    // instrucciones del modelo, aunque las herramientas sí lo encontraran y pudieran agendarlo.
    const liveAgendaDashboard = agendaEnabled ? await getAgendaDashboard(packageData).catch(() => null) : null;
    const catalogSource = liveAgendaDashboard?.catalog || staticAgendaConfig;
    // Enum del catálogo LIVE en la propia definición de la herramienta: el modelo elige de una
    // lista real en vez de escribir el nombre libre y fallar la primera vez contra el match exacto
    // de agenda-tools.js (encontrado en vivo: "evaluación" vs "Evaluación · Box Buin" fallaba
    // siempre al primer intento, y esa primera falla contaminaba el tono de la respuesta final).
    // Si quien escribe ya tiene su hora tomada, esa venta está cerrada. Con Alexis (14-09-2026) el
    // bot siguió pidiéndole ficha y antecedentes después de agendar, y cuando llegó al box ("Llegué /
    // Hola") le contestó "¿En qué te puedo ayudar?". Con hora tomada el agente sólo atiende pedidos
    // concretos y puede callarse ante avisos, saludos o agradecimientos.
    const upcomingAppointments = Array.isArray(context.upcomingAppointments)
      ? context.upcomingAppointments
      : (agendaEnabled && context.callerPhone ? await listUpcomingAppointmentsForPhone(packageData, context.callerPhone).catch(() => []) : []);
    const hasBooking = upcomingAppointments.length > 0;
    // ownerHandled: el hilo lo viene llevando el dueño por fuera. Ahí la decisión del modelo de no
    // intervenir se respeta siempre — antes un "?" en el mensaje la anulaba, y así el bot le
    // contestó "¿en qué te puedo ayudar?" a una paciente que respondía "bien y tú?" a Francisco
    // (07-10-2026; el registro muestra que el modelo sí había pedido callarse).
    const ownerHandled = context.allowSilence === true;
    const allowSilence = ownerHandled || hasBooking;
    const tools = getAgendaToolDefinitions(packageData, catalogSource, { allowSilence });
    const businessTimeZone = staticAgendaConfig.timezone || 'America/Santiago';
    const nowLabel = new Intl.DateTimeFormat('es-CL', { timeZone: businessTimeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    // Prefijo estático (cacheable): comportamiento base + identidad. Los hechos, que cambian por
    // consulta, van al final para no romper el caché del prefijo.
    const systemPrefix = [
      `Eres ${packageData.agent?.name || 'un asistente'} de ${packageData.business?.display_name || 'un negocio'}.`,
      `Tu función es: ${packageData.agent?.role || 'atender consultas del negocio'}.`,
      `Tono y estilo aprobados: ${(packageData.agent?.tone_policy?.instructions || []).join(' ') || packageData.agent?.tone || 'claro y profesional'}.`,
      BASE_BEHAVIOR,
      tools.length === 0 ? 'CAPACIDAD EN ESTA CONVERSACIÓN: no tienes ninguna herramienta para ejecutar acciones (agendar, reservar, cotizar en firme, tomar pedidos, etc.). Sólo informas con el conocimiento confirmado. Para cualquier gestión, deriva a una persona; nunca ofrezcas ni des a entender que tú puedes concretarla.' : '',
      agendaEnabled ? AGENDA_BEHAVIOR : '',
      agendaEnabled ? (() => {
        const names = list => (list || []).map(item => item.name).filter(Boolean).join('; ') || '(ninguno)';
        // Lo que no se agenda por este canal va en una lista APARTE, no como una nota al lado del
        // resto: mientras estuvo mezclado entre los agendables, el modelo pedía fecha y datos para
        // una hora que nunca iba a poder tomar (medido 3/3 con "quiero agendar en <esa sede>"). Es
        // el mismo criterio que ya usa la página pública de reservas, que los muestra separados.
        const describe = item => {
          const details = [item.duration_minutes ? `${item.duration_minutes} min` : '', item.price_clp != null ? `$${Number(item.price_clp).toLocaleString('es-CL')}` : ''].filter(Boolean).join(', ');
          return details ? `${item.name} (${details})` : item.name;
        };
        const bookableServices = (catalogSource.services || []).filter(item => item.bookable !== false);
        const externalServices = (catalogSource.services || []).filter(item => item.bookable === false);
        const servicesDetail = bookableServices.map(describe).filter(Boolean).join('; ') || '(ninguno)';
        const externalDetail = externalServices.length
          ? `
NO AGENDABLES POR ESTE CANAL (existen y puedes informar de ellos, pero NO tomas hora: el cliente coordina directamente con ese centro; si te la pide, díselo de inmediato y ofrécele los de arriba; si el negocio tiene una respuesta oficial para ese caso, úsala en vez de redactarla tú): ${externalServices.map(describe).join('; ')}.`
          : '';
        const tz = businessTimeZone;
        return `CATÁLOGO DE AGENDA (ofrece SÓLO esto; al llamar herramientas usa estos nombres exactos, sin la parte entre paréntesis).${externalDetail}
Servicios: ${servicesDetail}. Profesionales: ${names(catalogSource.resources)}.${(catalogSource.locations || []).length ? ` Sedes: ${names(catalogSource.locations)}.` : ''} Zona horaria del negocio: ${tz}. Las herramientas devuelven horarios en formato ISO/UTC: preséntaselos SIEMPRE al cliente en la hora local de ${tz}, nunca en UTC. Para agendar o cambiar una hora pasa date (YYYY-MM-DD) y time con la hora_local tal cual, sin convertir zonas.`;
      })() : '',
      packageData.agent?.system_prompt ? `DIRECTIVAS ESPECÍFICAS APROBADAS POR EL NEGOCIO (complementan las reglas anteriores, nunca las contradicen):\n${packageData.agent.system_prompt}` : ''
    ].filter(Boolean).join('\n\n');
    const messages = [
      {
        role: 'system',
        content: `${systemPrefix}\n\nFECHA Y HORA ACTUAL (${businessTimeZone}): ${nowLabel}. Usa esto como referencia real para "hoy", "mañana", días de la semana o cualquier fecha relativa — nunca asumas ni inventes otra fecha.\nCALENDARIO DE LOS PRÓXIMOS DÍAS (fecha = cómo se nombra; cópialo tal cual, no calcules días de la semana):\n${upcomingDaysTable(businessTimeZone)}\n\nCONOCIMIENTO CONFIRMADO DEL NEGOCIO (razona cuál aplica a la pregunta; no todos son relevantes):\n${factsContext || (agendaEnabled ? '(No hay conocimiento cargado; usa una herramienta de Agenda si corresponde.)' : '(No hay conocimiento confirmado cargado.)')}${internalFacts.length ? `\n\nCRITERIOS INTERNOS DEL NEGOCIO (guían lo que haces; NUNCA los cites, resumas ni expliques al cliente, ni menciones que existen):\n${internalFacts.map((fact, index) => `${index + 1}. ${fact.subject}: ${fact.value}`).join('\n')}` : ''}`
      },
      ...history,
      ...(hasBooking ? [{ role: 'system', content: (() => {
        const norm = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const bookedText = upcomingAppointments.map(item => norm(item.service)).join(' ');
        const otherSedeNames = (catalogSource.locations || []).map(item => String(item.name || '').replace(/\(.*?\)/g, '').trim()).filter(name => name && !bookedText.includes(norm(name)));
        const otherSedeFacts = literalReplies(packageData).filter(item => String(item.text || '').length < 600 && otherSedeNames.some(name => norm(item.text).includes(norm(name))))
          .map(item => String(item.text).replace(/\s+/g, ' ')).join(' | ');
        const fmt = new Intl.DateTimeFormat('es-CL', { timeZone: businessTimeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
        const list = upcomingAppointments.map(item => `${fmt.format(new Date(item.starts_at))}${item.service ? ` (${item.service})` : ''}`).join('; ');
        return `ESTE CLIENTE YA TIENE HORA TOMADA: ${list}. Esa venta está cerrada. No le preguntes por su dolor, su historia ni sus antecedentes: eso lo conversa Francisco en la consulta. Atiende sólo lo que pida en concreto: cambiar o cancelar la hora, una hora para otra persona, o una consulta como la ubicación, el precio o cómo pagar — para esas usa responder_textual si hay una respuesta oficial, igual que con cualquier cliente. Antes de responder, juzga con tu criterio qué quiso decir: si el mensaje significa que esa hora ya no le sirve o que se equivocó (de sede, de lugar, de servicio o de día), dicho como lo diga, anúlala con cancel_appointment sólo si pidió anularla (si solo duda, pregúntale "¿te la anulo?"; si pide tiempo para confirmar, como "te confirmo mañana", NO la anules: dile que se la dejas guardada), nómbrale la hora y dale en el mismo mensaje lo que sí buscaba; en ese caso no mandes un bloque oficial solo, y no des teléfonos ni correos de otra sede que no estén en los datos oficiales (el número de este WhatsApp es del negocio, no de otra sede). Datos oficiales de las otras sedes: ${otherSedeFacts || '(usa el conocimiento confirmado)'}. Si sólo avisa que llegó, saluda, agradece, confirma o manda su RUT o correo, no le respondas: guarda el RUT o correo con update_customer_profile si los mandó y llama no_intervenir.`;
      })() }] : []),
      { role: 'user', content: String(message) }
    ];
    const toolTrace = [];
    // Motivo del aviso blando al dueño, si el modelo lo pidió en cualquier ronda: viaja con la
    // respuesta para que el llamador cree el ticket y mande el aviso, sin callar al agente.
    let ownerAlert = null;
    let handoffReason = null;
    let totalInputTokens = 0; let totalOutputTokens = 0;
    // La familia gpt-5.x (razonamiento) rechaza `temperature` distinto de 1 con 400, y sin
    // `reasoning_effort: 'none'` gasta tokens de razonamiento ocultos no facturados como
    // respuesta visible (mismo hallazgo que en Rishtedar al probar gpt-5.6-luna). El resto de
    // los proveedores/modelos (gpt-4o-mini, Groq) sigue con el temperature bajo de siempre.
    const isGpt5Family = /^gpt-5(\.|-)/.test(llm.model);
    // Respuesta oficial del negocio elegida en este turno. Antes, elegirla cortaba el turno ahí
    // mismo, y eso es lo que dejaba al cliente con la lista de precios o el horario general y sin
    // ninguna hora ofrecida (medido 12-13/09/2026: en 11 de 20 conversaciones que no cerraron, la
    // última palabra del bot fue un bloque oficial). Ahora el bloque se manda intacto y el modelo
    // escribe aparte un segundo mensaje corto que empuja a la reserva — el texto del dueño sigue
    // sin tocarse, sólo deja de ser un callejón sin salida.
    let literalSent = null;
    // Si el cliente pregunta dos cosas con bloque oficial (dónde y cuánto), van las dos, en el mismo
    // mensaje; sólo cuando ninguna lleva imagen, para no pasarse del límite del pie de foto.
    const extraLiterals = [];
    let emptyRetried = false;
    let hoursRetried = false;
    let closingRetried = false;
    let stageVerdict = null;
    let stageRejections = 0;
    const mentionRetried = new Set();
    const forbiddenRetried = new Set();
    let echoRetried = false;
    let leakRetried = false;
    let repeatRetried = false;
    let literalSuggested = null;
    const internalSources = internalFacts.map(fact => ({ id: fact.id, text: `${fact.subject}: ${fact.value}` }));
    // Cada borrador que una guarda rechaza queda en la traza con su motivo: sin esto la auditoría
    // del 08-10-2026 no pudo saber qué había intentado decir el modelo antes del reintento.
    const rejectDraft = (guard, draft, detail = '') => toolTrace.push({ name: 'guard', result: { ok: false, guard, draft: String(draft || '').slice(0, 600), detail: String(detail || '').slice(0, 200) } });
    const finalizeText = text => {
      let output = String(text || '');
      const leak = detectInternalLeak(output, internalSources);
      if (leak) {
        // Ya se pidió reescribirlo y volvió a filtrar: se sacan las frases que filtran en vez de
        // mandar el texto interno. Si no queda nada, se pide lo que falte con una frase neutra.
        const kept = output.split(/(?<=[.!?])\s+|\n+/).filter(sentence => !detectInternalLeak(sentence, internalSources)).join(' ').trim();
        rejectDraft('internal_leak_stripped', output, leak.match);
        output = kept || 'Cuéntame, ¿en qué te puedo ayudar?';
      }
      const repeated = dropRepeatedSentences(output, history);
      if (repeated.dropped.length) {
        rejectDraft('repeated_sentence_dropped', output, repeated.dropped.join(' | '));
        output = repeated.text;
      }
      const days = fixRelativeDays(output, businessTimeZone);
      if (days.corrections.length) toolTrace.push({ name: 'guard', result: { ok: true, guard: 'relative_day_fixed', detail: days.corrections.join(', ') } });
      return days.text;
    };
    const asksPermissionToBook = /(te gustar[ií]a|quieres|deseas|prefieres|te parece)\s+que\s+(te\s+)?(busque|busquemos|veamos|revise|revisemos|agende|agendemos|deje)|¿\s*(te\s+)?(dejo|busco|agendo|reservo|vemos|buscamos)\s+(una\s+)?hora|¿\s*vemos\s+una\s+hora|\b(puedo|te puedo|podemos)\s+(buscarte|agendarte|ofrecerte|reservarte|buscar|agendar)\b|¿\s*qu[eé]\s+d[ií]a\s+te\s+(acomoda|sirve|queda)|¿\s*te\s+acomoda\s+(atenderte|el\s+box|en\s+el\s+box|alguna\s+de\s+esas)|¿\s*te\s+(gustar[ií]a|interesa|animas\s+a)\s+(tomar|agendar|reservar|coordinar|pedir)\s+(una\s+)?(hora|evaluaci)/i;
    const postponesSale = /cuando (tengas|puedas|quieras|est[eé]s list[ao]|lo tengas|decidas)|me escribes cuando|escr[ií]beme cuando/i;
    let activeTools = tools;
    const usage = () => ({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
    const literalResult = followUpText => {
      let draft = String(followUpText || '').trim();
      // Si el bloque oficial ya trae precios, el seguimiento no los repite: el modelo lo hacía 2 de
      // 3 veces aun con la instrucción, y un precio redactado al lado del oficial es justo el tipo
      // de cosa que termina contradiciéndolo. Se quitan las frases con precio, determinísticamente.
      if (draft && /\$\s?\d/.test([literalSent, ...extraLiterals].map(item => item.text).join(' '))) {
        draft = draft.split(/(?<=[.!?])\s+|\n+/).filter(sentence => !/\$\s?\d/.test(sentence)).join(' ').trim();
      }
      const checked = draft && !/SIN_SEGUIMIENTO/i.test(draft) ? validateMutationClaims(finalizeText(draft), toolTrace, { appointmentOnFile: hasBooking }) : null;
      // Si el seguimiento no salió (falla del modelo o texto rechazado), una anulación de este turno
      // igual se le dice: nunca puede quedar sólo el bloque oficial.
      const fallbackFollowUp = !checked?.ok ? bookingChangeNotice(toolTrace) : '';
      return {
        text: [literalSent, ...extraLiterals].map(item => item.text).join('\n\n'), imageUrl: literalSent.image || '', followUpText: checked?.ok ? checked.text : fallbackFollowUp,
        confidence: 'literal_business_reply', source: [literalSent, ...extraLiterals].map(item => item.id), handoff: false, ownerAlert,
        provider: llm.provider, model: llm.model, usage: usage(), toolTrace
      };
    };
    // El aviso al dueño es para cuando el agente YA intentó cerrar y no pudo. Si todavía no le
    // ofreció horas concretas al cliente, el aviso no se manda y el modelo recibe la instrucción de
    // ofrecerlas primero: la finalidad es que la hora quede tomada sin que el dueño intervenga.
    // Callarse nunca puede tragarse una consulta nueva. Con gpt-5.6-luna, en un hilo que el dueño
    // ya había atendido, "Necesito otra hora para la próxima semana, ¿tienes el lunes?" terminaba
    // en silencio 2 de 2 veces (medido 14-09-2026; con gpt-4o-mini no pasaba). Lo que sí justifica
    // callarse son respuestas a algo que dijo otro ("sí, a las 15", "ya llegué", "gracias, nos
    // vemos"): no traen preguntas ni piden hora, precio o disponibilidad.
    // En WhatsApp muchas preguntas llegan sin "?": "Es quiropráctico verdad" (Claudia, 09-10-2026)
    // se tomó como cierre y el bot se calló.
    const bringsNewRequest = /\?|\b(tienes|tiene|tienen|hay|cu[aá]nto|precio|valor|agendar|agenda|reservar|otra hora|disponib|horario)\b/i.test(String(message || ''))
      || /(?:^|[\s,.])(verdad|cierto|o no|no es as[ií])\s*[.!]*\s*$/i.test(String(message || ''))
      || /^\s*(qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|cu[aá]l|qui[eé]n|por qu[eé]|se puede|puedo|atiende[ns]?)(?![a-záéíóúñ])/i.test(String(message || ''));
    const postponesConfirmation = /\b(te|le|les)\s+(puedo\s+|podr[ií]a\s+)?(confirm|avis)\w*|\b(confirmo|aviso)\s+(ma[ñn]ana|despu[eé]s|luego|m[aá]s\s+tarde|en\s+la\s+(mañana|tarde|noche))|\bno\s+s[eé]\s+si\s+(voy|puedo|alcanzo)/i.test(String(message || ''))
      && !/confirm\w*\s+(que\s+)?(s[ií]|voy|asisto|ah[ií]\s+estar|nos\s+vemos)(?![a-záéíóúñ])/i.test(String(message || ''));
    const HOUR_PATTERN = /\b\d{1,2}:\d{2}\b|\ba las \d{1,2}\b/i;
    const lastAssistantText = [...history].reverse().find(item => item.role === 'assistant')?.content || '';
    const hourChosenByClient = time => hourChosenByClientGuard({ time, message, history });
    // Box o domicilio se pregunta siempre antes de agendar, si el negocio tiene las dos modalidades.
    // Pilar (franciskom, 09-10-2026) es paciente de domicilio y nunca lo dijo: el bot la agendó en el
    // box por defecto, le mandó el mapa del box, y la cita quedó mal en la base y en el Calendar.
    const bookableCatalog = (catalogSource.services || []).filter(item => item.bookable !== false);
    const offersBothModes = bookableCatalog.some(item => item.delivery_mode === 'mobile') && bookableCatalog.some(item => item.delivery_mode !== 'mobile');
    const onsiteNames = (catalogSource.locations || []).map(item => String(item.name || '').replace(/\(.*?\)/g, '').trim()).filter(Boolean);
    const HOME_VISIT = /domicilio|\b(a|en) (mi |la |su |tu )?casa\b|\bvengan\b|\bvenir a\b|\bmi direcci[oó]n\b/i;
    const normalizeText = value => String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const mentionsOnsite = text => /\bbox\b|\bconsulta\b|\bsede\b|\bvoy yo\b|\bvoy para all[aá]\b/i.test(text) || onsiteNames.some(name => normalizeText(text).includes(normalizeText(name)));
    const modalityEstablished = () => modalityEstablishedGuard({ offersBothModes, history, message, homeVisit: HOME_VISIT, mentionsOnsite });
    // Una hora se anula sólo si el cliente lo pidió con esas palabras, o si contesta que sí a un
    // "¿te la anulo?" del agente. Claudia (franciskom, 09-10-2026) escribió "tengo doble turno, le
    // puedo confirmar en la mañana" y el modelo le anuló la hora: el prompt solo no basta para una
    // acción que no se puede deshacer. Regla de Daniel: ante la duda, la hora se guarda.
    const cancelRequestedByClient = () => cancelRequestedByClientGuard({ message, lastAssistantText });
    // Ritmo de conversación (16-10-2026): ya no hay contadores ni listas de palabras. Un juez
    // (conversation-judge.js) lee el hilo completo y decide si toca ofrecer horas o seguir conversando.
    const userTurns = [...history.filter(item => item.role === 'user').map(item => item.content), String(message || '')];
    const concreteOfferMade = () => history.some(item => item.role === 'assistant' && HOUR_PATTERN.test(item.content))
      || toolTrace.some(item => item.name === 'get_availability' && item.result?.ok && (item.result.available_slots || []).length);
    // Horas reales para el seguimiento de un bloque oficial, consultadas por el runtime y no por el
    // modelo. Pedirle al modelo que "busque horas" después del bloque no alcanzó: la mitad de las
    // veces preguntaba "¿evaluación o respiratoria?" o "¿busco en el box?" en vez de ir a la agenda
    // (medido 14-09-2026). Con las horas ya en la mano sólo tiene que redactar la oferta. Se usa el
    // primer servicio agendable en sede (sin traslado) y el próximo día que tenga horas cerrables.
    const suggestedSlotsForFollowUp = async () => {
      const service = (catalogSource.services || []).find(item => item.bookable !== false && !Number(item.travel_buffer_minutes));
      const resource = (catalogSource.resources || [])[0];
      if (!service || !resource) return null;
      const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: businessTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
      const labelFmt = new Intl.DateTimeFormat('es-CL', { timeZone: businessTimeZone, weekday: 'long', day: 'numeric', month: 'long' });
      // Si el primer día con horas trae una sola, se completa con el siguiente: en vivo quedaba
      // "hoy a las 16:00, ¿cuál te dejo?" con una única opción (14-09-2026).
      const parts = [];
      let count = 0;
      for (let offset = 0; offset < 7 && count < 2; offset += 1) {
        const day = new Date(Date.now() + offset * 86_400_000);
        const result = await executeAgendaTool(packageData, 'get_availability', { service: service.name, resource: resource.name, date: dayFmt.format(day) }, context).catch(() => null);
        if (result?.ok && (result.ofrecer_primero || []).length) {
          toolTrace.push({ name: 'get_availability', result });
          const label = offset === 0 ? `hoy ${labelFmt.format(day)}` : offset === 1 ? `mañana ${labelFmt.format(day)}` : labelFmt.format(day);
          const slots = result.ofrecer_primero.slice(0, 3 - count);
          parts.push(`${label}, a las ${slots.join(', ')}`);
          count += slots.length;
        }
      }
      return parts.length ? `${parts.join('; y ')} (${service.name})` : null;
    };
    for (let round = 0; round < 7; round++) {
      let data;
      try {
        const response = await fetch(`${llm.baseUrl}/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
          body: JSON.stringify({
            model: llm.model, max_completion_tokens: 260, messages,
            ...(isGpt5Family ? { reasoning_effort: 'none' } : { temperature: 0.1 }),
            ...(activeTools.length ? { tools: activeTools, tool_choice: 'auto' } : {})
          })
        });
        if (!response.ok) throw new Error(`Groq ${response.status}`);
        data = await response.json();
      } catch (error) {
        // Si el bloque oficial ya estaba elegido, un fallo del seguimiento nunca puede costar la
        // respuesta: sale el bloque solo.
        if (literalSent) return literalResult('');
        throw error;
      }
      totalInputTokens += Number(data.usage?.prompt_tokens) || 0;
      totalOutputTokens += Number(data.usage?.completion_tokens) || 0;
      const assistantMessage = data.choices?.[0]?.message;
      if (!assistantMessage) {
        if (literalSent) return literalResult('');
        throw new Error('Groq no devolvió contenido');
      }
      const calls = assistantMessage.tool_calls || [];
      if (!calls.length) {
        if (literalSent) {
          const draftFollowUp = String(assistantMessage.content || '').trim();
          if (literalSuggested && !closingRetried && round < 4 && draftFollowUp && !/SIN_SEGUIMIENTO/i.test(draftFollowUp) && !HOUR_PATTERN.test(draftFollowUp)) {
            closingRetried = true;
            messages.push({ role: 'assistant', content: draftFollowUp });
            messages.push({ role: 'system', content: `Ese segundo mensaje NO se envió: no trae horas. Escríbelo ofreciendo estas horas reales: ${literalSuggested}, y termina con "¿cuál te dejo?".` });
            continue;
          }
          return literalResult(assistantMessage.content);
        }
        const rawText = String(assistantMessage.content || '').trim();
        // gpt-5.6-luna a veces devuelve un mensaje vacío, sin texto ni herramientas (medido
        // 14-09-2026). Antes eso lanzaba error: en el webhook el evento quedaba fallido y el
        // paciente sin respuesta. En un hilo donde callar está permitido, el vacío es silencio; en
        // cualquier otro, se le pide una vez más que conteste antes de rendirse.
        if (!rawText) {
          if (allowSilence && (ownerHandled || !bringsNewRequest) && !changedBookingThisTurn(toolTrace) && !(hasBooking && postponesConfirmation && !ownerHandled)) {
            return {
              text: '', silent: true, silentReason: 'respuesta vacía del modelo en un hilo atendido por el dueño',
              confidence: 'deliberate_silence', source: [], handoff: false, ownerAlert: null,
              provider: llm.provider, model: llm.model, usage: usage(), toolTrace
            };
          }
          if (!emptyRetried) {
            emptyRetried = true;
            messages.push({ role: 'system', content: 'Tu mensaje anterior llegó vacío. Respóndele al cliente ahora, con texto o con la herramienta que corresponda.' });
            continue;
          }
        }
        // Una hora ofrecida tiene que salir de la agenda consultada en este mismo turno. Ante "no
        // tengo la plata todavía", luna corrió la oferta anterior a "lunes 28 a las 17:00 o martes
        // 29 a las 11:00" sin consultar nada (medido 14-09-2026): horas inventadas que el paciente
        // podía elegir. Si el texto trae horas y en el turno no hubo consulta de agenda, se le pide
        // una vez que las verifique; repetir una oferta ya hecha sólo cuesta una consulta extra.
        const agendaCheckedThisTurn = toolTrace.some(item => ['get_availability', 'create_appointment', 'reschedule_appointment', 'get_my_appointment'].includes(item.name));
        if (rawText && round < 3 && !hoursRetried && !agendaCheckedThisTurn && HOUR_PATTERN.test(rawText)) {
          hoursRetried = true;
          messages.push({ role: 'assistant', content: rawText });
          messages.push({ role: 'system', content: 'Ese mensaje NO se envió: menciona horas que no consultaste en este turno. Consulta get_availability para el día o los días que vas a ofrecer y ofrece sólo horas que salgan de esa consulta. Si no ibas a ofrecer horas nuevas, reescribe el mensaje sin horas concretas.' });
          continue;
        }
        // Cerrar con horas no puede depender de que el modelo lo recuerde. Con instrucciones más
        // sueltas (14-09-2026) volvió a terminar en "¿quieres que te busque una hora?" o a soltar un
        // freno con "cuando tengas el dinero, escríbeme", sin ofrecer nada concreto. Si el mensaje
        // pide permiso para buscar o deja la hora para después y no trae horas, se le devuelve una vez.
        // "¿Te refieres a dolor en esas zonas?" es justo lo que Francisco describió como hablar de
        // psicólogo: devolverle al cliente lo que acaba de decir para que lo aclare. Se le devuelve
        // una vez para que lo interprete de la forma natural y siga.
        if (rawText && round < 3 && !echoRetried && /¿\s*(te\s+refieres|a\s+qu[eé]\s+te\s+refieres|quisiste\s+decir|qu[eé]\s+quieres\s+decir)/i.test(rawText)) {
          echoRetried = true;
          messages.push({ role: 'assistant', content: rawText });
          messages.push({ role: 'system', content: 'Ese mensaje NO se envió: le pide al cliente que aclare lo que ya dijo. Interprétalo de la forma más natural (si nombra partes del cuerpo, es dolor o molestia ahí) y sigue la conversación sin repetir sus palabras.' });
          continue;
        }
        const answeringDataRequest = /direcci[oó]n|comuna|nombre|rut\b|correo/i.test(lastAssistantText) && /\?/.test(lastAssistantText);
        // Juez de ritmo: reemplaza las guardas por contadores (primer dolor, descubrimiento, responder primero,
        // pregunta seca). Una sola vez por turno; si el juez falla, el borrador pasa.
        const closingData = /@/.test(String(message || '')) && /\d{1,2}\.?\d{3}\.?\d{3}-?[0-9kK]/.test(String(message || ''));
        const draftHasHours = Boolean(rawText) && (HOUR_PATTERN.test(rawText) || toolTrace.some(item => item.name === 'get_availability' && item.result?.ok && /\b\d{1,2}:\d{2}\b/.test(rawText)));
        const bookingToolUsed = toolTrace.some(item => ['create_appointment', 'reschedule_appointment', 'cancel_appointment'].includes(item.name));
        if (rawText && agendaEnabled && stageRejections < 2 && round < 5 && !hasBooking && !handoffReason && !answeringDataRequest && !closingData && !bookingToolUsed && draftHasHours) {
          if (!stageVerdict) {
            stageVerdict = await judgeConversationStage(llm, { history, message, draft: rawText }, { isGpt5Family }) || { stage: 'ofrecer', guidance: '', usage: { input: 0, output: 0 } };
            totalInputTokens += stageVerdict.usage.input; totalOutputTokens += stageVerdict.usage.output;
          }
          if (stageVerdict.stage === 'conversar') {
            stageRejections += 1;
            rejectDraft('stage_conversar', rawText, stageVerdict.guidance);
            messages.push({ role: 'assistant', content: rawText });
            messages.push({ role: 'system', content: `Ese mensaje NO se envió: todavía no toca ofrecer horas. ${stageVerdict.guidance} Sin horas en este mensaje (no consultes la agenda); las horas van cuando la persona responda. Sé cercano y breve (una o dos frases, una sola pregunta como máximo).` });
            continue;
          }
        }
        // Reglas de "situación" del negocio que se verifican en código (package.agent.required_mentions):
        // si el mensaje del cliente cae en el patrón y el borrador no dice lo exigido, se devuelve una vez.
        // En la urgencia de franciskom el modelo omitía la mención 2 de 2 con la regla enterrada en el prompt.
        const mentionRule = (packageData.agent?.required_mentions || []).find(rule => {
          try {
            return rule?.id && !mentionRetried.has(rule.id)
              && new RegExp(rule.when, 'i').test(String(message || ''))
              && !new RegExp(rule.require, 'i').test(rawText)
              && !history.some(item => item.role === 'assistant' && new RegExp(rule.require, 'i').test(item.content));
          } catch { return false; }
        });
        if (rawText && mentionRule && round < 4) {
          mentionRetried.add(mentionRule.id);
          rejectDraft('required_mention_' + mentionRule.id, rawText);
          messages.push({ role: 'assistant', content: rawText });
          messages.push({ role: 'system', content: 'Ese mensaje NO se envió: ' + (mentionRule.instruction || 'falta una mención obligatoria de esta situación.') });
          continue;
        }
        // Lo contrario de required_mentions (package.agent.forbidden_mentions): el borrador dice algo que
        // sólo corresponde en cierta situación y el cliente no ha dicho nada que la configure. Caso
        // real (franciskom, 16-10-2026): ante "dolor atroz de cuello" sin ninguna señal de urgencia, el
        // bot mandó a urgencias a una paciente que sólo quería una hora, contra la regla de agendar todo dolor.
        const forbiddenRule = (packageData.agent?.forbidden_mentions || []).find(rule => {
          try {
            return rule?.id && !forbiddenRetried.has(rule.id)
              && new RegExp(rule.forbid, 'i').test(rawText)
              && !(rule.unless && userTurns.some(text => new RegExp(rule.unless, 'i').test(String(text || ''))))
              && !history.some(item => item.role === 'assistant' && new RegExp(rule.forbid, 'i').test(item.content));
          } catch { return false; }
        });
        if (rawText && forbiddenRule && round < 4) {
          forbiddenRetried.add(forbiddenRule.id);
          rejectDraft('forbidden_mention_' + forbiddenRule.id, rawText);
          messages.push({ role: 'assistant', content: rawText });
          messages.push({ role: 'system', content: 'Ese mensaje NO se envió: ' + (forbiddenRule.instruction || 'dice algo que no corresponde a lo que contó el cliente.') });
          continue;
        }
        if (rawText && agendaEnabled && !hasBooking && !handoffReason && round < 3 && !closingRetried && !HOUR_PATTERN.test(rawText) && (asksPermissionToBook.test(rawText) || postponesSale.test(rawText))) {
          closingRetried = true;
          messages.push({ role: 'assistant', content: rawText });
          messages.push({ role: 'system', content: 'Ese mensaje NO se envió: pide permiso para buscar hora o deja la hora para después sin ofrecer nada concreto. Consulta la agenda y ofrécele dos o tres horas reales (si puso un freno de plata o de tiempo, en una fecha más adelante). Mantén el resto de lo que ibas a decir.' });
          continue;
        }
        const leak = rawText ? detectInternalLeak(rawText, internalSources) : null;
        if (leak && !leakRetried && round < 4) {
          leakRetried = true;
          rejectDraft('internal_leak', rawText, leak.match);
          messages.push({ role: 'assistant', content: rawText });
          messages.push({ role: 'system', content: 'Ese mensaje NO se envió: repite texto interno del negocio o habla del agente, del sistema o de reglas. Al cliente sólo le dices lo que le sirve a él, con tus palabras: nunca menciones reglas, criterios internos, el sistema ni cómo funcionas. Reescríbelo.' });
          continue;
        }
        if (rawText && !repeatRetried && round < 4 && repeatsLastAgentMessage(rawText, history)) {
          repeatRetried = true;
          rejectDraft('repeats_last_message', rawText);
          messages.push({ role: 'assistant', content: rawText });
          messages.push({ role: 'system', content: 'Ese mensaje NO se envió: es casi igual a tu mensaje anterior en esta conversación. No repitas: responde sólo a lo nuevo que dijo el cliente, en una o dos frases. Si no hay nada nuevo que responder, llama no_intervenir si la tienes; si no, haz una sola pregunta corta distinta.' });
          continue;
        }
        const finalText = finalizeText(rawText);
        let validation = validateMutationClaims(finalText, toolTrace, { appointmentOnFile: hasBooking });
        // "Le aviso a Francisco" sin haber llamado la herramienta: antes se reemplazaba por
        // "Todavía no dejé ese aviso. ¿Quieres que le pida al equipo que te escriba?" y el paciente
        // quedaba colgado (Camilo, 14-09-2026, pidiendo cambiar una hora que no se pudo). Si el
        // modelo decidió avisar, el runtime cumple el aviso y deja el texto.
        if (!validation.ok && validation.blockedTool === 'request_human_handoff') {
          ownerAlert = ownerAlert || `El agente le dijo al cliente que te avisaba. Último mensaje del cliente: "${String(message || '').slice(0, 200)}"`;
          validation = { ok: true, text: finalText };
        }
        const text = validation.text || bookingChangeNotice(toolTrace);
        if (!text) throw new Error('Groq devolvió una respuesta vacía');
        const handoff = toolTrace.some(item => item.name === 'request_human_handoff' && item.result?.ok);
        // Antes, un "no tengo ese dato confirmado" contaba como traspaso: dejaba el hilo mudo y le
        // mandaba un aviso urgente al dueño por no saber un dato. Ahora es un aviso blando — el
        // dueño se entera igual, pero el agente sigue atendiendo la conversación.
        const missingFact = !handoff && text.toLowerCase().includes('no tengo ese dato confirmado');
        const alert = ownerAlert || (missingFact ? 'El agente no tenía ese dato confirmado y ofreció que el negocio responda.' : null);
        return { text, confidence: validation.ok ? 'model_from_confirmed_context' : 'safety_blocked', source: selectedFacts.map(fact => fact.subject), handoff, handoffReason, ownerAlert: handoff ? null : alert, provider: llm.provider, model: llm.model, usage: usage(), toolTrace, safetyBlocked: validation.ok ? null : validation.blockedTool };
      }
      messages.push({ role: 'assistant', content: assistantMessage.content || null, tool_calls: calls });
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
        const name = call.function?.name;
        const answerTool = result => {
          toolTrace.push({ name, result });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        };
        // Silencio deliberado: se corta acá, sin volver a pasar por el modelo y sin texto. El
        // llamador es el que no envía nada (ver server.js), así el silencio es del runtime y no
        // depende de que el modelo produzca una respuesta vacía.
        // La anulación por "consulta nueva" queda sólo para el cliente con hora tomada en un hilo
        // que lleva el propio agente (luna se callaba ante "¿tienes el lunes?", 14-09-2026). En un
        // hilo del dueño, callarse es la decisión correcta aunque el mensaje traiga una pregunta.
        // Mensaje de un sistema o de un tercero (campaña, menú de botones, otra organización): no
        // se contesta. Silencio del runtime, igual que no_intervenir, pero disponible en cualquier hilo.
        // Si el seguro de cancelación acaba de frenar una anulación, el cliente dijo algo que el modelo
        // tomó por anular: callarse lo deja sin respuesta y con la duda. Hay que contestarle.
        if (name === 'no_intervenir' && toolTrace.some(item => item.name === 'cancel_appointment' && item.result?.action === 'kept_booking')) {
          answerTool({ ok: false, action: 'answer_instead', message: 'No te quedes callado: el cliente dijo algo sobre su hora y no se anuló nada. Respóndele en una frase y, si dudas qué quiso decir, pregúntale si quiere mantenerla o anularla.' });
          continue;
        }
        if (name === 'ignorar_mensaje_ajeno' && args?.origen !== 'respuesta_automatica' && args?.origen !== 'otra_organizacion') {
          answerTool({ ok: false, action: 'answer_instead', message: 'Es una persona que consulta o pide algo: respóndele (si es algo que el negocio no hace, díselo con amabilidad). No te quedes callado.' });
          continue;
        }
        if (name === 'ignorar_mensaje_ajeno' && !literalSent && !hasBooking) {
          return {
            text: '', silent: true, silentReason: String(args?.reason || 'mensaje ajeno').slice(0, 300),
            confidence: 'deliberate_silence', source: [], handoff: false, ownerAlert: null,
            provider: llm.provider, model: llm.model, usage: usage(), toolTrace
          };
        }
        if (name === 'no_intervenir' && !literalSent && changedBookingThisTurn(toolTrace)) {
          answerTool({ ok: false, action: 'confirm_change', message: 'Acabas de cambiar su reserva en este turno: confírmaselo al cliente en una o dos frases (qué quedó y cuándo). No puedes quedarte callado.' });
          continue;
        }
        // "Le puedo confirmar en la mañana" con hora tomada no es un cierre: la regla (Daniel,
        // 11-10-2026) es dejarle la hora guardada, decírselo y avisar a Francisco. Callarse dejaba a
        // la paciente sin respuesta y al dueño sin enterarse (replay D-a2).
        if (name === 'no_intervenir' && !literalSent && !ownerHandled && hasBooking && postponesConfirmation) {
          ownerAlert = ownerAlert || `Tiene hora tomada y quedó de confirmar después: "${String(message || '').slice(0, 200)}". La hora sigue guardada.`;
          answerTool({ ok: false, action: 'acknowledge_hold', message: 'No te quedes callado: el cliente pide tiempo para confirmar su hora. Dile en una frase que se la dejas guardada y que te avise. No la anules ni le ofrezcas otras horas.' });
          continue;
        }
        if (name === 'no_intervenir' && allowSilence && !ownerHandled && !literalSent && bringsNewRequest) {
          answerTool({ ok: false, action: 'new_request', message: 'El cliente hace una consulta nueva para ti (pregunta o pide hora, precio o disponibilidad): respóndela y avanza hacia la hora, aunque parte del hilo lo haya atendido otra persona.' });
          continue;
        }
        if (name === 'no_intervenir' && allowSilence && !literalSent) {
          return {
            text: '', silent: true, silentReason: String(args?.reason || '').slice(0, 300),
            confidence: 'deliberate_silence', source: [], handoff: false, ownerAlert: null,
            provider: llm.provider, model: llm.model, usage: usage(), toolTrace
          };
        }
        if (name === 'responder_textual') {
          const chosen = literalReplies(packageData).find(item => item.id === args?.id);
          // Un bloque oficial se manda una vez por conversación: después del de precios, "las piernas,
          // cuello y cintura" volvía a recibir el mismo bloque (medido 14-09-2026).
          const literalKey = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          if (chosen && history.some(item => item.role === 'assistant' && literalKey(item.content) === literalKey(chosen.text))) {
            answerTool({ ok: false, action: 'already_sent', message: 'Ese bloque oficial ya se lo mandaste antes en esta conversación. No lo repitas: responde con tus palabras a lo que dijo ahora.' });
            continue;
          }
          // Un bloque puede declarar qué tiene que traer el mensaje para aplicar ("match"). "Cómo es la
          // sesión" se pegaba ante cualquier relato de dolor o ante "¿es una hernia?", sin que nadie
          // hubiera preguntado cómo es la sesión.
          if (chosen && chosen.match && !(() => { try { return new RegExp(chosen.match, 'i').test(String(message || '')); } catch { return true; } })()) {
            answerTool({ ok: false, action: 'not_asked', message: `El cliente no preguntó eso ("${chosen.id}"). No se envió: responde tú a lo que dijo, con tus palabras y usando el conocimiento confirmado del negocio (ahí suele estar la respuesta).` });
            continue;
          }
          // "ademas": el segundo bloque viene en la misma llamada. Esperar que el modelo haga una
          // segunda llamada fallaba 1 de cada 3 veces ante "dónde queda y cuánto vale" (replay 08-10).
          const second = chosen && !literalSent ? literalReplies(packageData).find(item => item.id === args?.ademas) : null;
          if (second && second.id !== chosen.id && !second.image && !chosen.image
            && !history.some(item => item.role === 'assistant' && literalKey(item.content) === literalKey(second.text))) extraLiterals.push(second);
          // Con hora ya tomada, una pregunta corta sobre plata ("¿son 30 mil?") no pide el bloque de precios
          // completo: la sede de su hora tiene un valor y se le dice en una frase. Reenviarlo mezclaba los
          // $30.000 de otra sede con los $36.000 de la suya (franciskom, 09-10-2026).
          if (chosen && !literalSent && hasBooking && /\$\s?\d/.test(chosen.text) && String(message || '').trim().split(/\s+/).length <= 8) {
            answerTool({ ok: false, action: 'answer_in_words', message: 'El cliente ya tiene una hora tomada y hace una pregunta corta. No mandes el bloque de precios entero: respóndele en una frase con el valor de la sede de SU hora. Si el monto que menciona es el de otra sede o servicio, dile expresamente que ese valor corresponde a esa otra sede y cuál es el de su hora ("los $30.000 son de Eleva Salud; tu hora es en Box Buin y vale $36.000"), usando el conocimiento confirmado.' });
            continue;
          }
          // Si en este turno se anuló o se cambió la hora, el bloque no puede ir solo: el cliente se
          // quedaba con el mapa y sin saber que su hora ya no existía (replay 11-10-2026, 2 de 2).
          const changedBookingNow = successfulAction(toolTrace, 'cancel_appointment', ['cancelled'])
            || successfulAction(toolTrace, 'reschedule_appointment', ['rescheduled', 'rescheduled_needs_manual_confirmation']);
          // Con la hora tomada en la consulta, "la sesión es en mi casa" corrige la modalidad: el mapa
          // de la sede es justo lo contrario (Pilar, 09-10-2026). Cambiar la modalidad lo hace el
          // dueño, así que se le avisa y al cliente se le pide la dirección.
          const bookedOnsite = upcomingAppointments.some(item => (catalogSource.services || []).find(service => normalizeText(service.name) === normalizeText(item.service))?.delivery_mode !== 'mobile');
          if (chosen && !literalSent && hasBooking && offersBothModes && bookedOnsite && HOME_VISIT.test(String(message || '')) && /maps\.|waze/i.test(chosen.text || '')) {
            ownerAlert = ownerAlert || `Tiene hora en la consulta, pero dice que la sesión es a domicilio: "${String(message || '').slice(0, 200)}". Revisa la modalidad de su cita.`;
            answerTool({ ok: false, action: 'mode_mismatch', message: 'No se envió la ubicación: el cliente dice que la sesión es en su casa y su hora quedó en la consulta. Dile en una frase que le avisas a Francisco para dejarla a domicilio y pídele la dirección (calle, número y comuna). No anules ni cambies la hora.' });
            continue;
          }
          if (chosen && !literalSent && hasBooking && changedBookingNow) {
            literalSent = chosen;
            answerTool({ ok: true, action: 'literal_sent', id: chosen.id, instruccion: 'Ese bloque oficial ya le llegó al cliente en un mensaje aparte. Ahora escribe UN mensaje corto que le diga claro lo que pasó con su hora en este turno (anulada o cambiada, nombrando día y hora) y, si corresponde, lo que sí buscaba. No repitas nada del bloque.' });
            continue;
          }
          // Con hora tomada, un bloque de "agendar en otro lugar" significa que quizás se equivocó de
          // sede: el bloque solo la dejaba sin saber qué pasaba con la hora que ya tenía (Claudia,
          // franciskom, 09-10-2026). Se nombra su hora y se le pregunta; anular lo decide ella.
          // Lo mismo si en este turno el modelo quiso anular y se le impidió: "esa no es la dirección
          // que me dieron" terminaba en el mapa del box solo (replay 11-10-2026, 2 de 2).
          const doubtedBookingNow = toolTrace.some(item => item?.result?.action === 'kept_booking')
            || /equivoqu|equivocad|\b(esa no|ese no)\b|\bno (es|era) (la|el|ese|esa|ah[ií]|all[aá])\s*(direcci|lugar|sede|box|consulta|centro|ah[ií]|all[aá]|$)|pens[eé] que (era|er[ao]|ser[ií]a)|no (es|era) (ah[ií]|all[aá])/i.test(String(message || ''));
          if (chosen && !literalSent && hasBooking && (doubtedBookingNow || /agend|tomar hora|reserv/i.test(chosen.when || ''))) {
            literalSent = chosen;
            const whenFmt = new Intl.DateTimeFormat('es-CL', { timeZone: businessTimeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
            const booked = upcomingAppointments.map(item => `${item.service || 'sesión'} el ${(() => { try { return whenFmt.format(new Date(item.starts_at)); } catch { return item.starts_at; } })()}`).join('; ');
            ownerAlert = ownerAlert || `Tiene hora tomada (${booked}) y ahora duda del lugar o pide agendar en otro: "${String(message || '').slice(0, 200)}". Revisa si mantiene su hora.`;
            answerTool({ ok: true, action: 'literal_sent', id: chosen.id, instruccion: `Ese bloque oficial ya le llegó al cliente en un mensaje aparte. El cliente YA tiene hora tomada: ${booked}. Escribe UN mensaje corto que nombre esa hora y le pregunte si se la mantienes o se la anulas ("¿te la mantengo o te la anulo?"). No la anules tú y no repitas nada del bloque.` });
            continue;
          }
          if (chosen && !literalSent && hasBooking) {
            literalSent = chosen;
            return literalResult('');
          }
          if (chosen && !literalSent) {
            literalSent = chosen;
            // Se le listan los otros bloques en la propia respuesta: con la instrucción sola, ante
            // "horas, ubicación y valores" mandaba un bloque y se olvidaba del otro 1 de 2 veces.
            const others = literalReplies(packageData).filter(item => item.id !== chosen.id && !item.image)
              .map(item => `"${item.id}" (${String(item.when || '').split(/[.;]/)[0].slice(0, 120)})`).join('; ');
            const otherAsked = others && !extraLiterals.length ? `ANTES de escribir tu mensaje, revisa el mensaje del cliente: si además preguntó algo que cubre otro bloque oficial, llama ahora responder_textual con ese id. Otros bloques: ${others}.` : '';
            // Quien pide atención a domicilio no recibe horas del box: esas horas no consideran el
            // traslado, y ofrecérselas le prometía un horario que a domicilio puede no existir (medido
            // 14-09-2026). Para domicilio lo que falta es la dirección.
            const wantsHomeVisit = HOME_VISIT.test(String(message || ''));
            // Después de un bloque oficial (precio, qué incluye) el juez decide si toca ofrecer horas o preguntar qué le pasa.
            const stageAfterLiteral = wantsHomeVisit ? null : await judgeConversationStage(llm, { history, message, draft: '' }, { isGpt5Family }).catch(() => null);
            if (stageAfterLiteral) { totalInputTokens += stageAfterLiteral.usage.input; totalOutputTokens += stageAfterLiteral.usage.output; }
            const warmUp = !wantsHomeVisit && stageAfterLiteral?.stage === 'conversar';
            const suggested = wantsHomeVisit || warmUp ? null : await suggestedSlotsForFollowUp().catch(() => null);
            literalSuggested = suggested;
            if (warmUp) {
              answerTool({
                ok: true, action: 'literal_sent', id: chosen.id,
                instruccion: 'Ese bloque oficial ya le llegó al cliente tal cual, en un mensaje aparte. Todavía no sabemos qué le pasa: escribe UN segundo mensaje corto con una sola pregunta cercana y abierta sobre qué le está molestando o qué le gustaría tratar (por ejemplo "Cuéntame, ¿qué te está molestando?"). No ofrezcas horas todavía, no repitas nada del bloque y no hagas más de una pregunta. ' + otherAsked
              });
              continue;
            }
            answerTool({
              ok: true, action: 'literal_sent', id: chosen.id,
              horas_sugeridas: suggested || 'no se encontraron horas en los próximos días',
              instruccion: `Ese bloque oficial ya le llegó al cliente tal cual, en un mensaje aparte. Ahora escribe UN segundo mensaje corto (una o dos frases) que deje la hora a un paso: ofrécele horas concretas y termina con "¿cuál te dejo?" (o "¿te la dejo?" si hay una sola). No repitas nada de lo que ya dice el bloque (precios, direcciones, horarios de atención, que una sede se coordina con el centro) y no le hagas preguntas previas como qué servicio quiere o en qué sede: eso se resuelve después, al tomar la hora. ${wantsHomeVisit ? 'Pidió atención a domicilio: pídele la dirección (calle, número y comuna) para buscarle hora a domicilio, en una sola pregunta, y no le ofrezcas horas en la sede.' : `Horas ya consultadas en la agenda real: ${suggested || 'ninguna'}. Úsalas, salvo que el cliente haya pedido un día u horario específico: en ese caso consulta ese día con la herramienta y ofrece esas. Si pidió un día sin atención, dilo en media frase y ofrece las horas consultadas.`} Responde exactamente SIN_SEGUIMIENTO sólo si el cliente ya tiene su hora tomada. ${otherAsked}`
            });
            continue;
          }
          if (chosen && literalSent && chosen.id !== literalSent.id && !extraLiterals.length && !chosen.image && !literalSent.image) {
            extraLiterals.push(chosen);
            answerTool({ ok: true, action: 'literal_sent', id: chosen.id, instruccion: 'Este segundo bloque oficial también se envió, junto al primero. Sigue con el mensaje corto que avanza hacia la hora.' });
            continue;
          }
          // Sin este caso aparte, un id que ya no existe como respuesta oficial (tratamiento_respiratorio
          // pasó a conocimiento el 14-09-2026) recibía "ya se enviaron las respuestas oficiales" y el
          // modelo terminaba en "no tengo ese dato confirmado", 2 de 4 veces.
          answerTool(chosen
            ? { ok: false, message: 'Ya se enviaron las respuestas oficiales de este turno; no mandes otra.' }
            : { ok: false, action: 'unknown_reply', message: 'No hay una respuesta oficial con ese id. Responde tú con tus palabras usando el conocimiento confirmado del negocio: ahí está la información.' });
          continue;
        }
        // Una hora se toma o se cambia sólo si el cliente la eligió: tiene que estar en su mensaje o en
        // el último mensaje del agente que él está respondiendo. Rodolfo (14-09-2026) mandó su
        // dirección ("Eduardo Ríos Mackenna 1544, Buin") y el modelo agendó a "Eduardo" a las 19:00,
        // una hora que nadie había elegido en ese intercambio.
        if ((name === 'create_appointment' || name === 'reschedule_appointment') && !hourChosenByClient(args?.time)) {
          answerTool({ ok: false, action: 'confirm_first', message: `Todavía no hay una hora elegida por el cliente para ${args?.time || 'esa hora'}: el cliente no la escribió ni la aceptó con claridad (ofrecer una lista de horas no es elegir una). No se agendó nada. Ofrécele las horas reales y espera que elija.` });
          continue;
        }
        if (name === 'create_appointment' && !modalityEstablished()) {
          answerTool({ ok: false, action: 'ask_modality_first', message: `No se agendó nada todavía: falta saber si la sesión es en ${onsiteNames.join(' o ') || 'la consulta'} o a domicilio. Pregúntaselo en una frase corta, manteniendo la hora que eligió ("¿la sesión sería en ${onsiteNames[0] || 'la consulta'} o a domicilio?"), y agenda cuando conteste. Si es a domicilio, pide también la dirección.` });
          continue;
        }
        // "La sesión es en mi casa" no basta para agendar: sin dirección la hora queda sin traslado
        // calculado y Francisco no sabe adónde ir (replay D-b2, 11-10-2026: agendó a domicilio sin
        // dirección). Y quien pidió domicilio no queda agendado en el box.
        if (name === 'create_appointment' && offersBothModes) {
          const chosenService = bookableCatalog.find(item => normalizeText(item.name) === normalizeText(args?.service))
            || bookableCatalog.find(item => args?.service && normalizeText(item.name).includes(normalizeText(args.service)));
          const lastModeText = [...history.filter(item => item.role === 'user').map(item => item.content), String(message || '')]
            .reverse().find(text => HOME_VISIT.test(text) || mentionsOnsite(text));
          const wantsHome = Boolean(lastModeText && HOME_VISIT.test(lastModeText));
          if (wantsHome && chosenService && chosenService.delivery_mode !== 'mobile') {
            answerTool({ ok: false, action: 'wrong_mode', message: `No se agendó nada: el cliente pidió la sesión a domicilio y "${chosenService.name}" es en la consulta. Usa el servicio a domicilio del catálogo y su dirección.` });
            continue;
          }
          if (chosenService?.delivery_mode === 'mobile' && !/\d|s\/n|sin n[uú]mero/i.test(String(args?.address || ''))) {
            answerTool({ ok: false, action: 'ask_address', message: 'No se agendó nada todavía: para una sesión a domicilio falta la dirección (calle, número y comuna). Si ya te la dio en esta conversación, pásala en address; si no, pídesela en una frase corta, manteniendo la hora que eligió.' });
            continue;
          }
        }
        if (name === 'cancel_appointment' && !cancelRequestedByClient()) {
          ownerAlert = ownerAlert || `Tiene hora tomada y escribió: "${String(message || '').slice(0, 200)}". El bot no la anuló porque no lo pidió con esas palabras; revisa si la mantiene.`;
          answerTool({ ok: false, action: 'kept_booking', message: (HOME_VISIT.test(String(message || '')) ? 'Si lo que dice es que la sesión es en su casa: no le ofrezcas anular; dile que le avisas a Francisco para dejarla a domicilio y pídele la dirección (calle, número y comuna). ' : '') + 'No se anuló nada: el cliente no pidió anular su hora. Si pide tiempo para confirmar o tiene un inconveniente ("te confirmo mañana", "tengo turno"), dile en una frase que se la dejas guardada y que te avise; Francisco ya quedó avisado. Si de verdad parece que ya no le sirve o que se equivocó de sede o de lugar, nómbrale su hora, dale en el mismo mensaje lo que sí buscaba (por ejemplo, cómo se agenda en la otra sede) y pregúntale "¿te la anulo?"; espera su respuesta. No le preguntes por su dolor.' });
          continue;
        }
        if (name === 'avisar_al_dueno' && !hasBooking && !concreteOfferMade()) {
          answerTool({ ok: false, action: 'offer_first', message: 'Todavía no le ofreciste horas concretas a este cliente. No se avisó al dueño: primero consulta la disponibilidad y ofrécele dos o tres horas reales. Si con eso sigue dudando, ahí sí avisa.' });
          continue;
        }
        // clientTexts: lo que dijo el cliente, para que las herramientas verifiquen que un dato extraído (la comuna) salió de él y no lo supuso el modelo.
        const result = await executeAgendaTool(packageData, name, args, { ...context, clientTexts: userTurns });
        // Claudia (franciskom, 09-10-2026) había pedido en septiembre los datos del centro médico y hoy
        // pidió "una hora": el bot le dejó el Box sin que nadie le preguntara la sede. Si en la
        // conversación (de cualquier día) apareció otra sede, las horas no se ofrecen sin decirlo.
        if (name === 'get_availability' && result?.ok && Array.isArray(result.available_slots) && result.available_slots.length) {
          const asked = String(args?.location || args?.service || '').toLowerCase();
          const otherSedes = (catalogSource.locations || []).map(item => String(item.name || '').replace(/\(.*?\)/g, '').trim().toLowerCase())
            .filter(term => term && !asked.includes(term));
          const mentioned = [...history.filter(item => item.role === 'user').map(item => item.content), message].some(text => [...otherSedes, 'centro médico', 'centro medico'].some(term => String(text || '').toLowerCase().includes(term)));
          if (mentioned) result.aviso_sede = 'En esta conversación apareció otra sede (el centro médico). Estas horas son de la sede que consultaste, no de esa. Al ofrecerlas nombra la sede con su valor y, en una frase, aclara que si el cliente buscaba la otra sede esa hora se coordina directo con ellos; pregúntale cuál prefiere antes de dejarle una hora tomada.';
        }
        if (name === 'avisar_al_dueno' && result?.ok) ownerAlert = String(args?.reason || 'El cliente necesita que el dueño entre a la conversación.').slice(0, 400);
        if (name === 'request_human_handoff' && result?.ok) handoffReason = String(args?.reason || '').slice(0, 400);
        // Una herramienta puede pedir el aviso ella misma (un cambio de hora que falló por un
        // problema técnico): el dueño se entera aunque el modelo no llame avisar_al_dueno.
        if (result?.owner_alert) ownerAlert = String(result.owner_alert).slice(0, 400);
        answerTool(result);
      }
      // Mientras se escribe el seguimiento de un bloque oficial no tiene sentido elegir otro bloque,
      // callarse ni traspasar: sólo queda avanzar hacia la hora.
      // Hasta un segundo bloque sí: Ariel (08-10-2026) preguntó horas, ubicación y valores en un solo
      // mensaje, le llegó el bloque de precios y la ubicación nunca, porque la herramienta ya no estaba.
      if (literalSent) activeTools = tools.filter(item => ![...(extraLiterals.length ? ['responder_textual'] : []), 'no_intervenir', 'request_human_handoff'].includes(item.function?.name));
    }
    if (literalSent) return literalResult('');
    const changeNotice = bookingChangeNotice(toolTrace);
    if (changeNotice) {
      return { text: changeNotice, confidence: 'deterministic_booking_notice', source: [], handoff: false, ownerAlert, provider: llm.provider, model: llm.model, usage: usage(), toolTrace };
    }
    throw new Error('El agente excedió el límite de pasos de herramientas.');
  } catch (error) {
    if (!allowDeterministicFallback) throw error;
    console.warn('LLM no disponible en preview; se usa respuesta determinista:', error.message);
    return { ...fallback, provider: 'deterministic_fallback', usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
