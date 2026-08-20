import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const anonKey = process.env.SUPABASE_ANON_KEY || '';
if (!baseUrl || !serviceKey || !anonKey) {
  throw new Error('Define SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y SUPABASE_ANON_KEY para ejecutar staging real.');
}

async function raw(pathname, { method = 'GET', body, key = serviceKey, prefer = '' } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { response, data, text };
}

async function ok(pathname, options) {
  const result = await raw(pathname, options);
  if (!result.response.ok) throw new Error(`${options?.method || 'GET'} ${pathname} → ${result.response.status}: ${result.text}`);
  return result.data;
}

async function mustFail(pathname, options, expected) {
  const result = await raw(pathname, options);
  assert.equal(result.response.ok, false, `${pathname} debía ser rechazado.`);
  if (expected) assert.match(result.text, expected, `${pathname} falló por una causa inesperada.`);
  return result;
}

const suffix = randomUUID().slice(0, 8);
const locationId = randomUUID();
const serviceId = randomUUID();
const resourceId = randomUUID();
const conversationId = randomUUID();
const phone = `+56977${Date.now().toString().slice(-6)}`;
const wrongPhone = '+56900000000';
const externalId = `qa-${suffix}`;
let appointmentId = null;
let outboxId = null;
let blockId = null;

const start = new Date(Date.now() + 14 * 86_400_000);
start.setUTCHours(12, 0, 0, 0);
const moveTo = new Date(start.getTime());
moveTo.setUTCHours(14, 0, 0, 0);

try {
  await ok('/rest/v1/za_locations', { method: 'POST', prefer: 'return=minimal', body: { id: locationId, name: `QA Location ${suffix}`, timezone: 'UTC' } });
  await ok('/rest/v1/za_services', { method: 'POST', prefer: 'return=minimal', body: { id: serviceId, name: `QA Service ${suffix}`, duration_minutes: 60, price_clp: 1000 } });
  await ok('/rest/v1/za_resources', { method: 'POST', prefer: 'return=minimal', body: { id: resourceId, location_id: locationId, name: `QA Resource ${suffix}` } });
  await ok('/rest/v1/za_resource_services', { method: 'POST', prefer: 'return=minimal', body: { resource_id: resourceId, service_id: serviceId } });
  await ok('/rest/v1/za_availability_rules', { method: 'POST', prefer: 'return=minimal', body: { resource_id: resourceId, day_of_week: start.getUTCDay(), starts_at: '09:00', ends_at: '18:00' } });

  await mustFail('/rest/v1/rpc/za_available_slots', {
    method: 'POST', key: anonKey, body: { p_service_id: serviceId, p_resource_id: resourceId, p_date: start.toISOString().slice(0, 10), p_interval_minutes: 15 }
  });

  const created = await ok('/rest/v1/rpc/za_request_appointment', {
    method: 'POST', body: {
      p_customer_name: 'Cliente QA', p_customer_phone: phone, p_service_id: serviceId, p_resource_id: resourceId,
      p_starts_at: start.toISOString(), p_source: 'staff', p_location_id: locationId, p_notes: 'staging integration',
      p_confirmation_mode: 'manual', p_minimum_notice_hours: 2, p_maximum_advance_days: 60
    }
  });
  const appointment = Array.isArray(created) ? created[0] : created;
  appointmentId = appointment.id;
  assert.equal(appointment.status, 'pending_confirmation');
  assert.ok(appointment.expires_at && new Date(appointment.expires_at) > new Date(), 'La solicitud manual no recibió expires_at.');

  const exactRetryResult = await ok('/rest/v1/rpc/za_request_appointment', {
    method: 'POST', body: {
      p_customer_name: 'Cliente QA', p_customer_phone: phone, p_service_id: serviceId, p_resource_id: resourceId,
      p_starts_at: start.toISOString(), p_source: 'staff', p_location_id: locationId,
      p_confirmation_mode: 'manual', p_minimum_notice_hours: 2, p_maximum_advance_days: 60
    }
  });
  assert.equal((Array.isArray(exactRetryResult) ? exactRetryResult[0] : exactRetryResult).id, appointmentId, 'Un retry exacto creó una segunda cita.');

  const futureSessionResult = await ok('/rest/v1/rpc/za_request_appointment', {
    method: 'POST', body: {
      p_customer_name: 'Cliente QA', p_customer_phone: phone, p_service_id: serviceId, p_resource_id: resourceId,
      p_starts_at: new Date(start.getTime() + 60 * 60_000).toISOString(), p_source: 'staff', p_location_id: locationId,
      p_confirmation_mode: 'manual', p_minimum_notice_hours: 2, p_maximum_advance_days: 60
    }
  });
  assert.notEqual((Array.isArray(futureSessionResult) ? futureSessionResult[0] : futureSessionResult).id, appointmentId, 'El anti-duplicado bloqueó una sesión futura distinta.');

  await mustFail('/rest/v1/rpc/za_request_appointment', {
    method: 'POST', body: {
      p_customer_name: 'Cruce QA', p_customer_phone: `${phone}1`, p_service_id: serviceId, p_resource_id: resourceId,
      p_starts_at: new Date(start.getTime() + 30 * 60_000).toISOString(), p_source: 'staff', p_location_id: locationId,
      p_confirmation_mode: 'automatic', p_minimum_notice_hours: 2, p_maximum_advance_days: 60
    }
  }, /Horario ya ocupado/i);

  const blockRows = await ok('/rest/v1/za_availability_blocks', {
    method: 'POST', prefer: 'return=representation', body: { resource_id: resourceId, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 60 * 60_000).toISOString(), reason: 'QA confirm invariant' }
  });
  blockId = blockRows[0].id;
  await mustFail('/rest/v1/rpc/za_transition_appointment', {
    method: 'POST', body: { p_appointment_id: appointmentId, p_new_status: 'confirmed', p_expected_status: 'pending_confirmation' }
  }, /bloqueado/i);
  await ok(`/rest/v1/za_availability_blocks?id=eq.${blockId}`, { method: 'DELETE', prefer: 'return=minimal' });
  blockId = null;
  const confirmed = await ok('/rest/v1/rpc/za_transition_appointment', {
    method: 'POST', body: { p_appointment_id: appointmentId, p_new_status: 'confirmed', p_expected_status: 'pending_confirmation' }
  });
  assert.equal((Array.isArray(confirmed) ? confirmed[0] : confirmed).status, 'confirmed');
  await mustFail('/rest/v1/rpc/za_transition_appointment', {
    method: 'POST', body: { p_appointment_id: appointmentId, p_new_status: 'pending_confirmation', p_expected_status: 'confirmed' }
  }, /Transición de estado no permitida/i);
  await mustFail('/rest/v1/rpc/za_reschedule_appointment', {
    method: 'POST', body: { p_appointment_id: appointmentId, p_new_starts_at: moveTo.toISOString(), p_requester_phone: wrongPhone, p_minimum_notice_hours: 2, p_maximum_advance_days: 60 }
  }, /no pertenece al teléfono verificado/i);
  const moved = await ok('/rest/v1/rpc/za_reschedule_appointment', {
    method: 'POST', body: { p_appointment_id: appointmentId, p_new_starts_at: moveTo.toISOString(), p_requester_phone: phone, p_minimum_notice_hours: 2, p_maximum_advance_days: 60, p_confirmation_mode: 'manual' }
  });
  assert.equal(new Date((Array.isArray(moved) ? moved[0] : moved).starts_at).toISOString(), moveTo.toISOString());
  assert.equal((Array.isArray(moved) ? moved[0] : moved).status, 'pending_confirmation', 'Un reagendamiento manual no puede auto-confirmarse.');

  const expiringStart = new Date(start.getTime() + 4 * 60 * 60_000);
  const expiringResult = await ok('/rest/v1/rpc/za_request_appointment', {
    method: 'POST', body: {
      p_customer_name: 'Expira QA', p_customer_phone: `${phone}2`, p_service_id: serviceId, p_resource_id: resourceId,
      p_starts_at: expiringStart.toISOString(), p_source: 'staff', p_location_id: locationId,
      p_confirmation_mode: 'manual', p_minimum_notice_hours: 2, p_maximum_advance_days: 60
    }
  });
  const expiring = Array.isArray(expiringResult) ? expiringResult[0] : expiringResult;
  await ok(`/rest/v1/za_appointments?id=eq.${expiring.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { expires_at: new Date(Date.now() - 60_000).toISOString() } });
  await mustFail('/rest/v1/rpc/za_transition_appointment', {
    method: 'POST', body: { p_appointment_id: expiring.id, p_new_status: 'confirmed', p_expected_status: 'pending_confirmation' }
  }, /venció/i);
  const replacementResult = await ok('/rest/v1/rpc/za_request_appointment', {
    method: 'POST', body: {
      p_customer_name: 'Expira QA', p_customer_phone: `${phone}2`, p_service_id: serviceId, p_resource_id: resourceId,
      p_starts_at: expiringStart.toISOString(), p_source: 'staff', p_location_id: locationId,
      p_confirmation_mode: 'manual', p_minimum_notice_hours: 2, p_maximum_advance_days: 60
    }
  });
  assert.notEqual((Array.isArray(replacementResult) ? replacementResult[0] : replacementResult).id, expiring.id, 'Una solicitud vencida siguió bloqueando la hora.');

  await ok('/rest/v1/za_conversations', { method: 'POST', prefer: 'return=minimal', body: { id: conversationId, channel: 'whatsapp', external_id: externalId } });
  const handoffResult = await ok('/rest/v1/rpc/za_request_handoff', {
    method: 'POST', body: { p_conversation_id: conversationId, p_reason: 'Prueba atómica staging', p_caller_phone: phone }
  });
  const handoff = Array.isArray(handoffResult) ? handoffResult[0] : handoffResult;
  outboxId = handoff.event_id;
  const [conversationRows, outboxRows] = await Promise.all([
    ok(`/rest/v1/za_conversations?id=eq.${conversationId}&select=status,needs_human`),
    ok(`/rest/v1/za_outbox_events?id=eq.${outboxId}&select=event_type,status`)
  ]);
  assert.deepEqual(conversationRows[0], { status: 'handoff', needs_human: true });
  assert.equal(outboxRows[0]?.event_type, 'human_handoff_requested');

  console.log('PASS · Supabase staging validó permisos, colisiones, estados, identidad, reagendamiento y handoff atómico.');
} finally {
  const deletes = [
    outboxId && `/rest/v1/za_outbox_events?id=eq.${outboxId}`,
    blockId && `/rest/v1/za_availability_blocks?id=eq.${blockId}`,
    `/rest/v1/za_conversations?id=eq.${conversationId}`,
    `/rest/v1/za_appointments?resource_id=eq.${resourceId}`,
    `/rest/v1/za_customers?phone=eq.${encodeURIComponent(phone)}`,
    `/rest/v1/za_customers?phone=eq.${encodeURIComponent(`${phone}2`)}`,
    `/rest/v1/za_availability_rules?resource_id=eq.${resourceId}`,
    `/rest/v1/za_resource_services?resource_id=eq.${resourceId}`,
    `/rest/v1/za_resources?id=eq.${resourceId}`,
    `/rest/v1/za_services?id=eq.${serviceId}`,
    `/rest/v1/za_locations?id=eq.${locationId}`
  ].filter(Boolean);
  for (const pathname of deletes) {
    const result = await raw(pathname, { method: 'DELETE', prefer: 'return=minimal' });
    if (!result.response.ok) console.warn(`WARN · limpieza ${pathname} → ${result.response.status}`);
  }
}
