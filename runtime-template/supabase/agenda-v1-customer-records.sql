-- ZeroAgent · historial auditable de admisión/atención por cliente.
-- No pretende reemplazar una ficha clínica regulada. Conserva hechos declarados, notas y
-- correcciones en forma append-only para que un dato nuevo nunca borre silenciosamente otro.

create table if not exists public.za_customer_record_entries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.za_customers(id) on delete cascade,
  appointment_id uuid references public.za_appointments(id) on delete set null,
  entry_type text not null check (entry_type in ('intake_fact', 'service_note', 'follow_up', 'correction')),
  field_key text,
  label text not null default '',
  value text not null check (length(trim(value)) > 0),
  source text not null default 'manual' check (source in ('whatsapp', 'public_booking', 'client_console', 'import', 'manual')),
  source_message_id text,
  confidence numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  confirmed boolean not null default false,
  supersedes_id uuid references public.za_customer_record_entries(id) on delete restrict,
  operation_key text unique,
  created_by text not null default 'system',
  created_at timestamptz not null default now()
);

create index if not exists za_customer_record_customer_idx on public.za_customer_record_entries (customer_id, created_at desc);
create index if not exists za_customer_record_appointment_idx on public.za_customer_record_entries (appointment_id, created_at desc) where appointment_id is not null;

alter table public.za_customer_record_entries enable row level security;
revoke all on public.za_customer_record_entries from anon, authenticated;

create or replace function public.za_validate_customer_record_correction() returns trigger
language plpgsql
set search_path = public
as $$
declare v_original_customer uuid;
begin
  if new.entry_type = 'correction' and new.supersedes_id is null then
    raise exception 'Una corrección debe indicar la entrada original';
  end if;
  if new.supersedes_id is not null then
    select customer_id into v_original_customer from public.za_customer_record_entries where id = new.supersedes_id;
    if v_original_customer is null or v_original_customer <> new.customer_id then
      raise exception 'La corrección debe pertenecer al mismo cliente';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists za_customer_record_correction_guard on public.za_customer_record_entries;
create trigger za_customer_record_correction_guard before insert on public.za_customer_record_entries
for each row execute function public.za_validate_customer_record_correction();

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

  foreach v_key in array array['email','age','occupation','medical_history','extra_symptoms'] loop
    v_value := nullif(trim(p_fields->>v_key), '');
    if v_value is null then continue; end if;
    v_label := case v_key
      when 'email' then 'Correo'
      when 'age' then 'Edad'
      when 'occupation' then 'Ocupación'
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
