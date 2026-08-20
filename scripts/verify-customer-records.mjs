import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://customer-records.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('/rpc/za_update_customer_intake')) {
    return new Response(JSON.stringify({ customer_id: 'customer-1', entry_ids: ['entry-1'] }), { status: 200 });
  }
  if (pathname.endsWith('/za_customer_record_entries') && options.method === 'POST') {
    return new Response(JSON.stringify([{ id: 'entry-2', ...JSON.parse(options.body) }]), { status: 201 });
  }
  if (pathname.endsWith('/za_customer_record_entries')) {
    return new Response(JSON.stringify([{ id: 'entry-1', value: 'Dato declarado' }]), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

const {
  updateCustomerIntakeRecord,
  listCustomerRecord,
  appendCustomerRecordEntry
} = await import('../runtime-template/src/customer-records.js');

const updated = await updateCustomerIntakeRecord({}, '+56 9 1111 2222', {
  age: 34,
  occupation: 'Diseñadora',
  medical_history: 'Dato declarado por la persona'
}, {
  source: 'whatsapp',
  messageId: 'wamid-1',
  operationKey: 'zavu:event-1',
  createdBy: 'agent'
});
assert.equal(updated.customer_id, 'customer-1');
const rpc = calls.find(call => call.url.includes('/rpc/za_update_customer_intake'));
const rpcBody = JSON.parse(rpc.options.body);
assert.equal(rpcBody.p_phone, '56911112222');
assert.equal(rpcBody.p_source_message_id, 'wamid-1');
assert.equal(rpcBody.p_operation_key, 'zavu:event-1');
assert.equal(rpcBody.p_fields.occupation, 'Diseñadora');

const listed = await listCustomerRecord('customer-1');
assert.equal(listed.entries[0].id, 'entry-1');

const appended = await appendCustomerRecordEntry('customer-1', {
  entryType: 'follow_up',
  label: 'Seguimiento',
  value: 'La persona informa una evolución favorable.',
  source: 'client_console',
  operationKey: 'console:note-1'
});
assert.equal(appended.id, 'entry-2');
assert.equal(appended.created_by, 'operator');

await assert.rejects(
  () => appendCustomerRecordEntry('customer-1', { entryType: 'diagnosis', value: 'No permitido' }),
  /inválida/i
);

console.log('PASS customer records: ingesta idempotente, lectura, seguimiento y allowlist validados.');
