import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPackage, answerWithGroq } from './engine.js';
import { notifySentinel } from './sentinel.js';
import { recordUsage } from './metrics.js';
import { agendaConfig, agendaSupabaseRequest, agendaSupabaseUpload, agendaUsesSupabase, createAgendaAppointment, createAgendaAvailabilityRule, deleteAgendaAvailabilityRule, getAgendaDashboard, updateAgendaAppointment, updateAgendaFeedback } from './agenda.js';
import { dispatchAgendaOutbox } from './outbox.js';
import { verifyZavuSignature } from './zavu.js';
import { appendConversationMessage, createOperator, getAgentControl, getConversationInbox, getOrCreateConversation, loadConversationHistory, updateAgentControl, updateConversationOperation } from './conversations.js';

const packageData = await loadPackage();
const port = Number(process.env.PORT || 3000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeMode = process.env.RUNTIME_MODE || 'production';
const channelProvider = process.env.CHANNEL_PROVIDER || 'zavu';
const previewKey = process.env.PREVIEW_ACCESS_KEY || '';
const feedbackWebhookUrl = process.env.FEEDBACK_WEBHOOK_URL || '';
const dashboardKey = process.env.DASHBOARD_ACCESS_KEY || '';
const previewWebhookEvents = new Set();
const rateWindows = new Map();

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
  const llmProvider = process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'groq');
  if (!['openai', 'groq', 'compatible'].includes(llmProvider)) {
    throw new Error('LLM_PROVIDER debe ser openai, groq o compatible.');
  }
  const llmKey = process.env.LLM_API_KEY || (llmProvider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GROQ_API_KEY);
  const llmModel = process.env.LLM_MODEL || (llmProvider === 'openai' ? 'gpt-4o-mini' : process.env.GROQ_MODEL || 'llama-3.3-70b-versatile');
  required.push(['LLM_API_KEY (o clave nativa del proveedor)', llmKey], ['LLM_MODEL', llmModel]);
  if (llmProvider === 'compatible') required.push(['LLM_BASE_URL', process.env.LLM_BASE_URL]);
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

async function asset(res, fileName, contentType) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(await fs.readFile(path.join(root, 'public', fileName)));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}');
}

async function readRaw(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
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

async function zavuEventAlreadyProcessed(eventId) {
  if (!eventId) return false;
  if (agendaUsesSupabase()) {
    const rows = await agendaSupabaseRequest(`/rest/v1/za_webhook_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id&limit=1`);
    return Boolean(rows?.length);
  }
  return previewWebhookEvents.has(eventId);
}

async function markZavuEventProcessed(eventId) {
  if (!eventId) return;
  if (agendaUsesSupabase()) {
    await agendaSupabaseRequest('/rest/v1/za_webhook_events?on_conflict=event_id', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ event_id: eventId, source: 'zavu' })
    });
    return;
  }
  previewWebhookEvents.add(eventId);
  if (previewWebhookEvents.size > 500) previewWebhookEvents.clear();
}

async function sendZavuWhatsApp(to, text) {
  if (!process.env.ZAVUDEV_API_KEY || !process.env.ZAVUDEV_SENDER_ID) throw new Error('Zavu no está configurado.');
  const { default: Zavudev } = await import('@zavudev/sdk');
  const zavu = new Zavudev({ apiKey: process.env.ZAVUDEV_API_KEY });
  await zavu.messages.send({ to, channel: 'whatsapp', text, 'Zavu-Sender': process.env.ZAVUDEV_SENDER_ID });
}

function previewAuthorized(req, body = {}) {
  if (runtimeMode === 'preview_local' && !previewKey) return true;
  return secretMatches(req.headers['x-preview-key'] || body.accessKey, previewKey);
}

function dashboardAuthorized(req, body = {}) {
  if (runtimeMode === 'preview_local' && !dashboardKey) return true;
  return secretMatches(req.headers['x-dashboard-key'] || body.dashboardKey, dashboardKey);
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
        correction_text: String(payload.expected_answer || '').slice(0, 4000),
        conversation_id: payload.conversation_id || null,
        message_id: payload.message_id || null
      })
    });
  }
  return event;
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (req.method === 'GET' && pathname === '/') {
    return html(res, 200, await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8'));
  }
  if (req.method === 'GET' && pathname === '/playground') {
    return html(res, 200, await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8'));
  }
  if (req.method === 'GET' && pathname === '/agenda') {
    return html(res, 200, await fs.readFile(path.join(root, 'public', 'agenda.html'), 'utf8'));
  }
  if (req.method === 'GET' && (pathname === '/onboarding' || pathname === '/onboarding.html')) {
    return html(res, 200, await fs.readFile(path.join(root, 'public', 'onboarding.html'), 'utf8'));
  }
  if (req.method === 'GET' && pathname === '/onboarding.css') return asset(res, 'onboarding.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/onboarding.js') return asset(res, 'onboarding.js', 'application/javascript; charset=utf-8');
  if (req.method === 'GET' && pathname === '/client-console.css') return asset(res, 'client-console.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/client-console-layout.css') return asset(res, 'client-console-layout.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/client-console-tour.css') return asset(res, 'client-console-tour.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/client-console-v2.js') return asset(res, 'client-console-v2.js', 'application/javascript; charset=utf-8');
  if (req.method === 'GET' && pathname === '/reservar') {
    return html(res, 200, await fs.readFile(path.join(root, 'public', 'booking.html'), 'utf8'));
  }
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, agent: packageData.agent?.name, version: packageData.package_version, mode: 'preview_and_whatsapp', agenda: Boolean(agendaConfig(packageData)) });
  }
  if (req.method === 'GET' && pathname === '/api/agenda/dashboard') {
    if (!dashboardAuthorized(req)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    const dashboard = await getAgendaDashboard(packageData);
    return dashboard ? json(res, 200, dashboard) : json(res, 404, { error: 'Agenda v1 no está habilitada.' });
  }
  if (req.method === 'GET' && pathname === '/api/client/inbox') {
    if (!dashboardAuthorized(req)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, await getConversationInbox()); }
    catch (error) { return json(res, 502, { error: `No se pudo leer la bandeja: ${error.message}` }); }
  }
  if (req.method === 'GET' && pathname === '/api/client/agent-control') {
    if (!dashboardAuthorized(req)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
    try { return json(res, 200, await getAgentControl()); }
    catch (error) { return json(res, 502, { error: `No se pudo leer el control del agente: ${error.message}` }); }
  }
  if (req.method === 'PUT' && pathname === '/api/client/agent-control') {
    try {
      const body = await readJson(req);
      if (!dashboardAuthorized(req, body)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 200, await updateAgentControl(body));
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'PATCH' && pathname.startsWith('/api/client/conversations/')) {
    try {
      const body = await readJson(req);
      if (!dashboardAuthorized(req, body)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      const conversationId = pathname.split('/').pop();
      return json(res, 200, { conversation: await updateConversationOperation(conversationId, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && /^\/api\/client\/conversations\/[^/]+\/messages$/.test(pathname)) {
    let messageId = null;
    try {
      const body = await readJson(req);
      if (!dashboardAuthorized(req, body)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      if (!agendaUsesSupabase()) return json(res, 409, { error: 'El envío humano requiere Supabase y Zavu configurados.' });
      const parts = pathname.split('/');
      const conversationId = parts[4];
      const text = String(body.text || '').trim().slice(0, 4000);
      const requestId = String(body.requestId || randomUUID()).trim().slice(0, 120);
      if (!text) return json(res, 400, { error: 'Escribe un mensaje antes de enviarlo.' });
      const duplicate = await agendaSupabaseRequest(`/rest/v1/za_conversation_messages?client_message_id=eq.${encodeURIComponent(requestId)}&select=id,content,delivery_status,created_at&limit=1`);
      if (duplicate?.[0]) return json(res, 200, { ok: true, duplicate: true, message: duplicate[0] });
      const conversations = await agendaSupabaseRequest(`/rest/v1/za_conversations?id=eq.${encodeURIComponent(conversationId)}&select=id,external_id,status&limit=1`);
      const conversation = conversations?.[0];
      if (!conversation) return json(res, 404, { error: 'Conversación no encontrada.' });
      await updateConversationOperation(conversationId, { status: 'handoff', needs_human: true, handoff_reason: body.handoffReason || 'Atendida desde la aplicación del negocio' });
      const created = await agendaSupabaseRequest('/rest/v1/za_conversation_messages', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ conversation_id: conversationId, direction: 'outbound', content: text, sender_type: 'human', delivery_status: 'sending', client_message_id: requestId, tool_trace: { operator_name: String(body.operatorName || 'Equipo').slice(0, 120) } }) });
      messageId = created?.[0]?.id || null;
      await sendZavuWhatsApp(conversation.external_id, text);
      const sent = await agendaSupabaseRequest(`/rest/v1/za_conversation_messages?id=eq.${encodeURIComponent(messageId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ delivery_status: 'sent' }) });
      return json(res, 201, { ok: true, message: sent?.[0] || created?.[0] });
    } catch (error) {
      if (messageId) {
        try { await agendaSupabaseRequest(`/rest/v1/za_conversation_messages?id=eq.${encodeURIComponent(messageId)}`, { method: 'PATCH', body: JSON.stringify({ delivery_status: 'failed' }) }); } catch { /* conservar error original */ }
      }
      return json(res, 502, { error: `No se pudo enviar el mensaje: ${error.message}`, messageId });
    }
  }
  if (req.method === 'POST' && pathname === '/api/client/operators') {
    try {
      const body = await readJson(req);
      if (!dashboardAuthorized(req, body)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 201, { operator: await createOperator(body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/client/feedback') {
    try {
      const body = await readJson(req);
      if (!dashboardAuthorized(req, body)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
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
    return json(res, 200, { catalog: dashboard.catalog, timezone: dashboard.config.timezone, confirmation_mode: dashboard.config.confirmation_mode });
  }
  if (req.method === 'POST' && pathname === '/api/agenda/appointments') {
    try {
      const body = await readJson(req);
      if (body.source === 'public_booking' && !withinRateLimit(`public-booking:${req.socket.remoteAddress || 'unknown'}`, 12, 60 * 60 * 1000)) return json(res, 429, { error: 'Demasiadas solicitudes. Intenta nuevamente más tarde.' });
      if (body.source !== 'public_booking' && !dashboardAuthorized(req, body)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      const appointment = await createAgendaAppointment(packageData, body, body.source === 'public_booking' ? 'public_booking' : 'client_console');
      return json(res, 201, { appointment });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/agenda/availability-rules') {
    try {
      const body = await readJson(req);
      if (!dashboardAuthorized(req, body)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 201, { rule: await createAgendaAvailabilityRule(packageData, body) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'PATCH' && pathname.startsWith('/api/agenda/feedback/')) {
    try {
      const body = await readJson(req);
      if (!dashboardAuthorized(req, body)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      return json(res, 200, { feedback: await updateAgendaFeedback(packageData, pathname.split('/').pop(), body.status) });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/agenda/availability-rules/')) {
    try {
      if (!dashboardAuthorized(req)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      await deleteAgendaAvailabilityRule(packageData, pathname.split('/').pop());
      return json(res, 204, {});
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
      if (!dashboardAuthorized(req, body)) return json(res, 401, { error: 'Acceso al dashboard no autorizado.' });
      const id = pathname.split('/').pop();
      const appointment = await updateAgendaAppointment(packageData, id, body.status);
      return json(res, 200, { appointment });
    } catch (error) { return json(res, 422, { error: error.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/preview/chat') {
    try {
      const body = await readJson(req);
      if (!previewAuthorized(req, body)) return json(res, 401, { error: 'Acceso de preview no autorizado.' });
      if (!body.message?.trim()) return json(res, 400, { error: 'Escribe un mensaje para probar el agente.' });
      const agentControl = await getAgentControl();
      if (agentControl.control.mode === 'paused') return json(res, 409, { error: 'El agente está pausado por el dueño.' });
      const reply = await answerWithGroq(packageData, body.message, { conversationId: body.conversationId || 'web-preview' });
      await recordUsage({ provider: reply.provider, model: reply.model || 'deterministic', inputTokens: reply.usage?.inputTokens || 0, outputTokens: reply.usage?.outputTokens || 0, source: 'web_preview' });
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
      const callerPhone = event.from || event.senderPhone || event.phone || event.contact?.phone || '';
      const agentControl = await getAgentControl();
      if (agentControl.control.mode === 'paused') return json(res, 200, { paused: true, reply: null });
      const reply = await answerWithGroq(packageData, message, { callerPhone, conversationId: event.conversationId || event.id || '' });
      await recordUsage({ provider: reply.provider, model: reply.model || 'deterministic', inputTokens: reply.usage?.inputTokens || 0, outputTokens: reply.usage?.outputTokens || 0, source: 'whatsapp', conversationRef: event.conversationId || '' });
      let sentinel = { sent: false, reason: 'not_needed' };
      if (reply.handoff) {
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
    const rawBody = await readRaw(req);
    const secret = process.env.ZAVUDEV_WEBHOOK_SECRET;
    if (!secret) return json(res, 503, { error: 'Webhook Zavu no configurado.' });
    if (!verifyZavuSignature(rawBody, req.headers['x-zavu-signature'], secret)) return json(res, 401, { error: 'Firma Zavu inválida.' });
    try {
      const event = JSON.parse(rawBody);
      if (event.type !== 'message.inbound' || event.data?.channel !== 'whatsapp') return json(res, 200, { ok: true, ignored: 'event_type' });
      const callerPhone = event.data?.from || '';
      const message = event.data?.text || '';
      if (!callerPhone || !message) return json(res, 200, { ok: true, ignored: 'no_text_or_sender' });
      if (await zavuEventAlreadyProcessed(event.id)) return json(res, 200, { ok: true, ignored: 'duplicate' });
      if (!withinRateLimit(`zavu:${callerPhone.replace(/\D/g, '')}`, 40, 60 * 60 * 1000)) return json(res, 200, { ok: true, ignored: 'rate_limited' });
      const conversation = await getOrCreateConversation('whatsapp', callerPhone);
      await appendConversationMessage(conversation?.id, 'inbound', message);
      const agentControl = await getAgentControl();
      if (agentControl.control.mode === 'paused') return json(res, 200, { ok: true, paused: true });
      if (conversation?.status === 'handoff') {
        return json(res, 200, { ok: true, handoff: true, suppressed: true });
      }
      const history = await loadConversationHistory(conversation?.id);
      const reply = await answerWithGroq(packageData, message, { callerPhone, conversationId: conversation?.id || event.data?.messageId || event.id || '', history });
      await sendZavuWhatsApp(callerPhone, reply.text);
      await appendConversationMessage(conversation?.id, 'outbound', reply.text, { tools: reply.toolTrace || [] });
      await recordUsage({ provider: reply.provider, model: reply.model || 'deterministic', inputTokens: reply.usage?.inputTokens || 0, outputTokens: reply.usage?.outputTokens || 0, source: 'zavu_whatsapp', conversationRef: event.id || '' });
      // Si hubo handoff/corrección, intenta despachar la alerta inmediatamente.
      // El worker externo sigue siendo el respaldo para reintentos posteriores.
      if (reply.handoff) await dispatchAgendaOutbox(packageData);
      // Sólo deduplicamos tras haber persistido y enviado la respuesta. Si falla
      // cualquier paso anterior, Zavu recibe un error y puede reintentar el evento.
      await markZavuEventProcessed(event.id);
      return json(res, 200, { ok: true });
    } catch (error) {
      console.error('Error webhook Zavu:', error.message);
      return json(res, 503, { ok: false, retryable: true });
    }
  }
  return json(res, 404, { error: 'Ruta no encontrada.' });
});

validateRuntimeConfiguration();
server.listen(port, () => console.log(`ZeroAgent Runtime ${runtimeMode} escuchando en ${port}`));
