import { resolveConversationPolicy } from './conversation-policy.js';
import { labelThread } from './thread.js';

/**
 * Auditor de respaldo del borrador final. Reemplaza las listas de frases prohibidas por un juicio
 * general: ¿cada afirmación del borrador sobre el mundo (dónde está o qué hizo el dueño, una hora
 * tomada, un pago, un precio, un dato del negocio) tiene respaldo en lo que las herramientas
 * devolvieron en este turno o en el conocimiento confirmado? Lo que el dueño o el asistente dijeron
 * en turnos anteriores fue verdad en su momento y no respalda nada hoy. Detecta además cuando el
 * borrador promete avisar o pasar el mensaje al dueño, para que el runtime cumpla el aviso.
 * Si falla (red, JSON inválido) no bloquea nada.
 * Caso real (franciskom, 03-11-2026): "Francisco ya va en camino" copiado de un mensaje de hace 5 días.
 */

const AUDIT_SYSTEM = resolveConversationPolicy().audit_system;

const clip = (text, max = 400) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function formatAuditInput({ history = [], message = '', draft = '', facts = [], toolTrace = [], booked = [], policy }) {
  const lines = labelThread(history, { ownerLabel: policy?.owner_label || 'DUEÑO' }).slice(-10).map(item => `${item.who}: ${clip(item.text, 300)}`);
  lines.push(`CLIENTE (mensaje al que se responde ahora): ${clip(message, 400)}`);
  const factLines = facts.slice(0, 40).map(fact => `- ${clip(fact.subject, 80)}: ${clip(fact.value, 220)}`).join('\n') || '(ninguno)';
  const toolLines = (Array.isArray(toolTrace) ? toolTrace : []).map(item => `- ${item.name}: ${clip(JSON.stringify(item.result ?? {}), 3000)}`).join('\n') || '(ninguna herramienta consultada en este turno)';
  const bookedLines = booked.map(item => `- ${clip(item.service || 'sesión', 80)} · ${clip(item.starts_at, 40)}`).join('\n') || '(no tiene citas registradas en el sistema)';
  return `Citas del cliente registradas y verificadas en el sistema (respaldan afirmaciones sobre ellas):\n${bookedLines}\n\nConversación:\n${lines.join('\n')}\n\nDatos confirmados del negocio:\n${factLines}\n\nHerramientas de ESTE turno:\n${toolLines}\n\nBorrador (todavía no enviado):\n${clip(draft, 900)}`;
}

export function parseAuditVerdict(text) {
  const match = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!match) return null;
  try {
    const verdict = JSON.parse(match[0]);
    if (typeof verdict.sin_respaldo !== 'boolean') return null;
    return { unsupported: verdict.sin_respaldo === true, detail: clip(verdict.detalle, 300), promisesNotice: verdict.promete_aviso === true };
  } catch { return null; }
}

export async function auditDraftGrounding(llm, input, { isGpt5Family = false, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model, max_completion_tokens: 160,
        ...(isGpt5Family ? { reasoning_effort: 'none' } : { temperature: 0 }),
        messages: [{ role: 'system', content: input.policy?.audit_system || AUDIT_SYSTEM }, { role: 'user', content: formatAuditInput(input) }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const verdict = parseAuditVerdict(data.choices?.[0]?.message?.content);
    if (!verdict) return null;
    return { ...verdict, usage: { input: Number(data.usage?.prompt_tokens) || 0, output: Number(data.usage?.completion_tokens) || 0 } };
  } catch { return null; }
}
