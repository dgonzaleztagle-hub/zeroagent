-- Buffer de traslado entre compromisos en distintos lugares. Cuando el profesional atiende en
-- más de un sitio (ej. franciskom: Eleva Salud + Box Buin/domicilio), un horario que queda
-- pegado justo al final de un bloqueo en OTRO calendario no es realmente agendable — necesita
-- tiempo para trasladarse. Se suma antes y después de cualquier bloqueo que NO venga del
-- calendario donde el bot escribe sus propias citas (google_calendar_id).

alter table public.za_google_calendar_settings
  add column if not exists travel_buffer_minutes integer not null default 0 check (travel_buffer_minutes >= 0 and travel_buffer_minutes <= 240);
