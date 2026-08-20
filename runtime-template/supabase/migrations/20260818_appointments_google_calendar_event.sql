-- ZeroAgent Agenda · vincula cada cita con el evento que le corresponde en Google Calendar
-- (si el negocio lo tiene conectado). Nunca se usa para buscar/interpretar eventos ajenos —
-- sólo para actualizar o borrar el evento que ZeroAgent mismo creó.
alter table public.za_appointments add column if not exists google_calendar_event_id text;
