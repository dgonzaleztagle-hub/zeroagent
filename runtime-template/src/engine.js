import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAgendaTool, getAgendaToolDefinitions } from './agenda-tools.js';
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
      claimPattern(`\\b(?:el equipo|francisco|una persona|un humano|una humana)\\b(?!.{0,30}\\b(?:no|nunca)\\b).{0,60}\\b(?:avisad[ao]|notificad[ao])\\b`)
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
  if (claim.evidence === 'handoff') return successfulAction(toolTrace, 'request_human_handoff', ['handoff_requested']);
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
  return {
    ok: false,
    blockedTool: unsupported.tool,
    text: 'No pude confirmar esa operación de forma segura. No hice cambios en tu reserva. Puedo volver a intentarlo o pedir ayuda al equipo.'
  };
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
    const tools = getAgendaToolDefinitions(packageData);
    const agendaEnabled = tools.length > 0;
    const history = Array.isArray(context.history) ? context.history.slice(-20).filter(item => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string') : [];
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
        const servicesDetail = (catalogSource.services || []).map(item => {
          const details = [item.duration_minutes ? `${item.duration_minutes} min` : '', item.price_clp != null ? `$${Number(item.price_clp).toLocaleString('es-CL')}` : ''].filter(Boolean).join(', ');
          return details ? `${item.name} (${details})` : item.name;
        }).filter(Boolean).join('; ') || '(ninguno)';
        const tz = businessTimeZone;
        return `CATÁLOGO DE AGENDA (ofrece SÓLO esto; al llamar herramientas usa estos nombres exactos, sin la parte entre paréntesis). Servicios: ${servicesDetail}. Profesionales: ${names(catalogSource.resources)}.${(catalogSource.locations || []).length ? ` Sedes: ${names(catalogSource.locations)}.` : ''} Zona horaria del negocio: ${tz}. Las herramientas devuelven horarios en formato ISO/UTC: preséntaselos SIEMPRE al cliente en la hora local de ${tz}, nunca en UTC.`;
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
    let totalInputTokens = 0; let totalOutputTokens = 0;
    for (let round = 0; round < 4; round++) {
      const response = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
        body: JSON.stringify({ model: llm.model, temperature: 0.1, max_completion_tokens: 260, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) })
      });
      if (!response.ok) throw new Error(`Groq ${response.status}`);
      const data = await response.json();
      totalInputTokens += Number(data.usage?.prompt_tokens) || 0;
      totalOutputTokens += Number(data.usage?.completion_tokens) || 0;
      const assistantMessage = data.choices?.[0]?.message;
      if (!assistantMessage) throw new Error('Groq no devolvió contenido');
      const calls = assistantMessage.tool_calls || [];
      if (!calls.length) {
        const rawText = String(assistantMessage.content || '').trim();
        const validation = validateMutationClaims(rawText, toolTrace);
        const text = validation.text;
        if (!text) throw new Error('Groq devolvió una respuesta vacía');
        const handoff = toolTrace.some(item => item.name === 'request_human_handoff' && item.result?.ok) || text.toLowerCase().includes('no tengo ese dato confirmado');
        return { text, confidence: validation.ok ? 'model_from_confirmed_context' : 'safety_blocked', source: selectedFacts.map(fact => fact.subject), handoff, provider: llm.provider, model: llm.model, usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens }, toolTrace, safetyBlocked: validation.ok ? null : validation.blockedTool };
      }
      messages.push({ role: 'assistant', content: assistantMessage.content || null, tool_calls: calls });
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
        const result = await executeAgendaTool(packageData, call.function?.name, args, context);
        toolTrace.push({ name: call.function?.name, result });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error('El agente excedió el límite de pasos de herramientas.');
  } catch (error) {
    if (!allowDeterministicFallback) throw error;
    console.warn('LLM no disponible en preview; se usa respuesta determinista:', error.message);
    return { ...fallback, provider: 'deterministic_fallback', usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
