const baseUrl = process.env.ZEROAGENT_STUDIO_URL || 'http://localhost:8080';
const clientId = 'quiro-demo';

async function call(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${body.error || response.status}`);
  return body;
}

const clients = await call('/api/clients');
if (!clients.some(client => client.id === clientId)) {
  await call('/api/clients', {
    method: 'POST',
    body: JSON.stringify({
      id: clientId,
      name: 'Quiropráctica Vitalis · Demo',
      niche: 'Quiropráctico / atención manual',
      desc: 'Consulta quiropráctica ficticia para demostrar el agendador móvil de ZeroAgent.',
      agent: {
        name: 'Asistente de Vitalis',
        tone: 'friendly',
        role: 'Orientar sobre servicios, resolver dudas generales y gestionar reservas verificando disponibilidad real. Nunca diagnostica ni promete resultados clínicos.',
        systemPrompt: 'Eres el asistente de Quiropráctica Vitalis. Nunca diagnostiques, nunca afirmes que un dolor es o no es una condición médica (hernia, pinzamiento, etc.) y nunca prometas resultados de tratamiento. Ante cualquier consulta técnica o de dolor/síntomas, no la respondas por tu cuenta: ofrece agendar una evaluación con el quiropráctico para que la revise en persona, y si el cliente lo pide explícitamente, deriva a una persona. Para horarios, precios y servicios, usa sólo el conocimiento confirmado y las herramientas de agenda.'
      }
    })
  });
}

await call(`/api/clients/${clientId}/agenda`, {
  method: 'PUT',
  body: JSON.stringify({
    enabled: true,
    booking_mode: 'appointment',
    confirmation_mode: 'manual',
    timezone: 'America/Santiago',
    reminder_hours: 24,
    cancellation_policy: 'Puedes cancelar o reprogramar hasta 3 horas antes, sujeto a disponibilidad.',
    locations: [{ name: 'Vitalis · Ñuñoa', address: 'Irarrázaval 3100, Ñuñoa', hours: 'Lunes a viernes 10:00–19:00, sábado 10:00–14:00' }],
    services: [
      { name: 'Evaluación inicial', duration_minutes: 40, price_clp: 30000 },
      { name: 'Sesión de ajuste', duration_minutes: 25, price_clp: 22000 },
      { name: 'Control de seguimiento', duration_minutes: 20, price_clp: 18000 }
    ],
    resources: [
      { name: 'Dr. Ignacio Prieto', specialty: 'Quiropráctico', services: ['Evaluación inicial', 'Sesión de ajuste', 'Control de seguimiento'] }
    ],
    rules: { slot_interval_minutes: 20, minimum_notice_hours: 3, maximum_advance_days: 45, require_customer_phone: true, human_handoff_on_conflict: true }
  })
});

let demo = (await call('/api/clients')).find(client => client.id === clientId);
if (!demo.knowledgeItems?.length) {
  await call(`/api/clients/${clientId}/knowledge-items`, {
    method: 'POST',
    body: JSON.stringify({
      category: 'operación', subject: 'criterio profesional',
      value: 'Ante dolor, síntomas o preguntas de diagnóstico, el agente nunca opina ni tranquiliza: ofrece agendar una evaluación inicial para que el Dr. Ignacio lo revise en persona.',
      notes: 'Dato de demostración controlado.',
      testQuestion: 'Me duele mucho la espalda hace 3 días, ¿me puedes decir si es una hernia?',
      expectedBehavior: 'No diagnosticar ni tranquilizar; ofrecer agendar una evaluación inicial.'
    })
  });
  await call(`/api/clients/${clientId}/knowledge-items`, {
    method: 'POST',
    body: JSON.stringify({
      category: 'políticas', subject: 'formas de pago',
      value: 'Se acepta efectivo, débito, crédito y transferencia. No se trabaja con convenios de isapre ni reembolso directo.',
      notes: 'Dato de demostración controlado.',
      testQuestion: '¿Puedo pagar con isapre?',
      expectedBehavior: 'Aclarar que no hay convenio ni reembolso directo, e indicar los medios de pago aceptados.'
    })
  });
}

demo = (await call('/api/clients')).find(client => client.id === clientId);
let version = demo.versions?.find(item => item.version === '1.0.0');
if (!version) {
  const created = await call(`/api/clients/${clientId}/versions`, {
    method: 'POST', body: JSON.stringify({ version: '1.0.0', summary: 'Demo agendador móvil · Quiropráctica Vitalis' })
  });
  version = { id: created.versionId, status: 'draft' };
}
if (version.status !== 'approved') {
  await call(`/api/clients/${clientId}/versions/${version.id}/approve`, { method: 'PUT', body: '{}' });
}

const build = await call(`/api/clients/${clientId}/versions/${version.id}/build-runtime`, {
  method: 'POST',
  body: JSON.stringify({ target: 'preview' })
});
const preflight = await call(`/api/clients/${clientId}/installation-preflight?target=preview`);
console.log(JSON.stringify({ clientId, preflight, build }, null, 2));
