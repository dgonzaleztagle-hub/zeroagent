import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';

let previewAgentControl = { mode: 'active', paused_reason: '', updated_at: new Date().toISOString() };

export async function getOrCreateConversation(channel, externalId) {
  if (!agendaUsesSupabase()) return null;
  const filter = `/rest/v1/za_conversations?channel=eq.${encodeURIComponent(channel)}&external_id=eq.${encodeURIComponent(externalId)}&select=id,status`;
  const existing = await agendaSupabaseRequest(filter);
  if (existing?.[0]) return existing[0];
  const created = await agendaSupabaseRequest('/rest/v1/za_conversations', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ channel, external_id: externalId, status: 'active' })
  });
  return created[0];
}

export async function loadConversationHistory(conversationId, limit = 20) {
  if (!agendaUsesSupabase() || !conversationId) return [];
  const rows = await agendaSupabaseRequest(`/rest/v1/za_conversation_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&select=direction,content&order=created_at.desc&limit=${Math.max(1, Math.min(50, limit))}`);
  return (rows || []).reverse().map(item => ({ role: item.direction === 'inbound' ? 'user' : 'assistant', content: item.content }));
}

export async function appendConversationMessage(conversationId, direction, content, toolTrace = {}) {
  if (!agendaUsesSupabase() || !conversationId) return null;
  const rows = await agendaSupabaseRequest('/rest/v1/za_conversation_messages', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ conversation_id: conversationId, direction, content: String(content).slice(0, 8000), tool_trace: toolTrace })
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
    agendaSupabaseRequest(`/rest/v1/za_conversations?select=id,channel,external_id,status,priority,needs_human,handoff_reason,assigned_owner_id,created_at,updated_at,za_customers(full_name,phone),za_operators(name),za_conversation_messages(id,direction,content,sender_type,delivery_status,client_message_id,created_at)&order=updated_at.desc&limit=${Math.max(1, Math.min(100, Number(limit) || 40))}`),
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
