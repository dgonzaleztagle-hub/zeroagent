# ZeroAgent · manifiesto de instalación del cliente

Este paquete se instala en infraestructura del cliente y no depende de que ZeroAgent Studio esté encendido.

## Orden de instalación

1. Crear/confirmar el proyecto Supabase del cliente y ejecutar, en orden, `supabase/agenda-v1.sql`, todas las migraciones de `supabase/migrations/` en orden de nombre, `supabase/agenda-v1-extras.sql` (handoffs, sugerencias), `supabase/agenda-v1-direct-data.sql` (datos del negocio), `supabase/agenda-v1-ai-account.sql` (selección/uso de IA) y `supabase/agenda-v1-customer-records.sql` (historial auditable de admisión/atención). Las migraciones son idempotentes: este mismo orden sirve para una instalación nueva y para actualizar una existente.
2. Configurar las variables Supabase y ejecutar `npm run setup:agenda` para cargar el catálogo aprobado del paquete.
3. Guardar en el hosting `RUNTIME_MODE=staging` o `production`, claves de acceso, Supabase y Zavu. Para IA elegir: BYOK (`AI_CREDENTIALS_ENCRYPTION_KEY` y selección desde la consola) o las variables `LLM_*` heredadas. Nunca configurar más secretos de los necesarios.
4. Publicar primero a **staging** y registrar la URL y versión en ZeroAgent Studio.
5. Configurar horarios semanales explícitos por profesional; no se infieren desde el catálogo.
6. Configurar `ONBOARDING_ACCESS_TOKEN`, probar `/onboarding?token=...` y confirmar carga de respuestas/archivos en Supabase.
7. Probar web pública, dashboard, respuesta humana, creación/cancelación/reagendamiento y webhook Zavu.
8. Aprobar una versión; recién entonces conectar el número productivo.

`CHANNEL_PROVIDER=generic_webhook` está reservado para `RUNTIME_MODE=preview_local` y exige `GENERIC_WEBHOOK_SECRET`. Nunca se habilita en staging ni producción.

## Límites de responsabilidad

- Supabase, repositorio, hosting, dominio y canal quedan aislados por cliente. La IA puede ser un plan administrado por ZeroAgent o una clave BYOK del negocio cifrada en su propio Supabase.
- El Studio local conserva únicamente un alias y una credencial cifrada en el vault para mantenimiento autorizado.
- El runtime no llama al Studio. Feedback, conversaciones y agenda viven en Supabase del cliente.
- Los eventos `za_outbox_events` pueden notificar por Telegram/Zavu sin exponer la base del cliente a un SaaS central.

## Estados de despliegue

- `preview_local`: prueba técnica sin datos productivos.
- `staging`: cliente prueba el paquete en su propia infraestructura.
- `production`: número Zavu conectado; cambios mediante una nueva versión aprobada.
