# Auditoría ZeroAgent (código generado por GPT/Codex) · 19-07-2026

> Auditoría cruzada por 4 lentes independientes: backend Studio, runtime del cliente, frontend, y honestidad documental (docs vs código real). Cada hallazgo fue verificado leyendo el código, no inferido de nombres de archivo.

## Opinión general

El volumen y la arquitectura de fondo son sólidos: la separación Studio/runtime se respeta de verdad (si Studio se apaga, el agente del cliente sigue vivo), las RPC de reservas en Postgres usan `pg_advisory_xact_lock` + `tstzrange` correctamente (evitan doble reserva a nivel de base de datos), el vault usa DPAPI de Windows sin secretos hardcodeados, y el patrón de escape HTML (`esc()`/`escp()`) se aplica de forma consistente en casi todo el frontend.

Pero el perfil de bugs es el clásico de un modelo que escribe mucho código en una sola pasada sin una revisión adversarial posterior: **asume por defecto que todo corre en un entorno de confianza** (Studio sin auth, CORS abierto a `*`, webhook alternativo sin firma, RPCs de Supabase abiertas a `anon`/`authenticated` sin chequeo de dueño) y **la documentación se queda un nivel de confianza por encima de lo que el código realmente garantiza** (tests que verifican que un string existe pero se documentan como "batería contractual", preflights de staging/producción que existen en el código pero nunca se invocan desde el único flujo real de build). Ninguno de estos son bugs sutiles de lógica — son exactamente el tipo de cosas que aparecen cuando se audita por separación de responsabilidades y frontera de confianza, no leyendo archivo por archivo si "se ve bien escrito".

Dado que el plan es vender esto white-label a clientes reales (Vikram/Rishtedar como primer candidato), los hallazgos críticos de abajo son bloqueantes de lanzamiento, no deuda técnica a futuro.

## Contexto real del modelo de despliegue (aclarado por Daniel, 19-07-2026)

Esta auditoría se escribió antes de tener el modelo completo. Aclaración clave que recalibra severidades:

- **Studio (`server.js`, `app.js`, SQLite local) es 100% local y nunca se expone a internet.** No es un SaaS ni un servicio con IP pública — es la herramienta con la que Daniel (y el IDE, Claude/Codex) entrena, carga info, lee documentos/imágenes y aplica arreglos transversales. El "cerebro en la nube" que reemplaza a un LLM corriendo 24/7 es literalmente el IDE haciendo el trabajo a pedido, no un servidor. Esto baja la urgencia de los hallazgos #1 y #2 de abajo: no son explotables por un desconocido en internet.
- **Lo que se ve como "consola/demo del cliente" en `commercial-demo.*` es intencionalmente una demo de venta sin LLM ni integraciones reales** ("mira cómo funciona, si te gusta te armo uno"). El hallazgo de "cae a datos demo en silencio" no aplica ahí — se supone que muestra datos demo.
- **Lo que sí es el artefacto de producción real es `runtime-template/`**: eso es lo que se empaqueta con las credenciales propias del cliente (OpenAI, Supabase, Zavu) y se despliega en el Vercel del cliente, con conversaciones y reservas reales. El ciclo de vida productivo es: Studio entrena/configura → se empaqueta → se instala con credenciales del cliente → el cliente ve sus conversaciones en vivo y puede tomar control → feedback de "pulgar abajo" + corrección manda señal a Studio → Daniel (+ IDE) revisa y publica el arreglo en el Vercel del cliente. Nada de esto corrige producción automáticamente (coincide con lo ya documentado en `PROJECT_CONTEXT.md`: "una corrección nunca altera producción automáticamente").
- **Consecuencia para esta auditoría**: los hallazgos que viven en `server.js`/`app.js` (Studio) bajan de prioridad porque su superficie de ataque real es mucho menor de lo que asumí inicialmente. Los hallazgos que viven en `runtime-template/` (RPCs de Supabase, webhook, `booking.html`, `client-console-v2.js`, preflight de instalación) **suben o mantienen prioridad crítica**, porque ese código es exactamente lo que termina corriendo en vivo, con credenciales reales, en la infraestructura del cliente — no hay "solo es local" que lo proteja ahí.

---

## 🔴 Críticos — aplican al paquete real del cliente (`runtime-template/`), son bloqueantes de lanzamiento

### 1. El webhook alternativo `/webhooks/whatsapp` no verifica firma ni identidad
`server.js:374-400` toma `event.from`/`event.phone` del body tal cual y lo trata como "teléfono verificado por canal" — justo lo que la regla de negocio del proyecto prohíbe. Cualquiera que conozca la URL puede suplantar el teléfono de un cliente real y cancelar/reagendar sus citas o leer sus datos. La variable `CHANNEL_PROVIDER` que debería gatear esta ruta (`.env.example:3`) nunca se lee en el código — la ruta está siempre viva.

### 2. Las RPC de Supabase permiten saltarse el backend y la verificación de identidad por completo
`runtime-template/supabase/agenda-v1.sql:297` otorga `za_request_appointment` a `anon`; `:345` otorga `za_reschedule_appointment` a `authenticated`. Ninguna de las dos valida el teléfono dueño de la reserva dentro de la función SQL (esa validación vive solo en Node, `agenda-tools.js:28-34`). Como la `SUPABASE_ANON_KEY` se distribuye al cliente por diseño (`INSTALLATION_MANIFEST.md:9`), cualquiera con esa key puede llamar la RPC directo contra Supabase y reagendar la cita de **otro cliente**, o crear reservas `confirmed` saltándose el modo de confirmación configurado (spam/DoS de agenda).

### 3. La consola y el preview del cliente fallan **abiertos** si no se configuró la clave de acceso
`runtime-template/src/server.js:87-95` — `previewAuthorized`/`dashboardAuthorized` devuelven `true` si `PREVIEW_KEY`/`DASHBOARD_KEY` no están seteadas en el `.env` del cliente. Es un olvido de configuración fácil (nada en el Dockerfile lo fuerza) que deja **toda la consola operativa pública sin login**: conversaciones con teléfono real, envío de mensajes como humano por WhatsApp, pausa del agente, y el bug de doble reserva del punto #7.

### 4. XSS real en la página pública de reservas (`/reservar`, sin login)
`runtime-template/public/booking.html:2` inyecta `x.name` (nombres de servicios/profesionales que el dueño del negocio escribe en texto libre en Studio) directo en `innerHTML` sin escapar — es el único archivo de todo el frontend que rompe el patrón de escape que el resto del código sigue consistentemente. Cualquier cliente final que abra la página pública de reservas ejecuta lo que el dueño haya puesto (o lo que alguien le haya inyectado) en ese campo.

---

## ⚪ Studio local — prioridad baja dado el modelo (no expuesto a internet), pero baratos de arreglar

### A. Studio no tiene autenticación y acepta CORS de cualquier origen
`server.js:227` — `app.use(cors())` sin opciones = origen `*` por defecto. No es explotable por un desconocido en internet porque Studio nunca sale de tu PC. El riesgo residual real: mientras Studio corre, cualquier pestaña de tu navegador con JS de un sitio cualquiera podría, en teoría, hacer `fetch` a `localhost:8080`. Bajo, no cero. Igual vale la pena cerrarlo en algún momento (un simple check de header o bind a `127.0.0.1` con un token local) porque es barato y elimina la superficie por completo.

### B. Path traversal: `client id` sin sanitizar permite escritura de archivos fuera de `storage/`
`server.js:1733` (creación de cliente) no valida el formato del `id`; `server.js:1625` lo usa tal cual en un `path.join`. Sin superficie de ataque remota dado que Studio es local, pero sigue siendo un descuido real (inconsistente con `buildClientRuntime`, que sí sanitiza el mismo tipo de valor vía `safeFileName`, server.js:330) — fácil de arreglar con la misma función que ya existe en el propio archivo.

---

## 🟠 Altos (aplican al paquete real del cliente salvo que se indique lo contrario)

### 7. Doble reserva real vía el panel del dueño (no solo por WhatsApp)
`runtime-template/src/agenda.js:206-224` (`PATCH /api/agenda/appointments/:id`, usado por el dashboard) cambia el `status` de una reserva sin volver a chequear solapamiento de horario ni pasar por la RPC atómica. Escenario: reserva A rechazada libera el slot → cliente B reserva y confirma el mismo horario → el dueño reactiva A por error → A y B quedan ambas `confirmed` para el mismo recurso/horario.

### 8. `cancel_appointment` (tool del LLM) hace un PATCH sin bloqueo optimista
`agenda-tools.js:64-68` cancela sobre un snapshot potencialmente desactualizado, sin condición `?status=eq.confirmed`. Riesgo de lost-update si otra operación tocó la reserva entre el fetch y el PATCH.

### 9. `create_appointment` por WhatsApp se salta el aviso mínimo configurado
`agenda-tools.js:54-63` llama la RPC directo sin pasar por `createAgendaAppointment` (`agenda.js:151-181`), que es donde vive el chequeo de `minimum_notice_hours`. Un cliente puede pedir "resérvame en 5 minutos más" por WhatsApp y el sistema lo permite, aunque el negocio configuró horas de aviso mínimo — la misma regla se cumple en la web pero no en el canal LLM.

### 10. El preflight de staging/producción es código muerto en el único flujo real de build
`server.js:1575` llama `getInstallationPreflight(clientId)` **sin** el segundo argumento `target`, así que siempre evalúa como `preview` — nunca bloquea por falta de Supabase real configurado, sin importar para qué etapa se construye el paquete. El frontend tampoco llama nunca a `GET /installation-preflight` (solo lo usan dos scripts de demo). Resultado: se puede empaquetar y entregar un agente con Agenda activa sin que el Supabase del cliente esté siquiera conectado.

### 11. `request_human_handoff` no es atómico — puede prometer un traspaso que no queda registrado
`agenda-tools.js:76-82` crea el evento de outbox y luego actualiza la conversación en dos pasos separados; si el segundo falla, el LLM le dice al usuario que el traspaso *no* se logró, pero el evento outbox ya se creó (y eventualmente alertará por Telegram), mientras la conversación sigue "activa" y el bot le sigue respondiendo al cliente en vez de callarse. Tres fuentes de verdad (cliente, dashboard, alerta) quedan desincronizadas.

### 12. La consola cae a datos demo falsos en silencio si el backend falla — no es problema en la vitrina comercial, sí en el paquete real instalado
El comportamiento de `client-console-v2.js:22` (fallback a "Casa Aura" ante cualquier error de fetch) es exactamente lo que quieres en `/demo/panel` — es la vitrina de venta y ahí el fallback demo es la función correcta. El problema es que `client-console-v2.js` es **el mismo archivo** que se empaqueta dentro de `runtime-template/public/` y se instala con las credenciales reales del cliente. Ahí, si `/api/agenda/dashboard` falla por cualquier razón real (clave mal puesta, Supabase caído, red), el dueño del negocio vería "Casa Aura" sin saber que son datos falsos y que su backend real no responde — justo el escenario que el nuevo flujo de "el cliente revisa en vivo sus conversaciones y toma control si lo necesita" necesita evitar. Arreglo acotado: que el fallback demo solo se active bajo un flag explícito de modo demo (`?demo=1`/`embed=1`, que ya existe para la vitrina), y que en el paquete instalado real un error de fetch muestre un estado de error visible en vez de sustituir con datos falsos.

---

## 🟡 Medios

- **Cero transacciones SQL en todo Studio.** Import/reset de configuración (`server.js:2151-2251`) y aplicar propuesta de intake (`server.js:1253-1298`) son loops de inserts sin rollback; un error a mitad de camino deja estado parcial (mitigado parcialmente por snapshot JSON previo, pero la recuperación es manual).
- **Vault DPAPI sin master key propia ni backup** (`vault.js:12-22`): la clave de cifrado está atada al perfil de Windows que corre Studio. Migrar de máquina/cuenta o containerizar Studio vuelve indescifrables todas las credenciales guardadas — hay que repedir la Service Role Key a cada cliente.
- **Verificación de conexión Supabase superficial**: `server.js:2033` marca "conectado" con cualquier respuesta que no sea 401/403 — un 404 o 500 de un endpoint mal formado también cuenta como "conectado".
- **La documentación infla la cobertura de pruebas.** `npm run test:agenda-package` se documenta como que "ejecuta la batería contractual del runtime", pero en la práctica sólo verifica que ciertos strings/archivos existan (excepto la prueba de firma HMAC de Zavu, que sí es real). Los `regression_scenarios` nombrados en `zeroagent-standard/agenda-v1.yaml` y `agenda-v1-flows.yaml` no tienen ningún test ejecutable asociado en todo el repo.
- **La garantía "nunca confirma sin éxito de la herramienta" es solo disciplina de prompt**, no un guard de código: `engine.js:104-108` devuelve el texto del LLM sin comparar contra el `toolTrace` real.
- **Sentinel no se dispara desde el webhook productivo real** (`/webhooks/zavu`); solo desde el webhook genérico sin auth (#3) o desde un despacho de outbox diferido/manual — un handoff general por falta de información en el canal productivo no genera alerta inmediata.
- **Dos sistemas de diseño CSS completos compitiendo** en el Studio (`style.css` 1795 líneas vs `studio-redesign.css` con `!important` para ganarle) — deuda técnica real, doble fuente de verdad para los mismos componentes.
- **Bug visual concreto y verificable**: `--border-color`/`--primary-color` no están definidas en ningún `:root` — la barra de progreso de consumo de IA en "Monitoreo" es invisible en estado normal.

## 🟢 Bajos (higiene, no bloquean nada)

- Manejo de errores inconsistente entre archivos del frontend: varios `fetch` sin `.catch` dejan botones en "Guardando..." para siempre o silencian el error (`studio-redesign.js:10`, `client-console-v2.js` en varias acciones del listener central, `onboarding.js:34` que descarta un error de guardado y avanza igual).
- Varias rutas de Express desestructuran `req.body` antes del `try`, así que un request sin `Content-Type: application/json` tira un error HTML de Express en vez de JSON.
- Catches vacíos sin log en parseos de config JSON (`server.js:387,1074,1375,1444`) — si se corrompe la config de un cliente, nadie se entera.
- `outbox.js:23-26` traga el error real en el catch sin loggearlo, y puede abortar el resto del batch de notificaciones si el segundo paso también falla.
- Dockerfile sin `.dockerignore` — riesgo de empaquetar `.env`/`storage` en la imagen si el build corre desde un checkout descuidado.
- Manejo de secretos inconsistente: la Service Role Key de Supabase pasa por el vault cifrado; la API key de Gemini se guarda en `localStorage` en texto plano y viaja como query string.

---

## Gaps y oportunidades

**Gaps de producto/proceso** (no son bugs de código, son huecos frente a lo que el proyecto necesita para venderse):
- No existe ningún test automatizado que realmente pruebe contra un Supabase de staging — todo el "cierre de Agenda v1 en código" documentado en `PROJECT_CONTEXT.md` sigue sin una sola corrida real de integración. Antes de vender a Vikram u otro cliente, esto tiene que pasar de "pendiente" a hecho.
- Falta un mecanismo de rotación/backup de vault que no dependa del perfil de Windows — si vas a operar esto como negocio (no como script personal), un solo laptop siendo la única fuente de las credenciales de todos tus clientes es un punto único de falla serio.
- Falta un indicador visible en la consola del cliente que diga "esto son datos demo" quando cae a modo fallback — barato de agregar y evita un problema de confianza grave con clientes reales.

**Oportunidades de generalización** (para `C:\proyectos\MODULOS`, siguiendo tu patrón de convertir piezas específicas en producto reusable):
- El patrón de RPC atómica con `pg_advisory_xact_lock` + `tstzrange` para evitar doble-booking (`agenda-v1.sql:264-342`) está bien resuelto y es 100% reusable para cualquier vertical de agendamiento futura (Voz, otros clientes) — vale la pena extraerlo como snippet/módulo de referencia en vez de reescribirlo cada vez.
- El vault DPAPI (`vault.js`) es un patrón limpio de "credenciales de cliente cifradas localmente, nunca en el navegador" que aplica a cualquier Studio local que administre infraestructura de terceros — candidato a módulo genérico, una vez resuelto el gap de backup/rotación de arriba.
- La separación Studio/runtime (el paquete instalable no depende del proceso que lo construyó) es un patrón de arquitectura sólido que vale la pena mantener como principio no negociable en cualquier producto similar que construyas.

---

## Qué está bien hecho (para no perder la referencia)

- Separación real Studio/runtime: si Studio se apaga, el agente del cliente sigue operando — verificado en código, no solo en documentación.
- RPCs atómicas de Supabase con locking correcto contra doble reserva a nivel de base de datos.
- Vault sin secretos hardcodeados, cifrado real vía DPAPI.
- Webhook de Zavu (el canal productivo real) con HMAC-SHA256 + `timingSafeEqual` + anti-replay + dedupe — bien implementado, contrasta con el webhook alternativo sin protección (#1).
- Escape HTML consistente en casi todo el frontend (la excepción de `booking.html` es la rareza, no la norma).
- Generación de tokens de onboarding con entropía adecuada (~244 bits, no predecible).
