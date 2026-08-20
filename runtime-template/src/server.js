import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPackage, answerWithGroq } from './engine.js';
import { notifySentinel } from './sentinel.js';
import { recordUsage } from './metrics.js';
import { agendaConfig, agendaSupabaseRequest, agendaSupabaseUpload, agendaUsesSupabase, appendAgendaFeedbackLocal, createAgendaAppointment, createAgendaAvailabilityBlock, createAgendaAvailabilityRule, bulkUpdateCustomers, createManualCustomer, deleteAgendaAvailabilityBlock, deleteAgendaAvailabilityRule, getAgendaDashboard, getAvailableSlots, getCustomerDetail, importAgendaCustomers, listCustomers, normalizeChilePhone, rescheduleAgendaAppointment, updateAgendaAppointment, updateAgendaFeedback, updateAppointmentNotes, updateCustomerSettings } from './agenda.js';
import { parseContactsFile } from './contacts-import.js';
import { dispatchAgendaOutbox } from './outbox.js';
import { verifyZavuSignature, sendZavuWhatsApp, zavuDeliveryUpdate, zavuEventId, zavuProviderMessage } from './zavu.js';
import { appendConversationMessage, createOperator, findConversationMessageByClientId, getAgentControl, getConversationInbox, getOrCreateConversation, loadConversationHistory, updateAgentControl, updateConversationMessageDelivery, updateConversationOperation } from './conversations.js';
import { addKnowledgeSuggestion, currentConfirmedFacts, listKnowledgeSuggestions } from './knowledge.js';
import { createHandoffTicket, listHandoffTickets, updateHandoffTicket } from './handoffs.js';
import { addBusinessData, addBusinessInfo, listBusinessData, listBusinessInfo } from './business-data.js';
import { getNotificationSettings, updateNotificationSettings } from './notification-settings.js';
import { findOperatorByPin, operatorSessionFromRequest, sessionSetCookieHeader, setOperatorPin, signSession, verifyPinHash } from './auth.js';
import { getPublicAiAccount, resolveRuntimeLlmConfig, updateAiSelection } from './ai-account.js';
import { appendCustomerRecordEntry, listCustomerRecord } from './customer-records.js';
import { buildGoogleAuthUrl, completeGoogleCalendarConnection, disconnectGoogleCalendar, getGoogleCalendarStatus, signGoogleOAuthState, verifyGoogleOAuthState } from './google-calendar.js';

// Capturar errores de inicialización en vez de dejar que el módulo falle al
// importarse: en Vercel eso da un FUNCTION_INVOCATION_FAILED opaco en cada
// request, sin ninguna pista de la causa real. El detalle se loguea server-side
// (Vercel runtime logs); al cliente sólo se le devuelve un 500 genérico.
let initError = null;
let packageData = null;
const port = Number(process.env.PORT || 3000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeMode = process.env.RUNTIME_MODE || 'production';
const channelProvider = process.env.CHANNEL_PROVIDER || 'zavu';
const previewKey = process.env.PREVIEW_ACCESS_KEY || '';
const feedbackWebhookUrl = process.env.FEEDBACK_WEBHOOK_URL || '';
const dashboardKey = process.env.DASHBOARD_ACCESS_KEY || '';
const previewWebhookEvents = new Map();
const rateWindows = new Map();
try {
  packageData = await loadPackage();
} catch (error) {
  initError = `loadPackage failed: ${error.stack || error.message}`;
}

function secretMatches(actual = '', expected = '') {
  const left = Buffer.from(String(actual)); const right = Buffer.from(String(expected));
  return Boolean(expected) && left.length === right.length && timingSafeEqual(left, right);
}

function validateRuntimeConfiguration() {
  if (!['preview_local', 'staging', 'production'].includes(runtimeMode)) {
    throw new Error('RUNTIME_MODE debe ser preview_local, staging o production.');
  }
  if (!['zavu', 'generic_webhook'].includes(channelProvider)) {
    throw new Error('CHANNEL_PROVIDER debe ser zavu o generic_webhook.');
  }
  if (runtimeMode === 'preview_local') return;
  if (channelProvider !== 'zavu') throw new Error('Staging y producción requieren CHANNEL_PROVIDER=zavu.');
  const required = [
    ['PREVIEW_ACCESS_KEY', previewKey],
    ['DASHBOARD_ACCESS_KEY', dashboardKey],
    ['ONBOARDING_ACCESS_TOKEN', process.env.ONBOARDING_ACCESS_TOKEN]
  ];
  const hasByokVault = Boolean(process.env.AI_CREDENTIALS_ENCRYPTION_KEY);
  const hasLegacyAi = Boolean(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY);
  if (!hasByokVault && !hasLegacyAi) {
    required.push(['vault BYOK o LLM_API_KEY', '']);
  }
  if (hasLegacyAi) {
    const llmProvider = process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'groq');
    if (!['openai', 'groq', 'compatible'].includes(llmProvider)) throw new Error('LLM_PROVIDER debe ser openai, groq o compatible.');
    const llmModel = process.env.LLM_MODEL || (llmProvider === 'openai' ? 'gpt-4o-mini' : process.env.GROQ_MODEL || 'llama-3.3-70b-versatile');
    required.push(['LLM_MODEL', llmModel]);
    if (llmProvider === 'compatible') required.push(['LLM_BASE_URL', process.env.LLM_BASE_URL]);
  }
  if (agendaConfig(packageData)?.enabled) {
    required.push(['SUPABASE_URL', process.env.SUPABASE_URL], ['SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY]);
  }
  if (channelProvider === 'zavu') {
    required.push(
      ['ZAVUDEV_API_KEY', process.env.ZAVUDEV_API_KEY],
      ['ZAVUDEV_SENDER_ID', process.env.ZAVUDEV_SENDER_ID],
      ['ZAVUDEV_WEBHOOK_SECRET', process.env.ZAVUDEV_WEBHOOK_SECRET]
    );
  }
  const missing = required.filter(([, value]) => !String(value || '').trim()).map(([name]) => name);
  if (missing.length) throw new Error(`Configuración incompleta para ${runtimeMode}: ${missing.join(', ')}`);
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, private',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function jsonWithCookie(res, status, body, cookieHeader) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, private',
    'x-content-type-options': 'nosniff',
    'set-cookie': cookieHeader
  });
  res.end(JSON.stringify(body));
}

// Único criterio de "¿esto es un teléfono?" para todo el runtime — cualquier ruta que
// decida entre dashboard de escritorio y consola móvil debe usar este mismo helper.
function isMobileRequest(req) {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(req.headers['user-agent'] || '');
}

async function asset(res, fileName, contentType) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(await fs.readFile(path.join(root, 'public', fileName)));
}

async function answerWithConfiguredAi(message, context = {}) {
  const resolved = await resolveRuntimeLlmConfig();
  return answerWithGroq(packageData, message, { ...context, ...(resolved ? { llm: resolved } : {}) });
}

function aiDashboardView(account) {
  const selection = account.selection || {};
  return {
    status: selection.mode === 'byok' && selection.credentialConfigured ? 'active' : 'not_configured',
    provider: selection.byokProvider || '',
    model: selection.byokModel || '',
    mode: selection.mode,
    capabilities: {
      byok: Boolean(process.env.AI_CREDENTIALS_ENCRYPTION_KEY && agendaUsesSupabase())
    }
  };
}

async function readJson(req, maxBytes = 256 * 1024) {
  let raw = ''; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`El cuerpo de la solicitud supera el máximo de ${Math.floor(maxBytes / 1024)} KB.`);
    raw += chunk;
  }
  return JSON.parse(raw || '{}');
}

async function readRaw(req, maxBytes = 256 * 1024) {
  let raw = ''; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`El cuerpo de la solicitud supera el máximo de ${Math.floor(maxBytes / 1024)} KB.`);
    raw += chunk;
  }
  return raw;
}

async function readBuffer(req, maxBytes = 15 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('El archivo supera el máximo de 15 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function onboardingAuthorized(value = '') {
  const expected = process.env.ONBOARDING_ACCESS_TOKEN || previewKey;
  const left = Buffer.from(String(value)); const right = Buffer.from(String(expected));
  return Boolean(expected) && left.length === right.length && timingSafeEqual(left, right);
}

const zavuLeaseSeconds = Math.max(30, Math.min(900, Number(process.env.ZAVU_WEBHOOK_LEASE_SECONDS) || 300));

// El claim no es un marcador efímero de "ya lo vi": conserva estado, lease y reply.
// Así un fallo posterior al LLM o al envío se reanuda sin ejecutar herramientas ni
// construir una segunda respuesta. Las filas nunca se borran después de enviar.
async function claimZavuEvent(eventId, eventType) {
  if (agendaUsesSupabase()) {
    const result = await agendaSupabaseRequest('/rest/v1/rpc/za_claim_webhook_event', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
        p_event_id: eventId, p_source: 'zavu', p_event_type: eventType || '', p_lease_seconds: zavuLeaseSeconds
      })
    });
    return Array.isArray(result) ? result[0] : result;
  }
  const now = Date.now();
  const existing = previewWebhookEvents.get(eventId);
  if (existing && (['completed', 'ignored'].includes(existing.status) || (existing.status === 'processing' && existing.leaseExpiresAt > now))) {
    return { acquired: false, status: existing.status, lease_token: existing.leaseToken, reply: existing.reply || {}, attempts: existing.attempts || 1 };
  }
  const claim = {
    acquired: true, status: 'processing', lease_token: randomUUID(), reply: existing?.reply || {},
    attempts: Number(existing?.attempts || 0) + 1
  };
  previewWebhookEvents.set(eventId, { status: 'processing', leaseToken: claim.lease_token, reply: claim.reply, attempts: claim.attempts, leaseExpiresAt: now + zavuLeaseSeconds * 1000 });
  if (previewWebhookEvents.size > 500) {
    const terminalKey = [...previewWebhookEvents].find(([, item]) => item.status !== 'processing')?.[0];
    if (terminalKey) previewWebhookEvents.delete(terminalKey);
  }
  return claim;
}

async function checkpointZavuEvent(eventId, leaseToken, reply = {}) {
  if (agendaUsesSupabase()) {
    const result = await agendaSupabaseRequest('/rest/v1/rpc/za_checkpoint_webhook_event', {
      method: 'POST', body: JSON.stringify({ p_event_id: eventId, p_lease_token: leaseToken, p_reply: reply, p_lease_seconds: zavuLeaseSeconds })
    });
    return result === true || result?.[0] === true;
  }
  const existing = previewWebhookEvents.get(eventId);
  if (!existing || existing.status !== 'processing' || existing.leaseToken !== leaseToken) return false;
  existing.reply = { ...(existing.reply || {}), ...reply };
  existing.leaseExpiresAt = Date.now() + zavuLeaseSeconds * 1000;
  return true;
}

async function completeZavuEvent(eventId, leaseToken, status = 'completed', reply = {}, error = '') {
  if (agendaUsesSupabase()) {
    const result = await agendaSupabaseRequest('/rest/v1/rpc/za_complete_webhook_event', {
      method: 'POST', body: JSON.stringify({ p_event_id: eventId, p_lease_token: leaseToken, p_status: status, p_reply: reply, p_error: error || null })
    });
    return result === true || result?.[0] === true;
  }
  const existing = previewWebhookEvents.get(eventId);
  if (!existing || existing.status !== 'processing' || existing.leaseToken !== leaseToken) return false;
  previewWebhookEvents.set(eventId, { ...existing, status, leaseToken: null, leaseExpiresAt: 0, reply: { ...(existing.reply || {}), ...reply }, error });
  return true;
}

function previewAuthorized(req, body = {}) {
  if (runtimeMode === 'preview_local' && !previewKey) return true;
  return secretMatches(req.headers['x-preview-key'] || body.accessKey, previewKey);
}

async function dashboardAuthorized(req, body = {}) {
  if (runtimeMode === 'preview_local' && !dashboardKey) return true;
  if (secretMatches(req.headers['x-dashboard-key'] || body.dashboardKey, dashboardKey)) return true;
  // Sin dashboardKey configurado (o sin enviarlo), la sesión de operador logueado por PIN es la
  // única puerta — antes de esto, ausencia de dashboardKey significaba "acceso libre".
  return Boolean(await operatorSessionFromRequest(req));
}

// req.socket no existe en el request que Vercel entrega a una función serverless (a diferencia
// de un http.IncomingMessage real en preview local/Docker) — usarlo sin resguardo tumbaba CADA
// reserva pública en producción con un 422 opaco. x-forwarded-for además da la IP real del
// cliente, no la del proxy, que es lo que un rate limit por IP necesita de todas formas.
function clientIp(req) {
  // x-forwarded-for primero: detrás de un proxy/hosting serverless (Vercel) es la única IP real
  // disponible — req.socket no existe ahí. socket.remoteAddress queda como respaldo para conexión
  // directa (Docker/preview local), donde si existiera un x-forwarded-for sería del cliente mismo
  // falsificándolo, no de un proxy de confianza.
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

function withinRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateWindows.get(key) || []).filter(time => now - time < windowMs);
  if (hits.length >= limit) return false;
  hits.push(now); rateWindows.set(key, hits);
  return true;
}

async function recordFeedback(payload) {
  const event = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
  // Docker/VPS: respaldo local inmediato. Vercel: configurar FEEDBACK_WEBHOOK_URL hacia Supabase/API propia.
  try {
    const dir = path.join(root, 'storage');
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'feedback.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  } catch (error) {
    console.warn('No se pudo dejar respaldo local del feedback:', error.message);
  }
  if (!agendaUsesSupabase()) {
    try { await appendAgendaFeedbackLocal(packageData, event); }
    catch (error) { console.warn('No se pudo listar el feedback en el dashboard local:', error.message); }
  }
  if (feedbackWebhookUrl) {
    const response = await fetch(feedbackWebhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event)
    });
    if (!response.ok) throw new Error(`Webhook de feedback respondió ${response.status}`);
  }
  // En una instalación real, el feedback queda también en el Supabase que pertenece al cliente.
  // La tabla genera un evento outbox para avisar sin que el runtime dependa del Studio.
  if (agendaConfig(packageData)?.enabled && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { agendaSupabaseRequest } = await import('./agenda.js');
    await agendaSupabaseRequest('/rest/v1/za_feedback_items', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        rating: payload.rating,
        question: String(payload.question || '').slice(0, 2000),
        reply: String(payload.reply || '').slice(0, 2000),
        correction_text: String(payload.expected_answer || '').slice(0, 4000),
        conversation_id: payload.conversation_id || null,
        message_id: payload.message_id || null
      })
    });
  }
  return event;
}

// Handler puro (req, res), expuesto por api/index.js como función serverless de Vercel.
export async function handleRequest(req, res) {
  if (initError) {
    console.error('Fallo de inicialización del runtime:', initError);
    return json(res, 500, { error: 'El runtime no pudo inicializarse. Revisa los logs del servidor.' });
  }
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;
  if (req.method === 'GET' && pathname === '/') {
    // Si el build trae una landing propia (public/landing.html) se sirve en la raíz;
    // si no, "/" cae al dashboard de siempre — pero el dashboard de ESCRITORIO
    // (agenda.html) no está pensado para verse en un teléfono real (el bottom nav y los
    // controles se rompen en pantallas angostas), así que el dueño entrando desde el
    // celular tiene que caer en /m (la consola diseñada para eso), no en agenda.html.
    // El simulador de prueba queda aparte, en /playground.
    // IMPORTANTE: no puede llamarse "index.html" ningún archivo en public/ — Vercel sirve
    // archivos estáticos con ese nombre exacto en "/" ANTES de ejecutar este rewrite, así
    // que esta lógica condicional nunca se alcanzaría (el simulador ganaría siempre).
    try { return html(res, 200, await fs.readFile(path.join(root, 'public', 'landing.html'), 'utf8')); }
    catch {
      if (isMobileRequest(req)) return html(res, 200, await fs.readFile(path.join(root, 'public', 'm', 'index.html'), 'utf8'));
      return html(res, 200, await fs.readFile(path.join(root, 'public', 'agenda.html'), 'utf8'));
    }
  }
  if (req.method === 'GET' && pathname === '/landing.css') return asset(res, 'landing.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/landing.js') return asset(res, 'landing.js', 'application/javascript; charset=utf-8');
  if (req.method === 'GET' && pathname === '/logo.png') return asset(res, 'logo.png', 'image/png');
  if (req.method === 'GET' && pathname === '/francisco-corporativa.png') return asset(res, 'francisco-corporativa.png', 'image/png');
  if (req.method === 'GET' && pathname === '/sesion-paso-a-paso.jpeg') return asset(res, 'sesion-paso-a-paso.jpeg', 'image/jpeg');
  if (req.method === 'GET' && pathname === '/playground') {
    return html(res, 200, await fs.readFile(path.join(root, 'public', 'playground.html'), 'utf8'));
  }
  if (req.method === 'GET' && pathname === '/agenda') {
    // Mismo criterio que "/": el dashboard de escritorio no es responsive (bottom nav y
    // controles pensados para pantalla ancha) — un link duro a /agenda (ej. "Acceso equipo"
    // en el footer del landing) no puede asumir que quien lo toca está en un computador.
    if (isMobileRequest(req)) return html(res, 200, await fs.readFile(path.join(root, 'public', 'm', 'index.html'), 'utf8'));
    return html(res, 200, await fs.readFile(path.join(root, 'public', 'agenda.html'), 'utf8'));
  }
  if (req.method === 'GET' && (pathname === '/m' || pathname === '/m/')) {
    return html(res, 200, await fs.readFile(path.join(root, 'public', 'm', 'index.html'), 'utf8'));
  }
  if (req.method === 'GET' && pathname === '/m/m.css') return asset(res, path.join('m', 'm.css'), 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/m/m.js') return asset(res, path.join('m', 'm.js'), 'application/javascript; charset=utf-8');
  if (req.method === 'GET' && (pathname === '/onboarding' || pathname === '/onboarding.html')) {
    return html(res, 200, await fs.readFile(path.join(root, 'public', 'onboarding.html'), 'utf8'));
  }
  if (req.method === 'GET' && pathname === '/onboarding.css') return asset(res, 'onboarding.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/onboarding.js') return asset(res, 'onboarding.js', 'application/javascript; charset=utf-8');
  if (req.method === 'GET' && pathname === '/client-console.css') return asset(res, 'client-console.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/client-console-layout.css') return asset(res, 'client-console-layout.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/client-console-tour.css') return asset(res, 'client-console-tour.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/client-console-v2.js') return asset(res, 'client-console-v2.js', 'application/javascript; charset=utf-8');
  if (req.method === 'GET' && pathname === '/auth-gate.js') return asset(res, 'auth-gate.js', 'application/javascript; charset=utf-8');
  if (req.method === 'GET' && pathname === '/reservar') {
    return html(res, 200, await fs.readFile(path.join(root, 'public', 'booking.html'), 'utf8'));
  }
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, agent: packageData.agent?.name, version: packageData.package_version, mode: 'preview_and_whatsapp', agenda: Boolean(agendaConfig(packageData)) });
  }
  if (req.method === 'GET' && pathname === '/api/auth/session') {
    const operator = await operatorSessionFromRequest(req).catch(() => null);
    return json(res, 200, { authenticated: Boolean(operator), must_change_pin: Boolean(operator?.must_change_pin), operator: operator ? { id: operator.id, name: operator.name, role: operator.role } : null });
  }
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    let body; try { body = await readJson(req); } catch { return json(res, 400, { error: 'JSON inválido.' }); }
    if (!withinRateLimit(`auth-login:${clientIp(req)}`, 10, 15 * 60 * 1000)) return json(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
    const operator = await findOperatorByPin(body.pin).catch(() => null);
    if (!operator) return json(res, 401, { error: 'PIN incorrecto.' });
    const token = signSession(operator.id);
    return jsonWithCookie(res, 200, { ok: true, must_change_pin: Boolean(operator.must_change_pin), operator: { id: operator.id, name: operator.name, role: operator.role } }, sessionSetCookieHeader(token));
  }
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    return jsonWithCookie(res, 200, { ok: true }, sessionSetCookieHeader(null, { clear: true }));
  }
  if (req.method === 'POST' && pathname === '/api/auth/change-pin') {
    const operator = await operatorSessionFromRequest(req).catch(() => null);
    if (!operator) return json(res, 401, { error: 'Sesión no válida.' });
    let body; try { body = await readJson(req); } catch { return json(res, 400, { error: 'JSON inválido.' }); }
    const newPin = String(body.new_pin || '').trim();
    if (!/^\d{4,8}$/.test(newPin)) return json(res, 400, { error: 'El PIN debe tener entre 4 y 8 dígitos.' });
    if (!operator.must_change_pin && !verifyPinHash(String(body.current_pin || '').trim(), operator.pin_hash)) {
      return json(res, 401, { error: 'El PIN actual no coincide.' });
    }
    await setOperatorPin(operator.id, newPin, { mustChangePin: false });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && pathname === '/api/agenda/dashboard') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    const dashboard = await getAgendaDashboard(packageData);
    if (!dashboard) return json(res, 404, { error: 'Agenda v1 no está habilitada.' });
    const aiAccount = await getPublicAiAccount().catch(error => ({ selection: { mode: 'not_configured' }, platform: { connected: false, error: error.message } }));
    const aiPlan = aiDashboardView(aiAccount);
    return json(res, 200, { ...dashboard, ai_plan: aiPlan, capabilities: { ...(dashboard.capabilities || {}), ai: aiPlan.capabilities } });
  }
  if (req.method === 'GET' && pathname === '/api/client/inbox') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, await getConversationInbox()); }
    catch (error) { return json(res, 502, { error: `No se pudo leer la bandeja: ${error.message}` }); }
  }
  if (req.method === 'GET' && pathname === '/api/client/agent-control') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, await getAgentControl()); }
    catch (error) { return json(res, 502, { error: `No se pudo leer el control del agente: ${error.message}` }); }
  }
  if (req.method === 'PUT' && pathname === '/api/client/agent-control') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 200, await updateAgentControl(body));
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/client/notification-settings') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, await getNotificationSettings()); }
    catch (error) { return json(res, 502, { error: `No se pudo leer las notificaciones: ${error.message}` }); }
  }
  if (req.method === 'PATCH' && pathname === '/api/client/notification-settings') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 200, await updateNotificationSettings(body));
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/client/ai-account') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, await getPublicAiAccount()); }
    catch (error) { return json(res, 502, { error: `No se pudo leer la cuenta de IA: ${error.message}` }); }
  }
  if (req.method === 'PUT' && pathname === '/api/client/ai-account') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 200, await updateAiSelection(body));
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/client/google-calendar') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, await getGoogleCalendarStatus()); }
    catch (error) { return json(res, 502, { error: `No se pudo leer el estado de Google Calendar: ${error.message}` }); }
  }
  if (req.method === 'POST' && pathname === '/api/client/google-calendar/disconnect') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { await disconnectGoogleCalendar(); return json(res, 200, { ok: true }); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  // Estas dos rutas viven en /auth (no /api/client) porque Google redirige al navegador ahí
  // directo — no son llamadas fetch() del frontend, son navegación de página completa. Al
  // terminar (bien o mal) redirigen de vuelta a return_to (la consola que lo inició, PC o
  // móvil) con un query param que esa consola lee para mostrar el resultado.
  if (req.method === 'GET' && pathname === '/auth/google') {
    const operator = await operatorSessionFromRequest(req).catch(() => null);
    if (!operator) return json(res, 401, { error: 'Sesión no válida. Inicia sesión en el dashboard antes de conectar Google Calendar.' });
    try {
      const state = signGoogleOAuthState(operator.id, requestUrl.searchParams.get('return_to'));
      res.writeHead(302, { location: buildGoogleAuthUrl(req, state) });
      return res.end();
    } catch (error) { return json(res, 500, { error: error.message }); }
  }
  if (req.method === 'GET' && pathname === '/auth/google/callback') {
    const params = requestUrl.searchParams;
    const returnPath = verifyGoogleOAuthState(params.get('state'));
    const redirectWith = (query) => { res.writeHead(302, { location: `${returnPath || '/agenda'}?${query}` }); res.end(); };
    if (params.get('error')) return redirectWith('google_calendar=error&google_calendar_message=' + encodeURIComponent('Google canceló la conexión o no diste permiso.'));
    const operator = await operatorSessionFromRequest(req).catch(() => null);
    if (!operator || !returnPath) {
      return redirectWith('google_calendar=error&google_calendar_message=' + encodeURIComponent('El enlace de conexión expiró o no es válido. Vuelve a intentarlo.'));
    }
    try {
      const { accountEmail } = await completeGoogleCalendarConnection(req, { code: params.get('code'), operatorId: operator.id });
      return redirectWith('google_calendar=connected&google_account=' + encodeURIComponent(accountEmail));
    } catch (error) {
      return redirectWith('google_calendar=error&google_calendar_message=' + encodeURIComponent(error.message));
    }
  }
  if (req.method === 'PATCH' && pathname.startsWith('/api/client/conversations/')) {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      const conversationId = pathname.split('/').pop();
      return json(res, 200, { conversation: await updateConversationOperation(conversationId, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && /^\/api\/client\/conversations\/[^/]+\/messages$/.test(pathname)) {
    let messageId = null;
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      if (!agendaUsesSupabase()) return json(res, 409, { error: 'El envío humano requiere Supabase y Zavu configurados.' });
      const parts = pathname.split('/');
      const conversationId = parts[4];
      const text = String(body.text || '').trim().slice(0, 4000);
      const requestId = String(body.requestId || randomUUID()).trim().slice(0, 120);
      const operationKey = `human:out:${requestId}`;
      if (!text) return json(res, 400, { error: 'Escribe un mensaje antes de enviarlo.' });
      // Compatibilidad: builds anteriores guardaban requestId sin namespace.
      const legacy = await findConversationMessageByClientId(requestId);
      let existing = await findConversationMessageByClientId(operationKey) || legacy;
      if (existing && existing.content !== text) return json(res, 409, { error: 'requestId ya fue usado para otro mensaje.' });
      if (existing && ['queued', 'sent', 'delivered', 'read'].includes(existing.delivery_status)) {
        return json(res, 200, { ok: true, duplicate: true, message: existing });
      }
      const conversations = await agendaSupabaseRequest(`/rest/v1/za_conversations?id=eq.${encodeURIComponent(conversationId)}&select=id,external_id,status&limit=1`);
      const conversation = conversations?.[0];
      if (!conversation) return json(res, 404, { error: 'Conversación no encontrada.' });
      await updateConversationOperation(conversationId, { status: 'handoff', needs_human: true, handoff_reason: body.handoffReason || 'Atendida desde la aplicación del negocio' });
      if (!existing) {
        existing = await appendConversationMessage(conversationId, 'outbound', text, {
          operator_name: String(body.operatorName || 'Equipo').slice(0, 120)
        }, { senderType: 'human', deliveryStatus: 'sending', clientMessageId: operationKey });
      }
      messageId = existing?.id || null;
      const delivery = zavuProviderMessage(await sendZavuWhatsApp(conversation.external_id, text, { idempotencyKey: operationKey }));
      const sent = await updateConversationMessageDelivery({
        id: messageId, providerMessageId: delivery.id,
        status: ['queued', 'sent', 'delivered', 'read'].includes(delivery.status) ? delivery.status : 'sent', failureReason: ''
      });
      return json(res, existing?.delivery_status === 'failed' ? 200 : 201, { ok: true, retried: existing?.delivery_status === 'failed', message: sent || existing });
    } catch (error) {
      if (messageId) {
        try { await updateConversationMessageDelivery({ id: messageId, status: 'failed', failureReason: error.message }); } catch { /* conservar error original */ }
      }
      return json(res, 502, { error: `No se pudo enviar el mensaje: ${error.message}`, messageId });
    }
  }
  if (req.method === 'POST' && pathname === '/api/client/operators') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 201, { operator: await createOperator(body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/client/feedback') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      if (!['up', 'down'].includes(body.rating)) return json(res, 400, { error: 'Feedback inválido.' });
      if (body.rating === 'down' && !String(body.expectedAnswer || '').trim()) return json(res, 400, { error: 'Explica cómo debió responder antes de enviar la corrección.' });
      const feedback = await recordFeedback({
        agent_id: packageData.business?.id,
        package_version: packageData.package_version,
        channel: body.channel || 'client_console',
        rating: body.rating,
        question: String(body.question || ''),
        reply: String(body.reply || ''),
        expected_answer: String(body.expectedAnswer || ''),
        conversation_id: body.conversationId || null,
        message_id: body.messageId || null
      });
      return json(res, 201, { ok: true, feedbackId: feedback.id });
    } catch (error) { return json(res, 502, { error: `No se pudo registrar el feedback: ${error.message}` }); }
  }
  if (pathname.startsWith('/api/onboarding/')) {
    const parts = pathname.split('/');
    const token = parts[3] || '';
    const action = parts[4] || '';
    if (!onboardingAuthorized(token)) return json(res, 401, { error: 'El enlace no existe o venció.' });
    if (!agendaUsesSupabase()) return json(res, 409, { error: 'La entrevista requiere el Supabase del cliente configurado.' });
    const businessId = packageData.business?.id || 'business';
    try {
      let sessions = await agendaSupabaseRequest(`/rest/v1/za_onboarding_sessions?business_id=eq.${encodeURIComponent(businessId)}&select=*&limit=1`);
      let session = sessions?.[0];
      if (!session) {
        const created = await agendaSupabaseRequest('/rest/v1/za_onboarding_sessions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ business_id: businessId, status: 'sent' }) });
        session = created?.[0];
      }
      if (!session || session.status === 'revoked' || new Date(session.expires_at) < new Date()) return json(res, 410, { error: 'El enlace venció. Solicita uno nuevo.' });
      if (req.method === 'GET' && !action) {
        const [responses, files] = await Promise.all([
          agendaSupabaseRequest(`/rest/v1/za_onboarding_responses?session_id=eq.${encodeURIComponent(session.id)}&select=step_key,data`),
          agendaSupabaseRequest(`/rest/v1/za_onboarding_files?session_id=eq.${encodeURIComponent(session.id)}&select=id,original_name,mime_type,size_bytes,created_at&order=created_at.desc`)
        ]);
        if (session.status === 'sent') {
          const updated = await agendaSupabaseRequest(`/rest/v1/za_onboarding_sessions?id=eq.${encodeURIComponent(session.id)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'opened', updated_at: new Date().toISOString() }) });
          session = updated?.[0] || session;
        }
        return json(res, 200, { id: session.id, status: session.status, currentStep: session.current_step, expiresAt: session.expires_at, updatedAt: session.updated_at, submittedAt: session.submitted_at, approvedAt: session.approved_at, business: { id: businessId, name: packageData.business?.display_name, niche: packageData.business?.niche, description: packageData.business?.description || '' }, responses: Object.fromEntries((responses||[]).map(item=>[item.step_key,item.data||{}])), files: (files||[]).map(item=>({ id:item.id,name:item.original_name,type:item.mime_type,size:item.size_bytes,createdAt:item.created_at })) });
      }
      if (req.method === 'PUT' && action === 'response') {
        const body = await readJson(req); const stepKey = String(body.stepKey||'').trim().slice(0,80); const step = Math.max(0,Math.min(12,Number(body.step)||0));
        if (!stepKey || !body.data || typeof body.data !== 'object') return json(res, 400, { error: 'Respuesta inválida.' });
        const now = new Date().toISOString();
        await agendaSupabaseRequest('/rest/v1/za_onboarding_responses?on_conflict=session_id,step_key', { method:'POST', headers:{Prefer:'resolution=merge-duplicates,return=minimal'}, body:JSON.stringify({session_id:session.id,step_key:stepKey,data:body.data,updated_at:now}) });
        await agendaSupabaseRequest(`/rest/v1/za_onboarding_sessions?id=eq.${encodeURIComponent(session.id)}`, { method:'PATCH', body:JSON.stringify({status:'partial',current_step:step,updated_at:now}) });
        return json(res,200,{ok:true,savedAt:now,currentStep:step});
      }
      if (req.method === 'POST' && action === 'files') {
        const bytes = await readBuffer(req); if (!bytes.length) return json(res,400,{error:'El archivo está vacío.'});
        const originalName = path.basename(decodeURIComponent(String(req.headers['x-file-name']||'documento'))).slice(0,180); const id=randomUUID(); const storagePath=`${businessId}/${session.id}/${id}-${originalName.replace(/[^a-z0-9._-]+/gi,'-')}`;
        await agendaSupabaseUpload(storagePath,bytes,String(req.headers['content-type']||'application/octet-stream'));
        const inserted=await agendaSupabaseRequest('/rest/v1/za_onboarding_files',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({id,session_id:session.id,original_name:originalName,storage_path:storagePath,mime_type:String(req.headers['content-type']||'application/octet-stream'),size_bytes:bytes.length})});
        return json(res,201,{id,name:originalName,size:bytes.length,createdAt:inserted?.[0]?.created_at});
      }
      if (req.method === 'POST' && action === 'submit') {
        const responses=await agendaSupabaseRequest(`/rest/v1/za_onboarding_responses?session_id=eq.${encodeURIComponent(session.id)}&select=step_key`);
        if((responses||[]).length<6)return json(res,422,{error:'Completa las secciones principales antes de enviar.'});
        const now=new Date().toISOString();await agendaSupabaseRequest(`/rest/v1/za_onboarding_sessions?id=eq.${encodeURIComponent(session.id)}`,{method:'PATCH',body:JSON.stringify({status:'submitted',current_step:12,submitted_at:now,updated_at:now})});
        return json(res,200,{ok:true,submittedAt:now});
      }
      return json(res,404,{error:'Acción de onboarding no encontrada.'});
    } catch(error){return json(res,502,{error:`No se pudo procesar la entrevista: ${error.message}`});}
  }
  if (req.method === 'GET' && pathname === '/api/agenda/public-catalog') {
    const dashboard = await getAgendaDashboard(packageData);
    if (!dashboard) return json(res, 404, { error: 'Agenda v1 no está habilitada.' });
    return json(res, 200, { business_name: dashboard.business_name, catalog: dashboard.catalog, timezone: dashboard.config.timezone, confirmation_mode: dashboard.config.confirmation_mode, slots_endpoint: '/api/agenda/public-slots' });
  }
  if (req.method === 'GET' && pathname === '/api/agenda/public-slots') {
    try {
      if (!withinRateLimit(`public-slots:${clientIp(req)}`, 120, 60 * 60 * 1000)) return json(res, 429, { error: 'Demasiadas consultas. Intenta nuevamente más tarde.' });
      const date = String(requestUrl.searchParams.get('date') || '').slice(0, 10);
      const service = String(requestUrl.searchParams.get('service') || '').slice(0, 180);
      const resource = String(requestUrl.searchParams.get('resource') || '').slice(0, 180);
      const availableSlots = await getAvailableSlots(packageData, { date, service, resource });
      return json(res, 200, { date, service, resource, available_slots: availableSlots.map(starts_at => ({ starts_at })) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/agenda/appointments') {
    try {
      const body = await readJson(req);
      if (body.source === 'public_booking' && !withinRateLimit(`public-booking:${clientIp(req)}`, 12, 60 * 60 * 1000)) return json(res, 429, { error: 'Demasiadas solicitudes. Intenta nuevamente más tarde.' });
      if (body.source !== 'public_booking' && !(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      const source = body.source === 'public_booking' ? 'public_booking' : 'client_console';
      // La reserva pública sólo puede escribir datos operativos de su propia solicitud. Campos de
      // ficha clínica/CRM se aceptan desde canales verificados o desde la consola, nunca desde un
      // JSON anónimo que podría intentar sobrescribir el perfil de un teléfono conocido.
      const appointmentInput = source === 'public_booking' ? {
        customer_name: body.customer_name,
        customer_phone: body.customer_phone,
        customer_email: body.customer_email,
        customer_address: body.customer_address,
        service: body.service,
        resource: body.resource,
        location: body.location,
        starts_at: body.starts_at,
        notes: body.notes
      } : body;
      const appointment = await createAgendaAppointment(packageData, appointmentInput, source);
      if (appointment.risk_window) {
        await createHandoffTicket(packageData, {
          channel: source, conversationId: appointment.reference || appointment.id || '',
          customerMessage: `Reserva ${appointment.reference || ''} de ${appointment.customer_name || 'un cliente'} el ${appointment.starts_at} cae en una franja de riesgo.`,
          agentReply: '', reason: `[Franja de riesgo] ${appointment.risk_window.reason || 'Posible compromiso del profesional en otro lugar a esta hora.'} Confirma disponibilidad real antes de aceptar.`
        });
      }
      return json(res, 201, { appointment });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/agenda/availability-rules') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 201, { rule: await createAgendaAvailabilityRule(packageData, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'PATCH' && pathname.startsWith('/api/agenda/feedback/')) {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 200, { feedback: await updateAgendaFeedback(packageData, pathname.split('/').pop(), body.status) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/agenda/availability-rules/')) {
    try {
      if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      await deleteAgendaAvailabilityRule(packageData, pathname.split('/').pop());
      return json(res, 204, {});
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/agenda/availability-blocks') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 201, { block: await createAgendaAvailabilityBlock(packageData, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/agenda/availability-blocks/')) {
    try {
      if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      await deleteAgendaAvailabilityBlock(packageData, pathname.split('/').pop());
      return json(res, 204, {});
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/agenda/customers/import') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      const contacts = parseContactsFile(body.format, body.content);
      return json(res, 200, { result: await importAgendaCustomers(packageData, contacts) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/agenda/outbox/dispatch') {
    const token = process.env.OUTBOX_DISPATCH_TOKEN;
    if (!token || req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'Despacho outbox no autorizado.' });
    try { return json(res, 200, await dispatchAgendaOutbox(packageData)); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === 'PATCH' && pathname.startsWith('/api/agenda/appointments/')) {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      const id = pathname.split('/').pop();
      const appointment = typeof body.notes === 'string'
        ? await updateAppointmentNotes(packageData, id, body.notes)
        : body.new_starts_at
          ? await rescheduleAgendaAppointment(packageData, { id, new_starts_at: body.new_starts_at })
          : await updateAgendaAppointment(packageData, id, body.status);
      return json(res, 200, { appointment });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/client/customers') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, { customers: await listCustomers(packageData) }); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/client/customers') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 201, { customer: await createManualCustomer(packageData, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'PATCH' && pathname === '/api/client/customers') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 200, await bulkUpdateCustomers(packageData, body.ids, body));
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  const customerRecordMatch = pathname.match(/^\/api\/client\/customers\/([^/]+)\/record$/);
  if (req.method === 'GET' && customerRecordMatch) {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, await listCustomerRecord(decodeURIComponent(customerRecordMatch[1]))); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === 'POST' && customerRecordMatch) {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      const entry = await appendCustomerRecordEntry(decodeURIComponent(customerRecordMatch[1]), {
        ...body,
        source: 'client_console',
        createdBy: 'operator',
        operationKey: body.operationKey || body.operation_key || `console:${randomUUID()}`
      });
      return json(res, 201, { entry });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'GET' && pathname.startsWith('/api/client/customers/')) {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, await getCustomerDetail(packageData, decodeURIComponent(pathname.split('/').pop()))); }
    catch (error) { return json(res, 404, { error: error.message }); }
  }
  if (req.method === 'PATCH' && pathname.startsWith('/api/client/customers/')) {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      const id = decodeURIComponent(pathname.split('/').pop());
      return json(res, 200, { customer: await updateCustomerSettings(packageData, id, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/client/knowledge') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, { facts: currentConfirmedFacts(packageData), suggestions: await listKnowledgeSuggestions(packageData) }); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/client/knowledge/suggestions') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 201, { suggestion: await addKnowledgeSuggestion(packageData, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  // Datos (ficha estructurada: precio, dirección, teléfono) e Info (texto suelto) que el
  // dueño carga directo desde su consola. A diferencia de knowledge/suggestions, esto no
  // pasa por Studio: engine.js ya lo usa en la próxima respuesta, sin rebuild.
  if (req.method === 'GET' && pathname === '/api/client/business-data') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, { items: await listBusinessData(packageData) }); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/client/business-data') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 201, { item: await addBusinessData(packageData, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/client/business-info') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, { items: await listBusinessInfo(packageData) }); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/client/business-info') {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 201, { item: await addBusinessInfo(packageData, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/client/handoffs') {
    if (!(await dashboardAuthorized(req))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, { tickets: await listHandoffTickets(packageData) }); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === 'PATCH' && pathname.startsWith('/api/client/handoffs/')) {
    try {
      const body = await readJson(req);
      if (!(await dashboardAuthorized(req, body))) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      const id = pathname.split('/').pop();
      return json(res, 200, { ticket: await updateHandoffTicket(packageData, id, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/preview/chat') {
    try {
      const body = await readJson(req);
      if (!previewAuthorized(req, body)) return json(res, 401, { error: 'Acceso de preview no autorizado.' });
      if (!body.message?.trim()) return json(res, 400, { error: 'Escribe un mensaje para probar el agente.' });
      const agentControl = await getAgentControl();
      if (agentControl.control.mode === 'paused') return json(res, 409, { error: 'El agente está pausado por el dueño.' });
      const history = Array.isArray(body.history) ? body.history.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string') : [];
      const reply = await answerWithConfiguredAi(body.message, { conversationId: body.conversationId || 'web-preview', history });
      await recordUsage({ provider: reply.provider, model: reply.model || 'deterministic', inputTokens: reply.usage?.inputTokens || 0, outputTokens: reply.usage?.outputTokens || 0, source: 'web_preview' });
      if (reply.handoff) {
        await createHandoffTicket(packageData, { channel: 'preview', conversationId: body.conversationId || '', customerMessage: body.message, agentReply: reply.text, reason: 'Derivación automática del agente' });
      }
      return json(res, 200, { reply, mode: 'preview' });
    } catch { return json(res, 400, { error: 'Solicitud inválida.' }); }
  }
  if (req.method === 'POST' && pathname === '/api/preview/feedback') {
    try {
      const body = await readJson(req);
      if (!previewAuthorized(req, body)) return json(res, 401, { error: 'Acceso de preview no autorizado.' });
      if (!['up', 'down'].includes(body.rating)) return json(res, 400, { error: 'Feedback inválido.' });
      const feedback = await recordFeedback({
        agent_id: packageData.business?.id, package_version: packageData.package_version,
        channel: 'web_preview', rating: body.rating, question: String(body.question || ''),
        reply: String(body.reply || ''), expected_answer: String(body.expectedAnswer || '')
      });
      return json(res, 201, { ok: true, feedbackId: feedback.id });
    } catch (error) { return json(res, 502, { error: `No se pudo registrar el feedback: ${error.message}` }); }
  }
  if (req.method === 'POST' && pathname === '/webhooks/whatsapp') {
    if (runtimeMode !== 'preview_local' || channelProvider !== 'generic_webhook') return json(res, 404, { error: 'Ruta no disponible.' });
    const genericSecret = process.env.GENERIC_WEBHOOK_SECRET || '';
    const providedSecret = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!secretMatches(providedSecret, genericSecret)) return json(res, 401, { error: 'Webhook genérico no autorizado.' });
    try {
      const event = await readJson(req);
      const message = event.message || event.text || event.body?.message;
      if (!message) return json(res, 400, { error: 'Se requiere message en el webhook normalizado.' });
      const callerPhone = normalizeChilePhone(event.from || event.senderPhone || event.phone || event.contact?.phone || '');
      const agentControl = await getAgentControl();
      if (agentControl.control.mode === 'paused') return json(res, 200, { paused: true, reply: null });
      const reply = await answerWithConfiguredAi(message, { callerPhone, conversationId: event.conversationId || event.id || '' });
      await recordUsage({ provider: reply.provider, model: reply.model || 'deterministic', inputTokens: reply.usage?.inputTokens || 0, outputTokens: reply.usage?.outputTokens || 0, source: 'whatsapp', conversationRef: event.conversationId || '' });
      let sentinel = { sent: false, reason: 'not_needed' };
      if (reply.handoff) {
        await createHandoffTicket(packageData, { channel: 'whatsapp', conversationId: event.conversationId || event.id || '', customerMessage: message, agentReply: reply.text, reason: 'Derivación automática del agente' });
        try {
          sentinel = await notifySentinel({
            type: 'information_unknown', agentId: packageData.business?.id,
            agentName: packageData.agent?.name, message, subject: reply.source
          });
        } catch (error) {
          console.error('Centinela no pudo enviar alerta:', error.message);
          sentinel = { sent: false, reason: 'delivery_failed' };
        }
      }
      return json(res, 200, { reply, sentinel });
    } catch {
      return json(res, 400, { error: 'JSON inválido.' });
    }
  }
  if (req.method === 'POST' && pathname === '/webhooks/zavu') {
    let rawBody;
    try { rawBody = await readRaw(req); }
    catch { return json(res, 413, { error: 'Cuerpo de la solicitud demasiado grande.' }); }
    const secret = process.env.ZAVUDEV_WEBHOOK_SECRET;
    if (!secret) return json(res, 503, { error: 'Webhook Zavu no configurado.' });
    if (!verifyZavuSignature(rawBody, req.headers['x-zavu-signature'], secret)) return json(res, 401, { error: 'Firma Zavu inválida.' });
    let event;
    let eventId = '';
    let claim = null;
    try {
      event = JSON.parse(rawBody);
      eventId = zavuEventId(event, rawBody);
      claim = await claimZavuEvent(eventId, event.type);
      if (!claim?.acquired) return json(res, 200, { ok: true, duplicate: true, status: claim?.status || 'processing' });

      // Los callbacks de delivery actualizan el mensaje que ya existe; también son
      // eventos durables, por lo que reentregarlos no vuelve a mutar nada relevante.
      const deliveryUpdate = zavuDeliveryUpdate(event);
      if (deliveryUpdate) {
        const messageRow = deliveryUpdate.providerMessageId
          ? await updateConversationMessageDelivery(deliveryUpdate)
          : null;
        await completeZavuEvent(eventId, claim.lease_token, 'completed', {
          delivery_status: deliveryUpdate.status,
          provider_message_id: deliveryUpdate.providerMessageId,
          conversation_message_id: messageRow?.id || null
        });
        return json(res, 200, { ok: true, delivery: deliveryUpdate.status, matched: Boolean(messageRow) });
      }

      if (event.type !== 'message.inbound' || event.data?.channel !== 'whatsapp') {
        await completeZavuEvent(eventId, claim.lease_token, 'ignored', { ignored: 'event_type' });
        return json(res, 200, { ok: true, ignored: 'event_type' });
      }
      const callerPhone = normalizeChilePhone(event.data?.from || '');
      const message = event.data?.text || '';
      if (!callerPhone || !message) {
        await completeZavuEvent(eventId, claim.lease_token, 'ignored', { ignored: 'no_text_or_sender' });
        return json(res, 200, { ok: true, ignored: 'no_text_or_sender' });
      }
      if (!withinRateLimit(`zavu:${callerPhone.replace(/\D/g, '')}`, 40, 60 * 60 * 1000)) {
        await completeZavuEvent(eventId, claim.lease_token, 'ignored', { ignored: 'rate_limited' });
        return json(res, 200, { ok: true, ignored: 'rate_limited' });
      }
      const conversation = await getOrCreateConversation('whatsapp', callerPhone);
      const inboundKey = `zavu:in:${String(event.data?.messageId || eventId)}`.slice(0, 240);
      const inbound = await appendConversationMessage(conversation?.id, 'inbound', message, {}, {
        senderType: 'human', deliveryStatus: 'delivered', clientMessageId: inboundKey,
        providerMessageId: event.data?.messageId || null
      });
      const agentControl = await getAgentControl();
      if (agentControl.control.mode === 'paused') {
        await completeZavuEvent(eventId, claim.lease_token, 'ignored', { paused: true });
        return json(res, 200, { ok: true, paused: true });
      }
      if (conversation?.status === 'handoff') {
        await completeZavuEvent(eventId, claim.lease_token, 'ignored', { handoff: true, suppressed: true });
        return json(res, 200, { ok: true, handoff: true, suppressed: true });
      }
      if (conversation?.za_customers?.bot_muted) {
        await completeZavuEvent(eventId, claim.lease_token, 'ignored', { muted: true });
        return json(res, 200, { ok: true, muted: true });
      }
      const operationKey = `zavu:${eventId}`.slice(0, 240);
      let reply = claim.reply?.agent_reply;
      const generatedNow = !reply?.text;
      if (generatedNow) {
        const history = await loadConversationHistory(conversation?.id, 20, { excludeClientMessageId: inboundKey });
        reply = await answerWithConfiguredAi(message, {
          callerPhone, conversationId: conversation?.id || event.data?.messageId || eventId,
          history, messageId: operationKey, operationKey
        });
        if (!(await checkpointZavuEvent(eventId, claim.lease_token, { agent_reply: reply }))) {
          throw new Error('Se perdió el lease Zavu antes de guardar la respuesta.');
        }
        await recordUsage({
          provider: reply.provider, model: reply.model || 'deterministic', inputTokens: reply.usage?.inputTokens || 0,
          outputTokens: reply.usage?.outputTokens || 0, source: 'zavu_whatsapp', conversationRef: eventId
        }).catch(error => console.error('No se pudo registrar uso Zavu:', error.message));
      }
      // Si el cliente no existía cuando se creó/buscó la conversación (primer mensaje de alguien
      // nuevo) y este mismo turno acaba de crearlo (ej. reservó altiro), el vínculo quedaría nulo
      // hasta el próximo mensaje entrante — que puede no llegar nunca. Reintentar acá, en el mismo
      // turno, en vez de depender de un mensaje futuro que el cliente quizás no mande.
      if (conversation && !conversation.customer_id) await getOrCreateConversation('whatsapp', callerPhone);

      const outboundKey = `zavu:out:${eventId}`.slice(0, 240);
      let outbound = await findConversationMessageByClientId(outboundKey);
      if (outbound && outbound.content !== reply.text) throw new Error('La operación Zavu ya tiene otra respuesta persistida.');
      if (!outbound) {
        outbound = await appendConversationMessage(conversation?.id, 'outbound', reply.text, { tools: reply.toolTrace || [] }, {
          senderType: 'agent', deliveryStatus: 'sending', clientMessageId: outboundKey
        });
      }
      if (!['queued', 'sent', 'delivered', 'read'].includes(outbound?.delivery_status)) {
        const provider = zavuProviderMessage(await sendZavuWhatsApp(callerPhone, reply.text, { idempotencyKey: outboundKey }));
        outbound = await updateConversationMessageDelivery({
          id: outbound?.id, providerMessageId: provider.id,
          status: ['queued', 'sent', 'delivered', 'read'].includes(provider.status) ? provider.status : 'sent', failureReason: ''
        }) || outbound;
      }
      if (reply.handoff) {
        await createHandoffTicket(packageData, {
          channel: 'whatsapp', conversationId: callerPhone, customerMessage: message, agentReply: reply.text,
          reason: 'Derivación automática del agente', operationKey: `${operationKey}:handoff-ticket`
        });
      }
      // Si hubo handoff/corrección, intenta despachar la alerta inmediatamente.
      // El worker externo sigue siendo el respaldo para reintentos posteriores.
      if (reply.handoff) await dispatchAgendaOutbox(packageData);
      if (!(await completeZavuEvent(eventId, claim.lease_token, 'completed', {
        inbound_message_id: inbound?.id || null,
        outbound_message_id: outbound?.id || null,
        provider_message_id: outbound?.provider_message_id || null
      }))) throw new Error('Se perdió el lease Zavu antes de completar el evento.');
      return json(res, 200, { ok: true });
    } catch (error) {
      // Fallar conserva la fila y el reply/checkpoint. El siguiente delivery puede
      // reclamarla de nuevo; el envío repite exactamente la misma idempotencyKey.
      if (eventId && claim?.acquired) {
        await completeZavuEvent(eventId, claim.lease_token, 'failed', {}, error.message).catch(() => {});
      }
      console.error('Error webhook Zavu:', error.message);
      return json(res, 503, { ok: false, retryable: true });
    }
  }
  return json(res, 404, { error: 'Ruta no encontrada.' });
}

if (!initError) {
  try { validateRuntimeConfiguration(); }
  catch (error) { initError = `validateRuntimeConfiguration failed: ${error.stack || error.message}`; }
}

// Este archivo se despliega en Vercel como api/index.js → handleRequest, una función
// serverless (ver vercel.json). NUNCA arrancar acá un servidor HTTP propio (createServer
// + el método de escucha de Node) — ni siquiera nombrarlo literal en un comentario: Vercel
// detecta ese patrón en el código fuente por análisis de texto (no de ejecución) y trata
// el archivo completo como "el servidor detectado", ignorando vercel.json/api/index.js.
// Eso rompió el primer deploy de este runtime con FUNCTION_INVOCATION_FAILED en todas las
// rutas — y una segunda vez cuando este mismo comentario, al citar el patrón prohibido de
// forma literal para explicarlo, volvió a activar la misma detección (31-07-2026). Para
// correr esto localmente/Docker sin Vercel, usar un wrapper aparte que importe
// { handleRequest } y abra el servidor ahí, nunca en este archivo.
console.log(`ZeroAgent Runtime (${runtimeMode}) listo — el puerto ${port} sólo aplica si un wrapper externo abre el servidor.`);
