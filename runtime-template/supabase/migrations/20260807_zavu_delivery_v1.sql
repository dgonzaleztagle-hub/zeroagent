-- ZeroAgent · Zavu delivery v1
-- Upgrade incremental, seguro para ejecutar más de una vez.

begin;

alter table public.za_conversation_messages add column if not exists provider_message_id text;
alter table public.za_conversation_messages add column if not exists failure_reason text;
alter table public.za_conversation_messages add column if not exists delivered_at timestamptz;

do $$
declare v_constraint record;
begin
  for v_constraint in
    select conname from pg_constraint
    where conrelid = 'public.za_conversation_messages'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) like '%delivery_status%'
  loop
    execute format('alter table public.za_conversation_messages drop constraint %I', v_constraint.conname);
  end loop;
  alter table public.za_conversation_messages
    add constraint za_conversation_messages_delivery_status_check
    check (delivery_status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed'));
end $$;

drop index if exists public.za_conversation_messages_client_id_idx;
create unique index za_conversation_messages_client_id_idx on public.za_conversation_messages(client_message_id);
create unique index if not exists za_conversation_messages_provider_id_idx on public.za_conversation_messages(provider_message_id);

alter table public.za_outbox_events add column if not exists operation_key text;
create unique index if not exists za_outbox_events_operation_key_idx on public.za_outbox_events(operation_key);

-- Las filas antiguas representan webhooks que el runtime anterior ya procesó: nacen
-- como completed. Sólo las filas nuevas usan processing por defecto.
alter table public.za_webhook_events add column if not exists event_type text not null default '';
alter table public.za_webhook_events add column if not exists status text not null default 'completed';
alter table public.za_webhook_events add column if not exists lease_token uuid;
alter table public.za_webhook_events add column if not exists lease_expires_at timestamptz;
alter table public.za_webhook_events add column if not exists attempts integer not null default 0;
alter table public.za_webhook_events add column if not exists reply jsonb not null default '{}'::jsonb;
alter table public.za_webhook_events add column if not exists last_error text;
alter table public.za_webhook_events add column if not exists updated_at timestamptz not null default now();
alter table public.za_webhook_events add column if not exists completed_at timestamptz;
update public.za_webhook_events set completed_at = coalesce(completed_at, received_at), updated_at = coalesce(updated_at, received_at)
where status in ('completed', 'ignored');
alter table public.za_webhook_events alter column status set default 'processing';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.za_webhook_events'::regclass
      and conname = 'za_webhook_events_status_check'
  ) then
    alter table public.za_webhook_events add constraint za_webhook_events_status_check
      check (status in ('processing', 'completed', 'failed', 'ignored'));
  end if;
end $$;
create index if not exists za_webhook_events_lease_idx on public.za_webhook_events(status, lease_expires_at);

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

revoke all on function public.za_claim_webhook_event(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.za_claim_webhook_event(text, text, text, integer) to service_role;
revoke all on function public.za_checkpoint_webhook_event(text, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.za_checkpoint_webhook_event(text, uuid, jsonb, integer) to service_role;
revoke all on function public.za_complete_webhook_event(text, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.za_complete_webhook_event(text, uuid, text, jsonb, text) to service_role;

drop function if exists public.za_request_handoff(uuid, text, text);
drop function if exists public.za_request_handoff(uuid, text, text, text);
create function public.za_request_handoff(
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
    'reason', left(coalesce(p_reason, ''), 800),
    'caller_phone', regexp_replace(coalesce(p_caller_phone, ''), '\D', '', 'g'),
    'conversation_id', p_conversation_id
  )) on conflict (operation_key) do update set operation_key = excluded.operation_key returning id into v_event_id;
  return query select p_conversation_id, v_event_id, 'handoff'::text;
end; $$;
revoke all on function public.za_request_handoff(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.za_request_handoff(uuid, text, text, text) to service_role;

insert into public.za_schema_migrations(version, description)
values ('2026-08-07.zavu-delivery-v1', 'Webhooks durables con lease, mensajería idempotente y estados de entrega Zavu')
on conflict (version) do update set description = excluded.description;

commit;
