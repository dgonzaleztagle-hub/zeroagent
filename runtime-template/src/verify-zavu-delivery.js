import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  sendZavuWhatsApp, verifyZavuSignature, zavuDeliveryUpdate, zavuEventId, zavuProviderMessage
} from './zavu.js';

const calls = [];
const client = {
  messages: {
    async send(payload, options) {
      calls.push({ payload, options });
      return { message: { id: 'provider-1', status: 'queued' } };
    }
  }
};
const sent = await sendZavuWhatsApp('+56911111111', 'Hola', {
  client, senderId: 'sender-test', idempotencyKey: 'zavu:out:event-1', timeoutMs: 1
});
assert.equal(sent.message.id, 'provider-1');
assert.deepEqual(calls[0], {
  payload: {
    to: '+56911111111', channel: 'whatsapp', text: 'Hola',
    'Zavu-Sender': 'sender-test', idempotencyKey: 'zavu:out:event-1'
  },
  options: { timeout: 3_000, maxRetries: 2 }
});

const replayClient = {
  messages: {
    async send() {
      throw { status: 409, error: { data: { message: { id: 'provider-original', status: 'sent' } } } };
    }
  }
};
const replay = await sendZavuWhatsApp('+56911111111', 'Hola', {
  client: replayClient, senderId: 'sender-test', idempotencyKey: 'zavu:out:event-1'
});
assert.equal(replay.idempotentReplay, true);
assert.deepEqual(zavuProviderMessage(replay), { id: 'provider-original', status: 'sent' });

assert.deepEqual(zavuDeliveryUpdate({
  type: 'message.delivered', data: { messageId: 'provider-1', status: 'delivered' }
}), { providerMessageId: 'provider-1', status: 'delivered', failureReason: '' });
assert.deepEqual(zavuDeliveryUpdate({
  type: 'message.failed', data: { messageId: 'provider-2', error: { message: 'carrier rejected' } }
}), { providerMessageId: 'provider-2', status: 'failed', failureReason: 'carrier rejected' });
assert.equal(zavuDeliveryUpdate({ type: 'message.inbound', data: {} }), null);

const rawWithoutId = '{"type":"message.inbound","data":{"text":"hola"}}';
assert.equal(zavuEventId(JSON.parse(rawWithoutId), rawWithoutId), zavuEventId(JSON.parse(rawWithoutId), rawWithoutId));
assert.match(zavuEventId(JSON.parse(rawWithoutId), rawWithoutId), /^sha256:[a-f0-9]{64}$/);

const timestamp = Math.floor(Date.now() / 1000);
const webhookBody = '{"id":"event-1"}';
const signature = createHmac('sha256', 'secret').update(webhookBody).digest('hex');
assert.equal(verifyZavuSignature(webhookBody, `t=${timestamp},v1=${signature}`, 'secret'), true);

// Mock offline de PostgREST: prueba que el inbound/outbound estable se inserta una
// sola vez y que el mensaje actual puede excluirse del history del LLM.
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-test-key';
const rows = [];
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const body = options.body ? JSON.parse(options.body) : null;
  if (options.method === 'POST' && parsed.pathname.endsWith('/za_conversation_messages')) {
    if (rows.some(row => row.client_message_id === body.client_message_id)) return response([]);
    const row = { id: `row-${rows.length + 1}`, created_at: new Date(1_700_000_000_000 + rows.length).toISOString(), ...body };
    rows.push(row);
    return response([row]);
  }
  if (options.method === 'PATCH') {
    const key = parsed.searchParams.has('id') ? 'id' : 'provider_message_id';
    const value = parsed.searchParams.get(key)?.replace(/^eq\./, '');
    const row = rows.find(item => item[key] === value);
    const allowed = parsed.searchParams.get('delivery_status')?.replace(/^in\.\(|\)$/g, '').split(',').filter(Boolean);
    const matchesStatus = !allowed?.length || allowed.includes(row?.delivery_status);
    if (row && matchesStatus) Object.assign(row, body);
    return response(row && matchesStatus ? [row] : []);
  }
  if (parsed.searchParams.has('client_message_id')) {
    const id = parsed.searchParams.get('client_message_id')?.replace(/^eq\./, '');
    return response(rows.filter(row => row.client_message_id === id));
  }
  if (parsed.searchParams.has('conversation_id')) {
    return response([...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }
  return response([]);
};
function response(value) {
  return { ok: true, status: 200, async text() { return JSON.stringify(value); } };
}

const {
  appendConversationMessage, loadConversationHistory, updateConversationMessageDelivery
} = await import('./conversations.js');
const inboundKey = 'zavu:in:provider-in-1';
const inboundA = await appendConversationMessage('conversation-1', 'inbound', 'mensaje actual', {}, {
  senderType: 'human', deliveryStatus: 'delivered', clientMessageId: inboundKey, providerMessageId: 'provider-in-1'
});
const inboundB = await appendConversationMessage('conversation-1', 'inbound', 'mensaje actual', {}, {
  senderType: 'human', deliveryStatus: 'delivered', clientMessageId: inboundKey, providerMessageId: 'provider-in-1'
});
assert.equal(inboundA.id, inboundB.id);
assert.equal(rows.length, 1);
await appendConversationMessage('conversation-1', 'outbound', 'respuesta anterior', {}, {
  deliveryStatus: 'sent', clientMessageId: 'zavu:out:previous', providerMessageId: 'provider-out-previous'
});
const history = await loadConversationHistory('conversation-1', 20, { excludeClientMessageId: inboundKey });
assert.deepEqual(history, [{ role: 'assistant', content: 'respuesta anterior' }]);
const delivered = await updateConversationMessageDelivery({ providerMessageId: 'provider-out-previous', status: 'delivered' });
assert.equal(delivered.delivery_status, 'delivered');
assert.ok(delivered.delivered_at);
const lateSent = await updateConversationMessageDelivery({ providerMessageId: 'provider-out-previous', status: 'sent' });
assert.equal(lateSent, null);
assert.equal(rows.find(row => row.provider_message_id === 'provider-out-previous').delivery_status, 'delivered');

console.log('Zavu delivery/idempotency offline: OK');
