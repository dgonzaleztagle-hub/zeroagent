-- ZeroAgent Agenda · modalidades, matriz servicio/sede y buffers de traslado.
-- Se aplica después de agenda_hardening_v2 y es idempotente.

alter table public.za_locations add column if not exists kind text not null default 'premise';
alter table public.za_locations add column if not exists area_note text not null default '';
do $$ begin
  alter table public.za_locations add constraint za_locations_kind_check
    check (kind in ('premise', 'service_area', 'remote'));
exception when duplicate_object then null;
end $$;

alter table public.za_services add column if not exists delivery_mode text not null default 'onsite';
alter table public.za_services add column if not exists price_type text not null default 'fixed';
alter table public.za_services add column if not exists price_note text not null default '';
alter table public.za_services add column if not exists requires_customer_address boolean not null default false;
alter table public.za_services add column if not exists travel_buffer_minutes integer not null default 0;
alter table public.za_services add column if not exists service_area_note text not null default '';
do $$ begin
  alter table public.za_services add constraint za_services_delivery_mode_check
    check (delivery_mode in ('onsite', 'mobile', 'remote', 'external'));
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.za_services add constraint za_services_price_type_check
    check (price_type in ('fixed', 'from', 'quote'));
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.za_services add constraint za_services_travel_buffer_check
    check (travel_buffer_minutes between 0 and 240);
exception when duplicate_object then null;
end $$;

alter table public.za_appointments add column if not exists customer_address text not null default '';

create table if not exists public.za_service_locations (
  service_id uuid not null references public.za_services(id) on delete cascade,
  location_id uuid not null references public.za_locations(id) on delete cascade,
  primary key (service_id, location_id)
);

create table if not exists public.za_resource_locations (
  resource_id uuid not null references public.za_resources(id) on delete cascade,
  location_id uuid not null references public.za_locations(id) on delete cascade,
  primary key (resource_id, location_id)
);

alter table public.za_service_locations enable row level security;
alter table public.za_resource_locations enable row level security;
revoke all on public.za_service_locations, public.za_resource_locations from anon, authenticated;

-- Resuelve la sede efectiva y aplica las dos matrices. Una lista vacía mantiene
-- compatibilidad con paquetes antiguos; al existir vínculos, la allowlist es estricta.
create or replace function public.za_resolve_booking_location(
  p_service_id uuid, p_resource_id uuid, p_requested_location_id uuid default null
) returns uuid
language plpgsql stable
set search_path = public
as $$
declare v_fixed_location uuid; v_location uuid; v_count integer;
begin
  select location_id into v_fixed_location from public.za_resources where id = p_resource_id and active;
  if not found then raise exception 'Profesional no disponible'; end if;
  if v_fixed_location is not null and p_requested_location_id is not null and v_fixed_location <> p_requested_location_id then
    raise exception 'La sede no corresponde al profesional seleccionado';
  end if;
  v_location := coalesce(v_fixed_location, p_requested_location_id);
  if v_location is null then
    select count(*), min(location_id) into v_count, v_location from public.za_service_locations where service_id = p_service_id;
    if v_count > 1 then raise exception 'Debes elegir una sede o modalidad para este servicio'; end if;
  end if;
  if v_location is not null and not exists (select 1 from public.za_locations where id = v_location and active) then
    raise exception 'Sede no disponible';
  end if;
  if exists (select 1 from public.za_service_locations where service_id = p_service_id)
    and (v_location is null or not exists (select 1 from public.za_service_locations where service_id = p_service_id and location_id = v_location)) then
    raise exception 'Ese servicio no se presta en la sede o modalidad seleccionada';
  end if;
  if exists (select 1 from public.za_resource_locations where resource_id = p_resource_id)
    and (v_location is null or not exists (select 1 from public.za_resource_locations where resource_id = p_resource_id and location_id = v_location)) then
    raise exception 'El profesional no atiende en la sede o modalidad seleccionada';
  end if;
  return v_location;
end;
$$;

-- Defensa final para cualquier mutación, incluso si no pasa por las RPC del runtime.
-- `travel_buffer_minutes` se reserva antes y después de la atención.
create or replace function public.za_validate_appointment_delivery() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_service public.za_services%rowtype;
  v_location uuid;
  v_timezone text := 'America/Santiago';
  v_buffer integer := 0;
  v_guard_start timestamptz;
  v_guard_end timestamptz;
begin
  if not (new.status = 'confirmed' or (new.status = 'pending_confirmation' and (new.expires_at is null or new.expires_at > now()))) then
    return new;
  end if;
  select * into v_service from public.za_services where id = new.service_id and active;
  if not found or not v_service.bookable or v_service.delivery_mode = 'external' then raise exception 'Servicio no disponible para reserva'; end if;
  if not exists (select 1 from public.za_resource_services where resource_id = new.resource_id and service_id = new.service_id) then
    raise exception 'El profesional no realiza ese servicio';
  end if;
  v_location := public.za_resolve_booking_location(new.service_id, new.resource_id, new.location_id);
  new.location_id := v_location;
  if (v_service.delivery_mode = 'mobile' or v_service.requires_customer_address)
    and nullif(trim(coalesce(new.customer_address, '')), '') is null then
    raise exception 'Este servicio requiere la dirección de atención';
  end if;
  if v_location is not null then
    select timezone into v_timezone from public.za_locations where id = v_location;
  end if;
  v_buffer := greatest(0, least(240, coalesce(v_service.travel_buffer_minutes, 0)));
  v_guard_start := new.starts_at - make_interval(mins => v_buffer);
  v_guard_end := new.ends_at + make_interval(mins => v_buffer);
  perform pg_advisory_xact_lock(hashtext(new.resource_id::text));
  if not exists (
    select 1 from public.za_availability_rules r where r.resource_id = new.resource_id and r.active
      and r.day_of_week = extract(dow from (v_guard_start at time zone v_timezone))::integer
      and r.starts_at <= (v_guard_start at time zone v_timezone)::time
      and r.ends_at >= (v_guard_end at time zone v_timezone)::time
  ) then raise exception 'Horario o buffer fuera de disponibilidad'; end if;
  if exists (
    select 1 from public.za_availability_blocks b where b.resource_id = new.resource_id
      and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_guard_start, v_guard_end, '[)')
  ) then raise exception 'Horario bloqueado'; end if;
  if exists (
    select 1 from public.za_appointments a
    join public.za_services s on s.id = a.service_id
    where a.resource_id = new.resource_id and a.id is distinct from new.id
      and (a.status = 'confirmed' or (a.status = 'pending_confirmation' and (a.expires_at is null or a.expires_at > now())))
      and tstzrange(
        a.starts_at - make_interval(mins => greatest(0, least(240, coalesce(s.travel_buffer_minutes, 0)))),
        a.ends_at + make_interval(mins => greatest(0, least(240, coalesce(s.travel_buffer_minutes, 0)))), '[)'
      ) && tstzrange(v_guard_start, v_guard_end, '[)')
  ) then raise exception 'Horario o buffer de traslado ya ocupado'; end if;
  return new;
end;
$$;

drop trigger if exists za_appointment_delivery_guard on public.za_appointments;
create trigger za_appointment_delivery_guard
before insert or update of starts_at, ends_at, service_id, resource_id, location_id, customer_address, status
on public.za_appointments for each row execute function public.za_validate_appointment_delivery();

-- Reemplaza la firma anterior agregando la dirección por cita. Los campos de
-- admisión sensibles siguen ignorándose cuando el origen es public_booking.
drop function if exists public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer);
drop function if exists public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer, text);
create function public.za_request_appointment(
  p_customer_name text, p_customer_phone text, p_service_id uuid, p_resource_id uuid,
  p_starts_at timestamptz, p_source text default 'public_booking', p_location_id uuid default null,
  p_notes text default '', p_confirmation_mode text default 'manual', p_minimum_notice_hours integer default 0,
  p_maximum_advance_days integer default 730, p_customer_email text default null,
  p_customer_age integer default null, p_customer_occupation text default null,
  p_customer_medical_history text default null, p_customer_extra_symptoms text default null,
  p_pending_ttl_minutes integer default 120, p_customer_address text default null
) returns public.za_appointments
language plpgsql security definer set search_path = public as $$
declare
  v_customer public.za_customers; v_service public.za_services; v_ends_at timestamptz;
  v_appointment public.za_appointments; v_timezone text := 'America/Santiago';
  v_location uuid; v_buffer integer := 0; v_guard_start timestamptz; v_guard_end timestamptz;
begin
  if p_source not in ('public_booking', 'client_console', 'whatsapp', 'staff') then raise exception 'Origen inválido'; end if;
  if p_confirmation_mode not in ('manual', 'automatic') then raise exception 'Modo de confirmación inválido'; end if;
  if trim(coalesce(p_customer_name, '')) = '' or trim(coalesce(p_customer_phone, '')) = '' then raise exception 'Nombre y teléfono son obligatorios'; end if;
  select * into v_service from public.za_services where id = p_service_id and active;
  if not found then raise exception 'Servicio no disponible'; end if;
  if not v_service.bookable or v_service.delivery_mode = 'external' then raise exception 'Servicio no agendable por este canal'; end if;
  if not exists (select 1 from public.za_resource_services where resource_id = p_resource_id and service_id = p_service_id) then raise exception 'El profesional no realiza ese servicio'; end if;
  v_location := public.za_resolve_booking_location(p_service_id, p_resource_id, p_location_id);
  if (v_service.delivery_mode = 'mobile' or v_service.requires_customer_address)
    and nullif(trim(coalesce(p_customer_address, '')), '') is null then raise exception 'Este servicio requiere la dirección de atención'; end if;
  if p_starts_at <= now() then raise exception 'No se puede reservar en el pasado'; end if;
  if p_starts_at < now() + make_interval(hours => greatest(0, least(720, coalesce(p_minimum_notice_hours, 0)))) then raise exception 'El horario no cumple el aviso mínimo configurado'; end if;
  if p_starts_at > now() + make_interval(days => greatest(1, least(730, coalesce(p_maximum_advance_days, 730)))) then raise exception 'El horario supera la anticipación máxima configurada'; end if;
  v_ends_at := p_starts_at + make_interval(mins => v_service.duration_minutes);
  if v_location is not null then select timezone into v_timezone from public.za_locations where id = v_location; end if;
  v_buffer := greatest(0, least(240, coalesce(v_service.travel_buffer_minutes, 0)));
  v_guard_start := p_starts_at - make_interval(mins => v_buffer);
  v_guard_end := v_ends_at + make_interval(mins => v_buffer);
  perform pg_advisory_xact_lock(hashtext(p_resource_id::text));
  select a.* into v_appointment
  from public.za_appointments a join public.za_customers c on c.id = a.customer_id
  where a.resource_id = p_resource_id and a.service_id = p_service_id and a.starts_at = p_starts_at
    and regexp_replace(c.phone, '\D', '', 'g') = regexp_replace(trim(p_customer_phone), '\D', '', 'g')
    and (a.status = 'confirmed' or (a.status = 'pending_confirmation' and (a.expires_at is null or a.expires_at > now())))
  order by a.created_at desc limit 1;
  if found then return v_appointment; end if;
  if not exists (
    select 1 from public.za_availability_rules where resource_id = p_resource_id and active
      and day_of_week = extract(dow from (v_guard_start at time zone v_timezone))::integer
      and starts_at <= (v_guard_start at time zone v_timezone)::time
      and ends_at >= (v_guard_end at time zone v_timezone)::time
  ) then raise exception 'Horario o buffer fuera de disponibilidad'; end if;
  if exists (select 1 from public.za_availability_blocks where resource_id = p_resource_id and tstzrange(starts_at, ends_at, '[)') && tstzrange(v_guard_start, v_guard_end, '[)')) then raise exception 'Horario bloqueado'; end if;
  if exists (
    select 1 from public.za_appointments a join public.za_services s on s.id = a.service_id
    where a.resource_id = p_resource_id
      and (a.status = 'confirmed' or (a.status = 'pending_confirmation' and (a.expires_at is null or a.expires_at > now())))
      and tstzrange(
        a.starts_at - make_interval(mins => greatest(0, least(240, coalesce(s.travel_buffer_minutes, 0)))),
        a.ends_at + make_interval(mins => greatest(0, least(240, coalesce(s.travel_buffer_minutes, 0)))), '[)'
      ) && tstzrange(v_guard_start, v_guard_end, '[)')
  ) then raise exception 'Horario o buffer de traslado ya ocupado'; end if;
  insert into public.za_customers as existing(full_name, phone, email, age, occupation, medical_history, extra_symptoms)
  values (trim(p_customer_name), trim(p_customer_phone), nullif(trim(coalesce(p_customer_email, '')), ''),
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
  insert into public.za_appointments(customer_id, location_id, service_id, resource_id, starts_at, ends_at, status, source, notes, expires_at, customer_address)
  values (v_customer.id, v_location, p_service_id, p_resource_id, p_starts_at, v_ends_at,
    case when p_confirmation_mode = 'automatic' then 'confirmed'::public.za_appointment_status else 'pending_confirmation'::public.za_appointment_status end,
    p_source, left(coalesce(p_notes, ''), 800),
    case when p_confirmation_mode = 'automatic' then null else now() + make_interval(mins => greatest(5, least(10080, coalesce(p_pending_ttl_minutes, 120)))) end,
    left(trim(coalesce(p_customer_address, '')), 500))
  returning * into v_appointment;
  return v_appointment;
end;
$$;

revoke all on function public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer, text) to service_role;

drop function if exists public.za_available_slots(uuid, uuid, date, integer, integer, integer);
drop function if exists public.za_available_slots(uuid, uuid, date, integer, integer, integer, uuid);
create function public.za_available_slots(
  p_service_id uuid, p_resource_id uuid, p_date date, p_interval_minutes integer default 15,
  p_minimum_notice_hours integer default 0, p_maximum_advance_days integer default 730,
  p_location_id uuid default null
) returns table(starts_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_duration integer; v_buffer integer; v_bookable boolean; v_timezone text := 'America/Santiago';
  v_location uuid; v_rule record; v_local timestamp; v_start_tz timestamptz;
  v_end_tz timestamptz; v_guard_start timestamptz; v_guard_end timestamptz;
  v_seen timestamptz[] := array[]::timestamptz[];
begin
  select duration_minutes, greatest(0, least(240, travel_buffer_minutes)), bookable
    into v_duration, v_buffer, v_bookable from public.za_services
    where id = p_service_id and active and delivery_mode <> 'external';
  if v_duration is null then raise exception 'Servicio no disponible'; end if;
  if not v_bookable then raise exception 'Servicio no agendable por este canal'; end if;
  if not exists (select 1 from public.za_resource_services where resource_id = p_resource_id and service_id = p_service_id) then raise exception 'El profesional no realiza ese servicio'; end if;
  v_location := public.za_resolve_booking_location(p_service_id, p_resource_id, p_location_id);
  if v_location is not null then select timezone into v_timezone from public.za_locations where id = v_location; end if;
  for v_rule in select * from public.za_availability_rules where resource_id = p_resource_id and active and day_of_week = extract(dow from p_date)::integer loop
    for v_local in select generate_series(
      p_date + v_rule.starts_at + make_interval(mins => v_buffer),
      p_date + v_rule.ends_at - make_interval(mins => v_duration + v_buffer),
      make_interval(mins => greatest(5, least(60, p_interval_minutes)))
    ) loop
      v_start_tz := v_local at time zone v_timezone;
      v_end_tz := (v_local + make_interval(mins => v_duration)) at time zone v_timezone;
      v_guard_start := v_start_tz - make_interval(mins => v_buffer);
      v_guard_end := v_end_tz + make_interval(mins => v_buffer);
      if v_start_tz >= now() + make_interval(hours => greatest(0, least(720, coalesce(p_minimum_notice_hours, 0))))
        and v_start_tz <= now() + make_interval(days => greatest(1, least(730, coalesce(p_maximum_advance_days, 730))))
        and not (v_start_tz = any(v_seen))
        and not exists (select 1 from public.za_availability_blocks b where b.resource_id = p_resource_id and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_guard_start, v_guard_end, '[)'))
        and not exists (
          select 1 from public.za_appointments a join public.za_services s on s.id = a.service_id
          where a.resource_id = p_resource_id
            and (a.status = 'confirmed' or (a.status = 'pending_confirmation' and (a.expires_at is null or a.expires_at > now())))
            and tstzrange(
              a.starts_at - make_interval(mins => greatest(0, least(240, coalesce(s.travel_buffer_minutes, 0)))),
              a.ends_at + make_interval(mins => greatest(0, least(240, coalesce(s.travel_buffer_minutes, 0)))), '[)'
            ) && tstzrange(v_guard_start, v_guard_end, '[)')
        ) then
        v_seen := array_append(v_seen, v_start_tz); starts_at := v_start_tz; return next;
      end if;
    end loop;
  end loop;
end;
$$;

revoke all on function public.za_available_slots(uuid, uuid, date, integer, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.za_available_slots(uuid, uuid, date, integer, integer, integer, uuid) to service_role;

insert into public.za_schema_migrations(version, description)
values ('2026-08-07.service-delivery-v1', 'Modalidades, matrices servicio/sede y buffers de traslado')
on conflict (version) do update set description = excluded.description;
