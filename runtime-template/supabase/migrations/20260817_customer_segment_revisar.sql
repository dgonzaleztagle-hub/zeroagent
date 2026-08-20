-- Agrega 'revisar' como segmento válido de za_customers: contactos importados en bloque que no
-- se sabe si son clientes reales o familia/amigos del dueño (ej. agenda personal completa, filtrada
-- a mano contra el CRM real). Permite dejarlos visibles para revisión y silenciado masivo en vez de
-- descartarlos o mezclarlos sin criterio con clientes reales.

do $$
declare v_constraint record;
begin
  for v_constraint in
    select conname from pg_constraint
    where conrelid = 'public.za_customers'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) like '%segment%frio%'
  loop
    execute format('alter table public.za_customers drop constraint %I', v_constraint.conname);
  end loop;
  alter table public.za_customers
    add constraint za_customers_segment_check
    check (segment in ('frio', 'caliente', 'cliente', 'revisar'));
end $$;

insert into public.za_schema_migrations(version, description)
values ('2026-08-17.customer-segment-revisar', 'Agrega segmento "revisar" para import masivo de contactos sin clasificar')
on conflict (version) do update set description = excluded.description;
