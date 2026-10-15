import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Datos e Info de inyección directa: a diferencia de knowledge.js (sugerencias que nacen
// 'pending' y esperan aprobación en Studio), esto lo escribe el dueño del negocio desde su
// propia consola y el agente lo usa de inmediato — no pasa por revisión de Daniel+Claude.
// DATOS = ficha estructurada (label + value): precio, dirección, teléfono, horario.
// INFO  = texto suelto que no calza en una ficha, pero el agente debe poder citar igual.

function statePathFor(packageData, kind) {
  const scope = String(packageData.business?.id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(root, 'storage', `${kind}-${scope}.json`);
}

async function loadState(packageData, kind) {
  try { return JSON.parse(await fs.readFile(statePathFor(packageData, kind), 'utf8')); }
  catch { return { items: [] }; }
}

async function saveState(packageData, kind, state) {
  const statePath = statePathFor(packageData, kind);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporary, statePath);
}

export async function listBusinessData(packageData) {
  if (agendaUsesSupabase()) {
    return await agendaSupabaseRequest('/rest/v1/za_business_data?active=eq.true&select=*&order=created_at.desc&limit=200');
  }
  const state = await loadState(packageData, 'business-data');
  return (state.items || []).filter(item => item.active !== false);
}

export async function addBusinessData(packageData, input = {}) {
  const label = String(input.label || '').trim().slice(0, 140);
  const value = String(input.value || '').trim().slice(0, 500);
  const category = String(input.category || 'general').trim().slice(0, 80) || 'general';
  if (!label || !value) throw new Error('Indica el nombre del dato y su valor.');
  if (agendaUsesSupabase()) {
    const rows = await agendaSupabaseRequest('/rest/v1/za_business_data', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ label, value, category })
    });
    return rows[0];
  }
  const state = await loadState(packageData, 'business-data');
  const entry = { id: `data-${randomUUID()}`, label, value, category, active: true, created_at: new Date().toISOString() };
  state.items = [entry, ...(state.items || [])].slice(0, 200);
  await saveState(packageData, 'business-data', state);
  return entry;
}

export async function listBusinessInfo(packageData) {
  if (agendaUsesSupabase()) {
    return await agendaSupabaseRequest('/rest/v1/za_business_info?active=eq.true&select=*&order=created_at.desc&limit=200');
  }
  const state = await loadState(packageData, 'business-info');
  return (state.items || []).filter(item => item.active !== false);
}

export async function addBusinessInfo(packageData, input = {}) {
  const text = String(input.text || '').trim().slice(0, 1000);
  if (!text) throw new Error('Escribe la información que quieres que el agente sepa.');
  if (agendaUsesSupabase()) {
    const rows = await agendaSupabaseRequest('/rest/v1/za_business_info', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ text })
    });
    return rows[0];
  }
  const state = await loadState(packageData, 'business-info');
  const entry = { id: `info-${randomUUID()}`, text, active: true, created_at: new Date().toISOString() };
  state.items = [entry, ...(state.items || [])].slice(0, 200);
  await saveState(packageData, 'business-info', state);
  return entry;
}

// Hechos listos para el contexto del LLM, en el mismo formato {id, category, subject, value}
// que ya usa engine.js para las confirmed_facts horneadas — así se mezclan sin distinción.
// Hechos confirmados del agente (za_knowledge_facts): reemplazan a los confirmed_facts horneados
// en el paquete cuando el negocio ya los tiene en la base. Se marcan from_knowledge_table para que
// engine.js sepa que la base es la fuente y no mezcle con el paquete.
export async function listKnowledgeFacts() {
  if (!agendaUsesSupabase()) return [];
  const rows = await agendaSupabaseRequest('/rest/v1/za_knowledge_facts?active=eq.true&select=id,category,subject,value,visibility&order=category.asc,subject.asc&limit=200');
  return (rows || []).map(item => ({ ...item, visibility: item.visibility === 'internal' ? 'internal' : 'public', from_knowledge_table: true }));
}

export async function liveInjectedFacts(packageData) {
  const [knowledge, data, info] = await Promise.all([
    // Si la tabla todavía no existe (negocio sin la migración) o la consulta falla, se sigue con
    // el paquete: un error acá nunca puede dejar al agente sin conocimiento.
    listKnowledgeFacts().catch(() => []),
    listBusinessData(packageData).catch(() => []),
    listBusinessInfo(packageData).catch(() => [])
  ]);
  return [
    ...knowledge,
    ...data.map(item => ({ id: item.id, category: item.category || 'general', subject: item.label, value: item.value, visibility: 'public' })),
    ...info.map(item => ({ id: item.id, category: 'info', subject: 'Información del negocio', value: item.text, visibility: 'public' }))
  ];
}
