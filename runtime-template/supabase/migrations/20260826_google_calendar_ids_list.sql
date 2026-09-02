-- Un negocio puede tener varios calendarios en su misma cuenta de Google (uno por defecto,
-- otro para "Pacientes X", otro personal, etc.) — freebusy sólo miraba google_calendar_id
-- (uno solo), así que un bloqueo personal en OTRO calendario de la misma cuenta nunca se
-- reflejaba como "ocupado". calendar_ids guarda TODOS los calendarios visibles descubiertos
-- al conectar (id + nombre), para que freebusy los consulte todos a la vez; google_calendar_id
-- se mantiene como el calendario donde el bot escribe las citas que crea.

alter table public.za_google_calendar_settings
  add column if not exists calendar_ids jsonb not null default '[]'::jsonb;
