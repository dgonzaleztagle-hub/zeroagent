import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';
import { sendZavuAlert } from './zavu.js';
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

// Un mismo cliente puede gatillar dos avisos en segundos (dos mensajes seguidos, cada uno con su
// propio turno: pasó real con dos pacientes el 09 y 10-09-2026, dos SMS cobrados por el mismo
// caso). Se mira si ya hubo un ticket para ese mismo contacto hace poco y, si lo hay, el ticket se
// crea igual pero el aviso no se repite.
async function alertedRecently(ticket) {
  if (!agendaUsesSupabase() || !ticket?.conversation_id) return false;
  const windowMinutes = Math.max(0, Number(process.env.OWNER_ALERT_DEDUPE_MINUTES ?? 60));
  if (!windowMinutes) return false;
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const rows = await agendaSupabaseRequest(
    `/rest/v1/za_handoff_tickets?conversation_ref=eq.${encodeURIComponent(ticket.conversation_id)}`
    + `&created_at=gte.${encodeURIComponent(since)}&select=id,created_at&order=created_at.asc`
  ).catch(() => null);
  return Boolean((rows || []).some(row => row.id !== ticket.id));
}

async function alertHandoff(ticket) {
  // El chat de prueba del dueño ("Probar" en la consola, playground) crea tickets reales para que
  // vea el resultado de su prueba en la Bandeja — pero NO es un cliente esperando: alertarlo le
  // manda un SMS (que se cobra) por algo que acaba de escribir él mismo delante de la pantalla.
  // Caso real: una prueba de regresión con "quiero hablar con Francisco directamente" le llegó al
  // dueño como si un paciente lo estuviera pidiendo, en pleno primer día de marcha blanca.
  if (ticket.channel === 'preview') return;
  const { settings } = await getNotificationSettings();
  if (!settings.handoff_alert_enabled || !settings.alert_phone) return;
  if (await alertedRecently(ticket)) return;
  // El SMS se cobra por segmento de 160 caracteres, así que dice lo justo. Lo primero es CON QUIÉN
  // hablar: el nombre y el número del cliente, porque el dueño contesta desde su propio WhatsApp y
  // no desde la consola (Francisco fue explícito el 11-09-2026: entrar a la app en medio del día,
  // manejando o con su bebé en brazos, no le sirve — responde por voz desde el chat). Con el
  // número en el SMS abre la conversación de un toque. El link a la consola queda al final y sólo
  // si la instalación declaró CONSOLE_URL — Zavu exige verificar antes cualquier URL enviada por
  // SMS (urls.submitForVerification).
  const consoleUrl = String(process.env.CONSOLE_URL || '').trim();
  const who = [ticket.customer_name, ticket.conversation_id].filter(Boolean).join(' ') || 'Un cliente';
  const head = ticket.kind === 'owner_alert'
    ? `ZeroAgent: ${who} está dudando, cierra tú.`
    : `ZeroAgent: ${who} pide hablar contigo.`;
  const text = [
    head,
    ticket.reason ? ticket.reason.slice(0, 70) : (ticket.customer_message ? `"${ticket.customer_message.slice(0, 60)}"` : ''),
    consoleUrl ? consoleUrl : ''
  ].filter(Boolean).join(' ').slice(0, 300);
  await sendZavuAlert(settings.alert_phone, text, {
    idempotencyKey: `handoff-alert:${ticket.id}`,
    subject: ticket.kind === 'owner_alert' ? 'Un cliente necesita que lo convenzas' : 'Un cliente pide hablar contigo'
  });
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
    // kind y customer_name no se persisten (no existe columna): sirven sólo para redactar el aviso
    // al dueño en este mismo turno. El motivo sí queda guardado, y es lo que ve en la Bandeja.
    const alertable = ticket ? { ...ticket, kind: input.kind || 'handoff', customer_name: String(input.customerName || '').trim() } : ticket;
    if (created) await alertHandoff(alertable).catch(error => console.error('No se pudo enviar alerta de handoff:', error.message));
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
