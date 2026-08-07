import { agendaConfig, agendaSupabaseRequest, agendaUsesSupabase, getAgendaDashboard, getAvailableSlots, createAgendaAppointment, updateAgendaAppointment, rescheduleAgendaAppointment } from './agenda.js';

const activeStatuses = new Set(['pending_confirmation', 'confirmed']);
// Match de catálogo tolerante: el LLM puede pasar el nombre con otra capitalización o sin tildes.
// La relevancia no debe depender de coincidencia textual exacta.
const normName = value => String(value || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const findByName = (list, name) => (list || []).find(item => normName(item.name) === normName(name));
const normalizePhone = value => String(value || '').replace(/\D/g, '');
const samePhone = (a, b) => {
  const left = normalizePhone(a); const right = normalizePhone(b);
  return left.length >= 8 && right.length >= 8 && left === right;
};

export function getAgendaToolDefinitions(packageData) {
  if (!agendaConfig(packageData)) return [];
  return [
    { type: 'function', function: { name: 'get_availability', description: 'Consulta los horarios realmente disponibles. Úsala SIEMPRE que pregunten por horarios, disponibilidad o cupos, incluidas preguntas de sí/no como "¿tienen hora?" o "¿hay cupo?". Nunca inventes horarios ni respondas disponibilidad sin llamarla.', parameters: { type: 'object', properties: { service: { type: 'string' }, resource: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['service', 'resource', 'date'] } } },
    { type: 'function', function: { name: 'get_my_appointment', description: 'Consulta las reservas activas del cliente que escribe. Requiere identidad verificada por canal.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'create_appointment', description: 'Crea una solicitud de reserva sólo con datos completos y un horario elegido explícitamente.', parameters: { type: 'object', properties: { customer_name: { type: 'string' }, service: { type: 'string' }, resource: { type: 'string' }, location: { type: 'string' }, starts_at: { type: 'string', description: 'ISO 8601' }, notes: { type: 'string' } }, required: ['customer_name', 'service', 'resource', 'starts_at'] } } },
    { type: 'function', function: { name: 'cancel_appointment', description: 'Cancela una reserva del mismo cliente verificado. No usar para una reserva de otra persona.', parameters: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] } } },
    { type: 'function', function: { name: 'reschedule_appointment', description: 'Reagenda una reserva del mismo cliente después de que eligió fecha/hora. Verifica disponibilidad y cambia atómicamente.', parameters: { type: 'object', properties: { reference: { type: 'string' }, new_starts_at: { type: 'string', description: 'ISO 8601' } }, required: ['reference', 'new_starts_at'] } } },
    { type: 'function', function: { name: 'request_human_handoff', description: 'Escala a una persona cuando el cliente lo pide, hay un problema real o falta un dato crítico. Ejecutar en el mismo turno que se anuncia el traspaso.', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } } }
  ];
}

async function dashboardOrError(packageData) {
  // En producción usa Supabase; en preview local usa el estado local para poder ejercitar la tool.
  return getAgendaDashboard(packageData);
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
      const service = findByName(dashboard.catalog.services, args.service);
      const resource = findByName(dashboard.catalog.resources, args.resource);
      if (!service || !resource) return { error: 'catalog_not_found', message: 'Ese servicio o profesional no está en el catálogo. Ofrece sólo los disponibles.', available_services: dashboard.catalog.services.map(item => item.name), available_resources: dashboard.catalog.resources.map(item => item.name) };
      const slots = await getAvailableSlots(packageData, { service: service.name, resource: resource.name, date: args.date });
      const tz = config.timezone || 'America/Santiago';
      const hourFmt = new Intl.DateTimeFormat('es-CL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
      return { ok: true, service: service.name, resource: resource.name, date: args.date, timezone: tz, available_slots: slots.map(iso => ({ at: iso, hora_local: hourFmt.format(new Date(iso)) })) };
    }
    if (name === 'get_my_appointment') {
      if (!context.callerPhone) return { error: 'identity_required', message: 'No hay teléfono verificado para esta conversación.' };
      const appointments = dashboard.appointments.filter(item => activeStatuses.has(item.status) && samePhone(item.customer_phone, context.callerPhone));
      const tz = config.timezone || 'America/Santiago';
      const whenFmt = new Intl.DateTimeFormat('es-CL', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
      return { ok: true, timezone: tz, appointments: appointments.map(item => ({ reference: item.reference, status: item.status, starts_at: item.starts_at, cuando_local: whenFmt.format(new Date(item.starts_at)), service: item.service, resource: item.resource, location: item.location })) };
    }
    if (name === 'create_appointment') {
      if (!context.callerPhone) return { error: 'identity_required', message: 'No puedo crear una reserva por WhatsApp sin el teléfono verificado del remitente.' };
      const service = findByName(dashboard.catalog.services, args.service);
      const resource = findByName(dashboard.catalog.resources, args.resource);
      if (!service || !resource) return { error: 'catalog_not_found', message: 'Ese servicio o profesional no está en el catálogo. Ofrece sólo los disponibles.', available_services: dashboard.catalog.services.map(item => item.name), available_resources: dashboard.catalog.resources.map(item => item.name) };
      const location = findByName(dashboard.catalog.locations, args.location);
      let appointment;
      if (agendaUsesSupabase()) {
        const result = await agendaSupabaseRequest('/rest/v1/rpc/za_request_appointment', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ p_customer_name: String(args.customer_name || '').trim(), p_customer_phone: context.callerPhone, p_service_id: service.id, p_resource_id: resource.id, p_starts_at: args.starts_at, p_source: 'whatsapp', p_location_id: location?.id || resource.location_id || null, p_notes: String(args.notes || '').trim(), p_confirmation_mode: config.confirmation_mode, p_minimum_notice_hours: Number(config.rules?.minimum_notice_hours || 0), p_maximum_advance_days: Number(config.rules?.maximum_advance_days || 730) }) });
        appointment = Array.isArray(result) ? result[0] : result;
      } else {
        appointment = await createAgendaAppointment(packageData, { customer_name: String(args.customer_name || '').trim(), customer_phone: context.callerPhone, service: service.name, resource: resource.name, location: location?.name || '', starts_at: args.starts_at, notes: String(args.notes || '').trim() }, 'whatsapp');
      }
      const createdTz = config.timezone || 'America/Santiago';
      const createdWhen = new Intl.DateTimeFormat('es-CL', { timeZone: createdTz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(appointment.starts_at));
      return { ok: true, action: 'created', appointment: { reference: appointment.reference, starts_at: appointment.starts_at, cuando_local: createdWhen, status: appointment.status } };
    }
    if (name === 'cancel_appointment') {
      const owned = ownerAppointment(dashboard, args.reference, context.callerPhone); if (owned.error) return owned;
      if (!activeStatuses.has(owned.appointment.status)) return { error: 'invalid_status', message: 'Esa reserva ya no se puede cancelar.' };
      if (agendaUsesSupabase()) {
        await agendaSupabaseRequest('/rest/v1/rpc/za_transition_appointment', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ p_appointment_id: owned.appointment.id, p_new_status: 'cancelled', p_expected_status: owned.appointment.status }) });
      } else {
        await updateAgendaAppointment(packageData, owned.appointment.id, 'cancelled');
      }
      return { ok: true, action: 'cancelled', reference: owned.appointment.reference };
    }
    if (name === 'reschedule_appointment') {
      const owned = ownerAppointment(dashboard, args.reference, context.callerPhone); if (owned.error) return owned;
      let appointment;
      if (agendaUsesSupabase()) {
        const result = await agendaSupabaseRequest('/rest/v1/rpc/za_reschedule_appointment', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ p_appointment_id: owned.appointment.id, p_new_starts_at: args.new_starts_at, p_requester_phone: context.callerPhone, p_minimum_notice_hours: Number(config.rules?.minimum_notice_hours || 0), p_maximum_advance_days: Number(config.rules?.maximum_advance_days || 730), p_confirmation_mode: config.confirmation_mode || 'manual' }) });
        appointment = Array.isArray(result) ? result[0] : result;
      } else {
        appointment = await rescheduleAgendaAppointment(packageData, { id: owned.appointment.id, new_starts_at: args.new_starts_at });
      }
      const rescheduledTz = config.timezone || 'America/Santiago';
      const rescheduledWhen = new Intl.DateTimeFormat('es-CL', { timeZone: rescheduledTz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(appointment.starts_at));
      return { ok: true, action: 'rescheduled', reference: appointment.reference || owned.appointment.reference, starts_at: appointment.starts_at, cuando_local: rescheduledWhen };
    }
    if (name === 'request_human_handoff') {
      if (agendaUsesSupabase()) {
        if (!context.conversationId) return { error: 'conversation_required', message: 'No puedo registrar el traspaso sin una conversación persistente.' };
        const result = await agendaSupabaseRequest('/rest/v1/rpc/za_request_handoff', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ p_conversation_id: context.conversationId, p_reason: String(args.reason || '').slice(0, 800), p_caller_phone: normalizePhone(context.callerPhone) }) });
        const handoff = Array.isArray(result) ? result[0] : result;
        return { ok: true, action: 'handoff_requested', event_id: handoff?.event_id || null };
      }
      // Preview local: se reconoce el traspaso sin persistir outbox (eso vive en Supabase del cliente).
      return { ok: true, action: 'handoff_requested', event_id: null, preview: true };
    }
    return { error: 'unknown_tool' };
  } catch (error) {
    return { error: 'tool_failed', message: error.message };
  }
}
