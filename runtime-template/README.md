# ZeroAgent Runtime

Esta carpeta es una instalación independiente de un agente. No requiere que ZeroAgent Studio permanezca abierto.

El mismo agente se expone por dos entradas: preview web y webhook WhatsApp. Primero se valida la preview con el cliente; el número real se conecta sólo cuando la versión está aprobada.

## Rutas

- `GET /` — chat web de preview. Configura `PREVIEW_ACCESS_KEY` antes de compartirlo.
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

## Modelo para pruebas reales

El runtime usa un proveedor OpenAI-compatible definido por el cliente: `LLM_PROVIDER=groq|openai|compatible`, `LLM_API_KEY`, `LLM_MODEL` y, para proveedores compatibles como Qwen, `LLM_BASE_URL`. Por defecto conserva Groq con `llama-3.3-70b-versatile`. La clave pertenece sólo al entorno de despliegue y no se exporta junto al agente. El fallback determinista existe únicamente en `preview_local`; staging y producción fallan cerrados para no fingir que el agente respondió correctamente cuando el modelo está caído.

## Instalar

1. Copiar esta carpeta al servidor o computador definido para el cliente.
2. Copiar `.env.example` a `.env` y configurar las credenciales del canal en ese entorno. Nunca agregar credenciales a `agent-package.json`.
3. Ejecutar `npm start`, o construir con `docker build -t zeroagent .` y ejecutar el contenedor.
4. Configurar Zavu para enviar eventos `message.inbound` a `POST /webhooks/zavu`.
5. Comprobar `GET /health` y ejecutar `npm test` antes de conectar el canal real.

## Qué resuelve esta v1

- Recibe mensajes normalizados por webhook.
- Busca sólo hechos confirmados del paquete.
- Si no tiene una respuesta confirmada, deriva sin inventar.
- Expone pruebas del paquete mediante `npm test`.

Cuando Agenda está habilitada y existen `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, el agente puede llamar herramientas de disponibilidad, consulta de reserva propia, creación, cancelación, reagendamiento y traspaso humano. El teléfono debe llegar normalizado desde el adaptador Zavu; sin identidad verificable el runtime no modifica reservas.

Una evaluación negativa en preview se guarda en `za_feedback_items` y genera un evento `za_outbox_events`. Programa `npm run dispatch:outbox` o `POST /api/agenda/outbox/dispatch` con `OUTBOX_DISPATCH_TOKEN` para avisar al centinela Telegram configurado. La alerta contiene sólo un identificador y el tipo de evento; el contenido se revisa desde el Supabase del cliente mediante el vault autorizado.

Para Zavu productivo se requieren `ZAVUDEV_API_KEY`, `ZAVUDEV_SENDER_ID` y `ZAVUDEV_WEBHOOK_SECRET`. El endpoint dedicado usa el formato validado en Rishi: `X-Zavu-Signature = t=<unix>,v1=<hmac>` y HMAC-SHA256 del body crudo; rechaza firmas ausentes, inválidas o con más de cinco minutos. Configura Zavu para enviar `message.inbound` a `/webhooks/zavu`.

## Agenda v1

Cuando el paquete activa Agenda, el runtime incluye dos superficies separadas: `/agenda` para la operación del negocio y `/reservar` para quien solicita una hora. Ambas usan la misma API de reservas. Esta instalación inicial mantiene el estado en disco para preview local o VPS; el esquema `supabase/agenda-v1.sql` es la fuente de verdad para el despliegue productivo de cada cliente. No se debe usar el archivo local como persistencia de Vercel.

## Canal y adaptadores

El adaptador productivo de v1 está implementado en `src/zavu.js` y `src/server.js`: verifica HMAC, antigüedad de firma, idempotencia y envíos salientes mediante el SDK de Zavu. La integración no usa una capa genérica adicional y el webhook genérico nunca se configura fuera del preview local.

## Centinela por Telegram (opcional)

Configura `SENTINEL_TELEGRAM_BOT_TOKEN` y `SENTINEL_TELEGRAM_CHAT_ID` en `.env` para recibir alertas internas cuando el agente deba derivar por falta de información confirmada. Tiene una pausa de diez minutos por tipo de alerta para evitar ruido. No se envía ningún mensaje si esas variables no están configuradas.
