import { createHash } from 'node:crypto';
import { agendaSupabaseRequest, agendaUsesSupabase, normalizeChilePhone, updateCustomerProfile } from './agenda.js';

const allowedEntryTypes = new Set(['intake_fact', 'service_note', 'follow_up', 'correction']);
const allowedSources = new Set(['whatsapp', 'client_console', 'import', 'manual']);

function clean(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function operationKey(phone, fields, sourceMessageId = '') {
  return `intake:${createHash('sha256').update(JSON.stringify({ phone, fields, sourceMessageId })).digest('hex')}`;
}

export async function updateCustomerIntakeRecord(packageData, phone, fields = {}, context = {}) {
  const normalizedPhone = normalizeChilePhone(phone).replace(/\D/g, '');
  if (!normalizedPhone) throw new Error('Teléfono inválido para actualizar la ficha de admisión.');
  const sanitized = {
    email: clean(fields.email, 320),
    rut: clean(fields.rut, 20),
    age: fields.age == null ? '' : String(Math.max(0, Math.min(130, Number(fields.age) || 0))),
    occupation: clean(fields.occupation, 180),
    medical_history: clean(fields.medical_history, 1200),
    extra_symptoms: clean(fields.extra_symptoms, 1200)
  };
  if (!Object.values(sanitized).some(Boolean)) throw new Error('No se recibió ningún dato de admisión.');
  if (!agendaUsesSupabase()) {
    await updateCustomerProfile(packageData, normalizedPhone, sanitized);
    return { preview: true, entry_ids: [] };
  }
  const sourceMessageId = clean(context.sourceMessageId || context.messageId, 240);
  return agendaSupabaseRequest('/rest/v1/rpc/za_update_customer_intake', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      p_phone: normalizedPhone,
      p_fields: sanitized,
      p_source: allowedSources.has(context.source) ? context.source : 'whatsapp',
      p_source_message_id: sourceMessageId || null,
      p_operation_key: clean(context.operationKey, 240) || operationKey(normalizedPhone, sanitized, sourceMessageId),
      p_created_by: clean(context.createdBy, 120) || 'agent'
    })
  });
}

export async function listCustomerRecord(customerId) {
  if (!agendaUsesSupabase()) return { entries: [] };
  const id = clean(customerId, 80);
  const entries = await agendaSupabaseRequest(`/rest/v1/za_customer_record_entries?customer_id=eq.${encodeURIComponent(id)}&select=*&order=created_at.desc&limit=500`);
  return { entries: entries || [] };
}

export async function appendCustomerRecordEntry(customerId, input = {}) {
  if (!agendaUsesSupabase()) throw new Error('El historial de atención requiere Supabase.');
  const entryType = clean(input.entry_type || input.entryType, 40);
  const source = clean(input.source || 'client_console', 40);
  const value = clean(input.value, 6000);
  if (!allowedEntryTypes.has(entryType) || !allowedSources.has(source) || !value) throw new Error('Entrada de ficha inválida.');
  const row = {
    customer_id: clean(customerId, 80),
    appointment_id: clean(input.appointment_id || input.appointmentId, 80) || null,
    entry_type: entryType,
    field_key: clean(input.field_key || input.fieldKey, 80) || null,
    label: clean(input.label, 180),
    value,
    source,
    source_message_id: clean(input.source_message_id || input.sourceMessageId, 240) || null,
    confidence: input.confidence == null ? null : Math.max(0, Math.min(1, Number(input.confidence))),
    confirmed: input.confirmed === true,
    supersedes_id: clean(input.supersedes_id || input.supersedesId, 80) || null,
    operation_key: clean(input.operation_key || input.operationKey, 240) || null,
    created_by: clean(input.created_by || input.createdBy, 120) || 'operator'
  };
  const result = await agendaSupabaseRequest('/rest/v1/za_customer_record_entries', {
    method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify(row)
  });
  return Array.isArray(result) ? result[0] : result;
}
