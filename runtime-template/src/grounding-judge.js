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

const AUDIT_SYSTEM = `Eres el auditor de un asistente de WhatsApp de un negocio. Recibes la conversación, los datos confirmados del negocio, lo que las herramientas devolvieron EN ESTE TURNO y el borrador que el asistente quiere enviar. Tu tarea: detectar dos cosas.

1) AFIRMACIONES SOBRE EL DUEÑO O SOBRE UNA CITA SIN RESPALDO. Marca sin_respaldo=true SÓLO si el borrador afirma como cierto algo de estas dos clases y no está respaldado: (a) dónde está, qué hace o cuándo llega el dueño o su equipo; y (b) que existe, se mantiene o está confirmada una cita o visita concreta del cliente, si ninguna herramienta de este turno ni las citas registradas del cliente la respaldan; Lo que el dueño o el asistente dijeron en mensajes ANTERIORES ("voy en camino", "te dejé agendada") fue verdad en su momento y no respalda nada hoy. Hablar de una cita que SÍ figura en las citas registradas del cliente (guardarla, mantenerla, pedirle que confirme) tampoco se marca. Precios, horarios ofrecidos, compromisos de pago, descripciones de los servicios, empatía, saludos, preguntas y frases que derivan al dueño ("le aviso para que te confirme") NO se marcan nunca: otros controles los revisan.

2) PROMESA DE AVISO. El borrador dice o implica que el asistente le avisará, le pasará el mensaje o hará que el dueño o el equipo conteste, confirme o escriba.

Responde SOLO un JSON, sin texto extra: {"sin_respaldo":true|false,"detalle":"una frase: qué afirma sin respaldo y qué debería hacer en cambio","promete_aviso":true|false}`;

const clip = (text, max = 400) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function formatAuditInput({ history = [], message = '', draft = '', facts = [], toolTrace = [], booked = [] }) {
  const lines = history.slice(-10).map(item => `${item.role === 'assistant' ? 'ASISTENTE/DUEÑO (mensaje anterior)' : 'CLIENTE'}: ${clip(item.content, 300)}`);
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
    const kind = String(verdict.clase || '').toLowerCase();
    return { unsupported: verdict.sin_respaldo && (kind === 'paradero' || kind === 'cita'), detail: clip(verdict.detalle, 300), promisesNotice: verdict.promete_aviso === true };
  } catch { return null; }
}

export async function auditDraftGrounding(llm, input, { isGpt5Family = false, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model, max_completion_tokens: 160,
        ...(isGpt5Family ? { reasoning_effort: 'none' } : { temperature: 0 }),
        messages: [{ role: 'system', content: AUDIT_SYSTEM }, { role: 'user', content: formatAuditInput(input) }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const verdict = parseAuditVerdict(data.choices?.[0]?.message?.content);
    if (!verdict) return null;
    return { ...verdict, usage: { input: Number(data.usage?.prompt_tokens) || 0, output: Number(data.usage?.completion_tokens) || 0 } };
  } catch { return null; }
}
