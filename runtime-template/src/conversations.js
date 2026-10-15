import { agendaSupabaseRequest, agendaUsesSupabase, fetchAllAgendaRows, normalizeChilePhone } from './agenda.js';
import { fetchRecentZavuProfileNames } from './zavu.js';

let previewAgentControl = { mode: 'active', paused_reason: '', updated_at: new Date().toISOString() };

// Busca el cliente por teléfono (mismo string crudo que llega de Zavu, sin normalizar — es el
// mismo valor con el que agenda.js guarda customer_phone al crear una reserva, así que calzan).
// Si no existe todavía, lo crea con lo mínimo (nombre = teléfono): así CUALQUIER contacto que
// escriba por WhatsApp queda en el CRM desde el primer mensaje, no sólo quien llega a reservar.
// Sin esto, un contacto que nunca agenda (ej. un familiar del dueño) jamás aparecería en la
// ficha de clientes y no habría dónde marcarlo como "no contestar".
async function ensureCustomerIdByPhone(phone, profileName = '') {
  const normalized = normalizeChilePhone(phone) || phone;
  if (!normalized) return null;
  const existing = await agendaSupabaseRequest(`/rest/v1/za_customers?phone=eq.${encodeURIComponent(normalized)}&select=id`).catch(() => []);
  if (existing?.[0]?.id) return existing[0].id;
  // Quien escribe sin estar en la agenda del negocio queda guardado con su propio número como
  // nombre, y en la consola el dueño ve una lista de números que no puede reconocer ni buscar. Si
  // el evento del canal trajo el nombre de perfil, se usa altiro; si no, syncWhatsappProfileNames
  // (cron horario) lo rellena después.
  const created = await agendaSupabaseRequest('/rest/v1/za_customers', {
    method: 'POST', headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify({ full_name: String(profileName || '').trim().slice(0, 120) || normalized, phone: normalized })
  }).catch(() => null);
  if (created?.[0]?.id) return created[0].id;
  // Carrera: otro turno lo creó entre el select y el insert (resolution=ignore-duplicates no devuelve fila).
  const retry = await agendaSupabaseRequest(`/rest/v1/za_customers?phone=eq.${encodeURIComponent(normalized)}&select=id`).catch(() => []);
  return retry?.[0]?.id || null;
}

export async function getOrCreateConversation(channel, externalId, profileName = '') {
  if (!agendaUsesSupabase()) return null;
  const filter = `/rest/v1/za_conversations?channel=eq.${encodeURIComponent(channel)}&external_id=eq.${encodeURIComponent(externalId)}&select=id,status,customer_id,updated_at,za_customers(full_name,bot_muted)`;
  const existing = await agendaSupabaseRequest(filter);
  let conversation = existing?.[0];
  if (!conversation) {
    const created = await agendaSupabaseRequest('/rest/v1/za_conversations', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ channel, external_id: externalId, status: 'active' })
    });
    conversation = created[0];
  }
  // El cliente puede no existir todavía la primera vez que escribe (recién se crea al agendar) —
  // por eso se reintenta el vínculo cada vez que falta, no sólo al crear la conversación.
  if (channel === 'whatsapp' && !conversation.customer_id) {
    const customerId = await ensureCustomerIdByPhone(externalId, profileName);
    if (customerId) {
      // select= en el PATCH pide el mismo embed de za_customers que la lectura inicial — si no,
      // la representación devuelta no trae bot_muted y un contacto ya silenciado antes de su
      // primer mensaje en esta conversación quedaría sin ese dato (el bot le respondería igual).
      const updated = await agendaSupabaseRequest(`/rest/v1/za_conversations?id=eq.${encodeURIComponent(conversation.id)}&select=id,status,customer_id,updated_at,za_customers(full_name,bot_muted)`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ customer_id: customerId })
      }).catch(() => null);
      if (updated?.[0]) conversation = updated[0];
    }
  }
  return conversation;
}

// La gente escribe como habla: tres mensajes seguidos en dos segundos, no un párrafo. Como el
// webhook dispara una respuesta por mensaje, el agente contestaba tres veces —una por cada uno,
// cada una sin ver las siguientes— y eso es justo lo que lo delata como máquina frente a alguien
// que escribe normal. Caso real (franciskom, 09-09-2026): una paciente mandó tres líneas seguidas
// y recibió tres presentaciones distintas del "kinesiólogo".
// El turno espera unos segundos y, si en ese rato entró otro mensaje del mismo cliente, se calla:
// contesta el último evento, que ya tiene los tres mensajes en su historial.
// El valor se midió sobre la conversación real de franciskom (356 pausas entre mensajes seguidos
// de un mismo cliente, 08→11-09-2026): la mediana es 12 s, y los 7 s originales cubrían sólo el
// 34 % de los casos — de ahí las 6 respuestas dobles de la primera semana. Pero Zavu documenta
// explícitamente "responde en menos de 30 segundos, procesa async" (webhook-setup skill), y esta
// espera bloquea la respuesta HTTP del webhook ANTES de generar la respuesta (que mide otros
// 5-15 s más) — con 20 s de espera, un mensaje real quedó atascado sin contestar nunca (12-09-2026,
// evento de Supabase trabado en "processing" para siempre, ver recoverMissedZavuReplies en
// server.js). 12 s cubre la mitad de las pausas reales dejando margen bajo el límite documentado;
// la red de seguridad (recoverMissedZavuReplies) cubre lo que igual se pase de largo.
export function inboundDebounceMs() {
  const configured = Number(process.env.INBOUND_DEBOUNCE_MS ?? 12_000);
  return Math.max(0, Math.min(20_000, Number.isFinite(configured) ? configured : 12_000));
}

// Un mensaje que Zavu reentrega tarde (el primer intento falló) se guarda DESPUÉS de que el bot ya
// contestó la ráfaga completa, y el chequeo por hora de guardado no lo ve como viejo: el bot
// contestaba otra vez, con horas distintas (franciskom, 07-10-2026). Si el agente ya escribió en
// el hilo después de la hora real en que el cliente mandó este mensaje, ese mensaje ya quedó
// cubierto por esa respuesta (está en su historial).
export async function agentRepliedSince(conversationId, sinceIso) {
  if (!agendaUsesSupabase() || !conversationId || !sinceIso) return false;
  const rows = await agendaSupabaseRequest(
    `/rest/v1/za_conversation_messages?conversation_id=eq.${encodeURIComponent(conversationId)}`
    + `&direction=eq.outbound&sender_type=eq.agent&created_at=gt.${encodeURIComponent(sinceIso)}&select=id&limit=1`
  ).catch(() => null);
  return Boolean(rows?.length);
}

const MEDIA_FALLBACK_TEXT = {
  listen: 'Por ahora no puedo escuchar audios por acá. ¿Me lo escribes? Así te ayudo altiro.',
  see: 'No alcanzo a ver imágenes ni archivos por acá. ¿Me cuentas por escrito qué necesitas?'
};

// Qué contestar cuando un cliente manda algo sin texto. Sólo se contesta donde el bot lleva la
// conversación (le escribió en las últimas 24 h) o en un contacto nuevo, y una sola vez: a un hilo
// que lleva el dueño o a un contacto suyo de siempre no se le contesta nada. Stickers, reacciones,
// ubicaciones y contactos nunca reciben respuesta.
export async function mediaFallbackReply(conversation, media, excludeClientMessageId = '', overrides = {}) {
  const kind = String(media?.kind || '').toLowerCase();
  const family = ['audio', 'voice', 'ptt', 'video'].includes(kind) ? 'listen' : ['image', 'document'].includes(kind) ? 'see' : null;
  if (!family || !agendaUsesSupabase() || !conversation?.id) return null;
  const rows = await agendaSupabaseRequest(
    `/rest/v1/za_conversation_messages?conversation_id=eq.${encodeURIComponent(conversation.id)}`
    + '&select=direction,sender_type,content,client_message_id,created_at&order=created_at.desc&limit=30'
  ).catch(() => null);
  if (!rows) return null;
  const previous = rows.filter(item => item.client_message_id !== excludeClientMessageId);
  const now = Date.now();
  const lastAgent = previous.find(item => item.direction === 'outbound' && item.sender_type === 'agent');
  const lastHuman = previous.find(item => item.direction === 'outbound' && item.sender_type === 'human');
  if (lastHuman && now - Date.parse(lastHuman.created_at) < handoffAutoReturnHours() * 3_600_000) return null;
  const text = overrides[family] || MEDIA_FALLBACK_TEXT[family];
  if (previous.some(item => item.direction === 'outbound' && item.content === text && now - Date.parse(item.created_at) < 12 * 3_600_000)) return null;
  const botOwnsThread = lastAgent && now - Date.parse(lastAgent.created_at) < 24 * 3_600_000;
  const newContact = previous.every(item => item.sender_type === 'system');
  return botOwnsThread || newContact ? text : null;
}

// El saludo de bienvenida (o el mensaje de ausencia) que la app WhatsApp Business manda sola llega
// como eco igual que lo que el dueño escribe en persona, y pasaba el hilo a handoff: el bot quedaba
// mudo con prospectos nuevos (franciskom, 09/10-10-2026: uno esperó 9 h). Se reconoce porque llega
// 0,2-0,4 s después del mensaje del cliente — lo más rápido que Francisco contestó en persona fueron
// 4,6 s — o porque es el mismo texto de un saludo automático ya reconocido.
export const AUTOMATED_OWNER_REPLY_MS = 2_500;
export async function isAutomatedOwnerReply(conversationId, text) {
  if (!agendaUsesSupabase() || !conversationId) return false;
  const base = `/rest/v1/za_conversation_messages?conversation_id=eq.${encodeURIComponent(conversationId)}`;
  const lastInbound = await agendaSupabaseRequest(`${base}&direction=eq.inbound&select=created_at&order=created_at.desc&limit=1`).catch(() => null);
  const lastInboundAt = Date.parse(lastInbound?.[0]?.created_at || '');
  if (Number.isFinite(lastInboundAt) && Date.now() - lastInboundAt <= AUTOMATED_OWNER_REPLY_MS) return true;
  const content = String(text || '').trim();
  if (content.length < 20) return false;
  const known = await agendaSupabaseRequest(
    `/rest/v1/za_conversation_messages?direction=eq.outbound&sender_type=eq.system&content=eq.${encodeURIComponent(content)}&select=id&limit=1`
  ).catch(() => null);
  return Boolean(known?.length);
}

// ¿El saludo automático contestó el mensaje del cliente que este turno está por responder?
export async function automatedReplyAfter(conversationId, afterIso) {
  if (!agendaUsesSupabase() || !conversationId || !afterIso) return false;
  const rows = await agendaSupabaseRequest(
    `/rest/v1/za_conversation_messages?conversation_id=eq.${encodeURIComponent(conversationId)}`
    + `&direction=eq.outbound&sender_type=eq.system&created_at=gte.${encodeURIComponent(afterIso)}&select=id&limit=1`
  ).catch(() => null);
  return Boolean(rows?.length);
}

export async function supersededByNewerInbound(conversationId, afterIso) {
  if (!agendaUsesSupabase() || !conversationId || !afterIso) return false;
  const rows = await agendaSupabaseRequest(
    `/rest/v1/za_conversation_messages?conversation_id=eq.${encodeURIComponent(conversationId)}`
    + `&direction=eq.inbound&created_at=gt.${encodeURIComponent(afterIso)}&select=id&limit=1`
  ).catch(() => null);
  return Boolean(rows?.length);
}

// Rellena el nombre de los contactos que quedaron guardados como un número pelado, usando el
// nombre que cada persona tiene puesto en su WhatsApp. Nunca pisa un nombre real: sólo toca las
// filas cuyo full_name es el propio teléfono (o está vacío), así que los nombres que vienen de
// Google Contacts o que el dueño escribió a mano quedan intactos.
export async function syncWhatsappProfileNames(options = {}) {
  if (!agendaUsesSupabase()) return { updated: 0 };
  const names = await fetchRecentZavuProfileNames(options);
  let updated = 0;
  for (const { phone, name } of names) {
    const rows = await agendaSupabaseRequest(
      `/rest/v1/za_customers?phone=eq.${encodeURIComponent(phone)}&select=id,full_name`
    ).catch(() => null);
    const customer = rows?.[0];
    if (!customer) continue;
    const current = String(customer.full_name || '').trim();
    const looksLikePhone = !current || current === phone || /^[+0-9 ]+$/.test(current);
    if (!looksLikePhone || current === name) continue;
    // Prefer=return=representation para poder contar de verdad: sin él el PATCH no devuelve filas
    // y el contador que informa el cron quedaba siempre en cero aunque el nombre sí se corrigiera.
    const patched = await agendaSupabaseRequest(`/rest/v1/za_customers?id=eq.${encodeURIComponent(customer.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ full_name: name, updated_at: new Date().toISOString() })
    }).catch(() => null);
    if (patched?.length) updated += 1;
  }
  return { updated, checked: names.length };
}

// Cuánto rato hacia atrás cuenta como "lo que el cliente está diciendo ahora". Todo mensaje del
// cliente más viejo que esto, que quedó sin respuesta del agente, se marca como ya atendido por el
// dueño (ver OWNER_HANDLED_NOTE).
function ownerHandledCutoffMs() {
  const configured = Number(process.env.OWNER_HANDLED_AFTER_MS ?? 15 * 60_000);
  return Math.max(60_000, Number.isFinite(configured) ? configured : 15 * 60_000);
}

// El dueño contesta desde la app de WhatsApp de su teléfono y el canal NO nos entrega esos envíos
// (comprobado con Zavu el 08-09-2026: cero eventos message.sent, cero mensajes outbound). El
// historial que ve el modelo queda entonces con preguntas del cliente aparentemente sin responder,
// y el modelo las contesta tarde: caso real (franciskom, 09-09-2026) una paciente escribió "ya
// llegué" y recibió la lista de precios, porque su pregunta de la noche anterior —que el dueño ya
// había respondido por teléfono— seguía "abierta" en el historial. Esta nota le dice al modelo que
// esa parte ya está resuelta y que sólo conteste lo último.
export const OWNER_HANDLED_NOTE = 'Nota del sistema: los mensajes anteriores del cliente ya fueron atendidos por el negocio por otra vía (el dueño responde también desde su teléfono y esas respuestas no aparecen en este historial). Son sólo contexto: no los vuelvas a responder ni retomes preguntas de ahí. Responde únicamente los mensajes que vienen después de esta nota, y sólo si traen una consulta nueva y concreta para ti. Si el mensaje nuevo responde a algo que tú no dijiste, agradece, o acepta una hora, una fecha o un precio que tú no ofreciste en este historial, entonces también es parte de esa conversación ajena: no contestes, llama la herramienta para no intervenir en este turno.';

export async function loadConversationHistory(conversationId, limit = 20, options = {}) {
  if (!agendaUsesSupabase() || !conversationId) return [];
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const rows = await agendaSupabaseRequest(`/rest/v1/za_conversation_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&select=direction,sender_type,content,client_message_id,created_at&order=created_at.desc&limit=${safeLimit + 1}`);
  const exclude = String(options.excludeClientMessageId || '');
  const ordered = (rows || [])
    .filter(item => !exclude || item.client_message_id !== exclude)
    .slice(0, safeLimit)
    .reverse();
  const history = [];
  const cutoff = Date.now() - ownerHandledCutoffMs();
  // Sólo interesa la racha final sin respuesta: si después de un mensaje del cliente el agente
  // contestó, esa parte de la conversación está cerrada y no hay nada que marcar.
  let lastAgentReplyIndex = -1;
  ordered.forEach((item, index) => { if (item.direction !== 'inbound') lastAgentReplyIndex = index; });
  let noteInsertedAfter = -1;
  ordered.forEach((item, index) => {
    if (index > lastAgentReplyIndex && Date.parse(item.created_at || '') < cutoff) noteInsertedAfter = index;
  });
  // Lo que el dueño escribe en persona (eco) y su saludo automático van como 'assistant' —el agente
  // tiene que ver qué horas o datos ya se le dieron al cliente— pero con una nota antes: sin ella el
  // modelo leía las palabras de Francisco como propias y retomaba el hilo con su voz (11-10-2026).
  ordered.forEach((item, index) => {
    if (item.direction === 'outbound' && item.sender_type === 'human') history.push({ role: 'system', content: 'El siguiente mensaje lo escribió Francisco (el dueño) en persona desde su WhatsApp, no tú.' });
    if (item.direction === 'outbound' && item.sender_type === 'system') history.push({ role: 'system', content: 'El siguiente mensaje es el saludo automático de WhatsApp Business del dueño, ya enviado al cliente: no vuelvas a saludar ni repitas su pregunta; sigue desde lo que responda el cliente.' });
    history.push({ role: item.direction === 'inbound' ? 'user' : 'assistant', content: item.content });
    if (index === noteInsertedAfter) history.push({ role: 'system', content: OWNER_HANDLED_NOTE });
  });
  return history;
}

// El agente sólo puede elegir no responder en un hilo que ya venía siendo atendido por fuera: es
// decir, uno donde quedaron mensajes del cliente sin respuesta y con rato encima (la misma señal
// que inserta OWNER_HANDLED_NOTE). En una conversación nueva, o en una que el propio agente está
// llevando, callarse sería perder al cliente — así que ahí la herramienta ni se le ofrece.
export function historyAllowsSilence(history) {
  return Array.isArray(history) && history.some(item => item?.role === 'system' && item.content === OWNER_HANDLED_NOTE);
}

export async function findConversationMessageByClientId(clientMessageId) {
  if (!agendaUsesSupabase() || !clientMessageId) return null;
  const rows = await agendaSupabaseRequest(`/rest/v1/za_conversation_messages?client_message_id=eq.${encodeURIComponent(clientMessageId)}&select=*&limit=1`);
  return rows?.[0] || null;
}

export async function appendConversationMessage(conversationId, direction, content, toolTrace = {}, options = {}) {
  if (!agendaUsesSupabase() || !conversationId) return null;
  const clientMessageId = String(options.clientMessageId || '').trim().slice(0, 240) || null;
  const body = {
    conversation_id: conversationId,
    direction,
    content: String(content).slice(0, 8000),
    tool_trace: toolTrace,
    sender_type: ['agent', 'human', 'system'].includes(options.senderType) ? options.senderType : (direction === 'inbound' ? 'human' : 'agent'),
    delivery_status: ['queued', 'sending', 'sent', 'delivered', 'read', 'failed'].includes(options.deliveryStatus) ? options.deliveryStatus : 'sent',
    client_message_id: clientMessageId,
    provider_message_id: String(options.providerMessageId || '').trim().slice(0, 240) || null,
    failure_reason: String(options.failureReason || '').slice(0, 1000) || null
  };
  const endpoint = clientMessageId
    ? '/rest/v1/za_conversation_messages?on_conflict=client_message_id'
    : '/rest/v1/za_conversation_messages';
  const rows = await agendaSupabaseRequest(endpoint, {
    method: 'POST',
    headers: { Prefer: clientMessageId ? 'resolution=ignore-duplicates,return=representation' : 'return=representation' },
    body: JSON.stringify(body)
  });
  return rows?.[0] || (clientMessageId ? findConversationMessageByClientId(clientMessageId) : null);
}

export async function updateConversationMessageDelivery(input = {}) {
  if (!agendaUsesSupabase()) return null;
  const id = String(input.id || '').trim();
  const providerMessageId = String(input.providerMessageId || '').trim();
  if (!id && !providerMessageId) return null;
  const status = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed'].includes(input.status) ? input.status : null;
  const patch = {};
  if (status) patch.delivery_status = status;
  if (providerMessageId && id) patch.provider_message_id = providerMessageId.slice(0, 240);
  if (Object.hasOwn(input, 'failureReason')) patch.failure_reason = String(input.failureReason || '').slice(0, 1000) || null;
  if (status === 'delivered' || status === 'read') patch.delivered_at = new Date().toISOString();
  if (!Object.keys(patch).length) return null;
  let filter = id ? `id=eq.${encodeURIComponent(id)}` : `provider_message_id=eq.${encodeURIComponent(providerMessageId)}`;
  // Los callbacks pueden llegar fuera de orden. Cuando la búsqueda viene sólo por
  // provider_message_id (webhook), impedir que sent/queued rebajen delivered/read
  // o que un failed tardío borre una entrega ya confirmada. Los updates por id son
  // operaciones activas del runtime y sí pueden recuperar un envío marcado failed.
  if (!id && status) {
    const allowedCurrent = {
      queued: ['sending', 'queued'],
      sent: ['sending', 'queued', 'sent'],
      delivered: ['sending', 'queued', 'sent', 'delivered'],
      read: ['sending', 'queued', 'sent', 'delivered', 'read'],
      failed: ['sending', 'queued', 'sent', 'failed']
    }[status];
    if (allowedCurrent) filter += `&delivery_status=in.(${allowedCurrent.join(',')})`;
  }
  const rows = await agendaSupabaseRequest(`/rest/v1/za_conversation_messages?${filter}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch)
  });
  return rows?.[0] || null;
}

export async function setConversationStatus(conversationId, status) {
  if (!agendaUsesSupabase() || !conversationId) return null;
  const rows = await agendaSupabaseRequest(`/rest/v1/za_conversations?id=eq.${encodeURIComponent(conversationId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status })
  });
  return rows?.[0] || null;
}

// La consola del cliente puede ver sus propios hilos, pero no recibe las credenciales
// de Supabase ni una vista de administración del agente.
// Una conversación tomada por una persona deja al agente mudo SOLO en ese hilo — pero si nadie
// la devuelve, queda muda para siempre y el cliente se queda esperando a alguien que ya se olvidó
// del caso. Pasadas HANDOFF_AUTO_RETURN_HOURS sin que el equipo escriba, el agente la retoma solo.
// La ventana se cuenta desde el último mensaje humano saliente (o desde que la conversación se
// marcó, si nunca hubo respuesta humana), no desde el último mensaje del cliente: un cliente que
// insiste no debe devolverle la conversación al bot antes de que el dueño alcance a contestar.
export function handoffAutoReturnHours() {
  const configured = Number(process.env.HANDOFF_AUTO_RETURN_HOURS ?? 12);
  return Math.max(1, Math.min(720, Number.isFinite(configured) ? configured : 12));
}

export async function reclaimStaleHandoff(conversation) {
  if (!agendaUsesSupabase() || conversation?.status !== 'handoff') return conversation;
  const windowMs = handoffAutoReturnHours() * 3_600_000;
  const rows = await agendaSupabaseRequest(
    `/rest/v1/za_conversation_messages?conversation_id=eq.${encodeURIComponent(conversation.id)}`
    + '&direction=eq.outbound&sender_type=eq.human&select=created_at&order=created_at.desc&limit=1'
  );
  // Se cuenta desde lo más reciente entre el último mensaje del dueño y el paso a handoff (updated_at
  // de la conversación): si el bot traspasó hoy un hilo donde el dueño escribió hace semanas, el
  // mensaje viejo devolvía el hilo al bot en el turno siguiente.
  const lastHumanAt = Math.max(Date.parse(rows?.[0]?.created_at || '') || 0, Date.parse(conversation.updated_at || '') || 0);
  if (!lastHumanAt) return conversation;
  const elapsed = Date.now() - lastHumanAt;
  if (!Number.isFinite(elapsed) || elapsed < windowMs) return conversation;
  const updated = await updateConversationOperation(conversation.id, {
    status: 'active', needs_human: false, handoff_reason: ''
  }).catch(error => {
    console.error('[conversations] no se pudo devolver la conversación al agente:', error.message);
    return null;
  });
  return updated ? { ...conversation, ...updated, za_customers: conversation.za_customers } : conversation;
}

// Qué le toca al dueño en cada hilo, calculado en un solo lugar para las dos consolas. Antes la
// Bandeja marcaba "Necesita persona" todo hilo en handoff: los silenciados, los que Francisco ya
// estaba contestando y traspasos de hace un mes que nadie cerró (21 en el badge, franciskom
// 12-10-2026). Un handoff vencido se muestra como del bot porque eso es lo que pasará apenas el
// cliente escriba (reclaimStaleHandoff); acá sólo se lee, no se escribe.
export function conversationAttention(conversation, messages = [], now = Date.now()) {
  if (conversation?.za_customers?.bot_muted || conversation?.customer_bot_muted) return 'muted';
  if (!(conversation?.needs_human || conversation?.status === 'handoff')) return 'bot';
  const lastHumanAt = Math.max(0, ...messages.filter(item => item.direction === 'outbound' && item.sender_type === 'human').map(item => Date.parse(item.created_at) || 0));
  const since = Math.max(lastHumanAt, Date.parse(conversation.updated_at || '') || 0);
  if (since && now - since >= handoffAutoReturnHours() * 3_600_000) return 'bot';
  const lastMessage = messages[messages.length - 1];
  if (lastHumanAt && lastMessage?.direction === 'outbound' && lastMessage?.sender_type === 'human') return 'owner_handling';
  return 'needs_person';
}

// Última actividad real de cada conversación. updated_at de za_conversations sólo cambia con el
// estado del hilo (handoff, toma), no con cada mensaje: Cele escribió el 12-10 a las 10:18 y su
// hilo seguía con fecha del día anterior. Ordenar por updated_at dejaba fuera de la Bandeja (top 40)
// hilos activos y desordenaba Clientes.
export async function conversationActivity() {
  if (!agendaUsesSupabase()) return [];
  const rows = await fetchAllAgendaRows('/rest/v1/za_conversations?select=id,customer_id,updated_at,za_conversation_messages(created_at)&za_conversation_messages.order=created_at.desc&za_conversation_messages.limit=1&order=id.asc');
  return (rows || []).map(item => ({ id: item.id, customer_id: item.customer_id, last_at: item.za_conversation_messages?.[0]?.created_at || item.updated_at }))
    .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
}

export async function getConversationInbox(limit = 40) {
  if (!agendaUsesSupabase()) return { mode: 'local_preview_state', conversations: [] };
  const top = (await conversationActivity()).slice(0, Math.max(1, Math.min(100, Number(limit) || 40)));
  if (!top.length) return { mode: 'customer_supabase', operators: [], conversations: [] };
  const rank = new Map(top.map((item, index) => [item.id, index]));
  const [unordered, operators] = await Promise.all([
    agendaSupabaseRequest(`/rest/v1/za_conversations?id=in.(${top.map(item => item.id).join(',')})&select=id,channel,external_id,status,priority,needs_human,handoff_reason,assigned_owner_id,created_at,updated_at,za_customers(full_name,phone,bot_muted),za_operators(name),za_conversation_messages(id,direction,content,sender_type,delivery_status,client_message_id,provider_message_id,failure_reason,delivered_at,created_at)`),
    agendaSupabaseRequest('/rest/v1/za_operators?active=eq.true&select=id,name,email,role&order=name.asc')
  ]);
  const rows = [...(unordered || [])].sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return {
    mode: 'customer_supabase',
    operators: operators || [],
    conversations: (rows || []).map(item => {
      const messages = [...(item.za_conversation_messages || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return {
      id: item.id,
      attention: conversationAttention(item, messages),
      last_message_at: messages[messages.length - 1]?.created_at || item.updated_at,
      channel: item.channel,
      external_id: item.external_id,
      status: item.status,
      created_at: item.created_at,
      updated_at: item.updated_at,
      priority: item.priority || 'normal',
      needs_human: Boolean(item.needs_human),
      handoff_reason: item.handoff_reason || '',
      assigned_owner_id: item.assigned_owner_id || null,
      assigned_owner_name: item.za_operators?.name || '',
      customer_name: item.za_customers?.full_name || '',
      customer_phone: item.za_customers?.phone || item.external_id || '',
      customer_bot_muted: Boolean(item.za_customers?.bot_muted),
      messages
      };
    })
  };
}

export async function updateConversationOperation(conversationId, input = {}) {
  if (!agendaUsesSupabase()) throw new Error('La operación compartida requiere Supabase configurado.');
  const patch = {};
  if (['active', 'handoff', 'closed'].includes(input.status)) patch.status = input.status;
  if (['normal', 'high', 'urgent'].includes(input.priority)) patch.priority = input.priority;
  if (typeof input.needs_human === 'boolean') patch.needs_human = input.needs_human;
  if (Object.hasOwn(input, 'assigned_owner_id')) patch.assigned_owner_id = input.assigned_owner_id || null;
  if (Object.hasOwn(input, 'handoff_reason')) patch.handoff_reason = String(input.handoff_reason || '').trim().slice(0, 800);
  if (!Object.keys(patch).length) throw new Error('No hay cambios operativos válidos.');
  const rows = await agendaSupabaseRequest(`/rest/v1/za_conversations?id=eq.${encodeURIComponent(conversationId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch)
  });
  if (!rows?.[0]) throw new Error('Conversación no encontrada.');
  return rows[0];
}

export async function createOperator(input = {}) {
  if (!agendaUsesSupabase()) throw new Error('El equipo compartido requiere Supabase configurado.');
  const name = String(input.name || '').trim().slice(0, 120);
  const email = String(input.email || '').trim().toLowerCase().slice(0, 254) || null;
  const role = ['owner', 'manager', 'operator'].includes(input.role) ? input.role : 'operator';
  if (!name) throw new Error('Indica el nombre del responsable.');
  const rows = await agendaSupabaseRequest('/rest/v1/za_operators', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name, email, role })
  });
  return rows?.[0] || null;
}

export async function ensureInitialOwner(input = {}) {
  if (!agendaUsesSupabase() || !String(input.name || '').trim()) return null;
  const email = String(input.email || '').trim().toLowerCase();
  if (email) {
    const existing = await agendaSupabaseRequest(`/rest/v1/za_operators?email=eq.${encodeURIComponent(email)}&select=id,name`);
    if (existing?.[0]) return existing[0];
  }
  return createOperator({ name: input.name, email, role: 'owner' });
}

export async function getAgentControl() {
  if (!agendaUsesSupabase()) return { mode: 'local_preview_state', control: previewAgentControl };
  const rows = await agendaSupabaseRequest('/rest/v1/za_agent_controls?id=eq.true&select=mode,paused_reason,updated_at');
  return { mode: 'customer_supabase', control: rows?.[0] || { mode: 'active', paused_reason: '', updated_at: null } };
}

export async function updateAgentControl(input = {}) {
  if (!['active', 'paused'].includes(input.mode)) throw new Error('Modo de agente inválido.');
  const control = { mode: input.mode, paused_reason: String(input.paused_reason || '').trim().slice(0, 800), updated_at: new Date().toISOString() };
  if (!agendaUsesSupabase()) {
    previewAgentControl = control;
    return { mode: 'local_preview_state', control };
  }
  const rows = await agendaSupabaseRequest('/rest/v1/za_agent_controls?on_conflict=id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ id: true, ...control })
  });
  return { mode: 'customer_supabase', control: rows?.[0] || control };
}
