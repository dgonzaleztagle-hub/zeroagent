import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';

const DEFAULTS = { handoff_alert_enabled: true, booking_alert_enabled: true, failure_alert_enabled: true, alert_phone: '' };

let previewSettings = { ...DEFAULTS };

export async function getNotificationSettings() {
  if (!agendaUsesSupabase()) return { mode: 'local_preview_state', settings: previewSettings };
  const rows = await agendaSupabaseRequest('/rest/v1/za_notification_settings?id=eq.true&select=handoff_alert_enabled,booking_alert_enabled,failure_alert_enabled,alert_phone,updated_at');
  return { mode: 'customer_supabase', settings: rows?.[0] || DEFAULTS };
}

export async function updateNotificationSettings(input = {}) {
  const settings = {
    handoff_alert_enabled: Boolean(input.handoff_alert_enabled),
    booking_alert_enabled: Boolean(input.booking_alert_enabled),
    failure_alert_enabled: Boolean(input.failure_alert_enabled),
    alert_phone: String(input.alert_phone || '').replace(/[^\d+]/g, '').slice(0, 20),
    updated_at: new Date().toISOString()
  };
  if (!agendaUsesSupabase()) {
    previewSettings = settings;
    return { mode: 'local_preview_state', settings };
  }
  const rows = await agendaSupabaseRequest('/rest/v1/za_notification_settings?on_conflict=id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ id: true, ...settings })
  });
  return { mode: 'customer_supabase', settings: rows?.[0] || settings };
}
