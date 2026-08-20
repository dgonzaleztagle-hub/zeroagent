# ZeroAgent Runtime

Esta carpeta es una instalación independiente de un agente. No requiere que ZeroAgent Studio permanezca abierto.

El mismo agente se expone por dos entradas: preview web y webhook WhatsApp. Primero se valida la preview con el cliente; el número real se conecta sólo cuando la versión está aprobada.

## Rutas

- `GET /` — landing pública del negocio (`public/landing.html`) si el build trae una; si no, cae a `/m` (celular) o `/agenda` (escritorio). El chat de prueba vive aparte, en `/playground`.
- `GET /playground` — simulador de chat para probar el agente antes de conectar el canal real. `POST /api/preview/chat` exige `PREVIEW_ACCESS_KEY`.
- `POST /api/preview/chat` — conversación de prueba.
- `POST /api/preview/feedback` — pulgar arriba/abajo y respuesta esperada.
- `POST /webhooks/whatsapp` — webhook genérico disponible sólo con `RUNTIME_MODE=preview_local`, `CHANNEL_PROVIDER=generic_webhook` y bearer secret. Nunca se usa en staging ni producción.
- `POST /webhooks/zavu` — adaptador Zavu productivo; exige firma `X-Zavu-Signature` verificada. Un fallo transitorio devuelve `503` para permitir reintento del proveedor; los eventos sólo se deduplican después de enviar y persistir la respuesta.
- `GET /health` — estado del runtime.
- `GET /agenda` — consola operativa de Agenda v1 (si el paquete la habilita).
- `GET /reservar` — página pública de solicitud de reserva.
- `GET /api/agenda/dashboard` — catálogo y reservas operativas.
- `POST /api/agenda/appointments` — crea una solicitud validando datos y cruces de horario.

En Docker/VPS el feedback queda además en `storage/feedback.jsonl`. En Vercel ese disco no persiste: configura `FEEDBACK_WEBHOOK_URL` hacia una API propia/Supabase antes de usarlo con un cliente.

Cada respuesta también registra tokens en `storage/usage.jsonl`. Para sincronizar el panel de consumo de ZeroAgent, configura `METRICS_WEBHOOK_URL`; se envían sólo proveedor, modelo, tokens y referencia de conversación, nunca la API key.

## Cuenta de IA del negocio

En **BYOK**, el negocio aporta una clave OpenAI/Groq/compatible desde su consola; el runtime la cifra AES-256-GCM con `AI_CREDENTIALS_ENCRYPTION_KEY` y sólo guarda el ciphertext en su Supabase. La clave nunca vuelve al navegador.

Las variables `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` y `LLM_BASE_URL` siguen disponibles para instalaciones heredadas y preview. El fallback determinista existe únicamente en `preview_local`; staging y producción fallan cerrados para no fingir una respuesta cuando no hay cuenta/modelo operativo.

## Historial de cliente y admisión

`supabase/agenda-v1-customer-records.sql` agrega un historial append-only por cliente. Los datos declarados en WhatsApp, una importación o la consola conservan origen, mensaje asociado, autor, fecha y una clave idempotente. Las correcciones crean una entrada nueva que referencia a la anterior: no se borra silenciosamente el antecedente original. Los campos resumidos de `za_customers` siguen disponibles para búsquedas rápidas, pero no son el registro histórico.

Esta superficie se llama **ficha de atención/admisión** por defecto. Cada vertical puede cambiar su terminología, pero ZeroAgent no la presenta como una historia clínica regulada ni infiere diagnósticos.

## Instalar

Estándar desde el 30-07-2026: Supabase propio del cliente + despliegue a Vercel. `src/server.js`
es un handler serverless puro (`handleRequest`, ver `api/index.js` + `vercel.json`) — nunca abre
un servidor HTTP propio, así que no existe (ni debe agregarse) un script `npm start` tradicional.

## `agent-package.json` — plantilla vs. cliente construido

`agent-package.json` es un artefacto **por cliente** que genera Studio al construir (`buildClientRuntime`)
— nunca vive suelto en esta carpeta. `npm test` (`src/run-tests.js`) usa `agent-package.fixture.json`
como respaldo cuando no hay uno real, así que el test corre igual sobre la plantilla sola. Pero
**el runtime real (`_local-preview-wrapper.mjs`, `api/index.js`, cualquier deploy) no conoce ese
fixture** — `engine.js#loadPackage()` exige el `agent-package.json` real y falla si no existe.
Para levantar el runtime de verdad sin construir un cliente en Studio, copia el fixture manualmente:
`cp agent-package.fixture.json agent-package.json` (y bórralo después, nunca lo dejes commiteado
con ese nombre).

1. Copiar esta carpeta al repo del cliente y conectarlo a un proyecto Vercel propio.
2. Crear el proyecto Supabase del cliente y ejecutar las migraciones (ver `INSTALLATION_MANIFEST.md`).
3. Configurar las variables de entorno del canal directamente en Vercel (Project Settings → Environment Variables). Nunca agregar credenciales a `agent-package.json` ni commitear `.env.*`.
4. Para correr localmente antes de desplegar: un wrapper aparte importa `{ handleRequest }` de `src/server.js` y abre un servidor HTTP con él (ver `_local-preview-wrapper.mjs` y la entrada `*-runtime-preview` en `.claude/launch.json` de Studio como plantilla). Docker (`Dockerfile`) queda como camino alternativo para VPS, no es el estándar actual.
5. Configurar Zavu para enviar eventos `message.inbound`, `message.sent`, `message.delivered`, `message.read` y `message.failed` a `POST /webhooks/zavu`.
6. Comprobar `GET /health` y ejecutar `npm test` antes de conectar el canal real.

## Qué resuelve esta v1

- Recibe mensajes normalizados por webhook.
- Busca sólo hechos confirmados del paquete.
- Si no tiene una respuesta confirmada, deriva sin inventar.
- Expone pruebas del paquete mediante `npm test`.

Cuando Agenda está habilitada y existen `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, el agente puede llamar herramientas de disponibilidad, consulta de reserva propia, creación, cancelación, reagendamiento y traspaso humano. El teléfono debe llegar normalizado desde el adaptador Zavu; sin identidad verificable el runtime no modifica reservas.

Una evaluación negativa en preview se guarda en `za_feedback_items` y genera un evento `za_outbox_events`. El mecanismo de aviso recomendado (desde el 30-07-2026) es el botón `wa.me` en la consola del cliente (`public/m/m.js`), que el dueño toca para avisar directo por WhatsApp — no depende de cron ni de Sentinel. `npm run dispatch:outbox` / `POST /api/agenda/outbox/dispatch` con `OUTBOX_DISPATCH_TOKEN` y el centinela Telegram (abajo) siguen existiendo como vía alternativa, pero se descartaron como mecanismo principal porque Vercel limita los cron jobs por cuenta, no por proyecto.

Para Zavu productivo se requieren `ZAVUDEV_API_KEY`, `ZAVUDEV_SENDER_ID` y `ZAVUDEV_WEBHOOK_SECRET`. El endpoint dedicado usa el formato validado en Rishi: `X-Zavu-Signature = t=<unix>,v1=<hmac>` y HMAC-SHA256 del body crudo; rechaza firmas ausentes, inválidas o con más de cinco minutos. Cada evento queda en Supabase con estado, lease y checkpoint del reply; los envíos usan una clave idempotente estable y los callbacks actualizan `queued/sent/delivered/read/failed`. `ZAVUDEV_TIMEOUT_MS` y `ZAVU_WEBHOOK_LEASE_SECONDS` permiten ajustar sus límites sin cambiar código.

Las regresiones offline se ejecutan con `npm run test:zavu-delivery`. La compilación PostgreSQL reproducible de base + migraciones (dos pasadas) se ejecuta con `npm run test:supabase-migrations`; usa PGlite y no necesita credenciales ni red.

## Agenda v1

Cuando el paquete activa Agenda, el runtime incluye dos superficies separadas: `/agenda` para la operación del negocio y `/reservar` para quien solicita una hora. Ambas usan la misma API de reservas. Esta instalación inicial mantiene el estado en disco para preview local o VPS; el esquema `supabase/agenda-v1.sql` es la fuente de verdad para el despliegue productivo de cada cliente. No se debe usar el archivo local como persistencia de Vercel.

## Canal y adaptadores

El adaptador productivo de v1 está implementado en `src/zavu.js` y `src/server.js`: verifica HMAC, antigüedad de firma, idempotencia y envíos salientes mediante el SDK de Zavu. La integración no usa una capa genérica adicional y el webhook genérico nunca se configura fuera del preview local.

## Centinela por Telegram (opcional)

Configura `SENTINEL_TELEGRAM_BOT_TOKEN` y `SENTINEL_TELEGRAM_CHAT_ID` en `.env` para recibir alertas internas cuando el agente deba derivar por falta de información confirmada. Tiene una pausa de diez minutos por tipo de alerta para evitar ruido. No se envía ningún mensaje si esas variables no están configuradas.
