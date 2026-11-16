import assert from 'node:assert/strict';
import { answerTurn } from '../../src/engine.js';

// Banco reproducible: mismo coordinador y misma autorización, ningún endpoint externo.
// Los efectos se registran para comprobar lo que ocurrió, además del texto final.
export function createFrozenRuntime({ business = 'Taller Azul', owner = 'Camila', price = 25000 } = {}) {
  const service = { name: 'Sesión', duration_minutes: 60, price_clp: price, bookable: true, delivery_mode: 'onsite' };
  const catalog = { services: [service], resources: [{ name: owner, services: ['Sesión'] }], locations: [{ name: 'Sede Central' }] };
  const pkg = { business: { id: business, display_name: business }, agent: { name: 'Asistente', owner_name: owner },
    knowledge: { confirmed_facts: [{ id: 'f1', category: 'general', subject: 'Servicio', value: `La sesión cuesta $${price}.` }] },
    solutions: { agenda: { config: { enabled: true, timezone: 'America/Santiago', ...catalog } } } };
  const appointments = new Map(); const effects = []; const requests = [];
  let script = []; let toolFailure = null; let providerFailure = null;
  const services = {
    liveInjectedFacts: async () => [],
    getAgendaDashboard: async () => ({ catalog, appointments: [...appointments.values()] }),
    listUpcomingAppointmentsForPhone: async (_pkg, phone) => [...appointments.values()].filter(item => item.customer_phone === phone),
    routeTurn: async () => ({ route: 'reserva', reason: 'Clasificación guionada del banco.', usage: { input: 0, output: 0 } }),
    judgeConversationStage: async () => ({ stage: 'ofrecer', guidance: '', usage: { input: 0, output: 0 } }),
    auditDraftGrounding: async () => ({ unsupported: false, promisesNotice: false, usage: { input: 0, output: 0 } }),
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body); requests.push(request);
      assert.equal(request.model, 'gpt-6-luna');
      assert.equal(request.reasoning_effort, 'none');
      if (providerFailure) return Response.json({ error: providerFailure }, { status: 429 });
      assert.ok(script.length, 'El motor hizo una llamada no prevista; posible bucle.');
      const next = script.shift();
      return Response.json({ choices: [{ message: typeof next === 'string' ? { content: next } : next }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    },
    executeAgendaTool: async (_pkg, name, args, context) => {
      effects.push({ name, args: structuredClone(args), phone: context.callerPhone });
      if (toolFailure) return { ok: false, error: toolFailure };
      if (name === 'create_appointment') {
        const id = `${context.callerPhone}:${args.date}:${args.time}`;
        if (appointments.has(id)) return { ok: true, action: 'already_has_exact_appointment', appointment: appointments.get(id) };
        const appointment = { id, reference: `ZA-${appointments.size + 1}`, service: args.service, starts_at: `${args.date}T${args.time}:00-03:00`, customer_phone: context.callerPhone, status: 'confirmed' };
        appointments.set(id, appointment);
        return { ok: true, action: 'created', appointment };
      }
      if (name === 'cancel_appointment') {
        const match = [...appointments.values()].find(item => item.customer_phone === context.callerPhone && (!args.reference || item.reference === args.reference));
        if (!match) return { ok: false, error: 'not_found' };
        appointments.delete(match.id);
        return { ok: true, action: 'cancelled' };
      }
      if (name === 'avisar_al_dueno') return { ok: true, action: 'owner_alerted' };
      throw new Error(`Herramienta no prevista en el sandbox: ${name}`);
    }
  };
  return { pkg, catalog, appointments, effects, requests,
    failTool(error) { toolFailure = error; },
    failProvider(error) { providerFailure = error; },
    async turn(message, history, steps, phone = '+56900000001') {
      script = [...steps];
      const reply = await answerTurn(pkg, message, { history, callerPhone: phone, requireModel: true, now: '2026-11-16T15:00:00Z', services,
        llm: { provider: 'openai', apiKey: 'unused-offline', baseUrl: 'https://offline.invalid', model: 'gpt-6-luna' } });
      assert.equal(script.length, 0, 'Quedaron pasos del guion sin ejecutar.');
      return reply;
    }
  };
}

export const call = (name, args = {}) => ({ content: null, tool_calls: [{ id: 'test-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
