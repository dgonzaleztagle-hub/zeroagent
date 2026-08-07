import { createHmac, timingSafeEqual } from 'node:crypto';

// Formato observado en tráfico real Zavu: HMAC-SHA256(secret, rawBody).
// El timestamp del header es anti-replay; no se concatena al body para el hash.
export function verifyZavuSignature(rawBody, header, secret, nowMs = Date.now()) {
  const parts = String(header || '').split(',').map(part => part.trim());
  const timestamp = Number(parts.find(part => part.startsWith('t='))?.slice(2));
  const signature = parts.find(part => part.startsWith('v1='))?.slice(3);
  if (!timestamp || !signature || Math.abs(nowMs / 1000 - timestamp) > 300) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  try { return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; }
}
