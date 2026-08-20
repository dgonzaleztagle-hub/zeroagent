// Batería de integración real contra Supabase (staging del propio cliente — no hay ambiente
// separado hoy). A diferencia de verify-agenda-package.mjs (contrato/schema) y
// verify-supabase-staging.mjs (RPCs SQL puras), esto ejercita las funciones JS reales del runtime
// (agenda.js, agenda-tools.js, conversations.js) tal como las usa engine.js/server.js — el nivel
// donde vivían los bugs reales encontrados en la curación del 06/07-08-2026 (fecha pasada
// colándose por franja de riesgo, telefono sin normalizar, vínculo conversación-ficha que nunca
// llegaba, servicio ofrecido por un recurso que no lo hace). Crea datos QA con sufijo aleatorio y
// los borra en un `finally`, igual criterio que verify-supabase-staging.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SUPABASE_URL ||= '';
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY para ejecutar la integración real. Nunca contra producción con clientes reales.');
}

const importFrom = (relativePath) => import(pathToFileURL(path.join(root, relativePath)).href);
const { agendaSupabaseRequest, createAgendaAppointment, updateCustomerProfile, getAvailableSlots, seedAgendaCatalog } = await importFrom('runtime-template/src/agenda.js');
const { executeAgendaTool } = await importFrom('runtime-template/src/agenda-tools.js');
const { getOrCreateConversation } = await importFrom('runtime-template/src/conversations.js');

const suffix = randomUUID().slice(0, 8);
const locationId = randomUUID();
const serviceId = randomUUID();
const otherServiceId = randomUUID();
const resourceId = randomUUID();
const phone = `+56977${Date.now().toString().slice(-6)}`;

const packageData = {
  business: { id: `integration-qa-${suffix}` },
  solutions: { agenda: { config: {
    enabled: true, timezone: 'America/Santiago', confirmation_mode: 'manual',
    rules: { minimum_notice_hours: 1, maximum_advance_days: 60, pending_confirmation_ttl_minutes: 30, require_customer_phone: true, human_handoff_on_conflict: true },
    locations: [{ name: `QA Loc ${suffix}`, address: `QA Dirección ${suffix}` }],
    services: [{ name: `QA Servicio ${suffix}`, duration_minutes: 30, price_clp: 12345 }],
    resources: [{ name: `QA Prof ${suffix}`, specialty: `QA Especialidad ${suffix}`, services: [`QA Servicio ${suffix}`] }]
  } } }
};

const start = new Date(Date.now() + 3 * 86_400_000);
start.setUTCHours(14, 0, 0, 0);
const dateStr = start.toISOString().slice(0, 10);

let created = false;
try {
  await agendaSupabaseRequest('/rest/v1/za_locations', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id: locationId, name: `QA Loc ${suffix}`, timezone: 'America/Santiago' }) });
  await agendaSupabaseRequest('/rest/v1/za_services', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id: serviceId, name: `QA Servicio ${suffix}`, duration_minutes: 30, price_clp: 10000 }) });
  await agendaSupabaseRequest('/rest/v1/za_services', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id: otherServiceId, name: `QA Servicio Ajeno ${suffix}`, duration_minutes: 30, price_clp: 10000 }) });
  await agendaSupabaseRequest('/rest/v1/za_resources', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id: resourceId, location_id: locationId, name: `QA Prof ${suffix}` }) });
  await agendaSupabaseRequest('/rest/v1/za_resource_services', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ resource_id: resourceId, service_id: serviceId }) });
  // Vínculo obsoleto intencional: el seed reconciliable debe quitarlo porque no está en el paquete.
  await agendaSupabaseRequest('/rest/v1/za_resource_services', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ resource_id: resourceId, service_id: otherServiceId }) });
  await agendaSupabaseRequest('/rest/v1/za_availability_rules', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ resource_id: resourceId, day_of_week: start.getUTCDay(), starts_at: '09:00', ends_at: '20:00' }) });
  created = true;

  // Flujo 0: setup idempotente también actualiza catálogo y elimina vínculos obsoletos.
  const seeded = await seedAgendaCatalog(packageData);
  assert.ok(seeded.updated.locations >= 1 && seeded.updated.services >= 1 && seeded.updated.resources >= 1, `El seed no actualizó el catálogo existente: ${JSON.stringify(seeded)}`);
  const [seededLocation, seededService, seededResource, staleLinks] = await Promise.all([
    agendaSupabaseRequest(`/rest/v1/za_locations?id=eq.${locationId}&select=address`),
    agendaSupabaseRequest(`/rest/v1/za_services?id=eq.${serviceId}&select=price_clp`),
    agendaSupabaseRequest(`/rest/v1/za_resources?id=eq.${resourceId}&select=specialty`),
    agendaSupabaseRequest(`/rest/v1/za_resource_services?resource_id=eq.${resourceId}&service_id=eq.${otherServiceId}&select=resource_id`)
  ]);
  assert.equal(seededLocation[0].address, `QA Dirección ${suffix}`);
  assert.equal(seededService[0].price_clp, 12345);
  assert.equal(seededResource[0].specialty, `QA Especialidad ${suffix}`);
  assert.equal(staleLinks.length, 0, 'El seed dejó un vínculo resource-service que ya no existe en el paquete.');
  console.log('PASS · Flujo 0: el seed reconcilia inserts, updates y vínculos obsoletos.');

  // Flujo 1: primer mensaje de un paciente nuevo -> reserva -> conversación vinculada EN EL MISMO TURNO.
  const conv1 = await getOrCreateConversation('whatsapp', phone);
  assert.equal(conv1.customer_id, null, 'La conversación no debería tener cliente antes de la primera reserva.');
  const firstAppointment = await createAgendaAppointment(packageData, { customer_name: `QA Cliente ${suffix}`, customer_phone: phone, service: `QA Servicio ${suffix}`, resource: `QA Prof ${suffix}`, starts_at: start.toISOString() }, 'whatsapp');
  assert.ok(firstAppointment.expires_at, 'La solicitud manual no recibió expires_at en Supabase.');
  const exactRetry = await createAgendaAppointment(packageData, { customer_name: `QA Cliente ${suffix}`, customer_phone: phone, service: `QA Servicio ${suffix}`, resource: `QA Prof ${suffix}`, starts_at: start.toISOString() }, 'whatsapp');
  assert.equal(exactRetry.id, firstAppointment.id, 'El retry exacto creó una segunda fila en Supabase.');
  const conv1b = await getOrCreateConversation('whatsapp', phone);
  assert.ok(conv1b.customer_id, 'El vínculo conversación-cliente debe completarse en el mismo turno de la reserva, no esperar al siguiente mensaje.');
  console.log('PASS · Flujo 1: primer mensaje -> reserva -> conversación vinculada en el mismo turno.');

  // Flujo 2: mensaje posterior con antecedentes -> se guarda en la MISMA ficha.
  await updateCustomerProfile(packageData, phone, { age: 40, occupation: `QA Ocupación ${suffix}`, medical_history: 'Sin antecedentes relevantes (QA)' });
  const [customerRow] = await agendaSupabaseRequest(`/rest/v1/za_customers?id=eq.${encodeURIComponent(conv1b.customer_id)}&select=age,occupation,medical_history`);
  assert.equal(customerRow.age, 40);
  assert.equal(customerRow.occupation, `QA Ocupación ${suffix}`);
  console.log('PASS · Flujo 2: datos de ficha entregados después de agendar quedan en la misma ficha.');

  // Flujo 2b: una nueva sesión futura es válida, pero la reserva pública no pisa la ficha existente.
  const nextSession = await createAgendaAppointment(packageData, {
    customer_name: 'Nombre público adulterado', customer_phone: phone,
    customer_email: 'ataque@example.invalid', customer_age: 99, customer_occupation: 'Sobrescritura',
    customer_medical_history: 'Sobrescritura', customer_extra_symptoms: 'Sobrescritura',
    service: `QA Servicio ${suffix}`, resource: `QA Prof ${suffix}`, starts_at: new Date(start.getTime() + 60 * 60_000).toISOString()
  }, 'public_booking');
  assert.notEqual(nextSession.id, firstAppointment.id, 'El anti-duplicado bloqueó una sesión futura distinta.');
  const [preserved] = await agendaSupabaseRequest(`/rest/v1/za_customers?id=eq.${encodeURIComponent(conv1b.customer_id)}&select=full_name,email,age,occupation,medical_history,extra_symptoms`);
  assert.equal(preserved.full_name, `QA Cliente ${suffix}`);
  assert.equal(preserved.age, 40);
  assert.equal(preserved.occupation, `QA Ocupación ${suffix}`);
  assert.equal(preserved.medical_history, 'Sin antecedentes relevantes (QA)');
  assert.notEqual(preserved.email, 'ataque@example.invalid');
  console.log('PASS · Flujo 2b: sesiones futuras permitidas y reserva pública incapaz de pisar la ficha.');

  // Flujo 3: dos eventos de webhook simultáneos con el mismo event_id -> sólo uno gana el reclamo.
  const eventId = `qa-evt-${suffix}`;
  const claim = () => agendaSupabaseRequest('/rest/v1/za_webhook_events?on_conflict=event_id', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify({ event_id: eventId, source: 'zavu' })
  });
  const [claimA, claimB] = await Promise.all([claim(), claim()]);
  const wins = [claimA, claimB].filter(rows => Array.isArray(rows) && rows.length > 0).length;
  assert.equal(wins, 1, 'Dos entregas simultáneas del mismo event_id deben producir exactamente un ganador del reclamo.');
  console.log('PASS · Flujo 3: dos entregas simultáneas del mismo evento -> sólo una procesa.');

  // Flujo 4: formatos equivalentes de teléfono -> un solo cliente, no varios.
  // Móvil chileno real: 9 dígitos empezando en 9 (formato 9XXXXXXXX) — con otro largo,
  // normalizeChilePhone no tiene cómo saber si trae o no el código de país implícito.
  const phone2 = `+569${Date.now().toString().slice(-8)}`;
  const variants = [phone2.replace('+56', ''), phone2.replace('+', ''), phone2];
  for (const variant of variants) {
    // +5h de base para no chocar con el horario que ya ocupó el Flujo 1 en el mismo recurso.
    await createAgendaAppointment(packageData, { customer_name: `QA Formato ${suffix}`, customer_phone: variant, service: `QA Servicio ${suffix}`, resource: `QA Prof ${suffix}`, starts_at: new Date(start.getTime() + (5 + variants.indexOf(variant)) * 3_600_000).toISOString() }, 'whatsapp');
  }
  const matches = await agendaSupabaseRequest(`/rest/v1/za_customers?full_name=eq.${encodeURIComponent(`QA Formato ${suffix}`)}&select=id,phone`);
  assert.equal(matches.length, 1, `3 formatos del mismo teléfono deberían resolver a 1 cliente, encontré ${matches.length}: ${JSON.stringify(matches)}`);
  console.log('PASS · Flujo 4: formatos equivalentes de teléfono resuelven a un único cliente.');

  // Flujo 5: pedir un servicio que ese recurso NO ofrece -> disponibilidad y reserva rechazadas.
  await assert.rejects(() => getAvailableSlots(packageData, { service: `QA Servicio Ajeno ${suffix}`, resource: `QA Prof ${suffix}`, date: dateStr }), /no realiza ese servicio/i, 'get_availability debería rechazar un servicio no ofrecido por el recurso.');
  const toolResult = await executeAgendaTool(packageData, 'get_availability', { service: `QA Servicio Ajeno ${suffix}`, resource: `QA Prof ${suffix}`, date: dateStr }, { callerPhone: phone });
  assert.equal(toolResult.error, 'service_not_offered_by_resource', 'La tool get_availability debería devolver el error dedicado, no dejar pasar el pedido.');
  await assert.rejects(() => createAgendaAppointment(packageData, { customer_name: 'QA Rechazo', customer_phone: phone, service: `QA Servicio Ajeno ${suffix}`, resource: `QA Prof ${suffix}`, starts_at: start.toISOString() }, 'whatsapp'), /no realiza ese servicio/i, 'create_appointment (RPC) también debe rechazar un servicio no ofrecido por el recurso.');
  console.log('PASS · Flujo 5: servicio no asignado al recurso -> disponibilidad y reserva rechazadas en ambas capas.');

  console.log('PASS · Integración real de agenda: catálogo, CRM, deduplicación e invariantes pasan contra Supabase real.');
} finally {
  if (created) {
    await agendaSupabaseRequest(`/rest/v1/za_conversations?external_id=eq.${encodeURIComponent(phone)}`, { method: 'DELETE' }).catch(() => {});
    await agendaSupabaseRequest(`/rest/v1/za_appointments?resource_id=eq.${resourceId}`, { method: 'DELETE' }).catch(() => {});
    await agendaSupabaseRequest(`/rest/v1/za_customers?phone=eq.${encodeURIComponent(phone)}`, { method: 'DELETE' }).catch(() => {});
    await agendaSupabaseRequest(`/rest/v1/za_customers?full_name=eq.${encodeURIComponent(`QA Formato ${suffix}`)}`, { method: 'DELETE' }).catch(() => {});
    await agendaSupabaseRequest(`/rest/v1/za_webhook_events?event_id=eq.qa-evt-${suffix}`, { method: 'DELETE' }).catch(() => {});
    await agendaSupabaseRequest(`/rest/v1/za_availability_rules?resource_id=eq.${resourceId}`, { method: 'DELETE' }).catch(() => {});
    await agendaSupabaseRequest(`/rest/v1/za_resource_services?resource_id=eq.${resourceId}`, { method: 'DELETE' }).catch(() => {});
    await agendaSupabaseRequest(`/rest/v1/za_resources?id=eq.${resourceId}`, { method: 'DELETE' }).catch(() => {});
    await agendaSupabaseRequest(`/rest/v1/za_services?id=eq.${serviceId}`, { method: 'DELETE' }).catch(() => {});
    await agendaSupabaseRequest(`/rest/v1/za_services?id=eq.${otherServiceId}`, { method: 'DELETE' }).catch(() => {});
    await agendaSupabaseRequest(`/rest/v1/za_locations?id=eq.${locationId}`, { method: 'DELETE' }).catch(() => {});
  }
}
