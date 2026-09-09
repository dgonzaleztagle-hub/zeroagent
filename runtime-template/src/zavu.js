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
  return sendZavuMessage(to, text, { ...options, channel: 'whatsapp' });
}

// Las alertas al DUEÑO no pueden salir por WhatsApp cuando el bot vive en su propio número:
// nadie se manda WhatsApp a sí mismo. El SMS sale por la red de Zavu, no por su número, así que
// sí le llega a ese mismo teléfono — y no depende de que instale ni configure nada, que es
// justo lo que se necesita para un dueño poco tecnológico con iPhone. Canal configurable por si
// mañana se habilita el canal de correo del sender (167 veces más barato por mensaje).
export async function sendZavuAlert(to, text, options = {}) {
  const channel = String(process.env.ALERT_CHANNEL || 'sms_oneway').trim() || 'sms_oneway';
  const send = body => sendZavuMessage(to, body, { ...options, channel, subject: options.subject || 'Aviso ZeroAgent' });
  try {
    return await send(text);
  } catch (error) {
    // Zavu rechaza un SMS con una URL que todavía no está verificada en la cuenta. Una alerta que
    // no llega es peor que una alerta sin link: se reintenta con el texto pelado. El reintento
    // lleva su propia clave de idempotencia porque su contenido es distinto — en el peor caso
    // (que el primero hubiera salido igual) llega un aviso repetido, que es preferible a ninguno.
    const withoutLink = text.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
    if (withoutLink === text || !withoutLink) throw error;
    console.error('[zavu] la alerta con link falló, se reintenta sin link:', error.message);
    const retryKey = options.idempotencyKey ? `${options.idempotencyKey}:nolink` : '';
    return sendZavuMessage(to, withoutLink, {
      ...options, channel, subject: options.subject || 'Aviso ZeroAgent', idempotencyKey: retryKey
    });
  }
}

async function sendZavuMessage(to, text, options = {}) {
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
  const channel = options.channel || 'whatsapp';
  const payload = {
    to: recipient,
    channel,
    text: content.slice(0, 8_000),
    'Zavu-Sender': options.senderId || process.env.ZAVUDEV_SENDER_ID
  };
  // Imagen con pie de foto: un solo mensaje de WhatsApp, no dos. El texto viaja como caption, que
  // WhatsApp corta en 1024 caracteres — el llamador es quien decide si su bloque cabe o si conviene
  // mandar la imagen y el texto por separado.
  if (options.imageUrl) {
    payload.messageType = 'image';
    payload.content = { mediaUrl: String(options.imageUrl).trim() };
  }
  // Zavu exige asunto cuando el canal es correo (o cuando el destinatario es una dirección).
  if (channel === 'email' || recipient.includes('@')) payload.subject = String(options.subject || 'Aviso ZeroAgent').slice(0, 200);
  if (idempotencyKey) payload.idempotencyKey = idempotencyKey;

  try {
    return await zavu.messages.send(payload, { timeout, maxRetries: 2 });
  } catch (error) {
    if (Number(error?.status) !== 409 || !idempotencyKey) throw error;
    return { message: replayMessage(error), idempotentReplay: true };
  }
}

// Nombre que la propia persona tiene puesto en su WhatsApp. Es lo único que hay para identificar
// a quien escribe sin estar en la agenda del negocio: sin esto el dueño ve una lista de números
// que no puede reconocer ni buscar en su consola. Caso real (franciskom, 09-09-2026): una paciente
// de años quedó guardada como "+569…", el dueño no logró encontrarla para sacarle el bot de encima,
// y su nombre estaba en Zavu todo el tiempo.
//
// OJO: el parámetro `phoneNumber` de contacts.list existe en el SDK pero el backend no filtra por
// él (devuelve vacío para un número que sí existe, verificado 09-09-2026), así que no sirve para
// resolver un teléfono puntual. Se recorren las páginas más recientes, que vienen ordenadas por
// creación descendente — por eso esto vive en el cron horario y no en el camino del webhook.
export async function fetchRecentZavuProfileNames({ pages = 3, pageSize = 100 } = {}) {
  if (!process.env.ZAVUDEV_API_KEY) return [];
  const names = [];
  try {
    const { default: Zavudev } = await import('@zavudev/sdk');
    const zavu = new Zavudev({ apiKey: process.env.ZAVUDEV_API_KEY });
    let cursor = null;
    for (let page = 0; page < Math.max(1, Math.min(30, pages)); page += 1) {
      const query = cursor ? { limit: pageSize, cursor } : { limit: pageSize };
      const result = await zavu.contacts.list(query, { timeout: 10_000, maxRetries: 1 });
      const body = result?.body || result || {};
      const items = body.items || [];
      for (const item of items) {
        const name = String(item?.profileName || '').trim().slice(0, 120);
        const phone = String(item?.phoneNumber || item?.primaryPhone || '').trim();
        if (name && phone) names.push({ phone, name });
      }
      cursor = body.nextCursor || body.next_cursor;
      if (!cursor || !items.length) break;
    }
  } catch (error) {
    console.error('[zavu] no se pudieron leer los nombres de perfil:', error.message);
  }
  return names;
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
