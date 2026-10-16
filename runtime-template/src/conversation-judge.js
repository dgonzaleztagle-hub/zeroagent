/**
 * Juez de ritmo de conversación. Reemplaza los contadores ("no horas antes de N preguntas", "una
 * pregunta máx.") por un juicio sobre la conversación completa: ¿ya es buen momento de ofrecer horas
 * o conviene seguir conversando? Un modelo que ve el hilo entero decide mejor que cualquier regla
 * por palabras clave. Si falla (red, JSON inválido) no bloquea nada: se deja pasar el borrador.
 */

const JUDGE_SYSTEM = `Eres el supervisor de ritmo de conversación de un asistente de WhatsApp de un centro de salud (kinesiología / quiropráctica). Tu única tarea: decidir si en el próximo mensaje ya es buen momento de OFRECER HORAS o si conviene SEGUIR CONVERSANDO.

Piensa como un buen vendedor humano y cercano: entiende a la persona, reacciona a lo que cuenta, y propone la hora cuando corresponde. Ni interrogatorio ni charla de la vida.

Para poder ofrecer horas con naturalidad, un buen vendedor ya sabe tres cosas de la persona: (1) qué le pasa, (2) desde cuándo, y (3) si lo ha tratado o tiene diagnóstico o examen (una resonancia, un traumatólogo, un kinesiólogo cuentan). Las tres pueden estar CONTADAS por ella o haber sido PREGUNTADAS ya por el asistente (aunque no las haya contestado bien).

Es momento de OFRECER cuando:
- ya tienes esas tres cosas (contadas o preguntadas), o
- la persona deja claro que sólo quiere resolver la hora y no conversar (insiste, ya entrega sus datos, responde a horas que ya se le ofrecieron, o nombra un día y no cuenta nada más), o
- ya conversaron lo razonable y seguir preguntando sería interrogar (más de tres preguntas seguidas del asistente es demasiado).

Conviene SEGUIR CONVERSANDO cuando:
- falta alguna de las tres cosas y la persona no está apurada por la hora: aunque haya pedido una hora o dicho hace cuánto le duele, si nunca se habló de diagnóstico o tratamiento previo, primero se pregunta eso,
- la persona recién llegó o contó su molestia en una frase y no sabes casi nada más,
- te hizo una pregunta sobre su caso o su diagnóstico: se le responde con honestidad y cercanía y se espera su respuesta antes de pasar a horas,
- contó algo importante o personal a lo que primero corresponde reaccionar con una frase humana,
- pregunta algo seco (precio, ubicación, horario) sin contar qué le pasa: se responde y se pregunta con cercanía qué le molesta.

Las preguntas sobre precio, ubicación, formas de pago o datos del negocio se responden de frente y no cambian la etapa por sí solas.

Responde SOLO un JSON, sin texto extra: {"etapa":"ofrecer"|"conversar","orientacion":"una frase corta: qué debería hacer el próximo mensaje (por ejemplo: reaccionar a lo que contó y preguntar si tiene diagnóstico o tratamiento previo)"}`;

const clip = (text, max = 500) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function formatJudgeInput({ history = [], message = '', draft = '' }) {
  const lines = history.slice(-12).map(item => `${item.role === 'assistant' ? 'ASISTENTE' : 'CLIENTE'}: ${clip(item.content)}`);
  lines.push(`CLIENTE (mensaje al que se responde ahora): ${clip(message)}`);
  return `Conversación:\n${lines.join('\n')}\n\nBorrador del asistente (todavía no enviado):\n${clip(draft, 700)}`;
}

export function parseJudgeVerdict(text) {
  const match = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!match) return null;
  try {
    const verdict = JSON.parse(match[0]);
    const stage = String(verdict.etapa || '').toLowerCase();
    if (stage !== 'ofrecer' && stage !== 'conversar') return null;
    return { stage, guidance: clip(verdict.orientacion, 240) };
  } catch { return null; }
}

/**
 * @param {{baseUrl:string, apiKey:string, model:string}} llm
 * @returns {Promise<{stage:'ofrecer'|'conversar', guidance:string, usage:{input:number,output:number}}|null>}
 */
export async function judgeConversationStage(llm, { history, message, draft }, { isGpt5Family = false, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model, max_completion_tokens: 140,
        ...(isGpt5Family ? { reasoning_effort: 'none' } : { temperature: 0 }),
        messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: formatJudgeInput({ history, message, draft }) }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const verdict = parseJudgeVerdict(data.choices?.[0]?.message?.content);
    if (!verdict) return null;
    return { ...verdict, usage: { input: Number(data.usage?.prompt_tokens) || 0, output: Number(data.usage?.completion_tokens) || 0 } };
  } catch { return null; }
}
