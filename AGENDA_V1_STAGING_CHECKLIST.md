# ZeroAgent Agenda v1 · checklist de staging

Esta lista se ejecuta por cliente, después de generar una versión aprobada. No contiene secretos.

## 1. Infraestructura del cliente

- [ ] Repositorio y hosting creados a nombre del cliente.
- [ ] Proyecto Supabase creado a nombre del cliente.
- [ ] URL y service key guardadas sólo en el vault local del Studio; conexión probada.
- [ ] Ejecutado `supabase/agenda-v1.sql` en el proyecto Supabase correcto.
- [ ] Con `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y una `SUPABASE_ANON_KEY` temporal cargadas sólo en la terminal, ejecutado `npm run test:supabase-staging`. La anon key se usa exclusivamente para comprobar que las RPC bloquean accesos públicos; no se instala en el runtime del cliente.
- [ ] Variables de hosting configuradas: Supabase, proveedor LLM, `DASHBOARD_ACCESS_KEY`, Zavu y Telegram/outbox si aplica.

## 2. Paquete y catálogo

- [ ] Copiado el build aprobado al proyecto staging del cliente.
- [ ] Ejecutado `npm install` y `npm run setup:agenda`.
- [ ] Verificados sedes, servicios, profesionales y relaciones servicio-profesional.
- [ ] Configurados horarios semanales explícitos por profesional desde `/agenda`.
- [ ] Ejecutado `npm test` dentro del paquete.
- [ ] Confirmado `GET /health` y `/agenda` protegida.

## 3. Flujo de agenda

- [ ] Web `/reservar`: solicitud válida crea una reserva pendiente/confirmada según configuración.
- [ ] Intentar mismo recurso y bloque horario: una sola solicitud puede pasar.
- [ ] Intentar fuera de horario o bloqueado: se rechaza.
- [ ] Dashboard: confirmar, cancelar y agregar/quitar horario producen el estado esperado.
- [ ] Agente: consultar disponibilidad no altera una reserva.
- [ ] Agente: reagendar requiere selección explícita, luego confirma sólo tras éxito de herramienta.
- [ ] Agente: intenta modificar reserva desde otro teléfono → rechaza.
- [ ] Agente: handoff crea outbox, avisa y luego deja de responder automáticamente.

## 4. Zavu y feedback

- [ ] Zavu envía `message.inbound` a `/webhooks/zavu`.
- [ ] Firma válida responde y firma alterada obtiene 401.
- [ ] Evento repetido no genera otra respuesta.
- [ ] Remitente recibe respuesta por el sender configurado.
- [ ] Feedback negativo aparece en `za_feedback_items`, crea `za_outbox_events` y llega alerta Telegram si está configurado.
- [ ] Studio local, usando vault, visualiza feedback pendiente del Supabase cliente.

## 5. Pase a producción

- [ ] Preflight `target=production` sin blockers.
- [ ] Dueño del negocio destruyó el agente en staging y aprobó por escrito/versionado.
- [ ] Build, URL y versión de producción anotados en ZeroAgent Studio.
- [ ] Sólo entonces se conecta el sender/número productivo en Zavu.

## Criterio de no avance

No pasar a producción si hay una mutación sin verificación de identidad, disponibilidad no respaldada por Supabase, feedback sin persistencia, webhook sin firma válida o un handoff donde el agente siga respondiendo.
