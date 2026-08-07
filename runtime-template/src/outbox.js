import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';
import { notifySentinel } from './sentinel.js';

// El outbox pertenece al cliente. Este worker sólo entrega la notificación y marca el evento;
// no reenvía conversaciones ni credenciales hacia un servicio central.
export async function dispatchAgendaOutbox(packageData, limit = 20) {
  if (!agendaUsesSupabase()) return { sent: 0, skipped: 0, reason: 'supabase_not_configured' };
  const events = await agendaSupabaseRequest(`/rest/v1/za_outbox_events?status=in.(pending,failed)&order=created_at.asc&limit=${Math.max(1, Math.min(100, Number(limit) || 20))}`);
  let sent = 0; let failed = 0;
  for (const event of events || []) {
    try {
      const payload = event.payload || {};
      const delivery = await notifySentinel({
        type: event.event_type,
        agentId: packageData.business?.id,
        agentName: packageData.agent?.name,
        subject: payload.feedback_id || payload.conversation_id || event.id,
        message: 'Hay una corrección o solicitud pendiente en el Supabase del cliente. Revísala desde ZeroAgent Studio con el vault autorizado.'
      });
      if (!delivery.sent) throw new Error(`Centinela no entregó el evento: ${delivery.reason}`);
      await agendaSupabaseRequest(`/rest/v1/za_outbox_events?id=eq.${encodeURIComponent(event.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'sent', attempts: Number(event.attempts || 0) + 1, delivered_at: new Date().toISOString() }) });
      sent++;
    } catch {
      await agendaSupabaseRequest(`/rest/v1/za_outbox_events?id=eq.${encodeURIComponent(event.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed', attempts: Number(event.attempts || 0) + 1 }) });
      failed++;
    }
  }
  return { sent, failed, pending: events?.length || 0 };
}
