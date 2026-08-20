import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { agendaSupabaseRequest, agendaUsesSupabase } from './agenda.js';

const SETTINGS_ID = 'primary';
const PROVIDER_ENDPOINTS = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1'
};

function clean(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function encryptionKey() {
  const value = clean(process.env.AI_CREDENTIALS_ENCRYPTION_KEY, 200);
  if (!value) throw new Error('Falta AI_CREDENTIALS_ENCRYPTION_KEY para guardar una clave propia.');
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('AI_CREDENTIALS_ENCRYPTION_KEY debe contener exactamente 32 bytes en base64 o 64 caracteres hex.');
  return key;
}

function encryptCredential(apiKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return {
    credential_ciphertext: ciphertext.toString('base64'),
    credential_iv: iv.toString('base64'),
    credential_tag: cipher.getAuthTag().toString('base64'),
    credential_hint: `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`
  };
}

function decryptCredential(settings) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(settings.credential_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(settings.credential_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(settings.credential_ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

async function storedSettings() {
  if (!agendaUsesSupabase()) return null;
  try {
    const rows = await agendaSupabaseRequest(`/rest/v1/za_ai_settings?id=eq.${SETTINGS_ID}&select=*&limit=1`);
    return rows?.[0] || null;
  } catch (error) {
    if (/za_ai_settings|does not exist|schema cache/i.test(error.message)) return null;
    throw error;
  }
}

function allowedCompatibleHosts() {
  return new Set(clean(process.env.AI_ALLOWED_COMPATIBLE_HOSTS, 2000).split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
}

function providerBaseUrl(provider, requestedUrl = '') {
  if (PROVIDER_ENDPOINTS[provider]) return PROVIDER_ENDPOINTS[provider];
  if (provider !== 'compatible') throw new Error('Proveedor BYOK no soportado por este runtime.');
  const parsed = new URL(clean(requestedUrl, 500));
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('La URL compatible debe usar HTTPS y no incluir credenciales.');
  if (!allowedCompatibleHosts().has(parsed.hostname.toLowerCase())) throw new Error('El host compatible no está autorizado por ZeroAgent para este despliegue.');
  return parsed.toString().replace(/\/$/, '');
}

export async function getPublicAiAccount() {
  const selection = await storedSettings();
  const selected = selection ? {
    mode: selection.mode,
    byokProvider: selection.byok_provider || '',
    byokModel: selection.byok_model || '',
    byokBaseUrl: selection.byok_base_url || '',
    credentialConfigured: Boolean(selection.credential_ciphertext),
    credentialHint: selection.credential_hint || '',
    updatedAt: selection.updated_at
  } : {
    mode: 'environment',
    credentialConfigured: false,
    updatedAt: null
  };
  return { selection: selected };
}

export async function updateAiSelection(input = {}) {
  if (!agendaUsesSupabase()) throw new Error('La selección de IA requiere el Supabase del cliente.');
  const mode = clean(input.mode, 20);
  if (mode !== 'byok') throw new Error('El modo de IA debe ser byok.');
  const now = new Date().toISOString();
  const current = await storedSettings();
  const provider = clean(input.provider, 40);
  const model = clean(input.model, 160);
  if (!model) throw new Error('Indica el modelo que utilizará la clave propia.');
  const baseUrl = providerBaseUrl(provider, input.baseUrl);
  const apiKey = clean(input.apiKey, 1000);
  const encrypted = apiKey
    ? encryptCredential(apiKey)
    : current?.mode === 'byok' && current.credential_ciphertext
      ? {
          credential_ciphertext: current.credential_ciphertext,
          credential_iv: current.credential_iv,
          credential_tag: current.credential_tag,
          credential_hint: current.credential_hint
        }
      : null;
  if (!encrypted) throw new Error('Ingresa la API key del proveedor para activar BYOK.');
  const record = {
    id: SETTINGS_ID, mode, byok_provider: provider,
    byok_model: model, byok_base_url: baseUrl, ...encrypted, updated_at: now
  };
  await agendaSupabaseRequest('/rest/v1/za_ai_settings?on_conflict=id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(record)
  });
  return getPublicAiAccount();
}

export async function resolveRuntimeLlmConfig() {
  const selection = await storedSettings();
  if (selection?.mode === 'byok') {
    return {
      provider: selection.byok_provider,
      apiKey: decryptCredential(selection),
      baseUrl: providerBaseUrl(selection.byok_provider, selection.byok_base_url),
      model: selection.byok_model
    };
  }
  return null;
}
