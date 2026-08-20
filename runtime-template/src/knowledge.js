import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function statePathFor(packageData) {
  const scope = String(packageData.business?.id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(root, 'storage', `knowledge-suggestions-${scope}.json`);
}

async function loadState(packageData) {
  try { return JSON.parse(await fs.readFile(statePathFor(packageData), 'utf8')); }
  catch { return { suggestions: [] }; }
}

async function saveState(packageData, state) {
  const statePath = statePathFor(packageData);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporary, statePath);
}

// Lo que el agente ya sabe hoy: viene horneado en el build, de solo lectura desde el runtime.
// Para cambiarlo de verdad hay que aprobarlo en el Studio y reconstruir — acá el cliente sólo
// ve el estado actual y puede dejar una sugerencia para que alguien la revise.
export function currentConfirmedFacts(packageData) {
  return (packageData.knowledge?.confirmed_facts || []).map(fact => ({
    id: fact.id, category: fact.category, subject: fact.subject, value: fact.value
  }));
}

export async function listKnowledgeSuggestions(packageData) {
  if (agendaUsesSupabase()) {
    return await agendaSupabaseRequest('/rest/v1/za_knowledge_suggestions?select=*&order=created_at.desc&limit=200');
  }
  const state = await loadState(packageData);
  return state.suggestions || [];
}

export async function addKnowledgeSuggestion(packageData, input = {}) {
  const category = String(input.category || '').trim().slice(0, 80);
  const subject = String(input.subject || '').trim().slice(0, 140);
  const value = String(input.value || '').trim().slice(0, 2000);
  if (!category || !subject || !value) throw new Error('Indica categoría, asunto y el dato completo.');
  if (agendaUsesSupabase()) {
    const rows = await agendaSupabaseRequest('/rest/v1/za_knowledge_suggestions', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ category, subject, value })
    });
    return rows[0];
  }
  const state = await loadState(packageData);
  const entry = { id: `sugg-${randomUUID()}`, category, subject, value, status: 'pending', created_at: new Date().toISOString() };
  state.suggestions = [entry, ...(state.suggestions || [])].slice(0, 200);
  await saveState(packageData, state);
  return entry;
}
