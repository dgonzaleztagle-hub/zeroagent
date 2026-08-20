import { agendaSupabaseRequest, agendaUsesSupabase, normalizeChilePhone } from './agenda.js';

let previewAgentControl = { mode: 'active', paused_reason: '', updated_at: new Date().toISOString() };

// Busca el cliente por teléfono (mismo string crudo que llega de Zavu, sin normalizar — es el
// mismo valor con el que agenda.js guarda customer_phone al crear una reserva, así que calzan).
// Si no existe todavía, lo crea con lo mínimo (nombre = teléfono): así CUALQUIER contacto que
// escriba por WhatsApp queda en el CRM desde el primer mensaje, no sólo quien llega a reservar.
// Sin esto, un contacto que nunca agenda (ej. un familiar del dueño) jamás aparecería en la
// ficha de clientes y no habría dónde marcarlo como "no contestar".
async function ensureCustomerIdByPhone(phone) {
  const normalized = normalizeChilePhone(phone) || phone;
  if (!normalized) return null;
  const existing = await agendaSupabaseRequest(`/rest/v1/za_customers?phone=eq.${encodeURIComponent(normalized)}&select=id`).catch(() => []);
  if (existing?.[0]?.id) return existing[0].id;
  const created = await agendaSupabaseRequest('/rest/v1/za_customers', {
    method: 'POST', headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify({ full_name: normalized, phone: normalized })
  }).catch(() => null);
  if (created?.[0]?.id) return created[0].id;
  // Carrera: otro turno lo creó entre el select y el insert (resolution=ignore-duplicates no devuelve fila).
  const retry = await agendaSupabaseRequest(`/rest/v1/za_customers?phone=eq.${encodeURIComponent(normalized)}&select=id`).catch(() => []);
  return retry?.[0]?.id || null;
}

export async function getOrCreateConversation(channel, externalId) {
  if (!agendaUsesSupabase()) return null;
  const filter = `/rest/v1/za_conversations?channel=eq.${encodeURIComponent(channel)}&external_id=eq.${encodeURIComponent(externalId)}&select=id,status,customer_id,za_customers(bot_muted)`;
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
    const customerId = await ensureCustomerIdByPhone(externalId);
    if (customerId) {
      // select= en el PATCH pide el mismo embed de za_customers que la lectura inicial — si no,
      // la representación devuelta no trae bot_muted y un contacto ya silenciado antes de su
      // primer mensaje en esta conversación quedaría sin ese dato (el bot le respondería igual).
      const updated = await agendaSupabaseRequest(`/rest/v1/za_conversations?id=eq.${encodeURIComponent(conversation.id)}&select=id,status,customer_id,za_customers(bot_muted)`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ customer_id: customerId })
      }).catch(() => null);
      if (updated?.[0]) conversation = updated[0];
    }
  }
  return conversation;
}

export async function loadConversationHistory(conversationId, limit = 20, options = {}) {
  if (!agendaUsesSupabase() || !conversationId) return [];
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const rows = await agendaSupabaseRequest(`/rest/v1/za_conversation_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&select=direction,content,client_message_id&order=created_at.desc&limit=${safeLimit + 1}`);
  const exclude = String(options.excludeClientMessageId || '');
  return (rows || [])
    .filter(item => !exclude || item.client_message_id !== exclude)
    .slice(0, safeLimit)
    .reverse()
    .map(item => ({ role: item.direction === 'inbound' ? 'user' : 'assistant', content: item.content }));
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
export async function getConversationInbox(limit = 40) {
  if (!agendaUsesSupabase()) return { mode: 'local_preview_state', conversations: [] };
  const [rows, operators] = await Promise.all([
    agendaSupabaseRequest(`/rest/v1/za_conversations?select=id,channel,external_id,status,priority,needs_human,handoff_reason,assigned_owner_id,created_at,updated_at,za_customers(full_name,phone,bot_muted),za_operators(name),za_conversation_messages(id,direction,content,sender_type,delivery_status,client_message_id,provider_message_id,failure_reason,delivered_at,created_at)&order=updated_at.desc&limit=${Math.max(1, Math.min(100, Number(limit) || 40))}`),
    agendaSupabaseRequest('/rest/v1/za_operators?active=eq.true&select=id,name,email,role&order=name.asc')
  ]);
  return {
    mode: 'customer_supabase',
    operators: operators || [],
    conversations: (rows || []).map(item => ({
      id: item.id,
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
      messages: [...(item.za_conversation_messages || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    }))
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
