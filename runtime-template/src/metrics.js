import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function recordUsage(event) {
  const payload = { occurredAt: new Date().toISOString(), ...event };
  try {
    const dir = path.join(root, 'storage'); await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'usage.jsonl'), `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (error) { console.warn('No se pudo guardar uso local:', error.message); }
  if (agendaUsesSupabase()) {
    try {
      await agendaSupabaseRequest('/rest/v1/za_ai_usage_events', {
        method: 'POST',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({
          provider: String(payload.provider || 'unknown').slice(0, 80),
          model: String(payload.model || 'unknown').slice(0, 160),
          input_tokens: Math.max(0, Number(payload.inputTokens) || 0),
          output_tokens: Math.max(0, Number(payload.outputTokens) || 0),
          source: String(payload.source || 'runtime').slice(0, 80),
          conversation_ref: payload.conversationRef ? String(payload.conversationRef).slice(0, 240) : null,
          occurred_at: payload.occurredAt
        })
      });
    } catch (error) {
      // La telemetría nunca debe impedir responder. El warning también deja visible si falta
      // aplicar agenda-v1-ai-account.sql en un cliente actualizado.
      console.warn('No se pudo guardar uso IA en Supabase:', error.message);
    }
  }
  if (process.env.METRICS_WEBHOOK_URL) {
    try {
      const headers = { 'content-type': 'application/json' };
      if (process.env.METRICS_TOKEN) headers.authorization = `Bearer ${process.env.METRICS_TOKEN}`;
      await fetch(process.env.METRICS_WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (error) { console.warn('No se pudo sincronizar métricas:', error.message); }
  }
}
