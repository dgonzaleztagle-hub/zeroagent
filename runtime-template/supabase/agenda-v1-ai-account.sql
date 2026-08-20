-- ZeroAgent Agenda · cuenta de IA elegida por el negocio.
-- Aplicar después de agenda-v1.sql. Las claves BYOK quedan cifradas por el runtime con
-- AI_CREDENTIALS_ENCRYPTION_KEY; esta tabla nunca se expone al navegador ni a roles públicos.

create table if not exists public.za_ai_settings (
  id text primary key default 'primary' check (id = 'primary'),
  mode text not null default 'byok' check (mode = 'byok'),
  byok_provider text not null default '',
  byok_model text not null default '',
  byok_base_url text not null default '',
  credential_ciphertext text not null default '',
  credential_iv text not null default '',
  credential_tag text not null default '',
  credential_hint text not null default '',
  updated_at timestamptz not null default now(),
  check (byok_provider <> '' and byok_model <> '' and credential_ciphertext <> '')
);

create table if not exists public.za_ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model text not null,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  source text not null default 'runtime',
  conversation_ref text,
  occurred_at timestamptz not null default now()
);

create index if not exists za_ai_usage_events_occurred_idx on public.za_ai_usage_events (occurred_at desc);

alter table public.za_ai_settings enable row level security;
alter table public.za_ai_usage_events enable row level security;
revoke all on public.za_ai_settings from anon, authenticated;
revoke all on public.za_ai_usage_events from anon, authenticated;
