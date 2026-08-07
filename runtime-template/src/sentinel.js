const recentAlerts = new Map();

export async function notifySentinel(event) {
  const token = process.env.SENTINEL_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.SENTINEL_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, reason: 'not_configured' };

  const key = `${event.agentId}:${event.type}:${event.subject || 'general'}`;
  const now = Date.now();
  if (now - (recentAlerts.get(key) || 0) < 10 * 60 * 1000) {
    return { sent: false, reason: 'cooldown' };
  }
  recentAlerts.set(key, now);

  const text = [
    `🚨 Centinela · ${event.agentName || event.agentId}`,
    `Motivo: ${event.type}`,
    event.message ? `Consulta: ${event.message}` : '',
    event.subject ? `Dato relacionado: ${event.subject}` : '',
    'Acción sugerida: revisar la conversación y confirmar el dato antes de actualizar el agente.'
  ].filter(Boolean).join('\n');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!response.ok) throw new Error(`Telegram respondió ${response.status}`);
  return { sent: true };
}
