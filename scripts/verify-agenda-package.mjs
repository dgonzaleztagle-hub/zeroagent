import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zeroagent-agenda-'));

const packageData = {
  package_version: '0.0.0-qa',
  business: { id: 'agenda-qa', display_name: 'Agenda QA' },
  agent: { name: 'Agente QA', policy: { unknown_fact_behavior: 'admit_unknown_and_offer_handoff' } },
  knowledge: { confirmed_facts: [] },
  tests: [],
  solutions: {
    agenda: {
      contract_version: '1.0.0',
      config: {
        enabled: true,
        timezone: 'America/Santiago',
        confirmation_mode: 'manual',
        rules: { slot_interval_minutes: 15, minimum_notice_hours: 2, require_customer_phone: true },
        locations: [{ id: 'loc_qa', name: 'Sede QA' }],
        services: [{ id: 'svc_qa', name: 'Servicio QA', duration_minutes: 60, price_clp: 25000 }],
        resources: [{ id: 'res_qa', name: 'Profesional QA', location_id: 'loc_qa', services: ['Servicio QA'] }]
      },
      safety: { availability_is_authoritative: true, no_booking_without_live_availability_check: true },
      agent_flow_contract: { guarantees: ['verified_channel_identity', 'atomic_mutations', 'intent_can_change_between_turns', 'no_confirmation_without_tool_success'] }
    }
  }
};

try {
  await fs.cp(path.join(root, 'runtime-template'), temporary, { recursive: true });
  for (const onboardingAsset of ['onboarding.html', 'onboarding.css', 'onboarding.js']) {
    await fs.copyFile(path.join(root, onboardingAsset), path.join(temporary, 'public', onboardingAsset));
  }
  await fs.writeFile(path.join(temporary, 'agent-package.json'), JSON.stringify(packageData, null, 2));
  for (const required of ['INSTALLATION_MANIFEST.md', 'supabase/agenda-v1.sql', 'public/agenda.html', 'public/client-console.css', 'public/client-console-layout.css', 'public/client-console-tour.css', 'public/client-console-v2.js', 'public/booking.html', 'public/onboarding.html', 'public/onboarding.css', 'public/onboarding.js', 'src/agenda-tools.js', 'src/outbox.js']) {
    await fs.access(path.join(temporary, required));
  }
  const migration = await fs.readFile(path.join(temporary, 'supabase', 'agenda-v1.sql'), 'utf8');
  const runtimeServer = await fs.readFile(path.join(temporary, 'src', 'server.js'), 'utf8');
  const agendaHtml = await fs.readFile(path.join(temporary, 'public', 'agenda.html'), 'utf8');
  const clientConsole = await fs.readFile(path.join(temporary, 'public', 'client-console-v2.js'), 'utf8');
  assert.match(migration, /za_onboarding_sessions/, 'Falta persistencia Supabase del onboarding.');
  assert.match(migration, /delivery_status/, 'Falta estado persistente para mensajes humanos.');
  assert.match(runtimeServer, /\/api\/onboarding\//, 'Falta API instalable del onboarding.');
  assert.match(runtimeServer, /sendZavuWhatsApp\(conversation\.external_id, text\)/, 'Falta envío humano por Zavu desde la consola.');
  assert.match(runtimeServer, /RUNTIME_MODE/, 'Falta separar explícitamente preview, staging y producción.');
  assert.match(runtimeServer, /GENERIC_WEBHOOK_SECRET/, 'El webhook genérico no exige secreto propio.');
  assert.match(runtimeServer, /runtimeMode !== 'preview_local' \|\| channelProvider !== 'generic_webhook'/, 'El webhook genérico sigue disponible fuera del preview local.');
  assert.match(runtimeServer, /pathname === '\/client-console-tour\.css'/, 'El runtime no sirve la hoja de estilos del tour de consola.');
  assert.match(runtimeServer, /return json\(res, 503, \{ ok: false, retryable: true \}\)/, 'El webhook Zavu confirma un fallo transitorio y evita el reintento.');
  assert.match(migration, /revoke all on function public\.za_request_appointment[\s\S]*from public, anon, authenticated/i, 'La creación de reservas sigue expuesta a roles públicos.');
  assert.match(migration, /za_transition_appointment/, 'Falta transición atómica y validada de reservas.');
  assert.match(migration, /za_request_handoff/, 'Falta handoff transaccional con outbox.');
  assert.match(migration, /p_confirmation_mode text default 'manual'/, 'Reagendar no recibe el modo de confirmación.');
  assert.match(migration, /status = case when p_confirmation_mode = 'automatic'/, 'Un reagendamiento manual puede auto-confirmarse.');
  assert.match(agendaHtml, /data-calendar-mode="day"/, 'Falta selector funcional de vista diaria.');
  assert.match(clientConsole, /calendarMode:'week'/, 'Falta estado semana/día del calendario.');
  assert.match(clientConsole, /resource-count/, 'Faltan contadores visibles por profesional.');
  assert.match(clientConsole, /has-concurrency/, 'Falta tratamiento visual de reservas simultáneas.');
  assert.match(clientConsole, /renderRuntimeFailure/, 'Falta un estado de error productivo explícito.');
  const bookingHtml = await fs.readFile(path.join(temporary, 'public', 'booking.html'), 'utf8');
  assert.doesNotMatch(bookingHtml, /innerHTML\s*=\s*items\.map/, 'La reserva pública vuelve a inyectar datos del catálogo como HTML.');
  assert.match(bookingHtml, /option\.textContent\s*=\s*String\(item\.name/, 'El catálogo público no usa inserción DOM segura.');
  const { verifyZavuSignature } = await import(pathToFileURL(path.join(temporary, 'src', 'zavu.js')).href);
  const { validateMutationClaims } = await import(pathToFileURL(path.join(temporary, 'src', 'engine.js')).href);
  const raw = '{"id":"evt_qa"}'; const secret = 'qa-secret'; const timestamp = 1_700_000_000;
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifyZavuSignature(raw, `t=${timestamp},v1=${signature}`, secret, timestamp * 1000), true, 'Firma Zavu válida rechazada.');
  assert.equal(verifyZavuSignature(raw, `t=${timestamp - 301},v1=${signature}`, secret, timestamp * 1000), false, 'Timestamp Zavu vencido aceptado.');
  assert.equal(verifyZavuSignature(raw, `t=${timestamp},v1=${'0'.repeat(64)}`, secret, timestamp * 1000), false, 'Firma Zavu alterada aceptada.');
  assert.equal(validateMutationClaims('Tu reserva quedó confirmada para mañana.', []).ok, false, 'El modelo pudo confirmar una reserva sin éxito de herramienta.');
  assert.equal(validateMutationClaims('Tu reserva quedó confirmada para mañana.', [{ name: 'create_appointment', result: { ok: true } }]).ok, true, 'Se bloqueó una confirmación respaldada por herramienta.');
  const missingProductionConfig = spawnSync(process.execPath, ['src/server.js'], {
    cwd: temporary,
    encoding: 'utf8',
    env: {
      ...process.env,
      PORT: '0',
      RUNTIME_MODE: 'production',
      CHANNEL_PROVIDER: 'zavu',
      PREVIEW_ACCESS_KEY: '',
      DASHBOARD_ACCESS_KEY: '',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      ZAVUDEV_API_KEY: '',
      ZAVUDEV_SENDER_ID: '',
      ZAVUDEV_WEBHOOK_SECRET: ''
    }
  });
  assert.notEqual(missingProductionConfig.status, 0, 'El runtime productivo inició sin credenciales obligatorias.');
  assert.match(`${missingProductionConfig.stdout}${missingProductionConfig.stderr}`, /Configuración incompleta para production/, 'El fallo de configuración productiva no explica la causa.');

  const originalSupabaseUrl = process.env.SUPABASE_URL;
  const originalSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const agendaModule = await import(pathToFileURL(path.join(temporary, 'src', 'agenda.js')).href);
  const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  await assert.rejects(() => agendaModule.createAgendaAppointment(packageData, {
    customer_name: 'Sin horario QA', customer_phone: '+56900000000', service: 'Servicio QA', resource: 'Profesional QA',
    location: 'Sede QA', starts_at: start.toISOString()
  }, 'adversarial_test'), /Horario fuera de disponibilidad/, 'El preview permitió reservar sin horario explícito.');
  for (let day = 0; day < 7; day++) {
    await agendaModule.createAgendaAvailabilityRule(packageData, { resource: 'Profesional QA', day_of_week: day, starts_at: '00:00', ends_at: '23:59' });
  }
  const first = await agendaModule.createAgendaAppointment(packageData, {
    customer_name: 'Cliente QA', customer_phone: '+56911111111', service: 'Servicio QA', resource: 'Profesional QA',
    location: 'Sede QA', starts_at: start.toISOString()
  }, 'adversarial_test');
  await assert.rejects(() => agendaModule.createAgendaAppointment(packageData, {
    customer_name: 'Cruce QA', customer_phone: '+56922222222', service: 'Servicio QA', resource: 'Profesional QA',
    location: 'Sede QA', starts_at: new Date(start.getTime() + 30 * 60 * 1000).toISOString()
  }, 'adversarial_test'), /cruza con el horario/, 'Se aceptó una doble reserva superpuesta.');
  await assert.rejects(() => agendaModule.createAgendaAppointment(packageData, {
    customer_name: 'Aviso QA', customer_phone: '+56933333333', service: 'Servicio QA', resource: 'Profesional QA',
    location: 'Sede QA', starts_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  }, 'adversarial_test'), /aviso mínimo/, 'Se ignoró el aviso mínimo.');
  await assert.rejects(() => agendaModule.createAgendaAppointment(packageData, {
    customer_name: 'Anticipación QA', customer_phone: '+56944444444', service: 'Servicio QA', resource: 'Profesional QA',
    location: 'Sede QA', starts_at: new Date(Date.now() + 731 * 24 * 60 * 60 * 1000).toISOString()
  }, 'adversarial_test'), /anticipación máxima/, 'Se ignoró la anticipación máxima.');
  await agendaModule.updateAgendaAppointment(packageData, first.id, 'confirmed');
  await assert.rejects(() => agendaModule.updateAgendaAppointment(packageData, first.id, 'pending_confirmation'), /no permitida/, 'Se permitió retroceder una reserva confirmada.');
  const rescheduled = await agendaModule.rescheduleAgendaAppointment(packageData, { id: first.id, new_starts_at: new Date(start.getTime() + 2 * 60 * 60 * 1000).toISOString() });
  assert.equal(rescheduled.status, 'pending_confirmation', 'Un reagendamiento manual local no puede auto-confirmarse.');
  if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalSupabaseUrl;
  if (originalSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalSupabaseKey;
  const result = spawnSync(process.execPath, ['src/run-tests.js'], { cwd: temporary, encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.status, 0, 'La batería empaquetada de Agenda falló.');
  console.log('PASS · Paquete Agenda v1 contiene contrato, pantallas, migración y tests ejecutables.');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
