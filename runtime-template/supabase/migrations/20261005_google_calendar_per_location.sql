-- Calendario propio por "ruta" (una sede, o "delivery:mobile" para toda atención a domicilio):
-- el bot escribe cada cita en el calendario asignado a su ruta. Al actualizar/borrar el evento hay
-- que ir al MISMO calendario donde se creó, por eso la cita guarda cuál fue. Null = cita anterior
-- a este campo, siempre vivió en el calendario destino general (google_calendar_id de settings).
alter table public.za_google_calendar_settings
  add column if not exists calendar_routes jsonb not null default '{}'::jsonb;

alter table public.za_appointments
  add column if not exists google_calendar_id text;
