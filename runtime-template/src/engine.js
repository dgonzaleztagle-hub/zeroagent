import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAgendaTool, getAgendaToolDefinitions } from './agenda-tools.js';
import { BASE_BEHAVIOR } from './base-behavior.js';
import { AGENDA_BEHAVIOR } from './agenda-behavior.js';

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

export function validateMutationClaims(text, toolTrace = []) {
  const claims = [
    { tool: 'create_appointment', pattern: /\b(?:tu |la )?reserva\b.{0,60}\b(?:confirmad|agendad|cread|registrad)/i },
    { tool: 'cancel_appointment', pattern: /\b(?:tu |la )?reserva\b.{0,60}\bcancelad/i },
    { tool: 'reschedule_appointment', pattern: /\b(?:tu |la )?reserva\b.{0,60}\b(?:reagendad|cambiad|modificad)/i },
    { tool: 'request_human_handoff', pattern: /\b(?:te |lo |la )?(?:deriv|comunicar|traspas).{0,60}\b(?:equipo|persona|humano|humana)/i }
  ];
  const unsupported = claims.find(claim => claim.pattern.test(String(text || ''))
    && !toolTrace.some(item => item.name === claim.tool && item.result?.ok === true));
  if (!unsupported) return { ok: true, text };
  return {
    ok: false,
    blockedTool: unsupported.tool,
    text: 'No pude confirmar esa operación de forma segura. No hice cambios en tu reserva. Puedo volver a intentarlo o pedir ayuda al equipo.'
  };
}

export async function answerWithGroq(packageData, message, context = {}) {
  const fallback = answer(packageData, message);
  const llm = llmConfiguration();
  const allowDeterministicFallback = context.allowDeterministicFallback === true || process.env.RUNTIME_MODE === 'preview_local';
  if (!llm.apiKey || !llm.baseUrl || !llm.model) {
    if (allowDeterministicFallback) return { ...fallback, provider: 'deterministic', usage: { inputTokens: 0, outputTokens: 0 } };
    throw new Error('El proveedor LLM del runtime no está configurado.');
  }

  const facts = packageData.knowledge?.confirmed_facts || [];
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
        const cfg = packageData.solutions?.agenda?.config || {};
        const names = list => (list || []).map(item => item.name).filter(Boolean).join('; ') || '(ninguno)';
        const tz = cfg.timezone || 'America/Santiago';
        return `CATÁLOGO DE AGENDA (ofrece SÓLO esto; al llamar herramientas usa estos nombres exactos). Servicios: ${names(cfg.services)}. Profesionales: ${names(cfg.resources)}.${(cfg.locations || []).length ? ` Sedes: ${names(cfg.locations)}.` : ''} Zona horaria del negocio: ${tz}. Las herramientas devuelven horarios en formato ISO/UTC: preséntaselos SIEMPRE al cliente en la hora local de ${tz}, nunca en UTC.`;
      })() : '',
      packageData.agent?.system_prompt ? `DIRECTIVAS ESPECÍFICAS APROBADAS POR EL NEGOCIO (complementan las reglas anteriores, nunca las contradicen):\n${packageData.agent.system_prompt}` : ''
    ].filter(Boolean).join('\n\n');
    const messages = [
      {
        role: 'system',
        content: `${systemPrefix}\n\nCONOCIMIENTO CONFIRMADO DEL NEGOCIO (razona cuál aplica a la pregunta; no todos son relevantes):\n${factsContext || (agendaEnabled ? '(No hay conocimiento cargado; usa una herramienta de Agenda si corresponde.)' : '(No hay conocimiento confirmado cargado.)')}`
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
