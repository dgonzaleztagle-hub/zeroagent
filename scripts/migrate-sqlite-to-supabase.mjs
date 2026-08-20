// Fase 2 del plan de migración de Studio (C:\Users\dgonz\.claude\plans\parallel-chasing-bee.md):
// copia una sola vez todas las filas de database.sqlite al Supabase propio de Studio.
// Lee database.sqlite en modo solo-lectura, nunca escribe ahí. Requiere STUDIO_SUPABASE_URL y
// STUDIO_SUPABASE_SERVICE_ROLE_KEY en el entorno (ya están en .env, server.js los carga solo si
// se corre con `node --env-file=.env scripts/migrate-sqlite-to-supabase.mjs`).
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.ZEROAGENT_DB_PATH ? path.resolve(process.env.ZEROAGENT_DB_PATH) : path.join(__dirname, '..', 'database.sqlite');
const supabaseUrl = String(process.env.STUDIO_SUPABASE_URL || '').replace(/\/$/, '');
const supabaseKey = process.env.STUDIO_SUPABASE_SERVICE_ROLE_KEY || '';
if (!supabaseUrl || !supabaseKey) throw new Error('Falta STUDIO_SUPABASE_URL/STUDIO_SUPABASE_SERVICE_ROLE_KEY en el entorno.');

// Mismo orden que restoreOrder en server.js:2837-2843 (dependencia FK, padres antes que hijos).
const TABLE_ORDER = [
  'clients', 'audit_events', 'source_files', 'intake_jobs', 'agent_versions',
  'documents', 'knowledge_items', 'agent_tests', 'chats', 'conversation_feedback',
  'ai_budget_configs', 'ai_usage_records', 'ai_budget_events', 'client_infrastructure',
  'agenda_configs', 'onboarding_sessions', 'onboarding_responses', 'onboarding_files',
  'commercial_leads', 'prospecting_searches', 'prospects', 'prospect_activities'
];

// Columnas JSON-como-TEXT en SQLite -> jsonb real en Postgres. intake_jobs.proposal_json es un
// caso especial: default '' (string vacío), no '{}' — mapea a NULL, nunca a objeto vacío.
const JSON_COLUMNS = {
  audit_events: ['details_json'],
  intake_jobs: ['proposal_json'],
  agent_versions: ['package_json'],
  agenda_configs: ['config_json'],
  onboarding_responses: ['data_json'],
  prospects: ['signals_json'],
  prospect_activities: ['metadata_json'],
  agent_tests: ['last_result']
};
const EMPTY_STRING_MEANS_NULL = new Set(['proposal_json', 'last_result']);

// Columnas 0/1 (SQLite INTEGER) -> boolean real en Postgres.
const BOOLEAN_COLUMNS = {
  ai_budget_configs: ['alert_50', 'alert_75', 'alert_90', 'paused'],
  client_infrastructure: ['migration_applied', 'catalog_seeded', 'env_vars_set']
};

function transformRow(table, row) {
  const out = { ...row };
  for (const col of JSON_COLUMNS[table] || []) {
    const raw = out[col];
    if (raw === null || raw === undefined || (EMPTY_STRING_MEANS_NULL.has(col) && raw === '')) {
      out[col] = null;
    } else {
      try { out[col] = JSON.parse(raw); } catch (error) {
        throw new Error(`No se pudo parsear ${table}.${col} (id=${row.id}): ${error.message}`);
      }
    }
  }
  for (const col of BOOLEAN_COLUMNS[table] || []) {
    if (out[col] !== null && out[col] !== undefined) out[col] = Boolean(out[col]);
  }
  return out;
}

async function postBatch(table, rows) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}`, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`POST /rest/v1/${table} respondió ${response.status}: ${body}`);
  }
}

async function countRemote(table) {
  // select=* (no "id") porque client_infrastructure y agenda_configs usan client_id como PK,
  // no tienen columna id — select=id fallaba en silencio para esas dos (bug encontrado en vivo).
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}`, prefer: 'count=exact' }
  });
  if (!response.ok) throw new Error(`Conteo de ${table} falló: ${response.status} ${await response.text()}`);
  const range = response.headers.get('content-range') || '*/0';
  return Number(range.split('/')[1] || 0);
}

async function main() {
  console.log(`Abriendo ${dbPath} (solo lectura)...`);
  const db = await open({ filename: dbPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });

  const summary = [];
  for (const table of TABLE_ORDER) {
    const rows = await db.all(`SELECT * FROM ${table}`);
    if (!rows.length) { summary.push({ table, local: 0, sent: 0 }); console.log(`${table}: 0 filas, se omite.`); continue; }
    const transformed = rows.map(row => transformRow(table, row));
    const BATCH = 500;
    let sent = 0;
    for (let i = 0; i < transformed.length; i += BATCH) {
      const batch = transformed.slice(i, i + BATCH);
      await postBatch(table, batch);
      sent += batch.length;
    }
    summary.push({ table, local: rows.length, sent });
    console.log(`${table}: ${sent}/${rows.length} filas enviadas.`);
  }
  await db.close();

  console.log('\nVerificando conteo remoto por tabla...');
  let allOk = true;
  for (const { table, local } of summary) {
    const remote = await countRemote(table);
    const ok = remote === local;
    if (!ok) allOk = false;
    console.log(`${ok ? 'OK ' : 'MISMATCH '} ${table}: local=${local} remoto=${remote}`);
  }
  if (!allOk) { console.error('\nHay tablas con conteo distinto — no renombres database.sqlite todavía.'); process.exit(1); }
  console.log('\nTodos los conteos coinciden.');

  // BUG ENCONTRADO EN VIVO (19-08-2026): audit_events.id y chats.id son GENERATED BY DEFAULT AS
  // IDENTITY. Insertar filas con su id original (como hace este script, para preservar
  // referencias como conversation_feedback.chat_id) NO avanza la secuencia interna de Postgres —
  // el próximo INSERT sin id explícito (ej. writeAudit() en server.js) intenta usar nextval()=1 y
  // choca con la fila id=1 ya migrada. Sin este paso, el primer log de auditoría o el primer chat
  // nuevo después de migrar revientan con "duplicate key value violates unique constraint".
  console.log('\nSincronizando secuencias de identity (audit_events, chats)...');
  const seqSql = `select setval(pg_get_serial_sequence('public.audit_events','id'), coalesce((select max(id) from public.audit_events),1));`
    + ` select setval(pg_get_serial_sequence('public.chats','id'), coalesce((select max(id) from public.chats),1));`;
  // No hay endpoint de "ejecutar SQL crudo" en PostgREST — esto se corre una vez a mano vía
  // Management API (ver credenciales en ~/.claude/credenciales/zeroagent-studio-supabase.md) si
  // este script se vuelve a correr contra un proyecto con datos previos. No se automatiza acá
  // porque el PAT de Management API no debe vivir en un script versionado del repo.
  console.log('Corre esto manualmente vía Management API si vuelves a ejecutar este script:');
  console.log(seqSql);
}

main().catch(error => { console.error(error); process.exit(1); });
