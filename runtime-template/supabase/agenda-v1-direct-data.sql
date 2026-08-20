-- ZeroAgent Agenda v1 · extensión: Datos e Info de inyección directa.
-- Distinto de za_knowledge_suggestions (que nace 'pending' y espera aprobación de Studio):
-- estas dos tablas las escribe el propio dueño del negocio desde su consola y el agente
-- las usa de inmediato, en vivo, sin pasar por revisión de Daniel+Claude. Mismo patrón de
-- acceso que el resto de agenda-v1.sql: RLS activo, solo accesible vía service_role.
--
-- DATOS = hechos estructurados y objetivos (precio, dirección, teléfono, horario) que el
--         dueño mantiene él mismo, tipo ficha — un label + un valor.
-- INFO  = texto suelto que no calza en una ficha (indicaciones de llegada, política
--         informal, "somos pet friendly", etc.) pero que el agente debe poder citar igual.

create table if not exists public.za_business_data (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  value text not null,
  category text not null default 'general',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists za_business_data_active_idx on public.za_business_data(active, created_at desc);

create table if not exists public.za_business_info (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists za_business_info_active_idx on public.za_business_info(active, created_at desc);

alter table public.za_business_data enable row level security;
alter table public.za_business_info enable row level security;
