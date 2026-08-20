import crypto from 'node:crypto';
import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';

// Login por PIN para /agenda y /m — reemplaza el hueco donde, sin DASHBOARD_ACCESS_KEY
// configurado, el panel del cliente quedaba abierto a cualquiera con la URL. La sesión es un
// token firmado (HMAC), sin tabla de sesiones: verificable sin ir a la base en cada request.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sessionSecret() {
  // Reusa DASHBOARD_ACCESS_KEY si no hay un secreto dedicado, para no exigir una variable de
  // entorno nueva en clientes que ya la tienen configurada.
  return process.env.SESSION_SECRET || process.env.DASHBOARD_ACCESS_KEY || '';
}

function hmac(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPinHash(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return timingSafeStringEqual(candidate, hash);
}

export function signSession(operatorId) {
  if (!sessionSecret()) throw new Error('SESSION_SECRET/DASHBOARD_ACCESS_KEY no configurado.');
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${operatorId}.${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${hmac(payload)}`;
}

export function verifySessionToken(token) {
  if (!sessionSecret() || !token || typeof token !== 'string') return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  let payload;
  try { payload = Buffer.from(payloadB64, 'base64url').toString(); } catch { return null; }
  if (!timingSafeStringEqual(hmac(payload), sig)) return null;
  const [operatorId, expStr] = payload.split('.');
  const exp = Number(expStr);
  if (!operatorId || !exp || Date.now() > exp) return null;
  return { operatorId };
}

function parseCookies(header = '') {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

export function sessionCookieName() { return 'za_session'; }

export function readSessionFromRequest(req) {
  const cookies = parseCookies(req.headers?.cookie || '');
  return verifySessionToken(cookies[sessionCookieName()]);
}

export function sessionSetCookieHeader(token, { clear = false } = {}) {
  const parts = [`${sessionCookieName()}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (process.env.RUNTIME_MODE !== 'preview_local') parts.push('Secure');
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  return parts.join('; ');
}

async function findOperatorById(id) {
  const rows = await agendaSupabaseRequest(`/rest/v1/za_operators?id=eq.${encodeURIComponent(id)}&active=eq.true&select=id,name,email,role,must_change_pin,pin_hash`);
  return rows?.[0] || null;
}

// El PIN no es único por diseño (4-6 dígitos, universo chico) — no se puede indexar/buscar
// directo, así que se recorren los operadores activos con PIN configurado y se compara cada uno.
export async function findOperatorByPin(pin) {
  const clean = String(pin || '').trim();
  if (!clean) return null;
  const operators = await agendaSupabaseRequest('/rest/v1/za_operators?active=eq.true&pin_hash=not.is.null&select=id,name,email,role,must_change_pin,pin_hash');
  return (operators || []).find(op => verifyPinHash(clean, op.pin_hash)) || null;
}

export async function setOperatorPin(operatorId, pin, { mustChangePin = false } = {}) {
  const pin_hash = hashPin(pin);
  await agendaSupabaseRequest(`/rest/v1/za_operators?id=eq.${encodeURIComponent(operatorId)}`, {
    method: 'PATCH', body: JSON.stringify({ pin_hash, must_change_pin: mustChangePin, pin_updated_at: new Date().toISOString() })
  });
}

export async function operatorSessionFromRequest(req) {
  if (!agendaUsesSupabase()) return null;
  const session = readSessionFromRequest(req);
  if (!session) return null;
  return findOperatorById(session.operatorId);
}
