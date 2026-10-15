-- Restaura el RUT en za_update_customer_intake (11-10-2026).
-- 20260808_customer_rut agregó 'rut' a esta función, pero el arreglo de teléfono del 08-09 reaplicó
-- supabase/agenda-v1-customer-records.sql, que traía la versión anterior sin RUT y la pisó. Desde
-- entonces el RUT que el paciente manda después de reservar se descartaba en silencio mientras la
-- herramienta respondía "profile_updated". El archivo base quedó corregido con esta misma versión
-- para que reaplicarlo no vuelva a borrar el campo.
--
-- Además devuelve 'stored_fields': los campos que de verdad se guardaron, para que el runtime no le
-- confirme al modelo un dato que la base no aceptó.
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
  v_stored jsonb := '[]'::jsonb;
begin
  if p_source not in ('whatsapp', 'client_console', 'import', 'manual') then
    raise exception 'Fuente de admisión no autorizada';
  end if;
  -- El teléfono se guarda con prefijo (+56…) y llega normalizado a dígitos: hay que limpiar
  -- LOS DOS lados o la comparación no calza nunca y el intake falla con "Cliente no encontrado".
  select * into v_customer from public.za_customers
    where regexp_replace(coalesce(phone, ''), '\D', '', 'g') = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
    limit 1 for update;
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
    v_stored := v_stored || jsonb_build_array(v_key);
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
  return jsonb_build_object('customer_id', v_customer.id, 'entry_ids', v_entries, 'stored_fields', v_stored);
end;
$$;

revoke all on function public.za_update_customer_intake(text, jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.za_update_customer_intake(text, jsonb, text, text, text, text) to service_role;

insert into public.za_schema_migrations(version, description)
values ('20261011_customer_intake_rut_restore', 'Restaura el RUT en la admisión post-reserva y devuelve los campos guardados')
on conflict (version) do update set description = excluded.description;
