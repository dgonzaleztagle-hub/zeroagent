# Auditoría técnica independiente — Agenda, CRM y conversaciones

## Alcance confirmado

Esta es una aplicación a medida, en fase de pruebas y operada por un solo kinesiólogo. No hay login deliberadamente. La consola se protege con `DASHBOARD_ACCESS_KEY`.

**No implementar login, usuarios ni roles como parte de esta auditoría.** No es un defecto dentro del alcance actual.

La revisión se hizo desde cero, sin basarse en informes anteriores. El foco es la integridad de agenda, la relación conversación/ficha de paciente, la confiabilidad de WhatsApp y la capacidad real de prueba.

## Veredicto

La agenda tiene una base robusta: RPCs Supabase, validación de colisiones, transiciones de estado, protección de firma en Zavu e implementación de handoff.

No está lista todavía para operar con pacientes reales sin corregir los P1 listados abajo: hay fallas concretas de identidad de paciente, asociación conversación/ficha, idempotencia concurrente y límites de webhook.

## Pruebas ejecutadas

- `npm run test:agenda-package` → PASS.
- `npm run test:knowledge-regressions` → PASS.
- `npm --prefix runtime-template test` → PASS, usando `agent-package.fixture.json`.
- `node --check` sobre todos los módulos JS de runtime → PASS.
- Validación local de firma Zavu → firma válida aceptada; firma alterada y firma vencida rechazadas.

No se ejecutó `npm run test:supabase-staging` porque el workspace no dispone de `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` ni `SUPABASE_ANON_KEY`. El script existente crea datos QA y los elimina en `finally`; ejecutarlo sólo contra staging, nunca producción.

## Hallazgos P1 — corregir antes de pacientes reales

### 1. Normalización inconsistente de teléfonos

**Evidencia:**

- La reserva web entrega el teléfono como texto libre.
- `createAgendaAppointment()` sólo lo recorta.
- La importación de contactos sí usa `normalizeChilePhone()`.
- `updateCustomerProfile()` y `findCustomerIdByPhone()` buscan coincidencia exacta.
- Otras operaciones comparan sólo dígitos.

`9 1234 5678`, `+56 9 1234 5678` y `+56912345678` pueden crear pacientes distintos o impedir el vínculo conversación↔ficha. También puede fallar la actualización posterior de antecedentes.

**Cambio requerido:** definir una única normalización E.164 para Chile y aplicarla antes de insertar, buscar, actualizar o comparar teléfonos. Migrar/deduplicar los registros existentes antes de activar el cambio en producción.

### 2. Una reserva creada desde el primer mensaje no vincula esa conversación al paciente

**Evidencia:** `server.js` llama a `getOrCreateConversation('whatsapp', callerPhone)` antes de que `create_appointment` cree `za_customers`. `getOrCreateConversation()` intenta enlazar `customer_id`, pero en el primer mensaje no encuentra todavía al cliente. Sólo vuelve a intentarlo en un siguiente mensaje entrante.

Si el paciente agenda y no vuelve a escribir, la ficha existe pero `za_conversations.customer_id` queda nulo.

**Cambio requerido:** tras una reserva WhatsApp exitosa, resolver el paciente por teléfono normalizado y actualizar inmediatamente `za_conversations.customer_id`. Añadir prueba que cubra el primer mensaje de un paciente nuevo.

### 3. Idempotencia Zavu vulnerable a entregas simultáneas

**Evidencia:** el webhook consulta si `event.id` fue procesado, genera/persiste/envía la respuesta y recién al final marca el evento en `za_webhook_events`.

Dos entregas concurrentes del mismo evento pueden superar la consulta inicial y provocar respuestas duplicadas. Es posible que las validaciones de agenda bloqueen una duplicación de hora, pero el mensaje duplicado y los efectos intermedios siguen siendo posibles.

**Cambio requerido:** reclamar el evento atómicamente al inicio con estado `processing`; procesar sólo al ganador; registrar `completed` o permitir reintento controlado de `failed`.

### 4. `/webhooks/zavu` admite cuerpos sin límite

**Evidencia:** `readJson()` limita a 256 KB y `readBuffer()` a 15 MB, pero `readRaw()` usado por Zavu acumula el body sin máximo antes de validar HMAC.

Un POST grande puede consumir memoria/tiempo de la función.

**Cambio requerido:** agregar límite explícito a `readRaw()` y responder HTTP 413 antes de acumular más bytes. Mantener la verificación HMAC sobre el body completo que sí haya sido aceptado.

## Hallazgos P2 — corregir en la siguiente ronda

### 5. Disponibilidad puede ofrecer un servicio que el profesional no realiza

`za_request_appointment()` valida correctamente `za_resource_services`. Sin embargo, `za_available_slots()` no comprueba esa relación y la tool `get_availability` tampoco verifica que `service.name` esté en `resource.services`.

El agente puede mostrar horas válidas y fallar sólo al intentar reservar.

**Cambio requerido:** validar la relación en ambas capas: tool runtime y RPC de slots.

### 6. El smoke test no es una prueba end-to-end

El test runtime usa fixture y respuesta determinista. No cubre webhook, Supabase, tool-calling del LLM, concurrencia, creación de ficha, conversación↔paciente ni envío Zavu.

**Cambio requerido:** incorporar pruebas de integración, como mínimo:

1. Primer WhatsApp de paciente nuevo → reserva → conversación con `customer_id`.
2. Segundo mensaje con antecedentes → actualización de la misma ficha.
3. Dos webhooks simultáneos con el mismo `event_id` → una sola respuesta.
4. Formatos equivalentes de teléfono → un solo cliente.
5. Servicio no asignado a recurso → disponibilidad y reserva rechazadas.

### 7. Fixture permite test verde pero no permite levantar una plantilla sin build

`run-tests.js` usa `agent-package.fixture.json`, pero `engine.js` requiere `agent-package.json` real. Es correcto si se ejecuta un build generado por Studio, pero una plantilla suelta pasa test y luego inicializa el handler con error.

**Cambio requerido:** documentar claramente que la plantilla requiere un build para arrancar, o hacer que `loadPackage()` use fixture sólo en `preview_local` de forma explícita y nunca en staging/producción.

### 8. Historial conversacional se envía al LLM

`engine.js` pasa el historial de mensajes al proveedor LLM. Por tanto, antecedentes, síntomas, lesiones, medicamentos u otros textos clínicos ingresados por WhatsApp pueden llegar al proveedor configurado.

Durante pruebas usar datos ficticios. Antes de pacientes reales, decidir y documentar qué información puede participar en inferencia y qué se debe excluir/minimizar.

## Flujos obligatorios para staging

1. Reserva web válida, dentro de horario, crea una única solicitud.
2. Dos solicitudes simultáneas para el mismo recurso/bloque: sólo una pasa.
3. Reserva fuera de horario o bloqueada: no crea cita.
4. WhatsApp de paciente nuevo: reserva y deja conversación enlazada a ficha en el mismo turno.
5. WhatsApp posterior con edad, ocupación y antecedentes: actualiza esa misma ficha.
6. Formatos `9XXXXXXXX`, `56...` y `+56...`: resuelven al mismo paciente.
7. Evento Zavu repetido y simultáneo: no duplica respuesta.
8. Firma Zavu inválida: 401; body mayor al límite: 413.
9. Consulta de disponibilidad para combinación recurso/servicio inválida: rechazo sin mostrar slots.
10. Handoff: outbox creado, conversación en `handoff` y mensajes posteriores sin respuesta automática.

## Orden recomendado de trabajo

1. Unificar normalización de teléfono y reparar datos de prueba existentes.
2. Enlazar conversación con ficha inmediatamente después de reservar.
3. Corregir idempotencia concurrente del webhook y limitar body crudo.
4. Validar relación servicio-profesional en disponibilidad.
5. Ejecutar prueba real de Supabase staging con limpieza verificada.
6. Añadir la batería de integración anterior.

## Restricciones

- No agregar login ni roles por ahora.
- No ejecutar QA contra producción.
- Usar datos clínicos ficticios durante las pruebas.
- Mantener secretos exclusivamente en variables de entorno, nunca en Git ni en `agent-package.json`.
