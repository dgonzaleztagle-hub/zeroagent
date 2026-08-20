import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const clamp = (value, minimum, maximum, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};

function replayMessage(error) {
  return error?.error?.message
    || error?.error?.originalMessage
    || error?.error?.data?.message
    || error?.error?.data
    || null;
}

// Zavu acepta idempotencyKey en el cuerpo de messages.send. El mismo valor debe
// sobrevivir todos los reintentos de una operación; un 409 es la confirmación de
// que Zavu ya recibió esa operación, no un motivo para generar otra clave.
export async function sendZavuWhatsApp(to, text, options = {}) {
  const recipient = String(to || '').trim();
  const content = String(text || '').trim();
  if (!recipient || !content) throw new Error('Destinatario y mensaje Zavu son obligatorios.');

  let zavu = options.client;
  if (!zavu) {
    if (!process.env.ZAVUDEV_API_KEY || !process.env.ZAVUDEV_SENDER_ID) throw new Error('Zavu no está configurado.');
    const { default: Zavudev } = await import('@zavudev/sdk');
    zavu = new Zavudev({ apiKey: process.env.ZAVUDEV_API_KEY });
  }

  const idempotencyKey = String(options.idempotencyKey || '').trim().slice(0, 200);
  const timeout = clamp(options.timeoutMs ?? process.env.ZAVUDEV_TIMEOUT_MS, 3_000, 30_000, 15_000);
  const payload = {
    to: recipient,
    channel: 'whatsapp',
    text: content.slice(0, 8_000),
    'Zavu-Sender': options.senderId || process.env.ZAVUDEV_SENDER_ID
  };
  if (idempotencyKey) payload.idempotencyKey = idempotencyKey;

  try {
    return await zavu.messages.send(payload, { timeout, maxRetries: 2 });
  } catch (error) {
    if (Number(error?.status) !== 409 || !idempotencyKey) throw error;
    return { message: replayMessage(error), idempotentReplay: true };
  }
}

export function zavuEventId(event, rawBody = '') {
  const explicit = String(event?.id || '').trim();
  if (explicit) return explicit.slice(0, 240);
  return `sha256:${createHash('sha256').update(String(rawBody || JSON.stringify(event || {}))).digest('hex')}`;
}

export function zavuDeliveryUpdate(event) {
  const eventType = String(event?.type || '');
  const status = ({
    'message.queued': 'queued',
    'message.sent': 'sent',
    'message.delivered': 'delivered',
    'message.read': 'read',
    'message.failed': 'failed'
  })[eventType];
  if (!status) return null;
  const data = event?.data || {};
  return {
    providerMessageId: String(data.messageId || data.message_id || data.id || '').trim(),
    status,
    failureReason: status === 'failed'
      ? String(data.failureReason || data.failure_reason || data.error?.message || data.error || '').slice(0, 1_000)
      : ''
  };
}

export function zavuProviderMessage(result) {
  const message = result?.message || result?.data?.message || result?.data || result || {};
  if (typeof message === 'string') return { id: '', status: 'sent' };
  return {
    id: String(message?.id || message?.messageId || message?.message_id || '').trim(),
    status: String(message?.status || 'sent').toLowerCase()
  };
}

// Formato observado en tráfico real Zavu: HMAC-SHA256(secret, rawBody).
// El timestamp del header es anti-replay; no se concatena al body para el hash.
export function verifyZavuSignature(rawBody, header, secret, nowMs = Date.now()) {
  const parts = String(header || '').split(',').map(part => part.trim());
  const timestamp = Number(parts.find(part => part.startsWith('t='))?.slice(2));
  const signature = parts.find(part => part.startsWith('v1='))?.slice(3);
  if (!timestamp || !signature || Math.abs(nowMs / 1000 - timestamp) > 300) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  try { return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; }
}
