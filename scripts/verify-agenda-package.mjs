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
        rules: { slot_interval_minutes: 15, minimum_notice_hours: 2, pending_confirmation_ttl_minutes: 30, require_customer_phone: true },
        locations: [{ id: 'loc_qa', name: 'Sede QA' }],
        services: [{ id: 'svc_qa', name: 'Servicio QA', duration_minutes: 60, price_clp: 25000 }],
        resources: [{ id: 'res_qa', name: 'Profesional QA', location_id: 'loc_qa', services: ['Servicio QA'] }]
      },
      safety: { availability_is_authoritative: true, no_booking_without_live_availability_check: true },
      agent_flow_contract: {
        tools: ['get_availability', 'get_my_appointment', 'create_appointment', 'cancel_appointment', 'reschedule_appointment', 'update_customer_profile', 'request_human_handoff'],
        guarantees: ['verified_channel_identity', 'atomic_mutations', 'intent_can_change_between_turns', 'no_confirmation_without_tool_success']
      }
    }
  }
};

try {
  await fs.cp(path.join(root, 'runtime-template'), temporary, { recursive: true });
  for (const onboardingAsset of ['onboarding.html', 'onboarding.css', 'onboarding.js']) {
    await fs.copyFile(path.join(root, onboardingAsset), path.join(temporary, 'public', onboardingAsset));
  }
  await fs.writeFile(path.join(temporary, 'agent-package.json'), JSON.stringify(packageData, null, 2));
  for (const required of ['INSTALLATION_MANIFEST.md', 'supabase/agenda-v1.sql', 'supabase/migrations/20260807_agenda_hardening_v2.sql', 'supabase/migrations/20260807_zavu_delivery_v1.sql', 'public/agenda.html', 'public/client-console.css', 'public/client-console-layout.css', 'public/client-console-tour.css', 'public/client-console-v2.js', 'public/booking.html', 'public/onboarding.html', 'public/onboarding.css', 'public/onboarding.js', 'src/agenda-tools.js', 'src/outbox.js']) {
    await fs.access(path.join(temporary, required));
  }
  const migration = await fs.readFile(path.join(temporary, 'supabase', 'agenda-v1.sql'), 'utf8');
  const incrementalMigration = await fs.readFile(path.join(temporary, 'supabase', 'migrations', '20260807_agenda_hardening_v2.sql'), 'utf8');
  const runtimeServer = await fs.readFile(path.join(temporary, 'src', 'server.js'), 'utf8');
  const agendaHtml = await fs.readFile(path.join(temporary, 'public', 'agenda.html'), 'utf8');
  const clientConsole = await fs.readFile(path.join(temporary, 'public', 'client-console-v2.js'), 'utf8');
  assert.match(migration, /za_onboarding_sessions/, 'Falta persistencia Supabase del onboarding.');
  assert.match(migration, /delivery_status/, 'Falta estado persistente para mensajes humanos.');
  assert.match(runtimeServer, /\/api\/onboarding\//, 'Falta API instalable del onboarding.');
  assert.match(runtimeServer, /sendZavuWhatsApp\(conversation\.external_id, text, \{ idempotencyKey: operationKey \}\)/, 'Falta envío humano idempotente por Zavu desde la consola.');
  assert.match(runtimeServer, /RUNTIME_MODE/, 'Falta separar explícitamente preview, staging y producción.');
  assert.match(runtimeServer, /GENERIC_WEBHOOK_SECRET/, 'El webhook genérico no exige secreto propio.');
  assert.match(runtimeServer, /runtimeMode !== 'preview_local' \|\| channelProvider !== 'generic_webhook'/, 'El webhook genérico sigue disponible fuera del preview local.');
  assert.match(runtimeServer, /pathname === '\/client-console-tour\.css'/, 'El runtime no sirve la hoja de estilos del tour de consola.');
  assert.match(runtimeServer, /return json\(res, 503, \{ ok: false, retryable: true \}\)/, 'El webhook Zavu confirma un fallo transitorio y evita el reintento.');
  assert.match(runtimeServer, /pathname === '\/api\/agenda\/public-slots'/, 'La reserva pública no tiene un endpoint de disponibilidad real.');
  assert.match(runtimeServer, /slots_endpoint: '\/api\/agenda\/public-slots'/, 'El catálogo público no anuncia la capability de slots.');
  assert.match(migration, /revoke all on function public\.za_request_appointment[\s\S]*from public, anon, authenticated/i, 'La creación de reservas sigue expuesta a roles públicos.');
  assert.match(migration, /za_transition_appointment/, 'Falta transición atómica y validada de reservas.');
  assert.match(migration, /za_request_handoff/, 'Falta handoff transaccional con outbox.');
  assert.match(migration, /p_confirmation_mode text default 'manual'/, 'Reagendar no recibe el modo de confirmación.');
  assert.match(migration, /status = case when p_confirmation_mode = 'automatic'/, 'Un reagendamiento manual puede auto-confirmarse.');
  assert.match(incrementalMigration, /za_schema_migrations/, 'Falta versionado incremental del esquema instalado.');
  assert.match(incrementalMigration, /expires_at/, 'La migración incremental no agrega vencimiento a solicitudes pendientes.');
  assert.match(incrementalMigration, /a\.starts_at = p_starts_at/, 'La RPC no deduplica reintentos de la cita exacta.');
  assert.match(incrementalMigration, /p_source = 'public_booking' then existing\.medical_history/, 'Una reserva pública todavía podría reemplazar la ficha clínica existente.');
  const publicSanitizer = runtimeServer.match(/const appointmentInput = source === 'public_booking' \? \{[\s\S]*?\} : body;/)?.[0] || '';
  assert.ok(publicSanitizer, 'La API de reserva pública no tiene una allowlist explícita.');
  assert.doesNotMatch(publicSanitizer, /customer_(?:age|occupation|medical_history|extra_symptoms)/, 'La API pública acepta campos privados de CRM/ficha clínica.');
  assert.match(agendaHtml, /data-calendar-mode="day"/, 'Falta selector funcional de vista diaria.');
  assert.match(clientConsole, /calendarMode:'week'/, 'Falta estado semana/día del calendario.');
  assert.match(clientConsole, /resource-count/, 'Faltan contadores visibles por profesional.');
  assert.match(clientConsole, /has-concurrency/, 'Falta tratamiento visual de reservas simultáneas.');
  assert.match(clientConsole, /renderRuntimeFailure/, 'Falta un estado de error productivo explícito.');
  const bookingHtml = await fs.readFile(path.join(temporary, 'public', 'booking.html'), 'utf8');
  assert.doesNotMatch(bookingHtml, /innerHTML\s*=\s*items\.map/, 'La reserva pública vuelve a inyectar datos del catálogo como HTML.');
  assert.match(bookingHtml, /option\.textContent\s*=\s*(?:String\()?item\.name/, 'El catálogo público no usa inserción DOM segura.');
  const { verifyZavuSignature } = await import(pathToFileURL(path.join(temporary, 'src', 'zavu.js')).href);
  const { validateMutationClaims } = await import(pathToFileURL(path.join(temporary, 'src', 'engine.js')).href);
  const raw = '{"id":"evt_qa"}'; const secret = 'qa-secret'; const timestamp = 1_700_000_000;
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifyZavuSignature(raw, `t=${timestamp},v1=${signature}`, secret, timestamp * 1000), true, 'Firma Zavu válida rechazada.');
  assert.equal(verifyZavuSignature(raw, `t=${timestamp - 301},v1=${signature}`, secret, timestamp * 1000), false, 'Timestamp Zavu vencido aceptado.');
  assert.equal(verifyZavuSignature(raw, `t=${timestamp},v1=${'0'.repeat(64)}`, secret, timestamp * 1000), false, 'Firma Zavu alterada aceptada.');
  assert.equal(validateMutationClaims('Tu reserva quedó confirmada para mañana.', []).ok, false, 'El modelo pudo confirmar una reserva sin éxito de herramienta.');
  assert.equal(validateMutationClaims('Tu reserva quedó confirmada para mañana.', [{ name: 'create_appointment', result: { ok: true } }]).ok, true, 'Se bloqueó una confirmación respaldada por herramienta.');
  // src/server.js ya no es un proceso propio (es un handler serverless puro para Vercel, ver
  // el comentario al final de ese archivo) — arrancarlo con `node src/server.js` siempre sale
  // con status 0 porque no hay nada que mantenga vivo el proceso. La validación de config
  // faltante ahora vive en initError y se expone recién cuando handleRequest atiende una
  // request, así que hay que invocar el handler directo, no spawnear el archivo.
  const checkScript = `
    import { handleRequest } from './src/server.js';
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => { logs.push(args.map(String).join(' ')); };
    let status = null, body = '';
    const res = { writeHead(code) { status = code; }, end(chunk) { body += chunk || ''; } };
    await handleRequest({ method: 'GET', url: '/health', headers: { host: 'localhost' } }, res);
    originalError.call(console, '##RESULT##' + JSON.stringify({ status, body, logs }));
  `;
  await fs.writeFile(path.join(temporary, 'check-init-failure.mjs'), checkScript, 'utf8');
  const missingProductionConfig = spawnSync(process.execPath, ['check-init-failure.mjs'], {
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
  const resultLine = `${missingProductionConfig.stdout}${missingProductionConfig.stderr}`.split('\n').find(line => line.includes('##RESULT##'));
  assert.ok(resultLine, `El runtime productivo no reportó ningún resultado. stdout/stderr: ${missingProductionConfig.stdout}${missingProductionConfig.stderr}`);
  const initFailureResult = JSON.parse(resultLine.slice(resultLine.indexOf('##RESULT##') + '##RESULT##'.length));
  assert.equal(initFailureResult.status, 500, 'El runtime productivo respondió sin credenciales obligatorias en vez de fallar cerrado.');
  assert.match(initFailureResult.logs.join('\n'), /Configuración incompleta para production/, 'El fallo de configuración productiva no explica la causa en los logs del servidor.');

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
  assert.ok(first.expires_at && new Date(first.expires_at).getTime() > Date.now(), 'Una solicitud manual no recibió expires_at.');
  const exactRetry = await agendaModule.createAgendaAppointment(packageData, {
    customer_name: 'Cliente QA', customer_phone: '+56911111111', service: 'Servicio QA', resource: 'Profesional QA',
    location: 'Sede QA', starts_at: start.toISOString()
  }, 'adversarial_test');
  assert.equal(exactRetry.id, first.id, 'Un reintento exacto creó una segunda cita.');
  const recurringStart = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const recurring = await agendaModule.createAgendaAppointment(packageData, {
    customer_name: 'Cliente QA', customer_phone: '+56911111111', service: 'Servicio QA', resource: 'Profesional QA',
    location: 'Sede QA', starts_at: recurringStart.toISOString()
  }, 'adversarial_test');
  assert.notEqual(recurring.id, first.id, 'El anti-duplicado bloqueó una sesión futura distinta del mismo servicio.');
  const localStatePath = path.join(temporary, 'storage', 'agenda-state-agenda-qa.json');
  const localState = JSON.parse(await fs.readFile(localStatePath, 'utf8'));
  localState.appointments.find(item => item.id === recurring.id).expires_at = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(localStatePath, JSON.stringify(localState, null, 2));
  const replacement = await agendaModule.createAgendaAppointment(packageData, {
    customer_name: 'Cliente QA', customer_phone: '+56911111111', service: 'Servicio QA', resource: 'Profesional QA',
    location: 'Sede QA', starts_at: recurringStart.toISOString()
  }, 'adversarial_test');
  assert.notEqual(replacement.id, recurring.id, 'Una solicitud vencida siguió bloqueando la hora.');
  const stateWithReplacement = JSON.parse(await fs.readFile(localStatePath, 'utf8'));
  stateWithReplacement.appointments.find(item => item.id === replacement.id).expires_at = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(localStatePath, JSON.stringify(stateWithReplacement, null, 2));
  await assert.rejects(() => agendaModule.updateAgendaAppointment(packageData, replacement.id, 'confirmed'), /venció/, 'Se confirmó una solicitud pendiente ya vencida.');
  const recurringDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(recurringStart);
  const slotsAfterExpiry = await agendaModule.getAvailableSlots(packageData, { service: 'Servicio QA', resource: 'Profesional QA', date: recurringDate });
  assert.ok(slotsAfterExpiry.includes(recurringStart.toISOString()), 'Una solicitud vencida siguió ocultando el slot disponible.');
  await agendaModule.createAgendaAvailabilityBlock(packageData, { resource: 'Profesional QA', starts_at: recurringStart.toISOString(), ends_at: new Date(recurringStart.getTime() + 60 * 60_000).toISOString(), reason: 'QA' });
  const slotsAfterBlock = await agendaModule.getAvailableSlots(packageData, { service: 'Servicio QA', resource: 'Profesional QA', date: recurringDate });
  assert.equal(slotsAfterBlock.includes(recurringStart.toISOString()), false, 'El generador de slots local ignoró un bloqueo puntual.');
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
  const riskDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(start.getTime() + 86_400_000));
  const riskTarget = new Date(agendaModule.asIso(`${riskDate}T12:00`, 'America/Santiago'));
  const riskParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(riskTarget).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
  packageData.solutions.agenda.config.confirmation_mode = 'automatic';
  packageData.solutions.agenda.config.risk_windows = [{ resource: 'Profesional QA', day_of_week: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(riskParts.weekday), starts_at: `${riskParts.hour}:${riskParts.minute}`, ends_at: '24:00', reason: 'QA' }];
  const rescheduled = await agendaModule.rescheduleAgendaAppointment(packageData, { id: first.id, new_starts_at: riskTarget.toISOString() });
  assert.equal(rescheduled.status, 'pending_confirmation', 'Una franja de riesgo se auto-confirmó al reagendar.');
  assert.ok(rescheduled.expires_at, 'El reagendamiento pendiente no recibió expires_at.');
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
