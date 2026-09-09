import { agendaConfig, agendaSupabaseRequest, agendaUsesSupabase, getAgendaDashboard, getAvailableSlots, createAgendaAppointment, updateAgendaAppointment, rescheduleAgendaAppointment, findRiskWindow, isActiveAgendaAppointment, asIso } from './agenda.js';
import { updateCustomerIntakeRecord } from './customer-records.js';

// Match de catálogo tolerante: el LLM puede pasar el nombre con otra capitalización o sin tildes.
// La relevancia no debe depender de coincidencia textual exacta.
const normName = value => String(value || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const findByName = (list, name) => (list || []).find(item => normName(item.name) === normName(name));
// Si no hay match exacto (el modelo escribió "evaluación" en vez de "Evaluación · Box Buin"),
// intenta un match parcial ANTES de rendirse. Si calza con un solo item, se resuelve solo — es
// justo el caso más común y lo que antes fallaba siempre al primer intento (ver AGENDA_BEHAVIOR /
// el enum de getAgendaToolDefinitions, que reduce esto todavía más). Si calza con más de uno
// ("evaluación" sin decir sede, y hay evaluación en 2 sedes), es ambigüedad real del cliente, no
// del matching — no se elige por él, se marca `ambiguous` para que el modelo pregunte.
function resolveCatalogItem(list, name) {
  const exact = findByName(list, name);
  if (exact) return { item: exact };
  const query = normName(name);
  if (!query) return { item: null };
  const candidates = (list || []).filter(item => normName(item.name).includes(query));
  if (candidates.length === 1) return { item: candidates[0] };
  if (candidates.length > 1) return { item: null, ambiguous: candidates };
  return { item: null };
}
const normalizePhone = value => String(value || '').replace(/\D/g, '');
const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
const samePhone = (a, b) => {
  const left = normalizePhone(a); const right = normalizePhone(b);
  return left.length >= 8 && right.length >= 8 && left === right;
};

// El 2do parámetro (catálogo LIVE, mismo que ejecuta las herramientas) es opcional — sin él, se
// comporta como antes (sólo `type: 'string'`, sin enum). Con él, service/resource/location quedan
// acotados a los nombres reales, así el modelo elige de una lista real en vez de escribir el
// nombre libre y fallar contra el match exacto/parcial de resolveCatalogItem.
export function getAgendaToolDefinitions(packageData, catalog) {
  if (!agendaConfig(packageData)) return [];
  const namesOf = list => (list || []).map(item => item.name).filter(Boolean);
  const withEnum = (schema, names) => (names.length ? { ...schema, enum: names } : schema);
  const serviceSchema = withEnum({ type: 'string' }, namesOf(catalog?.services));
  const resourceSchema = withEnum({ type: 'string' }, namesOf(catalog?.resources));
  const locationSchema = withEnum({ type: 'string' }, namesOf(catalog?.locations));
  return [
    { type: 'function', function: { name: 'get_availability', description: 'Consulta los horarios realmente disponibles. Úsala SIEMPRE que pregunten por horarios, disponibilidad o cupos, incluidas preguntas de sí/no como "¿tienen hora?" o "¿hay cupo?". Nunca inventes horarios ni respondas disponibilidad sin llamarla. Para saber si hay hora sólo hace falta la SEDE (Box Buin o domicilio) — el servicio exacto (evaluación, sesión respiratoria) casi no cambia la duración real y es una pregunta posterior, no un requisito para buscar hora; pásalo sólo si el cliente ya lo dijo espontáneamente.', parameters: { type: 'object', properties: { location: { type: 'string', description: 'Sede pedida por el cliente.', enum: ['Box Buin', 'Domicilio'] }, service: serviceSchema, resource: resourceSchema, date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['location', 'resource', 'date'] } } },
    { type: 'function', function: { name: 'get_my_appointment', description: 'Consulta las reservas activas del cliente que escribe. Requiere identidad verificada por canal.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'create_appointment', description: 'Crea la reserva apenas tengas los datos requeridos (nombre, servicio, profesional, horario) y el cliente haya confirmado que quiere agendar ese horario. Al pedir los datos pídelos TODOS en la misma frase: nombre y apellido, RUT y correo (ej. "para dejarte tomada la hora necesito tu nombre y apellido, tu RUT para la boleta y un correo, así te llega la invitación al calendario"). Pregúntalo UNA sola vez: si el cliente no los da o responde sin alguno, AGENDA IGUAL con lo que tengas y menciona al confirmar qué dato quedó pendiente para la boleta — nunca retengas la hora esperando el RUT ni vuelvas a insistir. Salvo el nombre, ninguno de esos datos bloquea la reserva. Si la respuesta trae ask_intake_details:true, sigue el texto de intake_prompt para pedir esos datos opcionales DESPUÉS, en el mismo mensaje donde confirmas que la hora quedó agendada — nunca antes de crear la reserva. Si la respuesta trae action:"needs_manual_confirmation", NO digas que la reserva quedó agendada: sigue el mensaje que te devuelve la herramienta (el profesional debe confirmar esa hora en particular manualmente).', parameters: { type: 'object', properties: { customer_name: { type: 'string' }, email: { type: 'string', description: 'Correo del cliente, si lo dio.' }, rut: { type: 'string', description: 'RUT del cliente, si lo dio (se pide para emitir la boleta).' }, address: { type: 'string', description: 'Dirección de atención (calle, número, comuna) — obligatoria si el servicio es a domicilio.' }, age: { type: 'integer', description: 'Edad del cliente, si la dio.' }, occupation: { type: 'string', description: 'Ocupación del cliente, si la dio.' }, medical_history: { type: 'string', description: 'Antecedentes médicos importantes (lesiones, cirugías, medicamentos), si los dio.' }, extra_symptoms: { type: 'string', description: 'Otros síntomas además del motivo principal, si los dio.' }, service: serviceSchema, resource: resourceSchema, location: locationSchema, starts_at: { type: 'string', description: 'ISO 8601' }, notes: { type: 'string' } }, required: ['customer_name', 'service', 'resource', 'starts_at'] } } },
    { type: 'function', function: { name: 'update_customer_profile', description: 'Guarda correo, RUT, edad, ocupación, antecedentes médicos u otros síntomas que el cliente entrega para su ficha — típicamente respondiendo al pedido de "dejar la ficha lista" después de agendar. Es SÓLO para guardar esos datos, nunca implica crear, cambiar ni revisar ninguna reserva: no llames get_availability ni create_appointment en el mismo turno sólo porque el cliente mandó estos datos. Sólo funciona si el cliente ya agendó al menos una vez con este teléfono. Llámala apenas entregue alguno de estos datos, no esperes a tener todos.', parameters: { type: 'object', properties: { email: { type: 'string' }, rut: { type: 'string' }, age: { type: 'integer' }, occupation: { type: 'string' }, medical_history: { type: 'string' }, extra_symptoms: { type: 'string' } } } } },
    { type: 'function', function: { name: 'cancel_appointment', description: 'Cancela una reserva del mismo cliente verificado. No usar para una reserva de otra persona.', parameters: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] } } },
    { type: 'function', function: { name: 'reschedule_appointment', description: 'Reagenda una reserva del mismo cliente después de que eligió fecha/hora. Verifica disponibilidad y cambia atómicamente.', parameters: { type: 'object', properties: { reference: { type: 'string' }, new_starts_at: { type: 'string', description: 'ISO 8601' } }, required: ['reference', 'new_starts_at'] } } },
    ...(literalReplies(packageData).length ? [{ type: 'function', function: { name: 'responder_textual', description: `Envía una respuesta oficial del negocio TAL CUAL fue escrita por el dueño. Úsala SIEMPRE que el mensaje del cliente caiga en uno de estos casos, en vez de redactar tú la respuesta:
${literalReplies(packageData).map(item => `- "${item.id}": ${item.when}`).join('\n')}
El texto se manda literal y completo; tú no lo reescribes, no lo resumes y no le agregas nada antes ni después.`, parameters: { type: 'object', properties: { id: { type: 'string', enum: literalReplies(packageData).map(item => item.id), description: 'Cuál de las respuestas oficiales corresponde.' } }, required: ['id'] } } }] : []),
    { type: 'function', function: { name: 'request_human_handoff', description: 'Escala a una persona cuando el cliente lo pide, hay un problema real o falta un dato crítico. Ejecutar en el mismo turno que se anuncia el traspaso.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } }
  ];
}

// El modelo alucina la cola de una lista larga de horas: con 18-23 horas devueltas por la
// herramienta, gpt-4o-mini seguía la serie regular más allá del último dato real y ofrecía horas
// fuera del horario de atención (medido 3/3 en franciskom: ofrecía hasta las 22:00 atendiendo
// hasta las 20:00); con listas cortas responde exacto. Por eso la herramienta entrega una
// preselección breve y repartida a lo largo del día en vez del bloque completo — la lista real
// sigue disponible en available_slots para validar la hora que pida el cliente.
const MAX_SLOTS_TO_OFFER = 6;

function pickSlotShortlist(slots) {
  if (slots.length <= MAX_SLOTS_TO_OFFER) return slots;
  const step = (slots.length - 1) / (MAX_SLOTS_TO_OFFER - 1);
  const picked = [];
  for (let i = 0; i < MAX_SLOTS_TO_OFFER; i += 1) {
    const slot = slots[Math.round(i * step)];
    if (slot && !picked.includes(slot)) picked.push(slot);
  }
  return picked;
}

// Respuestas que el dueño quiere que salgan PALABRA POR PALABRA: precios oficiales, qué incluye
// cada servicio, promociones. Pedirle al modelo que "copie textual" no basta — antes o después
// parafrasea, se come un emoji o reordena una línea, y ahí ya no es el texto del negocio. Por eso
// el modelo sólo elige CUÁL corresponde (que es lo que sabe hacer) y el runtime devuelve el texto
// exacto sin dejarlo redactar: ver el corte en engine.js.
export function literalReplies(packageData) {
  const list = packageData?.agent?.literal_replies || [];
  return list.filter(item => item?.id && item?.text);
}

async function dashboardOrError(packageData) {
  // En producción usa Supabase; en preview local usa el estado local para poder ejercitar la tool.
  return getAgendaDashboard(packageData);
}

// La RPC de Supabase necesita una conversación real (za_conversations.id) para marcarla en handoff
// y encolar el outbox. El chat de prueba ("Probar" en /m, playground del dueño) nunca crea esa
// fila — sólo pasa una etiqueta de prueba como conversationId — así que ahí no corresponde llamar
// la RPC aunque Supabase esté conectado: se trata como preview, y quien registra el ticket en la
// Bandeja es el llamador (server.js), no esta función.
async function requestHandoff(reason, context) {
  if (agendaUsesSupabase() && isUuid(context.conversationId)) {
    const result = await agendaSupabaseRequest('/rest/v1/rpc/za_request_handoff', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ p_conversation_id: context.conversationId, p_reason: String(reason || '').slice(0, 800), p_caller_phone: normalizePhone(context.callerPhone), p_operation_key: context.operationKey ? `${String(context.operationKey).slice(0, 200)}:handoff-outbox` : null }) });
    const handoff = Array.isArray(result) ? result[0] : result;
    return { ok: true, action: 'handoff_requested', event_id: handoff?.event_id || null };
  }
  return { ok: true, action: 'handoff_requested', event_id: null, preview: true };
}

function ownerAppointment(dashboard, reference, callerPhone) {
  if (!callerPhone) return { error: 'identity_required', message: 'No hay teléfono verificado para consultar o modificar la reserva.' };
  const appointment = dashboard.appointments.find(item => String(item.reference || '').toUpperCase() === String(reference || '').trim().toUpperCase());
  if (!appointment) return { error: 'not_found', message: 'No encontré esa reserva.' };
  if (!samePhone(appointment.customer_phone, callerPhone)) return { error: 'ownership_not_verified', message: 'No puedo modificar una reserva sin verificar que pertenece a este número.' };
  return { appointment };
}

export async function executeAgendaTool(packageData, name, args = {}, context = {}) {
  try {
    const config = agendaConfig(packageData);
    if (!config) return { error: 'agenda_disabled' };
    const dashboard = await dashboardOrError(packageData);
    if (dashboard.error) return dashboard;
    if (name === 'get_availability') {
      const resourceMatch = resolveCatalogItem(dashboard.catalog.resources, args.resource);
      if (resourceMatch.ambiguous) return { error: 'ambiguous_resource', message: 'Más de un profesional calza con lo que pidió el cliente — pregúntale cuál de estas opciones exactas quiere, nunca elijas tú.', options: resourceMatch.ambiguous.map(item => item.name) };
      const resource = resourceMatch.item;
      if (!resource) return { error: 'catalog_not_found', message: 'Ese profesional no está en el catálogo. Ofrece sólo los disponibles.', available_resources: dashboard.catalog.resources.map(item => item.name) };
      let service = null;
      if (args.service) {
        const serviceMatch = resolveCatalogItem(dashboard.catalog.services, args.service);
        if (serviceMatch.ambiguous) return { error: 'ambiguous_service', message: 'Más de un servicio calza con lo que pidió el cliente — pregúntale cuál de estas opciones exactas quiere, nunca elijas tú.', options: serviceMatch.ambiguous.map(item => item.name) };
        service = serviceMatch.item;
      }
      if (!service && args.location) {
        // Sin servicio exacto, sólo sede: elige el servicio agendable de esa sede con MAYOR
        // duración (nunca ofrece un horario que le quede corto al servicio real que se termine
        // pidiendo — la diferencia entre servicios de una misma sede es de minutos, no cambia si
        // hay o no bloque libre). Confirmado con Daniel: lo único que realmente cambia la
        // viabilidad del horario es la sede (el traslado a domicilio necesita más bloque).
        const query = normName(args.location);
        const candidates = (dashboard.catalog.services || [])
          .filter(item => item.bookable !== false)
          .filter(item => normName(item.name).includes(query))
          .filter(item => (resource.services || []).some(n => normName(n) === normName(item.name)));
        service = candidates.sort((a, b) => (Number(b.duration_minutes) || 0) - (Number(a.duration_minutes) || 0))[0] || null;
      }
      // La sede que pidió el cliente puede existir pero no agendarse por este canal (la administra
      // un tercero). Antes se caía en "catalog_not_found", un error pensado para cuando falta el
      // dato — y el modelo, al recibirlo, seguía pidiéndole el servicio al cliente como si la hora
      // fuera posible, hasta dejarlo en un callejón sin salida. Si TODOS los servicios de esa sede
      // están marcados no agendables, la sede tampoco lo es: se dice de frente y se lo redirige.
      if (!service && args.location) {
        const query = normName(args.location);
        const inLocation = (dashboard.catalog.services || []).filter(item => normName(item.name).includes(query));
        if (inLocation.length && inLocation.every(item => item.bookable === false)) {
          const note = inLocation.find(item => item.redirect_note)?.redirect_note;
          return { ok: true, action: 'not_bookable_here', message: `${note || 'Esa sede no se agenda por este canal.'} Dile al cliente que esa hora la tiene que coordinar directamente con ese centro, y ofrécele agendar en las sedes que sí maneja Francisco.` };
        }
      }
      if (!service) return { error: 'catalog_not_found', message: 'Indica la sede (Box Buin o domicilio) para poder buscar hora, o el nombre exacto del servicio si el cliente ya lo dijo.', available_services: dashboard.catalog.services.map(item => item.name) };
      // Servicio marcado `bookable:false`: no lo maneja este negocio (ej. atención en un centro
      // de terceros) — no tiene sentido mostrar "disponibilidad" propia para algo que no se agenda acá.
      if (service.bookable === false) return { ok: true, action: 'not_bookable_here', message: service.redirect_note || `"${service.name}" no se agenda por este canal — indícale al cliente que coordine directamente con ese lugar.` };
      // La RPC de reserva (za_request_appointment) sí valida que el recurso realmente haga este
      // servicio (za_resource_services), pero get_availability no lo comprobaba — podía mostrar un
      // día completo de horarios "disponibles" para un profesional que ni siquiera ofrece ese
      // servicio, y recién fallar al intentar reservar. Sólo importa para negocios con más de un
      // profesional con servicios distintos (franciskom tiene uno solo que hace los tres).
      if (!(resource.services || []).some(name => normName(name) === normName(service.name))) {
        return { error: 'service_not_offered_by_resource', message: `"${resource.name}" no ofrece "${service.name}". Ofrece sólo servicios que ese profesional realmente hace.`, resource_services: resource.services || [] };
      }
      const slots = await getAvailableSlots(packageData, { service: service.name, resource: resource.name, date: args.date });
      const tz = config.timezone || 'America/Santiago';
      const hourFmt = new Intl.DateTimeFormat('es-CL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
      const availableSlots = slots.map(iso => ({ at: iso, hora_local: hourFmt.format(new Date(iso)) }));
      const shortlist = pickSlotShortlist(availableSlots);
      return {
        ok: true, service: service.name, resource: resource.name, date: args.date, timezone: tz,
        available_slots: availableSlots,
        total_disponibles: availableSlots.length,
        ofrecer_primero: shortlist.map(slot => slot.hora_local),
        nota: availableSlots.length > shortlist.length
          ? `TODAS las horas libres de ese día son las de "available_slots" (${availableSlots.length} en total, de ${availableSlots[0].hora_local} a ${availableSlots[availableSlots.length - 1].hora_local}). En tu mensaje ofrece sólo las de "ofrecer_primero" para no abrumar, y dile que hay más horas si ninguna le acomoda. Si el cliente pide otra hora, búscala en "available_slots": si está ahí, está libre y la agendas sin decir que no hay. Nunca ofrezcas una hora que no esté en "available_slots".`
          : 'Estas son todas las horas libres del día: ofrécelas tal cual, sin agregar ninguna más.'
      };
    }
    if (name === 'get_my_appointment') {
      if (!context.callerPhone) return { error: 'identity_required', message: 'No hay teléfono verificado para esta conversación.' };
      const appointments = dashboard.appointments.filter(item => isActiveAgendaAppointment(item) && samePhone(item.customer_phone, context.callerPhone));
      const tz = config.timezone || 'America/Santiago';
      const whenFmt = new Intl.DateTimeFormat('es-CL', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
      return { ok: true, timezone: tz, appointments: appointments.map(item => ({ reference: item.reference, status: item.status, starts_at: item.starts_at, cuando_local: whenFmt.format(new Date(item.starts_at)), service: item.service, resource: item.resource, location: item.location })) };
    }
    if (name === 'update_customer_profile') {
      if (!context.callerPhone) return { error: 'identity_required', message: 'No hay teléfono verificado para esta conversación.' };
      try {
        await updateCustomerIntakeRecord(packageData, context.callerPhone, args, {
          source: 'whatsapp', sourceMessageId: context.messageId, operationKey: context.operationKey, createdBy: 'agent'
        });
        return { ok: true, action: 'profile_updated' };
      } catch (error) {
        return { error: 'profile_update_failed', message: error.message };
      }
    }
    if (name === 'create_appointment') {
      if (!context.callerPhone) return { error: 'identity_required', message: 'No puedo crear una reserva por WhatsApp sin el teléfono verificado del remitente.' };
      const serviceMatch = resolveCatalogItem(dashboard.catalog.services, args.service);
      const resourceMatch = resolveCatalogItem(dashboard.catalog.resources, args.resource);
      if (serviceMatch.ambiguous) return { error: 'ambiguous_service', message: 'Más de un servicio calza con lo que pidió el cliente — pregúntale cuál de estas opciones exactas quiere, nunca elijas tú.', options: serviceMatch.ambiguous.map(item => item.name) };
      if (resourceMatch.ambiguous) return { error: 'ambiguous_resource', message: 'Más de un profesional calza con lo que pidió el cliente — pregúntale cuál de estas opciones exactas quiere, nunca elijas tú.', options: resourceMatch.ambiguous.map(item => item.name) };
      const service = serviceMatch.item;
      const resource = resourceMatch.item;
      if (!service || !resource) return { error: 'catalog_not_found', message: 'Ese servicio o profesional no está en el catálogo. Ofrece sólo los disponibles.', available_services: dashboard.catalog.services.map(item => item.name), available_resources: dashboard.catalog.resources.map(item => item.name) };
      // Igual que en get_availability: un servicio no gestionado por este negocio nunca se agenda
      // ni deriva a handoff — se redirige directo, sin crear ningún rastro de reserva/ticket.
      if (service.bookable === false) return { ok: true, action: 'not_bookable_here', message: service.redirect_note || `"${service.name}" no se agenda por este canal — indícale al cliente que coordine directamente con ese lugar.` };
      // Un reintento de la misma operación debe ser idempotente, pero un cliente sí puede reservar
      // varias sesiones futuras del mismo servicio. Sólo se deduplica la cita exacta.
      const requestedIso = asIso(args.starts_at, config.timezone || 'America/Santiago');
      const location = findByName(dashboard.catalog.locations, args.location);
      // Validar que la hora pedida sea futura y cumpla el aviso mínimo ANTES de mirar franjas de
      // riesgo: findRiskWindow sólo compara día-de-semana + hora, así que una fecha pasada que cae
      // en un día "riesgoso" (ej. un lunes que ya pasó) se colaba directo a needs_manual_confirmation
      // sin pasar nunca por el guard real de fecha pasada que sí tiene createAgendaAppointment más
      // abajo — se creaba un ticket de handoff para una hora que ya ocurrió.
      const requestedTime = new Date(requestedIso || '').getTime();
      if (!Number.isFinite(requestedTime)) return { error: 'invalid_starts_at', message: 'La hora solicitada no es una fecha válida.' };
      if (requestedTime < Date.now()) return { error: 'starts_at_in_past', message: 'Esa fecha/hora ya pasó. Pide una fecha futura y vuelve a intentar.' };
      const minimumNoticeMs = Number(config.rules?.minimum_notice_hours || 0) * 3_600_000;
      if (requestedTime - Date.now() < minimumNoticeMs) return { error: 'minimum_notice_not_met', message: `Esa hora está demasiado próxima — se necesitan al menos ${config.rules?.minimum_notice_hours || 0} horas de aviso. Ofrece un horario más adelante.` };
      const maximumAdvanceMs = Number(config.rules?.maximum_advance_days || 730) * 86_400_000;
      if (requestedTime - Date.now() > maximumAdvanceMs) return { error: 'maximum_advance_exceeded', message: `Esa hora supera la anticipación máxima de ${config.rules?.maximum_advance_days || 730} días. Ofrece una fecha más cercana.` };
      const existing = (dashboard.appointments || []).find(item => isActiveAgendaAppointment(item)
        && samePhone(item.customer_phone, context.callerPhone)
        && normName(item.service) === normName(service.name)
        && normName(item.resource) === normName(resource.name)
        && new Date(item.starts_at).getTime() === requestedTime);
      if (existing) {
        const existingTz = config.timezone || 'America/Santiago';
        const existingWhen = new Intl.DateTimeFormat('es-CL', { timeZone: existingTz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(existing.starts_at));
        return { ok: true, action: 'already_has_exact_appointment', appointment: { reference: existing.reference, starts_at: existing.starts_at, cuando_local: existingWhen, status: existing.status }, message: `Esa cita exacta ya existe (${existingWhen}, ref. ${existing.reference}). No se creó un duplicado.` };
      }
      // Franja de riesgo: el profesional podría estar comprometido en otro lugar a esa hora (no
      // siempre, depende de un tercero), así que no se agenda solo — se deriva para que confirme.
      const riskWindow = findRiskWindow(packageData, resource.name, requestedIso);
      if (riskWindow) {
        const handoffReason = `Cliente ${context.callerPhone || ''} pidió agendar "${service.name}" el ${new Date(requestedIso).toLocaleString('es-CL')} — cae en franja de riesgo (${riskWindow.reason || 'posible compromiso en otro lugar'}). Confirma disponibilidad real y agenda manualmente.`;
        const handoff = await requestHandoff(handoffReason, context);
        // Sugerencia de respaldo: buscar una hora libre ESE MISMO día en otro servicio que el
        // mismo profesional sí controla del todo (no cae en ninguna franja de riesgo), para que
        // el cliente no se quede sin ninguna opción mientras espera la confirmación.
        const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone || 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(requestedIso));
        let alternative = null;
        for (const altServiceName of resource.services || []) {
          if (altServiceName === service.name) continue;
          // Nunca ofrecer como "alternativa segura" un servicio que tampoco se agenda por este canal.
          const altService = findByName(dashboard.catalog.services, altServiceName);
          if (altService?.bookable === false) continue;
          const slots = await getAvailableSlots(packageData, { service: altServiceName, resource: resource.name, date: sameDay }).catch(() => []);
          const safeSlot = slots.find(iso => !findRiskWindow(packageData, resource.name, iso));
          if (safeSlot) { alternative = { service: altServiceName, starts_at: safeSlot }; break; }
        }
        const tz = config.timezone || 'America/Santiago';
        const alternativeText = alternative
          ? ` Como respaldo, hoy mismo hay hora libre a las ${new Intl.DateTimeFormat('es-CL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(alternative.starts_at))} para "${alternative.service}" — ofrécesela como alternativa segura si el cliente prefiere no esperar la confirmación.`
          : '';
        return { ...handoff, action: 'needs_manual_confirmation', message: `Explícale al cliente que ese horario necesita verificación manual (${riskWindow.reason || 'depende de una condición externa'}) y que el equipo retomará la conversación para avisar si queda disponible. No confirmes la reserva tú mismo.${alternativeText}` };
      }
      // Reusa createAgendaAppointment (ya cubre local/Supabase y el bump de segmento del
      // cliente) en vez de duplicar la llamada RPC — antes esta rama saltaba ese bump.
      const appointment = await createAgendaAppointment(packageData, {
        customer_name: String(args.customer_name || '').trim(), customer_phone: context.callerPhone, customer_email: String(args.email || '').trim(),
        customer_rut: String(args.rut || '').trim(), customer_address: String(args.address || '').trim(),
        customer_age: args.age, customer_occupation: String(args.occupation || '').trim(),
        customer_medical_history: String(args.medical_history || '').trim(), customer_extra_symptoms: String(args.extra_symptoms || '').trim(),
        service: service.name, resource: resource.name, location: location?.name || '', starts_at: requestedIso, notes: String(args.notes || '').trim()
      }, 'whatsapp');
      // La ficha es opcional por diseño y va DESPUÉS de que la reserva ya existe: si falla, la
      // hora igual quedó tomada, así que nunca puede propagar su error hacia arriba. Sin este
      // catch, un problema de ficha (cliente que no calza, migración no aplicada en el Supabase
      // del cliente) hacía que la herramienta completa se reportara como fallida y el agente le
      // dijera al paciente "no hice cambios en tu reserva" con la cita ya creada y el bloque
      // ocupado — el peor desenlace posible: el paciente cree que no tiene hora y nadie lo sabe.
      if (args.email || args.rut || args.age != null || args.occupation || args.medical_history || args.extra_symptoms) {
        try {
          await updateCustomerIntakeRecord(packageData, context.callerPhone, args, {
            source: 'whatsapp', sourceMessageId: context.messageId,
            operationKey: context.operationKey ? `${context.operationKey}:appointment-intake` : `appointment:${appointment.id || appointment.reference}`,
            createdBy: 'agent'
          });
        } catch (error) {
          console.error('[agenda] la reserva se creó pero no se pudo guardar la ficha del cliente:', error.message);
        }
      }
      const createdTz = config.timezone || 'America/Santiago';
      const createdWhen = new Intl.DateTimeFormat('es-CL', { timeZone: createdTz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(appointment.starts_at));
      // Los datos de ficha (correo/edad/ocupación/antecedentes/síntomas) son opcionales y NUNCA
      // deben bloquear la creación de la reserva. Se piden DESPUÉS de que la herramienta ya tuvo
      // éxito (acá, con un hint), nunca antes — pedirlos como precondición en el mismo turno que
      // la confirmación hacía que el modelo esperara la respuesta en vez de agendar (medido con
      // gpt-4o-mini: se quedaba pidiendo estos datos indefinidamente y nunca llamaba la herramienta,
      // incluso con el cliente diciendo explícitamente "agéndala ya").
      const intakeMissing = !args.email && !args.rut && args.age == null && !args.occupation && !args.medical_history && !args.extra_symptoms;
      return { ok: true, action: 'created', appointment: { reference: appointment.reference, starts_at: appointment.starts_at, cuando_local: createdWhen, status: appointment.status }, ...(intakeMissing ? { ask_intake_details: true, intake_prompt: 'La reserva ya quedó creada. Ahora, en este mismo mensaje donde confirmas la hora, aprovecha de decir algo como "aprovechemos de dejar tu ficha lista" y pedir en un solo bloque: correo, RUT (se usa para la boleta), edad, ocupación, antecedentes médicos importantes (lesiones, cirugías, medicamentos) y otros síntomas además del motivo principal. Es sólo para la ficha, no vuelvas a preguntar si no responde. Cuando el cliente conteste (en este turno o en uno posterior), guarda lo que haya dado llamando update_customer_profile — no basta con agradecer en el texto, si no se llama la herramienta se pierde.' } : {}) };
    }
    if (name === 'cancel_appointment') {
      const owned = ownerAppointment(dashboard, args.reference, context.callerPhone); if (owned.error) return owned;
      if (!isActiveAgendaAppointment(owned.appointment)) return { error: 'invalid_status', message: 'Esa reserva ya no se puede cancelar.' };
      await updateAgendaAppointment(packageData, owned.appointment.id, 'cancelled');
      return { ok: true, action: 'cancelled', reference: owned.appointment.reference };
    }
    if (name === 'reschedule_appointment') {
      const owned = ownerAppointment(dashboard, args.reference, context.callerPhone); if (owned.error) return owned;
      if (!isActiveAgendaAppointment(owned.appointment)) return { error: 'invalid_status', message: 'Esa reserva ya no se puede reagendar.' };
      const appointment = await rescheduleAgendaAppointment(packageData, { id: owned.appointment.id, new_starts_at: args.new_starts_at, requester_phone: context.callerPhone });
      const riskHandoff = appointment.risk_window
        ? await requestHandoff(`La reagenda ${appointment.reference || owned.appointment.reference} al ${appointment.starts_at} requiere confirmar disponibilidad humana: ${appointment.risk_window.reason || 'franja de riesgo configurada'}.`, context)
        : null;
      const rescheduledTz = config.timezone || 'America/Santiago';
      const rescheduledWhen = new Intl.DateTimeFormat('es-CL', { timeZone: rescheduledTz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(appointment.starts_at));
      return {
        ok: true,
        action: appointment.risk_window ? 'rescheduled_needs_manual_confirmation' : 'rescheduled',
        reference: appointment.reference || owned.appointment.reference,
        starts_at: appointment.starts_at,
        cuando_local: rescheduledWhen,
        status: appointment.status,
        ...(riskHandoff?.event_id ? { event_id: riskHandoff.event_id } : {}),
        ...(appointment.risk_window ? { message: 'La nueva hora quedó pendiente de confirmación humana porque cae en una franja de riesgo.' } : {})
      };
    }
    if (name === 'request_human_handoff') {
      return requestHandoff(args.reason, context);
    }
    return { error: 'unknown_tool' };
  } catch (error) {
    return { error: 'tool_failed', message: error.message };
  }
}
