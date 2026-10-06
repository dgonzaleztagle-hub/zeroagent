import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';

// Conexión de Google Calendar por negocio (un runtime = un cliente = una fila 'primary').
// El client_id/client_secret son a nivel PRODUCTO ZeroAgent (una sola app de Google Cloud,
// reusada por todos los clientes) y viven en env vars, no en esta tabla. Lo único que cambia
// por cliente es el refresh_token que resulta de que ESE negocio autorice SU Google Calendar.
const SETTINGS_ID = 'primary';
// calendar.freebusy es un scope aparte de calendar.events — sin él, freeBusy.query devuelve
// "Request had insufficient authentication scopes" aunque el evento sí se pueda crear/editar
// (encontrado probando la Fase 1 en producción, 18-08-2026).
// calendar.calendarlist.readonly (26-08-2026): sin esto, calendarList.list también da 403 —
// necesario para descubrir TODOS los calendarios de la cuenta (un negocio real casi siempre
// tiene más de uno: "Mi calendario" por defecto casi vacío, más uno o varios de trabajo/personal
// donde realmente pasan sus horas — caso real franciskom: sus pacientes vivían en "Pacientes
// FrancisKOM", nunca en "primary", así que freebusy contra un solo calendario fijo siempre daba
// falso "libre" para cualquier bloqueo en los otros).
// contacts.readonly (31-08-2026): Francisco ya movió sus contactos del teléfono a Google
// Contacts (siguiendo la guía que le mandamos) — con este scope podemos leerlos (solo lectura,
// nunca escribimos en su libreta) y traer nombres/teléfonos al CRM sin que tenga que tipear nada.
const SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/contacts.readonly';
const STATE_TTL_MS = 10 * 60 * 1000;

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function oauthClient() {
  const clientId = clean(process.env.GOOGLE_OAUTH_CLIENT_ID, 200);
  const clientSecret = clean(process.env.GOOGLE_OAUTH_CLIENT_SECRET, 200);
  if (!clientId || !clientSecret) throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET no configurados en este runtime.');
  return { clientId, clientSecret };
}

// Reusa la misma clave que ya cifra las API keys BYOK (AI_CREDENTIALS_ENCRYPTION_KEY): es un
// secreto simétrico genérico del runtime para cifrar-en-reposo, no algo específico de IA.
function encryptionKey() {
  const value = clean(process.env.AI_CREDENTIALS_ENCRYPTION_KEY, 200);
  if (!value) throw new Error('Falta AI_CREDENTIALS_ENCRYPTION_KEY para guardar la conexión de Google Calendar.');
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('AI_CREDENTIALS_ENCRYPTION_KEY debe contener exactamente 32 bytes en base64 o 64 caracteres hex.');
  return key;
}

function encryptToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    refresh_token_ciphertext: ciphertext.toString('base64'),
    refresh_token_iv: iv.toString('base64'),
    refresh_token_tag: cipher.getAuthTag().toString('base64')
  };
}

function decryptToken(settings) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(settings.refresh_token_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(settings.refresh_token_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(settings.refresh_token_ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

// state firmado (HMAC), sin tabla de sesiones propia — mismo patrón que auth.js para el login
// por PIN. Evita que /auth/google/callback acepte un `code` que no vino de un /auth/google
// iniciado por este mismo runtime (protección CSRF del flujo OAuth).
function stateSecret() {
  return process.env.SESSION_SECRET || process.env.DASHBOARD_ACCESS_KEY || '';
}

// Sólo rutas relativas propias (ej. "/agenda", "/m/") — nunca una URL absoluta ni
// protocol-relative ("//evil.com"), para no convertir esto en un open redirect. Los navegadores
// tratan "\" igual que "/" al resolver una URL, así que "/\evil.com" es tan protocol-relative
// como "//evil.com" — hay que normalizar antes de validar, no sólo mirar barras normales.
function safeReturnPath(path) {
  const value = clean(path, 200).replace(/\\/g, '/');
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/agenda';
  return value;
}

export function signGoogleOAuthState(operatorId, returnPath) {
  const secret = stateSecret();
  if (!secret) throw new Error('SESSION_SECRET/DASHBOARD_ACCESS_KEY no configurado.');
  const payload = [
    operatorId || '', Date.now() + STATE_TTL_MS, randomBytes(8).toString('hex'),
    Buffer.from(safeReturnPath(returnPath)).toString('base64url')
  ].join('.');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

// Devuelve el returnPath sólo si la firma es válida y no expiró; si no, null (el llamador
// decide el fallback — no lo resolvemos acá para no ocultar un state inválido/manipulado).
export function verifyGoogleOAuthState(state) {
  const secret = stateSecret();
  if (!secret || !state || typeof state !== 'string') return null;
  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) return null;
  let payload;
  try { payload = Buffer.from(payloadB64, 'base64url').toString(); } catch { return null; }
  const expectedSig = createHmac('sha256', secret).update(payload).digest('base64url');
  const left = Buffer.from(sig); const right = Buffer.from(expectedSig);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const [, expStr, , returnPathB64] = payload.split('.');
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return null;
  try { return safeReturnPath(Buffer.from(returnPathB64, 'base64url').toString()); } catch { return '/agenda'; }
}

function redirectUri(req) {
  const explicit = clean(process.env.GOOGLE_OAUTH_REDIRECT_BASE_URL, 300);
  if (explicit) return `${explicit.replace(/\/$/, '')}/auth/google/callback`;
  const proto = req.headers['x-forwarded-proto'] || (process.env.RUNTIME_MODE === 'preview_local' ? 'http' : 'https');
  const host = req.headers.host || 'localhost';
  return `${proto}://${host}/auth/google/callback`;
}

export function buildGoogleAuthUrl(req, state) {
  const { clientId } = oauthClient();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCodeForTokens(req, code) {
  const { clientId, clientSecret } = oauthClient();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri(req), grant_type: 'authorization_code'
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description || body.error || `Google respondió ${response.status} al canjear el código.`);
  return body; // { access_token, refresh_token, expires_in, id_token, scope, token_type }
}

function decodeIdTokenEmail(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString());
    return clean(payload.email, 200);
  } catch { return ''; }
}

// Todos los calendarios visibles para esta cuenta (propios + compartidos que aceptó) — no sólo
// "primary". Si esto falla (ej. token sin el scope calendar.calendarlist.readonly todavía,
// negocio conectado antes del 26-08-2026), no revienta la conexión: freebusy sigue funcionando
// contra el/los calendario(s) ya guardados, sólo no se puede refrescar la lista hasta reconectar.
async function fetchCalendarList(accessToken) {
  const response = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=freeBusyReader', {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Google respondió ${response.status} al listar calendarios.`);
  return (body.items || []).map(item => ({ id: item.id, summary: clean(item.summary, 200), primary: Boolean(item.primary) }));
}

async function storedSettings() {
  if (!agendaUsesSupabase()) return null;
  try {
    const rows = await agendaSupabaseRequest(`/rest/v1/za_google_calendar_settings?id=eq.${SETTINGS_ID}&select=*&limit=1`);
    return rows?.[0] || null;
  } catch (error) {
    if (/za_google_calendar_settings|does not exist|schema cache/i.test(error.message)) return null;
    throw error;
  }
}

export async function getGoogleCalendarStatus() {
  const settings = await storedSettings();
  return {
    connected: Boolean(settings?.refresh_token_ciphertext),
    accountEmail: settings?.google_account_email || '',
    connectedAt: settings?.connected_at || null,
    targetCalendarId: settings?.google_calendar_id || 'primary',
    calendarRoutes: settings?.calendar_routes && typeof settings.calendar_routes === 'object' ? settings.calendar_routes : {},
    calendars: Array.isArray(settings?.calendar_ids) ? settings.calendar_ids : [],
    travelBufferMinutes: Number(settings?.travel_buffer_minutes) || 0
  };
}

// Re-descubre los calendarios de la cuenta ya conectada (botón "Actualizar calendarios") — para
// cuando el negocio crea uno nuevo en Google después de haber conectado, sin tener que
// desconectar/reconectar. Devuelve la lista actualizada (misma forma que getGoogleCalendarStatus).
export async function refreshGoogleCalendarList() {
  const ctx = await calendarContext();
  if (!ctx) throw new Error('Google Calendar no está conectado.');
  const calendarIds = await fetchCalendarList(ctx.accessToken);
  await agendaSupabaseRequest(`/rest/v1/za_google_calendar_settings?id=eq.${SETTINGS_ID}`, {
    method: 'PATCH', body: JSON.stringify({ calendar_ids: calendarIds, updated_at: new Date().toISOString() })
  });
  return calendarIds;
}

// El calendario donde el bot escribe las citas que crea (distinto de la lista completa que
// freebusy consulta) — un negocio con varios calendarios necesita elegir cuál es "el de
// pacientes/trabajo", no asumir que es "primary".
export async function setGoogleCalendarTarget(calendarId) {
  const id = clean(calendarId, 300);
  if (!id) throw new Error('Falta el calendario a usar.');
  const settings = await storedSettings();
  const known = Array.isArray(settings?.calendar_ids) ? settings.calendar_ids : [];
  if (known.length && !known.some(cal => cal.id === id)) throw new Error('Ese calendario no está en la lista de calendarios de esta cuenta.');
  await agendaSupabaseRequest(`/rest/v1/za_google_calendar_settings?id=eq.${SETTINGS_ID}`, {
    method: 'PATCH', body: JSON.stringify({ google_calendar_id: id, updated_at: new Date().toISOString() })
  });
}

// Calendario propio por "ruta": el nombre de una sede (ej. "Box Buin (El Recurso)") o
// "delivery:mobile" para toda atención a domicilio — un domicilio nunca resuelve a una sede, así
// que se identifica por el modo de entrega del servicio. Las citas que crea el bot en esa ruta se
// escriben en el calendario asignado en vez del calendario destino general. calendarId vacío quita
// la asignación y esa ruta vuelve al calendario destino.
export async function setGoogleCalendarRoute(routeKey, calendarId) {
  const key = clean(routeKey, 200);
  if (!key) throw new Error('Falta la sede o el tipo de atención a asignar.');
  const settings = await storedSettings();
  const known = Array.isArray(settings?.calendar_ids) ? settings.calendar_ids : [];
  const id = clean(calendarId, 300);
  if (id && known.length && !known.some(cal => cal.id === id)) throw new Error('Ese calendario no está en la lista de calendarios de esta cuenta.');
  const next = { ...(settings?.calendar_routes && typeof settings.calendar_routes === 'object' ? settings.calendar_routes : {}) };
  if (id) next[key] = id; else delete next[key];
  await agendaSupabaseRequest(`/rest/v1/za_google_calendar_settings?id=eq.${SETTINGS_ID}`, {
    method: 'PATCH', body: JSON.stringify({ calendar_routes: next, updated_at: new Date().toISOString() })
  });
}

// Minutos de margen que hay que sumar antes/después de un bloqueo en OTRO calendario (no el de
// escritura) para que un horario recién ofrecido sea realmente cumplible — ver el comentario en
// getGoogleCalendarBusyIntervals. 0 = comportamiento anterior (pegado al bloqueo, sin margen).
export async function setGoogleCalendarBuffer(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 0 || value > 240) throw new Error('Los minutos de traslado deben ser un número entre 0 y 240.');
  await agendaSupabaseRequest(`/rest/v1/za_google_calendar_settings?id=eq.${SETTINGS_ID}`, {
    method: 'PATCH', body: JSON.stringify({ travel_buffer_minutes: Math.round(value), updated_at: new Date().toISOString() })
  });
}

// Punto de entrada del callback: canjea el code, guarda el refresh_token cifrado. No devuelve
// el token a quien llama — sólo confirma que quedó conectado.
export async function completeGoogleCalendarConnection(req, { code, operatorId }) {
  if (!agendaUsesSupabase()) throw new Error('Google Calendar requiere el Supabase del cliente.');
  const tokens = await exchangeCodeForTokens(req, code);
  if (!tokens.refresh_token) {
    // Pasa cuando el negocio ya había autorizado antes y Google no reemite refresh_token en un
    // re-consentimiento normal. Como pedimos prompt=consent siempre, esto no debería pasar en
    // el flujo normal — pero si pasa, es mejor avisar claro que dejar la conexión a medias.
    throw new Error('Google no devolvió un refresh_token. Vuelve a intentar la conexión desde cero.');
  }
  const email = decodeIdTokenEmail(tokens.id_token);
  // Best-effort: si falla (scope viejo en un re-consentimiento raro, error transitorio de
  // Google), la conexión igual queda buena — sólo no hay lista de calendarios para elegir
  // hasta que se use "Actualizar calendarios" o se reconecte.
  let calendarIds = [];
  try { calendarIds = await fetchCalendarList(tokens.access_token); } catch { calendarIds = []; }
  const record = {
    id: SETTINGS_ID,
    google_account_email: email,
    calendar_ids: calendarIds,
    ...encryptToken(tokens.refresh_token),
    connected_at: new Date().toISOString(),
    connected_by_operator_id: operatorId || null,
    updated_at: new Date().toISOString()
  };
  await agendaSupabaseRequest('/rest/v1/za_google_calendar_settings?on_conflict=id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(record)
  });
  return { accountEmail: email };
}

export async function disconnectGoogleCalendar() {
  if (!agendaUsesSupabase()) throw new Error('Google Calendar requiere el Supabase del cliente.');
  await agendaSupabaseRequest(`/rest/v1/za_google_calendar_settings?id=eq.${SETTINGS_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({
      google_account_email: '', refresh_token_ciphertext: '', refresh_token_iv: '', refresh_token_tag: '',
      connected_at: null, connected_by_operator_id: null, updated_at: new Date().toISOString()
    })
  });
}

// Los access_token de Google duran ~1h y este runtime es serverless (nada persiste entre
// invocaciones) — más simple y robusto pedir uno fresco en cada uso que intentar cachearlo.
// Resuelve accessToken + calendarId desde UNA sola lectura de storedSettings(): antes cada
// función de Calendar (freebusy/crear/actualizar/borrar evento) leía la fila de settings dos
// veces por separado (una para el token, otra para el id de calendario) — mismo dato, dos
// round-trips a Supabase por operación.
async function accessTokenFromSettings(settings) {
  const refreshToken = decryptToken(settings);
  const { clientId, clientSecret } = oauthClient();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description || body.error || `Google respondió ${response.status} al refrescar el token.`);
  return body.access_token;
}

// Access token fresco de la MISMA cuenta ya conectada, para integraciones hermanas que comparten
// el mismo OAuth (ej. google-contacts.js) sin duplicar el intercambio de refresh_token. Null si no
// hay conexión — el llamador decide qué hacer (nunca revienta acá).
export async function getGoogleAccessToken() {
  const settings = await storedSettings();
  if (!settings?.refresh_token_ciphertext) return null;
  return accessTokenFromSettings(settings);
}

async function calendarContext() {
  const settings = await storedSettings();
  if (!settings?.refresh_token_ciphertext) return null;
  const accessToken = await accessTokenFromSettings(settings);
  const calendarId = settings.google_calendar_id || 'primary';
  const knownIds = Array.isArray(settings.calendar_ids) ? settings.calendar_ids.map(cal => cal.id).filter(Boolean) : [];
  // Freebusy debe mirar TODOS los calendarios de la cuenta (un bloqueo personal en cualquiera de
  // ellos igual tiene que bloquear el horario) — si todavía no hay lista descubierta (conexión
  // vieja, antes de tener este scope), cae de vuelta al único calendario que se conocía antes.
  return {
    accessToken, calendarId,
    calendarRoutes: settings.calendar_routes && typeof settings.calendar_routes === 'object' ? settings.calendar_routes : {},
    busyCalendarIds: knownIds.length ? knownIds : [calendarId],
    travelBufferMinutes: Number(settings.travel_buffer_minutes) || 0
  };
}

// Paleta fija de Google (colorId 1-11) — mapeo simple por sede mientras franciskom sea el único
// cliente con esto. Eleva Salud no aparece a propósito: nunca se agenda por el bot (ver
// agent-package.json → locations → "no es agendable directo por el agente"), así que este
// mapeo nunca puede generar un evento para esa sede.
const LOCATION_COLOR_IDS = {
  'Box Buin (El Recurso)': '10', // Basil (verde)
  'Atención a domicilio': '5'    // Banana (amarillo)
};

export function colorIdForLocation(locationName) {
  return LOCATION_COLOR_IDS[locationName] || null;
}

// Calendario donde se escribe una cita: el primero asignado entre sus rutas (más específica
// primero) que todavía exista en la cuenta (pudo borrarse en Google); si no, el calendario destino.
function calendarIdForRoute(ctx, routeKeys) {
  for (const key of routeKeys) {
    const mapped = ctx.calendarRoutes[key];
    if (mapped && ctx.busyCalendarIds.includes(mapped)) return mapped;
  }
  return ctx.calendarId;
}

// Sólo devuelve rangos ocupados (sin título, invitados ni ningún otro detalle del evento —
// es literalmente todo lo que la API de freebusy expone). Nunca sabemos si un bloqueo es
// personal, Eleva Salud u otra cosa, y no hace falta: el bot sólo necesita "libre u ocupado".
// Si NO hay Calendar conectado, [] es el resultado correcto (nada que verificar) — pero un error
// REAL (token revocado, Supabase caído, clave de cifrado rotada) no se traga acá en silencio:
// se deja propagar igual que en createGoogleCalendarEvent/updateGoogleCalendarEventTime/
// deleteGoogleCalendarEvent, para que syncGoogleCalendarBestEffort (o el catch de
// excludeGoogleCalendarBusySlots/assertNotBusyOnGoogleCalendar en agenda.js) lo loguee. Antes
// un `.catch(() => null)` acá tragaba CUALQUIER falla sin loguear nada, dejando el chequeo de
// freebusy ciego en silencio mientras las funciones hermanas sí quedaban logueadas para el
// mismo error — encontrado en la revisión del 19-08-2026.
export async function getGoogleCalendarBusyIntervals(startIso, endIso) {
  const ctx = await calendarContext();
  if (!ctx) return [];
  const response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ timeMin: startIso, timeMax: endIso, items: ctx.busyCalendarIds.map(id => ({ id })) })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Google respondió ${response.status} al consultar freebusy.`);
  // Unión de TODOS los calendarios de la cuenta -- un bloqueo en cualquiera de ellos ("Familia",
  // "Entrenamiento", el de pacientes, etc.) cuenta como ocupado, sin importar en cuál esté.
  // Un bloqueo que viene de OTRO calendario (no el que usamos para escribir nuestras propias
  // citas) se estira travelBufferMinutes antes y después: un profesional que atiende en más de
  // un lugar necesita tiempo real para trasladarse, no puede empezar la próxima cita justo
  // cuando termina el compromiso anterior en otro sitio (caso real franciskom: Eleva Salud
  // termina 19:00, sin buffer ofrecíamos 19:00 igual, imposible de cumplir en la práctica).
  const bufferMs = ctx.travelBufferMinutes * 60_000;
  const calendars = body.calendars || {};
  return ctx.busyCalendarIds.flatMap(id => {
    const intervals = calendars[id]?.busy || [];
    if (!bufferMs || id === ctx.calendarId) return intervals;
    return intervals.map(interval => ({
      start: new Date(new Date(interval.start).getTime() - bufferMs).toISOString(),
      end: new Date(new Date(interval.end).getTime() + bufferMs).toISOString()
    }));
  });
}

// Crea un evento propio en el Calendar conectado. Devuelve null si no hay conexión (para que el
// llamador lo trate como "no hay nada que guardar", no como error). El invitado por correo hace
// que Calendar le mande a el/la paciente el mismo aviso con confirmar/rechazar que Francisco ya
// usaba a mano — no es algo que construyamos nosotros, es comportamiento nativo de Calendar.
// Devuelve { eventId, calendarId } — el calendarId hay que guardarlo junto al evento, porque
// actualizar/borrar después tiene que ir al MISMO calendario donde se creó.
export async function createGoogleCalendarEvent({ summary, description, startIso, endIso, attendeeEmail, colorId, locationName, deliveryMode }) {
  const ctx = await calendarContext();
  if (!ctx) return null;
  const calendarId = calendarIdForRoute(ctx, [deliveryMode ? `delivery:${deliveryMode}` : '', locationName || ''].filter(Boolean));
  const payload = { summary, description, start: { dateTime: startIso }, end: { dateTime: endIso } };
  if (colorId) payload.colorId = colorId;
  if (attendeeEmail) payload.attendees = [{ email: attendeeEmail }];
  // sendUpdates=all: sin esto Google NO manda el correo de invitación aunque haya attendees —
  // el default de la API es "none". Es justo el comportamiento que Francisco pidió replicar
  // (el correo con confirmar/rechazar que ya usa a mano).
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `Google respondió ${response.status} al crear el evento.`);
  return { eventId: result.id, calendarId };
}

// Sólo actualiza el evento que NOSOTROS creamos (por eventId propio) — nunca busca ni toca
// eventos existentes por título/fecha. Si el evento ya no existe en Google (borrado a mano),
// lo tratamos como no-op en vez de reventar el reagendamiento.
// calendarId = el guardado con la cita; ausente en citas anteriores a este campo (siempre vivieron
// en el calendario destino general).
export async function updateGoogleCalendarEventTime(eventId, { startIso, endIso, calendarId }) {
  if (!eventId) return;
  const ctx = await calendarContext();
  if (!ctx) return;
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId || ctx.calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${ctx.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ start: { dateTime: startIso }, end: { dateTime: endIso } })
  });
  if (response.ok || response.status === 404 || response.status === 410) return;
  const result = await response.json().catch(() => ({}));
  throw new Error(result.error?.message || `Google respondió ${response.status} al actualizar el evento.`);
}

export async function deleteGoogleCalendarEvent(eventId, calendarId) {
  if (!eventId) return;
  const ctx = await calendarContext();
  if (!ctx) return;
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId || ctx.calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${ctx.accessToken}` }
  });
  if (response.ok || response.status === 404 || response.status === 410) return;
  const result = await response.json().catch(() => ({}));
  throw new Error(result.error?.message || `Google respondió ${response.status} al borrar el evento.`);
}
