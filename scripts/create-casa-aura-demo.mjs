const baseUrl = process.env.ZEROAGENT_STUDIO_URL || 'http://localhost:8080';
const clientId = 'casa-aura-demo';

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
      name: 'Casa Aura · Demo',
      niche: 'Spa y bienestar',
      desc: 'Centro ficticio de bienestar para demostrar el producto Agenda v1.',
      agent: {
        name: 'Aura',
        tone: 'friendly',
        role: 'Orientar, informar y gestionar reservas verificando disponibilidad real.',
        systemPrompt: 'Eres Aura, asistente de Casa Aura. Nunca inventes disponibilidad, precios ni confirmaciones. Para reservar, cambiar o cancelar debes usar las herramientas de agenda y confirmar sólo si resultan exitosas.'
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
    cancellation_policy: 'Puedes cancelar o reprogramar hasta 2 horas antes, sujeto a disponibilidad.',
    locations: [{ name: 'Casa Aura · Providencia', address: 'Av. Providencia 1234', hours: 'Lunes a sábado 10:00–20:00' }],
    services: [
      { name: 'Masaje descontracturante', duration_minutes: 60, price_clp: 35000 },
      { name: 'Facial hidratante', duration_minutes: 45, price_clp: 28000 }
    ],
    resources: [
      { name: 'Camila Soto', specialty: 'Masoterapeuta', services: ['Masaje descontracturante'] },
      { name: 'Martina Rojas', specialty: 'Cosmetóloga', services: ['Facial hidratante'] }
    ],
    rules: { slot_interval_minutes: 15, minimum_notice_hours: 2, maximum_advance_days: 60, require_customer_phone: true, human_handoff_on_conflict: true }
  })
});

let demo = (await call('/api/clients')).find(client => client.id === clientId);
if (!demo.knowledgeItems?.length) {
  await call(`/api/clients/${clientId}/knowledge-items`, {
    method: 'POST',
    body: JSON.stringify({
      category: 'operación',
      subject: 'política de reservas',
      value: 'Las reservas se confirman sólo después de que la agenda valida el horario. No se debe prometer cupo antes.',
      notes: 'Dato de demostración controlado.',
      testQuestion: '¿Me puedes confirmar mañana a las 17:00?',
      expectedBehavior: 'Revisar disponibilidad viva antes de confirmar.'
    })
  });
}

demo = (await call('/api/clients')).find(client => client.id === clientId);
let version = demo.versions?.find(item => item.version === '1.0.0');
if (!version) {
  const created = await call(`/api/clients/${clientId}/versions`, {
    method: 'POST', body: JSON.stringify({ version: '1.0.0', summary: 'Demo Agenda v1 · Casa Aura' })
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
