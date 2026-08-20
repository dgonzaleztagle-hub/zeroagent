-- Permite marcar un contacto (za_customers) para que el bot nunca le responda
-- automáticamente por WhatsApp (ej. familiares del dueño que escriben al mismo número
-- del negocio). A diferencia de "handoff" (temporal, por conversación puntual), esto es
-- permanente y vive en el contacto: debe aplicar incluso al primer mensaje de esa persona,
-- antes de que exista una conversación que derivar.

alter table public.za_customers add column if not exists bot_muted boolean not null default false;

insert into public.za_schema_migrations(version, description)
values ('2026-08-17.customer-bot-muted', 'Silenciar bot por contacto (za_customers.bot_muted)')
on conflict (version) do update set description = excluded.description;
