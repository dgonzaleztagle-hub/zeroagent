-- ZeroAgent Agenda · conexión de Google Calendar (vitrina/espejo, un negocio = una fila).
-- Aplicar después de agenda-v1.sql. El refresh_token queda cifrado por el runtime con
-- AI_CREDENTIALS_ENCRYPTION_KEY (mismo secreto simétrico que ya protege las claves BYOK);
-- esta tabla nunca se expone al navegador ni a roles públicos.

create table if not exists public.za_google_calendar_settings (
  id text primary key default 'primary' check (id = 'primary'),
  google_account_email text not null default '',
  google_calendar_id text not null default 'primary',
  refresh_token_ciphertext text not null default '',
  refresh_token_iv text not null default '',
  refresh_token_tag text not null default '',
  connected_at timestamptz,
  connected_by_operator_id uuid references public.za_operators(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (google_account_email = '' or refresh_token_ciphertext <> '')
);

alter table public.za_google_calendar_settings enable row level security;
revoke all on public.za_google_calendar_settings from anon, authenticated;
