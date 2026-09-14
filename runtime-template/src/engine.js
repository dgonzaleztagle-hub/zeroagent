import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAgendaTool, getAgendaToolDefinitions, literalReplies } from './agenda-tools.js';
import { getAgendaDashboard } from './agenda.js';
import { BASE_BEHAVIOR } from './base-behavior.js';
import { AGENDA_BEHAVIOR } from './agenda-behavior.js';
import { liveInjectedFacts } from './business-data.js';

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

function successfulAction(toolTrace, tool, allowedActions) {
  return toolTrace.some(item => {
    if (item?.name !== tool || item.result?.ok !== true) return false;
    const action = String(item.result?.action || '').trim();
    // Compatibilidad con trazas anteriores a `action`; el runtime actual siempre la informa.
    return !action || allowedActions.includes(action);
  });
}

function claimHasEvidence(claim, toolTrace) {
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
    return toolTrace.some(item => item?.name === 'get_my_appointment'
      && item.result?.ok === true
      && Array.isArray(item.result.appointments)
      && item.result.appointments.length > 0);
  }
  return false;
}

export function validateMutationClaims(text, toolTrace = []) {
  const normalizedText = normalizedClaimText(text);
  const trace = Array.isArray(toolTrace) ? toolTrace : [];
  const unsupported = MUTATION_CLAIMS.find(claim => claim.patterns.some(pattern => patternMatchesCompletedClaim(pattern, normalizedText))
    && !claimHasEvidence(claim, trace));
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
  const liveFacts = await liveInjectedFacts(packageData).catch(() => []);
  const facts = [...liveFacts, ...bakedFacts];
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
    const tools = getAgendaToolDefinitions(packageData, catalogSource, { allowSilence: context.allowSilence === true });
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
Servicios: ${servicesDetail}. Profesionales: ${names(catalogSource.resources)}.${(catalogSource.locations || []).length ? ` Sedes: ${names(catalogSource.locations)}.` : ''} Zona horaria del negocio: ${tz}. Las herramientas devuelven horarios en formato ISO/UTC: preséntaselos SIEMPRE al cliente en la hora local de ${tz}, nunca en UTC.`;
      })() : '',
      packageData.agent?.system_prompt ? `DIRECTIVAS ESPECÍFICAS APROBADAS POR EL NEGOCIO (complementan las reglas anteriores, nunca las contradicen):\n${packageData.agent.system_prompt}` : ''
    ].filter(Boolean).join('\n\n');
    const messages = [
      {
        role: 'system',
        content: `${systemPrefix}\n\nFECHA Y HORA ACTUAL (${businessTimeZone}): ${nowLabel}. Usa esto como referencia real para "hoy", "mañana", días de la semana o cualquier fecha relativa — nunca asumas ni inventes otra fecha.\n\nCONOCIMIENTO CONFIRMADO DEL NEGOCIO (razona cuál aplica a la pregunta; no todos son relevantes):\n${factsContext || (agendaEnabled ? '(No hay conocimiento cargado; usa una herramienta de Agenda si corresponde.)' : '(No hay conocimiento confirmado cargado.)')}`
      },
      ...history,
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
      const checked = draft && !/SIN_SEGUIMIENTO/i.test(draft) ? validateMutationClaims(draft, toolTrace) : null;
      return {
        text: [literalSent, ...extraLiterals].map(item => item.text).join('\n\n'), imageUrl: literalSent.image || '', followUpText: checked?.ok ? checked.text : '',
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
    const bringsNewRequest = /\?|\b(tienes|tiene|tienen|hay|cu[aá]nto|precio|valor|agendar|agenda|reservar|otra hora|disponib|horario)\b/i.test(String(message || ''));
    const HOUR_PATTERN = /\b\d{1,2}:\d{2}\b|\ba las \d{1,2}\b/i;
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
    for (let round = 0; round < 5; round++) {
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
        if (literalSent) return literalResult(assistantMessage.content);
        const rawText = String(assistantMessage.content || '').trim();
        // gpt-5.6-luna a veces devuelve un mensaje vacío, sin texto ni herramientas (medido
        // 14-09-2026). Antes eso lanzaba error: en el webhook el evento quedaba fallido y el
        // paciente sin respuesta. En un hilo donde callar está permitido, el vacío es silencio; en
        // cualquier otro, se le pide una vez más que conteste antes de rendirse.
        if (!rawText) {
          if (context.allowSilence === true && !bringsNewRequest) {
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
        const validation = validateMutationClaims(rawText, toolTrace);
        const text = validation.text;
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
        if (name === 'no_intervenir' && context.allowSilence === true && !literalSent && bringsNewRequest) {
          answerTool({ ok: false, action: 'new_request', message: 'El cliente hace una consulta nueva para ti (pregunta o pide hora, precio o disponibilidad): respóndela y avanza hacia la hora, aunque parte del hilo lo haya atendido otra persona.' });
          continue;
        }
        if (name === 'no_intervenir' && context.allowSilence === true && !literalSent) {
          return {
            text: '', silent: true, silentReason: String(args?.reason || '').slice(0, 300),
            confidence: 'deliberate_silence', source: [], handoff: false, ownerAlert: null,
            provider: llm.provider, model: llm.model, usage: usage(), toolTrace
          };
        }
        if (name === 'responder_textual') {
          const chosen = literalReplies(packageData).find(item => item.id === args?.id);
          if (chosen && !literalSent) {
            literalSent = chosen;
            // Quien pide atención a domicilio no recibe horas del box: esas horas no consideran el
            // traslado, y ofrecérselas le prometía un horario que a domicilio puede no existir (medido
            // 14-09-2026). Para domicilio lo que falta es la dirección.
            const wantsHomeVisit = /domicilio|a (mi |la )?casa|vengan|venir a/i.test(String(message || ''));
            const suggested = wantsHomeVisit ? null : await suggestedSlotsForFollowUp().catch(() => null);
            answerTool({
              ok: true, action: 'literal_sent', id: chosen.id,
              horas_sugeridas: suggested || 'no se encontraron horas en los próximos días',
              instruccion: `Ese bloque oficial ya le llegó al cliente tal cual, en un mensaje aparte. Ahora escribe UN segundo mensaje corto (una o dos frases) que deje la hora a un paso: ofrécele horas concretas y termina con "¿cuál te dejo?" (o "¿te la dejo?" si hay una sola). No repitas nada de lo que ya dice el bloque (precios, direcciones, horarios de atención, que una sede se coordina con el centro) y no le hagas preguntas previas como qué servicio quiere o en qué sede: eso se resuelve después, al tomar la hora. ${wantsHomeVisit ? 'Pidió atención a domicilio: pídele la dirección (calle, número y comuna) para buscarle hora a domicilio, en una sola pregunta, y no le ofrezcas horas en la sede.' : `Horas ya consultadas en la agenda real: ${suggested || 'ninguna'}. Úsalas, salvo que el cliente haya pedido un día u horario específico: en ese caso consulta ese día con la herramienta y ofrece esas. Si pidió un día sin atención, dilo en media frase y ofrece las horas consultadas.`} Responde exactamente SIN_SEGUIMIENTO sólo si el cliente ya tiene su hora tomada.`
            });
            continue;
          }
          if (chosen && literalSent && chosen.id !== literalSent.id && !extraLiterals.length && !chosen.image && !literalSent.image) {
            extraLiterals.push(chosen);
            answerTool({ ok: true, action: 'literal_sent', id: chosen.id, instruccion: 'Este segundo bloque oficial también se envió, junto al primero. Sigue con el mensaje corto que avanza hacia la hora.' });
            continue;
          }
          answerTool({ ok: false, message: 'Ya se enviaron las respuestas oficiales de este turno; no mandes otra.' });
          continue;
        }
        if (name === 'avisar_al_dueno' && !concreteOfferMade()) {
          answerTool({ ok: false, action: 'offer_first', message: 'Todavía no le ofreciste horas concretas a este cliente. No se avisó al dueño: primero consulta la disponibilidad y ofrécele dos o tres horas reales. Si con eso sigue dudando, ahí sí avisa.' });
          continue;
        }
        const result = await executeAgendaTool(packageData, name, args, context);
        if (name === 'avisar_al_dueno' && result?.ok) ownerAlert = String(args?.reason || 'El cliente necesita que el dueño entre a la conversación.').slice(0, 400);
        if (name === 'request_human_handoff' && result?.ok) handoffReason = String(args?.reason || '').slice(0, 400);
        answerTool(result);
      }
      // Mientras se escribe el seguimiento de un bloque oficial no tiene sentido elegir otro bloque,
      // callarse ni traspasar: sólo queda avanzar hacia la hora.
      if (literalSent) activeTools = tools.filter(item => !['responder_textual', 'no_intervenir', 'request_human_handoff'].includes(item.function?.name));
    }
    if (literalSent) return literalResult('');
    throw new Error('El agente excedió el límite de pasos de herramientas.');
  } catch (error) {
    if (!allowDeterministicFallback) throw error;
    console.warn('LLM no disponible en preview; se usa respuesta determinista:', error.message);
    return { ...fallback, provider: 'deterministic_fallback', usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
