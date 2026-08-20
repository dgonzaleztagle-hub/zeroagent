import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';
import { sendZavuWhatsApp } from './zavu.js';
import { getNotificationSettings } from './notification-settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function statePathFor(packageData) {
  const scope = String(packageData.business?.id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(root, 'storage', `handoffs-${scope}.json`);
}

async function loadState(packageData) {
  try { return JSON.parse(await fs.readFile(statePathFor(packageData), 'utf8')); }
  catch { return { tickets: [] }; }
}

async function saveState(packageData, state) {
  const statePath = statePathFor(packageData);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporary, statePath);
}

function fromRow(row) {
  return {
    id: row.id, created_at: row.created_at, channel: row.channel, conversation_id: row.conversation_ref || '',
    customer_message: row.customer_message || '', agent_reply: row.agent_reply || '', reason: row.reason || '',
    operation_key: row.operation_key || '', status: row.status, note: row.note || undefined, updated_at: row.updated_at
  };
}

async function alertHandoff(ticket) {
  const { settings } = await getNotificationSettings();
  if (!settings.handoff_alert_enabled || !settings.alert_phone) return;
  const text = [
    '🔔 Un cliente necesita hablar con una persona.',
    ticket.reason ? `Motivo: ${ticket.reason}` : '',
    ticket.customer_message ? `Dijo: "${ticket.customer_message.slice(0, 300)}"` : '',
    'Revisa el caso en tu consola ZeroAgent.'
  ].filter(Boolean).join('\n');
  await sendZavuWhatsApp(settings.alert_phone, text, { idempotencyKey: `handoff-alert:${ticket.id}` });
}

// Bandeja de handoff: cuando el agente deriva a una persona (pedido explícito o señal de
// urgencia real) el ticket queda visible para que el dueño lo revise y marque resuelto.
// Además, si el cliente configuró un teléfono de alertas, se le avisa por el mismo canal
// Zavu que ya usa el agente — este es el único punto de entrada de TODOS los caminos que
// crean un handoff (webhook real, playground, risk windows), así que basta con cablearlo
// una vez acá para que la alerta cubra cualquier origen.
export async function createHandoffTicket(packageData, input = {}) {
  const operationKey = String(input.operationKey || '').trim().slice(0, 240);
  if (agendaUsesSupabase()) {
    const endpoint = operationKey ? '/rest/v1/za_handoff_tickets?on_conflict=operation_key' : '/rest/v1/za_handoff_tickets';
    const rows = await agendaSupabaseRequest(endpoint, {
      method: 'POST', headers: { Prefer: operationKey ? 'resolution=ignore-duplicates,return=representation' : 'return=representation' }, body: JSON.stringify({
        operation_key: operationKey || null,
        channel: input.channel || 'preview', conversation_ref: input.conversationId || '',
        customer_message: String(input.customerMessage || '').slice(0, 2000),
        agent_reply: String(input.agentReply || '').slice(0, 2000),
        reason: String(input.reason || '').slice(0, 400)
      })
    });
    const created = rows?.[0];
    const existing = !created && operationKey
      ? (await agendaSupabaseRequest(`/rest/v1/za_handoff_tickets?operation_key=eq.${encodeURIComponent(operationKey)}&select=*&limit=1`))?.[0]
      : null;
    const ticket = fromRow(created || existing);
    if (created) await alertHandoff(ticket).catch(error => console.error('No se pudo enviar alerta de handoff:', error.message));
    return ticket;
  }
  const state = await loadState(packageData);
  const duplicate = operationKey && (state.tickets || []).find(item => item.operation_key === operationKey);
  if (duplicate) return duplicate;
  const entry = {
    id: `ho-${randomUUID()}`,
    created_at: new Date().toISOString(),
    channel: input.channel || 'preview',
    conversation_id: input.conversationId || '',
    customer_message: String(input.customerMessage || '').slice(0, 2000),
    agent_reply: String(input.agentReply || '').slice(0, 2000),
    reason: String(input.reason || '').slice(0, 400),
    operation_key: operationKey,
    status: 'open'
  };
  state.tickets = [entry, ...(state.tickets || [])].slice(0, 300);
  await saveState(packageData, state);
  return entry;
}

export async function listHandoffTickets(packageData) {
  if (agendaUsesSupabase()) {
    const rows = await agendaSupabaseRequest('/rest/v1/za_handoff_tickets?select=*&order=created_at.desc&limit=300');
    return (rows || []).map(fromRow);
  }
  const state = await loadState(packageData);
  return state.tickets || [];
}

export async function updateHandoffTicket(packageData, id, patch = {}) {
  if (agendaUsesSupabase()) {
    const body = {};
    if (['open', 'resolved'].includes(patch.status)) body.status = patch.status;
    if (typeof patch.note === 'string') body.note = patch.note.trim().slice(0, 2000);
    if (!Object.keys(body).length) throw new Error('No hay cambios válidos.');
    const rows = await agendaSupabaseRequest(`/rest/v1/za_handoff_tickets?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body)
    });
    if (!rows?.[0]) throw new Error('Ticket no encontrado.');
    return fromRow(rows[0]);
  }
  const state = await loadState(packageData);
  const ticket = (state.tickets || []).find(item => item.id === id);
  if (!ticket) throw new Error('Ticket no encontrado.');
  if (['open', 'resolved'].includes(patch.status)) ticket.status = patch.status;
  if (typeof patch.note === 'string') ticket.note = patch.note.trim().slice(0, 2000);
  ticket.updated_at = new Date().toISOString();
  await saveState(packageData, state);
  return ticket;
}
