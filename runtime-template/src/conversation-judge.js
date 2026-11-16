import { resolveConversationPolicy } from './conversation-policy.js';
import { labelThread } from './thread.js';

/**
 * Juez de ritmo de conversación. Reemplaza los contadores ("no horas antes de N preguntas", "una
 * pregunta máx.") por un juicio sobre la conversación completa: ¿ya es buen momento de ofrecer horas
 * o conviene seguir conversando? Un modelo que ve el hilo entero decide mejor que cualquier regla
 * por palabras clave. Si falla (red, JSON inválido) no bloquea nada: se deja pasar el borrador.
 */

const JUDGE_SYSTEM = resolveConversationPolicy().judge_system;

const clip = (text, max = 500) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function formatJudgeInput({ history = [], message = '', draft = '', policy }) {
  const lines = labelThread(history, { ownerLabel: policy?.owner_label || 'DUEÑO' }).slice(-12).map(item => `${item.who}: ${clip(item.text)}`);
  lines.push(`CLIENTE (mensaje al que se responde ahora): ${clip(message)}`);
  return `Conversación:\n${lines.join('\n')}\n\nBorrador del asistente (todavía no enviado):\n${clip(draft, 700)}`;
}

export function parseJudgeVerdict(text) {
  const match = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!match) return null;
  try {
    const verdict = JSON.parse(match[0]);
    const stage = String(verdict.etapa || '').toLowerCase();
    if (!['ofrecer', 'conversar', 'esperar'].includes(stage)) return null;
    return { stage, guidance: clip(verdict.orientacion, 240) };
  } catch { return null; }
}

/**
 * @param {{baseUrl:string, apiKey:string, model:string}} llm
 * @returns {Promise<{stage:'ofrecer'|'conversar', guidance:string, usage:{input:number,output:number}}|null>}
 */
export async function judgeConversationStage(llm, { history, message, draft, policy }, { isGpt5Family = false, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model, max_completion_tokens: 140,
        ...(isGpt5Family ? { reasoning_effort: 'none' } : { temperature: 0 }),
        messages: [{ role: 'system', content: policy?.judge_system || JUDGE_SYSTEM }, { role: 'user', content: formatJudgeInput({ history, message, draft, policy }) }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const verdict = parseJudgeVerdict(data.choices?.[0]?.message?.content);
    if (!verdict) return null;
    return { ...verdict, usage: { input: Number(data.usage?.prompt_tokens) || 0, output: Number(data.usage?.completion_tokens) || 0 } };
  } catch { return null; }
}
