import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function recordUsage(event) {
  const payload = { occurredAt: new Date().toISOString(), ...event };
  try {
    const dir = path.join(root, 'storage'); await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'usage.jsonl'), `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (error) { console.warn('No se pudo guardar uso local:', error.message); }
  if (process.env.METRICS_WEBHOOK_URL) {
    try {
      const headers = { 'content-type': 'application/json' };
      if (process.env.METRICS_TOKEN) headers.authorization = `Bearer ${process.env.METRICS_TOKEN}`;
      await fetch(process.env.METRICS_WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (error) { console.warn('No se pudo sincronizar métricas:', error.message); }
  }
}
