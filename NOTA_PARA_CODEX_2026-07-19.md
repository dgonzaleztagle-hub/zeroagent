# Nota para Codex — auditoría cruzada de ZeroAgent (hecha por Claude Code, 19-07-2026)

## Qué es este documento

Daniel le pidió a Claude Code que auditara este repo (que tú, Codex, construiste como creador primario) desde cuatro lentes: backend Studio, runtime del cliente, frontend, y honestidad documental (docs vs código real). Después hubo una segunda pasada enfocada específicamente en el "corazón" del producto: el motor de entrenamiento, el flujo de conversación y las tools del agente.

Este documento junta ambas pasadas para que las revises con tu propio contexto — tú escribiste este código, así que puedes confirmar, matizar o corregir cualquier hallazgo con información que Claude no tiene (por qué se tomó tal decisión, si algo ya estaba en plan de arreglarse, etc.). No está escrito como veredicto final, sino como insumo para que la analices y le respondas a Daniel con tu propia lectura.

El detalle completo del primer barrido (con más hallazgos menores) está en `AUDITORIA_2026-07-19.md`, en la raíz de este mismo repo. Acá va el resumen accionable + lo nuevo sobre arquitectura del núcleo.

## Contexto del modelo de despliegue (confirmado por Daniel, para que no haya ambigüedad)

- **Studio (`server.js`, `app.js`, SQLite local) es 100% local y nunca se expone a internet.** Reemplaza a un LLM corriendo en la nube: el trabajo de entrenar, cargar info, leer documentos/imágenes y aplicar arreglos transversales lo hace el IDE (Codex o Claude) a pedido, no un servicio 24/7.
- **`commercial-demo.*` es intencionalmente una demo de venta sin LLM ni integraciones reales** ("mira cómo funciona, si te gusta te armo uno"). No es el producto.
- **El artefacto de producción real es `runtime-template/`**: se empaqueta con las credenciales propias del cliente (OpenAI/Groq, Supabase, Zavu) y se despliega en el Vercel del cliente. Ciclo de vida: Studio entrena/configura → se empaqueta → se instala con credenciales del cliente → el cliente ve sus conversaciones en vivo y puede tomar control → feedback de "pulgar abajo" + corrección manda señal a Studio → Daniel + IDE revisan y publican el arreglo en el Vercel del cliente. Ninguna corrección toca producción automáticamente (esto ya está bien resuelto en el código, confirmado).

Esto recalibra severidad: lo que vive solo en Studio es menos urgente (superficie de ataque casi nula, es local). Lo que vive en `runtime-template/` es lo que corre en vivo con datos y credenciales reales de cada cliente — ahí los hallazgos de seguridad sí son bloqueantes de lanzamiento.

---

## 1. Hallazgos de seguridad que aplican al paquete real del cliente (`runtime-template/`)

Estos son los que consideraría bloqueantes antes de instalar en un cliente real (Vikram/Rishtedar u otro):

1. **`/webhooks/whatsapp` sin verificar firma** (`runtime-template/src/server.js:374-400`). Toma `event.from`/`event.phone` del body tal cual y lo trata como teléfono verificado. Cualquiera que conozca la URL puede suplantar el teléfono de un cliente real y cancelar/reagendar sus citas. `CHANNEL_PROVIDER` (`.env.example:3`), que debería gatear esta ruta, nunca se lee en el código — la ruta está siempre viva. Contraste: el webhook real de Zavu (`server.js:401-431`) sí tiene HMAC-SHA256 + `timingSafeEqual` + anti-replay + dedupe, bien hecho.

2. **RPCs de Supabase otorgadas sin chequeo de dueño dentro de la función.** `runtime-template/supabase/agenda-v1.sql:297` otorga `za_request_appointment` a `anon`; `:345` otorga `za_reschedule_appointment` a `authenticated`. La verificación de "el teléfono que pide esto es dueño de la reserva" vive solo en Node (`agenda-tools.js:28-34`), nunca dentro de la función SQL. Como `SUPABASE_ANON_KEY` se distribuye al cliente por diseño (`INSTALLATION_MANIFEST.md:9`), cualquiera con esa key puede llamar la RPC directo contra Supabase y saltarse Node por completo.

3. **`previewAuthorized`/`dashboardAuthorized` fallan abiertos** (`runtime-template/src/server.js:87-95`): si `PREVIEW_KEY`/`DASHBOARD_KEY` no están seteadas en el `.env` del cliente, la función devuelve `true` incondicionalmente — consola operativa completa (conversaciones reales, envío de mensajes como humano, pausa del agente) queda pública sin login. Nada en el Dockerfile fuerza que esas variables existan.

4. **XSS real en `/reservar`** (`runtime-template/public/booking.html:2`): `x.name` (nombres de servicios/profesionales que el dueño del negocio escribe en texto libre en Studio) se inyecta en `innerHTML` sin escapar. Es el único archivo de todo el frontend que rompe el patrón `esc()`/`escp()` que el resto sigue consistentemente — fácil de alinear.

5. **Doble reserva real por el panel del dueño**, no solo por WhatsApp: `runtime-template/src/agenda.js:206-224` (`PATCH /api/agenda/appointments/:id`) cambia `status` sin volver a chequear solapamiento ni pasar por la RPC atómica. Las RPCs (`za_request_appointment`/`za_reschedule_appointment`, `agenda-v1.sql:264-342`) sí usan `pg_advisory_xact_lock` + `tstzrange` correctamente — el bug es que este endpoint del dashboard evita ese camino.

6. **`create_appointment` por WhatsApp se salta `minimum_notice_hours`**: `agenda-tools.js:54-63` llama la RPC directo sin pasar por `createAgendaAppointment` (`agenda.js:151-181`), que es donde vive ese chequeo. Un cliente puede pedir un horario a 5 minutos y el sistema lo permite por WhatsApp aunque no por la web.

7. **`request_human_handoff` no es atómico** (`agenda-tools.js:76-82`): crea el evento de outbox y actualiza la conversación en dos pasos separados; si el segundo falla, el LLM le informa al usuario que el traspaso no se logró, pero el evento outbox ya quedó creado y disparará alerta, mientras la conversación sigue "activa" y el bot le sigue respondiendo al cliente.

8. **El preflight de staging/producción es código muerto en el único flujo real de build**: `server.js:1575` llama `getInstallationPreflight(clientId)` sin el segundo argumento `target`, así que siempre evalúa como `preview`. El frontend de Studio tampoco llama nunca a `GET /installation-preflight`. Se puede empaquetar y entregar un agente sin que el Supabase del cliente esté conectado.

En Studio local (baja urgencia dado que nunca sale de la máquina, pero baratos de cerrar): `app.use(cors())` sin opciones en `server.js:227` (origen `*` por defecto), y un `client id` sin sanitizar en `server.js:1625/1733` que permite escritura de archivos fuera de `storage/` si alguien logra llegar a esa API. Detalle completo de esto y de los hallazgos medios/bajos en `AUDITORIA_2026-07-19.md`.

---

## 2. Lo que encontré sobre el "corazón" (motor, flujo, entrenamiento) — esto es lo que más quiero tu lectura

### 2.1 El contrato declarativo de flujos no lo ejecuta nadie

`zeroagent-standard/flows.yaml` y `agent.yaml` definen un motor genérico por bloques (`identify_intent`, `retrieve_facts`, `answer_with_facts`, `ask_for_field`, `save_field`, `recommend`, `calculate_total`, `create_lead`, `create_reservation_request`, `notify_human`, `handoff_human`, `close_conversation`) pensado para que Agenda, Ventas, Captación de leads y Atención compartan un mismo intérprete — así lo describe `PROJECT_CONTEXT.md`: *"El modelo admite varias verticales mediante contratos configurables."*

Hice `grep` de esos nombres de bloque en todo el `.js` del repo (fuera de `node_modules`): **cero coincidencias.** Nadie lee `flows.yaml` en runtime. Lo único que existe implementado es Agenda, escrita a mano y directa como tool-calling en `runtime-template/src/engine.js` + `agenda-tools.js`. Las 6 tools reales (`get_availability`, `get_my_appointment`, `create_appointment`, `cancel_appointment`, `reschedule_appointment`, `request_human_handoff`) están bien cubiertas y bien diseñadas — el problema no es Agenda en sí, es que el "motor multi-vertical" que el contrato promete es hoy solo el YAML, sin intérprete.

**Pregunta para Codex**: ¿este motor de bloques estaba planeado como el próximo paso, o quedó como documento de intención sin plan concreto de implementarlo? Si Agenda sigue siendo la única vertical real por un buen tiempo (que es lo que dice `PROJECT_CONTEXT.md` como orden correcto), ¿vale la pena mantener el YAML como visión, o conviene marcarlo explícitamente como "no implementado" para que nadie lo asuma como capacidad real?

### 2.2 Hay tres implementaciones independientes del mismo "responder con LLM + hechos confirmados", y no se prueban lo mismo

1. `runtime-template/src/engine.js` (`answerWithGroq`) — el motor real de producción: tool-calling completo con Agenda, scoring de hechos por palabras clave (`words()`).
2. `server.js:2097` (`POST /api/clients/:id/playground/chat`, Studio) — reimplementación manual del mismo prompt para el playground de prueba, pero **sin ningún tool de Agenda expuesto**.
3. `llm-helper.js` (lado navegador, Studio) — llama a Gemini directo desde el browser con `?key=` en la URL, con su propio prompt y lógica de tono.

Las tres tienen su propio texto de system prompt y su propia función de scoring — no comparten código. Consecuencia concreta: si en el playground de Studio Daniel escribe "resérvame mañana a las 3", el playground no tiene tools de Agenda, así que cae al fallback de "no tengo ese dato confirmado" — nunca ejerce el flujo real de reservas que sí vive en `engine.js`. Lo que se aprueba en el playground no es garantía de lo que el cliente real experimenta.

**Pregunta para Codex**: ¿el playground de Studio se pensó como una prueba rápida de tono/hechos nomás (no de tools), o se esperaba que validara el flujo completo? Si es lo segundo, ¿la forma más simple de unificarlo es que el playground invoque el mismo `engine.js`/`agenda-tools.js` del runtime en vez de reimplementar el prompt en `server.js`?

### 2.3 El retrieval de hechos es por palabras clave, no semántico

`words()` en `engine.js` (y su equivalente en `server.js`) tokeniza y cuenta solapes exactos de palabras entre la pregunta y `category`/`subject`/`value` de cada hecho. Hay un parche puntual (`engine.js:28-34`) que vincula una pregunta de test *exacta* ya aprobada a su hecho, para no perder esa respuesta por variación de fraseo — es un band-aid al síntoma, no una solución al retrieval en sí. A medida que la base de conocimiento de un cliente crezca y las preguntas reales varíen más en fraseo, esto va a generar más "no tengo ese dato confirmado" de lo necesario, que es justo lo que alimenta el ciclo de "pulgar abajo" → corrección manual.

**Pregunta para Codex**: ¿se evaluó embeddings/retrieval semántico y se descartó por costo/latencia, o es simplemente lo próximo en la lista? Dado que ya hay una llamada a un proveedor LLM configurada (Groq/OpenAI), agregar un paso de embeddings no debería ser un salto grande de infraestructura.

### 2.4 Monolito: confirmado, pero solo en Studio

Línea por línea: `server.js` (Studio) tiene 2267 líneas, `app.js` (Studio) 1616. En cambio `runtime-template/src/*.js` (lo que se empaqueta para el cliente) está modularizado de forma sana: 12 archivos, el más grande 435 líneas (`server.js` del runtime), el resto entre 12 y 297. El monolito vive específicamente en la herramienta interna (Studio), no en el producto que se entrega — El patrón correcto de modularización ya existe en el mismo repo como referencia; sería cuestión de aplicar el mismo criterio a `server.js`/`app.js` (separar por dominio: rutas de clientes, agenda, prospección, onboarding, vault).

---

## 3. Lo que está bien hecho (para no perder la referencia al iterar)

- Separación real Studio/runtime: si Studio se apaga, el agente del cliente sigue operando.
- RPCs atómicas de Supabase con `pg_advisory_xact_lock` + `tstzrange` — evitan doble reserva a nivel de base de datos correctamente.
- Vault sin secretos hardcodeados, cifrado real vía DPAPI de Windows.
- Webhook de Zavu (canal productivo real) con HMAC-SHA256 + anti-replay + dedupe.
- Escape HTML consistente en casi todo el frontend.
- Las 6 tools de Agenda están bien definidas y bien acotadas en su contrato (parámetros, descripciones que dejan claro qué no deben hacer).

## Qué se espera de esta lectura

Daniel quiere ver cómo analizas esto desde tu propio contexto de haber escrito el código — no es necesario que estés de acuerdo con todo. Si algo de esto tiene una razón de diseño que Claude no vio, o si algo ya estaba planeado para la siguiente iteración, decilo explícito para que Daniel tenga las dos lecturas antes de decidir qué se prioriza.
