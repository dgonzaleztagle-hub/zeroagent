-- Conocimiento del agente en la base, no en el paquete horneado (08-10-2026).
-- Hasta acá los hechos confirmados vivían como prosa en agent-package.json: cambiar uno exigía un
-- build y un deploy, y no había forma de distinguir lo que se le dice al cliente de lo que sólo
-- guía al agente. Una regla interna redactada como instrucción le llegó textual a un paciente.
--
-- visibility:
--   public   -> el agente puede decírselo al cliente con sus palabras.
--   internal -> criterio para decidir; el runtime lo entrega en un bloque aparte y una guarda de
--               salida bloquea cualquier respuesta que lo repita.
-- Cuando esta tabla tiene filas activas, es la ÚNICA fuente de hechos del agente (engine.js deja de
-- leer los confirmed_facts del paquete).

create table if not exists public.za_knowledge_facts (
  id text primary key,
  category text not null default 'general',
  subject text not null,
  value text not null,
  visibility text not null default 'public' check (visibility in ('public', 'internal')),
  active boolean not null default true,
  source text not null default 'package',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists za_knowledge_facts_active_idx on public.za_knowledge_facts(active, category);

alter table public.za_knowledge_facts enable row level security;

drop trigger if exists za_knowledge_facts_touch on public.za_knowledge_facts;
create trigger za_knowledge_facts_touch before update on public.za_knowledge_facts
  for each row execute function public.za_touch_updated_at();

insert into public.za_schema_migrations(version, description)
values ('20261008_knowledge_facts', 'Conocimiento del agente en la base, con visibilidad pública o interna')
on conflict (version) do update set description = excluded.description;
