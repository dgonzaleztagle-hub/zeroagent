import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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

function asIso(value) {
  const date = new Date(value);
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

export async function getAgendaDashboard(packageData) {
  const config = agendaConfig(packageData);
  if (!config) return null;
  if (supabaseSettings()) {
    const [locations, services, resources, links, appointments, availabilityRules, feedback] = await Promise.all([
      agendaSupabaseRequest('/rest/v1/za_locations?active=eq.true&select=id,name,address,timezone'),
      agendaSupabaseRequest('/rest/v1/za_services?active=eq.true&select=id,name,duration_minutes,price_clp'),
      agendaSupabaseRequest('/rest/v1/za_resources?active=eq.true&select=id,name,specialty,location_id'),
      agendaSupabaseRequest('/rest/v1/za_resource_services?select=resource_id,service_id'),
      agendaSupabaseRequest('/rest/v1/za_appointments?select=id,reference,status,source,starts_at,ends_at,notes,za_customers(full_name,phone),za_services(name,duration_minutes),za_resources(name),za_locations(name)&order=starts_at.asc'),
      agendaSupabaseRequest('/rest/v1/za_availability_rules?select=id,resource_id,day_of_week,starts_at,ends_at,active&order=day_of_week.asc,starts_at.asc'),
      agendaSupabaseRequest('/rest/v1/za_feedback_items?select=id,rating,correction_text,status,created_at&order=created_at.desc&limit=30')
    ]);
    const resourceCatalog = resources.map(resource => ({
      ...resource,
      services: links.filter(link => link.resource_id === resource.id).map(link => services.find(service => service.id === link.service_id)?.name).filter(Boolean)
    }));
    return {
      mode: 'customer_supabase',
      config: { timezone: config.timezone, confirmation_mode: config.confirmation_mode, reminder_hours: config.reminder_hours, cancellation_policy: config.cancellation_policy, rules: config.rules },
      catalog: { locations, services, resources: resourceCatalog },
      appointments: appointments.map(item => ({
        id: item.id, reference: item.reference, status: item.status, source: item.source, starts_at: item.starts_at,
        duration_minutes: item.za_services?.duration_minutes, notes: item.notes, customer_name: item.za_customers?.full_name,
        customer_phone: item.za_customers?.phone, service: item.za_services?.name, resource: item.za_resources?.name, location: item.za_locations?.name
      })),
      blocks: [],
      availabilityRules: availabilityRules.map(rule => ({ ...rule, resource: resources.find(resource => resource.id === rule.resource_id)?.name || 'Recurso eliminado' })),
      feedback
    };
  }
  const state = await loadAgendaState(packageData);
  return {
    mode: 'local_preview_state',
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
    feedback: []
  };
}

export async function createAgendaAppointment(packageData, input, source = 'client_console') {
  const config = agendaConfig(packageData);
  if (!config) throw new Error('Agenda v1 no está habilitada en este paquete.');
  const dashboard = await getAgendaDashboard(packageData);
  const state = await loadAgendaState(packageData);
  const serviceName = cleanText(input.service);
  const resourceName = cleanText(input.resource);
  const customerName = cleanText(input.customer_name);
  const customerPhone = cleanText(input.customer_phone, 40);
  const startsAt = asIso(input.starts_at);
  const service = dashboard.catalog.services.find(item => item.name === serviceName);
  const resource = dashboard.catalog.resources.find(item => item.name === resourceName);
  if (!service || !resource) throw new Error('El servicio o profesional seleccionado no existe en este paquete.');
  if (!customerName || (config.rules?.require_customer_phone && !customerPhone) || !startsAt) {
    throw new Error('Para reservar se necesita nombre, teléfono, servicio, profesional y fecha/hora válida.');
  }
  if (new Date(startsAt).getTime() < Date.now()) throw new Error('No se pueden crear reservas en el pasado.');
  const minimumNotice = Number(config.rules?.minimum_notice_hours || 0) * 3_600_000;
  if (new Date(startsAt).getTime() - Date.now() < minimumNotice) throw new Error('El horario no cumple el aviso mínimo configurado.');
  const maximumAdvance = Number(config.rules?.maximum_advance_days || 730) * 86_400_000;
  if (new Date(startsAt).getTime() - Date.now() > maximumAdvance) throw new Error('El horario supera la anticipación máxima configurada.');
  if (supabaseSettings()) {
    const location = dashboard.catalog.locations.find(item => item.name === cleanText(input.location));
    const result = await agendaSupabaseRequest('/rest/v1/rpc/za_request_appointment', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
        p_customer_name: customerName, p_customer_phone: customerPhone, p_service_id: service.id, p_resource_id: resource.id,
        p_starts_at: startsAt, p_source: source, p_location_id: location?.id || resource.location_id || null,
        p_notes: cleanText(input.notes, 800), p_confirmation_mode: config.confirmation_mode,
        p_minimum_notice_hours: Number(config.rules?.minimum_notice_hours || 0),
        p_maximum_advance_days: Number(config.rules?.maximum_advance_days || 730)
      })
    });
    const appointment = Array.isArray(result) ? result[0] : result;
    return { ...appointment, customer_name: customerName, customer_phone: customerPhone, service: serviceName, resource: resourceName, location: location?.name || '' };
  }
  const duration = Number(service.duration_minutes) || 30;
  const startTime = new Date(startsAt).getTime();
  if (!isWithinLocalAvailability(state, resourceName, startsAt, duration, config.timezone || 'America/Santiago')) {
    throw new Error('Horario fuera de disponibilidad. Define horarios explícitos para este profesional antes de reservar.');
  }
  const conflict = state.appointments.find(item => item.resource === resourceName && !['cancelled', 'rejected'].includes(item.status)
    && overlaps(startTime, duration, new Date(item.starts_at).getTime(), Number(item.duration_minutes) || 30));
  if (conflict) throw new Error('Ese profesional ya tiene una reserva que se cruza con el horario solicitado.');
  const appointment = {
    id: `apt_${randomUUID()}`,
    reference: `ZA-${randomUUID().slice(0, 8).toUpperCase()}`,
    created_at: new Date().toISOString(),
    source,
    status: config.confirmation_mode === 'automatic' ? 'confirmed' : 'pending_confirmation',
    customer_name: customerName,
    customer_phone: customerPhone,
    service: serviceName,
    resource: resourceName,
    location: cleanText(input.location) || state.catalog.locations[0]?.name || '',
    starts_at: startsAt,
    duration_minutes: duration,
    notes: cleanText(input.notes, 800)
  };
  state.appointments.push(appointment);
  await saveAgendaState(packageData, state);
  return appointment;
}

export async function updateAgendaAppointment(packageData, id, status) {
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
    return Array.isArray(result) ? result[0] : result;
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
    const conflict = state.appointments.find(item => item.id !== appointment.id && item.resource === appointment.resource
      && !['cancelled', 'rejected'].includes(item.status)
      && overlaps(new Date(appointment.starts_at).getTime(), Number(appointment.duration_minutes) || 30, new Date(item.starts_at).getTime(), Number(item.duration_minutes) || 30));
    if (conflict) throw new Error('El horario ya fue ocupado por otra reserva.');
  }
  appointment.status = status;
  appointment.updated_at = new Date().toISOString();
  await saveAgendaState(packageData, state);
  return appointment;
}

// Disponibilidad real. En producción la calcula la RPC atómica; en preview local se genera desde las
// reglas de disponibilidad del recurso, excluyendo reservas que se cruzan y respetando el aviso mínimo.
// (El generador local usa la hora local del servidor; producción ancla la zona horaria en Postgres.)
export async function getAvailableSlots(packageData, { service, resource, date }) {
  const config = agendaConfig(packageData);
  if (!config) throw new Error('Agenda v1 no está habilitada en este paquete.');
  const dashboard = await getAgendaDashboard(packageData);
  const svc = dashboard.catalog.services.find(item => item.name === cleanText(service));
  const res = dashboard.catalog.resources.find(item => item.name === cleanText(resource));
  if (!svc || !res) throw new Error('Servicio o profesional no configurado.');
  if (supabaseSettings()) {
    const slots = await agendaSupabaseRequest('/rest/v1/rpc/za_available_slots', {
      method: 'POST', body: JSON.stringify({ p_service_id: svc.id, p_resource_id: res.id, p_date: date, p_interval_minutes: config.rules?.slot_interval_minutes || 15 })
    });
    return (slots || []).map(item => item.starts_at);
  }
  const state = await loadAgendaState(packageData);
  const timeZone = config.timezone || 'America/Santiago';
  const day = localDayOfWeek(zonedDateTimeToUtc(date, '12:00', timeZone), timeZone);
  const rules = (state.availabilityRules || []).filter(rule => rule.resource === res.name && Number(rule.day_of_week) === day && rule.active !== false);
  const duration = Number(svc.duration_minutes) || 30;
  const interval = Number(config.rules?.slot_interval_minutes) || 15;
  const minimumNotice = Number(config.rules?.minimum_notice_hours || 0) * 3_600_000;
  const now = Date.now();
  const busy = state.appointments.filter(item => item.resource === res.name && !['cancelled', 'rejected'].includes(item.status));
  const slots = [];
  for (const rule of rules) {
    const [sh, sm] = String(rule.starts_at).split(':').map(Number);
    const [eh, em] = String(rule.ends_at).split(':').map(Number);
    const windowEnd = zonedDateTimeToUtc(date, `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`, timeZone);
    const cursor = zonedDateTimeToUtc(date, `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`, timeZone);
    while (cursor.getTime() + duration * 60_000 <= windowEnd.getTime()) {
      const slotStart = cursor.getTime();
      const clashes = busy.some(item => overlaps(slotStart, duration, new Date(item.starts_at).getTime(), Number(item.duration_minutes) || 30));
      if (!clashes && slotStart > now && slotStart - now >= minimumNotice) slots.push(new Date(slotStart).toISOString());
      cursor.setTime(cursor.getTime() + interval * 60_000);
    }
  }
  return slots;
}

export async function rescheduleAgendaAppointment(packageData, { id, new_starts_at }) {
  const config = agendaConfig(packageData);
  if (!config) throw new Error('Agenda v1 no está habilitada en este paquete.');
  const startsAt = asIso(new_starts_at);
  if (!startsAt) throw new Error('Fecha/hora nueva inválida.');
  if (supabaseSettings()) {
    const result = await agendaSupabaseRequest('/rest/v1/rpc/za_reschedule_appointment', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
        p_appointment_id: id, p_new_starts_at: startsAt,
        p_minimum_notice_hours: Number(config.rules?.minimum_notice_hours || 0),
        p_maximum_advance_days: Number(config.rules?.maximum_advance_days || 730),
        p_confirmation_mode: config.confirmation_mode || 'manual'
      })
    });
    return Array.isArray(result) ? result[0] : result;
  }
  const state = await loadAgendaState(packageData);
  const appointment = state.appointments.find(item => item.id === id);
  if (!appointment) throw new Error('Reserva no encontrada.');
  if (['cancelled', 'rejected', 'completed', 'no_show'].includes(appointment.status)) throw new Error('Esa reserva ya no se puede reagendar.');
  const target = new Date(startsAt).getTime();
  if (target < Date.now()) throw new Error('No se puede reagendar al pasado.');
  if (target - Date.now() < Number(config.rules?.minimum_notice_hours || 0) * 3_600_000) throw new Error('El nuevo horario no cumple el aviso mínimo configurado.');
  if (target - Date.now() > Number(config.rules?.maximum_advance_days || 730) * 86_400_000) throw new Error('El nuevo horario supera la anticipación máxima configurada.');
  const duration = Number(appointment.duration_minutes) || 30;
  const conflict = state.appointments.find(item => item.id !== appointment.id && item.resource === appointment.resource
    && !['cancelled', 'rejected'].includes(item.status)
    && overlaps(target, duration, new Date(item.starts_at).getTime(), Number(item.duration_minutes) || 30));
  if (conflict) throw new Error('Ese profesional ya tiene una reserva que se cruza con el nuevo horario.');
  appointment.starts_at = startsAt;
  appointment.status = config.confirmation_mode === 'automatic' ? 'confirmed' : 'pending_confirmation';
  appointment.updated_at = new Date().toISOString();
  await saveAgendaState(packageData, state);
  return appointment;
}

// Instalación idempotente: traduce el catálogo aprobado del paquete hacia el Supabase del cliente.
// Horarios semanales se configuran después desde el dashboard, porque nunca deben inferirse desde texto libre.
export async function seedAgendaCatalog(packageData) {
  const config = agendaConfig(packageData);
  if (!config) throw new Error('Agenda v1 no está habilitada en este paquete.');
  if (!agendaUsesSupabase()) throw new Error('Configura SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY antes de sembrar Agenda.');
  const [existingLocations, existingServices, existingResources] = await Promise.all([
    agendaSupabaseRequest('/rest/v1/za_locations?select=id,name'),
    agendaSupabaseRequest('/rest/v1/za_services?select=id,name'),
    agendaSupabaseRequest('/rest/v1/za_resources?select=id,name')
  ]);
  const byName = list => new Map((list || []).map(item => [item.name, item]));
  const locations = byName(existingLocations); const services = byName(existingServices); const resources = byName(existingResources);
  let createdLocations = 0; let createdServices = 0; let createdResources = 0;
  for (const item of config.locations || []) {
    if (!item?.name || locations.has(item.name)) continue;
    const rows = await agendaSupabaseRequest('/rest/v1/za_locations', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: item.name, address: item.address || '', timezone: config.timezone }) });
    locations.set(item.name, rows[0]); createdLocations++;
  }
  for (const item of config.services || []) {
    if (!item?.name || services.has(item.name)) continue;
    const rows = await agendaSupabaseRequest('/rest/v1/za_services', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: item.name, duration_minutes: Number(item.duration_minutes) || 30, price_clp: item.price_clp ?? null }) });
    services.set(item.name, rows[0]); createdServices++;
  }
  for (const item of config.resources || []) {
    if (!item?.name || resources.has(item.name)) continue;
    const rows = await agendaSupabaseRequest('/rest/v1/za_resources', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: item.name, specialty: item.specialty || '', location_id: locations.values().next().value?.id || null }) });
    resources.set(item.name, rows[0]); createdResources++;
  }
  for (const item of config.resources || []) {
    const resource = resources.get(item.name);
    for (const serviceName of item.services || []) {
      const service = services.get(serviceName);
      if (!resource || !service) continue;
      await agendaSupabaseRequest('/rest/v1/za_resource_services?on_conflict=resource_id,service_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ resource_id: resource.id, service_id: service.id }) });
    }
  }
  return { locations: locations.size, services: services.size, resources: resources.size, created: { locations: createdLocations, services: createdServices, resources: createdResources } };
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

export async function updateAgendaFeedback(packageData, feedbackId, status) {
  if (!['new', 'reviewing', 'resolved', 'dismissed'].includes(status)) throw new Error('Estado de feedback inválido.');
  if (!agendaUsesSupabase()) throw new Error('El feedback productivo requiere Supabase configurado.');
  const rows = await agendaSupabaseRequest(`/rest/v1/za_feedback_items?id=eq.${encodeURIComponent(feedbackId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status, ...(status === 'resolved' ? { resolved_at: new Date().toISOString() } : {}) })
  });
  if (!rows?.[0]) throw new Error('Feedback no encontrado.');
  return rows[0];
}
