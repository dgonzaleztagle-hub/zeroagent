-- ZeroAgent Agenda v1 · esquema por cliente
-- Ejecutar una vez en el proyecto Supabase que pertenece al cliente.
-- La API pública sólo crea solicitudes mediante la RPC controlada; nunca recibe acceso directo a tablas.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- Versionado mínimo de esquema. Cada hardening incremental registra una clave estable y puede
-- volver a ejecutarse sin duplicar datos ni depender del historial local del instalador.
create table if not exists public.za_schema_migrations (
  version text primary key,
  description text not null default '',
  applied_at timestamptz not null default now()
);

do $$ begin
  create type public.za_appointment_status as enum (
    'pending_confirmation', 'confirmed', 'cancelled', 'completed', 'no_show', 'rejected'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.za_agent_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  manifest jsonb not null default '{}'::jsonb,
  status text not null check (status in ('draft', 'staging', 'production', 'retired')),
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create table if not exists public.za_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null default '',
  timezone text not null default 'America/Santiago',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.za_services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  duration_minutes integer not null check (duration_minutes between 5 and 720),
  price_clp integer check (price_clp is null or price_clp >= 0),
  active boolean not null default true,
  -- Servicio que el negocio no gestiona directamente (ej. atención en un centro de terceros):
  -- nunca se agenda ni deriva a handoff por ningún canal, sólo redirige con `redirect_note`.
  bookable boolean not null default true,
  redirect_note text not null default '',
  created_at timestamptz not null default now(),
  unique (name)
);
-- Upgrade seguro para instalaciones creadas con una revisión anterior de Agenda v1.
alter table public.za_services add column if not exists bookable boolean not null default true;
alter table public.za_services add column if not exists redirect_note text not null default '';

create table if not exists public.za_resources (
  id uuid primary key default gen_random_uuid(),
  location_id uuid references public.za_locations(id) on delete set null,
  name text not null,
  specialty text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (name)
);

create table if not exists public.za_resource_services (
  resource_id uuid not null references public.za_resources(id) on delete cascade,
  service_id uuid not null references public.za_services(id) on delete cascade,
  primary key (resource_id, service_id)
);

-- Horario semanal explícito. Nunca se interpreta texto libre como disponibilidad real.
create table if not exists public.za_availability_rules (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.za_resources(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  starts_at time not null,
  ends_at time not null,
  active boolean not null default true,
  check (ends_at > starts_at),
  unique (resource_id, day_of_week, starts_at, ends_at)
);

create table if not exists public.za_availability_blocks (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.za_resources(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null default '',
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.za_customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null,
  email text,
  age integer,
  occupation text,
  medical_history text,
  extra_symptoms text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (phone)
);
alter table public.za_customers add column if not exists email text;
alter table public.za_customers add column if not exists age integer;
alter table public.za_customers add column if not exists occupation text;
alter table public.za_customers add column if not exists medical_history text;
alter table public.za_customers add column if not exists extra_symptoms text;
alter table public.za_customers add column if not exists segment text not null default 'frio' check (segment in ('frio', 'caliente', 'cliente'));

create table if not exists public.za_appointments (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('ZA-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  customer_id uuid not null references public.za_customers(id),
  location_id uuid references public.za_locations(id) on delete set null,
  service_id uuid not null references public.za_services(id),
  resource_id uuid not null references public.za_resources(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.za_appointment_status not null default 'pending_confirmation',
  source text not null check (source in ('public_booking', 'client_console', 'whatsapp', 'staff')),
  notes text not null default '',
  agent_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  check (ends_at > starts_at)
);
alter table public.za_appointments add column if not exists expires_at timestamptz;
update public.za_appointments
set expires_at = created_at + interval '120 minutes'
where status = 'pending_confirmation' and expires_at is null;
do $$ begin
  alter table public.za_appointments add constraint za_pending_appointment_has_expiry
    check (status <> 'pending_confirmation' or expires_at is not null);
exception when duplicate_object then null;
end $$;
create index if not exists za_appointments_resource_time_idx on public.za_appointments(resource_id, starts_at);
create index if not exists za_appointments_customer_idx on public.za_appointments(customer_id, starts_at desc);
create index if not exists za_appointments_pending_expiry_idx on public.za_appointments(expires_at) where status = 'pending_confirmation';

create table if not exists public.za_conversations (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('whatsapp', 'web_preview', 'client_console')),
  external_id text,
  customer_id uuid references public.za_customers(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'handoff', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, external_id)
);

-- Equipo del cliente: la IA no es el dueño de un caso. Cuando requiere una persona,
-- la conversación conserva responsable, prioridad y contexto de traspaso.
create table if not exists public.za_operators (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique,
  role text not null default 'operator' check (role in ('owner', 'manager', 'operator')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Freno operativo del dueño. Es independiente del traspaso por conversación:
-- un incidente puede exigir pausar todas las respuestas automáticas sin apagar el runtime.
create table if not exists public.za_agent_controls (
  id boolean primary key default true check (id),
  mode text not null default 'active' check (mode in ('active', 'paused')),
  paused_reason text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.za_conversations add column if not exists assigned_owner_id uuid references public.za_operators(id) on delete set null;
alter table public.za_conversations add column if not exists priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent'));
alter table public.za_conversations add column if not exists needs_human boolean not null default false;
alter table public.za_conversations add column if not exists handoff_reason text not null default '';
create index if not exists za_conversations_operation_idx on public.za_conversations(status, needs_human, priority, updated_at desc);

create table if not exists public.za_conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.za_conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  content text not null,
  tool_trace jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.za_conversation_messages add column if not exists sender_type text not null default 'agent' check (sender_type in ('agent', 'human', 'system'));
alter table public.za_conversation_messages add column if not exists delivery_status text not null default 'sent' check (delivery_status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed'));
alter table public.za_conversation_messages add column if not exists client_message_id text;
alter table public.za_conversation_messages add column if not exists provider_message_id text;
alter table public.za_conversation_messages add column if not exists failure_reason text;
alter table public.za_conversation_messages add column if not exists delivered_at timestamptz;
drop index if exists public.za_conversation_messages_client_id_idx;
create unique index za_conversation_messages_client_id_idx on public.za_conversation_messages(client_message_id);
create unique index if not exists za_conversation_messages_provider_id_idx on public.za_conversation_messages(provider_message_id);

create table if not exists public.za_feedback_items (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.za_conversations(id) on delete set null,
  message_id uuid references public.za_conversation_messages(id) on delete set null,
  rating text not null check (rating in ('up', 'down')),
  correction_text text not null default '',
  status text not null default 'new' check (status in ('new', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Outbox: el producto del cliente registra el evento; una Edge Function/webhook puede avisar a Telegram/Zavu.
create table if not exists public.za_outbox_events (
  id uuid primary key default gen_random_uuid(),
  operation_key text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create unique index if not exists za_outbox_events_operation_key_idx on public.za_outbox_events(operation_key);

create table if not exists public.za_webhook_events (
  event_id text primary key,
  source text not null,
  event_type text not null default '',
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed', 'ignored')),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  reply jsonb not null default '{}'::jsonb,
  last_error text,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists za_webhook_events_lease_idx on public.za_webhook_events(status, lease_expires_at);

-- Entrevista privada del dueño. Las respuestas viven junto al resto de los datos
-- del cliente y nunca dependen de que ZeroAgent Studio esté abierto.
create table if not exists public.za_onboarding_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id text not null unique,
  status text not null default 'sent' check (status in ('sent','opened','partial','submitted','approved','revoked')),
  current_step integer not null default 0 check (current_step between 0 and 12),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  approved_at timestamptz
);
create table if not exists public.za_onboarding_responses (
  session_id uuid not null references public.za_onboarding_sessions(id) on delete cascade,
  step_key text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(session_id, step_key)
);
create table if not exists public.za_onboarding_files (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.za_onboarding_sessions(id) on delete cascade,
  original_name text not null,
  storage_path text not null,
  mime_type text not null default 'application/octet-stream',
  size_bytes integer not null default 0,
  created_at timestamptz not null default now()
);
insert into storage.buckets (id, name, public) values ('zeroagent-onboarding','zeroagent-onboarding',false) on conflict (id) do nothing;

create or replace function public.za_touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists za_customers_touch on public.za_customers;
create trigger za_customers_touch before update on public.za_customers for each row execute function public.za_touch_updated_at();
drop trigger if exists za_appointments_touch on public.za_appointments;
create trigger za_appointments_touch before update on public.za_appointments for each row execute function public.za_touch_updated_at();
drop trigger if exists za_conversations_touch on public.za_conversations;
create trigger za_conversations_touch before update on public.za_conversations for each row execute function public.za_touch_updated_at();

-- Claim durable para webhooks: un worker adquiere un lease, puede guardar el reply
-- antes de enviar y nunca necesita borrar el evento para reintentarlo.
create or replace function public.za_claim_webhook_event(
  p_event_id text, p_source text, p_event_type text default '', p_lease_seconds integer default 300
) returns table(acquired boolean, status text, lease_token uuid, reply jsonb, attempts integer)
language plpgsql security definer set search_path = public as $$
declare v_event public.za_webhook_events; v_token uuid := gen_random_uuid(); v_inserted integer := 0;
begin
  if nullif(trim(coalesce(p_event_id, '')), '') is null then raise exception 'event_id requerido'; end if;
  insert into public.za_webhook_events(event_id, source, event_type, status, lease_token, lease_expires_at, attempts)
  values (left(trim(p_event_id), 240), left(coalesce(nullif(trim(p_source), ''), 'unknown'), 80), left(coalesce(p_event_type, ''), 120),
    'processing', v_token, now() + make_interval(secs => greatest(30, least(900, coalesce(p_lease_seconds, 300)))), 1)
  on conflict (event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    return query select true, 'processing'::text, v_token, '{}'::jsonb, 1;
    return;
  end if;

  select webhook.* into v_event from public.za_webhook_events as webhook where webhook.event_id = left(trim(p_event_id), 240) for update;
  if v_event.status in ('completed', 'ignored')
    or (v_event.status = 'processing' and v_event.lease_expires_at is not null and v_event.lease_expires_at > now()) then
    return query select false, v_event.status, v_event.lease_token, coalesce(v_event.reply, '{}'::jsonb), v_event.attempts;
    return;
  end if;

  update public.za_webhook_events as webhook set
    source = left(coalesce(nullif(trim(p_source), ''), webhook.source), 80),
    event_type = left(coalesce(nullif(p_event_type, ''), webhook.event_type), 120),
    status = 'processing', lease_token = v_token,
    lease_expires_at = now() + make_interval(secs => greatest(30, least(900, coalesce(p_lease_seconds, 300)))),
    attempts = webhook.attempts + 1, last_error = null, updated_at = now(), completed_at = null
  where webhook.event_id = v_event.event_id returning webhook.* into v_event;
  return query select true, v_event.status, v_token, coalesce(v_event.reply, '{}'::jsonb), v_event.attempts;
end; $$;

create or replace function public.za_checkpoint_webhook_event(
  p_event_id text, p_lease_token uuid, p_reply jsonb default '{}'::jsonb, p_lease_seconds integer default 300
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
  update public.za_webhook_events set reply = coalesce(reply, '{}'::jsonb) || coalesce(p_reply, '{}'::jsonb),
    lease_expires_at = now() + make_interval(secs => greatest(30, least(900, coalesce(p_lease_seconds, 300)))), updated_at = now()
  where event_id = left(trim(p_event_id), 240) and lease_token = p_lease_token and status = 'processing';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end; $$;

create or replace function public.za_complete_webhook_event(
  p_event_id text, p_lease_token uuid, p_status text default 'completed',
  p_reply jsonb default '{}'::jsonb, p_error text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_updated integer;
begin
  if p_status not in ('completed', 'failed', 'ignored') then raise exception 'Estado terminal inválido'; end if;
  update public.za_webhook_events set status = p_status,
    reply = coalesce(reply, '{}'::jsonb) || coalesce(p_reply, '{}'::jsonb),
    last_error = nullif(left(coalesce(p_error, ''), 2000), ''), lease_token = null, lease_expires_at = null,
    updated_at = now(), completed_at = case when p_status in ('completed', 'ignored') then now() else null end
  where event_id = left(trim(p_event_id), 240) and lease_token = p_lease_token and status = 'processing';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end; $$;

create or replace function public.za_feedback_to_outbox()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.rating = 'down' then
    insert into public.za_outbox_events(event_type, payload)
    values ('feedback_requires_review', jsonb_build_object('feedback_id', new.id, 'created_at', new.created_at));
  end if;
  return new;
end; $$;
drop trigger if exists za_feedback_outbox on public.za_feedback_items;
create trigger za_feedback_outbox after insert on public.za_feedback_items for each row execute function public.za_feedback_to_outbox();

-- Única puerta del runtime para solicitar una reserva. Serializa por recurso y evita cruces.
drop function if exists public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text);
drop function if exists public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer);
drop function if exists public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer);
drop function if exists public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text);
drop function if exists public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text);
drop function if exists public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer);
create or replace function public.za_request_appointment(
  p_customer_name text, p_customer_phone text, p_service_id uuid, p_resource_id uuid,
  p_starts_at timestamptz, p_source text default 'public_booking', p_location_id uuid default null,
  p_notes text default '', p_confirmation_mode text default 'manual', p_minimum_notice_hours integer default 0,
  p_maximum_advance_days integer default 730, p_customer_email text default null,
  p_customer_age integer default null, p_customer_occupation text default null,
  p_customer_medical_history text default null, p_customer_extra_symptoms text default null,
  p_pending_ttl_minutes integer default 120
) returns public.za_appointments
language plpgsql security definer set search_path = public as $$
declare v_customer public.za_customers; v_service public.za_services; v_ends_at timestamptz; v_appointment public.za_appointments; v_timezone text; v_resource_location uuid;
begin
  if p_source not in ('public_booking', 'client_console', 'whatsapp', 'staff') then raise exception 'Origen inválido'; end if;
  if p_confirmation_mode not in ('manual', 'automatic') then raise exception 'Modo de confirmación inválido'; end if;
  if trim(coalesce(p_customer_name, '')) = '' or trim(coalesce(p_customer_phone, '')) = '' then raise exception 'Nombre y teléfono son obligatorios'; end if;
  select * into v_service from public.za_services where id = p_service_id and active;
  if not found then raise exception 'Servicio no disponible'; end if;
  if not v_service.bookable then raise exception 'Servicio no agendable por este canal'; end if;
  if not exists (select 1 from public.za_resource_services where resource_id = p_resource_id and service_id = p_service_id) then raise exception 'El profesional no realiza ese servicio'; end if;
  if p_starts_at <= now() then raise exception 'No se puede reservar en el pasado'; end if;
  if p_starts_at < now() + make_interval(hours => greatest(0, least(720, coalesce(p_minimum_notice_hours, 0)))) then raise exception 'El horario no cumple el aviso mínimo configurado'; end if;
  if p_starts_at > now() + make_interval(days => greatest(1, least(730, coalesce(p_maximum_advance_days, 730)))) then raise exception 'El horario supera la anticipación máxima configurada'; end if;
  v_ends_at := p_starts_at + make_interval(mins => v_service.duration_minutes);
  select r.location_id, coalesce(l.timezone, 'America/Santiago') into v_resource_location, v_timezone
  from public.za_resources r left join public.za_locations l on l.id = r.location_id where r.id = p_resource_id and r.active;
  if not found then raise exception 'Profesional no disponible'; end if;
  if v_resource_location is not null and p_location_id is not null and p_location_id is distinct from v_resource_location then raise exception 'La sede no corresponde al profesional seleccionado'; end if;
  if p_location_id is not null and not exists (select 1 from public.za_locations where id = p_location_id and active) then raise exception 'Sede no disponible'; end if;
  perform pg_advisory_xact_lock(hashtext(p_resource_id::text));
  -- Reintentos concurrentes de la misma cita son idempotentes. Una sesión futura distinta del
  -- mismo cliente/servicio sí es válida y no se deduplica.
  select a.* into v_appointment
  from public.za_appointments a join public.za_customers c on c.id = a.customer_id
  where a.resource_id = p_resource_id and a.service_id = p_service_id and a.starts_at = p_starts_at
    and regexp_replace(c.phone, '\D', '', 'g') = regexp_replace(trim(p_customer_phone), '\D', '', 'g')
    and (a.status = 'confirmed' or (a.status = 'pending_confirmation' and (a.expires_at is null or a.expires_at > now())))
  order by a.created_at desc limit 1;
  if found then return v_appointment; end if;
  if not exists (
    select 1 from public.za_availability_rules
    where resource_id = p_resource_id and active
      and day_of_week = extract(dow from (p_starts_at at time zone v_timezone))::integer
      and starts_at <= (p_starts_at at time zone v_timezone)::time
      and ends_at >= (v_ends_at at time zone v_timezone)::time
  ) then raise exception 'Horario fuera de disponibilidad'; end if;
  if exists (select 1 from public.za_availability_blocks where resource_id = p_resource_id and tstzrange(starts_at, ends_at, '[)') && tstzrange(p_starts_at, v_ends_at, '[)')) then raise exception 'Horario bloqueado'; end if;
  if exists (select 1 from public.za_appointments a where a.resource_id = p_resource_id
    and (a.status = 'confirmed' or (a.status = 'pending_confirmation' and (a.expires_at is null or a.expires_at > now())))
    and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_starts_at, v_ends_at, '[)')) then raise exception 'Horario ya ocupado'; end if;
  insert into public.za_customers as existing(full_name, phone, email, age, occupation, medical_history, extra_symptoms)
  values (trim(p_customer_name), trim(p_customer_phone),
    nullif(trim(coalesce(p_customer_email, '')), ''),
    case when p_source = 'public_booking' then null else p_customer_age end,
    case when p_source = 'public_booking' then null else nullif(trim(coalesce(p_customer_occupation, '')), '') end,
    case when p_source = 'public_booking' then null else nullif(trim(coalesce(p_customer_medical_history, '')), '') end,
    case when p_source = 'public_booking' then null else nullif(trim(coalesce(p_customer_extra_symptoms, '')), '') end)
  on conflict(phone) do update set
    full_name = case when p_source = 'public_booking' then existing.full_name else excluded.full_name end,
    email = case when p_source = 'public_booking' then existing.email else coalesce(excluded.email, existing.email) end,
    age = case when p_source = 'public_booking' then existing.age else coalesce(excluded.age, existing.age) end,
    occupation = case when p_source = 'public_booking' then existing.occupation else coalesce(excluded.occupation, existing.occupation) end,
    medical_history = case when p_source = 'public_booking' then existing.medical_history else coalesce(excluded.medical_history, existing.medical_history) end,
    extra_symptoms = case when p_source = 'public_booking' then existing.extra_symptoms else coalesce(excluded.extra_symptoms, existing.extra_symptoms) end
  returning * into v_customer;
  insert into public.za_appointments(customer_id, location_id, service_id, resource_id, starts_at, ends_at, status, source, notes, expires_at)
  values (v_customer.id, coalesce(v_resource_location, p_location_id), p_service_id, p_resource_id, p_starts_at, v_ends_at,
    case when p_confirmation_mode = 'automatic' then 'confirmed'::public.za_appointment_status else 'pending_confirmation'::public.za_appointment_status end,
    p_source, left(coalesce(p_notes, ''), 800),
    case when p_confirmation_mode = 'automatic' then null else now() + make_interval(mins => greatest(5, least(10080, coalesce(p_pending_ttl_minutes, 120)))) end)
  returning * into v_appointment;
  return v_appointment;
end; $$;

-- Por defecto, nadie ve ni modifica tablas desde el navegador. El dashboard autenticado usa RPC/API de servidor.
alter table public.za_schema_migrations enable row level security;
alter table public.za_agent_versions enable row level security;
alter table public.za_locations enable row level security;
alter table public.za_services enable row level security;
alter table public.za_resources enable row level security;
alter table public.za_resource_services enable row level security;
alter table public.za_availability_rules enable row level security;
alter table public.za_availability_blocks enable row level security;
alter table public.za_customers enable row level security;
alter table public.za_appointments enable row level security;
alter table public.za_conversations enable row level security;
alter table public.za_operators enable row level security;
alter table public.za_agent_controls enable row level security;
alter table public.za_conversation_messages enable row level security;
alter table public.za_feedback_items enable row level security;
alter table public.za_outbox_events enable row level security;
alter table public.za_webhook_events enable row level security;
alter table public.za_onboarding_sessions enable row level security;
alter table public.za_onboarding_responses enable row level security;
alter table public.za_onboarding_files enable row level security;

revoke all on function public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer) to service_role;

-- Disponibilidad consultable por el agente. Devuelve sólo bloques que sobreviven reglas, bloqueos y reservas vigentes.
drop function if exists public.za_available_slots(uuid, uuid, date, integer);
drop function if exists public.za_available_slots(uuid, uuid, date, integer, integer, integer);
create or replace function public.za_available_slots(
  p_service_id uuid, p_resource_id uuid, p_date date, p_interval_minutes integer default 15,
  p_minimum_notice_hours integer default 0, p_maximum_advance_days integer default 730
) returns table(starts_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_duration integer; v_bookable boolean; v_timezone text; v_rule record; v_local timestamp; v_start_tz timestamptz; v_end_tz timestamptz; v_seen timestamptz[] := array[]::timestamptz[];
begin
  select s.duration_minutes, s.bookable into v_duration, v_bookable from public.za_services s where s.id = p_service_id and s.active;
  if v_duration is null then raise exception 'Servicio no disponible'; end if;
  if not v_bookable then raise exception 'Servicio no agendable por este canal'; end if;
  select coalesce(l.timezone, 'America/Santiago') into v_timezone from public.za_resources r left join public.za_locations l on l.id = r.location_id where r.id = p_resource_id and r.active;
  if v_timezone is null then raise exception 'Profesional no disponible'; end if;
  -- Misma validación que ya tiene za_request_appointment: sin esto, se podían generar horarios
  -- "disponibles" para un profesional que ni siquiera ofrece ese servicio.
  if not exists (select 1 from public.za_resource_services where resource_id = p_resource_id and service_id = p_service_id) then raise exception 'El profesional no realiza ese servicio'; end if;
  for v_rule in select * from public.za_availability_rules where resource_id = p_resource_id and active and day_of_week = extract(dow from p_date)::integer loop
    for v_local in select generate_series(p_date + v_rule.starts_at, p_date + v_rule.ends_at - make_interval(mins => v_duration), make_interval(mins => greatest(5, least(60, p_interval_minutes)))) loop
      v_start_tz := v_local at time zone v_timezone;
      v_end_tz := (v_local + make_interval(mins => v_duration)) at time zone v_timezone;
      if v_start_tz >= now() + make_interval(hours => greatest(0, least(720, coalesce(p_minimum_notice_hours, 0))))
        and v_start_tz <= now() + make_interval(days => greatest(1, least(730, coalesce(p_maximum_advance_days, 730))))
        and not (v_start_tz = any(v_seen))
        and not exists (select 1 from public.za_availability_blocks b where b.resource_id = p_resource_id and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_start_tz, v_end_tz, '[)'))
        and not exists (select 1 from public.za_appointments a where a.resource_id = p_resource_id
          and (a.status = 'confirmed' or (a.status = 'pending_confirmation' and (a.expires_at is null or a.expires_at > now())))
          and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(v_start_tz, v_end_tz, '[)')) then
        v_seen := array_append(v_seen, v_start_tz); starts_at := v_start_tz; return next;
      end if;
    end loop;
  end loop;
end; $$;

-- Reagendamiento atómico: la reserva original se excluye de la comprobación, cualquier otra la bloquea.
drop function if exists public.za_reschedule_appointment(uuid, timestamptz);
drop function if exists public.za_reschedule_appointment(uuid, timestamptz, text);
drop function if exists public.za_reschedule_appointment(uuid, timestamptz, text, integer, integer);
drop function if exists public.za_reschedule_appointment(uuid, timestamptz, text, integer, integer, text);
drop function if exists public.za_reschedule_appointment(uuid, timestamptz, text, integer, integer, text, integer, text);
create or replace function public.za_reschedule_appointment(
  p_appointment_id uuid, p_new_starts_at timestamptz, p_requester_phone text default null,
  p_minimum_notice_hours integer default 0, p_maximum_advance_days integer default 730,
  p_confirmation_mode text default 'manual', p_pending_ttl_minutes integer default 120,
  p_risk_note text default ''
) returns public.za_appointments
language plpgsql security definer set search_path = public as $$
declare v_appointment public.za_appointments; v_duration integer; v_timezone text; v_end timestamptz; v_result public.za_appointments;
begin
  if p_confirmation_mode not in ('manual', 'automatic') then raise exception 'Modo de confirmación inválido'; end if;
  select * into v_appointment from public.za_appointments where id = p_appointment_id for update;
  if not found then raise exception 'Reserva no encontrada'; end if;
  if p_requester_phone is not null and not exists (
    select 1 from public.za_customers c where c.id = v_appointment.customer_id
      and regexp_replace(c.phone, '\D', '', 'g') = regexp_replace(p_requester_phone, '\D', '', 'g')
  ) then raise exception 'La reserva no pertenece al teléfono verificado'; end if;
  if v_appointment.status in ('cancelled', 'completed', 'no_show', 'rejected') then raise exception 'La reserva no se puede reagendar en su estado actual'; end if;
  if v_appointment.status = 'pending_confirmation' and v_appointment.expires_at is not null and v_appointment.expires_at <= now() then raise exception 'La solicitud pendiente venció y ya no se puede reagendar'; end if;
  if p_new_starts_at = v_appointment.starts_at then return v_appointment; end if;
  if p_new_starts_at <= now() then raise exception 'No se puede reagendar al pasado'; end if;
  if p_new_starts_at < now() + make_interval(hours => greatest(0, least(720, coalesce(p_minimum_notice_hours, 0)))) then raise exception 'El horario no cumple el aviso mínimo configurado'; end if;
  if p_new_starts_at > now() + make_interval(days => greatest(1, least(730, coalesce(p_maximum_advance_days, 730)))) then raise exception 'El horario supera la anticipación máxima configurada'; end if;
  select duration_minutes into v_duration from public.za_services where id = v_appointment.service_id and active and bookable;
  if v_duration is null then raise exception 'Servicio no disponible'; end if;
  select coalesce(l.timezone, 'America/Santiago') into v_timezone from public.za_resources r left join public.za_locations l on l.id = r.location_id where r.id = v_appointment.resource_id and r.active;
  if v_timezone is null then raise exception 'Profesional no disponible'; end if;
  v_end := p_new_starts_at + make_interval(mins => v_duration);
  if not exists (select 1 from public.za_availability_rules where resource_id = v_appointment.resource_id and active and day_of_week = extract(dow from (p_new_starts_at at time zone v_timezone))::integer and starts_at <= (p_new_starts_at at time zone v_timezone)::time and ends_at >= (v_end at time zone v_timezone)::time) then raise exception 'Horario fuera de disponibilidad'; end if;
  perform pg_advisory_xact_lock(hashtext(v_appointment.resource_id::text));
  if exists (select 1 from public.za_availability_blocks where resource_id = v_appointment.resource_id and tstzrange(starts_at, ends_at, '[)') && tstzrange(p_new_starts_at, v_end, '[)')) then raise exception 'Horario bloqueado'; end if;
  if exists (select 1 from public.za_appointments a where a.resource_id = v_appointment.resource_id and a.id <> p_appointment_id
    and (a.status = 'confirmed' or (a.status = 'pending_confirmation' and (a.expires_at is null or a.expires_at > now())))
    and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_new_starts_at, v_end, '[)')) then raise exception 'Horario ya ocupado'; end if;
  update public.za_appointments set starts_at = p_new_starts_at, ends_at = v_end,
    status = case when p_confirmation_mode = 'automatic' then 'confirmed'::public.za_appointment_status else 'pending_confirmation'::public.za_appointment_status end,
    expires_at = case when p_confirmation_mode = 'automatic' then null else now() + make_interval(mins => greatest(5, least(10080, coalesce(p_pending_ttl_minutes, 120)))) end,
    notes = case when trim(coalesce(p_risk_note, '')) = '' then notes else left(concat_ws(' — ', nullif(notes, ''), trim(p_risk_note)), 800) end
    where id = p_appointment_id returning * into v_result;
  return v_result;
end; $$;

-- Toda transición de estado pasa por una máquina explícita. Una reserva cancelada
-- o rechazada no se puede "revivir" y ocupar un horario que ya fue liberado.
create or replace function public.za_transition_appointment(
  p_appointment_id uuid, p_new_status public.za_appointment_status, p_expected_status public.za_appointment_status default null
) returns public.za_appointments
language plpgsql security definer set search_path = public as $$
declare v_appointment public.za_appointments; v_result public.za_appointments; v_timezone text;
begin
  select * into v_appointment from public.za_appointments where id = p_appointment_id for update;
  if not found then raise exception 'Reserva no encontrada'; end if;
  if p_expected_status is not null and v_appointment.status <> p_expected_status then raise exception 'La reserva cambió de estado; actualiza antes de continuar'; end if;
  if v_appointment.status = p_new_status then return v_appointment; end if;
  if not (
    (v_appointment.status = 'pending_confirmation' and p_new_status in ('confirmed', 'cancelled', 'rejected')) or
    (v_appointment.status = 'confirmed' and p_new_status in ('cancelled', 'completed', 'no_show'))
  ) then raise exception 'Transición de estado no permitida'; end if;
  if p_new_status = 'confirmed' then
    if v_appointment.expires_at is not null and v_appointment.expires_at <= now() then raise exception 'La solicitud pendiente venció; crea una nueva reserva'; end if;
    perform pg_advisory_xact_lock(hashtext(v_appointment.resource_id::text));
    select coalesce(l.timezone, 'America/Santiago') into v_timezone
    from public.za_resources r left join public.za_locations l on l.id = r.location_id
    where r.id = v_appointment.resource_id and r.active;
    if v_timezone is null then raise exception 'Profesional no disponible'; end if;
    if not exists (
      select 1 from public.za_availability_rules ar where ar.resource_id = v_appointment.resource_id and ar.active
        and ar.day_of_week = extract(dow from (v_appointment.starts_at at time zone v_timezone))::integer
        and ar.starts_at <= (v_appointment.starts_at at time zone v_timezone)::time
        and ar.ends_at >= (v_appointment.ends_at at time zone v_timezone)::time
    ) then raise exception 'El horario ya no está dentro de la disponibilidad del profesional'; end if;
    if exists (
      select 1 from public.za_availability_blocks b where b.resource_id = v_appointment.resource_id
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_appointment.starts_at, v_appointment.ends_at, '[)')
    ) then raise exception 'El horario fue bloqueado y ya no se puede confirmar'; end if;
    if exists (
      select 1 from public.za_appointments other where other.resource_id = v_appointment.resource_id
        and other.id <> v_appointment.id
        and (other.status = 'confirmed' or (other.status = 'pending_confirmation' and (other.expires_at is null or other.expires_at > now())))
        and tstzrange(other.starts_at, other.ends_at, '[)') && tstzrange(v_appointment.starts_at, v_appointment.ends_at, '[)')
    ) then raise exception 'El horario ya fue ocupado por otra reserva'; end if;
  end if;
  update public.za_appointments set status = p_new_status,
    expires_at = case when p_new_status = 'pending_confirmation' then expires_at else null end
    where id = p_appointment_id returning * into v_result;
  return v_result;
end; $$;

-- Conversación y alerta se escriben en la misma transacción: o ambas ocurren o ninguna.
drop function if exists public.za_request_handoff(uuid, text, text);
drop function if exists public.za_request_handoff(uuid, text, text, text);
create or replace function public.za_request_handoff(
  p_conversation_id uuid, p_reason text, p_caller_phone text, p_operation_key text default null
) returns table(conversation_id uuid, event_id uuid, status text)
language plpgsql security definer set search_path = public as $$
declare v_event_id uuid;
begin
  if p_conversation_id is null then raise exception 'Conversación requerida para traspaso'; end if;
  perform 1 from public.za_conversations where id = p_conversation_id for update;
  if not found then raise exception 'Conversación no encontrada'; end if;
  update public.za_conversations set status = 'handoff', needs_human = true,
    handoff_reason = left(coalesce(p_reason, ''), 800), updated_at = now()
    where id = p_conversation_id;
  insert into public.za_outbox_events(operation_key, event_type, payload)
    values (nullif(left(trim(coalesce(p_operation_key, '')), 240), ''), 'human_handoff_requested', jsonb_build_object(
      'reason', left(coalesce(p_reason, ''), 800), 'caller_phone', regexp_replace(coalesce(p_caller_phone, ''), '\D', '', 'g'),
      'conversation_id', p_conversation_id
    )) on conflict (operation_key) do update set operation_key = excluded.operation_key returning id into v_event_id;
  return query select p_conversation_id, v_event_id, 'handoff'::text;
end; $$;

revoke all on function public.za_available_slots(uuid, uuid, date, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.za_available_slots(uuid, uuid, date, integer, integer, integer) to service_role;
revoke all on function public.za_reschedule_appointment(uuid, timestamptz, text, integer, integer, text, integer, text) from public, anon, authenticated;
grant execute on function public.za_reschedule_appointment(uuid, timestamptz, text, integer, integer, text, integer, text) to service_role;
revoke all on function public.za_transition_appointment(uuid, public.za_appointment_status, public.za_appointment_status) from public, anon, authenticated;
grant execute on function public.za_transition_appointment(uuid, public.za_appointment_status, public.za_appointment_status) to service_role;
revoke all on function public.za_claim_webhook_event(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.za_claim_webhook_event(text, text, text, integer) to service_role;
revoke all on function public.za_checkpoint_webhook_event(text, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.za_checkpoint_webhook_event(text, uuid, jsonb, integer) to service_role;
revoke all on function public.za_complete_webhook_event(text, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.za_complete_webhook_event(text, uuid, text, jsonb, text) to service_role;
revoke all on function public.za_request_handoff(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.za_request_handoff(uuid, text, text, text) to service_role;

insert into public.za_schema_migrations(version, description)
values ('2026-08-07.agenda-hardening-v2', 'Expiración de pendientes, deduplicación exacta e invariantes atómicas de agenda')
on conflict (version) do update set description = excluded.description;
