-- Minutos de traslado (antes Y después, simétrico) que un servicio necesita alrededor de su
-- sesión real — separado de duration_minutes, que a partir de esta migración vuelve a representar
-- SOLO la sesión (ej. "Atención a domicilio" pasa de 120 a 60 min, igual que su par en Box Buin;
-- "Sesión kinésica respiratoria · Domicilio" de 105 a 45, igual que su par en Box Buin). Antes el
-- traslado se sumaba plano dentro de duration_minutes sin decir dónde iba, así que la hora que el
-- bot le decía al cliente terminaba siendo la de salida del profesional, no la de llegada real —
-- 30 minutos de diferencia, un compromiso incumplido en la práctica aunque la agenda internamente
-- no se cruzara. Con travel_buffer_minutes separado, starts_at/ends_at vuelven a ser la sesión real
-- (lo que se le dice al cliente) y el margen de traslado se reserva aparte, sin tocar lo que se
-- comunica.
--
-- za_available_slots y za_request_appointment YA fueron actualizadas para usar esta columna
-- directamente en la Supabase real de franciskom (encontrado ahí, nunca capturado antes en una
-- migración de este repo) — acá se replican esas mismas definiciones para que el repo deje de
-- estar desincronizado, y se extiende el mismo criterio a za_reschedule_appointment y
-- za_transition_appointment, que todavía no lo tenían: reagendar o confirmar manualmente una cita
-- podía dejarla pegada a otra sin margen de traslado, mientras que crear una nueva sí quedaba
-- protegida — misma clase de bug, dos mitades del sistema desincronizadas.
alter table public.za_services
  add column if not exists travel_buffer_minutes integer not null default 0
    check (travel_buffer_minutes >= 0 and travel_buffer_minutes <= 240);

drop function if exists public.za_available_slots(uuid, uuid, date, integer, integer, integer);
create or replace function public.za_available_slots(
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
end; $$;

drop function if exists public.za_reschedule_appointment(uuid, timestamptz, text, integer, integer, text, integer, text);
create or replace function public.za_reschedule_appointment(
  p_appointment_id uuid, p_new_starts_at timestamptz, p_requester_phone text default null,
  p_minimum_notice_hours integer default 0, p_maximum_advance_days integer default 730,
  p_confirmation_mode text default 'manual', p_pending_ttl_minutes integer default 120,
  p_risk_note text default ''
) returns public.za_appointments
language plpgsql security definer set search_path = public as $$
declare
  v_appointment public.za_appointments; v_duration integer; v_buffer integer; v_timezone text;
  v_end timestamptz; v_guard_start timestamptz; v_guard_end timestamptz; v_result public.za_appointments;
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
  select duration_minutes, greatest(0, least(240, travel_buffer_minutes)) into v_duration, v_buffer from public.za_services where id = v_appointment.service_id and active and bookable;
  if v_duration is null then raise exception 'Servicio no disponible'; end if;
  select coalesce(l.timezone, 'America/Santiago') into v_timezone from public.za_resources r left join public.za_locations l on l.id = r.location_id where r.id = v_appointment.resource_id and r.active;
  if v_timezone is null then raise exception 'Profesional no disponible'; end if;
  v_end := p_new_starts_at + make_interval(mins => v_duration);
  v_guard_start := p_new_starts_at - make_interval(mins => v_buffer);
  v_guard_end := v_end + make_interval(mins => v_buffer);
  if not exists (select 1 from public.za_availability_rules where resource_id = v_appointment.resource_id and active and day_of_week = extract(dow from (v_guard_start at time zone v_timezone))::integer and starts_at <= (v_guard_start at time zone v_timezone)::time and ends_at >= (v_guard_end at time zone v_timezone)::time) then raise exception 'Horario o buffer fuera de disponibilidad'; end if;
  perform pg_advisory_xact_lock(hashtext(v_appointment.resource_id::text));
  if exists (select 1 from public.za_availability_blocks where resource_id = v_appointment.resource_id and tstzrange(starts_at, ends_at, '[)') && tstzrange(v_guard_start, v_guard_end, '[)')) then raise exception 'Horario bloqueado'; end if;
  if exists (
    select 1 from public.za_appointments a join public.za_services s on s.id = a.service_id
    where a.resource_id = v_appointment.resource_id and a.id <> p_appointment_id
      and (a.status = 'confirmed' or (a.status = 'pending_confirmation' and (a.expires_at is null or a.expires_at > now())))
      and tstzrange(
        a.starts_at - make_interval(mins => greatest(0, least(240, coalesce(s.travel_buffer_minutes, 0)))),
        a.ends_at + make_interval(mins => greatest(0, least(240, coalesce(s.travel_buffer_minutes, 0)))), '[)'
      ) && tstzrange(v_guard_start, v_guard_end, '[)')
  ) then raise exception 'Horario o buffer de traslado ya ocupado'; end if;
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
declare
  v_appointment public.za_appointments; v_result public.za_appointments; v_timezone text;
  v_buffer integer; v_guard_start timestamptz; v_guard_end timestamptz;
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
    select greatest(0, least(240, travel_buffer_minutes)) into v_buffer from public.za_services where id = v_appointment.service_id;
    v_guard_start := v_appointment.starts_at - make_interval(mins => coalesce(v_buffer, 0));
    v_guard_end := v_appointment.ends_at + make_interval(mins => coalesce(v_buffer, 0));
    if not exists (
      select 1 from public.za_availability_rules ar where ar.resource_id = v_appointment.resource_id and ar.active
        and ar.day_of_week = extract(dow from (v_guard_start at time zone v_timezone))::integer
        and ar.starts_at <= (v_guard_start at time zone v_timezone)::time
        and ar.ends_at >= (v_guard_end at time zone v_timezone)::time
    ) then raise exception 'El horario ya no está dentro de la disponibilidad del profesional'; end if;
    if exists (
      select 1 from public.za_availability_blocks b where b.resource_id = v_appointment.resource_id
        and tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange(v_guard_start, v_guard_end, '[)')
    ) then raise exception 'El horario fue bloqueado y ya no se puede confirmar'; end if;
    if exists (
      select 1 from public.za_appointments other join public.za_services s on s.id = other.service_id
      where other.resource_id = v_appointment.resource_id
        and other.id <> v_appointment.id
        and (other.status = 'confirmed' or (other.status = 'pending_confirmation' and (other.expires_at is null or other.expires_at > now())))
        and tstzrange(
          other.starts_at - make_interval(mins => greatest(0, least(240, coalesce(s.travel_buffer_minutes, 0)))),
          other.ends_at + make_interval(mins => greatest(0, least(240, coalesce(s.travel_buffer_minutes, 0)))), '[)'
        ) && tstzrange(v_guard_start, v_guard_end, '[)')
    ) then raise exception 'El horario ya fue ocupado por otra reserva'; end if;
  end if;
  update public.za_appointments set status = p_new_status,
    expires_at = case when p_new_status = 'pending_confirmation' then expires_at else null end
    where id = p_appointment_id returning * into v_result;
  return v_result;
end; $$;

revoke all on function public.za_available_slots(uuid, uuid, date, integer, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.za_available_slots(uuid, uuid, date, integer, integer, integer, uuid) to service_role;
revoke all on function public.za_reschedule_appointment(uuid, timestamptz, text, integer, integer, text, integer, text) from public, anon, authenticated;
grant execute on function public.za_reschedule_appointment(uuid, timestamptz, text, integer, integer, text, integer, text) to service_role;
revoke all on function public.za_transition_appointment(uuid, public.za_appointment_status, public.za_appointment_status) from public, anon, authenticated;
grant execute on function public.za_transition_appointment(uuid, public.za_appointment_status, public.za_appointment_status) to service_role;
