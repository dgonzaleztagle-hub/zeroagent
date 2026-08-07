/**
 * Adaptador único del Playground del Studio.
 *
 * La respuesta siempre viene del mismo motor empaquetado que usa el runtime.
 * No existe fallback visual, Gemini directo desde el navegador ni simulador
 * heurístico: si el runtime falla, la prueba falla de forma visible.
 */
export async function getAgentResponse(clientId, _agent, userMessage, _apiKey, _model, chatHistory = []) {
  const startedAt = performance.now();
  const response = await fetch(`/api/clients/${clientId}/playground/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: userMessage, history: chatHistory })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo ejecutar el motor del runtime.');
  const versionLabel = data.version?.number ? ` · paquete v${data.version.number} (${data.version.status})` : '';
  return {
    reply: data.reply,
    retrievedContext: data.retrievedContext || [],
    latency: data.latency ?? Math.round(performance.now() - startedAt),
    modelUsed: `${data.modelUsed || 'deterministic'}${versionLabel}`,
    toolTrace: data.toolTrace || [],
    version: data.version || null
  };
}
