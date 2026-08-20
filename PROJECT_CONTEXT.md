# ZeroAgent · contexto vivo del proyecto

> Leer este archivo antes de diseñar, cambiar o delegar trabajo. Se actualiza al cerrar cada hito importante.
> No contiene secretos, API keys, URLs privadas ni datos de clientes.

## Propósito

ZeroAgent es un Studio **local** para construir, probar, versionar e instalar agentes de WhatsApp que pertenecen a cada cliente. No es un SaaS central ni un producto público multi-tenant.

La primera solución vertical es **ZeroAgent Agenda v1**: reservas/agendamiento para negocios de servicios (barberías, spa, centros de atención, etc.). Rishtedar/Rishi es la referencia de calidad operacional, no una dependencia de código.

## Regla de colaboración con Daniel

Daniel prioriza **eficiencia y solidez por sobre rapidez aparente**. Puede explorar muchas ideas y verticales en paralelo; la responsabilidad del agente principal no es obedecer cada desvío como una nueva prioridad, sino mantener el objetivo, ordenar el trabajo y cubrir los huecos que Daniel no esté viendo.

Reglas operativas:

1. Antes de ampliar alcance, verificar qué falta para cerrar de verdad el núcleo activo.
2. Distinguir ideas, prototipos, código implementado, código validado y capacidad productiva. Nunca usar “cerrado”, “listo” o “seguro” como sinónimos.
3. Cuestionar y criticar decisiones de Daniel cuando agreguen dispersión, deuda, riesgo o contradigan el objetivo, explicando el motivo con claridad.
4. No optimizar para mostrar mucho avance. Optimizar para reducir retrabajo, riesgo y complejidad total.
5. Cada capacidad productiva pasa por: diseño → implementación → pruebas funcionales → revisión adversarial/seguridad → integración real → documentación honesta.
6. Mantener un solo frente principal y registrar las ideas laterales como backlog hasta que el frente cumpla sus criterios de salida.
7. El agente principal actúa como responsable técnico y de producto: propone prioridades, detiene expansiones prematuras y señala gaps aunque Daniel no los haya preguntado explícitamente.

## Decisiones no negociables

1. El agente, su Supabase, hosting, dominio, claves y Zavu viven en la infraestructura del cliente.
2. El Studio local no participa del runtime. Si está apagado, el agente y la agenda deben seguir operando.
3. El vault local guarda de forma cifrada la credencial autorizada de cada Supabase cliente para mantenimiento desde el IDE. SQLite sólo conserva alias/metadatos.
4. API/REST sirve al runtime y dashboard del cliente. MCP queda para mantenimiento interno desde el IDE, no para el bot en producción.
5. Zavu es el canal WhatsApp actual. La arquitectura permite adaptadores posteriores, pero no se implementa Meta directo ahora.
6. La disponibilidad, reservas y cambios son datos/operaciones deterministas; el LLM conversa y decide cuándo pedir una herramienta, nunca inventa ni altera directamente.
7. No se hace una versión distinta del producto por cliente: hay un paquete estándar y configuración/versionado por cliente.

## Arquitectura acordada

```text
ZeroAgent Studio (PC local)
  └─ vault local autorizado
       └─ Supabase + hosting + Zavu del cliente
            ├─ agente WhatsApp
            ├─ dashboard operativo del cliente
            ├─ página pública /reservar
            ├─ conversaciones y feedback
            └─ outbox de alertas → Telegram/Zavu
```

Estados de entrega: `preview_local` → `staging` (cliente destruye el agente a pruebas) → `production` (Zavu conectado). Cambios de producción mediante versiones aprobadas y rollback posible.

## Estándar de comportamiento de Agenda

- Una pregunta nueva puede interrumpir un flujo previo; el contexto ayuda, no encierra al usuario.
- Consultar horarios no cambia una reserva.
- Sólo una selección explícita permite reagendar/cancelar.
- Disponibilidad siempre viene de la fuente viva; nunca desde el prompt o la memoria del modelo.
- La identidad para ver/modificar reservas viene del teléfono verificado por WhatsApp/Zavu. En web se exige verificación adicional.
- El agente sólo confirma una operación después de recibir éxito de una mutación atómica.
- Si anuncia un traspaso humano, crea el evento de traspaso en el mismo turno.
- Falta de información que impide resolver una situación real: no inventar, escalar.

## Componentes y archivos relevantes

| Componente | Estado | Referencia |
|---|---|---|
| Studio local (Express + SQLite) | existente, en evolución | `server.js`, `app.js`, `index.html` |
| Vault local de Supabase | existente | `vault.js` |
| Configurador Agenda v1 en Studio | implementado | vista `#agenda`, tabla `agenda_configs` |
| Contrato Agenda | implementado | `zeroagent-standard/agenda-v1.yaml` |
| Flujos y regresiones Agenda | implementado | `zeroagent-standard/agenda-v1-flows.yaml` |
| Runtime empaquetable | existente, ampliándose | `runtime-template/` |
| Esquema Supabase por cliente | implementado, pendiente ejecutar en staging | `runtime-template/supabase/agenda-v1.sql` |
| Seeder de catálogo | implementado, pendiente prueba contra Supabase staging | `npm run setup:agenda` |
| Manifest de instalación | implementado | `runtime-template/INSTALLATION_MANIFEST.md` + `INSTALLATION.json` generado por build |
| Consola cliente `/agenda` | implementada: Agenda, conversaciones y feedback | `runtime-template/public/agenda.html` |
| Capa operativa del dueño | implementada en preview y runtime | responsables, prioridad, toma/devolución y pausa global |
| UX consola cliente | rediseñada y verificada en Chrome | `public/agenda.html`, `public/client-console.css`, `public/client-console-layout.css`, `public/client-console-v2.js` |
| Contrato completo de consola cliente | documentado | `CLIENT_CONSOLE_PRODUCT_SPEC.md` |
| Preview del dashboard cliente en Studio | implementado en el mismo puerto 8080 | `/preview/agenda-cliente?demo=1` |
| Reserva pública `/reservar` | primera versión implementada | `runtime-template/public/booking.html` |
| Loop de herramientas real del agente | implementado en runtime; pendiente prueba contra Supabase staging | `runtime-template/src/agenda-tools.js`, `src/engine.js` |
| Preflight por etapa | implementado | preview / staging / production en `server.js` |
| Verificación local del paquete | pasa | `npm run test:agenda-package` |
| Consola móvil nativa (nuevo estándar) | implementada y verificada en Vercel real: Hoy, Agenda, Clientes, Bandeja, Entrenar, Probar | `runtime-template/public/m/` |
| Entrypoint Vercel (función serverless, sin `.listen()`) | implementado | `runtime-template/api/index.js`, `runtime-template/vercel.json`, `handleRequest` exportado desde `src/server.js` |
| Bandeja de handoff sin Supabase-conversations completo | implementada (local-file + Supabase, tabla `za_handoff_tickets`) | `runtime-template/src/handoffs.js` |
| Sugerencias de conocimiento del cliente | implementada (local-file + Supabase, tabla `za_knowledge_suggestions`) | `runtime-template/src/knowledge.js` |
| CRM ligero de contactos (`frio`/`caliente`/`cliente`) | implementado y verificado en Vercel real | `agenda.js` (`listCustomers`, `getCustomerDetail`, `updateCustomerSegment`, `bumpCustomerSegment`), columna `za_customers.segment` en `agenda-v1-extras.sql` |
| Checklist de staging | implementada | `AGENDA_V1_STAGING_CHECKLIST.md` |
| Bandeja remota en Studio (handoffs + sugerencias de conocimiento) | implementada y verificada contra Supabase real de quiro-demo | `server.js` (`/api/clients/:id/remote-inbox`, `/api/clients/:id/remote-inbox/suggestions/:id/approve`), `studio-redesign.js` (Actividad), `app.js`+`index.html` (panel "Sugerencias del cliente" en Conocimiento) |

## Persistencia correcta

En producción la fuente de verdad es Supabase del cliente: ubicaciones, servicios, recursos, horarios, bloqueos, clientes, reservas, conversaciones, feedback, versiones y outbox. El runtime trae almacenamiento local sólo para preview/VPS temporal y debe advertir que no es válido como persistencia Vercel.

La instalación ejecuta primero la migración y luego `npm run setup:agenda`; este segundo paso carga el catálogo aprobado del paquete de manera idempotente. Los horarios de profesionales se configuran explícitamente y jamás se deducen desde una descripción en texto.

## Validación realizada

- `node --check` pasó para Studio y módulos del runtime Agenda.
- `npm run test:agenda-package` pasó: crea una instalación efímera, comprueba migración/paneles/outbox/contrato y ejecuta la batería contractual del runtime.
- Aún pendiente: ejecutar `agenda-v1.sql`, `npm run setup:agenda` y las mutaciones contra un Supabase staging real. Sin ese proyecto y sus credenciales no se puede afirmar validación de integración.
- Se creó el cliente ficticio `Casa Aura · Demo`: Agenda habilitada, dos servicios, dos profesionales, una regla de no inventar disponibilidad, prueba de regresión, versión `1.0.0` aprobada y runtime de preview construido en `storage/agent-builds/casa-aura-demo/`.
- La consola del cliente mantiene el límite de permisos: ve conversaciones WhatsApp, aprueba/corrige respuestas y usa el playground; no modifica prompts, herramientas ni versiones. En Supabase, los feedback negativos quedan ligados a conversación/mensaje y el trigger crea el evento outbox para mantenimiento.
- El dueño controla dos escalas de seguridad: `Tomar conversación` pausa IA sólo para ese hilo y `Devolver a IA` la reactiva; `Pausar agente` detiene todas las respuestas automáticas del canal sin apagar el runtime. En un handoff, Zavu persiste mensajes entrantes pero el bot no responde. Los humanos contestan inicialmente desde Zavu; el composer humano propio queda fuera del P0 para no duplicar un contact center completo.
- Referencia Cxpress: se adoptó la noción de operación con dueño, cola y métricas; no se replica un SaaS omnicanal. La consola empaquetada fue rediseñada para que IA sea infraestructura, no decoración: Inicio, Conversaciones, Agenda y Calidad tienen superficies separadas y jerarquía operativa.
- Corrección 2026-07-17: se eliminó la implementación fragmentada de la consola. Conversaciones abre el historial sin estado vacío superpuesto; Agenda filtra por profesional y abre una ficha con teléfono, correo, notas y `wa.me`; `Servicios y equipo` muestra los datos operativos que alimentan al agente; Playground pasó a ser una vista interna del mismo dashboard. Los clics fueron reproducidos y verificados directamente en Chrome sobre el puerto 8080.

## Estado de Agenda v1 en código

La arquitectura principal existe, pero no se considera cerrada ni instalable hasta completar una integración real en Supabase staging. Configuración Studio, paquete, migración/seeder, web pública, dashboard cliente, herramientas LLM, webhook Zavu, conversación/handoff, feedback/outbox y preflight están implementados. La auditoría del 19-07-2026 demostró que varios de esos componentes existían sin que su frontera productiva estuviera realmente conectada o validada; desde ahora queda prohibido describir “archivo presente” o “preview funcional” como cierre productivo.

## Hito actual y siguiente trabajo

Se construyó la base standalone y dos superficies web conectadas a la misma API. El loop del agente ya incluye estas herramientas:

1. `get_availability`
2. `get_my_appointment` con identidad de canal verificada
3. `create_appointment`
4. `cancel_appointment`
5. `reschedule_appointment`
6. `request_human_handoff` → outbox/alerta

El esquema incorpora las RPC atómicas de solicitud, disponibilidad y reagendamiento. El runtime las expone al LLM mediante tool-calling y exige Supabase + identidad verificada para operar. Falta una prueba de integración contra un Supabase staging antes de describir el agente como operativo de Agenda.

Después de la remediación interna: primer staging real contra el Supabase de un cliente de prueba. CRM, landing y nuevas verticales permanecen congelados hasta ese hito.

## Remediación de auditoría · 19-07-2026

- El runtime ahora distingue `preview_local`, `staging` y `production`; staging/producción fallan cerrados si faltan claves de acceso, onboarding, proveedor LLM, Supabase o Zavu.
- El webhook genérico sólo existe en preview local explícito y exige bearer secret. Zavu continúa como canal productivo firmado.
- Las RPC de Agenda revocan ejecución a `public`, `anon` y `authenticated`; el runtime usa exclusivamente service role desde servidor.
- Crear, confirmar, cancelar, reagendar y pedir handoff pasan por RPCs con locking, máquina de estados e identidad verificada. Aviso mínimo y anticipación máxima se validan también dentro de Postgres.
- La reserva pública dejó de insertar catálogo con `innerHTML`; la consola instalada no sustituye fallos reales con datos Casa Aura.
- El build exige destino explícito (`preview`, `staging` o `production`), ejecuta el preflight de ese destino y lo registra en `BUILD.json`/`INSTALLATION.json`.
- El Playground del Studio dejó de tener un prompt y simulador propios: ejecuta el mismo `runtime-template/src/engine.js` sobre una versión empaquetada. Si falla, no inventa una respuesta local alternativa.
- El motor bloquea afirmaciones de reserva creada, cancelada, reagendada o handoff realizado si no existe éxito de la herramienta correspondiente.
- La prueba efímera ahora ejecuta casos adversariales: firma alterada/vencida, arranque productivo sin secretos, doble reserva, aviso mínimo, anticipación máxima, transición inválida, permisos RPC, XSS y confirmación sin tool.
- Los YAML quedan clasificados como contrato declarativo no ejecutable en v1; no se promete un mini-n8n ni un motor multi-vertical inexistente.
- El Studio sólo escucha en `127.0.0.1`, restringe CORS, valida IDs y dejó de publicar el árbol completo del proyecto/`storage` como archivos estáticos.
- La prueba de infraestructura exige autoridad de service role y presencia real del esquema Agenda, no sólo una respuesta HTTP distinta de 401.
- Pendiente bloqueante externo: no hay credenciales guardadas en el vault para un Supabase staging. Falta ejecutar la migración y las mutaciones reales contra ese proyecto antes de instalar a un cliente.

## Línea futura: ZeroAgent Voz / versión premium

ZeroAgent podrá ofrecer una versión premium con atención telefónica en vivo. No será un agente distinto: reutilizará el mismo conocimiento, reglas, herramientas, agenda, CRM, feedback y Supabase del agente de WhatsApp, agregando un adaptador de telefonía/SIP y conversación por voz en tiempo real.

Propuesta comercial:

- teléfono que siempre contesta, con voz natural y transferencia a humano;
- número existente mediante desvío, portabilidad o proveedor compatible;
- capacidad de reservar, vender, tomar pedidos o responder consultas durante la llamada;
- confirmaciones y seguimiento posterior por WhatsApp;
- llamadas, transcripciones, resultados y feedback visibles en el dashboard del dueño;
- cuentas de telefonía, modelo y servidor pertenecen al cliente; ZeroAgent instala, configura y monitorea;
- instalación y mantenimiento premium, con consumo de llamadas cobrado separadamente.

Orden correcto: cerrar primero Agenda + WhatsApp y su empaquetamiento. Luego construir Voz como otro canal instalable sobre el mismo runtime. Referente comercial observado: Jesy.ai valida la venta vertical de una recepcionista telefónica orientada a resultados, no la venta genérica de “IA”.

## Onboarding guiado del dueño

Decisión aprobada: cada proyecto podrá generar una preview inicial en Vercel con una ruta privada de onboarding perteneciente al paquete del cliente, no al Studio ni a un SaaS central de ZeroAgent.

Flujo previsto:

1. ZeroAgent crea el proyecto y despliega una preview inicial.
2. El dueño recibe un enlace privado como `/onboarding`.
3. Responde una entrevista condicionada por el producto contratado: Agenda, Ventas, Pedidos, Soporte u otro.
4. Puede adjuntar PDF, Word, Excel, CSV, TXT, Markdown e imágenes relevantes.
5. Respuestas y archivos se guardan en el Supabase del propio cliente.
6. ZeroAgent accede mediante el vault local, analiza el material desde el IDE y detecta contradicciones, información faltante y riesgos de invención.
7. Se genera una segunda ronda de preguntas específicas para cerrar huecos.
8. El dueño aprueba un resumen de conocimiento y reglas antes de construir la versión candidata del agente.

La entrevista no será una lista genérica de diez preguntas. Cada solución tendrá su propia pauta: Agenda cubre duración, profesionales, capacidad, descansos y cancelaciones; Ventas cubre precios, objeciones, descuentos, pagos y despacho; otros productos agregan sus excepciones operativas. Se implementará después de cerrar la operación base de Agenda + WhatsApp.

## Referencia Rishtedar

- No editar Rishtedar desde este proyecto.
- La carpeta `C:\proyectos\rishtedar` está actualmente en `staging`; no usarla como referencia.
- Para leer producción, consultar exclusivamente `master` mediante Git sin hacer checkout ni tocar la carpeta: por ejemplo `git -C C:\proyectos\rishtedar show master:ruta/al/archivo`.

## Cómo actualizar esta bitácora

Al cerrar una decisión o hito, actualizar: decisión, estado real, archivos afectados, validación realizada y siguiente paso. Nunca afirmar que algo está productivo si sólo fue probado como preview o no se ejecutó su migración Supabase.

## Rediseño de producto implementado · 18-07-2026

- Studio se reorganizó como fábrica: Portafolio, Actividad, Resumen, Diagnóstico, Conocimiento, Solución, Agenda, Calidad, Monitoreo y Configuración local.
- La entrevista guiada tiene 13 pasos, enlace privado renovable, autosave, archivos, reanudación y estado visible desde Diagnóstico.
- La maqueta local persiste entrevistas en SQLite; el paquete instalable usa tablas y Storage del Supabase propio del cliente.
- La consola del cliente usa su marca como protagonista y navegación modular: Hoy, Conversaciones, Agenda, Calidad y Negocio.
- Conversaciones permite tomar un caso, silenciar al agente por contacto y responder desde la aplicación usando Zavu. Cada envío humano usa una clave idempotente y estado `sending/sent/failed`.
- Agenda se separó en Calendario, Reservas, Servicios, Equipo y Disponibilidad; las fichas muestran contacto, origen, profesional, sede, notas y acciones de estado.
- Playground quedó dentro de Calidad junto a aprobaciones y correcciones; una corrección nunca altera producción automáticamente.
- El diseño comparte sistema visual, pero Studio es oscuro y técnico-editorial mientras la consola del cliente es clara, cálida y personalizable.
- Responsive operativo validado sin overflow horizontal en la consola y onboarding móvil. Se exige una sola zona principal de scroll y `[hidden]` autoritativo para evitar paneles superpuestos.

## Demo comercial de Agenda · 18-07-2026

- La vertical comercial inicial queda acotada a consultas frecuentes + agendamiento por WhatsApp.
- `/demo` es una landing editorial vendedora con propuesta de valor, funcionamiento, límites del agente, preguntas frecuentes, acceso directo al producto y captura local de interesados.
- `/demo/panel` reutiliza la consola real del cliente; no existe una segunda maqueta. Fuerza datos ficticios, no usa credenciales ni infraestructura externa y descarta los cambios al recargar.
- El modo comercial incorpora una guía de cuatro pasos: Resumen, Conversaciones, Agenda y Calidad. El modo `embed=1` permite mostrar el mismo producto dentro de la landing sin controles comerciales superpuestos.
- La landing utiliza una imagen comercial original y una visualización viva del dashboard. La identidad elegida evita neón, glassmorphism y tarjetas genéricas: composición editorial, fondo cálido y verde sobrio.
- Los interesados se guardan en SQLite en `commercial_leads`. Antes de publicar debe definirse el dominio, destino de alertas comerciales y protección anti-spam/rate limiting.
- Estado real: implementado y probado localmente en el puerto 8080. Todavía no está publicado ni conectado a un dominio.
- Corrección posterior: la visualización embebida ahora escala ancho y alto en la misma proporción, sin lienzo blanco sobrante en escritorio ni móvil. El acceso `?tour=1` inicia un recorrido visual real con oscurecimiento, foco y explicación secuencial sobre Resumen, Conversaciones, Agenda y Calidad; al terminar deja el panel libre para explorar y puede reiniciarse desde la barra comercial.
- Calendario operativo: Semana y Día son vistas funcionales. Semana apila o distribuye reservas simultáneas dentro de la misma hora; Día muestra columnas separadas por profesional cuando está seleccionado “Todo el equipo”. Las pestañas de recursos indican cuántas reservas tienen en el período visible y las flechas avanzan una semana o un día según el modo. El escenario comercial incluye tres profesionales reservados simultáneamente para validar el caso de alta concurrencia.
- La landing comercial ahora explica explícitamente que el agente se construye con historia, información, documentos, reglas, límites y ejemplos reales del negocio. Presenta el flujo entrevista → análisis de brechas → segunda ronda/aprobación y enlaza a `/demo/onboarding`, que reutiliza la entrevista real de 13 pasos en modo descartable, sin token ni persistencia del cliente.

## Estándar de demo por cliente · 30-07-2026

A partir de este hito, **todo demo nuevo que se genere para un prospecto sigue este patrón por
defecto** — no es específico de un cliente puntual, es el nuevo estándar de `runtime-template/`.
Reemplaza el patrón anterior (consola de escritorio única, Docker/VPS como destino).

**Qué cambia respecto a lo anterior:**
- La consola móvil nativa (`public/m/`) deja de ser algo puntual: Hoy, Agenda, **Clientes**
  (CRM ligero), Bandeja (handoff), Entrenar (conocimiento) y Probar. Se construye pensada para
  el celular desde el día uno, no como adaptación de la de escritorio.
- El destino de despliegue por defecto es **Vercel + Supabase propio del cliente**, no
  Docker/VPS. El `Dockerfile`/`README.md` de `runtime-template/` quedaron obsoletos como
  camino principal — no se mantienen activamente salvo pedido explícito.
- Cada cliente tiene su **propio proyecto Supabase** (cuenta separada, nunca mezclado con otro
  cliente) y su **propio proyecto Vercel** (misma cuenta de Daniel, un proyecto por cliente).

**CRM de contactos (`za_customers` + columna `segment`):** ya forma parte del esquema estándar
(`agenda-v1-extras.sql`). Todo cliente nuevo lo hereda automático. `segment` es
`frio` | `caliente` | `cliente`: nace en `frio`, sube solo a `caliente` al crear una reserva y a
`cliente` al confirmarla/completarla — nunca baja solo, el dueño lo puede cambiar a mano siempre
desde la pestaña Clientes. El "resumen por IA" del historial de un contacto queda como
placeholder visual hasta que haya un canal WhatsApp real conectado (ahí sí hay conversación real
que resumir); mientras tanto la nota de cada visita (`za_appointments.notes`) es editable a mano.

**Procedimiento para desplegar un cliente nuevo (Supabase + Vercel):**

1. Construir el cliente en el Studio como siempre (agente, agenda, conocimiento, versión aprobada, `build-runtime` con `target` apropiado).
2. Crear un proyecto Supabase **dedicado a ese cliente** (cuenta/org separada si el cliente lo amerita — preguntar a Daniel, no asumir). Se puede automatizar vía Management API (`https://api.supabase.com/v1/projects`) con un token de acceso personal del cliente.
3. Aplicar `runtime-template/supabase/agenda-v1.sql` y `agenda-v1-extras.sql` contra ese proyecto (endpoint `/v1/projects/{ref}/database/query` de la Management API, o el MCP de Supabase si está conectado a la cuenta correcta).
4. Sembrar catálogo con `seedAgendaCatalog(packageData)` (ya existe en `agenda.js`) apuntando `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` al proyecto del cliente.
5. Desplegar el build a Vercel (cuenta de Daniel, un proyecto nuevo por cliente) vía API REST directa (`POST /v13/deployments`) con el token personal de Vercel de Daniel — **no** el conector MCP de Vercel pre-conectado en este entorno, que pertenece a la cuenta de otro cliente (Rishtedar) y no tiene permiso para crear proyectos en la cuenta propia de Daniel.
6. **Gotcha crítico de Vercel, ya resuelto en el código pero hay que saberlo:** Vercel detecta un "servidor Node" por **análisis de texto** — busca literalmente `.listen(` en cualquier archivo del árbol subido, sin importar si está condicionado a no ejecutarse. Por eso `runtime-template/src/server.js` **nunca** debe tener esa llamada (exporta sólo `handleRequest`, invocado por `api/index.js` como función serverless — ver `vercel.json` con `rewrites`+`functions.includeFiles`). Si un proyecto Vercel ya existente quedó con `framework` fijado en `"node"` por un deploy anterior, pasar `framework: null` en un deploy nuevo **no alcanza**: hay que forzarlo con `PATCH /v9/projects/{id}` `{"framework": null}` antes de redesplegar.
7. Desactivar la protección SSO del proyecto (`PATCH /v9/projects/{id}` `{"ssoProtection": null}`) — Vercel la activa por defecto y el cliente no podría abrir el link sin loguearse en la cuenta de Daniel.
8. Configurar las variables de entorno del proyecto Vercel vía API (`POST /v10/projects/{id}/env`): `RUNTIME_MODE=preview_local` (evita exigir credenciales Zavu/onboarding que este modo de demo no usa — Supabase sí queda conectado igual, es independiente de `RUNTIME_MODE`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, y la key del proveedor LLM (`OPENAI_API_KEY` o `GROQ_API_KEY`, confirmar con Daniel cuál usar — no asumir que se puede reutilizar la de otro cliente sin preguntar). Redesplegar después de fijar las variables — un deploy ya construido no las recoge retroactivamente.
9. Verificar en el navegador real (no sólo `curl`): landing en `/`, consola en `/m` con sus 6 pestañas, un mensaje de chat real contra el LLM, y que Agenda/Clientes reflejen datos de Supabase (`mode: "customer_supabase"` en `/api/agenda/dashboard`, no `"local_preview_state"`).

**Dónde queda cada credencial:** nunca en este archivo ni en memoria de IA en texto plano.
Quedan en archivos `.env.*` locales por cliente (cubiertos por `.gitignore`), y un puntero (sin
el valor) en la memoria de sesión de Claude Code para ese proyecto.

## Studio como panel único de operación · 30-07-2026

Daniel dejó explícito que Studio se queda **local a propósito** (usa su suscripción Claude en
vez de pagar cómputo/IA aparte en la nube) — no se busca hacerlo accesible desde cualquier
lugar. Lo que sí se necesitaba es que Studio esté realmente **conectado al mundo**: que las
secciones que dependen de infraestructura de cada cliente (monitoreo, entrenamiento, sugerencias
de conocimiento) funcionen de verdad y no sólo dentro de la consola de cada cliente por separado.

Auditoría de conectividad real (no sólo "el archivo existe"):

- **Sí estaba conectado:** Prospección (Serper real), Playground/Calidad (motor + LLM real),
  entrevista guiada para clientes en staging/producción (Supabase propio del cliente),
  verificación manual de infraestructura por cliente.
- **Hueco confirmado:** "Actividad" (el feed de portafolio) sólo leía SQLite local — ni siquiera
  el feedback negativo real de producción, sólo el de las pruebas del propio Playground. Las dos
  tablas nuevas del CRM/handoff (`za_handoff_tickets`, `za_knowledge_suggestions`, agregadas el
  30-07 en el estándar de demo por cliente) no las leía Studio en ningún lado: para verlas había
  que entrar a la consola `/agenda`/`/m` de cada cliente por separado, lo que rompe la idea de
  Studio como panel único.
- **Hallazgo adicional:** `client_infrastructure` (el vault de Studio) estaba vacío para
  **todos** los clientes, incluido quiro-demo ya desplegado en producción — sus credenciales
  reales sólo vivían en `runtime-template/.env.quiro-demo`, usadas directo por los scripts de
  deploy, nunca cargadas al vault de Studio. Es decir, ni siquiera el mecanismo de
  mantenimiento remoto que ya existía (`/agenda-feedback`) se podía usar contra un cliente real
  hasta ahora.

Fix implementado:

- Nuevo endpoint `GET /api/clients/:id/remote-inbox`: mismo patrón de vault que
  `/agenda-feedback` (nunca expone la credencial al navegador ni al runtime), trae handoffs
  abiertos y sugerencias de conocimiento pendientes del Supabase real del cliente.
- `POST /api/clients/:id/remote-inbox/suggestions/:suggestionId/approve`: convierte una
  sugerencia remota en un `knowledge_item` local aprobado (entra a la próxima versión, no toca
  el agente en caliente) y marca la sugerencia como `approved` en el Supabase del cliente.
- "Actividad" ahora agrega, para cada cliente con vault configurado, sus casos derivados y
  sugerencias pendientes al feed y al resumen del portafolio.
- La vista Conocimiento muestra un panel "Sugerencias del cliente" con botón Aprobar por ítem.
- Se configuró el vault de Studio para quiro-demo (antes vacío) y se verificó el ciclo completo
  contra su Supabase real: insertar handoff/sugerencia → aparecer en Actividad → aprobar
  sugerencia desde Conocimiento → dato confirmado local → sugerencia marcada `approved` en
  Supabase. Datos de prueba limpiados después de verificar.
- Pendiente/backlog, no bloqueante: hacer lo mismo (vault configurado en Studio) para el resto
  de clientes que lleguen a producción, y decidir si el handoff se puede "marcar resuelto"
  también desde Studio o si eso se queda operativo en la consola del cliente (hoy sólo se lee,
  no se resuelve, desde Studio).

**Separación de roles en el entrenamiento (aclarada por Daniel el mismo día):** existen dos
flujos distintos y no deben mezclarse.

1. **Sugerencias del cliente** (`za_knowledge_suggestions`) — el dueño escribe un dato directo
   ("esto es así"). Vive en Conocimiento, se aprueba tal cual con un clic, no requiere tocar el
   prompt.
2. **Correcciones de casos reales** (`za_feedback_items`, rating negativo de una conversación de
   producción) — el dueño no propone un dato, señala que una respuesta real salió mal. Esta
   revisión es de Daniel + Claude: se ve la pregunta real, la respuesta real y la corrección, se
   decide si el fix es de prompt (Solución) o de un dato/prueba faltante (Conocimiento), se ajusta
   a mano, y recién ahí se marca el caso como "en revisión" o "resuelto". Vive en Calidad
   (`GET /api/clients/:id/remote-inbox` ahora también trae `corrections`;
   `PATCH /api/clients/:id/remote-inbox/corrections/:id/status` para marcar el estado). No hay
   ninguna acción automática que cree o modifique el agente a partir de una corrección — el ajuste
   siempre es manual.

Verificado end-to-end contra el Supabase real de quiro-demo: caso insertado con pregunta/
respuesta/corrección → aparece en el panel de Calidad → "Ya lo arreglamos" → `status: resolved` +
`resolved_at` en Supabase, caso desaparece del panel. Dato de prueba limpiado después.

**Decisión sobre el aviso (30-07-2026, tras cuestionar el mecanismo original):** se descarta
Telegram/Sentinel + Vercel Cron + trigger de outbox como vía principal de aviso. Motivo: Vercel
limita los cron jobs **por cuenta/equipo**, no por proyecto (2 en Hobby, 40 en Pro, 100 en
Enterprise) — como todos los proyectos Vercel de los clientes viven bajo la cuenta de Daniel, ese
tope se acumula entre todos los clientes, no por cliente; se rompe con pocos clientes en Hobby.
En su lugar: un botón `wa.me` (mensaje persona-a-persona común, sin API de Meta, sin aprobación de
plantilla, sin costo de conversación) en la consola del cliente (`public/m/m.js`), que el dueño
puede tocar tras enviar una corrección (tab "Probar") o sugerencia (tab "Entrenar") para avisarle
a Daniel directo por WhatsApp con el nombre real del negocio (`state.dashboard.business_name`, no
el nombre del agente). Número configurado: +56972739105. Implementado, desplegado y verificado
en vivo contra quiro-demo — ambos links generan el texto y número correctos
(`https://wa.me/56972739105?text=...`), botón visible tras enviar sugerencia real, dato de prueba
limpiado después.

**Capa de respaldo (por si el dueño no manda el wa.me):** botón manual "Barrer clientes ahora" en
Actividad (`index.html`, `studio-redesign.js`) que re-ejecuta el mismo barrido de
`remote-inbox` para todos los clientes con vault configurado, ahora **en paralelo** (no uno por
uno) para que no se vuelva lento al crecer la cartera, con timestamp de última actualización
visible. Implementado y verificado en Studio local. Explícitamente fuera de alcance por ahora: una
"comparativa de configuración" (deriva entre lo que Studio cree que desplegó y lo que realmente
corre en el Supabase del cliente) — es una feature distinta y más grande, queda en backlog hasta
que haya evidencia real de que la deriva es un problema.

## Prospección y CRM local · 18-07-2026

- BizScout se toma como precedente y cantera de ideas, no como aplicación que deba integrarse completa. Su búsqueda geográfica, calificación y seguimiento evolucionan dentro de ZeroAgent Studio bajo la sección `Prospección`.
- Prospección es exclusivamente una herramienta interna local. No forma parte del paquete del cliente y el runtime continúa independiente.
- El modelo admite varias verticales mediante contratos configurables: Agenda, Captación de leads, Ventas conversacionales, Atención/consultas y búsqueda personalizada. Agenda es la prioridad comercial inicial, no una restricción estructural.
- La fuente de verdad es SQLite: `prospecting_searches`, `prospects` y `prospect_activities`. La deduplicación usa dominio, teléfono normalizado y nombre + ubicación.
- La clasificación inicial es determinista y explicable. Conserva señales visibles —encaje de rubro, contacto disponible, actividad, reputación, presencia web y agenda detectada— antes de considerar una futura capa LLM.
- El CRM combina una vista Foco con ficha 360° y una vista Pipeline. La ficha reúne evidencia, WhatsApp, sitio, mensaje sugerido, notas, próximo seguimiento, estado e historia; el pipeline permite mover oportunidades entre etapas.
- Un prospecto calificado se convierte en proyecto ZeroAgent mediante una acción explícita. Recién entonces aparece en Portafolio y comienza entrevista, diagnóstico y construcción del agente.
- La búsqueda real utiliza Serper únicamente desde el servidor local y queda disponible al definir `SERPER_API_KEY`. Sin clave existe un escenario coherente de cinco negocios para recorrer el flujo sin fingir una búsqueda externa.
- Referencias UX estudiadas: Attio para registros, relaciones y vistas flexibles; Close para bandeja de acción y cronología de contacto; HubSpot para lectura de salud del pipeline. No se replica su complejidad SaaS.
- Validación: mismo servidor 8080 reiniciado, API local persistente, carga del escenario, apertura de ficha, cambio de etapa, notas, historial, alternancia Foco/Pipeline y responsive a 390 px sin overflow horizontal. La inspección del navegador no mostró errores de consola.

## Nichos y diversificación de verticales · 31-07-2026

- **Investigación de nichos** (Meta prohíbe bots de propósito general en WhatsApp Business API
  desde enero 2026, exige acotarse a un caso de uso declarado — valida tener bases por nicho, no
  es solo prolijidad): 6 nichos semi-curados agregados a Studio en una nueva vista "Nichos"
  (`index.html`/`app.js`, array `NICHES`). Cruzados contra las verticales de Prospección ya
  existentes (`agenda`, `leads`, `sales`, `support`). Estado real, no aspiracional: Agenda v1 es
  la única base construida hoy; el resto está diseñada (Pedidos) o pendiente de diseño.
- **Pedidos v1 (diseño acordado, no construido todavía):** núcleo genérico — catálogo de ítems
  (categoría/precio/variantes/disponibilidad), el agente arma un carrito por conversación,
  confirma el pedido, estado pendiente→preparación→listo→entregado/cancelado. La derivación al
  dueño reutiliza el mecanismo de handoff que ya existe (reclamo, ítem inexistente, problema de
  pago) — cero código nuevo ahí. El punto de entrega de un pedido confirmado queda como un único
  punto de enganche configurable por cliente: por defecto, una bandeja visual en la propia
  consola (mismo patrón que conversaciones/handoffs, funciona sin integrar nada); adaptadores a
  sistemas ya instalados (Toteat u otros) se construyen caso a caso cuando aparezca ese cliente
  específico, no de forma especulativa ahora.
- **Reorganización del nav — decisión tomada, implementación diferida a propósito:** al revisar
  el sidebar de Studio se confirmó el riesgo real que Daniel señaló: "Agenda" vive como ítem de
  nav dedicado bajo "Cliente activo". Si Pedidos se construye igual (un ítem más), y luego una
  tercera/cuarta vertical, el sidebar acumula un ítem por vertical sin importar si el cliente
  activo la usa o no. La decisión, para cuando Pedidos exista de verdad: consolidar Agenda +
  Pedidos (+ futuras verticales) bajo un solo ítem de nav ("Soluciones" o similar) con sub-tabs
  internas — mismo patrón de subnav que ya funciona en Calidad de la consola del cliente
  (Probar/Conversaciones/Correcciones/Conocimiento). No se implementa ahora porque construir esa
  estructura de tabs para una sola vertical real (Agenda) sería andamiaje especulativo — se hace
  cuando exista el segundo dato real (Pedidos) para diseñar contra algo concreto, no una forma
  hipotética.

## Auditoría end-to-end · 31-07-2026

A pedido explícito de Daniel ("¿revisamos end to end? flujo mío, flujo cliente, creación de
nuevos clientes..."). Hallazgos con evidencia, no supuestos:

- **Build-runtime confirmado sano:** `buildClientRuntime` en `server.js` hace
  `fs.cp(runtimeTemplateRoot, outputDir, {recursive:true})` — copia completa de
  `runtime-template/` en cada build nuevo, sin lista blanca de archivos. Cualquier cliente nuevo
  hereda automáticamente ambas consolas (`/m` móvil y `/agenda` escritorio) y todo lo construido
  este día (CRM, handoffs, sugerencias, correcciones, wa.me) sin trabajo extra.
- **Gap encontrado y corregido:** `client_infrastructure.connection_status` de quiro-demo quedó
  en `saved_unverified` (se guardó el vault vía PUT directo para probar, nunca se llamó al
  endpoint real de verificación). Eso habría bloqueado el preflight de un build staging/production
  oficial. Se ejecutó `POST /api/clients/quiro-demo/infrastructure/test` — ahora `connected` con
  `last_checked_at` fresco.
- **Gap encontrado, no bloqueante, pendiente de decisión:** el historial de versiones de Studio
  para quiro-demo llega hasta v1.3.0 (30-07 05:32 UTC); todo lo construido después (CRM,
  correcciones, wa.me) se desplegó vía el script directo de `scratchpad/deploy-vercel.mjs` contra
  un snapshot de build viejo, sin pasar por `build-runtime`/aprobación de versión. El código fuente
  (`runtime-template/`) está correcto y al día — un build oficial futuro lo recogería bien — pero
  el registro de versiones de Studio no refleja fielmente qué hay en producción ahora mismo.
  Recomendado: crear una versión nueva (ej. 1.4.0) documentando estos cambios.
- **Gap real y recurrente, no exclusivo de quiro-demo:** crear un cliente nuevo (`POST
  /api/clients`) es sólo un INSERT de nombre/rubro/descripción — no configura Supabase, Vercel ni
  el vault. Eso ya causó que los 8 clientes existentes tuvieran `client_infrastructure` vacío
  hasta que se corrigió manualmente para quiro-demo en esta sesión. No hay checklist ni
  recordatorio dentro de la UI de Studio; vive solo como conocimiento escrito en este archivo
  (sección "Estándar de demo por cliente"). Seguir el procedimiento de 9 pasos al pie de la letra
  por cada cliente nuevo hasta que se decida construir un recordatorio real dentro de Studio.
- **Paridad móvil/escritorio del wa.me, corregida:** el botón "Avisar por WhatsApp" se había
  agregado sólo a `public/m/m.js` (Probar y Entrenar). Se replicó el mismo `supportWaLink()` en
  `public/client-console-v2.js` (consola de escritorio del cliente): en `submitPlaygroundFeedback`
  (corrección desde "Probar agente") y en el submit de `#knowledge-suggestion-form` (Calidad →
  Conocimiento). Ambos verificados en vivo generando el link correcto con el nombre real del
  negocio.
- **Backlog cerrado (31-07-2026), seguridad explícitamente excluida por ahora:** Daniel confirmó
  hacer el resto de lo pendiente salvo autenticación/seguridad (eso queda para cuando un cliente
  contrate de verdad o se arme otro cliente real — hoy es demo, accesible sin login a propósito).
  - **Checklist de despliegue visible:** `client_infrastructure` sumó columnas
    `vercel_project_url`, `migration_applied`, `catalog_seeded`, `env_vars_set`
    (`PUT /api/clients/:id/deployment-checklist`). Se agregó al card "Preparación del agente"
    (Resumen del proyecto) junto a los checks que ya existían — vault conectado, migración,
    catálogo sembrado, URL de Vercel, env vars — todo visible de un vistazo, ya no solo en la
    cabeza de quien recuerde el procedimiento de 9 pasos. Verificado con quiro-demo: los 4 nuevos
    quedaron en verde tras marcarlos.
  - **Comparativa de configuración (deriva):** `GET /api/clients/:id/config-drift` trae el
    catálogo real (`za_locations`, `za_services`, `za_resources`) del Supabase del cliente vía
    vault y lo compara en memoria contra `agenda_configs` local por nombre — reporta qué falta
    sembrar, qué existe solo en Supabase (agregado por fuera de Studio) y qué campos no calzan.
    Botón "Comparar con Supabase real" en la vista Agenda. Verificado con quiro-demo en ambos
    sentidos: catálogo real (sin diferencias) y con un servicio de prueba agregado solo en local
    (detectó correctamente "falta sembrar en Supabase → Servicio Fantasma"; revertido después).
- **Confirmado, no es un bug:** el panel "Conocimiento" ya existente en la consola de escritorio
  del cliente (`agenda.html`, Calidad → Conocimiento, formulario "Sugerir un dato nuevo") y el
  nuevo panel "Sugerencias del cliente" agregado a Studio esta sesión NO son duplicados — son
  complementarios: el primero es donde el dueño escribe la sugerencia (en su propio Supabase), el
  segundo es donde Daniel la revisa/aprueba desde Studio (leyendo la misma tabla
  `za_knowledge_suggestions` vía vault). Mismo patrón para correcciones: la consola del cliente y
  el panel nuevo de Studio leen/escriben la misma tabla `za_feedback_items` con el mismo
  vocabulario de estado (`new`/`reviewing`/`resolved`/`dismissed`) — si el dueño resuelve algo
  desde su propia consola, desaparece también de la vista de Studio, sin conflicto.

## Actividad clickeable + Datos/Info de inyección directa · 31-07-2026

- **Contexto real que originó esto:** Francisco Martinez (el kinesiólogo/osteópata/quiropráctico
  de un box en Buín donde Daniel fue paciente — de ahí nació la idea del demo) probó quiro-demo y
  dejó 3 correcciones reales vía el Playground/consola. Studio las mostraba agregadas ("3") en el
  resumen de Actividad sin decir cuáles eran ni dónde atenderlas, y la fuente tipográfica de todo
  `studio-redesign.css` (el rediseño posterior) quedó en píxeles fijos de 8-12px — genuinamente
  chica para uso diario, no solo percepción.
- **Fuente global corregida:** `studio-redesign.css` tenía casi todo el texto de trabajo (menú,
  filas de actividad, labels, botones, selects) en 8-12px fijos. Subido ~2px parejo en todo el
  archivo (verificado con `getComputedStyle` en vivo: menú 13.5px, texto de actividad 12.5px,
  headers de card 17px).
- **Actividad ahora es accionable, no solo informativa:** cada fila del feed y cada número del
  "Resumen del portafolio" (`studio-redesign.js`, `jumpToActivityItem`) es clickeable — selecciona
  el cliente correcto y salta a la vista donde se resuelve de verdad (correcciones/casos
  derivados → Calidad, sugerencias → Conocimiento, fuentes pendientes → Diagnóstico,
  onboarding/versiones → Resumen del proyecto). Verificado en vivo: clic en una corrección real
  saltó a Calidad con quiro-demo cargado y el panel de correcciones visible.
- **Confirmado explícitamente (pregunta directa de Daniel), y así se documenta para no repetir la
  explicación:** lo que un cliente escribe como corrección NUNCA se inyecta solo al prompt. Queda
  como texto crudo en `za_feedback_items` hasta que Daniel+Claude editan a mano el prompt/
  `knowledge_items`/Agenda y construyen una versión nueva — el botón "Ya lo arreglamos" en Calidad
  solo cambia el `status` de la fila (ver comentario en `server.js` línea ~2346), no aplica nada
  automático. Sin Zavu ni agente en WhatsApp corriendo hoy — todo lo anterior ocurre dentro del
  Playground/demo de entrenamiento, cero clientes reales conectados.
- **Curación real aplicada a las 3 correcciones de Francisco, como demostración del circuito:**
  - 2 de comportamiento (tono/saludo) → editadas directo en el system prompt de quiro-demo
    (`agent_system_prompt` vía `PUT /api/clients/:id/agent`): identidad pasó de plural genérico
    ("con el Dr. Ignacio", nombre de agente "Asistente de Vitalis") a primera persona como
    Francisco Martinez, Kinesiólogo Osteópata y Quiropráctico; se agregó pregunta de diagnóstico
    médico previo y se sacó el relleno empático ("lamento que sientas...") a favor de tono
    directo. `knowledge_item` "criterio profesional" reescrito en consistencia (v3). Ambas
    correcciones marcadas `resolved` — verificado que desaparecen de `/remote-inbox` y bajan el
    conteo de Actividad de 3 a 1.
  - 1 de datos (precios reales de Francisco: Box Buin $36.000/45-60min, Eleva Salud
    $30.000/30min, domicilio +$6.000 — todos distintos de la ficha ficticia de Agenda
    Ñuñoa/Dr. Ignacio Prieto/$30.000-$22.000-$18.000 que sigue cargada) se dejó deliberadamente
    en `reviewing`, no `resolved` — es un dato de negocio, no de comportamiento, y su lugar
    correcto es el bucket "Datos" nuevo (ver abajo), no una reinterpretación mía como texto de
    prompt que además contradiría la Agenda ficticia todavía cargada.
- **Los dos "buckets" de inyección directa que pidió Daniel (comparando con el patrón ya usado en
  Rishtedar: datos estructurados vs. "conocimiento basura" no curado) — construidos:**
  - Ya existía sin que se hubiera notado como tal: `za_locations`/`za_services`/`za_resources`
    (Agenda) ya se consultan en vivo desde el Supabase real del cliente (`agenda.js`,
    `agendaSupabaseRequest`) — cero curación de Daniel+Claude en el camino. El hueco real no era
    conceptual, era que nadie podía escribir ahí salvo Daniel a mano/por script.
  - **Nuevo — DATOS** (`za_business_data`: label/value/category) e **INFO**
    (`za_business_info`: texto libre): tablas nuevas en
    `runtime-template/supabase/agenda-v1-direct-data.sql` (mismo patrón RLS que el resto,
    **pendiente que Daniel corra esta migración en el Supabase real de quiro-demo** — el conector
    Supabase MCP pre-conectado en este entorno es el proyecto de Rishtedar, no el de quiro-demo,
    así que no se pudo aplicar directo, por política de no mezclar infraestructura entre
    clientes).
  - `runtime-template/src/business-data.js`: helpers `listBusinessData`/`addBusinessData`/
    `listBusinessInfo`/`addBusinessInfo`/`liveInjectedFacts` — mismo patrón que `knowledge.js`
    (fallback a archivo local si no hay Supabase configurado).
  - `engine.js` (`answerWithGroq`): los hechos en vivo de Datos/Info se anteponen a las
    `confirmed_facts` horneadas del build — se ven en la próxima respuesta, sin rebuild ni
    aprobación.
  - Endpoints nuevos en `runtime-template/src/server.js`: `GET/POST /api/client/business-data` y
    `/api/client/business-info` (mismo gate `dashboardAuthorized` que el resto de la consola).
  - UI nueva en ambas consolas del cliente (`agenda.html`+`client-console-v2.js` escritorio,
    `m/index.html`+`m/m.js` móvil), dentro de Calidad → Conocimiento, debajo de "Sugerir un dato
    nuevo": dos formularios separados y claramente distinguidos ("se usan de inmediato" vs. la
    sugerencia de arriba que sí espera revisión).
  - Studio ve estos datos en modo solo-lectura/auditoría (`GET /api/clients/:id/remote-inbox`
    extendido con `businessData`/`businessInfo`, panel nuevo "Datos e Info cargados por el
    cliente" en Conocimiento) — sin botones de aprobar, porque no hay nada que aprobar.
  - **Migración aplicada y verificada en el Supabase real de quiro-demo (31-07-2026):** cada
    proyecto tiene su propio token de gestión guardado en su propio
    `runtime-template/.env.quiro-demo` (no en el conector Supabase MCP genérico del entorno, que
    queda atado a la cuenta/organización donde se generó — hoy Rishtedar). Se aplicó
    `agenda-v1-direct-data.sql` vía la Management API de Supabase (`POST
    /v1/projects/{ref}/database/query` con `SUPABASE_MANAGEMENT_TOKEN`), confirmando ambas
    tablas creadas. Se cargaron los 3 precios reales de Francisco (Box Buin, Eleva Salud,
    domicilio) como primeras filas de `za_business_data`, y se marcó la corrección de precios
    (la única que había quedado en `reviewing`) como `resolved` — Studio ya la muestra en el
    panel de auditoría "Datos e Info cargados por el cliente" y el conteo de Actividad bajó a 0.
  - **Pendiente solo para verlo en producción real (Vercel):** copiar los archivos tocados de
    `runtime-template/` al snapshot de build y redeployar, igual que los cambios anteriores de
    esta sesión — el runtime local/Studio ya está al día, falta el redeploy si se quiere probar
    en la URL pública.

## Bandeja con conversaciones reales + paridad móvil · 31-07-2026

- **Versionado real de v1.4.0 y v1.4.1:** después de curar las correcciones y hacer el fold de
  conocimiento, se creó versión (no solo se documentó) porque cambió prompt/knowledge real, a
  diferencia del criterio usado el 30-07 para cambios puramente de plataforma. Al armar v1.4.0 se
  encontró y eliminó un `test` viejo que decía explícitamente "ofrecer evaluación en plural, con
  el doctor" — quedaba contradictorio con la nueva identidad singular de Francisco Martinez; no
  hay endpoint para editar un test, así que el patrón es borrar+recrear, igual que con
  `knowledge_items`. Deploy real hecho vía Management API + REST directo a Vercel (mismo patrón de
  sesiones anteriores), reescribiendo `deploy-vercel.mjs` del scratchpad para apuntar a la carpeta
  de build real generada por Studio en vez de a un snapshot viejo parchado a mano — más correcto,
  ya no hace falta copiar archivos sueltos antes de cada deploy.
- **Aclarado con evidencia de código, no a partir de la duda de Daniel:** lo que un cliente escribe
  como corrección NUNCA se auto-inyecta al prompt (confirmado leyendo `server.js` línea ~2346 —
  el botón "Ya lo arreglamos" sólo cambia `status`, no toca prompt/knowledge/Agenda). El ajuste
  real siempre pasa por edición manual en Studio + nueva versión + build + deploy.
- **Bandeja/Inbox real (conversaciones + feedback + toma de control) ya estaba construido en
  escritorio, sólo faltaba en móvil:** `renderInbox()` en `client-console-v2.js` ya leía
  conversaciones reales (`za_conversations`/`za_conversation_messages`), permitía calificar cada
  mensaje del agente (👍/👎 → mismo `POST /api/client/feedback` que las correcciones), tomar un
  caso puntual (`data-action="take-conversation"`, independiente del pause global del agente) y
  responder como humano (`sendHuman` → Zavu). La consola móvil (`m/m.js`) sólo tenía la lista
  simple de tickets de handoff — sin hilo, sin calificar, sin tomar caso, sin responder. Se
  construyó la paridad completa: `conversationRowHtml`/`conversationMessageHtml`/
  `openConversation` (bottom sheet `#conversation-sheet`, mismo patrón que el resto de sheets de
  `/m`), calificar mensaje real, "Tomar conversación"/"Devolver a la IA", y formulario para
  responder (`POST /api/client/conversations/:id/messages`) — endpoints ya existían en
  `runtime-template/src/server.js`, sólo faltaba la UI.
- **Datos demo reales sembrados en el Supabase de quiro-demo** (no simulados en el frontend, filas
  reales vía Management API): operador "Francisco Martinez" (`za_operators`), una conversación
  activa con Camila Sanhueza (IA respondiendo con el tono/preguntas del prompt v3/v4) y una
  conversación en handoff urgente con Felipe Rojas (caída + hormigueo, coincide con la lógica de
  detección de urgencia del prompt) — así Bandeja se ve reflejada con contenido creíble en vez de
  vacía, tanto para Daniel como para que Francisco "sienta" el producto antes de tener Zavu real.
- **Verificado en vivo, en la URL real, no sólo localhost:** calificar un mensaje real (👍) generó
  un registro real en `za_feedback_items`; "Tomar caso" → responder disparó el intento real de
  envío por Zavu y mostró el error correcto y esperado ("Zavu no está configurado", ya que no hay
  WhatsApp conectado todavía — comportamiento correcto, no un bug); "Devolver a IA" confirmado por
  API que vuelve `needs_human:false`. Se restauró el estado de Felipe a handoff urgente después de
  la prueba para no dejar la demo alterada.
- **Bug de caché encontrado durante la verificación:** Vercel sirve `/m/m.js` con
  `cache-control: public, max-age=0, must-revalidate`, pero el navegador puede seguir usando una
  copia vieja del script en una pestaña con historial de navegación previo al deploy más reciente
  — `location.reload()` o un `navigate` normal no lo detectan. Se resolvió navegando a una URL con
  query string nuevo (`/m/?cb=<timestamp>`). Tenerlo presente para la próxima vez que algo se vea
  desactualizado justo después de un deploy: no asumir que el deploy falló, verificar primero si
  es caché del lado del navegador de la pestaña de prueba.
- **Pendiente, no hecho en esta ronda:** ninguna paridad de "conversaciones reales" es visible
  todavía en Studio mismo (Studio sólo tiene el panel de correcciones/sugerencias/datos-info, no
  un visor de conversaciones) — no se pidió, no se construyó. Si se quiere que Daniel audite
  conversaciones completas desde Studio (no sólo desde la consola del cliente), es una pieza nueva
  a diseñar, no una extensión trivial de lo que ya existe.

## Bug real: la raíz "/" servía el simulador, no el dashboard · 31-07-2026

- **Reporte de Daniel** (captura de pantalla en el celular): entró a la URL pública pelada
  (`quiro-vitalis-demo-tiodaniel.vercel.app`, sin ruta) y le apareció el simulador de prueba
  ("MODO PREVIEW · NO ES WHATSAPP REAL", agente vacío sin datos) en vez de su consola operativa
  — lo interpretó como que se había caído la conexión con el dashboard.
- **Causa real, no una percepción:** `src/server.js` tenía una regla explícita para "/" (si existe
  `public/landing.html` se sirve esa; si no, cae al dashboard) — la intención era correcta y el
  comentario del código incluso lo decía así, pero el código apuntaba mal: el fallback leía
  `public/index.html` (que es literalmente el archivo del simulador/Playground, título "Preview
  del agente"), no `public/agenda.html` (el dashboard real, título "Operación · ZeroAgent"). Se
  corrigió el fallback — pero eso solo no bastó.
- **Segunda causa, más de fondo, y la que realmente importaba:** aunque se arregló el fallback en
  el código, la URL raíz seguía sirviendo el simulador. Confirmado con la API de Vercel
  (`/v8/deployments/{id}/files/{uid}`) que el código desplegado SÍ tenía el fix — el problema es
  que **Vercel sirve archivos estáticos llamados exactamente `index.html` en "/" antes de evaluar
  cualquier rewrite**, sin importar que `vercel.json` tenga `"rewrites":[{"source":"/(.*)",
  "destination":"/api/index"}]` apuntando todo a la función. O sea: mientras existiera
  `public/index.html`, la ruta "/" NUNCA iba a ejecutar la lógica condicional de `server.js` —
  el archivo estático ganaba siempre, por diseño de Vercel, no por un bug de caché ni de deploy.
- **Fix real:** se renombró `runtime-template/public/index.html` → `public/playground.html`
  (mismo contenido, sin cambios funcionales) y se actualizó la ruta `/playground` en `server.js`
  para leer el nuevo nombre. Al no quedar ningún archivo llamado `index.html` en `public/`, "/"
  ahora sí ejecuta el rewrite y la lógica condicional real. Verificado en la URL pública real
  (incluyendo la URL de deployment específica para descartar problemas de alias/caché): "/" →
  "Operación · ZeroAgent" con los datos reales (conversación de Felipe pendiente incluida);
  `/playground` sigue sirviendo el simulador sin cambios; `/m/` sin cambios.
- **Por qué esto importa para todo cliente futuro, no solo quiro-demo:** este bug vive en
  `runtime-template/src/server.js`, el template compartido — cualquier cliente sin
  `public/landing.html` propio (o sea, la gran mayoría hoy) habría tenido el mismo problema: su
  dueño entra a su URL principal y ve el simulador de pruebas en vez de su operación real. Ya
  quedó corregido en el template para todos los builds futuros, no solo parchado para quiro-demo.
- **Regresión inmediata encontrada por Daniel (captura de celular, minutos después del fix
  anterior):** el fix de arriba hizo que "/" cayera en `agenda.html` — pero esa es la consola de
  **escritorio**, nunca pensada para verse en un teléfono real: el bottom nav se desbordaba,
  "Pausar agente" se cortaba en dos líneas apretadas, todo se veía roto. Exactamente el lente de
  diseño que hay que aplicar siempre (ver política del proyecto) — arreglar el ruteo no bastaba,
  había que verificar cómo se veía de verdad en el dispositivo real donde se usa.
  - **Fix:** `pathname === '/'` ahora revisa `req.headers['user-agent']` (regex simple:
    Android/iPhone/iPad/iPod/Mobile) — si es móvil, sirve `public/m/index.html` (la consola ya
    diseñada para eso); si no, `agenda.html` (escritorio). El simulador sigue aparte en
    `/playground`, sin tocar.
  - **Verificado con curl real usando ambos User-Agent** (no solo cambiando el viewport del
    navegador de prueba, que no cambia el UA real): UA de Android → responde con
    `script src="/m/m.js"`; UA de Windows/Chrome de escritorio → responde con
    `script src="/client-console-v2.js"`. Contenido de `/m/` sin cambios respecto a lo ya
    verificado en la ronda anterior (Bandeja con conversaciones reales).

## El landing de Vitalis se había perdido (encontrado y restaurado) · 31-07-2026

- **Segundo reclamo de Daniel, más grave que el anterior:** el landing explicativo del producto
  (propuesta de valor, cómo funciona, límites, "pruébalo tú mismo") ya no aparecía en "/" —
  "eso de nuevo te lo saltaste". Tenía razón: el propio checklist estándar de despliegue
  (`## Estándar de demo por cliente · 30-07-2026`, paso 9) dice explícitamente "verificar landing
  en '/'" — es parte del procedimiento esperado, no algo opcional, y yo lo traté como si su
  ausencia fuera el estado normal en vez de investigar por qué faltaba.
- **Causa raíz encontrada revisando los builds viejos, no adivinada:** `storage/agent-builds/
  quiro-demo/1.0.0-build-1785354189822/public/` SÍ tenía `landing.html`/`landing.css`/
  `landing.js` — un landing real y específico para Vitalis (hero con mock de chat, "Cómo
  funciona" en 3 pasos, límites del agente, CTA a `/m`). Nunca se guardó en
  `runtime-template/public/` (el template compartido de donde `buildClientRuntime` copia cada
  build nuevo) — vivía solo en esa carpeta de build puntual. Cada build posterior (v1.1.0 en
  adelante) se generó desde el template limpio, sin esos 3 archivos, y desapareció sin que nadie
  lo notara hasta ahora.
- **Por qué no se guardó en el template compartido:** el contenido es específico de Vitalis/
  quiropráctico (menciona la marca, el caso de uso exacto) — meterlo en `runtime-template/public/`
  lo pondría por defecto en TODOS los clientes futuros, lo cual está mal. El sistema de build
  (`buildClientRuntime`) no tiene hoy un mecanismo de "archivos propios por cliente que sobreviven
  al rebuild" — sólo copia el template compartido. Ese es el hueco real de herramienta, no algo
  que se arregle agregándolo al template.
- **Fix aplicado:** se guardó una copia de referencia en `storage/client-landings/quiro-demo/`
  (fuera de `runtime-template/`, no se copia a otros clientes) y se copió manualmente al build
  desplegado más reciente antes de subirlo a Vercel. **Pendiente real:** la próxima vez que se
  corra `build-runtime` para quiro-demo, hay que volver a copiar estos 3 archivos a la carpeta de
  build nueva antes de desplegar — no es automático todavía. Si se repite este patrón con más
  clientes, vale la pena construir el mecanismo real (ej. `runtime-template/client-overrides/
  <clientId>/` que `buildClientRuntime` fusione encima del template).
- **Verificado en la URL pública real** (con curl usando UA de escritorio y de iPhone, y en el
  navegador): "/" muestra el landing completo, sin overflow horizontal (`scrollWidth ===
  clientWidth === 375`), tipografía Fraunces cargando, botón "Abrir el agente" apunta a `/m`
  (que ahora sí enruta a la consola móvil real). Cero errores de consola.

## Francisco (FrancisKOM) aceptó — se separa demo de producción real · 31-07-2026

- **El cliente piloto aceptó el servicio.** Desde ahora hay que distinguir dos cosas que antes
  eran una sola: **`quiro-demo` (marca "Vitalis")** queda congelado tal cual está — Supabase y
  Vercel actuales, datos ficticios (Camila, Felipe) — como vitrina para mostrar a otros
  prospectos. **`franciskom`** es el proyecto nuevo y real de Francisco (Kinesiología ·
  Quiropraxia, Buin, 5.0★/50 reseñas en Google) — nunca se mezcla infraestructura entre ambos.
- **Estructura creada para franciskom (31-07-2026):**
  - Cliente registrado en Studio (`clients.id = 'franciskom'`) vía `POST /api/clients`.
  - Supabase propio del cliente: proyecto `pbyyixjilpnknjpvgeuq`, cuenta
    `dgonzalez.tagle+franciskom@gmail.com`. Esquema completo aplicado (`agenda-v1.sql`,
    `agenda-v1-extras.sql`, `agenda-v1-direct-data.sql`) vía Management API — **no** se corrió
    `_seed-demo.sql` (esa instancia es real, no lleva datos ficticios).
  - Credenciales guardadas en dos lugares, nunca en memoria de IA en texto plano: (a)
    `runtime-template/.env.franciskom` (gitignorado, mismo formato que `.env.quiro-demo`:
    management token, project ref, URL, service role key) para scripts/dev local; (b) vault
    cifrado de Studio (`PUT /api/clients/franciskom/infrastructure`, DPAPI vía `vault.js`) para
    que Studio mismo pueda leer feedback/handoffs remotos. Verificado con
    `POST /api/clients/franciskom/infrastructure/test` → conexión y esquema Agenda v1 OK.
  - **Clonado completo del agente (31-07-2026):** el placeholder inicial del prompt no fue el
    único hueco — tampoco se habían portado los 3 datos de precios reales que Francisco cargó
    él mismo en `quiro-demo` vía DATOS/INFO (Box Buin, Eleva Salud, domicilio), y Daniel lo notó
    de inmediato al entrar a Studio. Se portó todo: prompt/persona completo (Francisco Martinez,
    detección de urgencia, criterio profesional), los 2 `knowledge_items` aprobados, y los 3
    `za_business_data` reales — copiados al Supabase propio de franciskom, no al del demo. "Un
    clon" significa clonar también los datos reales que el cliente ya había cargado, no sólo el
    código — lección para la próxima vez que se separe demo/producción de un cliente.
  - Tampoco se creó todavía repo Git ni proyecto Vercel separado para franciskom — Daniel pidió
    explícitamente dejar esa parte para después ("lo del git y vercel lo vemos después que tengas
    armado todo").
  - **Orden de construcción acordado (31-07-2026):** el login PIN (con pantalla obligatoria de
    "cambia tu PIN" en el primer ingreso, ver diseño más abajo) se deja deliberadamente para el
    **último** paso — así Daniel (y eventualmente Francisco) pueden hacer QA entrando libremente
    a `/agenda` y `/m` sin loguearse en cada prueba mientras se construye el resto. Orden: (1)
    landing patient-facing con datos en vivo, (2) resto de contenido/ajustes, (3) QA visible
    apretando botones, (4) recién ahí el candado PIN, (5) repo Git + Vercel separados.
  - **Diseño acordado del login PIN (no construido aún):** PIN inicial tipo "genérico" (ej.
    120174) marcado con una bandera `must_change`; al loguearse con ese PIN se fuerza una
    pantalla de "Define tu PIN" antes de dejar pasar al resto del panel — no se puede saltar. Una
    vez definido su PIN propio, se guarda hasheado (nunca texto plano) y se apaga la bandera.
  - **Datos reales adicionales cargados desde la ficha de Google/redes de Francisco
    (31-07-2026):** WhatsApp real `+56 9 8743 0833` (seteado en `agent.whatsapp`), dirección
    "El Recurso, Buin (Box Buin)", correo `francisco.martinez.quiroz@gmail.com`, y una
    descripción real del negocio (Kinesiología/Quiropraxia/Osteopatía, 5.0★/50 reseñas Google,
    +4.5K Instagram @franciskom_) — todo cargado a `za_business_data`/`za_business_info` de
    franciskom.
  - **Horario semanal completo: pendiente, no es un bug, es información que falta.** Google solo
    expone "cierra a las 20:00" del día de hoy, no la semana completa — Daniel aclaró que
    probablemente el horario real depende de las horas reservadas en su box (como un centro
    médico), no un horario fijo de local. **Plan acordado:** terminar de armar todo lo demás con
    los datos que ya tenemos, y al final generar un link de onboarding (`POST
    /api/clients/franciskom/onboarding` — el flujo genérico de 12 pasos que ya existe, no hay que
    construir nada nuevo) para que Francisco complete él mismo el horario real y cualquier otro
    dato que falte, antes de la entrega final.
- **Dirección de producto acordada para franciskom (landing ya construido, ver sección siguiente):**
  el landing público de esta instancia real NO debe estar enfocado en explicarle el producto a
  Francisco (como el landing de venta del demo) sino en sus **pacientes reales** — servicios,
  ubicación, horarios — con CTA a agendar/conversar. Desde ese mismo landing, Francisco entra a
  su panel admin por un link discreto. Como ese panel va a quedar expuesto en un dominio público
  real (a diferencia del demo, que solo Daniel y Francisco conocían), se decidió agregar un login
  simple (PIN + sesión por cookie) a `/agenda` y `/m` antes de lanzar — hoy esas rutas y todo
  `/api/client/*` no tienen ninguna autenticación, solo lo protege que la URL es difícil de
  adivinar. Este login todavía no está construido (deliberadamente al final, ver orden de
  construcción arriba).

## Landing patient-facing de FrancisKOM construido · 31-07-2026

- **Primera pieza real del plan "regalonear al primer cliente".** A diferencia del landing de
  `quiro-demo` (que le vende el producto a Francisco), este landing está pensado para SUS
  pacientes: paleta cálida crema/terracota, tipografía Fraunces + Inter, motivo decorativo tipo
  columna vertebral en el hero, CTA directo a WhatsApp real. Secciones: hero, los 3 servicios
  (Kinesiología/Quiropraxia/Osteopatía), "cómo funciona" en 3 pasos, las 3 ubicaciones reales con
  precio (Box Buin $36.000, Eleva Salud $30.000, domicilio $36.000+$6.000), testimonio real (la
  reseña de Google citada), CTA final, y footer con Instagram/WhatsApp reales + link discreto
  "Acceso equipo" hacia `/agenda` (sin candado todavía, a propósito — ver orden de construcción).
- **Archivos:** `storage/client-landings/franciskom/landing.html|css|js` — mismo patrón que
  quiro-demo (vive fuera de `runtime-template/` porque es contenido específico del cliente, no
  se copia a otros clientes). Incluye `_static-preview-server.mjs` + entrada
  `franciskom-landing-preview` en `.claude/launch.json` (puerto 5540) para poder previsualizar con
  rutas absolutas reales (`/landing.css`, `/landing.js`) antes de que exista un build/deploy —
  reutilizable para el próximo cliente que necesite este mismo tipo de preview aislado.
- **Verificado en navegador real, no solo generado:** las 3 tarjetas de ubicación (inicialmente
  quedaron sólo 2 de 3 — Eleva Salud se me quedó afuera por descuido al redactar el HTML, se
  corrigió antes de dar por bueno el resultado — lección: verificar contra los datos reales
  guardados, no contra lo que uno recuerda haber escrito), responsive en 375px sin overflow
  horizontal, sin errores de consola, y un ajuste tipográfico real (un `<br>` manual en el hero
  dejaba una "a" huérfana sola en una línea en mobile — se sacó y se dejó que el texto haga wrap
  natural).
- **Pendiente:** integrar este landing al build real de franciskom cuando se arme la primera
  versión/deploy (hoy no hay ningún build todavía — ver pendientes de git/Vercel).
- **Fix real tras revisión de Daniel (31-07-2026):** la sección de "testimonio" citaba como
  reseña de un paciente un texto que en realidad es la descripción "Acerca de" que el propio
  Francisco escribió en su ficha de Google — no es una cita de cliente, y Daniel lo notó al ver
  el diseño. Se reemplazó por una sección honesta: 5.0★ + "50 opiniones reales en Google" + botón
  que enlaza directo a su ficha real de Google, sin inventar ninguna cita.
- **Explorado y descartado por ahora: carrusel en vivo de reseñas reales.** Daniel preguntó si se
  podía hacer un GET a las reseñas reales y mostrarlas en un carrusel. Es viable solo vía Google
  Places API (nunca scraping) — pero esa API devuelve **máximo 5 reseñas** por negocio (nunca las
  50 completas) y exige un proyecto de Google Cloud con facturación habilitada (tarjeta de
  Daniel, no se puede automatizar desde acá). Queda pendiente como mejora futura si Daniel decide
  montar esa cuenta; hasta entonces el link directo a Google cumple la misma función de prueba
  social sin ese costo/complejidad.
- **Mapa y "cómo llegar" reales, sin API key (31-07-2026):** cada tarjeta de ubicación tiene un
  link "Cómo llegar ↗" (`google.com/maps/dir/?api=1&destination=...`) y se agregó un mapa
  embebido de Box Buin con el método clásico sin clave (`maps.google.com/maps?q=...&output=embed`),
  a diferencia del carrusel de reseñas que sí necesitaría facturación.

## LEY de branding: "un producto hojacero.cl" · 31-07-2026

- **Regla fija declarada por Daniel para todo lo que se construya de ahora en adelante con estos
  agentes:** cualquier texto visible al usuario final que diga "ZeroAgent" (Construido/Tecnología
  por ZeroAgent, etc.) debe llevar agregado "· un producto hojacero.cl" a continuación. ZeroAgent
  es el nombre de la herramienta; hojacero.cl es la marca comercial de Daniel que debe quedar
  siempre asociada frente al cliente final. Guardado como memoria de tipo `feedback`
  (`hojacero-branding-ley.md`) para que no dependa de que se repita cada sesión.
- **Aplicado de inmediato en las 5 superficies donde ya existía el tag (31-07-2026):**
  - `runtime-template/public/agenda.html` (sidebar del panel de escritorio) — **el más importante,
    porque vive en el template compartido y por lo tanto ya queda incluido automáticamente en
    todo cliente futuro**, sin que haya que acordarse de agregarlo build por build.
  - `runtime-template/public/m/index.html` (pantalla "Hoy" de la consola móvil, nuevo
    `.powered-mobile` en `m.css`) — la consola móvil no tenía ningún tag de marca hasta ahora, se
    agregó para que ambas superficies (móvil/escritorio) queden consistentes, siguiendo el
    principio ya establecido de que toda la app debe funcionar en ambos con detección automática
    por User-Agent.
  - `storage/client-landings/franciskom/landing.html`, `storage/client-landings/quiro-demo/
    landing.html`, `landing-quiro-movil.html`.

## Verificación real del clon en PC y móvil · reveló 2 huecos no detectados antes · 31-07-2026

- **Daniel preguntó directamente si se había verificado que la info/botones estuvieran
  construidos tanto en móvil como en PC para franciskom.** La respuesta honesta era que no —
  sólo se había verificado que los datos quedaran bien guardados en Supabase/Studio, nunca que
  `/agenda` y `/m` reales los mostraran corriendo contra el backend de franciskom. Al hacerlo, se
  encontraron 2 problemas reales que la sola verificación de datos no hubiera detectado:
  1. **Mojibake en `name`/`niche`/`desc` del cliente:** venían corrompidos desde el primer
     `POST /api/clients` de esta sesión (hecho vía `curl` con heredoc, que no preserva UTF-8) —
     ya se había corregido `agent.name/role/systemPrompt` vía Node más tarde, pero esos 3 campos
     de nivel cliente nunca se tocaron. Se corrigieron con un script puntual usando el mismo
     driver `sqlite`/`sqlite3` que usa Studio, apuntando directo a `database.sqlite` (seguro de
     correr con el servidor Studio abierto en paralelo — SQLite maneja la concurrencia).
  2. **La Agenda (servicios/sedes/recursos) nunca se configuró para franciskom** — sólo se había
     portado prompt/knowledge/precios sueltos, pero el módulo de Agenda (`PUT /api/clients/:id/
     agenda`) seguía en `enabled:false`, 0 servicios, 0 recursos. Sin esto el preflight de
     instalación (`installation-preflight`) bloqueaba cualquier build. Se configuró con datos
     100% reales ya confirmados (Box Buin, Eleva Salud, domicilio, Francisco Martinez como único
     recurso) — el horario de cada sede quedó marcado explícitamente "PENDIENTE confirmar" en vez
     de inventarse, y los umbrales operativos (`slot_interval_minutes`, `minimum_notice_hours`,
     etc.) son valores por defecto razonables copiados de la estructura del demo, no datos reales
     confirmados por Francisco — quedan para ajustar cuando llegue el cuestionario de onboarding.
  3. También se agregaron las 3 pruebas de regresión de quiro-demo (mismo comportamiento de
     prompt, no datos específicos del demo) para que el preflight dejara de bloquear por "falta
     al menos una prueba activa".
- **Con eso resuelto, se creó la primera versión real (0.1.1) y se construyó un runtime de
  preview** (`storage/agent-builds/franciskom/0.1.1-build-1785526969527/`), con el landing ya
  copiado adentro. Como `src/server.js` nunca llama `.listen()` a propósito (para no repetir el
  bug de detección de framework de Vercel), se creó un wrapper local
  `_local-preview-wrapper.mjs` + `storage/agent-builds/franciskom/preview.env` (gitignorado,
  con las credenciales reales de franciskom) + entrada `franciskom-runtime-preview` en
  `.claude/launch.json` (puerto 4610) — reutilizable para verificar el próximo build de
  cualquier cliente antes de desplegarlo de verdad.
- **Verificado en navegador real, ambas superficies, contra el backend real de franciskom:**
  `/agenda` (PC) y `/m` (móvil) — ambas muestran correctamente el nombre correcto ya sin
  mojibake, las 7 fichas de `za_business_data`/`za_business_info` (precios, dirección, WhatsApp,
  correo, descripción), los 2 knowledge_items, el tag "Tecnología por ZeroAgent · un producto
  hojacero.cl", y la navegación entre pestañas (Negocio/Calidad/Entrenar) sin errores de consola
  ni requests fallidos (todas las llamadas a `/api/client/*` y `/api/agenda/dashboard`
  respondieron 200). No se probó el chat real del agente (necesita `LLM_API_KEY`, que franciskom
  aún no tiene configurada — pendiente distinto, no bloqueante para esta verificación).
- **Lección para todo flujo de clonación futuro:** verificar que los datos "llegaron bien" a la
  base (vía API/SQL) NO es lo mismo que verificar que el producto real los muestra — hay que
  correr el build real contra el backend real del cliente antes de dar el clon por completo.
- **Decisión de proceso (31-07-2026):** por ahora NO se construye una función formal de "Clonar
  nicho → cliente" en Studio — recién se hizo este flujo por primera vez con franciskom, y
  automatizarlo con un solo caso real es alto riesgo de diseñarlo mal (los huecos de arriba son
  justo el tipo de cosa que sólo se aprende a chequear pisándola). Se deja como checklist manual
  documentado + la plantilla de verificación reutilizable; la herramienta formal se construye
  recién en el SEGUNDO clon real (el próximo cliente de cualquier nicho), con dos casos de
  referencia en vez de uno.

## Logo real de FrancisKOM agregado · 31-07-2026

- Francisco compartió su logo real (PNG transparente) — guardado en
  `storage/client-landings/franciskom/logo.png` (mismo criterio que el resto de sus assets de
  marca: vive junto al landing, no en la raíz del repo ni en `runtime-template/`).
  Reemplazó el wordmark de texto "FrancisKOM" en el nav del landing por el logo real
  (`<img src="/logo.png">`, 34px de alto, mantiene proporción). Verificado que carga 200 OK y
  renderiza sin distorsión (naturalWidth/naturalHeight y renderedWidth/renderedHeight con la
  misma proporción).
- **Bug real encontrado por Daniel al probar "Acceso equipo" (dio 404):** no era un problema de
  la vista previa liviana (`localhost:5540`, que no tiene `/agenda` y por diseño da 404 ahí,
  esperable) — el problema real era que `runtime-template/src/server.js` nunca tuvo una ruta
  para `/logo.png`. Cualquier logo agregado a un landing habría salido roto en el sitio
  desplegado de verdad. **Fix aplicado al template compartido** (afecta a todo cliente futuro
  con logo, no sólo franciskom): agregada la ruta `GET /logo.png` junto a las de
  `landing.css`/`landing.js`. Sincronizado también al build `0.1.1-build-...` ya generado
  (`landing.html/css/js` + `logo.png` recopiados a `public/`, y `src/server.js` actualizado).
  Verificado end-to-end con el runtime real corriendo: `/` sirve el landing con el logo en
  200 OK, y "Acceso equipo" lleva correctamente a `/agenda`.

## Planificación futura: inyección de conocimiento a gran escala · 31-07-2026

- **Contexto:** conversación con Daniel (no ligada a Francisco — usó su caso solo de ejemplo,
  sin intención de cambiar su producto) sobre qué hacer cuando un cliente futuro tenga MUCHO más
  conocimiento del que cabe en un prompt simple — ej. una empresa con un PDF de 200 páginas, un
  corredor con 500 propiedades, o (ejemplo extremo) un doctor que quiera cargar 25.000 páginas de
  libros de medicina para que el agente "filtre" mejor el dolor en la conversación (sin cambiar
  la regla de "nunca diagnostica, deriva ante señales reales" — eso no cambia).
- **Son dos problemas distintos, no una sola perilla "RAG sí/no":**
  1. **Catálogo grande pero estructurado** (500 propiedades): no es RAG — es darle al agente una
     **herramienta para consultar una base de datos con filtros reales** (mismo patrón que ya
     existe para la Agenda: `get_availability`, `create_appointment` → acá sería
     `search_properties(comuna, precio, dormitorios...)`). Más simple y más preciso que buscar
     por parecido semántico cuando los datos ya son estructurados.
  2. **Conocimiento grande y no estructurado** (el libro de 25.000 páginas): esto sí es RAG real
     — trocear el texto, generar un embedding (vector) por fragmento, guardarlos en `pgvector`
     (extensión de Postgres — el mismo Supabase que ya tiene cada cliente, sin infraestructura
     nueva), y en cada pregunta buscar sólo los 3-5 fragmentos más relevantes para inyectarlos —
     nunca el documento completo.
- **Cómo se trocea (aclarado a pedido de Daniel):** no es clasificar el libro, ni cortar por
  conteo fijo de palabras a lo bruto (eso corre el riesgo de cortar a mitad de una idea). Se
  corta por sentido — donde termina un párrafo/sección — apuntando a un tamaño objetivo, y
  normalmente el fragmento siguiente repite un poco del final del anterior para no perder el
  hilo. Analogía usada: "no es partir una cuerda cada 25 cm exactos, es partirla en los nudos."
- **Costos, dos cosas distintas que no hay que mezclar:**
  - **Ingesta (costo único):** barata si el PDF es texto digital real — para 1.000 páginas,
    centavos de dólar en embeddings y minutos de procesamiento. Si el documento fuera un libro
    escaneado (imágenes, necesita OCR), el costo y tiempo suben harto y la precisión baja — vale
    la pena confirmar esto apenas aparezca un caso real concreto.
  - **Uso (costo recurrente):** cada pregunta agrega ~2.000-3.000 tokens de contexto extra (los
    fragmentos recuperados) a esa respuesta puntual — este costo escala con el volumen de
    conversaciones del cliente, NO con el tamaño del libro (da lo mismo si son 1.000 o 25.000
    páginas, siempre se inyectan sólo los fragmentos relevantes a esa pregunta).
- **Mecanismo:** nunca se pega el PDF completo en una conversación con Claude — reventaría la
  ventana de contexto y no quedaría reutilizable. El flujo real: Daniel indica dónde vive el
  archivo (ruta local, o eventualmente un botón de carga en Studio), y un script/pipeline hace
  todo de una pasada (extraer texto → trocear → generar embeddings → guardar) sin intervención
  manual paso a paso.
- **Decisión de proceso (misma lógica que "clonar nicho → cliente"):** no se construye nada de
  esto todavía — se deja como decisión de arquitectura documentada (dos módulos: catálogo con
  herramientas vs. RAG vectorial, elegibles como "modo de conocimiento" al crear un cliente en
  Nichos) para no tener que diseñarlo desde cero cuando aparezca el caso real. Daniel va a buscar
  un PDF de ejemplo de algún tema para probar el pipeline cuando corresponda.

## franciskom.vercel.app: primer deploy real, crash y causa raíz · 31-07-2026 / 01-08-2026

- **Repo:** `https://github.com/dgonzaleztagle-hub/franciskom` (main). Antes de subir el primer
  commit se excluyeron a propósito: `.env.franciskom`/`.env.quiro-demo` (el build los había
  copiado completos con credenciales reales — `fs.cp` recursivo del template no respeta
  `.gitignore`, sólo git lo respeta), `_local-preview-wrapper.mjs` (wrapper de prueba local con
  un `.listen()` real — ver más abajo por qué eso es peligroso en este repo específicamente), y
  `supabase/_seed-demo.sql` (no aplica a una instancia real). Se agregó un `.gitignore` propio al
  repo nuevo cubriendo `.env`/`.env.*`.
- **Daniel creó el proyecto Vercel él mismo** (importando el repo desde GitHub) y conectó
  `franciskom.vercel.app` — primer deploy real mostró **FUNCTION_INVOCATION_FAILED** en todas las
  rutas.
- **Causa raíz encontrada con logs reales (no adivinada):** el conector MCP de Vercel
  pre-conectado en este entorno apunta a la cuenta de **Rishtedar** (otro cliente) — no servía
  para depurar franciskom (regla del proyecto: nunca usar el conector de la cuenta equivocada).
  Daniel dio un token personal de su propia cuenta (`vcp_...`, guardado en `.env.vercel` en la
  raíz del repo, gitignorado, reemplazando el token anterior). Con eso, el log de build mostraba
  literalmente: **"Build complete — Using `src/server.js` as the root entrypoint."** — el
  proyecto en Vercel tenía el **Framework Preset en "Node.js"** (`framework: "node"` en el
  project config), probablemente auto-detectado al importar el repo. Con ese preset Vercel trata
  `src/server.js` como un servidor persistente que debe escuchar un puerto — ignora
  `vercel.json`/`api/index.js` por completo. Como este runtime nunca escucha un puerto a
  propósito (diseñado para correr como función serverless), el proceso no respondía nada.
- **Hipótesis intermedia descartada con evidencia:** antes de encontrar el framework preset, se
  sospechó que el comentario en `src/server.js` que advertía "nunca escribas `.listen(` acá,
  Vercel lo detecta por texto" citaba el propio patrón prohibido de forma literal dentro del
  comentario, re-disparando la misma detección. Se reescribió igual (sin citar el patrón
  literalmente en ningún comentario/log del archivo — buena práctica real, y evita que la próxima
  persona que lea ese comentario copie el patrón prohibido sin querer) pero el log de build
  **seguía** diciendo "Using src/server.js as root entrypoint" después de ese fix — confirmando
  que el framework preset era la causa dominante, no el texto del comentario.
- **Fix aplicado (vía API, con el token de Daniel):**
  1. `PATCH /v9/projects/{id}` con `{"framework": null}` — mismo valor que ya usa quiro-demo.
  2. Redeploy del mismo commit ya corregido → el log de build dejó de mostrar el mensaje de
     "root entrypoint" (confirmado antes de dar el fix por bueno).
  3. Cargadas las env vars `RUNTIME_MODE=preview_local`, `SUPABASE_URL`,
     `SUPABASE_SERVICE_ROLE_KEY` directo por API (Daniel señaló explícitamente que para eso le
     había dado el token — no había que pedirle que las pegara él mismo en el dashboard).
  4. Nuevo redeploy → verificado en navegador real (no sólo curl): `/` (landing con logo),
     `/agenda` (nombre "FrancisKOM" correcto, ya no el placeholder "Casa Aura" del template
     compartido), sin errores de consola.
- **Nota de verificación:** un `curl -sI` aislado a `/agenda` dio un 404 una sola vez justo
  después del redeploy (probablemente un blip de propagación de alias) — se confirmó que no era
  real repitiendo la petición 3 veces (200 consistente) y verificando en navegador real antes de
  reportar como resuelto.
- **Pendiente:** `LLM_API_KEY`/proveedor y las credenciales de Zavu (WhatsApp) siguen sin
  configurar — el chat real del agente todavía no se puede probar en producción. Login PIN sigue
  dejado para el final, como se acordó.

## QA de Daniel en consola móvil de franciskom — 4 huecos reales corregidos · 01-08-2026

- **Causa raíz de "Servicio en blanco / Profesional vacío" en Nueva reserva:** `seedAgendaCatalog`
  (la función que traduce el catálogo aprobado — sedes, servicios, recursos — hacia las tablas
  reales `za_locations`/`za_services`/`za_resources`/`za_resource_services` del Supabase del
  cliente) sólo se invoca desde `src/setup-agenda.js`, un script standalone. Nunca se corrió para
  franciskom: se aplicó el esquema SQL y se guardó la config de Agenda en Studio, pero jamás se
  sembraron filas reales en su Supabase. Corregido corriendo `seedAgendaCatalog` directo contra el
  Supabase real de franciskom (2 sedes, 3 servicios, 1 recurso creados) — confirmado en navegador:
  el combo Servicio ahora lista las 3 evaluaciones reales.
- **Bloqueador real descubierto al probar creación de reserva:** con el catálogo ya sembrado, crear
  una reserva sigue fallando con `"Horario fuera de disponibilidad"` porque `za_availability_rules`
  está vacía — Francisco todavía no confirma su horario semanal completo (los `hours` del paquete
  siguen marcados `PENDIENTE`, a propósito, para no inventar un horario). **No se inventó un
  horario para destrabar esto** — sigue pendiente que Francisco confirme horas reales (vía el
  cuestionario de onboarding) antes de que cualquier reserva pueda crearse de verdad, en preview o
  producción.
- **Profesional no debería ser un dropdown con una sola opción:** fix general (no específico de
  franciskom) en `public/m/m.js` — cuando `catalog.resources.length === 1`, el campo "Profesional"
  del formulario de reserva móvil pasa de `<select>` a un texto fijo con el nombre, con un
  `<select hidden>` de una sola opción detrás para que el submit siga funcionando igual.
- **Captura de correo en reservas — gap real en todo el flujo, no sólo la UI:** ni el formulario
  manual, ni el tool `create_appointment` del agente, ni la RPC `za_request_appointment` aceptaban
  email. Se agregó de punta a punta (aplica a cualquier cliente futuro, es fix general):
  - `supabase/agenda-v1.sql`: la RPC ahora acepta `p_customer_email` (default null) y hace upsert
    en `za_customers.email` sin pisar un email ya guardado con uno vacío.
  - `src/agenda.js` (`createAgendaAppointment`) y `src/agenda-tools.js` (tool `create_appointment`,
    con instrucción explícita al agente de pedir el correo si el cliente no lo ha dado en la
    conversación, y seguir igual si se niega).
  - `public/m/index.html`/`m.js`: campo "Correo (para su ficha)" opcional en Nueva reserva.
  - Migración de la función aplicada al Supabase real de franciskom (no se tocó el de quiro-demo —
    queda congelado como demo de venta).
- **"Entrenar al agente" en móvil — scroll largo:** se dividió en 3 sub-pestañas (segment-pills,
  mismo patrón visual que "Clientes"): **Sugerir dato** (correcciones pendientes + formulario de
  sugerencia + lo que el agente sabe hoy), **Datos sueltos** (`za_business_info`), **Datos del
  negocio** (`za_business_data`). Verificado el toggle en navegador real (cada botón muestra sólo
  su panel, sin overlap).
- **Pregunta abierta de Daniel, no resuelta con código:** si "Clientes" (CRM liviano
  frío/caliente/cliente) es la interpretación correcta de lo que él esperaba como "ficha", dado que
  a un kinesiólogo le suena más a ficha clínica que a CRM. La "ficha" sí existe hoy (el bottom sheet
  que abre al tocar un cliente en la lista — muestra contacto, segmento, WhatsApp/correo, historial
  de visitas con nota editable por visita) — pero la lista estaba vacía en la prueba de Daniel
  porque aún no hay clientes reales cargados (sin reservas creadas todavía, por el bloqueador de
  disponibilidad de arriba). Queda pendiente que Daniel confirme si ese nivel de detalle (nota
  libre por visita) alcanza, o si espera campos clínicos explícitos (zona de dolor, tipo de
  tratamiento, etc.) antes de dar por cerrado este punto.
- Todos los archivos fuente se sincronizaron también en
  `storage/agent-builds/franciskom/0.1.1-build-1785526969527/` (build usado por el preview local en
  el puerto 4610) y el servidor de preview se reinició para reflejar los cambios — verificado en
  navegador real, sin errores de consola.

## Fix real: `/agenda` no detectaba móvil (Daniel entró desde Android y vio el dashboard de PC) · 01-08-2026

- **Causa real:** la raíz `/` sí tenía detección de mobile (User-Agent) para caer en `/m` en vez de
  `agenda.html`, pero la ruta explícita `/agenda` en `src/server.js` **nunca la tuvo** — siempre
  servía el dashboard de escritorio sin importar el dispositivo. El link discreto "Acceso equipo"
  del footer del landing de franciskom apunta justo a `/agenda`, así que cualquiera que lo tocara
  desde el celular (como hizo Daniel en Android) caía en el dashboard de PC renderizado angosto,
  no en la consola móvil.
- **Fix (general, no específico de franciskom):** se extrajo la detección a un helper único
  `isMobileRequest(req)` en `server.js` y se aplicó también en la ruta `/agenda`, no sólo en `/`.
  Cualquier link duro a `/agenda` desde un landing futuro queda cubierto igual.
- **Verificado con curl usando User-Agent real de Android y de escritorio, contra
  `https://franciskom.vercel.app/agenda` en producción** (no sólo local): Android sirve
  `m/m.css`/`tabbar` (consola móvil), escritorio sirve `client-console-layout.css` (dashboard PC).
  Commit y push directos al repo de franciskom (con el token que Daniel ya autorizó usar para esto),
  Vercel redeployó solo y se confirmó `READY` antes de dar el fix por bueno.

## Datos reales de operación + módulo de bloqueos de horario · 01-08-2026

- **Daniel sembrado como cliente de prueba real** en `za_customers` de franciskom (+56972739105,
  dgonzalez.tagle@gmail.com), con una reserva de prueba real ("Evaluación · Box Buin", nota "dolor
  de hombro derecho") — usada también para confirmar que la "ficha" (bottom sheet de Clientes) se
  ve poblada correctamente.
- **Horario semanal provisorio cargado:** lunes a sábado 10:00-20:00 para Francisco Martinez (6
  reglas en `za_availability_rules`), explícitamente marcado como no confirmado por Francisco — se
  reemplaza cuando él confirme el horario real.
- **"Atención a domicilio" pasó de 60 a 120 minutos de duración** (en `za_services` real y en la
  config de Studio) — una hora de atención a domicilio implica al menos 2 horas de agenda ocupada
  por el traslado, según indicó Francisco.
- **Módulo de bloqueos de horario — no existía, se construyó completo:** el schema SQL ya traía la
  tabla `za_availability_blocks` (bloqueos puntuales resource/starts_at/ends_at/reason) desde el
  diseño original de Agenda v1, pero nunca se escribió código que la usara. Se agregó:
  - `agenda.js`: `createAgendaAvailabilityBlock`/`deleteAgendaAvailabilityBlock` (Supabase + fallback
    local), chequeo de bloqueos también en el flujo local de `createAgendaAppointment`, y
    `getAgendaDashboard` ahora trae los bloqueos reales (antes hardcodeado a `[]`).
  - `server.js`: `POST`/`DELETE /api/agenda/availability-blocks`.
  - Consola móvil (`m/index.html`+`m.js`): sección "Bloqueos" en Agenda con botón "Bloquear
    horario" (sheet con motivo/desde/hasta, profesional fijo si hay uno solo) y listado con "Quitar
    bloqueo". Se factorizó `fillResourceField` (antes duplicado entre Nueva reserva y Bloquear
    horario).
  - **Verificado extremo a extremo en producción real:** crear un bloqueo, confirmar que aparece
    en la lista, confirmar que una reserva que se cruza con el bloqueo falla con "Horario
    bloqueado", y eliminar el bloqueo — antes de dar el módulo por bueno. Sin UI de escritorio
    todavía (pendiente si Daniel la pide).
## Datos reales de Instagram/promocional de Francisco incorporados · 01-08-2026

- **Horario actualizado a real:** Daniel compartió el copy que Francisco ya publica ("lunes a sábado
  de 8 a 20hrs, de acuerdo a disponibilidad") — se reemplazaron las 6 reglas provisorias (10:00-20:00)
  por las reales (08:00-20:00) en el Supabase real de franciskom y en la config de Studio.
- **2 knowledge_items nuevos:** (1) "todo el agendamiento se hace por este mismo canal, sin
  formulario aparte" — la "regla" que Daniel pidió extraer del resto del copy de horario; (2) bio y
  formación académica real de Francisco (Kinesiología UC Maule 2009-2014, Diplomado Terapia Manual
  U. de Chile 2016, Máster Osteopatía Madrid 2018-2023) para que el agente la use como conocimiento
  general.
- **Landing reconstruido** con: sección nueva "Quién te atiende" (bio + formación), el paso a paso
  reemplazado por el proceso real de sesión de Francisco (entrevista → razonamiento → terapia manual
  → plan), 3 testimonios reales con iniciales (reemplazando el link genérico a Google por uno + el
  link real de reseña `g.page/r/Ca96NkJRPVQxEBM/review`), la hora real (8-20h) agregada cerca de
  "Dónde atenderte", y un embed de YouTube Short (`youtube.com/embed/zSX4c5bd7Pw`, sin API key,
  mismo patrón que el mapa embebido).
- **Pendiente, requiere input de Daniel — no se construyó todavía:**
  - **Fotos reales** (headshot de Francisco de la imagen 2, foto corporativa de la imagen 3): las
    imágenes que Daniel pegó en el chat no quedan como archivo accesible en disco (a diferencia del
    logo, que sí se guardó como archivo) — la sección "Quién te atiende" tiene un placeholder vacío
    (`.about-photo`) listo para recibir la foto en cuanto Daniel la mande como archivo.
  - **Mensaje "spam" post-atención (pedir reseña en Google al día siguiente):** Daniel compartió el
    mensaje real y el link de reseña. Requiere un dispatcher programado (buscar citas completadas de
    ~24h atrás, enviar por WhatsApp, marcar como enviado) que no existe todavía, y depende de que
    Zavu (WhatsApp) esté configurado para franciskom — todavía no lo está. No se construyó a ciegas;
    falta que Daniel confirme el diseño antes de implementarlo.
  - **Formulario de admisión pre-consulta** (nombre, edad, ocupación, motivo, antecedentes médicos,
    síntomas extra — extraído del Google Form real vía WebFetch): la idea de Daniel es que el AGENTE
    pregunte esto en la conversación en vez de depender de un formulario que nadie llena. No se tocó
    el system prompt todavía — cambiar el prompt es sensible (mucha iteración ya invertida en el tono
    humano) y se prefirió proponerlo antes de escribirlo directo.
- **Nota de verificación honesta:** el rebuild del landing se verificó por DOM/texto/consola (sin
  errores, todas las secciones e iframes presentes) y en producción real tras el deploy, pero no se
  pudo tomar una captura visual esta vuelta (el panel del navegador no estaba visible en esta
  sesión) — falta una revisión visual real antes de darlo por definitivamente bueno en diseño.
- **Fotos reales agregadas (01-08-2026, segunda vuelta):** Daniel guardó los 2 archivos en la raíz
  del repo (`corporativa fransisco.png`, `sesion paso a paso fransiscokom.jpeg`) — se copiaron a
  `storage/client-landings/franciskom/` con nombres limpios, se agregó su ruta explícita en
  `server.js` (mismo patrón que `/logo.png`, el runtime no sirve estáticos genéricos) y se
  insertaron en el landing: la foto corporativa en "Quién te atiende", la infografía real del paso
  a paso en una grilla de 2 columnas junto al texto de los 4 pasos (no se reemplazó el texto, se
  usan ambos).
- **Bug real encontrado por Daniel en desktop:** el `<h2>` de la sección de video quedaba pegado a
  la izquierda en vez de centrado. Causa: heredaba `max-width:20ch` de la regla genérica `.panel h2`
  sin `margin:auto`, así que el bloque angosto no se centraba aunque `.video{text-align:center}`
  estuviera puesto — el mismo problema ya se había resuelto antes en `.cta-final h2` (que sí tiene
  `margin:0 auto`) pero no se replicó el patrón al agregar la sección de video. Corregido agregando
  `margin:0 auto`; verificado con JS en el navegador en un viewport de escritorio real (1400px) que
  el centro del `<h2>` y del video coinciden exactamente con el centro del panel — no sólo se asumió
  arreglado por el cambio de CSS.

- **Motivación real (de Francisco, vía Daniel):** hay 3 categorías de agendamiento distintas —
  Box Buin (propio, agendable libremente), domicilio (agendable pero con 2h de bloqueo mínimo por
  traslado) y Eleva Salud (Francisco NO controla su propia agenda ahí — es un centro médico donde
  atiende como profesional visitante). El módulo de bloqueos resuelve el caso de Eleva Salud: en
  vez de que el agente ofrezca agendar ahí libremente, Francisco bloquea manualmente los tramos en
  que está en el centro. **Pendiente de decidir con Daniel:** si el servicio "Evaluación · Eleva
  Salud" debería dejar de ser agendable por el agente/pacientes directamente (dado que ahí Francisco
  no controla el calendario), reemplazándolo por bloqueos manuales — no se tocó todavía, es una
  decisión de producto, no técnica.

## Migración de Studio a Supabase propio + landing comercial elevada · 19-08-2026

- **Migración SQLite → Supabase (Studio):** plan completo en
  `C:\Users\dgonz\.claude\plans\parallel-chasing-bee.md`, doblemente auditado antes de ejecutar.
  Fases 0-3 (proyecto propio, schema de 22 tablas + 12 RPC, migración de datos reales, reescritura
  completa de `server.js`) completas y verificadas con HTTP real, incluido un ciclo real de
  backup/reset/restore. Fase 4 arrancada: `studioDbBackend` (server.js:41) pasó a defaultear a
  `'postgres'` — `STUDIO_DB_BACKEND=sqlite` queda como salida de emergencia mientras dura el
  período real de uso, antes de borrar el código SQLite de respaldo, la bandera y las dependencias
  `sqlite`/`sqlite3`. Detalle completo (7 bugs reales encontrados y arreglados en el camino) en
  memoria de sesión (`studio-migracion-supabase.md`), no repetido acá para no duplicar bitácoras.
- **Landing comercial (`/demo`, `commercial-demo.html`) rediseñada de punta a punta.** Mismo
  contenido/estrategia ya validada (hero → cómo se entrena → cómo funciona → demo real embebido →
  resultados → principios → FAQ → captura de leads), pero elevada en ejecución: tipografía
  unificada a Fraunces (ya usada en los landings de cliente, antes esta usaba Georgia genérica —
  quedaba inconsistente con el resto de la marca) + Inter, revelado progresivo en scroll
  (`IntersectionObserver` con respaldo por tiempo para que nada quede invisible si el observer no
  dispara), marquee de confianza, grano editorial sutil. Se consolidaron 3 CSS fragmentados
  (`commercial-demo.css`/`-forms.css`/`-onboarding.css`) en un solo archivo coherente con tokens de
  diseño compartidos.
- **Sección nueva: caso real de FrancisKOM.** A pedido explícito de Daniel, se agregó prueba
  social con su nombre real (antes la landing sólo mostraba el demo ficticio "Casa Aura") — 3
  sedes, especialidades, 5.0★/50 reseñas Google, foto real (`corporativa fransisco.png` ya
  existente en el repo, copiada a `assets/franciskom-caso.png`), link directo a
  `franciskom.vercel.app` (sitio real en producción) y a su reseña real de Google. Sin citas
  inventadas atribuidas a Francisco — la prueba social se apoya en hechos verificables y un link
  real, no en un testimonio de texto que nunca dijo.
- **Verificado con HTTP/DOM real, no sólo generado:** todos los archivos sirven 200, cero overflow
  horizontal en desktop y 375px, formulario de leads probado end-to-end contra el Supabase real de
  Studio (lead de prueba creado y borrado después), acordeón de FAQ, animación de marquee y
  revelado en scroll confirmados por `getComputedStyle`/clases DOM. **No se pudo tomar una captura
  visual real esta vez** — el panel del navegador no estaba compositando frames en esta sesión
  (mismo síntoma que bloqueó `IntersectionObserver`, resuelto con el respaldo por tiempo) — falta
  una revisión visual real de Daniel antes de darlo por definitivamente bueno en diseño, siguiendo
  la política del proyecto de no confiar sólo en el chequeo funcional.
- **Hallazgo aparte, no arreglado (fuera de alcance):** el iframe del demo embebido
  (`/demo/panel?embed=1`, que sirve `agenda.html` del template) pide `/auth-gate.js`, que no existe
  → 404. Preexistente, no introducido por este cambio, vive en `runtime-template/`, no en la
  landing.
