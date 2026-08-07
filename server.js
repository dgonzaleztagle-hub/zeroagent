import express from 'express';
import cors from 'cors';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'crypto';
import { createLocalVault } from './vault.js';
import { answerWithGroq as answerWithRuntimeEngine } from './runtime-template/src/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cargador mínimo de .env sin dependencias: permite configurar SERPER_API_KEY, GROQ_API_KEY y otras
// variables en un archivo .env local sin instalar paquetes. Lo ya presente en el entorno tiene prioridad.
(() => {
  try {
    const raw = readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* sin .env: se usan las variables del entorno del sistema */ }
})();
const storageRoot = path.join(__dirname, 'storage', 'sources');
const ideInboxRoot = path.join(__dirname, '.zeroagent', 'inbox');
const backupRoot = path.join(__dirname, 'storage', 'backups');
const runtimeTemplateRoot = path.join(__dirname, 'runtime-template');
const runtimeBuildRoot = path.join(__dirname, 'storage', 'agent-builds');
const vaultRoot = path.join(__dirname, 'storage', 'vault');
const onboardingRoot = path.join(__dirname, 'storage', 'onboarding');
const localVault = createLocalVault(vaultRoot);
const runtimeVersion = 'zeroagent-runtime-node-v4-preview-groq-metrics';

const toneProfiles = {
  friendly: {
    label: 'Cálido y amistoso',
    instructions: ['Habla con cercanía y empatía.', 'Usa lenguaje simple y positivo.', 'Puedes usar uno o dos emojis sólo si aportan claridad.'],
    avoid: ['Exceso de confianza o promesas no confirmadas.']
  },
  professional: {
    label: 'Formal y profesional',
    instructions: ['Usa un trato respetuoso y preciso.', 'Prioriza claridad, orden y datos verificables.', 'Evita emojis salvo que el negocio los requiera.'],
    avoid: ['Lenguaje coloquial, presión comercial o afirmaciones informales.']
  },
  casual: {
    label: 'Casual e informal',
    instructions: ['Habla de forma natural y cercana.', 'Mantén mensajes breves y fáciles de responder.', 'Conserva siempre el respeto y la precisión.'],
    avoid: ['Jerga que pueda confundir o quitar seriedad a un problema.']
  },
  direct: {
    label: 'Directo y conciso',
    instructions: ['Responde primero lo que se preguntó.', 'Usa frases cortas, listas y una pregunta por vez.', 'Elimina introducciones y relleno innecesario.'],
    avoid: ['Explicaciones largas, rodeos o presión comercial.']
  },
  persuasive: {
    label: 'Persuasivo / ventas',
    instructions: ['Conecta beneficios confirmados con la necesidad del cliente.', 'Propón un siguiente paso concreto: cotizar, reservar o comprar.', 'Resuelve objeciones sin ocultar condiciones ni límites.'],
    avoid: ['Inventar urgencia, descuentos, disponibilidad o resultados.']
  }
};

// Agenda es un producto instalable, no una instrucción escondida dentro del prompt.
// La configuración se mantiene pequeña en Studio y viaja como contrato al paquete del cliente.
const agendaV1Defaults = {
  enabled: false,
  pack_version: '1.0.0',
  booking_mode: 'appointment',
  timezone: 'America/Santiago',
  confirmation_mode: 'manual',
  reminder_hours: 24,
  cancellation_policy: 'Las cancelaciones y reprogramaciones se revisan según disponibilidad.',
  locations: [],
  services: [],
  resources: [],
  rules: {
    slot_interval_minutes: 15,
    minimum_notice_hours: 2,
    maximum_advance_days: 60,
    require_customer_phone: true,
    human_handoff_on_conflict: true
  }
};

// Prospección vive en Studio y nunca viaja dentro del paquete del cliente.
// Las verticales son contratos de búsqueda editables, no pantallas separadas.
const prospectingVerticals = {
  agenda: {
    label: 'Agenda y reservas',
    defaultTerms: 'barbería spa centro estética clínica veterinaria taller reservas citas',
    positive: ['barber', 'spa', 'estética', 'estetica', 'clínica', 'clinica', 'dental', 'veterin', 'kinesi', 'peluquer', 'masaje', 'taller', 'reserva', 'cita', 'hora'],
    pitch: 'automatizar consultas y reservas por WhatsApp'
  },
  leads: {
    label: 'Captación de leads',
    defaultTerms: 'inmobiliaria corredora seguros asesoría empresa servicios cotización',
    positive: ['inmobili', 'corredor', 'seguro', 'asesor', 'consult', 'cotiza', 'servicio', 'abogado'],
    pitch: 'responder, calificar y derivar oportunidades comerciales'
  },
  sales: {
    label: 'Ventas conversacionales',
    defaultTerms: 'tienda distribuidora automotora venta por WhatsApp catálogo',
    positive: ['tienda', 'venta', 'automot', 'distribu', 'catálogo', 'catalogo', 'producto', 'cotiza'],
    pitch: 'resolver dudas y acompañar el cierre por WhatsApp'
  },
  support: {
    label: 'Atención y consultas',
    defaultTerms: 'servicio técnico academia institución atención clientes preguntas frecuentes',
    positive: ['servicio', 'academ', 'institu', 'soporte', 'atención', 'atencion', 'técnico', 'tecnico'],
    pitch: 'absorber consultas repetitivas y escalar excepciones'
  },
  custom: {
    label: 'Búsqueda personalizada',
    defaultTerms: '',
    positive: [],
    pitch: 'crear un agente adaptado a su operación'
  }
};

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function canonicalDomain(value = '') {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}

function canonicalPhone(value = '') {
  return String(value).replace(/\D/g, '').replace(/^56(?=9\d{8}$)/, '');
}

function scoreProspect(candidate, verticalKey) {
  const vertical = prospectingVerticals[verticalKey] || prospectingVerticals.custom;
  const haystack = `${candidate.name} ${candidate.category} ${candidate.description}`.toLowerCase();
  const signals = [];
  let score = 18;
  const matches = vertical.positive.filter(term => haystack.includes(term));
  if (matches.length) { score += Math.min(28, 10 + matches.length * 5); signals.push(`Encaje con ${vertical.label.toLowerCase()}`); }
  if (candidate.phone) { score += 14; signals.push('Teléfono disponible'); }
  if (candidate.email) { score += 12; signals.push('Correo visible para enviar propuesta'); }
  if (candidate.whatsapp) { score += 10; signals.push('WhatsApp directo detectado'); }
  if (candidate.instagram || candidate.facebook) { score += 4; signals.push('Redes sociales activas'); }
  if (candidate.website) { score += 8; signals.push('Presencia web verificable'); }
  else { score += 10; signals.push('Sin web visible: alta fricción digital'); }
  if (candidate.rating >= 4) { score += 8; signals.push(`Buena reputación (${candidate.rating})`); }
  if (candidate.reviewCount >= 25) { score += 12; signals.push(`${candidate.reviewCount} reseñas: negocio activo`); }
  if (candidate.reviewCount >= 100) score += 6;
  const bookingPattern = /(calendly|agendapro|booksy|reserv|agenda|booking)/i;
  const hasBooking = bookingPattern.test(`${candidate.website} ${candidate.description}`);
  if (hasBooking) { score -= 8; signals.push('Ya muestra una vía de reserva digital'); }
  else if (verticalKey === 'agenda') { score += 10; signals.push('No se detecta agenda online'); }
  score = Math.max(0, Math.min(100, score));
  return {
    score,
    fit: score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low',
    signals,
    suggestedMessage: `Hola, vi ${candidate.name} y creo que podríamos ayudarles a ${vertical.pitch}. Tenemos una demostración funcional para que puedan probar la experiencia antes de decidir.`
  };
}

// Enriquecimiento de contacto: visita el sitio del negocio y extrae correo, WhatsApp y redes.
// Es el corazón del objetivo comercial: poder enviar info/demo por correo o WhatsApp directo,
// no sólo el teléfono/fijo que entrega Serper. Portado del Radar de HojaCero (ya probado).
async function fetchSiteHtml(url, timeoutMs = 5000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    clearTimeout(timeout);
    if (!response.ok) return '';
    return await response.text();
  } catch { return ''; }
}

function extractEmailsFromHtml(html) {
  const emails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return [...new Set(emails.map(email => email.toLowerCase()))]
    .filter(email => !/(example|wixpress|sentry|\.png|\.jpe?g|\.gif|\.svg|\.webp)/.test(email));
}

async function scrapeBusinessContacts(websiteUrl) {
  const result = { emails: [], whatsapp: null, instagram: null, facebook: null, hasSSL: Boolean(websiteUrl && websiteUrl.startsWith('https')), techStack: [] };
  if (!websiteUrl || !/^https?:\/\//i.test(websiteUrl)) return result;
  const html = await fetchSiteHtml(websiteUrl);
  if (!html) return result;
  result.emails = extractEmailsFromHtml(html).slice(0, 3);
  const waMatch = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\d+)/i.exec(html);
  if (waMatch) result.whatsapp = waMatch[1];
  else {
    const waText = /whatsapp[^0-9]*?(\+?56\s?\d[\d\s-]{7,})/i.exec(html);
    if (waText) result.whatsapp = waText[1].replace(/[\s-]/g, '');
  }
  const ig = /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]+)/i.exec(html);
  if (ig && !['p', 'reel', 'reels', 'explore', 'accounts'].includes(ig[1].toLowerCase())) result.instagram = ig[1];
  const fb = /facebook\.com\/([a-zA-Z0-9.]+)/i.exec(html);
  if (fb && !['sharer', 'share', 'tr', 'plugins', 'dialog'].includes(fb[1].toLowerCase())) result.facebook = fb[1];
  if (/wp-content|wordpress/i.test(html)) result.techStack.push('WordPress');
  if (/cdn\.shopify|shopify/i.test(html)) result.techStack.push('Shopify');
  if (/wix\.com|wixstatic/i.test(html)) result.techStack.push('Wix');
  // Muchos negocios ponen el correo sólo en /contacto: si la home no lo trae, se busca ahí.
  if (!result.emails.length) {
    try {
      const origin = new URL(websiteUrl).origin;
      for (const path of ['/contacto', '/contact', '/contactenos', '/contacto-nosotros']) {
        const extra = await fetchSiteHtml(origin + path, 4000);
        if (extra) {
          const found = extractEmailsFromHtml(extra);
          if (found.length) { result.emails = found.slice(0, 3); break; }
        }
      }
    } catch { /* URL inválida para derivar origin */ }
  }
  return result;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(chunk.map((item, offset) => worker(item, i + offset)));
    settled.forEach((entry, offset) => { results[i + offset] = entry.status === 'fulfilled' ? entry.value : null; });
  }
  return results;
}

function normalizeAgendaConfig(input = {}) {
  const asList = (value) => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  const rules = input.rules && typeof input.rules === 'object' ? input.rules : {};
  return {
    enabled: Boolean(input.enabled),
    pack_version: '1.0.0',
    booking_mode: ['appointment', 'reservation'].includes(input.booking_mode) ? input.booking_mode : 'appointment',
    timezone: typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : 'America/Santiago',
    confirmation_mode: ['automatic', 'manual'].includes(input.confirmation_mode) ? input.confirmation_mode : 'manual',
    reminder_hours: number(input.reminder_hours, 24, 0, 168),
    cancellation_policy: typeof input.cancellation_policy === 'string' ? input.cancellation_policy.trim().slice(0, 1000) : agendaV1Defaults.cancellation_policy,
    locations: asList(input.locations),
    services: asList(input.services),
    resources: asList(input.resources),
    rules: {
      slot_interval_minutes: number(rules.slot_interval_minutes, 15, 5, 60),
      minimum_notice_hours: number(rules.minimum_notice_hours, 2, 0, 168),
      maximum_advance_days: number(rules.maximum_advance_days, 60, 1, 730),
      require_customer_phone: rules.require_customer_phone !== false,
      human_handoff_on_conflict: rules.human_handoff_on_conflict !== false
    }
  };
}

function getToneProfile(tone) {
  return toneProfiles[tone] || toneProfiles.friendly;
}

const modelRates = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'llama-3.3-70b-versatile': { input: 0, output: 0 }
};

function estimateUsageUsd(model, inputTokens = 0, outputTokens = 0) {
  const rate = modelRates[model];
  if (!rate) return 0;
  return (Number(inputTokens) * rate.input + Number(outputTokens) * rate.output) / 1_000_000;
}

async function getAiBudgetOverview(clientId) {
  const config = await db.get('SELECT * FROM ai_budget_configs WHERE client_id = ?', [clientId]);
  const current = config || {
    client_id: clientId, provider: 'openai', model: 'gpt-4o-mini', cycle_budget_clp: 20000,
    usd_clp: 922, alert_50: 1, alert_75: 1, alert_90: 1, cycle_started_at: new Date().toISOString(), paused: 0
  };
  const spent = await db.get(`SELECT COALESCE(SUM(estimated_cost_usd), 0) AS usd, COALESCE(SUM(input_tokens), 0) AS input_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens, COUNT(*) AS requests
    FROM ai_usage_records WHERE client_id = ? AND occurred_at >= ?`, [clientId, current.cycle_started_at]);
  const spentClp = Number(spent.usd) * Number(current.usd_clp);
  const budget = Number(current.cycle_budget_clp);
  const percent = budget > 0 ? (spentClp / budget) * 100 : 0;
  const alertLevel = percent >= 100 ? 'exhausted' : percent >= 90 ? '90' : percent >= 75 ? '75' : percent >= 50 ? '50' : 'ok';
  return { config: current, usage: { ...spent, spent_clp: spentClp, available_clp: Math.max(0, budget - spentClp), percent, alert_level: alertLevel } };
}

const app = express();
const PORT = 8080;
const studioOrigins = new Set(['http://localhost:8080', 'http://127.0.0.1:8080']);

app.use(cors({ origin: [...studioOrigins] }));
app.use(express.json({ limit: '25mb' }));
// Studio vive sólo en localhost, pero eso no evita que otra pestaña intente
// disparar mutaciones contra él. Las peticiones de scripts locales sin Origin
// siguen permitidas; cualquier navegador debe provenir del propio Studio.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !studioOrigins.has(origin)) return res.status(403).json({ error: 'Origen no autorizado.' });
  next();
});

// Experiencia comercial: una landing pública y el mismo panel real en modo
// seguro. No existe una segunda maqueta que pueda divergir del producto.
app.get('/demo', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'commercial-demo.html'));
});
app.get('/demo/panel', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(runtimeTemplateRoot, 'public', 'agenda.html'));
});
app.get('/demo/onboarding', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'onboarding.html'));
});
// El enlace que se genera desde el Studio es una entrevista real, no la demo
// comercial. Debe quedar disponible en el mismo origen que sus APIs locales.
app.get('/onboarding.html', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'onboarding.html'));
});
app.post('/api/commercial/leads', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const business = String(req.body?.business || '').trim();
  const contact = String(req.body?.contact || '').trim();
  if (!name || !business || !contact || name.length > 120 || business.length > 160 || contact.length > 200) {
    return res.status(400).json({ error: 'Completa los tres datos para poder contactarte.' });
  }
  await db.run('INSERT INTO commercial_leads (id, name, business, contact, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [randomUUID(), name, business, contact, 'booking_demo', new Date().toISOString()]);
  res.status(201).json({ ok: true });
});

// Preview local del panel que recibe el cliente. Comparte el puerto del Studio
// para poder revisar el producto sin abrir otro proceso ni requerir Supabase.
// El query ?demo=1 activa únicamente datos ficticios de presentación.
app.get('/preview/agenda-cliente', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(runtimeTemplateRoot, 'public', 'agenda.html'));
});
app.get('/playground', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(runtimeTemplateRoot, 'public', 'index.html'));
});
app.get('/client-console.css', (req, res) => res.sendFile(path.join(runtimeTemplateRoot, 'public', 'client-console.css')));
app.get('/client-console-layout.css', (req, res) => res.sendFile(path.join(runtimeTemplateRoot, 'public', 'client-console-layout.css')));
app.get('/client-console-tour.css', (req, res) => res.sendFile(path.join(runtimeTemplateRoot, 'public', 'client-console-tour.css')));
app.get('/client-console-v2.js', (req, res) => res.sendFile(path.join(runtimeTemplateRoot, 'public', 'client-console-v2.js')));

// Servir archivos estáticos del dashboard (HTML, CSS, JS)
const studioPublicFiles = new Set([
  'style.css', 'studio-redesign.css', 'prospecting.css',
  'app.js', 'llm-helper.js', 'studio-redesign.js', 'prospecting.js',
  'commercial-demo.css', 'commercial-demo-forms.css', 'commercial-demo-onboarding.css', 'commercial-demo.js',
  'onboarding.css', 'onboarding.js'
]);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:publicFile', (req, res, next) => {
  if (!studioPublicFiles.has(req.params.publicFile)) return next();
  return res.sendFile(path.join(__dirname, req.params.publicFile));
});
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny', index: false }));

// ==========================================
// CONFIGURACIÓN DE BASE DE DATOS SQLITE
// ==========================================
let db;

async function ensureColumn(table, column, definition) {
  const columns = await db.all(`PRAGMA table_info(${table});`);
  if (!columns.some(item => item.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

async function clientExists(clientId) {
  return Boolean(await db.get('SELECT id FROM clients WHERE id = ?', [clientId]));
}

async function writeAudit(action, entityType, entityId, details = {}) {
  await db.run(`
    INSERT INTO audit_events (action, entity_type, entity_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `, [action, entityType, entityId, JSON.stringify(details), new Date().toISOString()]);
}

async function createDataSnapshot(reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tables = [
    'clients', 'audit_events', 'source_files', 'intake_jobs', 'agent_versions',
    'documents', 'knowledge_items', 'agent_tests', 'chats', 'conversation_feedback',
    'ai_budget_configs', 'ai_usage_records', 'ai_budget_events', 'client_infrastructure',
    'agenda_configs', 'onboarding_sessions', 'onboarding_responses', 'onboarding_files',
    'commercial_leads', 'prospecting_searches', 'prospects', 'prospect_activities'
  ];
  const snapshot = {
    snapshot_version: 2,
    created_at: new Date().toISOString(),
    reason,
    tables: Object.fromEntries(await Promise.all(tables.map(async table => [table, await db.all(`SELECT * FROM ${table}`)])))
  };
  const filePath = path.join(backupRoot, `${stamp}-${safeFileName(reason)}.json`);
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  return filePath;
}

async function buildClientRuntime(clientId, version, packageData, target) {
  // Un build es inmutable: nunca borres una preview que un cliente pueda estar usando.
  const buildId = `${safeFileName(version)}-build-${Date.now()}`;
  const outputDir = path.join(runtimeBuildRoot, safeFileName(clientId), buildId);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.cp(runtimeTemplateRoot, outputDir, { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(__dirname, 'onboarding.html'), path.join(outputDir, 'public', 'onboarding.html')),
    fs.copyFile(path.join(__dirname, 'onboarding.css'), path.join(outputDir, 'public', 'onboarding.css')),
    fs.copyFile(path.join(__dirname, 'onboarding.js'), path.join(outputDir, 'public', 'onboarding.js'))
  ]);
  await fs.writeFile(path.join(outputDir, 'agent-package.json'), JSON.stringify(packageData, null, 2), 'utf8');
  await fs.writeFile(path.join(outputDir, 'BUILD.json'), JSON.stringify({
    built_at: new Date().toISOString(), client_id: clientId, package_version: version,
      runtime: runtimeVersion, target, credentials: 'not included'
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(outputDir, 'INSTALLATION.json'), JSON.stringify({
    schema_version: 1,
    client_id: clientId,
    package_version: version,
    target,
    generated_at: new Date().toISOString(),
    ownership: 'customer_owned_infrastructure',
    deployment_stages: ['preview_local', 'staging', 'production'],
    required_environment: [
      'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
      'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_BASE_URL',
      'ZAVUDEV_API_KEY', 'ZAVUDEV_SENDER_ID', 'ZAVUDEV_WEBHOOK_SECRET',
      'ONBOARDING_ACCESS_TOKEN', 'DASHBOARD_ACCESS_KEY', 'PREVIEW_ACCESS_KEY'
    ],
    agenda: packageData.solutions?.agenda ? {
      enabled: true,
      migration: 'supabase/agenda-v1.sql',
      client_console: '/agenda',
      public_booking: '/reservar',
      private_onboarding: '/onboarding?token=<ONBOARDING_ACCESS_TOKEN>',
      feedback_source: 'customer_supabase.za_feedback_items',
      maintenance: 'ZeroAgent Studio uses the local vault only after explicit client authorization.'
    } : { enabled: false },
    verification: [
      'npm test', 'GET /health', 'create and cancel a staging booking',
      'verify Zavu webhook signature and outbound reply', 'approve production version'
    ]
  }, null, 2), 'utf8');
  return outputDir;
}

async function getInstallationPreflight(clientId, target = 'preview') {
  const client = await db.get('SELECT * FROM clients WHERE id = ?', [clientId]);
  if (!client) return null;
  const [facts, documents, tests, approvedSources, pendingJobs] = await Promise.all([
    db.get("SELECT COUNT(*) AS count FROM knowledge_items WHERE client_id = ? AND status = 'approved'", [clientId]),
    db.get('SELECT COUNT(*) AS count FROM documents WHERE client_id = ?', [clientId]),
    db.get("SELECT COUNT(*) AS count FROM agent_tests WHERE client_id = ? AND status = 'active'", [clientId]),
    db.get("SELECT COUNT(*) AS count FROM source_files WHERE client_id = ? AND status = 'approved'", [clientId]),
    db.get("SELECT COUNT(*) AS count FROM intake_jobs WHERE client_id = ? AND status IN ('pending_ide', 'under_review')", [clientId])
  ]);
  const agendaRecord = await db.get('SELECT config_json FROM agenda_configs WHERE client_id = ?', [clientId]);
  const infrastructure = await db.get('SELECT supabase_url, connection_status, last_checked_at FROM client_infrastructure WHERE client_id = ?', [clientId]);
  let agenda = { ...agendaV1Defaults };
  if (agendaRecord?.config_json) {
    try { agenda = normalizeAgendaConfig(JSON.parse(agendaRecord.config_json)); } catch { /* base segura */ }
  }
  const blockers = [];
  const warnings = [];
  if (!client.agent_name || !client.agent_role || !client.agent_system_prompt) blockers.push('Falta completar la identidad y directivas del agente.');
  if (!facts.count && !documents.count) blockers.push('Falta al menos un dato confirmado o documento de conocimiento.');
  if (!tests.count) blockers.push('Falta al menos una prueba de regresión activa.');
  if (!approvedSources.count) {
    if (target === 'production') blockers.push('Producción requiere al menos una fuente original aprobada y trazable.');
    else warnings.push('No hay fuente original aprobada; los datos manuales deben quedar respaldados por una fuente.');
  }
  if (pendingJobs.count) {
    if (target === 'production') blockers.push(`Producción está bloqueada por ${pendingJobs.count} tarea(s) pendiente(s) o en revisión.`);
    else warnings.push(`Hay ${pendingJobs.count} tarea(s) pendiente(s) o en revisión.`);
  }
  if (agenda.enabled) {
    if (!agenda.services.length) blockers.push('Agenda v1 está activa pero no tiene servicios configurados.');
    if (!agenda.resources.length) blockers.push('Agenda v1 está activa pero no tiene profesionales o recursos configurados.');
    if (!agenda.locations.length) warnings.push('Agenda v1 no tiene sede; el paquete usará una agenda sin ubicación explícita.');
    if (!agenda.rules?.slot_interval_minutes) blockers.push('Agenda v1 no tiene intervalo de bloques válido.');
    warnings.push('Antes de producción, ejecuta supabase/agenda-v1.sql en el Supabase del cliente y completa los horarios semanales desde el dashboard cliente.');
    if (target !== 'preview') {
      if (!infrastructure?.supabase_url || !(await localVault.exists(clientId))) blockers.push('Agenda v1 en staging/producción requiere Supabase del cliente configurado en el vault local.');
      if (infrastructure?.connection_status !== 'connected') blockers.push('La conexión Supabase del cliente debe estar verificada antes de staging/producción.');
      const lastCheck = Date.parse(infrastructure?.last_checked_at || '');
      if (!Number.isFinite(lastCheck) || Date.now() - lastCheck > 24 * 60 * 60 * 1000) blockers.push('La verificación de Supabase venció; vuelve a comprobar la conexión antes de construir este entorno.');
    }
  }
  if (!['preview', 'staging', 'production'].includes(target)) blockers.push('Objetivo de instalación inválido.');
  return { target, ready: blockers.length === 0, blockers, warnings, counts: { facts: facts.count, documents: documents.count, tests: tests.count, approvedSources: approvedSources.count, pendingJobs: pendingJobs.count, agendaServices: agenda.services.length, agendaResources: agenda.resources.length }, agenda: { enabled: agenda.enabled, packVersion: agenda.pack_version }, infrastructure: { configured: Boolean(infrastructure?.supabase_url), connected: infrastructure?.connection_status === 'connected', lastCheckedAt: infrastructure?.last_checked_at || null } };
}

function safeFileName(fileName = 'source') {
  return path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'source';
}

function decodeBase64File(fileData) {
  if (!fileData) return null;
  const base64 = fileData.includes(',') ? fileData.split(',').pop() : fileData;
  return Buffer.from(base64, 'base64');
}

function buildGapQuestions(niche = '', knowledgeItems = []) {
  const known = knowledgeItems.map(item => `${item.category} ${item.subject} ${item.value}`.toLowerCase()).join(' ');
  const has = (...terms) => terms.some(term => known.includes(term));
  const questions = [];
  const addIfMissing = (key, question, priority = 'important') => {
    if (!has(key)) questions.push({ key, question, priority });
  };

  addIfMissing(['horario', 'hora'], '¿Cuáles son los horarios de atención y existen excepciones por sucursal o día?', 'critical');
  addIfMissing(['sucursal', 'dirección', 'direccion'], '¿Qué sucursales atienden, cuál es la dirección de cada una y qué servicios tiene cada sede?', 'critical');
  addIfMissing(['precio', 'tarifa', 'valor', '$', 'uf'], '¿Qué precios o rangos se pueden informar, desde cuándo rigen y qué condiciones los cambian?', 'critical');
  addIfMissing(['pago', 'transferencia', 'tarjeta', 'factura'], '¿Qué medios de pago, facturación, anticipos o links de pago están permitidos?', 'important');
  addIfMissing(['derivar', 'humano', 'ejecutivo', 'contacto'], '¿En qué casos el agente debe derivar a una persona y a quién debe avisar?', 'critical');

  const nicheLower = niche.toLowerCase();
  if (/(restaurante|comida|caf[eé]|delivery|gastronom)/.test(nicheLower)) {
    addIfMissing(['reparto', 'delivery', 'despacho'], '¿Tienen reparto, qué zonas cubren, cuánto cuesta y cuánto demora?', 'critical');
    addIfMissing(['alergen', 'alérgen', 'vegano', 'vegetar'], '¿Qué alérgenos, alternativas alimentarias o advertencias se deben comunicar?', 'important');
  } else if (/(cl[ií]nic|salud|m[eé]dic|dental|consulta)/.test(nicheLower)) {
    addIfMissing(['preparación', 'preparacion', 'ayuno'], '¿Qué preparación, contraindicaciones o advertencias deben informarse antes de una atención?', 'critical');
    addIfMissing(['convenio', 'isapre', 'fonasa'], '¿Qué convenios o coberturas se pueden informar y cuáles deben confirmarse?', 'important');
  } else if (/(servicio|consultor|ingenier|industrial|legal|profesional)/.test(nicheLower)) {
    addIfMissing(['cotización', 'cotizacion', 'presupuesto'], '¿Qué antecedentes mínimos debe recopilar el agente para preparar una cotización?', 'critical');
    addIfMissing(['agenda', 'reunión', 'reunion'], '¿Cómo se agenda una reunión y qué disponibilidad debe ofrecer?', 'important');
  }
  return questions;
}

async function initDatabase() {
  db = await open({
    filename: path.join(__dirname, 'database.sqlite'),
    driver: sqlite3.Database
  });

  // Habilitar claves foráneas
  await db.run('PRAGMA foreign_keys = ON;');
  await db.run('PRAGMA journal_mode = WAL;');
  await db.run('PRAGMA busy_timeout = 5000;');
  await fs.mkdir(storageRoot, { recursive: true });
  await fs.mkdir(ideInboxRoot, { recursive: true });
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.mkdir(runtimeBuildRoot, { recursive: true });
  await fs.mkdir(vaultRoot, { recursive: true });
  await fs.mkdir(onboardingRoot, { recursive: true });

  // Crear Tabla de Clientes
  await db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      niche TEXT NOT NULL,
      desc TEXT,
      agent_name TEXT,
      agent_tone TEXT,
      agent_avatar_color TEXT,
      agent_role TEXT,
      agent_whatsapp TEXT,
      agent_system_prompt TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);

  // Migración liviana de la maqueta actual hacia un Studio de proyectos.
  await ensureColumn('clients', 'project_stage', "TEXT NOT NULL DEFAULT 'intake'");
  await ensureColumn('clients', 'project_notes', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('clients', 'next_action', "TEXT NOT NULL DEFAULT ''");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS source_files (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      original_name TEXT,
      storage_path TEXT,
      mime_type TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending_ide',
      version_number INTEGER NOT NULL DEFAULT 1,
      replaces_source_id TEXT,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY(replaces_source_id) REFERENCES source_files(id) ON DELETE SET NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS intake_jobs (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_ide',
      instructions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY(source_id) REFERENCES source_files(id) ON DELETE CASCADE
    );
  `);

  await ensureColumn('intake_jobs', 'workspace_path', 'TEXT');
  await ensureColumn('intake_jobs', 'proposal_json', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('intake_jobs', 'error_message', "TEXT NOT NULL DEFAULT ''");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      summary TEXT NOT NULL DEFAULT '',
      package_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      approved_at TEXT,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE,
      UNIQUE(client_id, version)
    );
  `);

  // Crear Tabla de Documentos
  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
  `);

  // Conocimiento atómico y comprobable. A diferencia de un documento libre,
  // cada afirmación puede rastrearse a una fuente y pasar por aprobación.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      source_id TEXT,
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved',
      notes TEXT NOT NULL DEFAULT '',
      confirmed_at TEXT NOT NULL,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY(source_id) REFERENCES source_files(id) ON DELETE SET NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tests (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      knowledge_item_id TEXT,
      question TEXT NOT NULL,
      expected_behavior TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_result TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY(knowledge_item_id) REFERENCES knowledge_items(id) ON DELETE SET NULL
    );
  `);

  // Crear Tabla de Chats
  await db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      time TEXT NOT NULL,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_feedback (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      rating TEXT NOT NULL,
      correction_text TEXT NOT NULL DEFAULT '',
      source_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
      FOREIGN KEY(source_id) REFERENCES source_files(id) ON DELETE SET NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ai_budget_configs (
      client_id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'openai', model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
      cycle_budget_clp REAL NOT NULL DEFAULT 20000, usd_clp REAL NOT NULL DEFAULT 922,
      alert_50 INTEGER NOT NULL DEFAULT 1, alert_75 INTEGER NOT NULL DEFAULT 1, alert_90 INTEGER NOT NULL DEFAULT 1,
      cycle_started_at TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ai_usage_records (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, occurred_at TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
      conversation_ref TEXT, source TEXT NOT NULL DEFAULT 'runtime', FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ai_budget_events (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, kind TEXT NOT NULL, amount_clp REAL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS client_infrastructure (
      client_id TEXT PRIMARY KEY, supabase_url TEXT NOT NULL DEFAULT '', project_ref TEXT NOT NULL DEFAULT '',
      credential_alias TEXT NOT NULL DEFAULT '', credential_hint TEXT NOT NULL DEFAULT '',
      connection_status TEXT NOT NULL DEFAULT 'not_configured', last_checked_at TEXT, updated_at TEXT NOT NULL,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS agenda_configs (
      client_id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_sessions (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'sent',
      current_step INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      submitted_at TEXT,
      approved_at TEXT,
      FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS onboarding_client_idx ON onboarding_sessions(client_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS onboarding_responses (
      session_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, step_key),
      FOREIGN KEY(session_id) REFERENCES onboarding_sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS onboarding_files (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES onboarding_sessions(id) ON DELETE CASCADE
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS commercial_leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      business TEXT NOT NULL,
      contact TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'booking_demo',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS commercial_leads_created_idx ON commercial_leads(created_at DESC);
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS prospecting_searches (
      id TEXT PRIMARY KEY,
      vertical TEXT NOT NULL,
      location TEXT NOT NULL,
      terms TEXT NOT NULL,
      coverage TEXT NOT NULL DEFAULT 'comuna',
      status TEXT NOT NULL DEFAULT 'completed',
      result_count INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'serper',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prospecting_searches_created_idx ON prospecting_searches(created_at DESC);

    CREATE TABLE IF NOT EXISTS prospects (
      id TEXT PRIMARY KEY,
      search_id TEXT,
      name TEXT NOT NULL,
      vertical TEXT NOT NULL DEFAULT 'agenda',
      category TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      phone_key TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      whatsapp TEXT NOT NULL DEFAULT '',
      instagram TEXT NOT NULL DEFAULT '',
      facebook TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      source_url TEXT NOT NULL DEFAULT '',
      rating REAL,
      review_count INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      fit TEXT NOT NULL DEFAULT 'low',
      signals_json TEXT NOT NULL DEFAULT '[]',
      suggested_message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      notes TEXT NOT NULL DEFAULT '',
      next_action_at TEXT,
      last_contacted_at TEXT,
      last_contact_channel TEXT NOT NULL DEFAULT '',
      converted_client_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(search_id) REFERENCES prospecting_searches(id) ON DELETE SET NULL,
      FOREIGN KEY(converted_client_id) REFERENCES clients(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS prospects_status_idx ON prospects(status, score DESC);
    CREATE INDEX IF NOT EXISTS prospects_domain_idx ON prospects(domain);
    CREATE INDEX IF NOT EXISTS prospects_phone_idx ON prospects(phone_key);

    CREATE TABLE IF NOT EXISTS prospect_activities (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(prospect_id) REFERENCES prospects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS prospect_activities_idx ON prospect_activities(prospect_id, created_at DESC);
  `);

  // Migración idempotente: agrega columnas de contacto/trazabilidad a bases ya existentes.
  for (const column of ['whatsapp', 'instagram', 'facebook', 'last_contact_channel']) {
    try { await db.exec(`ALTER TABLE prospects ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`); } catch { /* ya existe */ }
  }
  try { await db.exec('ALTER TABLE prospects ADD COLUMN last_contacted_at TEXT'); } catch { /* ya existe */ }

  await seedDatabase();
}

// Seeding de datos iniciales si la base de datos está vacía
async function seedDatabase() {
  const clientsCount = await db.get('SELECT COUNT(*) as count FROM clients');
  if (clientsCount.count === 0) {
    console.log('Sembrando base de datos inicial con clientes demo...');

    // Cliente 1: Delicias R&S
    await db.run(`
      INSERT INTO clients (id, name, niche, desc, agent_name, agent_tone, agent_avatar_color, agent_role, agent_whatsapp, agent_system_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'delicias-rys', 'Delicias R&S', 'Repostería & Comida Casera',
      'Negocio local que elabora y distribuye empanadas gourmet, pasteles y menús diarios a domicilio.',
      'Tomás de Delicias R&S', 'friendly', 'emerald',
      'Atención al cliente y toma de pedidos de empanadas y almuerzos.', '+56 9 8877 6655',
      `Eres "Tomás", el asistente de WhatsApp de "Delicias R&S". 
Tu labor es ser muy simpático, cálido y responder a las consultas de los clientes con entusiasmo.
Reglas:
1. Sé breve y usa emojis (como 🥐, 🥧, 😊).
2. Ofrece las empanadas de pino y queso que son la especialidad de la casa.
3. Si el cliente quiere agendar, pídele su nombre, dirección y su pedido exacto.
4. Consulta tus documentos de entrenamiento para ver precios y horarios actualizados. ¡No inventes datos!`
    ]);

    await db.run(`
      INSERT INTO documents (id, client_id, title, category, content)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'doc-1', 'delicias-rys', 'Menú de Empanadas & Almuerzos', 'prices',
      `Nuestras Empanadas:
- Empanada de Pino Horno (Vacuno): $2.500 c/u.
- Empanada de Queso Frita: $1.800 c/u.
- Empanada de Pollo Mandarina (Especialidad): $2.800 c/u.

Menú del Día (Almuerzo):
- Entrada + Plato de Fondo (Casero) + Postre: $4.500.
* El menú varía diariamente. Consúltalo a partir de las 11:30 AM.`
    ]);

    await db.run(`
      INSERT INTO documents (id, client_id, title, category, content)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'doc-2', 'delicias-rys', 'Políticas de Delivery y Despacho', 'policies',
      `Zonas de Despacho y Precios:
- Comuna de Santiago Centro: Despacho gratis por compras superiores a $10.000. Si es menos, costo fijo de $1.500.
- Comunas aledañas (Providencia, Ñuñoa): Costo fijo de despacho $2.500.

Horarios de Reparto:
- Lunes a Sábado: 12:30 PM a 4:30 PM y de 7:00 PM a 10:00 PM.
- Domingos: Cerrado.`
    ]);

    await db.run(`
      INSERT INTO chats (client_id, sender, text, time)
      VALUES (?, ?, ?, ?)
    `, [
      'delicias-rys', 'agent',
      '¡Hola! Bienvenido a Delicias R&S. 🥧 Soy Tomás, tu asistente virtual. ¿Te gustaría ordenar algunas empanadas hoy o saber nuestro menú del día?',
      '12:00'
    ]);

    // Cliente 2: Valprocess
    await db.run(`
      INSERT INTO clients (id, name, niche, desc, agent_name, agent_tone, agent_avatar_color, agent_role, agent_whatsapp, agent_system_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'valprocess', 'Valprocess', 'Consultoría de Procesos Industriales',
      'Empresa de ingeniería dedicada a optimizar flujos de trabajo, automatización de maquinarias y control de calidad.',
      'Ingeniero Asistente Valprocess', 'professional', 'blue',
      'Atención técnica a clientes industriales y agendamiento de reuniones de consultoría.', '+56 2 2455 9900',
      `Actúa como el Ingeniero Asistente Virtual de Valprocess.
Tu tono debe ser sumamente profesional, técnico, educado y corporativo.
Reglas:
1. Responde de manera formal y precisa, utilizando terminología adecuada de ingeniería.
2. Evita el uso de emojis excepto en casos muy puntuales.
3. El objetivo es recopilar el nombre de la empresa del cliente, su problema técnico principal, y agendar una llamada de diagnóstico de 15 minutos con nuestros ingenieros consultores.`
    ]);

    await db.run(`
      INSERT INTO documents (id, client_id, title, category, content)
      VALUES (?, ?, ?, ?, ?)
    `, [
      'val-doc-1', 'valprocess', 'Servicios de Automatización y Consultoría', 'about',
      `Nuestros Servicios Principales:
1. Auditoría de Procesos: Análisis completo de la línea de producción (Valor: Desde UF 50).
2. Automatización SCADA/PLC: Diseño e implementación de sistemas de control industrial.
3. Capacitación de Personal: Cursos de seguridad industrial y eficiencia operativa.`
    ]);

    await db.run(`
      INSERT INTO chats (client_id, sender, text, time)
      VALUES (?, ?, ?, ?)
    `, [
      'valprocess', 'agent',
      'Estimado cliente, gracias por contactar a Valprocess. ¿En qué área de automatización o consultoría industrial requiere asistencia técnica hoy?',
      '10:30'
    ]);
  }
}

// ==========================================
// ENDPOINTS DE LA API REST
// ==========================================

async function upsertProspect(candidate, searchId, vertical, location) {
  const domain = canonicalDomain(candidate.website);
  const phoneKey = canonicalPhone(candidate.phone);
  const nameKey = cleanText(candidate.name, 180).toLowerCase();
  // Contacto enriquecido (correo/WhatsApp/redes). Se fija en el candidato antes de puntuar
  // para que el score premie la contactabilidad, que es el objetivo comercial de la búsqueda.
  const email = cleanText((candidate.emails && candidate.emails[0]) || candidate.email || '', 160).toLowerCase();
  const whatsapp = String(candidate.whatsapp || '').replace(/\D/g, '');
  const instagram = cleanText(candidate.instagram || '', 120);
  const facebook = cleanText(candidate.facebook || '', 160);
  candidate.email = email;
  candidate.whatsapp = whatsapp || null;
  candidate.instagram = instagram || null;
  candidate.facebook = facebook || null;
  let existing = null;
  if (domain) existing = await db.get('SELECT id FROM prospects WHERE domain = ? LIMIT 1', [domain]);
  if (!existing && phoneKey) existing = await db.get('SELECT id FROM prospects WHERE phone_key = ? LIMIT 1', [phoneKey]);
  if (!existing) existing = await db.get('SELECT id FROM prospects WHERE lower(name) = ? AND lower(location) = lower(?) LIMIT 1', [nameKey, location]);

  const evaluation = scoreProspect(candidate, vertical);
  const now = new Date().toISOString();
  if (existing) {
    await db.run(`UPDATE prospects SET search_id = ?, vertical = ?, category = ?, location = ?, address = ?, website = ?, domain = ?,
      phone = ?, phone_key = ?, email = ?, whatsapp = ?, instagram = ?, facebook = ?, source = ?, source_url = ?, rating = ?, review_count = ?,
      score = ?, fit = ?, signals_json = ?, suggested_message = ?, updated_at = ? WHERE id = ?`, [
      searchId, vertical, candidate.category, location, candidate.address, candidate.website, domain,
      candidate.phone, phoneKey, email, whatsapp, instagram, facebook, candidate.source, candidate.sourceUrl, candidate.rating, candidate.reviewCount,
      evaluation.score, evaluation.fit, JSON.stringify(evaluation.signals), evaluation.suggestedMessage, now, existing.id
    ]);
    return { id: existing.id, created: false, email: Boolean(email), whatsapp: Boolean(whatsapp) };
  }

  const id = randomUUID();
  await db.run(`INSERT INTO prospects (id, search_id, name, vertical, category, location, address, website, domain, phone, phone_key,
    email, whatsapp, instagram, facebook, source, source_url, rating, review_count, score, fit, signals_json, suggested_message, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`, [
    id, searchId, cleanText(candidate.name, 180) || 'Negocio sin nombre', vertical, cleanText(candidate.category, 160), location,
    cleanText(candidate.address, 300), cleanText(candidate.website, 500), domain, cleanText(candidate.phone, 80), phoneKey,
    email, whatsapp, instagram, facebook,
    candidate.source, cleanText(candidate.sourceUrl, 500), candidate.rating || null, Number(candidate.reviewCount) || 0,
    evaluation.score, evaluation.fit, JSON.stringify(evaluation.signals), evaluation.suggestedMessage, now, now
  ]);
  await db.run('INSERT INTO prospect_activities (id, prospect_id, kind, summary, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [randomUUID(), id, 'discovered', `Encontrado mediante ${candidate.source}.`, JSON.stringify({ search_id: searchId }), now]);
  return { id, created: true, email: Boolean(email), whatsapp: Boolean(whatsapp) };
}

app.get('/api/prospecting/verticals', (req, res) => {
  res.json(Object.entries(prospectingVerticals).map(([id, item]) => ({ id, label: item.label, defaultTerms: item.defaultTerms })));
});

app.get('/api/prospecting/overview', async (req, res) => {
  try {
    const vertical = cleanText(req.query.vertical, 40);
    const status = cleanText(req.query.status, 40);
    const search = cleanText(req.query.search, 120).toLowerCase();
    const clauses = [];
    const params = [];
    if (vertical && vertical !== 'all') { clauses.push('p.vertical = ?'); params.push(vertical); }
    if (status && status !== 'all') { clauses.push('p.status = ?'); params.push(status); }
    if (search) { clauses.push('(lower(p.name) LIKE ? OR lower(p.category) LIKE ? OR lower(p.location) LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const prospects = await db.all(`SELECT p.* FROM prospects p ${where} ORDER BY
      CASE p.status WHEN 'qualified' THEN 0 WHEN 'replied' THEN 1 WHEN 'contacted' THEN 2 WHEN 'shortlisted' THEN 3 ELSE 4 END,
      p.score DESC, p.updated_at DESC LIMIT 300`, params);
    const activities = prospects.length ? await db.all(`SELECT * FROM prospect_activities WHERE prospect_id IN (${prospects.map(() => '?').join(',')}) ORDER BY created_at DESC`, prospects.map(item => item.id)) : [];
    const statsRows = await db.all('SELECT status, COUNT(*) AS count FROM prospects GROUP BY status');
    const stats = Object.fromEntries(statsRows.map(row => [row.status, row.count]));
    res.json({
      prospects: prospects.map(item => ({ ...item, signals: JSON.parse(item.signals_json || '[]'), activities: activities.filter(activity => activity.prospect_id === item.id) })),
      stats: { total: statsRows.reduce((sum, row) => sum + row.count, 0), ...stats },
      configured: Boolean(process.env.SERPER_API_KEY)
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/prospecting/search', async (req, res) => {
  try {
    const vertical = prospectingVerticals[req.body?.vertical] ? req.body.vertical : 'custom';
    const location = cleanText(req.body?.location, 120);
    const terms = cleanText(req.body?.terms || prospectingVerticals[vertical].defaultTerms, 240);
    const coverage = ['barrio', 'comuna', 'ciudad', 'region'].includes(req.body?.coverage) ? req.body.coverage : 'comuna';
    if (!location || !terms) return res.status(400).json({ error: 'Indica ubicación y qué negocios quieres encontrar.' });
    if (!process.env.SERPER_API_KEY) return res.status(409).json({ error: 'La búsqueda real está lista, pero falta SERPER_API_KEY en el servidor local.', code: 'provider_not_configured' });

    const searchId = randomUUID();
    const createdAt = new Date().toISOString();
    // La cobertura cambia la amplitud geográfica real de la consulta, no es sólo un rótulo.
    const coverageQuery = {
      barrio: `${terms} cerca de ${location}`,
      comuna: `${terms} en ${location}`,
      ciudad: `${terms} en ${location} y alrededores`,
      region: `${terms} en la región de ${location}`
    };
    const query = coverageQuery[coverage] || `${terms} en ${location}`;
    const response = await fetch('https://google.serper.dev/places', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'cl', hl: 'es', num: 20 })
    });
    if (!response.ok) throw new Error(`Serper respondió ${response.status}.`);
    const payload = await response.json();
    const places = Array.isArray(payload.places) ? payload.places : [];
    await db.run('INSERT INTO prospecting_searches (id, vertical, location, terms, coverage, result_count, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [searchId, vertical, location, terms, coverage, places.length, 'serper_places', createdAt]);
    // Enriquecimiento en paralelo (máx 4 sitios a la vez) para extraer correo/WhatsApp/redes
    // sin disparar la latencia total de la búsqueda.
    const contacts = await mapWithConcurrency(places, 4, place => scrapeBusinessContacts(place.website));
    const imported = [];
    for (let index = 0; index < places.length; index++) {
      const place = places[index];
      const scraped = contacts[index] || { emails: [], whatsapp: null, instagram: null, facebook: null };
      imported.push(await upsertProspect({
        name: place.title, category: place.type || '', description: place.snippet || '', address: place.address || '',
        website: place.website || '', phone: place.phoneNumber || '', rating: Number(place.rating) || null,
        reviewCount: Number(place.ratingCount || place.reviews) || 0, source: 'serper_places', sourceUrl: place.cid ? `https://www.google.com/maps?cid=${place.cid}` : '',
        emails: scraped.emails, whatsapp: scraped.whatsapp, instagram: scraped.instagram, facebook: scraped.facebook
      }, searchId, vertical, location));
    }
    res.status(201).json({
      search_id: searchId, found: places.length,
      created: imported.filter(item => item.created).length,
      with_email: imported.filter(item => item.email).length,
      with_whatsapp: imported.filter(item => item.whatsapp).length
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/prospecting/demo', async (req, res) => {
  try {
    const existing = await db.get("SELECT COUNT(*) AS count FROM prospects WHERE source = 'demo'");
    if (!existing.count) {
      const searchId = randomUUID();
      const now = new Date().toISOString();
      await db.run('INSERT INTO prospecting_searches (id, vertical, location, terms, coverage, result_count, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [searchId, 'agenda', 'Ñuñoa y Providencia', 'negocios con atención por hora', 'comuna', 5, 'demo', now]);
      const demo = [
        { name:'Marea Studio', category:'Centro de estética', address:'Av. Irarrázaval 2840, Ñuñoa', website:'https://mareastudio.example', phone:'+56 9 6111 2084', rating:4.8, reviewCount:186, emails:['hola@mareastudio.cl'], whatsapp:'56961112084', instagram:'mareastudio' },
        { name:'Clínica Veterinaria Parque', category:'Veterinaria', address:'Los Leones 1210, Providencia', website:'', phone:'+56 9 7442 9100', rating:4.6, reviewCount:94 },
        { name:'Norte Barber Club', category:'Barbería', address:'Manuel Montt 640, Providencia', website:'https://nortebarber.example', phone:'+56 9 8831 5504', rating:4.7, reviewCount:63, emails:['reservas@nortebarber.cl'], whatsapp:'56988315504', instagram:'nortebarberclub' },
        { name:'Kine Activa', category:'Kinesiología', address:'Pedro de Valdivia 1885, Ñuñoa', website:'https://kineactiva.example/reservas', phone:'+56 2 2550 4400', rating:4.5, reviewCount:41, emails:['contacto@kineactiva.cl'] },
        { name:'Taller Motor Sur', category:'Taller mecánico', address:'Seminario 870, Ñuñoa', website:'', phone:'+56 9 5230 1198', rating:4.3, reviewCount:128 }
      ];
      for (const item of demo) await upsertProspect({ ...item, description:'Atención local con consultas y coordinación por teléfono o WhatsApp.', source:'demo', sourceUrl:'' }, searchId, 'agenda', 'Ñuñoa / Providencia');
    }
    res.status(201).json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const contactChannels = {
  whatsapp: 'WhatsApp',
  email: 'Correo',
  call: 'Llamada',
  instagram: 'Instagram',
  visit: 'Visita'
};

// Registro de contacto: un solo gesto deja trazabilidad (actividad + último contacto)
// y hace avanzar el prospecto en el pipeline sin trabajo manual extra.
app.post('/api/prospecting/prospects/:id/contact', async (req, res) => {
  try {
    const prospect = await db.get('SELECT * FROM prospects WHERE id = ?', [req.params.id]);
    if (!prospect) return res.status(404).json({ error: 'Prospecto no encontrado.' });
    const channel = contactChannels[req.body?.channel] ? req.body.channel : 'whatsapp';
    const note = cleanText(req.body?.note || '', 300);
    const now = new Date().toISOString();
    // Contactar mueve el prospecto a la etapa de trabajo si aún estaba en el radar.
    const nextStatus = ['new', 'shortlisted'].includes(prospect.status) ? 'contacted' : prospect.status;
    await db.run('UPDATE prospects SET status = ?, last_contacted_at = ?, last_contact_channel = ?, updated_at = ? WHERE id = ?',
      [nextStatus, now, channel, now, prospect.id]);
    const summary = `Contacto por ${contactChannels[channel]}${note ? `: ${note}` : ''}`;
    await db.run('INSERT INTO prospect_activities (id, prospect_id, kind, summary, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), prospect.id, 'contacted', summary, JSON.stringify({ channel }), now]);
    if (nextStatus !== prospect.status) await db.run('INSERT INTO prospect_activities (id, prospect_id, kind, summary, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), prospect.id, 'status_changed', `Estado: ${prospect.status} → ${nextStatus}`, '{}', now]);
    res.json({ ok: true, status: nextStatus, last_contacted_at: now, channel });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Export CSV de la cosecha, respetando los filtros activos (estado/búsqueda).
app.get('/api/prospecting/export', async (req, res) => {
  try {
    const status = cleanText(req.query.status, 40);
    const search = cleanText(req.query.search, 120).toLowerCase();
    const onlyContactable = req.query.onlyContactable === '1';
    const clauses = [];
    const params = [];
    if (status && status !== 'all') { clauses.push('status = ?'); params.push(status); }
    if (search) { clauses.push('(lower(name) LIKE ? OR lower(category) LIKE ? OR lower(location) LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (onlyContactable) clauses.push("(email != '' OR whatsapp != '' OR phone != '')");
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await db.all(`SELECT * FROM prospects ${where} ORDER BY score DESC, updated_at DESC`, params);
    const columns = ['name', 'category', 'location', 'address', 'phone', 'whatsapp', 'email', 'instagram', 'facebook', 'website', 'score', 'fit', 'status', 'last_contacted_at', 'last_contact_channel', 'next_action_at'];
    const headers = ['Negocio', 'Rubro', 'Zona', 'Dirección', 'Teléfono', 'WhatsApp', 'Correo', 'Instagram', 'Facebook', 'Sitio', 'Score', 'Encaje', 'Estado', 'Último contacto', 'Canal último contacto', 'Próximo seguimiento'];
    const escapeCsv = value => {
      const text = String(value ?? '');
      return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [headers.join(',')];
    for (const row of rows) lines.push(columns.map(col => escapeCsv(row[col])).join(','));
    // BOM para que Excel abra las tildes correctamente.
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="prospectos-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.patch('/api/prospecting/prospects/:id', async (req, res) => {
  try {
    const prospect = await db.get('SELECT * FROM prospects WHERE id = ?', [req.params.id]);
    if (!prospect) return res.status(404).json({ error: 'Prospecto no encontrado.' });
    const allowedStatuses = ['new', 'shortlisted', 'contacted', 'replied', 'qualified', 'won', 'lost', 'discarded'];
    const status = allowedStatuses.includes(req.body?.status) ? req.body.status : prospect.status;
    const notes = req.body?.notes === undefined ? prospect.notes : cleanText(req.body.notes, 3000);
    const nextAction = req.body?.next_action_at === undefined ? prospect.next_action_at : (req.body.next_action_at || null);
    await db.run('UPDATE prospects SET status = ?, notes = ?, next_action_at = ?, updated_at = ? WHERE id = ?', [status, notes, nextAction, new Date().toISOString(), prospect.id]);
    if (status !== prospect.status) await db.run('INSERT INTO prospect_activities (id, prospect_id, kind, summary, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), prospect.id, 'status_changed', `Estado: ${prospect.status} → ${status}`, '{}', new Date().toISOString()]);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Ingreso manual al CRM: para negocios que ya conoces y no vienen de una búsqueda.
app.post('/api/prospecting/prospects/manual', async (req, res) => {
  try {
    const name = cleanText(req.body?.name, 180);
    if (!name) return res.status(400).json({ error: 'El nombre del negocio es obligatorio.' });
    const vertical = prospectingVerticals[req.body?.vertical] ? req.body.vertical : 'custom';
    const location = cleanText(req.body?.location, 120) || 'Manual';
    const now = new Date().toISOString();
    const searchId = randomUUID();
    await db.run('INSERT INTO prospecting_searches (id, vertical, location, terms, coverage, result_count, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [searchId, vertical, location, name, 'comuna', 1, 'manual', now]);
    const result = await upsertProspect({
      name, category: cleanText(req.body?.category, 160), description: '', address: cleanText(req.body?.address, 300),
      website: cleanText(req.body?.website, 500), phone: cleanText(req.body?.phone, 80),
      emails: req.body?.email ? [cleanText(req.body.email, 160)] : [], whatsapp: cleanText(req.body?.whatsapp, 80),
      instagram: cleanText(req.body?.instagram, 120), facebook: '',
      rating: null, reviewCount: 0, source: 'manual', sourceUrl: ''
    }, searchId, vertical, location);
    res.status(201).json({ ok: true, id: result.id, created: result.created });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/prospecting/prospects/:id/convert', async (req, res) => {
  try {
    const prospect = await db.get('SELECT * FROM prospects WHERE id = ?', [req.params.id]);
    if (!prospect) return res.status(404).json({ error: 'Prospecto no encontrado.' });
    if (prospect.converted_client_id) return res.status(409).json({ error: 'Este prospecto ya tiene un proyecto.' });
    const base = cleanText(prospect.name, 80).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cliente';
    let clientId = base;
    let suffix = 2;
    while (await clientExists(clientId)) clientId = `${base}-${suffix++}`;
    await db.run(`INSERT INTO clients (id, name, niche, desc, agent_name, agent_tone, agent_avatar_color, agent_role, agent_whatsapp, agent_system_prompt, project_stage, next_action)
      VALUES (?, ?, ?, ?, ?, 'friendly', 'emerald', ?, ?, ?, 'intake', ?)`, [
      clientId, prospect.name, prospect.category || prospectingVerticals[prospect.vertical]?.label || 'Negocio local',
      `Prospecto originado en Prospección. ${prospect.address}`.trim(), `Asistente de ${prospect.name}`,
      prospect.vertical === 'agenda' ? 'Resolver consultas y gestionar reservas.' : 'Resolver consultas y captar oportunidades.', prospect.phone,
      `Eres el asistente de ${prospect.name}. Usa únicamente conocimiento aprobado y deriva lo que no puedas confirmar.`,
      'Enviar entrevista guiada al dueño'
    ]);
    await db.run('INSERT INTO chats (client_id, sender, text, time) VALUES (?, ?, ?, ?)', [clientId, 'agent', `Hola, soy el asistente de ${prospect.name}. ¿En qué puedo ayudarte?`, new Date().toLocaleTimeString('es-CL', { hour:'2-digit', minute:'2-digit' })]);
    await db.run("UPDATE prospects SET status = 'won', converted_client_id = ?, updated_at = ? WHERE id = ?", [clientId, new Date().toISOString(), prospect.id]);
    await db.run('INSERT INTO prospect_activities (id, prospect_id, kind, summary, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), prospect.id, 'converted', 'Convertido en proyecto ZeroAgent.', JSON.stringify({ client_id: clientId }), new Date().toISOString()]);
    await writeAudit('convert_prospect', 'prospect', prospect.id, { client_id: clientId });
    res.status(201).json({ ok: true, client_id: clientId });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 1. Obtener listado de clientes
app.get('/api/clients', async (req, res) => {
  try {
    const clients = await db.all('SELECT * FROM clients');
    // Mapeamos los datos de base de datos a la estructura esperada por el frontend
    const formattedClients = await Promise.all(clients.map(async (client) => {
      const docs = await db.all('SELECT id, title, category, content FROM documents WHERE client_id = ?', [client.id]);
      const chats = await db.all('SELECT id, sender, text, time FROM chats WHERE client_id = ? ORDER BY id ASC', [client.id]);
      const feedback = await db.all('SELECT chat_id, rating, correction_text, source_id, created_at FROM conversation_feedback WHERE client_id = ?', [client.id]);
      const sources = await db.all(`
        SELECT id, title, source_type, original_name, storage_path, mime_type, size_bytes,
               notes, status, version_number, replaces_source_id, created_at, reviewed_at
        FROM source_files WHERE client_id = ? ORDER BY created_at DESC
      `, [client.id]);
      const intakeJobs = await db.all(`
        SELECT id, source_id, kind, status, instructions, workspace_path, proposal_json, error_message, created_at, completed_at
        FROM intake_jobs WHERE client_id = ? ORDER BY created_at DESC
      `, [client.id]);
      const versions = await db.all(`
        SELECT id, version, status, summary, created_at, approved_at
        FROM agent_versions WHERE client_id = ? ORDER BY created_at DESC
      `, [client.id]);
      const knowledgeItems = await db.all(`
        SELECT id, source_id, category, subject, value, status, notes, confirmed_at
        FROM knowledge_items WHERE client_id = ? ORDER BY confirmed_at DESC
      `, [client.id]);
      const tests = await db.all(`
        SELECT id, knowledge_item_id, question, expected_behavior, status, last_result, created_at
        FROM agent_tests WHERE client_id = ? ORDER BY created_at DESC
      `, [client.id]);
      const agendaRecord = await db.get('SELECT config_json, updated_at FROM agenda_configs WHERE client_id = ?', [client.id]);
      const onboarding = await db.get(`SELECT id, status, current_step, expires_at, created_at, updated_at, submitted_at, approved_at
        FROM onboarding_sessions WHERE client_id = ? ORDER BY created_at DESC LIMIT 1`, [client.id]);
      let agenda = { ...agendaV1Defaults };
      if (agendaRecord?.config_json) {
        try { agenda = normalizeAgendaConfig(JSON.parse(agendaRecord.config_json)); } catch { /* configuración antigua inválida: usar base segura */ }
      }

      return {
        id: client.id,
        name: client.name,
        niche: client.niche,
        desc: client.desc,
        project: {
          stage: client.project_stage || 'intake',
          notes: client.project_notes || '',
          nextAction: client.next_action || ''
        },
        agent: {
          name: client.agent_name,
          tone: client.agent_tone,
          avatarColor: client.agent_avatar_color,
          role: client.agent_role,
          whatsapp: client.agent_whatsapp,
          systemPrompt: client.agent_system_prompt
        },
        documents: docs,
        chats: chats,
        feedback,
        sources,
        intakeJobs: intakeJobs.map(job => ({
          ...job,
          proposal: job.proposal_json ? JSON.parse(job.proposal_json) : null
        })),
        versions,
        knowledgeItems,
        tests,
        agenda: { ...agenda, updatedAt: agendaRecord?.updated_at || null },
        onboarding: onboarding || null
      };
    }));

    res.json(formattedClients);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function publicOnboardingSession(session, client, responses = [], files = []) {
  return {
    id: session.id,
    status: session.status,
    currentStep: session.current_step,
    expiresAt: session.expires_at,
    updatedAt: session.updated_at,
    submittedAt: session.submitted_at,
    approvedAt: session.approved_at,
    business: { id: client.id, name: client.name, niche: client.niche, description: client.desc || '' },
    responses: Object.fromEntries(responses.map(item => {
      try { return [item.step_key, JSON.parse(item.data_json || '{}')]; } catch { return [item.step_key, {}]; }
    })),
    files: files.map(item => ({ id: item.id, name: item.original_name, type: item.mime_type, size: item.size_bytes, createdAt: item.created_at }))
  };
}

// Entrevista local para demos y clientes aún sin infraestructura. El paquete final
// incluye la misma interfaz contra el Supabase propio del cliente.
app.post('/api/clients/:id/onboarding', async (req, res) => {
  try {
    if (!(await clientExists(req.params.id))) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const now = new Date();
    const expires = new Date(now.getTime() + 14 * 86400000);
    const id = `onboarding-${randomUUID()}`;
    const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    await db.run(`UPDATE onboarding_sessions SET status = 'revoked', updated_at = ? WHERE client_id = ? AND status NOT IN ('submitted','approved','revoked')`, [now.toISOString(), req.params.id]);
    await db.run(`INSERT INTO onboarding_sessions (id, client_id, token, status, current_step, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, 'sent', 0, ?, ?, ?)`, [id, req.params.id, token, expires.toISOString(), now.toISOString(), now.toISOString()]);
    await writeAudit('onboarding_created', 'client', req.params.id, { sessionId: id, expiresAt: expires.toISOString() });
    res.status(201).json({ id, token, url: `/onboarding.html?token=${token}`, status: 'sent', expiresAt: expires.toISOString() });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/clients/:id/onboarding', async (req, res) => {
  try {
    const session = await db.get(`SELECT id, token, status, current_step, expires_at, created_at, updated_at, submitted_at, approved_at
      FROM onboarding_sessions WHERE client_id = ? ORDER BY created_at DESC LIMIT 1`, [req.params.id]);
    if (!session) return res.json({ status: 'not_created' });
    const answers = await db.get('SELECT COUNT(*) AS count FROM onboarding_responses WHERE session_id = ?', [session.id]);
    const files = await db.get('SELECT COUNT(*) AS count FROM onboarding_files WHERE session_id = ?', [session.id]);
    res.json({ ...session, url: `/onboarding.html?token=${session.token}`, answers: answers.count, files: files.count });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/onboarding/:token', async (req, res) => {
  try {
    const session = await db.get('SELECT * FROM onboarding_sessions WHERE token = ?', [req.params.token]);
    if (!session) return res.status(404).json({ error: 'El enlace no existe o fue revocado.' });
    if (session.status === 'revoked' || new Date(session.expires_at) < new Date()) return res.status(410).json({ error: 'El enlace venció. Solicita uno nuevo.' });
    const client = await db.get('SELECT id, name, niche, desc FROM clients WHERE id = ?', [session.client_id]);
    const responses = await db.all('SELECT step_key, data_json FROM onboarding_responses WHERE session_id = ?', [session.id]);
    const files = await db.all('SELECT id, original_name, mime_type, size_bytes, created_at FROM onboarding_files WHERE session_id = ? ORDER BY created_at DESC', [session.id]);
    if (session.status === 'sent') await db.run("UPDATE onboarding_sessions SET status = 'opened', updated_at = ? WHERE id = ?", [new Date().toISOString(), session.id]);
    res.json(publicOnboardingSession({ ...session, status: session.status === 'sent' ? 'opened' : session.status }, client, responses, files));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/onboarding/:token/response', async (req, res) => {
  const stepKey = String(req.body?.stepKey || '').trim().slice(0, 80);
  const step = Math.max(0, Math.min(12, Number(req.body?.step) || 0));
  if (!stepKey || !req.body?.data || typeof req.body.data !== 'object') return res.status(400).json({ error: 'Respuesta inválida.' });
  try {
    const session = await db.get('SELECT * FROM onboarding_sessions WHERE token = ?', [req.params.token]);
    if (!session || ['revoked','submitted','approved'].includes(session.status) || new Date(session.expires_at) < new Date()) return res.status(410).json({ error: 'La entrevista ya no admite cambios.' });
    const now = new Date().toISOString();
    await db.run(`INSERT INTO onboarding_responses (session_id, step_key, data_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, step_key) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at`, [session.id, stepKey, JSON.stringify(req.body.data), now]);
    await db.run("UPDATE onboarding_sessions SET status='partial', current_step=?, updated_at=? WHERE id=?", [step, now, session.id]);
    res.json({ ok: true, savedAt: now, currentStep: step });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/onboarding/:token/files', express.raw({ type: '*/*', limit: '15mb' }), async (req, res) => {
  try {
    const session = await db.get('SELECT * FROM onboarding_sessions WHERE token = ?', [req.params.token]);
    if (!session || ['revoked','submitted','approved'].includes(session.status)) return res.status(410).json({ error: 'La entrevista ya no admite archivos.' });
    const originalName = path.basename(decodeURIComponent(String(req.headers['x-file-name'] || 'documento'))).slice(0, 180);
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'El archivo está vacío.' });
    const id = `onboarding-file-${randomUUID()}`;
    const directory = path.join(onboardingRoot, session.id);
    await fs.mkdir(directory, { recursive: true });
    const storedName = `${id}-${safeFileName(originalName)}`;
    await fs.writeFile(path.join(directory, storedName), req.body);
    const now = new Date().toISOString();
    await db.run(`INSERT INTO onboarding_files (id, session_id, original_name, storage_path, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, session.id, originalName, path.relative(__dirname, path.join(directory, storedName)), String(req.headers['content-type'] || 'application/octet-stream'), req.body.length, now]);
    res.status(201).json({ id, name: originalName, size: req.body.length });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/onboarding/:token/submit', async (req, res) => {
  try {
    const session = await db.get('SELECT * FROM onboarding_sessions WHERE token = ?', [req.params.token]);
    if (!session || session.status === 'revoked') return res.status(410).json({ error: 'La entrevista no está disponible.' });
    const count = await db.get('SELECT COUNT(*) AS count FROM onboarding_responses WHERE session_id = ?', [session.id]);
    if (count.count < 6) return res.status(422).json({ error: 'Completa las secciones principales antes de enviar.' });
    const now = new Date().toISOString();
    await db.run("UPDATE onboarding_sessions SET status='submitted', current_step=12, submitted_at=?, updated_at=? WHERE id=?", [now, now, session.id]);
    await writeAudit('onboarding_submitted', 'client', session.client_id, { sessionId: session.id, sections: count.count });
    res.json({ ok: true, submittedAt: now });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Registrar una propuesta creada desde el IDE. Studio la muestra para revisión humana;
// nunca aplica los cambios de conocimiento automáticamente.
app.put('/api/intake-jobs/:jobId/proposal', async (req, res) => {
  const { jobId } = req.params;
  const { proposal } = req.body;

  if (!proposal || typeof proposal !== 'object' || !proposal.summary) {
    return res.status(400).json({ error: 'La propuesta debe incluir al menos un resumen.' });
  }

  try {
    const job = await db.get('SELECT client_id, source_id FROM intake_jobs WHERE id = ?', [jobId]);
    if (!job) return res.status(404).json({ error: 'Tarea no encontrada.' });

    const completedAt = new Date().toISOString();
    await db.run(`
      UPDATE intake_jobs
      SET status = 'under_review', proposal_json = ?, completed_at = ?, error_message = ''
      WHERE id = ?
    `, [JSON.stringify(proposal), completedAt, jobId]);
    await db.run(`
      UPDATE source_files SET status = 'under_review' WHERE id = ? AND client_id = ?
    `, [job.source_id, job.client_id]);

    res.json({ message: 'Propuesta registrada para revisión humana.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Aplicar una propuesta sólo mediante una acción humana explícita desde Studio.
// Acepta el contrato knowledge_proposal.facts y test_proposals del IDE.
app.post('/api/intake-jobs/:jobId/apply', async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = await db.get('SELECT client_id, source_id, status, proposal_json FROM intake_jobs WHERE id = ?', [jobId]);
    if (!job) return res.status(404).json({ error: 'Tarea no encontrada.' });
    if (job.status === 'applied') return res.status(409).json({ error: 'Esta propuesta ya fue aplicada.' });
    const proposal = job.proposal_json ? JSON.parse(job.proposal_json) : null;
    if (!proposal) return res.status(400).json({ error: 'No hay una propuesta para aplicar.' });

    const rawFacts = proposal.knowledge_proposal?.facts || proposal.knowledge_proposal?.items || proposal.knowledge_items || [];
    const rawTests = proposal.test_proposals || proposal.tests || [];
    if (!Array.isArray(rawFacts) || !Array.isArray(rawTests)) {
      return res.status(400).json({ error: 'La propuesta debe usar listas para hechos y pruebas.' });
    }
    const invalidFact = rawFacts.find(fact => !fact?.category || !fact?.subject || !fact?.value);
    const invalidTest = rawTests.find(test => !test?.question || !(test.expected_behavior || test.expectedBehavior));
    if (invalidFact || invalidTest) {
      return res.status(400).json({ error: 'Hay hechos o pruebas incompletos en la propuesta.' });
    }

    const now = new Date().toISOString();
    const factIds = [];
    for (const fact of rawFacts) {
      const id = `knowledge-${randomUUID()}`;
      factIds.push(id);
      await db.run(`
        INSERT INTO knowledge_items (id, client_id, source_id, category, subject, value, status, notes, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?)
      `, [id, job.client_id, job.source_id, fact.category.trim(), fact.subject.trim(), fact.value.trim(), (fact.notes || fact.evidence || '').trim(), now]);
    }
    for (const test of rawTests) {
      const linkedIndex = Number.isInteger(test.fact_index) ? test.fact_index : Number.isInteger(test.factIndex) ? test.factIndex : null;
      const linkedFactId = linkedIndex !== null && factIds[linkedIndex] ? factIds[linkedIndex] : null;
      await db.run(`
        INSERT INTO agent_tests (id, client_id, knowledge_item_id, question, expected_behavior, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [`test-${randomUUID()}`, job.client_id, linkedFactId, test.question.trim(), (test.expected_behavior || test.expectedBehavior).trim(), now]);
    }
    await db.run("UPDATE intake_jobs SET status = 'applied', completed_at = ? WHERE id = ?", [now, jobId]);
    await db.run("UPDATE source_files SET status = 'approved', reviewed_at = ? WHERE id = ? AND client_id = ?", [now, job.source_id, job.client_id]);
    await writeAudit('proposal_applied', 'intake_job', jobId, { clientId: job.client_id, sourceId: job.source_id, facts: rawFacts.length, tests: rawTests.length });
    res.json({ message: 'Propuesta aplicada y marcada como aprobada.', factsCreated: rawFacts.length, testsCreated: rawTests.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/clients/:id/gap-questions', async (req, res) => {
  const { id: clientId } = req.params;
  try {
    const client = await db.get('SELECT niche FROM clients WHERE id = ?', [clientId]);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const facts = await db.all("SELECT category, subject, value FROM knowledge_items WHERE client_id = ? AND status = 'approved'", [clientId]);
    res.json({ questions: buildGapQuestions(client.niche, facts) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Registrar un dato confirmado y, opcionalmente, su prueba de regresión.
app.post('/api/clients/:id/knowledge-items', async (req, res) => {
  const { id: clientId } = req.params;
  const { category, subject, value, notes = '', sourceId = null, testQuestion = '', expectedBehavior = '' } = req.body;
  if (!category?.trim() || !subject?.trim() || !value?.trim()) {
    return res.status(400).json({ error: 'Categoría, asunto y valor son obligatorios.' });
  }
  if ((testQuestion.trim() || expectedBehavior.trim()) && (!testQuestion.trim() || !expectedBehavior.trim())) {
    return res.status(400).json({ error: 'Para guardar una prueba se requieren pregunta y comportamiento esperado.' });
  }
  try {
    const itemId = `knowledge-${randomUUID()}`;
    const confirmedAt = new Date().toISOString();
    await db.run(`
      INSERT INTO knowledge_items (id, client_id, source_id, category, subject, value, status, notes, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?)
    `, [itemId, clientId, sourceId || null, category.trim(), subject.trim(), value.trim(), notes.trim(), confirmedAt]);

    let testId = null;
    if (testQuestion.trim() || expectedBehavior.trim()) {
      testId = `test-${randomUUID()}`;
      await db.run(`
        INSERT INTO agent_tests (id, client_id, knowledge_item_id, question, expected_behavior, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [testId, clientId, itemId, testQuestion.trim(), expectedBehavior.trim(), confirmedAt]);
    }
    await writeAudit('knowledge_item_created', 'knowledge_item', itemId, { clientId, sourceId, testId });
    res.status(201).json({ message: 'Dato confirmado guardado.', itemId, testId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/clients/:id/knowledge-items/:itemId', async (req, res) => {
  const { id: clientId, itemId } = req.params;
  try {
    const result = await db.run('DELETE FROM knowledge_items WHERE id = ? AND client_id = ?', [itemId, clientId]);
    if (result.changes === 0) return res.status(404).json({ error: 'Dato no encontrado.' });
    await writeAudit('knowledge_item_deleted', 'knowledge_item', itemId, { clientId });
    res.json({ message: 'Dato eliminado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/clients/:id/tests/:testId', async (req, res) => {
  const { id: clientId, testId } = req.params;
  try {
    const result = await db.run('DELETE FROM agent_tests WHERE id = ? AND client_id = ?', [testId, clientId]);
    if (result.changes === 0) return res.status(404).json({ error: 'Prueba no encontrada.' });
    res.json({ message: 'Prueba eliminada.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Actualizar el estado de construcción del proyecto de un cliente
app.get('/api/clients/:id/agenda', async (req, res) => {
  try {
    if (!(await clientExists(req.params.id))) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const record = await db.get('SELECT config_json, updated_at FROM agenda_configs WHERE client_id = ?', [req.params.id]);
    let config = { ...agendaV1Defaults };
    if (record?.config_json) {
      try { config = normalizeAgendaConfig(JSON.parse(record.config_json)); } catch { /* base segura */ }
    }
    res.json({ ...config, updatedAt: record?.updated_at || null });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/clients/:id/agenda', async (req, res) => {
  try {
    if (!(await clientExists(req.params.id))) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const config = normalizeAgendaConfig(req.body || {});
    const now = new Date().toISOString();
    await db.run(`INSERT INTO agenda_configs (client_id, config_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
      [req.params.id, JSON.stringify(config), now]);
    await writeAudit('agenda_configured', 'client', req.params.id, { enabled: config.enabled, services: config.services.length, resources: config.resources.length });
    res.json({ ...config, updatedAt: now });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Actualizar el estado de construcción del proyecto de un cliente
app.put('/api/clients/:id/project', async (req, res) => {
  const { id } = req.params;
  const { stage, notes = '', nextAction = '' } = req.body;
  const allowedStages = ['intake', 'waiting_info', 'building', 'testing', 'ready_to_install', 'installed', 'paused'];

  if (!allowedStages.includes(stage)) {
    return res.status(400).json({ error: 'Estado de proyecto inválido.' });
  }

  try {
    const result = await db.run(`
      UPDATE clients SET project_stage = ?, project_notes = ?, next_action = ? WHERE id = ?
    `, [stage, notes, nextAction, id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Cliente no encontrado.' });
    res.json({ message: 'Proyecto actualizado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Construye el paquete portable del agente desde el estado vivo del cliente.
// Es la ÚNICA fuente del contrato: la usan tanto el versionado como el playground de calidad,
// para que "entrenar" y "probar" ejerciten exactamente el mismo motor y los mismos datos.
async function buildClientPackage(clientId, version = 'preview') {
  const client = await db.get('SELECT * FROM clients WHERE id = ?', [clientId]);
  if (!client) return null;
  const documents = await db.all('SELECT id, title, category, content FROM documents WHERE client_id = ?', [clientId]);
  const approvedSources = await db.all(`
    SELECT id, title, source_type, original_name, storage_path, mime_type, notes, content, version_number, created_at
    FROM source_files WHERE client_id = ? AND status = 'approved' ORDER BY created_at ASC
  `, [clientId]);
  const confirmedFacts = await db.all(`
    SELECT id, source_id, category, subject, value, notes, confirmed_at
    FROM knowledge_items WHERE client_id = ? AND status = 'approved' ORDER BY confirmed_at ASC
  `, [clientId]);
  const activeTests = await db.all(`
    SELECT id, knowledge_item_id, question, expected_behavior, last_result
    FROM agent_tests WHERE client_id = ? AND status = 'active' ORDER BY created_at ASC
  `, [clientId]);
  const agendaRecord = await db.get('SELECT config_json FROM agenda_configs WHERE client_id = ?', [clientId]);
  let agenda = { ...agendaV1Defaults };
  if (agendaRecord?.config_json) {
    try { agenda = normalizeAgendaConfig(JSON.parse(agendaRecord.config_json)); } catch { /* no empaquetar valores corruptos */ }
  }
  return {
    standard_version: 1,
    package_type: 'zeroagent-agent',
    package_version: version,
    generated_at: new Date().toISOString(),
    business: {
      id: client.id,
      display_name: client.name,
      niche: client.niche,
      description: client.desc || ''
    },
    agent: {
      name: client.agent_name,
      tone: client.agent_tone,
      tone_policy: getToneProfile(client.agent_tone),
      role: client.agent_role,
      system_prompt: client.agent_system_prompt,
      policy: {
        use_only_approved_facts: true,
        unknown_fact_behavior: 'admit_unknown_and_offer_handoff'
      }
    },
    project: {
      stage: client.project_stage,
      notes: client.project_notes,
      next_action: client.next_action
    },
    knowledge: {
      legacy_documents: documents,
      approved_sources: approvedSources,
      confirmed_facts: confirmedFacts
    },
    flows: agenda.enabled ? [{
      id: 'agenda-v1',
      type: 'booking',
      status: 'configured',
      contract: 'zeroagent-agenda-v1'
    }] : [],
    solutions: agenda.enabled ? {
      agenda: {
        contract_version: '1.0.0',
        purpose: 'Shared availability for WhatsApp, public booking and client console.',
        config: agenda,
        required_runtime_capabilities: [
          'supabase-postgres', 'atomic-booking-functions', 'zavu-webhook-adapter',
          'client-console-feedback', 'public-booking-page'
        ],
        safety: {
          availability_is_authoritative: true,
          no_booking_without_live_availability_check: true,
          handoff_on_conflict: agenda.rules.human_handoff_on_conflict
        },
        agent_flow_contract: {
          standard: 'zeroagent-agenda-flows',
          tools: ['get_availability', 'get_my_appointment', 'create_appointment', 'cancel_appointment', 'reschedule_appointment', 'request_human_handoff'],
          guarantees: ['verified_channel_identity', 'atomic_mutations', 'intent_can_change_between_turns', 'no_confirmation_without_tool_success']
        }
      }
    } : {},
    tests: activeTests,
    installation: {
      credentials: 'configured_at_installation',
      channel_provider: 'configured_at_installation',
      ownership: 'customer_owned_infrastructure',
      stages: ['preview_local', 'staging', 'production'],
      studio_connection: 'local_vault_authorized_maintenance_only'
    }
  };
}

// Crear un paquete versionado de agente. En esta etapa se genera el contrato portable;
// el runtime Docker se conectará a este mismo paquete en una etapa posterior.
app.post('/api/clients/:id/versions', async (req, res) => {
  const { id: clientId } = req.params;
  const { version, summary = '' } = req.body;
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    return res.status(400).json({ error: 'La versión debe usar el formato mayor.menor.parche, por ejemplo 0.1.0.' });
  }

  try {
    const packageData = await buildClientPackage(clientId, version);
    if (!packageData) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const versionId = `version-${randomUUID()}`;
    await db.run(`
      INSERT INTO agent_versions (id, client_id, version, status, summary, package_json, created_at)
      VALUES (?, ?, ?, 'draft', ?, ?, ?)
    `, [versionId, clientId, version, summary.trim(), JSON.stringify(packageData, null, 2), packageData.generated_at]);
    res.status(201).json({ message: 'Versión de borrador creada.', versionId, package: packageData });
  } catch (error) {
    const isDuplicate = String(error.message).includes('UNIQUE constraint failed');
    res.status(isDuplicate ? 409 : 500).json({ error: isDuplicate ? 'Ya existe esa versión para este agente.' : error.message });
  }
});

app.put('/api/clients/:id/versions/:versionId/approve', async (req, res) => {
  const { id: clientId, versionId } = req.params;
  try {
    const result = await db.run(`
      UPDATE agent_versions SET status = 'approved', approved_at = ?
      WHERE id = ? AND client_id = ?
    `, [new Date().toISOString(), versionId, clientId]);
    if (result.changes === 0) return res.status(404).json({ error: 'Versión no encontrada.' });
    res.json({ message: 'Versión aprobada.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/clients/:id/versions/:versionId/export', async (req, res) => {
  const { id: clientId, versionId } = req.params;
  try {
    const record = await db.get(`
      SELECT version, package_json FROM agent_versions WHERE id = ? AND client_id = ?
    `, [versionId, clientId]);
    if (!record) return res.status(404).json({ error: 'Versión no encontrada.' });
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(`${clientId}-${record.version}-package.json`)}"`);
    res.type('application/json').send(record.package_json);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/clients/:id/installation-preflight', async (req, res) => {
  try {
    const preflight = await getInstallationPreflight(req.params.id, req.query.target || 'preview');
    if (!preflight) return res.status(404).json({ error: 'Cliente no encontrado.' });
    res.json(preflight);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Construye una instalación autocontenida del runtime para una versión aprobada.
// El Studio no queda involucrado una vez copiada esa carpeta al entorno del cliente.
app.post('/api/clients/:id/versions/:versionId/build-runtime', async (req, res) => {
  const { id: clientId, versionId } = req.params;
  try {
    const target = String(req.body?.target || '').trim();
    if (!['preview', 'staging', 'production'].includes(target)) {
      return res.status(400).json({ error: 'Debes indicar explícitamente el destino: preview, staging o production.' });
    }
    const record = await db.get(`
      SELECT version, status, package_json FROM agent_versions WHERE id = ? AND client_id = ?
    `, [versionId, clientId]);
    if (!record) return res.status(404).json({ error: 'Versión no encontrada.' });
    if (record.status !== 'approved') return res.status(409).json({ error: 'Aprueba la versión antes de construir una instalación.' });
    const preflight = await getInstallationPreflight(clientId, target);
    if (!preflight.ready) return res.status(409).json({ error: 'La instalación no pasó la revisión previa.', preflight });
    const outputDir = await buildClientRuntime(clientId, record.version, JSON.parse(record.package_json), target);
    await writeAudit('runtime_built', 'agent_version', versionId, { clientId, version: record.version, target, outputDir });
    res.json({
      message: `Runtime ${target} construido. Copia esta carpeta al entorno correspondiente y configura sus credenciales allí.`,
      target,
      outputDir,
      relativePath: path.relative(__dirname, outputDir)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Registrar una fuente original y dejar una tarea local para que el IDE la interprete.
app.post('/api/clients/:id/sources', async (req, res) => {
  const { id: clientId } = req.params;
  const {
    title,
    sourceType,
    originalName = '',
    mimeType = '',
    sizeBytes = 0,
    notes = '',
    content = '',
    fileData = '',
    replacesSourceId = null
  } = req.body;
  const allowedTypes = ['spreadsheet', 'document', 'website', 'note', 'other'];

  if (!title?.trim() || !allowedTypes.includes(sourceType)) {
    return res.status(400).json({ error: 'Título o tipo de fuente inválido.' });
  }

  if (!(await clientExists(clientId))) {
    return res.status(404).json({ error: 'Cliente no encontrado.' });
  }

  try {
    const sourceId = `source-${randomUUID()}`;
    const jobId = `job-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const previous = replacesSourceId
      ? await db.get('SELECT version_number FROM source_files WHERE id = ? AND client_id = ?', [replacesSourceId, clientId])
      : null;
    const versionNumber = previous ? previous.version_number + 1 : 1;
    let storagePath = null;

    const binary = decodeBase64File(fileData);
    if (binary) {
      const clientStorageId = safeFileName(clientId);
      const clientDir = path.join(storageRoot, clientStorageId, sourceId);
      const fileName = safeFileName(originalName || title);
      await fs.mkdir(clientDir, { recursive: true });
      await fs.writeFile(path.join(clientDir, fileName), binary);
      storagePath = path.posix.join('sources', clientStorageId, sourceId, fileName);
    }

    await db.run(`
      INSERT INTO source_files (
        id, client_id, title, source_type, original_name, storage_path, mime_type,
        size_bytes, notes, content, status, version_number, replaces_source_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_ide', ?, ?, ?)
    `, [
      sourceId, clientId, title.trim(), sourceType, originalName, storagePath, mimeType,
      Number(sizeBytes) || 0, notes.trim(), content.trim(), versionNumber, replacesSourceId, createdAt
    ]);

    const instructions = sourceType === 'spreadsheet'
      ? 'Interpretar hojas y columnas; proponer cambios estructurados sin aplicarlos automáticamente.'
      : 'Extraer información relevante; identificar datos faltantes o contradictorios y proponer cambios sin aplicarlos automáticamente.';

    await db.run(`
      INSERT INTO intake_jobs (id, client_id, source_id, kind, status, instructions, created_at)
      VALUES (?, ?, ?, 'interpret_source', 'pending_ide', ?, ?)
    `, [jobId, clientId, sourceId, instructions, createdAt]);

    const taskDirectory = path.join(ideInboxRoot, jobId);
    const relativeTaskPath = path.posix.join('.zeroagent', 'inbox', jobId, 'task.json');
    const task = {
      standard_version: 1,
      task_id: jobId,
      kind: 'interpret_source',
      status: 'pending_ide',
      created_at: createdAt,
      client: { id: clientId },
      source: {
        id: sourceId,
        title: title.trim(),
        type: sourceType,
        original_name: originalName,
        storage_path: storagePath,
        content: content.trim(),
        notes: notes.trim(),
        version_number: versionNumber,
        replaces_source_id: replacesSourceId
      },
      instructions,
      expected_output: path.posix.join('.zeroagent', 'proposals', `${jobId}.json`),
      rules: [
        'No aplicar cambios directamente a la base de conocimiento.',
        'Identificar datos nuevos, modificados, eliminados, ambiguos o contradictorios.',
        'Proponer información estructurada y casos de prueba afectados.',
        'Conservar la relación con la fuente original.'
      ]
    };
    await fs.mkdir(taskDirectory, { recursive: true });
    await fs.writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify(task, null, 2), 'utf8');
    await db.run('UPDATE intake_jobs SET workspace_path = ? WHERE id = ?', [relativeTaskPath, jobId]);

    res.status(201).json({ message: 'Fuente registrada y enviada a la cola local del IDE.', sourceId, jobId, workspacePath: relativeTaskPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/clients/:id/sources/:sourceId/status', async (req, res) => {
  const { id: clientId, sourceId } = req.params;
  const { status } = req.body;
  const allowedStatuses = ['pending_ide', 'under_review', 'approved', 'rejected'];
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Estado de fuente inválido.' });

  try {
    const result = await db.run(`
      UPDATE source_files SET status = ?, reviewed_at = CASE WHEN ? IN ('approved', 'rejected') THEN ? ELSE NULL END
      WHERE id = ? AND client_id = ?
    `, [status, status, new Date().toISOString(), sourceId, clientId]);
    if (result.changes === 0) return res.status(404).json({ error: 'Fuente no encontrada.' });
    res.json({ message: 'Estado de fuente actualizado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/clients/:id/sources/:sourceId', async (req, res) => {
  const { id: clientId, sourceId } = req.params;
  try {
    const source = await db.get('SELECT storage_path FROM source_files WHERE id = ? AND client_id = ?', [sourceId, clientId]);
    if (!source) return res.status(404).json({ error: 'Fuente no encontrada.' });

    const jobs = await db.all('SELECT workspace_path FROM intake_jobs WHERE source_id = ? AND client_id = ?', [sourceId, clientId]);

    await db.run('DELETE FROM source_files WHERE id = ? AND client_id = ?', [sourceId, clientId]);
    if (source.storage_path) {
      await fs.rm(path.join(__dirname, 'storage', path.dirname(source.storage_path)), { recursive: true, force: true });
    }
    for (const job of jobs) {
      if (job.workspace_path) {
        await fs.rm(path.dirname(path.join(__dirname, job.workspace_path)), { recursive: true, force: true });
      }
    }
    await writeAudit('delete_source', 'source', sourceId, { client_id: clientId, storage_path: source.storage_path });
    res.json({ message: 'Fuente eliminada.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Crear un nuevo cliente
app.post('/api/clients', async (req, res) => {
  const { id, name, niche, desc, agent } = req.body;
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(String(id || '')) || !String(name || '').trim()) {
    return res.status(400).json({ error: 'El cliente requiere nombre y un ID seguro de 2 a 80 caracteres.' });
  }
  try {
    await db.run(`
      INSERT INTO clients (id, name, niche, desc, agent_name, agent_tone, agent_avatar_color, agent_role, agent_whatsapp, agent_system_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, name, niche, desc,
      agent?.name || `Asistente de ${name}`,
      agent?.tone || 'friendly',
      agent?.avatarColor || 'emerald',
      agent?.role || `Resolver consultas sobre ${name}.`,
      agent?.whatsapp || '',
      agent?.systemPrompt || `Eres el asistente de ${name}. Consulta el entrenamiento.`
    ]);

    // Crear mensaje de bienvenida inicial
    const welcomeMsg = `¡Hola! Soy tu asistente de WhatsApp. ¿En qué te puedo asesorar hoy?`;
    await db.run(`
      INSERT INTO chats (client_id, sender, text, time)
      VALUES (?, ?, ?, ?)
    `, [id, 'agent', welcomeMsg, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })]);

    res.status(201).json({ message: 'Cliente creado con éxito.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Eliminar un cliente
app.delete('/api/clients/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const client = await db.get('SELECT id, name FROM clients WHERE id = ?', [id]);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const snapshotPath = await createDataSnapshot(`before-delete-client-${id}`);
    await db.run('DELETE FROM clients WHERE id = ?', [id]);
    await writeAudit('delete_client', 'client', id, { name: client.name, snapshot_path: snapshotPath });
    res.json({ message: 'Cliente eliminado correctamente.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Actualizar configuración de agente
app.put('/api/clients/:id/agent', async (req, res) => {
  const { id } = req.params;
  const { name, tone, avatarColor, role, whatsapp, systemPrompt } = req.body;
  try {
    await db.run(`
      UPDATE clients
      SET agent_name = ?, agent_tone = ?, agent_avatar_color = ?, agent_role = ?, agent_whatsapp = ?, agent_system_prompt = ?
      WHERE id = ?
    `, [name, tone, avatarColor, role, whatsapp, systemPrompt, id]);

    res.json({ message: 'Agente actualizado con éxito.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Añadir un documento de entrenamiento
app.post('/api/clients/:id/documents', async (req, res) => {
  const { id: clientId } = req.params;
  const { id, title, category, content } = req.body;
  try {
    await db.run(`
      INSERT INTO documents (id, client_id, title, category, content)
      VALUES (?, ?, ?, ?, ?)
    `, [id, clientId, title, category, content]);

    res.status(201).json({ message: 'Documento indexado con éxito.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Eliminar un documento de entrenamiento
app.delete('/api/clients/:id/documents/:docId', async (req, res) => {
  const { id: clientId, docId } = req.params;
  try {
    const result = await db.run('DELETE FROM documents WHERE id = ? AND client_id = ?', [docId, clientId]);
    if (result.changes === 0) return res.status(404).json({ error: 'Documento no encontrado.' });
    await writeAudit('delete_document', 'document', docId, { client_id: clientId });
    res.json({ message: 'Documento eliminado con éxito.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. Registrar un nuevo mensaje de chat
app.post('/api/clients/:id/chats', async (req, res) => {
  const { id: clientId } = req.params;
  const { sender, text, time } = req.body;
  try {
    const result = await db.run(`
      INSERT INTO chats (client_id, sender, text, time)
      VALUES (?, ?, ?, ?)
    `, [clientId, sender, text, time]);

    res.status(201).json({ message: 'Mensaje registrado con éxito.', chatId: result.lastID });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Revisión humana de una respuesta. Una evaluación negativa crea una fuente local
// y una tarea para que el IDE proponga el dato/regla/prueba que corresponda.
app.post('/api/clients/:id/chats/:chatId/feedback', async (req, res) => {
  const { id: clientId, chatId } = req.params;
  const { rating, correctionText = '' } = req.body;
  if (!['up', 'down'].includes(rating)) return res.status(400).json({ error: 'Evaluación inválida.' });
  if (rating === 'down' && !correctionText.trim()) {
    return res.status(400).json({ error: 'Indica cómo debió responder antes de registrar una corrección.' });
  }
  try {
    const chat = await db.get('SELECT id, text, sender FROM chats WHERE id = ? AND client_id = ?', [chatId, clientId]);
    if (!chat) return res.status(404).json({ error: 'Mensaje no encontrado.' });
    if (chat.sender !== 'agent') return res.status(400).json({ error: 'Sólo se evalúan respuestas del agente.' });

    const now = new Date().toISOString();
    const feedbackId = `feedback-${randomUUID()}`;
    let sourceId = null;
    if (rating === 'down') {
      sourceId = `source-${randomUUID()}`;
      const jobId = `job-${randomUUID()}`;
      const sourceContent = `Respuesta original del agente:\n${chat.text}\n\nCorrección indicada por el propietario:\n${correctionText.trim()}`;
      const instructions = 'Analizar esta corrección de conversación. Proponer el dato, regla o flujo necesario y una prueba de regresión; no aplicar cambios automáticamente.';
      await db.run(`
        INSERT INTO source_files (id, client_id, title, source_type, notes, content, status, version_number, created_at)
        VALUES (?, ?, ?, 'note', ?, ?, 'pending_ide', 1, ?)
      `, [sourceId, clientId, `Corrección de conversación · ${now.slice(0, 10)}`, 'Generada desde revisión manual de una respuesta del agente.', sourceContent, now]);
      await db.run(`
        INSERT INTO intake_jobs (id, client_id, source_id, kind, status, instructions, created_at)
        VALUES (?, ?, ?, 'review_conversation_feedback', 'pending_ide', ?, ?)
      `, [jobId, clientId, sourceId, instructions, now]);
      const taskDirectory = path.join(ideInboxRoot, jobId);
      await fs.mkdir(taskDirectory, { recursive: true });
      await fs.writeFile(path.join(taskDirectory, 'task.json'), JSON.stringify({
        standard_version: 1, task_id: jobId, kind: 'review_conversation_feedback', status: 'pending_ide', created_at: now,
        client: { id: clientId }, source: { id: sourceId, type: 'note', content: sourceContent }, instructions,
        expected_output: path.posix.join('.zeroagent', 'proposals', `${jobId}.json`),
        rules: ['No aplicar cambios directamente.', 'Proponer un hecho o regla verificable y una prueba de regresión.']
      }, null, 2), 'utf8');
    }
    await db.run(`
      INSERT INTO conversation_feedback (id, client_id, chat_id, rating, correction_text, source_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [feedbackId, clientId, chatId, rating, correctionText.trim(), sourceId, now]);
    await writeAudit('conversation_feedback', 'chat', String(chatId), { clientId, rating, sourceId });
    res.status(201).json({ message: rating === 'down' ? 'Corrección enviada al flujo de revisión.' : 'Respuesta marcada como correcta.', sourceId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 8. Limpiar chats de un cliente
app.delete('/api/clients/:id/chats', async (req, res) => {
  const { id } = req.params;
  try {
    await db.run('DELETE FROM conversation_feedback WHERE client_id = ?', [id]);
    await db.run('DELETE FROM chats WHERE client_id = ?', [id]);
    res.json({ message: 'Historial de chat limpiado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 9. Endpoint RAG de producción para consulta externa
app.post('/api/clients/:id/retrieve', async (req, res) => {
  const { id: clientId } = req.params;
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'La propiedad "query" es obligatoria.' });
  }

  try {
    // 1. Recuperar documentos heredados y hechos confirmados del cliente.
    const docs = await db.all('SELECT title, content FROM documents WHERE client_id = ?', [clientId]);
    const facts = await db.all(`
      SELECT subject, value, notes FROM knowledge_items
      WHERE client_id = ? AND status = 'approved'
    `, [clientId]);
    const retrievalItems = [
      ...facts.map(fact => ({
        title: `Dato confirmado · ${fact.subject}`,
        content: `${fact.subject}: ${fact.value}${fact.notes ? `\nEvidencia: ${fact.notes}` : ''}`,
        confirmed: true
      })),
      ...docs.map(doc => ({ ...doc, confirmed: false }))
    ];
    
    if (retrievalItems.length === 0) {
      return res.json({ query, retrievedContext: [] });
    }

    // 2. Ejecutar algoritmo de coincidencia de palabras clave en el servidor
    const queryWords = query.toLowerCase()
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "")
      .split(/\s+/)
      .filter(word => word.length > 2);

    if (queryWords.length === 0) {
      return res.json({ query, retrievedContext: retrievalItems.filter(item => item.confirmed).slice(0, 1) });
    }

    const scoredDocs = retrievalItems.map(doc => {
      let score = 0;
      const titleLower = doc.title.toLowerCase();
      const contentLower = doc.content.toLowerCase();

      queryWords.forEach(word => {
        if (titleLower.includes(word)) score += 5;
        const occurrences = contentLower.split(word).length - 1;
        score += occurrences * 1;
      });

      if (doc.confirmed) score += 2;

      return { ...doc, score };
    });

    const retrievedContext = scoredDocs
      .filter(doc => doc.score > 0)
      .sort((a, b) => b.score - a.score);

    res.json({
      query,
      retrievedContext
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/clients/:id/ai-budget', async (req, res) => {
  try {
    if (!(await clientExists(req.params.id))) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const overview = await getAiBudgetOverview(req.params.id);
    const events = await db.all('SELECT kind, amount_clp, notes, created_at FROM ai_budget_events WHERE client_id = ? ORDER BY created_at DESC LIMIT 8', [req.params.id]);
    res.json({ ...overview, events });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/clients/:id/infrastructure', async (req, res) => {
  try {
    if (!(await clientExists(req.params.id))) return res.status(404).json({ error: 'Cliente no encontrado.' });
    const record = await db.get('SELECT supabase_url, project_ref, credential_alias, credential_hint, connection_status, last_checked_at, updated_at FROM client_infrastructure WHERE client_id = ?', [req.params.id]);
    res.json({
      ...(record || { supabase_url: '', project_ref: '', credential_alias: '', credential_hint: '', connection_status: 'not_configured', last_checked_at: null }),
      vault_configured: await localVault.exists(req.params.id)
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Lectura local de mantenimiento: Studio consulta el Supabase del cliente mediante el vault cifrado.
// Nunca se expone esta ruta al runtime ni se copia la credencial al navegador.
app.get('/api/clients/:id/agenda-feedback', async (req, res) => {
  try {
    const infra = await db.get('SELECT supabase_url FROM client_infrastructure WHERE client_id = ?', [req.params.id]);
    if (!infra?.supabase_url || !(await localVault.exists(req.params.id))) return res.status(409).json({ error: 'Configura el vault Supabase del cliente para revisar feedback remoto.' });
    const secret = await localVault.read(req.params.id);
    const [feedbackResponse, outboxResponse] = await Promise.all([
      fetch(`${infra.supabase_url}/rest/v1/za_feedback_items?status=in.(new,reviewing)&select=id,rating,correction_text,status,created_at&order=created_at.desc&limit=20`, { headers: { apikey: secret, authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(8000) }),
      fetch(`${infra.supabase_url}/rest/v1/za_outbox_events?status=eq.pending&select=id,event_type,created_at&order=created_at.desc&limit=20`, { headers: { apikey: secret, authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(8000) })
    ]);
    if (!feedbackResponse.ok || !outboxResponse.ok) return res.status(502).json({ error: 'No se pudieron leer las tablas Agenda; confirma que la migración está ejecutada.' });
    const [feedback, outbox] = await Promise.all([feedbackResponse.json(), outboxResponse.json()]);
    res.json({ feedback, outbox, checkedAt: new Date().toISOString() });
  } catch (error) { res.status(502).json({ error: `No se pudo consultar Agenda remota: ${error.message}` }); }
});

app.put('/api/clients/:id/infrastructure', async (req, res) => {
  const { supabaseUrl = '', projectRef = '', secretKey = '' } = req.body;
  if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl.trim())) {
    return res.status(400).json({ error: 'La URL debe ser un proyecto Supabase válido con HTTPS.' });
  }
  try {
    const now = new Date().toISOString();
    const existing = await db.get('SELECT credential_hint FROM client_infrastructure WHERE client_id = ?', [req.params.id]);
    let hint = existing?.credential_hint || '';
    if (secretKey.trim()) hint = (await localVault.store(req.params.id, secretKey)).hint;
    await db.run(`INSERT INTO client_infrastructure (client_id, supabase_url, project_ref, credential_alias, credential_hint, connection_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET supabase_url=excluded.supabase_url, project_ref=excluded.project_ref, credential_alias=excluded.credential_alias, credential_hint=excluded.credential_hint, connection_status=excluded.connection_status, updated_at=excluded.updated_at`,
      [req.params.id, supabaseUrl.trim().replace(/\/$/, ''), projectRef.trim(), `zeroagent/${req.params.id}/supabase`, hint, hint ? 'saved_unverified' : 'not_configured', now]);
    await writeAudit('infrastructure_saved', 'client', req.params.id, { supabaseUrl: Boolean(supabaseUrl), projectRef, secretStored: Boolean(secretKey.trim()) });
    res.json({ message: 'Infraestructura guardada en vault local.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/clients/:id/infrastructure/test', async (req, res) => {
  try {
    const infra = await db.get('SELECT supabase_url FROM client_infrastructure WHERE client_id = ?', [req.params.id]);
    if (!infra?.supabase_url || !(await localVault.exists(req.params.id))) return res.status(409).json({ error: 'Primero configura URL y credencial del proyecto.' });
    const secret = await localVault.read(req.params.id);
    const headers = { apikey: secret, authorization: `Bearer ${secret}` };
    const [adminResponse, agendaResponse] = await Promise.all([
      fetch(`${infra.supabase_url}/auth/v1/admin/users?page=1&per_page=1`, { headers, signal: AbortSignal.timeout(8000) }),
      fetch(`${infra.supabase_url}/rest/v1/za_agent_controls?select=id&limit=1`, { headers, signal: AbortSignal.timeout(8000) })
    ]);
    const now = new Date().toISOString();
    const ok = adminResponse.ok && agendaResponse.ok;
    await db.run('UPDATE client_infrastructure SET connection_status = ?, last_checked_at = ?, updated_at = ? WHERE client_id = ?', [ok ? 'connected' : 'failed', now, now, req.params.id]);
    if (!adminResponse.ok) return res.status(502).json({ error: `La credencial no tiene autoridad de service role (${adminResponse.status}).` });
    if (!agendaResponse.ok) return res.status(502).json({ error: `Supabase respondió, pero Agenda v1 no está instalada o accesible (${agendaResponse.status}).` });
    await writeAudit('infrastructure_connection_tested', 'client', req.params.id, { authStatus: adminResponse.status, agendaStatus: agendaResponse.status });
    res.json({ message: 'Service role y esquema Agenda v1 verificados.', status: agendaResponse.status });
  } catch (error) { res.status(502).json({ error: `No se pudo verificar: ${error.message}` }); }
});

app.delete('/api/clients/:id/infrastructure', async (req, res) => {
  try {
    await localVault.remove(req.params.id);
    await db.run('DELETE FROM client_infrastructure WHERE client_id = ?', [req.params.id]);
    await writeAudit('infrastructure_removed', 'client', req.params.id, {});
    res.json({ message: 'Credencial local revocada y olvidada.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/clients/:id/ai-budget', async (req, res) => {
  const { provider = 'openai', model = 'gpt-4o-mini', cycleBudgetClp, usdClp = 922, paused = false } = req.body;
  if (!Number.isFinite(Number(cycleBudgetClp)) || Number(cycleBudgetClp) < 0) return res.status(400).json({ error: 'Presupuesto inválido.' });
  try {
    const now = new Date().toISOString();
    await db.run(`INSERT INTO ai_budget_configs (client_id, provider, model, cycle_budget_clp, usd_clp, cycle_started_at, paused, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET provider=excluded.provider, model=excluded.model, cycle_budget_clp=excluded.cycle_budget_clp, usd_clp=excluded.usd_clp, paused=excluded.paused, updated_at=excluded.updated_at`,
      [req.params.id, provider, model, Number(cycleBudgetClp), Number(usdClp), now, paused ? 1 : 0, now]);
    await writeAudit('ai_budget_configured', 'client', req.params.id, { provider, model, cycleBudgetClp, paused });
    res.json(await getAiBudgetOverview(req.params.id));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/clients/:id/ai-budget/recharge', async (req, res) => {
  const { amountClp, notes = '' } = req.body;
  if (!Number.isFinite(Number(amountClp)) || Number(amountClp) <= 0) return res.status(400).json({ error: 'Indica un monto de recarga válido.' });
  try {
    const existing = await getAiBudgetOverview(req.params.id);
    const now = new Date().toISOString();
    await db.run(`INSERT INTO ai_budget_configs (client_id, provider, model, cycle_budget_clp, usd_clp, cycle_started_at, paused, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(client_id) DO UPDATE SET cycle_budget_clp=excluded.cycle_budget_clp, cycle_started_at=excluded.cycle_started_at, paused=0, updated_at=excluded.updated_at`,
      [req.params.id, existing.config.provider, existing.config.model, Number(amountClp), existing.config.usd_clp, now, now]);
    await db.run('INSERT INTO ai_budget_events (id, client_id, kind, amount_clp, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [`budget-${randomUUID()}`, req.params.id, 'recharge_reset', Number(amountClp), notes.trim(), now]);
    await writeAudit('ai_budget_recharged', 'client', req.params.id, { amountClp });
    res.json(await getAiBudgetOverview(req.params.id));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// El runtime del cliente puede enviar telemetría a esta ruta cuando ZeroAgent sea accesible.
app.post('/api/clients/:id/ai-usage', async (req, res) => {
  const { provider = 'openai', model = 'gpt-4o-mini', inputTokens = 0, outputTokens = 0, conversationRef = '', source = 'runtime' } = req.body;
  if (process.env.ZEROAGENT_METRICS_TOKEN && req.headers.authorization !== `Bearer ${process.env.ZEROAGENT_METRICS_TOKEN}`) {
    return res.status(401).json({ error: 'Telemetría no autorizada.' });
  }
  try {
    const cost = estimateUsageUsd(model, inputTokens, outputTokens);
    await db.run(`INSERT INTO ai_usage_records (id, client_id, occurred_at, provider, model, input_tokens, output_tokens, estimated_cost_usd, conversation_ref, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`usage-${randomUUID()}`, req.params.id, new Date().toISOString(), provider, model, Number(inputTokens) || 0, Number(outputTokens) || 0, cost, conversationRef, source]);
    res.status(201).json({ estimatedCostUsd: cost, ...(await getAiBudgetOverview(req.params.id)) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Playground de calidad: ejecuta exactamente el mismo motor y contrato de herramientas del runtime.
// Sin versionId prueba el ESTADO VIVO del cliente (para iterar el entrenamiento sin construir una
// versión cada vez); con versionId valida el paquete exacto de esa versión (lo que se despliega).
// En ambos casos es el mismo motor, prompt, capa de comportamiento y herramientas del runtime.
app.post('/api/clients/:id/playground/chat', async (req, res) => {
  const { id: clientId } = req.params;
  const { message, history = [], versionId = '', callerPhone = '' } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Escribe un mensaje para probar el agente.' });
  try {
    let packageData;
    let versionMeta;
    if (versionId) {
      const version = await db.get('SELECT id, version, status, package_json FROM agent_versions WHERE id = ? AND client_id = ?', [versionId, clientId]);
      if (!version) return res.status(404).json({ error: 'Versión no encontrada.' });
      packageData = JSON.parse(version.package_json);
      versionMeta = { id: version.id, number: version.version, status: version.status };
    } else {
      packageData = await buildClientPackage(clientId);
      if (!packageData) return res.status(404).json({ error: 'Cliente no encontrado.' });
      versionMeta = { id: null, number: 'preview', status: 'live_preview' };
    }
    const startedAt = Date.now();
    const result = await answerWithRuntimeEngine(packageData, message.trim(), {
      history,
      callerPhone,
      conversationId: `studio-playground:${clientId}`,
      allowDeterministicFallback: true
    });
    const inputTokens = Number(result.usage?.inputTokens) || 0;
    const outputTokens = Number(result.usage?.outputTokens) || 0;
    await db.run(`INSERT INTO ai_usage_records (id, client_id, occurred_at, provider, model, input_tokens, output_tokens, estimated_cost_usd, conversation_ref, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'playground', 'studio_playground')`,
      [`usage-${randomUUID()}`, clientId, new Date().toISOString(), result.provider || 'deterministic', result.model || 'deterministic', inputTokens, outputTokens]);
    const sources = new Set(Array.isArray(result.source) ? result.source : [result.source].filter(Boolean));
    const retrievedContext = (packageData.knowledge?.confirmed_facts || []).filter(fact => sources.has(fact.subject));
    res.json({
      reply: result.text,
      modelUsed: result.model ? `${result.provider} · ${result.model}` : result.provider,
      latency: Date.now() - startedAt,
      retrievedContext,
      toolTrace: result.toolTrace || [],
      version: versionMeta
    });
  } catch (error) {
    res.status(502).json({ error: `No se pudo ejecutar el motor del runtime: ${error.message}` });
  }
});

// Importar base de datos JSON completa (reemplazar base de datos)
app.get('/api/settings/export', async (req, res) => {
  try {
    const snapshotPath = await createDataSnapshot('manual-export');
    res.download(snapshotPath, `zeroagent-backup-${new Date().toISOString().slice(0, 10)}.json`);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings/import', async (req, res) => {
  const snapshot = req.body;
  const tables = snapshot?.tables;
  const restoreOrder = [
    'clients', 'audit_events', 'source_files', 'intake_jobs', 'agent_versions',
    'documents', 'knowledge_items', 'agent_tests', 'chats', 'conversation_feedback',
    'ai_budget_configs', 'ai_usage_records', 'ai_budget_events', 'client_infrastructure',
    'agenda_configs', 'onboarding_sessions', 'onboarding_responses', 'onboarding_files',
    'commercial_leads', 'prospecting_searches', 'prospects', 'prospect_activities'
  ];
  if (snapshot?.snapshot_version !== 2 || !tables || !restoreOrder.every(table => Array.isArray(tables[table]))) {
    return res.status(400).json({ error: 'El archivo no es un respaldo ZeroAgent v2 completo. No se modificó la base de datos.' });
  }
  try {
    const snapshotPath = await createDataSnapshot('before-import');
    await db.exec('PRAGMA foreign_keys = OFF;');
    await db.exec('BEGIN IMMEDIATE;');
    try {
      for (const table of [...restoreOrder].reverse()) await db.exec(`DELETE FROM ${table};`);
      for (const table of restoreOrder) {
        const columns = (await db.all(`PRAGMA table_info(${table});`)).map(item => item.name);
        for (const row of tables[table]) {
          const rowColumns = columns.filter(column => Object.hasOwn(row, column));
          if (!rowColumns.length) continue;
          await db.run(`INSERT INTO ${table} (${rowColumns.map(column => `"${column}"`).join(', ')}) VALUES (${rowColumns.map(() => '?').join(', ')})`, rowColumns.map(column => row[column] ?? null));
        }
      }
      await db.exec('COMMIT;');
    } catch (error) {
      await db.exec('ROLLBACK;');
      throw error;
    } finally {
      await db.exec('PRAGMA foreign_keys = ON;');
    }
    await writeAudit('import_database', 'database', 'local', { snapshot_path: snapshotPath, clients_imported: tables.clients.length });
    res.json({ message: 'Respaldo completo restaurado con éxito.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Resetear base de datos completa a los valores por defecto
app.post('/api/settings/reset', async (req, res) => {
  try {
    const snapshotPath = await createDataSnapshot('before-reset');
    await db.exec('DELETE FROM prospect_activities;');
    await db.exec('DELETE FROM prospects;');
    await db.exec('DELETE FROM prospecting_searches;');
    await db.exec('DELETE FROM commercial_leads;');
    await db.exec('DELETE FROM intake_jobs;');
    await db.exec('DELETE FROM agent_versions;');
    await db.exec('DELETE FROM agent_tests;');
    await db.exec('DELETE FROM knowledge_items;');
    await db.exec('DELETE FROM source_files;');
    await db.exec('DELETE FROM conversation_feedback;');
    await db.exec('DELETE FROM chats;');
    await db.exec('DELETE FROM documents;');
    await db.exec('DELETE FROM clients;');
    
    // Forzar re-sembrado de manera segura sin re-abrir la conexión SQLite
    await seedDatabase();
    await writeAudit('reset_database', 'database', 'local', { snapshot_path: snapshotPath });
    res.json({ message: 'Base de datos re-establecida a los valores iniciales.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ARRANQUE DEL SERVIDOR
// ==========================================
initDatabase()
  .then(() => {
    app.listen(PORT, '127.0.0.1', () => {
      console.log(`\n==========================================`);
      console.log(`🚀 ZeroAgent Backend activo en puerto ${PORT}`);
      console.log(`🌐 Acceso local: http://localhost:${PORT}`);
      console.log(`==========================================\n`);
    });
  })
  .catch(err => {
    console.error('Error al inicializar la base de datos:', err);
  });
