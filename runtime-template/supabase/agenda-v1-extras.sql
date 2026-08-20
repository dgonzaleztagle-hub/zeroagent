-- ZeroAgent Agenda v1 · extensión: Bandeja de handoff y sugerencias de conocimiento.
-- Mismo patrón que el resto de agenda-v1.sql: tablas propias del cliente, bloqueadas por
-- RLS para anon/authenticated, accesibles solo vía service_role (server-to-server).
-- Se agregó junto con el módulo "/m" (consola móvil) para que Bandeja y Entrenar tengan
-- persistencia real en Supabase, igual que ya la tienen appointments/feedback.

create table if not exists public.za_handoff_tickets (
  id uuid primary key default gen_random_uuid(),
  operation_key text,
  channel text not null default 'preview',
  conversation_ref text not null default '',
  customer_message text not null default '',
  agent_reply text not null default '',
  reason text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists za_handoff_tickets_status_idx on public.za_handoff_tickets(status, created_at desc);
alter table public.za_handoff_tickets add column if not exists operation_key text;
create unique index if not exists za_handoff_tickets_operation_key_idx on public.za_handoff_tickets(operation_key);

create table if not exists public.za_knowledge_suggestions (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  subject text not null,
  value text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists za_knowledge_suggestions_status_idx on public.za_knowledge_suggestions(status, created_at desc);

alter table public.za_handoff_tickets enable row level security;
alter table public.za_knowledge_suggestions enable row level security;

-- za_feedback_items original sólo guardaba correction_text, asumiendo que question/reply
-- se recuperan vía conversation_id/message_id → za_conversation_messages. Eso no sirve para
-- el feedback del chat de prueba ("Probar" en /m), que no crea una conversación real.
alter table public.za_feedback_items add column if not exists question text not null default '';
alter table public.za_feedback_items add column if not exists reply text not null default '';

-- CRM ligero de "control interno": clasificación del contacto. El sistema la sugiere
-- (nace en 'frio', sube a 'caliente' al crear una reserva y a 'cliente' al confirmarla/
-- completarla), pero el dueño la puede cambiar a mano en cualquier momento desde la
-- pestaña Clientes de /m — nunca es un cálculo que se le imponga.
alter table public.za_customers add column if not exists segment text not null default 'frio' check (segment in ('frio', 'caliente', 'cliente'));

-- Alertas operativas del dueño. Fila única por cliente (mismo patrón que za_agent_controls).
-- El handoff (evento más crítico: el agente necesita a una persona) dispara un WhatsApp real
-- al número configurado acá, reusando el mismo canal Zavu que ya usa el agente para
-- responder clientes — no requiere ningún proveedor ni credencial nueva.
create table if not exists public.za_notification_settings (
  id boolean primary key default true check (id),
  handoff_alert_enabled boolean not null default true,
  booking_alert_enabled boolean not null default true,
  failure_alert_enabled boolean not null default true,
  alert_phone text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.za_notification_settings enable row level security;
