-- Fix: za_resolve_booking_location usaba min(location_id) sobre una columna uuid — Postgres no
-- tiene agregado min() nativo para uuid, así que cualquier llamada sin location_id explícito (el
-- caso normal de /api/agenda/public-slots para un profesional sin sede fija, ej. Francisco
-- Martinez que atiende en dos sedes) fallaba con "function min(uuid) does not exist". Encontrado
-- probando disponibilidad real durante la integración de Google Calendar (18-08-2026) — bug
-- preexistente desde 20260807_zz_service_delivery_v1.sql, no introducido por esa integración.
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
    select count(*), min(location_id::text)::uuid into v_count, v_location from public.za_service_locations where service_id = p_service_id;
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
