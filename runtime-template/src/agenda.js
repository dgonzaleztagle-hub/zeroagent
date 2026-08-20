import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { colorIdForLocation, createGoogleCalendarEvent, deleteGoogleCalendarEvent, getGoogleCalendarBusyIntervals, updateGoogleCalendarEventTime } from './google-calendar.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function statePathFor(packageData) {
  const scope = String(packageData.business?.id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(root, 'storage', `agenda-state-${scope}.json`);
}

function supabaseSettings() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return url && key ? { url, key } : null;
}

export function agendaUsesSupabase() {
  return Boolean(supabaseSettings());
}

export async function agendaSupabaseRequest(pathname, options = {}) {
  const settings = supabaseSettings();
  if (!settings) throw new Error('Supabase no está configurado en este runtime.');
  const response = await fetch(`${settings.url}${pathname}`, {
    ...options,
    headers: {
      apikey: settings.key,
      authorization: `Bearer ${settings.key}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(body || `Supabase respondió ${response.status}`);
  return body ? JSON.parse(body) : null;
}

// PostgREST trunca silenciosamente a max-rows (1000 en Supabase) sin devolver error — un cliente
// real con más de 1000 citas o contactos (franciskom ya pasó los 1000 al importar su agenda) pierde
// datos sin ningún aviso. Cualquier lista que pueda crecer sin techo real debe paginar con esto en
// vez de agendaSupabaseRequest directo.
export async function fetchAllAgendaRows(pathname) {
  const pageSize = 1000;
  let offset = 0;
  let all = [];
  while (true) {
    const separator = pathname.includes('?') ? '&' : '?';
    const page = await agendaSupabaseRequest(`${pathname}${separator}limit=${pageSize}&offset=${offset}`);
    all = all.concat(page || []);
    if (!page || page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

export async function agendaSupabaseUpload(storagePath, bytes, contentType = 'application/octet-stream') {
  const settings = supabaseSettings();
  if (!settings) throw new Error('Supabase no está configurado en este runtime.');
  const response = await fetch(`${settings.url}/storage/v1/object/zeroagent-onboarding/${storagePath}`, {
    method: 'POST',
    headers: { apikey: settings.key, authorization: `Bearer ${settings.key}`, 'content-type': contentType, 'x-upsert': 'false' },
    body: bytes
  });
  const body = await response.text();
  if (!response.ok) throw new Error(body || `Supabase Storage respondió ${response.status}`);
  return body ? JSON.parse(body) : { ok: true };
}

function cleanText(value, max = 180) {
  return String(value || '').trim().slice(0, max);
}

export function asIso(value, timeZone = 'America/Santiago') {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  // Con offset explícito (Z o +HH:MM/-HH:MM), como ya envían reserva-móvil/reagendamiento
  // desde el navegador: confiar en el parseo estándar, ya es un instante absoluto.
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  // Sin offset — el valor crudo de un <input type="datetime-local"> (reserva pública,
  // reserva/bloqueo manual desde consola PC y móvil). new Date() lo interpretaría con la
  // zona horaria del PROCESO, que en Vercel es UTC, no la del negocio: una reserva pedida a
  // las 10:00 Chile quedaría guardada como 10:00 UTC (~06:00-07:00 Chile). Interpretar
  // siempre como hora local del negocio.
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(raw);
  if (!match) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = zonedDateTimeToUtc(match[1], match[2], timeZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function agendaConfig(packageData) {
  const agenda = packageData.solutions?.agenda?.config;
  return agenda?.enabled ? agenda : null;
}

function initialState(packageData) {
  const config = agendaConfig(packageData);
  return {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    appointments: [],
    blocks: [],
    feedback: [],
    catalog: {
      locations: config?.locations || [],
      services: config?.services || [],
      resources: config?.resources || []
    }
  };
}

export async function loadAgendaState(packageData) {
  if (!agendaConfig(packageData)) return null;
  try {
    const saved = JSON.parse(await fs.readFile(statePathFor(packageData), 'utf8'));
    return { ...initialState(packageData), ...saved, catalog: initialState(packageData).catalog };
  } catch {
    return initialState(packageData);
  }
}

async function saveAgendaState(packageData, state) {
  const statePath = statePathFor(packageData);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  state.updated_at = new Date().toISOString();
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporary, statePath);
}

function overlaps(aStart, aDuration, bStart, bDuration) {
  const aEnd = aStart + aDuration * 60_000;
  const bEnd = bStart + bDuration * 60_000;
  return aStart < bEnd && bStart < aEnd;
}

// Nunca deja que una falla de Google Calendar rompa el flujo real de agenda (crear/cancelar/
// reagendar una cita) — sync best-effort, se loguea (logs del runtime en Vercel) y se sigue.
async function syncGoogleCalendarBestEffort(action) {
  try { await action(); } catch (error) { console.error('[google-calendar] sync falló:', error.message); }
}

// Sólo se usa para filtrar disponibilidad — si Google falla, se ofrecen los horarios sin
// filtrar por Calendar en vez de tumbar la consulta completa (mejor mostrar de más que trabarse).
async function excludeGoogleCalendarBusySlots(slots, durationMinutes, date, timeZone) {
  if (!slots.length) return slots;
  let busy = [];
  try {
    const rangeStart = zonedDateTimeToUtc(date, '00:00', timeZone).toISOString();
    const rangeEnd = zonedDateTimeToUtc(date, '23:59', timeZone).toISOString();
    busy = await getGoogleCalendarBusyIntervals(rangeStart, rangeEnd);
  } catch (error) {
    console.error('[google-calendar] freebusy falló, se ofrecen horarios sin filtrar por Calendar:', error.message);
    return slots;
  }
  if (!busy.length) return slots;
  return slots.filter(iso => {
    const start = new Date(iso).getTime();
    const end = start + durationMinutes * 60_000;
    return !busy.some(interval => start < new Date(interval.end).getTime() && new Date(interval.start).getTime() < end);
  });
}

// excludeGoogleCalendarBusySlots sólo protege a quien primero consulta disponibilidad
// (bot de WhatsApp, widget público) — la reserva manual de staff en la consola (PC y móvil)
// postea un horario escrito a mano directo a createAgendaAppointment sin pasar por ahí antes.
// Este chequeo corre DENTRO de createAgendaAppointment mismo para cubrir cualquier origen por
// igual, presente o futuro, en vez de parchar cada diálogo del frontend uno por uno.
async function assertNotBusyOnGoogleCalendar(startIso, endIso) {
  let busy;
  try {
    busy = await getGoogleCalendarBusyIntervals(startIso, endIso);
  } catch (error) {
    console.error('[google-calendar] freebusy check en creación falló, se permite la reserva sin verificar:', error.message);
    return;
  }
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const clash = busy.some(interval => start < new Date(interval.end).getTime() && new Date(interval.start).getTime() < end);
  if (clash) throw new Error('Ese horario quedó ocupado en el Google Calendar conectado. Elige otro horario.');
}

const ACTIVE_APPOINTMENT_STATUSES = new Set(['pending_confirmation', 'confirmed']);

export function isActiveAgendaAppointment(appointment, now = Date.now()) {
  if (!appointment || !ACTIVE_APPOINTMENT_STATUSES.has(appointment.status)) return false;
  if (appointment.status !== 'pending_confirmation' || !appointment.expires_at) return true;
  const expiresAt = new Date(appointment.expires_at).getTime();
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

function pendingConfirmationTtlMinutes(config) {
  const configured = Number(config?.rules?.pending_confirmation_ttl_minutes ?? config?.rules?.pending_ttl_minutes ?? 120);
  return Math.max(5, Math.min(10_080, Number.isFinite(configured) ? Math.round(configured) : 120));
}

function pendingExpiresAt(config, status, from = Date.now()) {
  return status === 'pending_confirmation'
    ? new Date(from + pendingConfirmationTtlMinutes(config) * 60_000).toISOString()
    : null;
}

function zonedParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
}

function zonedDateTimeToUtc(date, time, timeZone) {
  const [year, month, day] = String(date).split('-').map(Number);
  const [hour, minute] = String(time).split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let timestamp = desired;
  // Dos pasadas resuelven el offset real de la zona, incluso cerca de cambios DST.
  for (let pass = 0; pass < 2; pass++) {
    const parts = zonedParts(timestamp, timeZone);
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    timestamp += desired - observed;
  }
  return new Date(timestamp);
}

function localDayOfWeek(timestamp, timeZone) {
  const weekday = zonedParts(timestamp, timeZone).weekday;
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
}

function isWithinLocalAvailability(state, resource, startsAt, durationMinutes, timeZone) {
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const startParts = zonedParts(start, timeZone);
  const endParts = zonedParts(end, timeZone);
  // No aceptar una cita que cruce el cambio de día local.
  if (`${startParts.year}-${startParts.month}-${startParts.day}` !== `${endParts.year}-${endParts.month}-${endParts.day}`) return false;
  const day = localDayOfWeek(start, timeZone);
  const startTime = `${startParts.hour}:${startParts.minute}`;
  const endTime = `${endParts.hour}:${endParts.minute}`;
  return (state.availabilityRules || []).some(rule => rule.resource === resource && Number(rule.day_of_week) === day && rule.active !== false
    && String(rule.starts_at).slice(0, 5) <= startTime && String(rule.ends_at).slice(0, 5) >= endTime);
}

// Franjas donde el profesional PUEDE estar comprometido en otro lugar (ej. turno en un centro
// médico donde no controla su propia agenda), pero no siempre — no son un bloqueo real, sino una
// señal de "no confirmes solo, deriva a que la persona lo verifique". Distinto de availabilityRules
// (cuándo SÍ está disponible) y de blocks (cuándo NO lo está, con certeza).
export function findRiskWindow(packageData, resourceName, startsAtIso) {
  const config = agendaConfig(packageData);
  const windows = config?.risk_windows || [];
  if (!windows.length) return null;
  const timeZone = config?.timezone || 'America/Santiago';
  const start = new Date(startsAtIso);
  const day = localDayOfWeek(start, timeZone);
  const parts = zonedParts(start, timeZone);
  const time = `${parts.hour}:${parts.minute}`;
  return windows.find(item => item.resource === resourceName && Number(item.day_of_week) === day
    && String(item.starts_at).slice(0, 5) <= time && String(item.ends_at).slice(0, 5) > time) || null;
}

export async function getAgendaDashboard(packageData) {
  const config = agendaConfig(packageData);
  if (!config) return null;
  if (supabaseSettings()) {
    const [locations, services, resources, links, appointments, availabilityRules, availabilityBlocks, feedback] = await Promise.all([
      agendaSupabaseRequest('/rest/v1/za_locations?active=eq.true&select=id,name,address,timezone'),
      agendaSupabaseRequest('/rest/v1/za_services?active=eq.true&select=id,name,duration_minutes,price_clp,bookable,redirect_note'),
      agendaSupabaseRequest('/rest/v1/za_resources?active=eq.true&select=id,name,specialty,location_id'),
      agendaSupabaseRequest('/rest/v1/za_resource_services?select=resource_id,service_id'),
      fetchAllAgendaRows('/rest/v1/za_appointments?select=id,reference,status,source,starts_at,ends_at,expires_at,notes,za_customers(full_name,phone,email),za_services(name,duration_minutes),za_resources(name),za_locations(name)&order=starts_at.asc'),
      agendaSupabaseRequest('/rest/v1/za_availability_rules?select=id,resource_id,day_of_week,starts_at,ends_at,active&order=day_of_week.asc,starts_at.asc'),
      agendaSupabaseRequest('/rest/v1/za_availability_blocks?select=id,resource_id,starts_at,ends_at,reason&order=starts_at.asc'),
      agendaSupabaseRequest('/rest/v1/za_feedback_items?select=id,rating,question,reply,correction_text,status,created_at&order=created_at.desc&limit=30')
    ]);
    const resourceCatalog = resources.map(resource => ({
      ...resource,
      services: links.filter(link => link.resource_id === resource.id).map(link => services.find(service => service.id === link.service_id)?.name).filter(Boolean)
    }));
    return {
      mode: 'customer_supabase',
      business_name: packageData.business?.display_name || '',
      description: packageData.business?.description || '',
      channel_status: { zavu_connected: Boolean(process.env.ZAVUDEV_SENDER_ID && process.env.ZAVUDEV_WEBHOOK_SECRET) },
      config: { timezone: config.timezone, confirmation_mode: config.confirmation_mode, reminder_hours: config.reminder_hours, cancellation_policy: config.cancellation_policy, rules: config.rules },
      catalog: { locations, services, resources: resourceCatalog },
      appointments: appointments.map(item => ({
        id: item.id, reference: item.reference, status: item.status, source: item.source, starts_at: item.starts_at, expires_at: item.expires_at,
        is_expired: item.status === 'pending_confirmation' && Boolean(item.expires_at) && new Date(item.expires_at).getTime() <= Date.now(),
        duration_minutes: item.za_services?.duration_minutes, notes: item.notes, customer_name: item.za_customers?.full_name,
        customer_phone: item.za_customers?.phone, customer_email: item.za_customers?.email, service: item.za_services?.name, resource: item.za_resources?.name, location: item.za_locations?.name
      })),
      blocks: availabilityBlocks.map(block => ({ ...block, resource: resources.find(resource => resource.id === block.resource_id)?.name || 'Recurso eliminado' })),
      availabilityRules: availabilityRules.map(rule => ({ ...rule, resource: resources.find(resource => resource.id === rule.resource_id)?.name || 'Recurso eliminado' })),
      feedback
    };
  }
  const state = await loadAgendaState(packageData);
  return {
    mode: 'local_preview_state',
    business_name: packageData.business?.display_name || '',
    description: packageData.business?.description || '',
    channel_status: { zavu_connected: Boolean(process.env.ZAVUDEV_SENDER_ID && process.env.ZAVUDEV_WEBHOOK_SECRET) },
    config: {
      timezone: config.timezone,
      confirmation_mode: config.confirmation_mode,
      reminder_hours: config.reminder_hours,
      cancellation_policy: config.cancellation_policy,
      rules: config.rules
    },
    catalog: state.catalog,
    appointments: [...state.appointments].sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    blocks: state.blocks,
    availabilityRules: state.availabilityRules || [],
    feedback: [...(state.feedback || [])]
  };
}

// Respaldo local del feedback cuando no hay Supabase: mismo archivo de estado que
// appointments/availabilityRules, para que el dashboard del cliente pueda listarlo
// y marcarlo resuelto sin depender de infraestructura externa.
export async function appendAgendaFeedbackLocal(packageData, item) {
  if (!agendaConfig(packageData) || agendaUsesSupabase()) return null;
  const state = await loadAgendaState(packageData);
  const entry = {
    id: item.id || randomUUID(),
    rating: item.rating,
    question: cleanText(item.question, 800),
    reply: cleanText(item.reply, 2000),
    correction_text: cleanText(item.expected_answer, 2000),
    status: 'new',
    created_at: item.created_at || new Date().toISOString()
  };
  state.feedback = [entry, ...(state.feedback || [])].slice(0, 200);
  await saveAgendaState(packageData, state);
  return entry;
}

// El segmento nunca baja solo: el dueño lo puede bajar a mano, pero el sistema
// sólo lo sube (frio → caliente → cliente) ante señales reales de avance.
const SEGMENT_ORDER = { revisar: -1, frio: 0, caliente: 1, cliente: 2 };
async function bumpCustomerSegment(customerId, minSegment) {
  if (!customerId || !supabaseSettings()) return;
  try {
    const rows = await agendaSupabaseRequest(`/rest/v1/za_customers?id=eq.${encodeURIComponent(customerId)}&select=id,segment`);
    const current = rows?.[0]?.segment || 'frio';
    if ((SEGMENT_ORDER[current] ?? 0) >= SEGMENT_ORDER[minSegment]) return;
    await agendaSupabaseRequest(`/rest/v1/za_customers?id=eq.${encodeURIComponent(customerId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ segment: minSegment }) });
  } catch (error) { console.warn('No se pudo actualizar el segmento del cliente:', error.message); }
}

export async function createAgendaAppointment(packageData, input, source = 'client_console') {
  const config = agendaConfig(packageData);
  if (!config) throw new Error('Agenda v1 no está habilitada en este paquete.');
  const dashboard = await getAgendaDashboard(packageData);
  const state = await loadAgendaState(packageData);
  const serviceName = cleanText(input.service);
  const resourceName = cleanText(input.resource);
  const customerName = cleanText(input.customer_name);
  // Normalizado a un único formato (E.164 Chile) sea cual sea el origen (WhatsApp ya normalizado
  // en el ingreso del webhook, reserva pública en texto libre, consola) — antes cada camino guardaba
  // el teléfono como llegaba y "9 1234 5678"/"+56 9 1234 5678"/"+56912345678" podían crear tres
  // clientes distintos en vez de uno.
  const customerPhone = normalizeChilePhone(cleanText(input.customer_phone, 40)) || cleanText(input.customer_phone, 40);
  const customerEmail = cleanText(input.customer_email, 254);
  const customerRut = cleanText(input.customer_rut, 20);
  const customerAddress = cleanText(input.customer_address, 300);
  const customerAge = Number.isInteger(Number(input.customer_age)) && Number(input.customer_age) > 0 ? Number(input.customer_age) : null;
  const customerOccupation = cleanText(input.customer_occupation, 120);
  const customerMedicalHistory = cleanText(input.customer_medical_history, 800);
  const customerExtraSymptoms = cleanText(input.customer_extra_symptoms, 500);
  const startsAt = asIso(input.starts_at, config.timezone || 'America/Santiago');
  const service = dashboard.catalog.services.find(item => item.name === serviceName);
  const resource = dashboard.catalog.resources.find(item => item.name === resourceName);
  if (!service || !resource) throw new Error('El servicio o profesional seleccionado no existe en este paquete.');
  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new Error('El correo informado no es válido.');
  if (!(resource.services || []).includes(service.name)) throw new Error('El profesional no realiza ese servicio.');
  // Servicio no gestionado por este negocio (ej. atención en un centro de terceros): nunca se
  // agenda por ningún canal, sin importar el origen (reserva pública, consola, WhatsApp).
  if (service.bookable === false) throw new Error(service.redirect_note || `"${service.name}" no se agenda por este canal.`);
  if (!customerName || (config.rules?.require_customer_phone && !customerPhone) || !startsAt) {
    throw new Error('Para reservar se necesita nombre, teléfono, servicio, profesional y fecha/hora válida.');
  }
  if (new Date(startsAt).getTime() < Date.now()) throw new Error('No se pueden crear reservas en el pasado.');
  const minimumNotice = Number(config.rules?.minimum_notice_hours || 0) * 3_600_000;
  if (new Date(startsAt).getTime() - Date.now() < minimumNotice) throw new Error('El horario no cumple el aviso mínimo configurado.');
  const maximumAdvance = Number(config.rules?.maximum_advance_days ?? 730) * 86_400_000;
  if (new Date(startsAt).getTime() - Date.now() > maximumAdvance) throw new Error('El horario supera la anticipación máxima configurada.');
  // La franja de riesgo aplica acá, no sólo en la tool del agente de WhatsApp: cualquier
  // origen (reserva pública, consola, staff) puede crear un cruce que el equipo no controla
  // del todo. Nunca auto-confirmamos ese horario, sin importar el confirmation_mode del negocio.
  const riskWindow = findRiskWindow(packageData, resourceName, startsAt);
  const effectiveConfirmationMode = riskWindow ? 'manual' : config.confirmation_mode;
  const riskNote = riskWindow ? `[Franja de riesgo] ${riskWindow.reason || 'Posible compromiso del profesional en otro lugar a esta hora.'} Confirmar disponibilidad real antes de aceptar.` : '';
  const notesWithRisk = [cleanText(input.notes, 800), riskNote].filter(Boolean).join(' — ').slice(0, 800);
  const checkDurationMinutes = Number(service.duration_minutes) || 30;
  await assertNotBusyOnGoogleCalendar(startsAt, new Date(new Date(startsAt).getTime() + checkDurationMinutes * 60_000).toISOString());
  if (supabaseSettings()) {
    const explicitLocation = dashboard.catalog.locations.find(item => item.name === cleanText(input.location));
    // La sede real de la cita puede venir del recurso (resource.location_id) cuando la reserva
    // no manda `location` explícito (típico del bot de WhatsApp) — usar sólo `explicitLocation`
    // acá dejaba el evento de Calendar sin color pese a que la cita sí tenía sede conocida.
    const location = explicitLocation || dashboard.catalog.locations.find(item => item.id === resource.location_id) || null;
    const result = await agendaSupabaseRequest('/rest/v1/rpc/za_request_appointment', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
        p_customer_name: customerName, p_customer_phone: customerPhone, p_service_id: service.id, p_resource_id: resource.id,
        p_starts_at: startsAt, p_source: source, p_location_id: location?.id || resource.location_id || null,
        p_notes: notesWithRisk, p_confirmation_mode: effectiveConfirmationMode,
        p_minimum_notice_hours: Number(config.rules?.minimum_notice_hours || 0),
        p_maximum_advance_days: Number(config.rules?.maximum_advance_days ?? 730),
        p_pending_ttl_minutes: pendingConfirmationTtlMinutes(config),
        p_customer_email: customerEmail || null, p_customer_age: customerAge,
        p_customer_occupation: customerOccupation || null, p_customer_medical_history: customerMedicalHistory || null,
        p_customer_extra_symptoms: customerExtraSymptoms || null, p_customer_rut: customerRut || null,
        p_customer_address: customerAddress || null
      })
    });
    const appointment = Array.isArray(result) ? result[0] : result;
    await bumpCustomerSegment(appointment.customer_id, 'caliente');
    await syncGoogleCalendarBestEffort(async () => {
      // za_request_appointment dedupea reintentos devolviendo la fila existente — si ya tiene
      // event_id, un reintento acá crearía un segundo evento y una segunda invitación por correo.
      if (appointment.google_calendar_event_id) return;
      const eventId = await createGoogleCalendarEvent({
        summary: `${serviceName} — ${customerName}`,
        description: [`Servicio: ${serviceName}`, `Teléfono: ${customerPhone}`, notesWithRisk].filter(Boolean).join('\n'),
        startIso: appointment.starts_at, endIso: appointment.ends_at,
        attendeeEmail: customerEmail || null, colorId: colorIdForLocation(location?.name || '')
      });
      if (!eventId) return;
      // Ventana angosta pero real: si un cancelar llegó mientras Google creaba el evento (dos
      // llamadas de red), no dejar el evento vivo en Calendar para una cita ya cancelada acá.
      const freshRows = await agendaSupabaseRequest(`/rest/v1/za_appointments?id=eq.${encodeURIComponent(appointment.id)}&select=status`);
      if (['cancelled', 'rejected'].includes(freshRows?.[0]?.status)) {
        await deleteGoogleCalendarEvent(eventId);
        return;
      }
      await agendaSupabaseRequest(`/rest/v1/za_appointments?id=eq.${encodeURIComponent(appointment.id)}`, {
        method: 'PATCH', body: JSON.stringify({ google_calendar_event_id: eventId })
      });
      appointment.google_calendar_event_id = eventId;
    });
    return { ...appointment, customer_name: customerName, customer_phone: customerPhone, customer_email: customerEmail, customer_rut: customerRut, customer_address: customerAddress, service: serviceName, resource: resourceName, location: location?.name || '', risk_window: riskWindow || null };
  }
  const duration = Number(service.duration_minutes) || 30;
  const startTime = new Date(startsAt).getTime();
  const exactExisting = state.appointments.find(item => isActiveAgendaAppointment(item)
    && item.resource === resourceName && item.service === serviceName
    && normalizeChilePhone(item.customer_phone) === customerPhone
    && new Date(item.starts_at).getTime() === startTime);
  if (exactExisting) return { ...exactExisting, duplicate: true };
  if (!isWithinLocalAvailability(state, resourceName, startsAt, duration, config.timezone || 'America/Santiago')) {
    throw new Error('Horario fuera de disponibilidad. Define horarios explícitos para este profesional antes de reservar.');
  }
  const conflict = state.appointments.find(item => item.resource === resourceName && isActiveAgendaAppointment(item)
    && overlaps(startTime, duration, new Date(item.starts_at).getTime(), Number(item.duration_minutes) || 30));
  if (conflict) throw new Error('Ese profesional ya tiene una reserva que se cruza con el horario solicitado.');
  const endTime = startTime + duration * 60_000;
  const blocked = (state.blocks || []).some(block => block.resource === resourceName
    && startTime < new Date(block.ends_at).getTime() && new Date(block.starts_at).getTime() < endTime);
  if (blocked) throw new Error('Ese horario está bloqueado para este profesional.');
  const appointment = {
    id: `apt_${randomUUID()}`,
    reference: `ZA-${randomUUID().slice(0, 8).toUpperCase()}`,
    created_at: new Date().toISOString(),
    source,
    status: effectiveConfirmationMode === 'automatic' ? 'confirmed' : 'pending_confirmation',
    expires_at: pendingExpiresAt(config, effectiveConfirmationMode === 'automatic' ? 'confirmed' : 'pending_confirmation'),
    customer_name: customerName,
    customer_phone: customerPhone,
    customer_email: customerEmail,
    customer_rut: customerRut,
    customer_address: customerAddress,
    customer_age: customerAge,
    customer_occupation: customerOccupation,
    customer_medical_history: customerMedicalHistory,
    customer_extra_symptoms: customerExtraSymptoms,
    service: serviceName,
    resource: resourceName,
    // Mismo fallback que la rama Supabase (resource.location_id): si la reserva no manda
    // `location` explícito, usar la sede propia del recurso (`resource.location`, nombre —
    // este catálogo local no tiene ids de Supabase) antes de caer al primer catálogo genérico.
    location: cleanText(input.location) || resource.location || state.catalog.locations[0]?.name || '',
    starts_at: startsAt,
    duration_minutes: duration,
    notes: notesWithRisk,
    risk_window: riskWindow || null
  };
  state.appointments.push(appointment);
  await saveAgendaState(packageData, state);
  await syncGoogleCalendarBestEffort(async () => {
    const eventId = await createGoogleCalendarEvent({
      summary: `${serviceName} — ${customerName}`,
      description: [`Servicio: ${serviceName}`, `Teléfono: ${customerPhone}`, notesWithRisk].filter(Boolean).join('\n'),
      startIso: appointment.starts_at, endIso: new Date(endTime).toISOString(),
      attendeeEmail: customerEmail || null, colorId: colorIdForLocation(appointment.location)
    });
    if (!eventId) return;
    // Misma ventana angosta que en la rama Supabase: si un cancelar llegó mientras Google creaba
    // el evento, no dejar el evento vivo en Calendar para una cita ya cancelada acá.
    const freshState = await loadAgendaState(packageData);
    const freshAppointment = freshState.appointments.find(item => item.id === appointment.id);
    if (!freshAppointment || ['cancelled', 'rejected'].includes(freshAppointment.status)) {
      await deleteGoogleCalendarEvent(eventId);
      return;
    }
    appointment.google_calendar_event_id = eventId;
    freshAppointment.google_calendar_event_id = eventId;
    await saveAgendaState(packageData, freshState);
  });
  return appointment;
}

export async function updateAgendaAppointment(packageData, id, status) {
  const config = agendaConfig(packageData);
  if (!config) throw new Error('Agenda v1 no está habilitada en este paquete.');
  const allowed = ['pending_confirmation', 'confirmed', 'cancelled', 'completed', 'no_show', 'rejected'];
  if (!allowed.includes(status)) throw new Error('Estado de reserva inválido.');
  if (supabaseSettings()) {
    const current = await agendaSupabaseRequest(`/rest/v1/za_appointments?id=eq.${encodeURIComponent(id)}&select=id,status`);
    if (!current?.[0]) throw new Error('Reserva no encontrada.');
    const result = await agendaSupabaseRequest('/rest/v1/rpc/za_transition_appointment', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
        p_appointment_id: id, p_new_status: status, p_expected_status: current[0].status
      })
    });
    const appointment = Array.isArray(result) ? result[0] : result;
    if (['confirmed', 'completed'].includes(status)) await bumpCustomerSegment(appointment.customer_id, 'cliente');
    if (['cancelled', 'rejected'].includes(status) && appointment.google_calendar_event_id) {
      await syncGoogleCalendarBestEffort(() => deleteGoogleCalendarEvent(appointment.google_calendar_event_id));
    }
    return appointment;
  }
  const state = await loadAgendaState(packageData);
  if (!state) throw new Error('Agenda v1 no está habilitada en este paquete.');
  const appointment = state.appointments.find(item => item.id === id);
  if (!appointment) throw new Error('Reserva no encontrada.');
  const transitions = {
    pending_confirmation: ['confirmed', 'cancelled', 'rejected'],
    confirmed: ['cancelled', 'completed', 'no_show']
  };
  if (appointment.status !== status && !transitions[appointment.status]?.includes(status)) throw new Error('Transición de estado no permitida.');
  if (status === 'confirmed') {
    if (appointment.status === 'pending_confirmation' && !isActiveAgendaAppointment(appointment)) {
      throw new Error('La solicitud pendiente venció; crea una nueva reserva para confirmar ese horario.');
    }
    const duration = Number(appointment.duration_minutes) || 30;
    const start = new Date(appointment.starts_at).getTime();
    const end = start + duration * 60_000;
    if (!isWithinLocalAvailability(state, appointment.resource, appointment.starts_at, duration, config.timezone || 'America/Santiago')) {
      throw new Error('El horario ya no está dentro de la disponibilidad del profesional.');
    }
    if ((state.blocks || []).some(block => block.resource === appointment.resource
      && start < new Date(block.ends_at).getTime() && new Date(block.starts_at).getTime() < end)) {
      throw new Error('El horario fue bloqueado y ya no se puede confirmar.');
    }
    const conflict = state.appointments.find(item => item.id !== appointment.id && item.resource === appointment.resource
      && isActiveAgendaAppointment(item)
      && overlaps(start, duration, new Date(item.starts_at).getTime(), Number(item.duration_minutes) || 30));
    if (conflict) throw new Error('El horario ya fue ocupado por otra reserva.');
  }
  appointment.status = status;
  if (status !== 'pending_confirmation') appointment.expires_at = null;
  appointment.updated_at = new Date().toISOString();
  await saveAgendaState(packageData, state);
  if (['cancelled', 'rejected'].includes(status) && appointment.google_calendar_event_id) {
    await syncGoogleCalendarBestEffort(() => deleteGoogleCalendarEvent(appointment.google_calendar_event_id));
  }
  return appointment;
}

// Disponibilidad real. En producción la calcula la RPC atómica; en preview local se genera desde las
// reglas de disponibilidad del recurso, excluyendo reservas que se cruzan y respetando el aviso mínimo.
// (El generador local usa la hora local del servidor; producción ancla la zona horaria en Postgres.)
export async function getAvailableSlots(packageData, { service, resource, date }) {
  const config = agendaConfig(packageData);
  if (!config) throw new Error('Agenda v1 no está habilitada en este paquete.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('Fecha inválida; usa YYYY-MM-DD.');
  if (supabaseSettings()) {
    // Consulta puntual en vez de getAgendaDashboard() completo: el dashboard trae TODAS las
    // citas históricas paginadas (miles de filas en clientes con actividad real) sólo para
    // validar un servicio/recurso — este es el chequeo de mayor frecuencia de todo Calendar
    // (cada consulta de disponibilidad del bot/widget lo paga), así que el ahorro es real.
    const serviceName = cleanText(service);
    const resourceName = cleanText(resource);
    const [services, resources] = await Promise.all([
      agendaSupabaseRequest(`/rest/v1/za_services?name=eq.${encodeURIComponent(serviceName)}&select=id,name,duration_minutes,bookable,redirect_note&limit=1`),
      agendaSupabaseRequest(`/rest/v1/za_resources?name=eq.${encodeURIComponent(resourceName)}&select=id,name&limit=1`)
    ]);
    const svc = services?.[0];
    const res = resources?.[0];
    if (!svc || !res) throw new Error('Servicio o profesional no configurado.');
    if (svc.bookable === false) throw new Error(svc.redirect_note || 'Ese servicio no se agenda por este canal.');
    const links = await agendaSupabaseRequest(`/rest/v1/za_resource_services?resource_id=eq.${encodeURIComponent(res.id)}&service_id=eq.${encodeURIComponent(svc.id)}&select=resource_id&limit=1`);
    if (!links?.length) throw new Error('El profesional no realiza ese servicio.');
    const slots = await agendaSupabaseRequest('/rest/v1/rpc/za_available_slots', {
      method: 'POST', body: JSON.stringify({
        p_service_id: svc.id, p_resource_id: res.id, p_date: date,
        p_interval_minutes: config.rules?.slot_interval_minutes || 15,
        p_minimum_notice_hours: Number(config.rules?.minimum_notice_hours || 0),
        p_maximum_advance_days: Number(config.rules?.maximum_advance_days ?? 730)
      })
    });
    const isoSlots = (slots || []).map(item => item.starts_at);
    return excludeGoogleCalendarBusySlots(isoSlots, Number(svc.duration_minutes) || 30, date, config.timezone || 'America/Santiago');
  }
  const dashboard = await getAgendaDashboard(packageData);
  const svc = dashboard.catalog.services.find(item => item.name === cleanText(service));
  const res = dashboard.catalog.resources.find(item => item.name === cleanText(resource));
  if (!svc || !res) throw new Error('Servicio o profesional no configurado.');
  if (svc.bookable === false) throw new Error(svc.redirect_note || 'Ese servicio no se agenda por este canal.');
  if (!(res.services || []).includes(svc.name)) throw new Error('El profesional no realiza ese servicio.');
  const state = await loadAgendaState(packageData);
  const timeZone = config.timezone || 'America/Santiago';
  const day = localDayOfWeek(zonedDateTimeToUtc(date, '12:00', timeZone), timeZone);
  const rules = (state.availabilityRules || []).filter(rule => rule.resource === res.name && Number(rule.day_of_week) === day && rule.active !== false);
  const duration = Number(svc.duration_minutes) || 30;
  const interval = Number(config.rules?.slot_interval_minutes) || 15;
  const minimumNotice = Number(config.rules?.minimum_notice_hours || 0) * 3_600_000;
  const maximumAdvance = Number(config.rules?.maximum_advance_days ?? 730) * 86_400_000;
  const now = Date.now();
  const busy = state.appointments.filter(item => item.resource === res.name && isActiveAgendaAppointment(item, now));
  const slots = [];
  for (const rule of rules) {
    const [sh, sm] = String(rule.starts_at).split(':').map(Number);
    const [eh, em] = String(rule.ends_at).split(':').map(Number);
    const windowEnd = zonedDateTimeToUtc(date, `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`, timeZone);
    const cursor = zonedDateTimeToUtc(date, `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`, timeZone);
    while (cursor.getTime() + duration * 60_000 <= windowEnd.getTime()) {
      const slotStart = cursor.getTime();
      const clashes = busy.some(item => overlaps(slotStart, duration, new Date(item.starts_at).getTime(), Number(item.duration_minutes) || 30));
      const slotEnd = slotStart + duration * 60_000;
      const blocked = (state.blocks || []).some(block => block.resource === res.name
        && slotStart < new Date(block.ends_at).getTime() && new Date(block.starts_at).getTime() < slotEnd);
      if (!clashes && !blocked && slotStart > now && slotStart - now >= minimumNotice && slotStart - now <= maximumAdvance) slots.push(new Date(slotStart).toISOString());
      cursor.setTime(cursor.getTime() + interval * 60_000);
    }
  }
  return excludeGoogleCalendarBusySlots([...new Set(slots)].sort(), duration, date, timeZone);
}

export async function rescheduleAgendaAppointment(packageData, { id, new_starts_at, requester_phone = null }) {
  const config = agendaConfig(packageData);
  if (!config) throw new Error('Agenda v1 no está habilitada en este paquete.');
  const startsAt = asIso(new_starts_at, config.timezone || 'America/Santiago');
  if (!startsAt) throw new Error('Fecha/hora nueva inválida.');
  if (supabaseSettings()) {
    // Consulta puntual en vez de getAgendaDashboard() completo: el dashboard trae TODAS las
    // citas históricas paginadas sólo para leer una fila — franciskom ya pasó 1000+ citas, así
    // que esto ya estaba degradando cada reagendamiento en producción.
    const currentRows = await agendaSupabaseRequest(`/rest/v1/za_appointments?id=eq.${encodeURIComponent(id)}&select=id,starts_at,status,google_calendar_event_id,za_resources(name),za_services(duration_minutes)`);
    const current = currentRows?.[0];
    if (!current) throw new Error('Reserva no encontrada.');
    const currentResourceName = current.za_resources?.name || '';
    // Si la nueva hora es igual a la actual (reintento/doble-click), no tiene sentido consultar
    // freebusy contra el propio evento de Calendar de esta misma cita (se vería a sí mismo como
    // "ocupado") ni mandar el correo de "tu cita cambió" más abajo — no cambió nada.
    const sameTime = new Date(startsAt).getTime() === new Date(current.starts_at).getTime();
    if (!sameTime) {
      const durationMinutes = Number(current.za_services?.duration_minutes) || 30;
      const endsAtForCheck = new Date(new Date(startsAt).getTime() + durationMinutes * 60_000).toISOString();
      await assertNotBusyOnGoogleCalendar(startsAt, endsAtForCheck);
    }
    const riskWindow = findRiskWindow(packageData, currentResourceName, startsAt);
    const effectiveConfirmationMode = riskWindow ? 'manual' : (config.confirmation_mode || 'manual');
    const riskNote = riskWindow ? `[Franja de riesgo] ${riskWindow.reason || 'Posible compromiso del profesional en otro lugar a esta hora.'} Confirmar disponibilidad real antes de aceptar.` : '';
    const result = await agendaSupabaseRequest('/rest/v1/rpc/za_reschedule_appointment', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
        p_appointment_id: id, p_new_starts_at: startsAt,
        p_requester_phone: requester_phone || null,
        p_minimum_notice_hours: Number(config.rules?.minimum_notice_hours || 0),
        p_maximum_advance_days: Number(config.rules?.maximum_advance_days ?? 730),
        p_confirmation_mode: effectiveConfirmationMode,
        p_pending_ttl_minutes: pendingConfirmationTtlMinutes(config),
        p_risk_note: riskNote
      })
    });
    const appointment = Array.isArray(result) ? result[0] : result;
    if (appointment.google_calendar_event_id && !sameTime) {
      await syncGoogleCalendarBestEffort(() => updateGoogleCalendarEventTime(appointment.google_calendar_event_id, { startIso: appointment.starts_at, endIso: appointment.ends_at }));
    }
    return { ...appointment, risk_window: riskWindow || null };
  }
  const state = await loadAgendaState(packageData);
  const appointment = state.appointments.find(item => item.id === id);
  if (!appointment) throw new Error('Reserva no encontrada.');
  if (['cancelled', 'rejected', 'completed', 'no_show'].includes(appointment.status)) throw new Error('Esa reserva ya no se puede reagendar.');
  if (appointment.status === 'pending_confirmation' && !isActiveAgendaAppointment(appointment)) throw new Error('La solicitud pendiente venció y ya no se puede reagendar.');
  const target = new Date(startsAt).getTime();
  if (target < Date.now()) throw new Error('No se puede reagendar al pasado.');
  if (target - Date.now() < Number(config.rules?.minimum_notice_hours || 0) * 3_600_000) throw new Error('El nuevo horario no cumple el aviso mínimo configurado.');
  if (target - Date.now() > Number(config.rules?.maximum_advance_days ?? 730) * 86_400_000) throw new Error('El nuevo horario supera la anticipación máxima configurada.');
  const duration = Number(appointment.duration_minutes) || 30;
  if (!isWithinLocalAvailability(state, appointment.resource, startsAt, duration, config.timezone || 'America/Santiago')) {
    throw new Error('Horario fuera de disponibilidad.');
  }
  const targetEnd = target + duration * 60_000;
  if ((state.blocks || []).some(block => block.resource === appointment.resource
    && target < new Date(block.ends_at).getTime() && new Date(block.starts_at).getTime() < targetEnd)) {
    throw new Error('Ese horario está bloqueado para este profesional.');
  }
  const conflict = state.appointments.find(item => item.id !== appointment.id && item.resource === appointment.resource
    && isActiveAgendaAppointment(item)
    && overlaps(target, duration, new Date(item.starts_at).getTime(), Number(item.duration_minutes) || 30));
  if (conflict) throw new Error('Ese profesional ya tiene una reserva que se cruza con el nuevo horario.');
  // Mismo criterio que la rama Supabase: hora nueva = hora actual no consulta freebusy (se vería
  // a sí misma como "ocupada") ni dispara el correo de "tu cita cambió" más abajo.
  const sameTime = target === new Date(appointment.starts_at).getTime();
  if (!sameTime) await assertNotBusyOnGoogleCalendar(startsAt, new Date(targetEnd).toISOString());
  const riskWindow = findRiskWindow(packageData, appointment.resource, startsAt);
  const effectiveConfirmationMode = riskWindow ? 'manual' : (config.confirmation_mode || 'manual');
  const riskNote = riskWindow ? `[Franja de riesgo] ${riskWindow.reason || 'Posible compromiso del profesional en otro lugar a esta hora.'} Confirmar disponibilidad real antes de aceptar.` : '';
  appointment.starts_at = startsAt;
  appointment.status = effectiveConfirmationMode === 'automatic' ? 'confirmed' : 'pending_confirmation';
  appointment.expires_at = pendingExpiresAt(config, appointment.status);
  if (riskNote && !String(appointment.notes || '').includes(riskNote)) appointment.notes = [appointment.notes, riskNote].filter(Boolean).join(' — ').slice(0, 800);
  appointment.risk_window = riskWindow || null;
  appointment.updated_at = new Date().toISOString();
  await saveAgendaState(packageData, state);
  if (appointment.google_calendar_event_id && !sameTime) {
    await syncGoogleCalendarBestEffort(() => updateGoogleCalendarEventTime(appointment.google_calendar_event_id, { startIso: appointment.starts_at, endIso: new Date(targetEnd).toISOString() }));
  }
  return appointment;
}

// Instalación idempotente: traduce el catálogo aprobado del paquete hacia el Supabase del cliente.
// Horarios semanales se configuran después desde el dashboard, porque nunca deben inferirse desde texto libre.
export async function seedAgendaCatalog(packageData) {
  const config = agendaConfig(packageData);
  if (!config) throw new Error('Agenda v1 no está habilitada en este paquete.');
  if (!agendaUsesSupabase()) throw new Error('Configura SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY antes de sembrar Agenda.');
  const [existingLocations, existingServices, existingResources, existingLinks] = await Promise.all([
    agendaSupabaseRequest('/rest/v1/za_locations?select=id,name,address,timezone,active'),
    agendaSupabaseRequest('/rest/v1/za_services?select=id,name,duration_minutes,price_clp,bookable,redirect_note,active'),
    agendaSupabaseRequest('/rest/v1/za_resources?select=id,name,specialty,location_id,active'),
    agendaSupabaseRequest('/rest/v1/za_resource_services?select=resource_id,service_id')
  ]);
  const keyForName = value => String(value || '').trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const byName = list => new Map((list || []).map(item => [keyForName(item.name), item]));
  const locations = byName(existingLocations); const services = byName(existingServices); const resources = byName(existingResources);
  const changed = (row, patch) => Object.entries(patch).some(([key, value]) => (row?.[key] ?? null) !== (value ?? null));
  const counters = {
    created: { locations: 0, services: 0, resources: 0, links: 0 },
    updated: { locations: 0, services: 0, resources: 0 },
    removed: { links: 0 }
  };
  for (const item of config.locations || []) {
    if (!item?.name) continue;
    const key = keyForName(item.name);
    const patch = { name: cleanText(item.name), address: cleanText(item.address, 500), timezone: config.timezone || 'America/Santiago', active: item.active !== false };
    const existing = locations.get(key);
    if (!existing) {
      const rows = await agendaSupabaseRequest('/rest/v1/za_locations', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      locations.set(key, rows[0]); counters.created.locations++;
    } else if (changed(existing, patch)) {
      const rows = await agendaSupabaseRequest(`/rest/v1/za_locations?id=eq.${encodeURIComponent(existing.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      locations.set(key, rows[0]); counters.updated.locations++;
    }
  }
  for (const item of config.services || []) {
    if (!item?.name) continue;
    const key = keyForName(item.name);
    const patch = { name: cleanText(item.name), duration_minutes: Number(item.duration_minutes) || 30, price_clp: item.price_clp ?? null, bookable: item.bookable !== false, redirect_note: cleanText(item.redirect_note, 800), active: item.active !== false };
    const existing = services.get(key);
    if (!existing) {
      const rows = await agendaSupabaseRequest('/rest/v1/za_services', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      services.set(key, rows[0]); counters.created.services++;
    } else if (changed(existing, patch)) {
      const rows = await agendaSupabaseRequest(`/rest/v1/za_services?id=eq.${encodeURIComponent(existing.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      services.set(key, rows[0]); counters.updated.services++;
    }
  }
  const configuredLocationRows = (config.locations || []).map(item => locations.get(keyForName(item?.name))).filter(Boolean);
  for (const item of config.resources || []) {
    if (!item?.name) continue;
    // No adivinar sede: un profesional que atiende en varias sedes (o a domicilio) no tiene
    // una sede fija, y forzarle la primera rompe la reserva en cualquier otra (la RPC la
    // rechaza). Sólo se asigna sede fija si el recurso la declara explícitamente, o si el
    // negocio entero tiene una sola sede (ahí sí es inequívoco).
    const configuredLocationName = item.location || (config.locations || []).find(location => location.id && location.id === item.location_id)?.name;
    const declaredLocation = configuredLocationName ? locations.get(keyForName(configuredLocationName)) : null;
    const singleLocation = configuredLocationRows.length === 1 ? configuredLocationRows[0] : null;
    const resourceLocationId = declaredLocation?.id || singleLocation?.id || null;
    const key = keyForName(item.name);
    const patch = { name: cleanText(item.name), specialty: cleanText(item.specialty, 300), location_id: resourceLocationId, active: item.active !== false };
    const existing = resources.get(key);
    if (!existing) {
      const rows = await agendaSupabaseRequest('/rest/v1/za_resources', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      resources.set(key, rows[0]); counters.created.resources++;
    } else if (changed(existing, patch)) {
      const rows = await agendaSupabaseRequest(`/rest/v1/za_resources?id=eq.${encodeURIComponent(existing.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      resources.set(key, rows[0]); counters.updated.resources++;
    }
  }
  const existingLinkKeys = new Set((existingLinks || []).map(link => `${link.resource_id}:${link.service_id}`));
  const desiredLinkKeys = new Set();
  const configuredResourceIds = new Set();
  for (const item of config.resources || []) {
    const resource = resources.get(keyForName(item.name));
    if (resource) configuredResourceIds.add(resource.id);
    for (const serviceName of item.services || []) {
      const service = services.get(keyForName(serviceName));
      if (!resource || !service) continue;
      const linkKey = `${resource.id}:${service.id}`;
      desiredLinkKeys.add(linkKey);
      if (existingLinkKeys.has(linkKey)) continue;
      await agendaSupabaseRequest('/rest/v1/za_resource_services?on_conflict=resource_id,service_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ resource_id: resource.id, service_id: service.id }) });
      counters.created.links++;
    }
  }
  for (const link of existingLinks || []) {
    const linkKey = `${link.resource_id}:${link.service_id}`;
    if (!configuredResourceIds.has(link.resource_id) || desiredLinkKeys.has(linkKey)) continue;
    await agendaSupabaseRequest(`/rest/v1/za_resource_services?resource_id=eq.${encodeURIComponent(link.resource_id)}&service_id=eq.${encodeURIComponent(link.service_id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    counters.removed.links++;
  }
  return { locations: locations.size, services: services.size, resources: resources.size, ...counters };
}

export async function createAgendaAvailabilityRule(packageData, input = {}) {
  if (!agendaConfig(packageData)) throw new Error('Agenda v1 no está habilitada en este paquete.');
  const dashboard = await getAgendaDashboard(packageData);
  const resource = dashboard.catalog.resources.find(item => item.name === cleanText(input.resource));
  const day = Number(input.day_of_week);
  const startsAt = cleanText(input.starts_at, 8);
  const endsAt = cleanText(input.ends_at, 8);
  if (!resource || !Number.isInteger(day) || day < 0 || day > 6 || !/^\d{2}:\d{2}$/.test(startsAt) || !/^\d{2}:\d{2}$/.test(endsAt) || endsAt <= startsAt) {
    throw new Error('Indica profesional, día y un rango horario válido.');
  }
  if (!agendaUsesSupabase()) {
    const state = await loadAgendaState(packageData);
    const rule = { id: `rule_${randomUUID()}`, resource: resource.name, day_of_week: day, starts_at: startsAt, ends_at: endsAt, active: true };
    state.availabilityRules = [...(state.availabilityRules || []), rule];
    await saveAgendaState(packageData, state);
    return rule;
  }
  const result = await agendaSupabaseRequest('/rest/v1/za_availability_rules', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ resource_id: resource.id, day_of_week: day, starts_at: startsAt, ends_at: endsAt, active: true })
  });
  return { ...result[0], resource: resource.name };
}

export async function deleteAgendaAvailabilityRule(packageData, ruleId) {
  if (!agendaUsesSupabase()) {
    const state = await loadAgendaState(packageData);
    const before = (state.availabilityRules || []).length;
    state.availabilityRules = (state.availabilityRules || []).filter(rule => rule.id !== ruleId);
    if (state.availabilityRules.length === before) throw new Error('Horario no encontrado.');
    await saveAgendaState(packageData, state);
    return { ok: true };
  }
  await agendaSupabaseRequest(`/rest/v1/za_availability_rules?id=eq.${encodeURIComponent(ruleId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return { ok: true };
}

// Bloqueos puntuales: a diferencia del horario semanal (siempre igual, semana a semana),
// un bloqueo cubre un tramo real (ej. turno en un centro médico donde el profesional no
// controla su propia agenda, o tiempo de traslado extra a domicilio) sin tocar el horario base.
// Se listan junto al resto del dashboard (getAgendaDashboard), igual que availabilityRules.
export async function createAgendaAvailabilityBlock(packageData, input = {}) {
  const config = agendaConfig(packageData);
  if (!config) throw new Error('Agenda v1 no está habilitada en este paquete.');
  const dashboard = await getAgendaDashboard(packageData);
  const resource = dashboard.catalog.resources.find(item => item.name === cleanText(input.resource));
  const timeZone = config.timezone || 'America/Santiago';
  const startsAt = asIso(input.starts_at, timeZone);
  const endsAt = asIso(input.ends_at, timeZone);
  const reason = cleanText(input.reason, 200);
  if (!resource || !startsAt || !endsAt || new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error('Indica profesional y un rango de fecha/hora válido para el bloqueo.');
  }
  if (!agendaUsesSupabase()) {
    const state = await loadAgendaState(packageData);
    const block = { id: `block_${randomUUID()}`, resource: resource.name, starts_at: startsAt, ends_at: endsAt, reason };
    state.blocks = [...(state.blocks || []), block];
    await saveAgendaState(packageData, state);
    return block;
  }
  const result = await agendaSupabaseRequest('/rest/v1/za_availability_blocks', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ resource_id: resource.id, starts_at: startsAt, ends_at: endsAt, reason })
  });
  return { ...result[0], resource: resource.name };
}

export async function deleteAgendaAvailabilityBlock(packageData, blockId) {
  if (!agendaUsesSupabase()) {
    const state = await loadAgendaState(packageData);
    const before = (state.blocks || []).length;
    state.blocks = (state.blocks || []).filter(block => block.id !== blockId);
    if (state.blocks.length === before) throw new Error('Bloqueo no encontrado.');
    await saveAgendaState(packageData, state);
    return { ok: true };
  }
  await agendaSupabaseRequest(`/rest/v1/za_availability_blocks?id=eq.${encodeURIComponent(blockId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return { ok: true };
}

export async function updateAgendaFeedback(packageData, feedbackId, status) {
  if (!['new', 'reviewing', 'resolved', 'dismissed'].includes(status)) throw new Error('Estado de feedback inválido.');
  if (!agendaUsesSupabase()) {
    const state = await loadAgendaState(packageData);
    const item = (state.feedback || []).find(entry => entry.id === feedbackId);
    if (!item) throw new Error('Feedback no encontrado.');
    item.status = status;
    if (status === 'resolved') item.resolved_at = new Date().toISOString();
    await saveAgendaState(packageData, state);
    return item;
  }
  const rows = await agendaSupabaseRequest(`/rest/v1/za_feedback_items?id=eq.${encodeURIComponent(feedbackId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status, ...(status === 'resolved' ? { resolved_at: new Date().toISOString() } : {}) })
  });
  if (!rows?.[0]) throw new Error('Feedback no encontrado.');
  return rows[0];
}

// Agrega un contacto a mano, sin que haya reservado ni escrito todavía — necesario para poder
// marcar "no contestar" a alguien ANTES de su primer mensaje (ej. un familiar del dueño). Si el
// teléfono ya existe, no se pisa nada: se devuelve la ficha existente tal cual.
export async function createManualCustomer(packageData, input = {}) {
  if (!agendaConfig(packageData)) throw new Error('Agenda v1 no está habilitada en este paquete.');
  const phone = normalizeChilePhone(cleanText(input.phone, 40)) || cleanText(input.phone, 40);
  if (!phone) throw new Error('Teléfono requerido.');
  const fullName = cleanText(input.full_name, 120) || phone;
  if (!agendaUsesSupabase()) return { id: phone, full_name: fullName, phone, segment: 'frio', bot_muted: false };
  // on_conflict=phone es obligatorio para que Postgrest use la unique(phone) real como objetivo del
  // upsert — sin eso, "resolution=ignore-duplicates" sólo mira la primary key (id, siempre nueva en
  // un insert), así que un teléfono repetido rompería contra la constraint en vez de ignorarse.
  // ignore-duplicates (no merge): si el contacto ya existe con datos reales de una reserva, agregarlo
  // "a mano" con solo nombre/teléfono no debe pisar esa ficha — sólo importa dejarlo disponible para
  // marcarlo como silenciado, no sobrescribir lo que ya tenía.
  await agendaSupabaseRequest('/rest/v1/za_customers?on_conflict=phone', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify({ full_name: fullName, phone })
  });
  const rows = await agendaSupabaseRequest(`/rest/v1/za_customers?phone=eq.${encodeURIComponent(phone)}&select=*`);
  if (!rows?.[0]) throw new Error('No se pudo crear el contacto.');
  return rows[0];
}

// ── CRM ligero: control interno de contactos ──
// Sin Supabase no existe una tabla de clientes separada (cada cita local guarda el
// nombre/teléfono directo), así que se agrupa por teléfono como "cliente virtual".
export async function listCustomers(packageData) {
  if (!agendaConfig(packageData)) throw new Error('Agenda v1 no está habilitada en este paquete.');
  if (agendaUsesSupabase()) {
    const [customers, appointments] = await Promise.all([
      fetchAllAgendaRows('/rest/v1/za_customers?select=id,full_name,phone,email,segment,bot_muted,created_at&order=full_name.asc'),
      fetchAllAgendaRows('/rest/v1/za_appointments?select=id,customer_id,starts_at,status&order=starts_at.desc')
    ]);
    return (customers || []).map(customer => {
      const own = (appointments || []).filter(item => item.customer_id === customer.id);
      return { ...customer, appointment_count: own.length, last_visit: own[0]?.starts_at || null };
    });
  }
  const state = await loadAgendaState(packageData);
  const byPhone = new Map();
  for (const appointment of state.appointments) {
    const key = appointment.customer_phone;
    if (!key) continue;
    if (!byPhone.has(key)) byPhone.set(key, { id: key, full_name: appointment.customer_name, phone: key, email: null, segment: 'caliente', bot_muted: false, created_at: appointment.created_at, appointments: [] });
    byPhone.get(key).appointments.push(appointment);
  }
  return [...byPhone.values()].map(customer => {
    const sorted = [...customer.appointments].sort((a, b) => b.starts_at.localeCompare(a.starts_at));
    const { appointments, ...rest } = customer;
    return { ...rest, appointment_count: appointments.length, last_visit: sorted[0]?.starts_at || null };
  });
}

export async function getCustomerDetail(packageData, customerId) {
  if (!agendaConfig(packageData)) throw new Error('Agenda v1 no está habilitada en este paquete.');
  if (agendaUsesSupabase()) {
    const [customerRows, appointments] = await Promise.all([
      agendaSupabaseRequest(`/rest/v1/za_customers?id=eq.${encodeURIComponent(customerId)}&select=*`),
      agendaSupabaseRequest(`/rest/v1/za_appointments?customer_id=eq.${encodeURIComponent(customerId)}&select=id,reference,status,starts_at,notes,za_services(name),za_resources(name)&order=starts_at.desc`)
    ]);
    const customer = customerRows?.[0];
    if (!customer) throw new Error('Cliente no encontrado.');
    return {
      customer,
      appointments: (appointments || []).map(item => ({ id: item.id, reference: item.reference, status: item.status, starts_at: item.starts_at, notes: item.notes, service: item.za_services?.name, resource: item.za_resources?.name }))
    };
  }
  const state = await loadAgendaState(packageData);
  const own = state.appointments.filter(item => item.customer_phone === customerId);
  if (!own.length) throw new Error('Cliente no encontrado.');
  const sorted = [...own].sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  return {
    customer: { id: customerId, full_name: own[0].customer_name, phone: own[0].customer_phone, email: null, segment: 'caliente', bot_muted: false },
    appointments: sorted.map(item => ({ id: item.id, reference: item.reference, status: item.status, starts_at: item.starts_at, notes: item.notes, service: item.service, resource: item.resource }))
  };
}

// Actualiza varios contactos de una vez (ej. "silenciar seleccionados" desde la categoría
// "revisar") — un solo PATCH con id=in.(...) en vez de N requests, importante cuando la selección
// puede ser de cientos de filas (import masivo de agenda personal).
export async function bulkUpdateCustomers(packageData, ids, patch = {}) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('Selección vacía.');
  const update = {};
  if (patch.segment !== undefined) {
    if (!['frio', 'caliente', 'cliente', 'revisar'].includes(patch.segment)) throw new Error('Segmento inválido.');
    update.segment = patch.segment;
  }
  if (patch.bot_muted !== undefined) update.bot_muted = Boolean(patch.bot_muted);
  if (!Object.keys(update).length) throw new Error('Nada que actualizar.');
  if (!agendaUsesSupabase()) return { updated: ids.length };
  const idList = ids.map(id => encodeURIComponent(String(id).slice(0, 80))).join(',');
  const rows = await agendaSupabaseRequest(`/rest/v1/za_customers?id=in.(${idList})`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(update)
  });
  return { updated: rows?.length || 0 };
}

export async function updateCustomerSettings(packageData, customerId, patch = {}) {
  const update = {};
  if (patch.segment !== undefined) {
    if (!['frio', 'caliente', 'cliente', 'revisar'].includes(patch.segment)) throw new Error('Segmento inválido.');
    update.segment = patch.segment;
  }
  if (patch.bot_muted !== undefined) update.bot_muted = Boolean(patch.bot_muted);
  if (!Object.keys(update).length) throw new Error('Nada que actualizar.');
  if (!agendaUsesSupabase()) return { id: customerId, ...update };
  const rows = await agendaSupabaseRequest(`/rest/v1/za_customers?id=eq.${encodeURIComponent(customerId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(update)
  });
  if (!rows?.[0]) throw new Error('Cliente no encontrado.');
  return rows[0];
}

// Actualiza la ficha (correo/edad/ocupación/antecedentes/síntomas) de un cliente que YA existe,
// identificado por teléfono verificado — para cuando esos datos llegan en un turno posterior a la
// reserva (create_appointment sólo los guarda si vienen en esa misma llamada). Sin esto, un
// cliente que responde "tengo 34 años, trabajo en X" DESPUÉS de agendar no tenía dónde quedar
// guardado: no existía ninguna herramienta capaz de tocar su ficha fuera del momento de reservar.
export async function updateCustomerProfile(packageData, phone, fields = {}) {
  if (!agendaUsesSupabase()) return { id: phone, ...fields };
  const patch = {};
  if (fields.email) patch.email = String(fields.email).trim();
  if (Number.isInteger(Number(fields.age)) && Number(fields.age) > 0) patch.age = Number(fields.age);
  if (fields.occupation) patch.occupation = String(fields.occupation).trim().slice(0, 120);
  if (fields.rut) patch.rut = String(fields.rut).trim().slice(0, 20);
  if (fields.medical_history) patch.medical_history = String(fields.medical_history).trim().slice(0, 800);
  if (fields.extra_symptoms) patch.extra_symptoms = String(fields.extra_symptoms).trim().slice(0, 500);
  if (!Object.keys(patch).length) throw new Error('No hay datos nuevos que guardar.');
  const normalizedPhone = normalizeChilePhone(phone) || String(phone).trim();
  const rows = await agendaSupabaseRequest(`/rest/v1/za_customers?phone=eq.${encodeURIComponent(normalizedPhone)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch)
  });
  if (!rows?.[0]) throw new Error('Cliente no encontrado — todavía no tiene ninguna reserva registrada.');
  return rows[0];
}

export function normalizeChilePhone(value) {
  let digits = String(value || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  digits = digits[0] + digits.slice(1).replace(/\+/g, '');
  if (digits.startsWith('+')) return digits;
  digits = digits.replace(/^0+/, '');
  if (!digits) return '';
  if (digits.startsWith('56')) return `+${digits}`;
  if (digits.length === 9 && digits.startsWith('9')) return `+56${digits}`;
  if (digits.length === 8) return `+56${digits}`;
  return `+${digits}`;
}

// Importa una lista de contactos ya parseada (ver contacts-import.js) al CRM. No depende del
// formato de origen (vCard, CSV, futuro Google Contacts) — solo espera {full_name, phone, email?}.
// No pisa el email ya guardado de un cliente existente (p.ej. capturado en una reserva real) si el
// contacto importado no trae uno.
const SEGMENT_RANK = { revisar: -1, frio: 0, caliente: 1, cliente: 2 };

export async function importAgendaCustomers(packageData, contacts) {
  if (!agendaConfig(packageData)) throw new Error('Agenda v1 no está habilitada en este paquete.');
  if (!agendaUsesSupabase()) throw new Error('Importar contactos requiere Supabase configurado en este runtime.');
  const result = { created: 0, updated: 0, skipped: [] };
  for (const raw of contacts) {
    const full_name = cleanText(raw.full_name, 200);
    const phone = normalizeChilePhone(raw.phone);
    const email = raw.email ? cleanText(raw.email, 200).toLowerCase() : null;
    const segment = SEGMENT_RANK[raw.segment] != null ? raw.segment : 'frio';
    if (!full_name || !phone) { result.skipped.push({ full_name: raw.full_name || '', phone: raw.phone || '', reason: 'Falta nombre o teléfono válido' }); continue; }
    const existing = await agendaSupabaseRequest(`/rest/v1/za_customers?phone=eq.${encodeURIComponent(phone)}&select=id,email,segment`);
    if (existing?.[0]) {
      const patch = { full_name };
      if (email && !existing[0].email) patch.email = email;
      // Nunca degradar: un import solo sube el segmento (frio→caliente→cliente), nunca lo baja
      // — si ya reservó o confirmó algo real, ese hecho pesa más que la etiqueta del contacto importado.
      if (SEGMENT_RANK[segment] > (SEGMENT_RANK[existing[0].segment] ?? 0)) patch.segment = segment;
      await agendaSupabaseRequest(`/rest/v1/za_customers?id=eq.${encodeURIComponent(existing[0].id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      result.updated++;
    } else {
      await agendaSupabaseRequest('/rest/v1/za_customers', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ full_name, phone, email, segment }) });
      result.created++;
    }
  }
  return result;
}

export async function updateAppointmentNotes(packageData, appointmentId, notes) {
  const cleaned = cleanText(notes, 800);
  if (!agendaUsesSupabase()) {
    const state = await loadAgendaState(packageData);
    const appointment = state.appointments.find(item => item.id === appointmentId);
    if (!appointment) throw new Error('Reserva no encontrada.');
    appointment.notes = cleaned;
    appointment.updated_at = new Date().toISOString();
    await saveAgendaState(packageData, state);
    return appointment;
  }
  const rows = await agendaSupabaseRequest(`/rest/v1/za_appointments?id=eq.${encodeURIComponent(appointmentId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ notes: cleaned })
  });
  if (!rows?.[0]) throw new Error('Reserva no encontrada.');
  return rows[0];
}
