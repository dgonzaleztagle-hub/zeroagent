-- ZeroAgent Agenda v1 · hardening incremental v2
-- Aplicar sobre instalaciones existentes. Es idempotente y no elimina datos de negocio.
begin;

create table if not exists public.za_schema_migrations (
  version text primary key,
  description text not null default '',
  applied_at timestamptz not null default now()
);
alter table public.za_schema_migrations enable row level security;

alter table public.za_services add column if not exists bookable boolean not null default true;
alter table public.za_services add column if not exists redirect_note text not null default '';
alter table public.za_customers add column if not exists email text;
alter table public.za_customers add column if not exists age integer;
alter table public.za_customers add column if not exists occupation text;
alter table public.za_customers add column if not exists medical_history text;
alter table public.za_customers add column if not exists extra_symptoms text;
alter table public.za_customers add column if not exists segment text not null default 'frio' check (segment in ('frio', 'caliente', 'cliente'));
alter table public.za_appointments add column if not exists expires_at timestamptz;
update public.za_appointments
set expires_at = created_at + interval '120 minutes'
where status = 'pending_confirmation' and expires_at is null;
do $$ begin
  alter table public.za_appointments add constraint za_pending_appointment_has_expiry
    check (status <> 'pending_confirmation' or expires_at is not null);
exception when duplicate_object then null;
end $$;
create index if not exists za_appointments_pending_expiry_idx on public.za_appointments(expires_at) where status = 'pending_confirmation';

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

revoke all on function public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer) to service_role;
revoke all on function public.za_available_slots(uuid, uuid, date, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.za_available_slots(uuid, uuid, date, integer, integer, integer) to service_role;
revoke all on function public.za_reschedule_appointment(uuid, timestamptz, text, integer, integer, text, integer, text) from public, anon, authenticated;
grant execute on function public.za_reschedule_appointment(uuid, timestamptz, text, integer, integer, text, integer, text) to service_role;
revoke all on function public.za_transition_appointment(uuid, public.za_appointment_status, public.za_appointment_status) from public, anon, authenticated;
grant execute on function public.za_transition_appointment(uuid, public.za_appointment_status, public.za_appointment_status) to service_role;

insert into public.za_schema_migrations(version, description)
values ('2026-08-07.agenda-hardening-v2', 'Expiración de pendientes, deduplicación exacta e invariantes atómicas de agenda')
on conflict (version) do update set description = excluded.description;

commit;
