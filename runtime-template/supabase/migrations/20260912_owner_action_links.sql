-- Links de acción de un toque para el dueño.
--
-- El dueño de un negocio de este tamaño no entra a la consola: contesta desde su propio WhatsApp,
-- manejando o con un hijo en brazos, y muchas veces dictando los mensajes (Francisco, 12-09-2026).
-- Un aviso que dice "entra a tu consola" no se usa nunca. Con esto, el SMS lleva un link corto
-- que abre una pantalla con ESE paciente y tres botones: abrir su WhatsApp, seguir la conversación
-- él mismo (el agente se calla en ese hilo) o no contestarle más a ese contacto.
--
-- El token es aleatorio, corto para que el SMS quepa en un segmento de 160 caracteres, y de vida
-- limitada. Se guarda en tabla (en vez de firmarlo) justamente para poder acortarlo y revocarlo.
create table if not exists public.za_action_tokens (
  token text primary key,
  conversation_id uuid references public.za_conversations(id) on delete cascade,
  customer_id uuid references public.za_customers(id) on delete set null,
  customer_phone text not null default '',
  customer_name text not null default '',
  context_message text not null default '',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_action text
);
create index if not exists za_action_tokens_expires_idx on public.za_action_tokens(expires_at);

alter table public.za_action_tokens enable row level security;

insert into public.za_schema_migrations(version, description)
values ('2026-09-12.owner-action-links', 'Links de un toque para que el dueño tome o silencie una conversación desde el SMS de aviso')
on conflict (version) do update set description = excluded.description;
