-- Agrega RUT a la ficha del cliente. Francisco (franciskom) confirmó dos veces por separado que
-- pide nombre, apellido, RUT y correo para emitir la boleta al agendar — hasta ahora sólo quedaba
-- como texto de conversación, sin campo estructurado en la ficha ni en el CRM.
-- Se aplica después de service_delivery_v1 (extiende esa misma versión de za_request_appointment,
-- que ya tiene resolución de sede/dirección/buffers — no la version vieja de agenda-v1.sql).

alter table public.za_customers add column if not exists rut text;

-- Se captura en cualquier canal (igual que email), no sólo en WhatsApp/consola: una reserva
-- pública también necesita boleta.
drop function if exists public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer, text);
create or replace function public.za_request_appointment(
  p_customer_name text, p_customer_phone text, p_service_id uuid, p_resource_id uuid,
  p_starts_at timestamptz, p_source text default 'public_booking', p_location_id uuid default null,
  p_notes text default '', p_confirmation_mode text default 'manual', p_minimum_notice_hours integer default 0,
  p_maximum_advance_days integer default 730, p_customer_email text default null,
  p_customer_age integer default null, p_customer_occupation text default null,
  p_customer_medical_history text default null, p_customer_extra_symptoms text default null,
  p_pending_ttl_minutes integer default 120, p_customer_address text default null,
  p_customer_rut text default null
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
  insert into public.za_customers as existing(full_name, phone, email, age, occupation, medical_history, extra_symptoms, rut)
  values (trim(p_customer_name), trim(p_customer_phone), nullif(trim(coalesce(p_customer_email, '')), ''),
    case when p_source = 'public_booking' then null else p_customer_age end,
    case when p_source = 'public_booking' then null else nullif(trim(coalesce(p_customer_occupation, '')), '') end,
    case when p_source = 'public_booking' then null else nullif(trim(coalesce(p_customer_medical_history, '')), '') end,
    case when p_source = 'public_booking' then null else nullif(trim(coalesce(p_customer_extra_symptoms, '')), '') end,
    nullif(trim(coalesce(p_customer_rut, '')), ''))
  on conflict(phone) do update set
    full_name = case when p_source = 'public_booking' then existing.full_name else excluded.full_name end,
    email = case when p_source = 'public_booking' then existing.email else coalesce(excluded.email, existing.email) end,
    age = case when p_source = 'public_booking' then existing.age else coalesce(excluded.age, existing.age) end,
    occupation = case when p_source = 'public_booking' then existing.occupation else coalesce(excluded.occupation, existing.occupation) end,
    medical_history = case when p_source = 'public_booking' then existing.medical_history else coalesce(excluded.medical_history, existing.medical_history) end,
    extra_symptoms = case when p_source = 'public_booking' then existing.extra_symptoms else coalesce(excluded.extra_symptoms, existing.extra_symptoms) end,
    rut = coalesce(excluded.rut, existing.rut)
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

revoke all on function public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.za_request_appointment(text, text, uuid, uuid, timestamptz, text, uuid, text, text, integer, integer, text, integer, text, text, text, integer, text, text) to service_role;

-- za_update_customer_intake: agrega 'rut' al mismo mecanismo de admisión post-reserva que ya
-- existía para correo/edad/ocupación/antecedentes/síntomas.
create or replace function public.za_update_customer_intake(
  p_phone text,
  p_fields jsonb,
  p_source text default 'whatsapp',
  p_source_message_id text default null,
  p_operation_key text default null,
  p_created_by text default 'agent'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer public.za_customers%rowtype;
  v_key text;
  v_value text;
  v_label text;
  v_entry_id uuid;
  v_entries jsonb := '[]'::jsonb;
begin
  if p_source not in ('whatsapp', 'client_console', 'import', 'manual') then
    raise exception 'Fuente de admisión no autorizada';
  end if;
  select * into v_customer from public.za_customers where phone = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') limit 1 for update;
  if v_customer.id is null then raise exception 'Cliente no encontrado'; end if;

  update public.za_customers set
    email = coalesce(nullif(trim(p_fields->>'email'), ''), email),
    age = coalesce(case when (p_fields->>'age') ~ '^\d{1,3}$' then (p_fields->>'age')::integer end, age),
    occupation = coalesce(nullif(trim(p_fields->>'occupation'), ''), occupation),
    rut = coalesce(nullif(trim(p_fields->>'rut'), ''), rut),
    medical_history = case
      when nullif(trim(p_fields->>'medical_history'), '') is null then medical_history
      when medical_history is null or trim(medical_history) = '' then trim(p_fields->>'medical_history')
      when position(lower(trim(p_fields->>'medical_history')) in lower(medical_history)) > 0 then medical_history
      else medical_history || E'\n' || trim(p_fields->>'medical_history')
    end,
    extra_symptoms = case
      when nullif(trim(p_fields->>'extra_symptoms'), '') is null then extra_symptoms
      when extra_symptoms is null or trim(extra_symptoms) = '' then trim(p_fields->>'extra_symptoms')
      when position(lower(trim(p_fields->>'extra_symptoms')) in lower(extra_symptoms)) > 0 then extra_symptoms
      else extra_symptoms || E'\n' || trim(p_fields->>'extra_symptoms')
    end,
    updated_at = now()
  where id = v_customer.id;

  foreach v_key in array array['email','age','occupation','rut','medical_history','extra_symptoms'] loop
    v_value := nullif(trim(p_fields->>v_key), '');
    if v_value is null then continue; end if;
    v_label := case v_key
      when 'email' then 'Correo'
      when 'age' then 'Edad'
      when 'occupation' then 'Ocupación'
      when 'rut' then 'RUT'
      when 'medical_history' then 'Antecedente declarado'
      when 'extra_symptoms' then 'Información adicional declarada'
    end;
    v_entry_id := null;
    insert into public.za_customer_record_entries (
      customer_id, entry_type, field_key, label, value, source, source_message_id,
      confidence, confirmed, operation_key, created_by
    ) values (
      v_customer.id, 'intake_fact', v_key, v_label, v_value, p_source, nullif(p_source_message_id, ''),
      1, true, case when p_operation_key is null then null else p_operation_key || ':' || v_key end, left(coalesce(p_created_by, 'agent'), 120)
    ) on conflict (operation_key) do nothing returning id into v_entry_id;
    if v_entry_id is not null then v_entries := v_entries || jsonb_build_array(v_entry_id); end if;
  end loop;
  return jsonb_build_object('customer_id', v_customer.id, 'entry_ids', v_entries);
end;
$$;

revoke all on function public.za_update_customer_intake(text, jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.za_update_customer_intake(text, jsonb, text, text, text, text) to service_role;

insert into public.za_schema_migrations(version, description)
values ('2026-08-08.customer-rut', 'RUT estructurado en ficha de cliente (boleta)')
on conflict (version) do update set description = excluded.description;
