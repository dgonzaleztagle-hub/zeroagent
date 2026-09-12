import { randomBytes } from 'node:crypto';
import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';

// Link de un toque que viaja en el SMS de aviso al dueño. Existe porque el dueño no entra a la
// consola: contesta desde su propio WhatsApp (ver migración 20260912_owner_action_links.sql).
// La página que abre el link no ejecuta nada — los previsualizadores de enlaces y los filtros de
// SMS abren las URLs solos, así que una acción en el GET silenciaría contactos sin que nadie la
// pidiera. Las acciones son POST, un botón cada una.

const ACTIONS = new Set(['tomar', 'devolver', 'silenciar', 'desilenciar']);

function linkLifetimeMs() {
  const days = Number(process.env.OWNER_ACTION_LINK_DAYS ?? 7);
  return Math.max(1, Number.isFinite(days) ? days : 7) * 24 * 60 * 60 * 1000;
}

// Base del link: si la instalación no declara una, se deduce del origen de la consola
// (CONSOLE_URL suele ser https://negocio.cl/m → https://negocio.cl/t/). Sin ninguna de las dos,
// no hay link y el aviso sale sin él: una alerta sin link es mejor que una que no llega.
export function actionLinkBase() {
  const explicit = String(process.env.OWNER_ACTION_LINK_BASE || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '') + '/';
  const consoleUrl = String(process.env.CONSOLE_URL || '').trim();
  if (!consoleUrl) return '';
  try { return `${new URL(consoleUrl).origin}/t/`; }
  catch { return ''; }
}

export async function createOwnerActionLink(input = {}) {
  const base = actionLinkBase();
  if (!base || !agendaUsesSupabase() || !input.conversationId) return '';
  // 12 bytes en base64url = 16 caracteres: corto para el SMS y con 96 bits de aleatoriedad.
  const token = randomBytes(12).toString('base64url');
  const row = {
    token,
    conversation_id: input.conversationId,
    customer_id: input.customerId || null,
    customer_phone: String(input.customerPhone || '').slice(0, 40),
    customer_name: String(input.customerName || '').slice(0, 120),
    context_message: String(input.contextMessage || '').slice(0, 400),
    expires_at: new Date(Date.now() + linkLifetimeMs()).toISOString()
  };
  const created = await agendaSupabaseRequest('/rest/v1/za_action_tokens', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row)
  }).catch(error => {
    console.error('No se pudo crear el link de acción del dueño:', error.message);
    return null;
  });
  if (!created?.[0]?.token) return '';
  return `${base}${created[0].token}`;
}

export async function loadOwnerAction(token) {
  if (!agendaUsesSupabase()) return null;
  const clean = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(clean)) return null;
  const rows = await agendaSupabaseRequest(
    `/rest/v1/za_action_tokens?token=eq.${encodeURIComponent(clean)}`
    + '&select=token,conversation_id,customer_id,customer_phone,customer_name,context_message,expires_at,last_action,last_used_at'
    + ',za_conversations(status),za_customers(full_name,bot_muted)&limit=1'
  ).catch(() => null);
  const row = rows?.[0];
  if (!row) return null;
  const expired = Date.parse(row.expires_at || '') < Date.now();
  return {
    ...row,
    expired,
    conversation_status: row.za_conversations?.status || '',
    muted: Boolean(row.za_customers?.bot_muted),
    display_name: row.za_customers?.full_name || row.customer_name || row.customer_phone || 'Contacto'
  };
}

export async function applyOwnerAction(token, action) {
  if (!ACTIONS.has(action)) return { ok: false, error: 'accion_invalida' };
  const record = await loadOwnerAction(token);
  if (!record) return { ok: false, error: 'link_invalido' };
  if (record.expired) return { ok: false, error: 'link_vencido' };

  if (action === 'silenciar' || action === 'desilenciar') {
    if (!record.customer_id) return { ok: false, error: 'sin_contacto' };
    await agendaSupabaseRequest(`/rest/v1/za_customers?id=eq.${encodeURIComponent(record.customer_id)}`, {
      method: 'PATCH', body: JSON.stringify({ bot_muted: action === 'silenciar', updated_at: new Date().toISOString() })
    });
  } else {
    // "Tomar" usa el mismo estado que el botón de la consola: el agente se calla en ese hilo y lo
    // retoma solo pasadas HANDOFF_AUTO_RETURN_HOURS sin mensajes del negocio.
    const patch = action === 'tomar'
      ? { status: 'handoff', needs_human: true, handoff_reason: 'El dueño tomó la conversación desde el aviso.' }
      : { status: 'active', needs_human: false };
    await agendaSupabaseRequest(`/rest/v1/za_conversations?id=eq.${encodeURIComponent(record.conversation_id)}`, {
      method: 'PATCH', body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
    });
  }
  await agendaSupabaseRequest(`/rest/v1/za_action_tokens?token=eq.${encodeURIComponent(record.token)}`, {
    method: 'PATCH', body: JSON.stringify({ last_used_at: new Date().toISOString(), last_action: action })
  }).catch(() => null);
  return { ok: true, action, record: await loadOwnerAction(token) };
}

const escape = value => String(value || '').replace(/[&<>"']/g, char => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));

export function ownerActionPage(record, options = {}) {
  const negocio = escape(options.businessName || 'ZeroAgent');
  if (!record) {
    return pageShell(negocio, '<h1>Este link no existe</h1><p>Puede haber sido reemplazado por un aviso más nuevo.</p>');
  }
  if (record.expired) {
    return pageShell(negocio, '<h1>Este link ya venció</h1><p>Abre la conversación directo en tu WhatsApp.</p>');
  }
  const phone = String(record.customer_phone || '').replace(/\D/g, '');
  const nombre = escape(record.display_name);
  const mensaje = record.context_message ? `<p class="msg">“${escape(record.context_message)}”</p>` : '';
  const aviso = options.notice ? `<p class="hecho">${escape(options.notice)}</p>` : '';
  const enHandoff = record.conversation_status === 'handoff';
  const silenciado = record.muted;
  const estado = silenciado
    ? '<p class="estado">El asistente no le responde a este contacto.</p>'
    : enHandoff
      ? '<p class="estado">El asistente está callado en esta conversación.</p>'
      : '<p class="estado">El asistente está atendiendo esta conversación.</p>';
  const botones = [
    phone ? `<a class="btn primario" href="https://wa.me/${phone}">Abrir su WhatsApp</a>` : '',
    silenciado
      ? `<button class="btn" name="accion" value="desilenciar">Volver a contestarle</button>`
      : enHandoff
        ? `<button class="btn" name="accion" value="devolver">Que el asistente la retome</button>`
        : `<button class="btn" name="accion" value="tomar">Yo sigo esta conversación</button>`,
    silenciado ? '' : `<button class="btn peligro" name="accion" value="silenciar">No contestarle más a esta persona</button>`
  ].filter(Boolean).join('\n      ');
  return pageShell(negocio, `
    <h1>${nombre}</h1>
    <p class="fono">${escape(record.customer_phone)}</p>
    ${mensaje}
    ${estado}
    ${aviso}
    <form method="post">
      ${botones}
    </form>
    <p class="pie">Todo esto es reversible: desde este mismo link o desde tu consola.</p>`);
}

function pageShell(negocio, contenido) {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${negocio}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 28px 20px 40px; font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #0f1115; color: #f2f4f8; }
  main { max-width: 520px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 2px; }
  .fono { margin: 0 0 18px; color: #9aa4b2; font-variant-numeric: tabular-nums; }
  .msg { background: #1b1f27; border-left: 3px solid #3b82f6; padding: 12px 14px; border-radius: 8px; color: #dbe3ef; }
  .estado { color: #9aa4b2; font-size: 15px; }
  .hecho { background: #10281a; border: 1px solid #1f5133; color: #b7f0cd; padding: 12px 14px; border-radius: 8px; }
  form { display: grid; gap: 12px; margin: 22px 0 0; }
  .btn { display: block; width: 100%; box-sizing: border-box; text-align: center; text-decoration: none; padding: 18px 16px; border-radius: 14px; border: 1px solid #2b3240; background: #1b1f27; color: #f2f4f8; font-size: 17px; font-weight: 600; cursor: pointer; }
  .btn.primario { background: #1f9d55; border-color: #1f9d55; color: #fff; }
  .btn.peligro { color: #ffb4b4; border-color: #4a2530; }
  .pie { margin-top: 22px; color: #77808f; font-size: 14px; }
</style>
</head><body><main>${contenido}</main></body></html>`;
}
