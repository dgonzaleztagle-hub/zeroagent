-- Login por PIN para /agenda y /m: antes, sin DASHBOARD_ACCESS_KEY configurado, esas consolas
-- quedaban abiertas a cualquiera con la URL. Agrega el estado de PIN a za_operators (ya existía
-- la tabla, sólo le faltaban estas columnas).
alter table public.za_operators
  add column if not exists pin_hash text,
  add column if not exists must_change_pin boolean not null default true,
  add column if not exists pin_updated_at timestamptz;
