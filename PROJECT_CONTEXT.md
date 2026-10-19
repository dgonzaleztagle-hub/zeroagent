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

## Landing desplegada de verdad a Vercel, sin el demo embebido roto · 19-08-2026

- **El 404 de arriba resultó ser más grave de lo que parecía:** `auth-gate.js` no es cosmético —
  oculta toda la página hasta confirmar sesión y sólo dispara el evento `za-authenticated` que
  `client-console-v2.js` espera antes de pedir cualquier dato. Sin ese script, el panel embebido no
  hacía NI UNA sola llamada de API (confirmado con la consola de red) — el botón "Probar el
  sistema" de la landing llevaba a una demo completamente muerta. Causa: el login PIN
  (`runtime-template/src/auth.js`+`public/auth-gate.js`) se construyó pensando en clientes reales
  desplegados con `runtime-template/src/server.js` (que sí sirve `/auth-gate.js`) — Studio nunca
  aprendió a servir ese archivo para su propia ruta `/demo/panel`, y nadie lo notó porque nadie
  había abierto esa demo desde que se agregó el PIN.
- **Decisión de Daniel:** en vez de replicar todo el login/auth para una demo desechable, sacar la
  prueba en vivo — "un tema visual solamente será suficiente por este inicio". Se reemplazó el
  `<iframe>` por una maqueta estática (`.panel-mock` en `commercial-demo.css`): conversación +
  reserva confirmada + tarjetas de agenda/calidad/handoff, sin ninguna llamada de red. Mismo
  criterio aplicado al link "Probar entrevista de ejemplo" (apuntaba a `/demo/onboarding`, otra
  ruta que sólo existe en Studio local) — ambos CTAs ahora apuntan al formulario de contacto real.
- **Con eso, la landing dejó de depender de Studio y se pudo desplegar de verdad.** Nueva carpeta
  `landing/` (repo raíz): copia estática de `commercial-demo.html/css/js` + los 2 assets +
  `api/leads.js` (función serverless de Vercel, sin dependencias, hace `POST` directo a
  `commercial_leads` en el Supabase de Studio usando `STUDIO_SUPABASE_URL`/
  `STUDIO_SUPABASE_SERVICE_ROLE_KEY`). Proyecto Vercel nuevo (`zeroagent-landing`, cuenta
  `dgonzaleztagle-hub`, mismo token ya usado para franciskom) creado y desplegado vía API directa
  (mismo patrón de subida de archivos que quiro-demo, sin conector Git) — protección SSO
  desactivada a propósito (por defecto Vercel la deja activada y nadie podría abrir el link sin
  loguearse en la cuenta de Daniel, mismo gotcha ya documentado para clientes).
- **Verificado en producción real, no sólo local:** `https://zeroagent-landing.vercel.app` — cero
  errores de consola, todos los assets 200, y el formulario de contacto probado de punta a punta
  contra la función serverless real (lead creado en el Supabase real de Studio y borrado después).
- **Pendiente/decisión futura, no resuelta hoy:** si vale la pena reconstruir el demo interactivo
  en vivo (necesitaría un login de "modo demo" que Studio no tiene) o si la maqueta estática basta
  a largo plazo. La prueba social real (caso FrancisKOM con link a `franciskom.vercel.app`) queda
  como la pieza de mayor peso de la landing mientras tanto.

## Auditoría previa a la marcha blanca de franciskom + 3 fixes desplegados · 08-09-2026

Francisco pidió arrancar la marcha blanca. Antes de dar el vamos se auditó el despliegue real
(repo `dgonzaleztagle-hub/franciskom`, Vercel `franciskom.cl`, Supabase `pbyyixjilpnknjpvgeuq`)
**probando el bot end-to-end contra la base real**, no sólo leyendo código. La infraestructura
estaba bien (deploy = último commit, dominio y variables OK, LLM con saldo, timezone chileno
correcto en las funciones SQL, Google Calendar filtrando los 8 calendarios con buffer de 30 min:
23 horas brutas → 5 reales). Los defectos estaban en el comportamiento, y ninguno se veía sin
conversar con el agente:

1. **La reserva se creaba y el bot le decía al paciente que no había hecho nada.** `za_update_
   customer_intake` comparaba `phone = regexp_replace(p_phone…)` normalizando sólo el parámetro y
   no la columna (`+56…` vs `56…`), así que **nunca** encontraba al cliente. Desde el commit del
   02-09 que hace pedir el correo junto al nombre, toda reserva con correo pasaba por ahí: la cita
   quedaba creada y sincronizada a Calendar, la herramienta lanzaba excepción, y el agente
   respondía "No pude confirmar esa operación de forma segura. No hice cambios en tu reserva".
   Agravante: `za_customer_record_entries` y las tablas de `agenda-v1-ai-account.sql` nunca se
   habían aplicado en el Supabase de franciskom (el manifiesto las lista, la instalación se quedó
   en las migraciones). Fix: normalizar los dos lados (en `agenda-v1-customer-records.sql` y en
   `migrations/20260808_customer_rut.sql`, que es la que realmente estaba viva), aplicar las dos
   migraciones faltantes, y envolver el guardado de ficha en try/catch — un dato opcional jamás
   puede voltear una reserva que ya existe.
2. **El modelo inventaba horas fuera del horario de atención.** Con listas largas (18-23 horas
   libres) gpt-4o-mini seguía la serie más allá del último dato real y ofrecía hasta las 22:00 en
   un negocio que cierra a las 20:00 — medido 3/3; con listas cortas responde exacto. Fix:
   `get_availability` devuelve `ofrecer_primero` (máximo 6, repartidas a lo largo del día) y
   mantiene `available_slots` completa para validar; el behavior de Agenda dice explícitamente que
   una hora que no esté en `available_slots` no existe, y que una que sí esté se acepta aunque no
   se haya ofrecido. Re-medido 3/3 sin horas inventadas, y "¿tienes a las 16:00?" (fuera de la
   preselección, libre de verdad) se sigue aceptando.
3. **Reservas pendientes que morían solas y que nadie veía.** TTL por defecto de 2 h con
   confirmación manual: una hora pedida de noche vencía antes de que Francisco despertara. El
   switch "avisarme de reservas nuevas" existía en la consola sin ninguna implementación detrás, y
   `handoff_alert_enabled` estaba en false con `alert_phone` vacío — por eso un handoff real
   (paciente Pamela Naranjo, 24-08) llevaba dos semanas sin que nadie lo viera. Fix: default de TTL
   a 24 h, alerta de reserva nueva implementada (best-effort, se salta el origen `client_console`),
   y **franciskom pasó a `confirmation_mode: automatic`** por decisión de Daniel — la invitación de
   Google Calendar que el paciente ya recibe funciona como confirmación, dejar la hora pendiente lo
   contradecía. Las franjas de riesgo de Eleva Salud siguen forzando confirmación manual.

**También se limpió en producción:** cita de prueba del 04-08 que seguía "pendiente", operador
`[DEMO] Operador de prueba` desactivado, y se pobló `za_service_locations` (estaba vacía: ningún
servicio amarrado a su sede, las reservas del bot quedaban sin sede y el evento de Calendar sin
color).

**Verificado en producción real** (`franciskom.cl/reservar`, navegador): modo automático reflejado
en toda la página, horas ofrecidas = las 5 reales del día según Calendar, copy del panel lateral
alineado con el modo.

**Pendiente, con decisión de Daniel:**
- **Canal de aviso para handoff.** El bot vive en el número personal de Francisco, así que no puede
  avisarse por WhatsApp a sí mismo. No existe ninguna capacidad de correo en el runtime (lo único
  que sale por correo hoy es la invitación de Google Calendar al paciente). Las vías reales son un
  proveedor de correo propio (Resend/SMTP con el dominio, sirve para toda la línea) o el scope
  `gmail.send` sobre el OAuth ya conectado (obliga a re-autorizar y Google lo trata como scope
  restringido).
- **`reminder_hours: 24` sigue siendo decorativo** — no hay código de recordatorios. Implica cron +
  envío automático a pacientes reales, no se hizo sin autorización explícita.
- **El Supabase de Studio (`nbjujqodjvhbxvvlfdfs`) ya no resuelve por DNS** — proyecto pausado o
  eliminado. Por eso el `confirmation_mode` de franciskom NO se pudo actualizar en Studio: si se
  reconstruye el build desde ahí, vuelve a `manual`.
- Silenciar contactos personales (`bot_muted`) es trabajo de Francisco, no nuestro — él sabe a
  quién deja y a quién no, y los irá marcando a medida que escriban.

### Canal de aviso al dueño resuelto: SMS por Zavu · 08-09-2026

Investigado con la cuenta real de Zavu de franciskom (no con supuestos):

- **Zavu sí manda correo** (`channel: 'email'` en el mismo endpoint de mensajes, con asunto,
  HTML, reply-to y adjuntos), **pero el sender de Francisco sólo tiene `whatsapp` y `sms_oneway`**
  — el canal de correo habría que habilitarlo en la cuenta (dirección/dominio de envío).
- **El sender ya trae `sms_oneway`, así que el SMS no necesita habilitar nada.** Y resuelve el
  problema de raíz: el SMS sale por la red de Zavu, no por el número de Francisco, así que sí le
  llega a ese mismo teléfono. Sirve además porque Francisco usa iPhone y no es hábil con
  tecnología (Web Push quedó descartado: iOS sólo lo entrega si la consola está instalada como
  PWA en la pantalla de inicio).
- **Costos reales (tarifas públicas de Zavu + saldo leído por API):** el plan free da **US$2 de
  crédito al mes** (`balance: 200`, en centavos) para SMS/voz/correo, más 2.000 mensajes de
  WhatsApp. SMS a Chile **US$0,067** → unos **29 avisos al mes**. Correo transaccional **US$0,40
  por 1.000** → 5.000 avisos con el mismo crédito (167 veces más barato por mensaje).
- **Implementado:** `sendZavuAlert()` en `zavu.js` (canal por `ALERT_CHANNEL`, default
  `sms_oneway`, y `subject` automático si el canal es correo), usado por la alerta de handoff y la
  de reserva nueva. Los textos se acortaron a una línea para que quepan en un segmento de 160
  caracteres — un mensaje largo se cobra 2 o 3 veces.
- **Configuración de franciskom:** `alert_phone = +56987430833` (su propio número),
  `handoff_alert_enabled = true`, **`booking_alert_enabled = false`** a propósito: las reservas ya
  entran a su Google Calendar y Google le notifica, así el crédito mensual queda para lo que sí
  necesita una persona.

**Hallazgo colateral, importante:** el WhatsApp de Francisco en Zavu tiene
`paymentStatus.setupStatus: NOT_STARTED` y `canSendTemplates: false` — el bot **sólo puede
escribir dentro de la ventana de 24 h** desde el último mensaje del paciente. Cualquier mensaje
proactivo (el recordatorio de 24 h antes, reactivaciones) está bloqueado por Meta hasta configurar
método de pago y aprobar plantillas. No afecta a la marcha blanca (responder a quien escribe entra
en la ventana), pero explica que el recordatorio no sea sólo "falta código".

### Flujo de toma de una conversación individual (verificado) · 08-09-2026

Hay **tres niveles de silencio** y conviene no confundirlos:

1. **Pausa global** (`za_agent_controls.mode`): el bot se calla con todos. Es la que está activa hoy.
2. **Pausa por conversación** (`za_conversations.status = 'handoff'`): el bot se calla sólo en ese
   hilo. Es la que corresponde cuando el dueño quiere meterse en un caso puntual.
3. **Contacto silenciado** (`za_customers.bot_muted`): el bot no le responde nunca más a esa
   persona. Es para los contactos personales, no para tomar un caso.

**Orden de chequeos en el webhook** (`server.js`): guarda el entrante → pausa global → estado
`handoff` de la conversación → `bot_muted` del contacto → recién ahí responde.

**Cómo se activa el nivel 2 desde la consola (existe en PC y en móvil, verificado por endpoint):**
- Botón "Tomar conversación" (móvil) / "Tomar caso" (PC) → `PATCH /api/client/conversations/<id>`
  con `status: handoff`.
- **O simplemente responder desde la consola:** `POST /api/client/conversations/<id>/messages`
  marca la conversación como `handoff` ANTES de enviar. El dueño no necesita acordarse de tomarla
  primero.
- "Devolver a la IA" / "Devolver a IA" → `status: active`, `needs_human: false`, y el bot retoma.
- El handoff automático del agente (pedido del cliente o franja de riesgo) deja la conversación en
  el mismo estado, así que el bot ya se calla solo en ese hilo sin intervención.

**Hueco conocido:** todo lo anterior asume que el dueño actúa DESDE LA CONSOLA. Si responde desde
la app de WhatsApp en su teléfono, el sistema no se entera y el bot puede seguir contestando en
paralelo. Los últimos 30 mensajes registrados en Zavu son 29 entrantes y 1 saliente (el SMS de
prueba): no aparece ningún mensaje enviado por Francisco desde su teléfono, y la documentación de
Zavu no aclara si emite eco de esos envíos. Por eso el 08-09 se **suscribió el webhook del sender
al evento `message.sent`** (antes: `message.inbound`, `message.delivered`, `message.failed`). Si
empiezan a llegar ecos de mensajes que no salieron de nuestra API, se puede cablear el
auto-takeover (el dueño responde desde su WhatsApp y el bot se calla solo en ese hilo); si no
llegan, hay que decirle explícitamente que para tomar un caso use la consola.

### Comprobado: Zavu NO ve los mensajes que el dueño manda desde su teléfono · 08-09-2026

Prueba en vivo con Daniel escribiéndole a Francisco por WhatsApp mientras se observaba el sistema:

- Se suscribió el webhook del sender al evento `message.sent` (antes sólo `message.inbound`,
  `message.delivered`, `message.failed`).
- Daniel le pidió a Francisco que respondiera; Francisco escribió "ok" desde su teléfono.
- Resultado: **cero eventos `message.sent`** en `za_webhook_events`, y **cero mensajes outbound de
  WhatsApp** al consultar directamente `messages.list` de Zavu (39 mensajes de WhatsApp en las
  últimas páginas, todos entrantes). Comprobado por las dos vías.

**Consecuencia:** no se puede auto-pausar el agente cuando el dueño se mete desde su celular,
porque el sistema no tiene forma de enterarse. Para tomar una conversación hay que hacerlo desde
la consola (botón "Tomar conversación", o simplemente responder desde ahí, que la toma sola). La
salida de fondo sería que Zavu exponga el eco de mensajes enviados desde la app de WhatsApp — es
una capacidad del modo de coexistencia de Meta, y hay que pedírsela a ellos.

**Implementado en cambio (decisión de Daniel: 12 horas):** `reclaimStaleHandoff` en
`conversations.js` — pasadas `HANDOFF_AUTO_RETURN_HOURS` (12 por defecto) sin mensaje humano
saliente en el hilo, el agente lo retoma. La ventana se cuenta desde el último mensaje humano, no
desde el último del cliente, para que un cliente que insiste no le devuelva la conversación al bot
antes de que el dueño alcance a contestar. Se evalúa en el webhook con el mensaje que entra, sin
cron. Verificado contra la base real: toma de 13 h vuelve al agente, toma de 2 h sigue con la
persona.

**Y el SMS de derivación ahora lleva el link de la consola** (`CONSOLE_URL`, ya configurada en
Vercel como `https://franciskom.cl/m`). Zavu exige verificar las URLs antes de enviarlas por SMS
(`urls.submitForVerification`; la de franciskom quedó `pending` de aprobación automática), así que
si ese envío es rechazado la alerta se reintenta sin el link — una alerta que no llega es peor que
una sin link.

### Marcha blanca iniciada + incidente del minuto 1 · 08-09-2026 22:03

Francisco despausó el bot desde la consola a las 22:03 (hora Chile). En los primeros dos minutos
apareció el problema de fondo que ninguna prueba de agenda había tocado:

**El bot le respondió a Daniel** (guardado en la agenda de Francisco como "Paciente Daniel
Gonzales", sin silenciar) mensajes que eran de coordinación técnica sobre el propio sistema —
"ok ahora lo que no tienes silenciado debería contestar automático" — y contestó en primera persona
como Francisco, con soltura: *"Entendido. Voy a dejar el bot despausado desde la consola para que
responda automáticamente en las conversaciones que no estén silenciadas."* Es decir, además de
opinar sobre un tema ajeno al negocio, **prometió una acción interna que no puede ejecutar**. Sonó
tan natural que Daniel escribió "parece que el bot que le puse es más inteligente de lo que
pensaba" creyendo que era Francisco.

**Por qué pasó:** `base-behavior.js` prohibía inventar DATOS y prometer acciones de herramientas,
pero nada impedía sostener una conversación entera sobre cualquier otro asunto. El modelo no
percibía que estaba fuera de dominio: sólo conversaba.

**Fix (general, todos los clientes):** bloque **ALCANCE** en `base-behavior.js` — sólo conversa
sobre el negocio (saludos, agradecimientos y que el cliente cuente cómo se siente siguen siendo
naturales); ante un tema ajeno lo dice en una frase y ofrece avisar al equipo; **nunca habla del
asistente** (su consola, pausas, silencios, quién lo programó); y nunca dice que hará algo "por
dentro". Deliberadamente corto: el propio archivo documenta que los bloques largos y densos en
prohibiciones suprimen el tool-calling. **Verificado tras el cambio:** los tres mensajes reales que
provocaron el incidente ahora son declinados, y disponibilidad, creación de reserva y handoff
siguen disparando sus herramientas; precios y conocimiento sin cambios.

**Contención aplicada en producción:** se silenció el número de Daniel y los **26 contactos
personales activos** que no están guardados como "Paciente ..." (la contadora, el sushi, la vecina,
el gas, taekwondo, Manuel de Eleva Salud, la apoderada, Amorchito…). Quedan **0 contactos
personales activos sin silenciar**; 38 silenciados en total. Reversible desde la consola con un
toque si alguno resulta ser paciente.

**Convención útil descubierta:** Francisco guarda a sus pacientes con el prefijo "Paciente ..."
(1.296 contactos), frente a 1.952 guardados con nombre propio y 46 sólo con número. Esa etiqueta
separa pacientes de personales mejor que cualquier heurística nuestra, y es la base del silenciado
selectivo aplicado hoy.

### Cierre del día: marcha blanca andando · 08-09-2026

**Estado al cierre:** bot `active` desde las 22:03 (hora Chile), 38 contactos silenciados, **0
contactos personales activos sin silenciar**, 0 casos abiertos en la bandeja, 0 citas de prueba en
la base. Desde la activación entraron 30 mensajes y el bot respondió 3 — todos a Daniel, antes de
silenciarlo. **Ningún paciente real ha escrito todavía**, así que el comportamiento en vivo está
por verse.

**Un último fix del día, encontrado por un falso positivo real:** Francisco recibió un SMS de
derivación que no correspondía a ningún paciente. Rastreado por el texto del propio SMS ("quiero
hablar con Francisco directamente"), resultó ser una **prueba de regresión del chat de preview**
hecha desde esta sesión: el playground crea tickets de handoff reales y `alertHandoff` los trataba
como cliente esperando. Le pasaría a cualquier dueño que pruebe su propio bot: SMS cobrado por un
cliente inexistente y caso falso en la bandeja. `alertHandoff` ahora ignora el canal `preview` —
el ticket se sigue creando (para eso se prueba), pero no interrumpe a nadie. Los dos tickets falsos
se borraron.

**Regla nueva para el equipo:** con el bot en vivo, **ya no se prueba contra la base del cliente
con el teléfono de alertas configurado**. Cada prueba puede sonarle el teléfono al dueño o
ensuciarle la bandeja. Probar sin `alert_phone`, o contra una copia.

**Consumo de SMS del día:** 2 mensajes (el de prueba autorizado y el falso), US$0,056. Quedan
~US$1,94 del crédito mensual.

**Studio, hallazgo lateral no resuelto (no afecta a franciskom):** el proyecto
`nbjujqodjvhbxvvlfdfs` **ya no existe** — su PAT de Management API responde `Unauthorized` (el
mismo valor en `.env` y en `~/.claude/credenciales/zeroagent-studio-supabase.md`) y su dominio no
resuelve por DNS, mientras el de franciskom sí resuelve desde la misma máquina. Se descartó
filtración: el token nunca estuvo en ningún commit ni en el repo público. Consecuencias: (1) Studio
quedó sin base de datos —su default es Postgres desde el 19-08; salida de emergencia
`STUDIO_DB_BACKEND=sqlite` con `database.sqlite.pre-migration-backup`—, y (2) **el landing
comercial sigue escribiendo sus leads en esa base muerta** (`landing/api/leads.js` →
`commercial_leads`), o sea prospectos que se pierden en silencio. Daniel debe entrar a
supabase.com con `dgonzalez.tagle+zeroagent@gmail.com` y ver si el proyecto existe; según eso, se
reconecta con un PAT nuevo o se crea uno de reemplazo.

**Lo que queda por delante en franciskom:** observar el comportamiento con pacientes reales (es lo
único que ninguna prueba entrega), y decidir si se le pide a Zavu el eco de coexistencia para poder
auto-pausar el bot cuando Francisco responde desde su teléfono.

### Primer caso real de la marcha blanca: dos defectos que sólo aparecen con un paciente de verdad · 09-09-2026

Francisco avisó que el agente le contestó a una paciente. Al revisar la conversación real
(`+56992373692`, **Adelaida Vergara**, cuidadora de un paciente adulto mayor con problemas
respiratorios, con historial de meses con Francisco) aparecieron dos cosas que ninguna prueba
había tocado:

1. **Una respuesta por cada mensaje.** Ella escribió tres líneas en dos segundos —como escribe
   cualquiera en WhatsApp— y el agente contestó tres veces, cada respuesta ciega a las siguientes,
   presentándose como "Francisco Martinez, Kinesiólogo Osteópata" a una paciente de años. Nada lo
   delata más como máquina. **Fix:** el webhook espera `INBOUND_DEBOUNCE_MS` (7 s) y, si en ese
   rato entró otro mensaje del mismo cliente, ese turno se calla; contesta el último evento, que
   ya tiene las tres líneas en su historial. Verificado contra la base real:
   `supersededByNewerInbound` distingue correctamente los dos casos.
2. **El dueño no podía encontrarla para sacarle el bot de encima.** Ella no está en los Google
   Contacts de Francisco (los guarda en el iPhone, que sincroniza con iCloud, no con Google), así
   que el sistema la había registrado con su propio número como nombre. En la consola veía una
   lista de números que no puede reconocer ni buscar. **Su nombre estaba en Zavu todo el tiempo**:
   el canal guarda el `profileName` que cada persona tiene puesto en su WhatsApp (98 de cada 100
   contactos lo traen). **Fix:** se usa ese nombre cuando el contacto no está en la agenda del
   negocio — del evento entrante si lo trae, y si no del cron horario, que ahora corre el sync de
   nombres en TODAS las pasadas (Google Contacts sigue sólo a las 7 am). Nunca pisa un nombre
   real: sólo filas cuyo `full_name` es el propio teléfono. Se hizo además un backfill manual:
   **43 contactos** dejaron de ser un número pelado en la consola de Francisco.

**Trampa documentada:** `contacts.list` de Zavu acepta un filtro `phoneNumber` que el backend
ignora — devuelve vacío para un número que sí existe (verificado 09-09-2026). Por eso el sync
recorre páginas recientes desde el cron en vez de resolver un teléfono puntual en el webhook.

**Contención inmediata aplicada:** la conversación de Adelaida quedó en `handoff` (el agente no
responde ahí) con el motivo escrito, y su ficha quedó con nombre para que Francisco la encuentre.

**Lo que NO era:** Francisco entendió que ella quería cancelar una hora. Los mensajes de
cancelación son de días anteriores; lo de anoche fue ella avisándole "te equivocaste de chat" —
probablemente por algo que él le escribió desde su teléfono, que el sistema no ve. Otra vez el
mismo hueco: el dueño conversando desde su celular mientras el agente responde en paralelo sin
saberlo.

### La nomenclatura de contactos de Francisco (corrige la regla de silenciado del 08-09) · 09-09-2026

Daniel explicó cómo clasifica Francisco a sus contactos, y **invalida parcialmente la regla que se
aplicó anoche** ("silenciar todo lo que no diga Paciente"):

- **`Paciente Fulano`** → paciente. El agente lo atiende.
- **`S1338`, `S1399`, `S1405`…** → **leads fríos**: gente que alguna vez se contactó y no llegó a
  acuerdo. Son 1.320 en su agenda. **El agente TIENE que atenderlos** — son clientes potenciales,
  justamente el tipo de conversación que el agente existe para recuperar.
- **Nombre propio sin prefijo** → personales, proveedores, colegas… o un paciente que todavía no
  etiquetó. Caso a caso.

**Error corregido:** el silenciado masivo del 08-09 dejó mudos a 14 leads `S-xxxx`. Ya se
revirtieron (`bot_muted=false`). Quedan 16 contactos silenciados, de los cuales **Natali Figueroa**
y **Maureen Ravest** son dudosos (nombre propio sin marca) y los debe revisar Francisco; el resto
son inequívocamente no-pacientes.

**Regla corregida para el futuro:** silenciar sólo lo que se reconoce como personal o proveedor.
Ante la duda, NO silenciar: que el agente conteste de más es recuperable con un mensaje; que no le
conteste a un lead o a un paciente es una venta perdida que nadie ve.

**Y la pregunta de fondo que Daniel hizo — ¿el nombre que Francisco pone pisa al de WhatsApp?
Sí.** `importAgendaCustomers` compara y sobrescribe (`if (existing.full_name !== item.full_name)
patch.full_name = item.full_name`), así que en cuanto él guarda el contacto en Google con su
nomenclatura, la sincronización diaria reemplaza el nombre de WhatsApp por el suyo. Y al revés no
ocurre: `syncWhatsappProfileNames` sólo toca filas cuyo nombre es el propio teléfono. El nombre de
WhatsApp es un relleno temporal, nunca una fuente que compita con la del dueño.

### El agente se presenta como asistente, nunca como el dueño · 09-09-2026

**Decisión de Daniel, no negociable:** el agente debe decir lo que es. Hasta hoy el paquete de
franciskom lo instruía al revés y a propósito — `system_prompt`: "Eres Francisco Martinez,
Kinesiólogo Osteópata", `role`: "habla en primera persona, como el profesional que eres" — y en el
día 1 de la marcha blanca eso llevó a que le respondiera como Francisco a pacientes de años.

Ahora: se presenta como "el asistente de FrancisKOM, el centro de Francisco Martinez", habla de
Francisco en tercera persona, y si le preguntan si es una persona o un bot **abre la respuesta
diciendo que no es una persona** (la versión anterior contestaba "soy el asistente de FrancisKOM…",
que deja la duda). La regla vive en `base-behavior.js` (bloque IDENTIDAD), así que aplica a todos
los clientes de la línea, no sólo a este paquete.

Lo que se conservó a propósito: nombrar a Francisco de forma concreta. El prompt original evitaba
convertirlo en "un profesional" externo y anónimo, y eso sigue siendo correcto — el paciente tiene
que saber quién lo va a atender. Lo que cambia es quién dice ser el que escribe.

Verificado tras el cambio: disponibilidad, derivación explícita, ruta de urgencia (caída +
hormigueo deriva de inmediato) y respuestas de precios se comportan igual que antes.

**Y se revirtió TODO el silenciado que no hizo Francisco** (instrucción de Daniel: el silencio es
decisión del dueño). Quedan 12 contactos silenciados: los 11 que eligió él más el número de Daniel,
que pidió expresamente que el bot dejara de responderle. Los 26 que se habían silenciado el 08-09
por heurística —incluidos 14 leads `S-xxxx`— vuelven a ser atendidos por el agente.

### Respuestas literales del negocio (el modelo elige cuál, no cómo) · 09-09-2026

Francisco pidió que precios y "qué incluye la sesión" se respondan **con su texto exacto** —
emojis, negritas de WhatsApp, saltos de línea y todo—, y que el bloque respiratorio salga *sólo*
si preguntan específicamente por eso.

Instruir al modelo a "copiar textual" no aguanta: antes o después parafrasea, se come un emoji o
reordena una línea, y deja de ser el texto del negocio. La solución es determinista: el paquete
declara `agent.literal_replies` (`{id, when, text}`), la herramienta `responder_textual` le da al
modelo sólo la decisión de CUÁL corresponde, y **el engine devuelve ese texto tal cual y corta el
bucle ahí mismo** — no vuelve a pasar por el modelo. Es genérico para toda la línea: cualquier
cliente puede tener sus bloques oficiales (precios, promociones, políticas).

Cargados para franciskom: `sesion_general` y `sesion_respiratoria`. **Verificado carácter por
carácter contra el texto que mandó Francisco: 6 de 6 exactos**, eligiendo bien el bloque en cada
caso, y sin invadir el resto (dolor → indaga; hora → `get_availability`; pedir persona → handoff;
saludo → presentación).

Los precios de sus bloques calzan con el catálogo real de la base, así que no hay contradicción
entre lo que dice el texto y lo que cobra la agenda.

**Pendiente de decisión de Francisco:** una pregunta de cobertura pura ("¿atienden en Paine?") hoy
se responde redactada (menciona el precio de paso) en vez de mandar el bloque completo. Puede
quedarse así o sumarse al caso de `sesion_general`; es cosa de decírselo.

### Ocho respuestas literales, envío de imágenes y el RUT que no bloquea · 09-09-2026

Francisco mandó el resto de sus textos oficiales. Quedaron cargados **ocho bloques**:
`sesion_general` y `sesion_respiratoria` (precios / qué incluye), `como_es_la_sesion` y
`tratamiento_respiratorio` (el proceso), `formacion_profesional`, `ubicacion_box_buin`,
`ubicacion_eleva_salud` y `horario_atencion` — todos palabra por palabra como él los escribió.

**Envío de imágenes, que no existía:** el runtime sólo mandaba texto. Un bloque literal ahora
puede declarar `image` y sale como UN mensaje de WhatsApp con el texto de pie de foto (los dos
bloques largos miden 959 y 831 caracteres, bajo el límite de 1024 del caption). Además las
imágenes de `public/` se sirven **por patrón** en vez de una ruta cableada por archivo — antes
agregar una foto que el agente pudiera mandar obligaba a tocar el servidor — y `asset()` ahora lee
el archivo ANTES de escribir cabeceras: al revés, un archivo inexistente mandaba un 200 a medias y
el cliente recibía la conexión cortada en vez de un 404. La imagen del flyer vive sólo en el repo
del cliente (`public/formacion-profesional.jpeg`), nunca en la plantilla.

**RUT al agendar (decisión de Daniel):** se piden nombre y apellido, RUT y correo en una sola
frase, pero **si falta el RUT la hora se toma igual** y el resto se pide después. El límite es
deliberado: exigir todos los datos antes de reservar es exactamente lo que dejaba al modelo
pidiendo información sin llamar nunca la herramienta.

**Cómo se afinaron los disparadores (medido, no a ojo):** con 18 formulaciones reales, la versión
final acierta **18/18**. En el camino se probó un rediseño donde el modelo elegía `tema` +
`aspecto` en vez del id del bloque: **midió peor (12/18)** y se descartó — lo que el modelo
realmente usa para decidir son las frases gatillo explícitas ("cuánto cuesta", "qué incluye",
"cómo es", "en qué consiste"), no una taxonomía. Las reglas negativas cruzadas ("no uses ésta
si…") también lo hacían oscilar entre bloques vecinos; funcionan mejor los disparadores positivos
con una sola excepción explícita.

**Pendiente menor:** Eleva Salud entrega ubicación pero no es agendable por el agente (se coordina
con el centro directamente); confirmar con Francisco que el bloque diga eso si alguien intenta
tomar hora ahí.

### Eleva Salud: dejar de ofrecer hora donde Francisco no controla la agenda · 09-09-2026

Pedir hora en Eleva Salud caía en `catalog_not_found` —un error pensado para "falta un dato"— así
que el agente seguía pidiéndole servicio y fecha al cliente como si la hora fuera posible, y recién
chocaba después. La peor versión de eso es prometer un cupo que no puede existir.

Tres arreglos, en orden de cuánto movieron la aguja:

1. **Sede no agendable → redirección explícita.** Si TODOS los servicios de una sede están marcados
   `bookable: false`, `get_availability` devuelve `not_bookable_here` con la nota de redirección en
   vez del error genérico. Sirve para cualquier cliente con una sede administrada por un tercero.
2. **El prompt lista los no agendables en su propia sección**, no mezclados entre los agendables con
   una nota al lado — mismo criterio que ya usaba la página pública de reservas.
3. **El caso terco se resolvió con una respuesta literal.** Ni (1) ni (2) evitaron que ante "quiero
   agendar en Eleva Salud" (sin fecha) el modelo pidiera la fecha igual: **0/3 en ambos intentos**,
   porque sin fecha nunca llega a llamar la herramienta. Se agregó el bloque
   `agendar_en_eleva_salud`, y el `when` tuvo que decir explícitamente "aunque ya sepas que no se
   agenda, NO redactes tú la respuesta: usa ésta" — sin esa frase el modelo redactaba una respuesta
   correcta pero sin la dirección ni el "coordínalo con ellos". Con ella, 8/8.

**Lección que se repite hoy:** cuando el comportamiento tiene que ser exacto, el prompt no alcanza;
lo que funciona es que el modelo sólo DECIDA y el runtime garantice el texto. Es el mismo patrón de
las respuestas literales.

**Medición final: 26/26** — los nueve bloques literales con sus variaciones, más las conversaciones
que NO deben disparar ninguno (saludo, relato de dolor, disponibilidad real, derivación, urgencia,
cobertura a domicilio).

### Análisis de la primera semana real (08-09 22:04 → 11-09) · 11-09-2026

Francisco reportó que el bot "le hace handoff a cada rato con un me duele el cuello". Se leyeron
las 72 conversaciones completas (Supabase `za_conversation_messages` con `tool_trace` + Zavu
`/v1/conversations`) y los 788 eventos de webhook. **Sólo análisis, nada cambiado todavía.**
Datos crudos y script de lectura en el scratchpad de la sesión (no versionado).

**Números:** ~100 respuestas del bot; **2 reservas de punta a punta** (Constanza Campos, atendida
el 11-09 17:00 y feliz; Camilo Arenas, lunes 14-09 18:00) — las dos en conversaciones SIN
derivación. **20 derivaciones reales** por WhatsApp; descontando a Daniel y a la señora de
Francisco quedan 18, y **~9 eran pacientes comunes con dolor** que el bot debió llevar a hora:
"dolor de cuello y espalda" + "Siii", lordosis post-operación (2 tickets), lupus, "camino más
agachada", **"requiero ajuste completo"** (pedía hora explícitamente), "problemas a la columna",
"espalda, cervical y brazos", "cuello y cadera, tengo 43, soy joven", paciente que pide domicilio
para su hijo. Justificadas: Peñaflor fuera de zona, dedos dormidos (según la regla actual), el
bromista del "mes completo", Tania de Eleva mandando agenda, una colega derivando paciente, y el
domicilio que Francisco ya coordinaba. Varios de los derivados terminaron agendando igual, con
Francisco haciendo a mano la indagación que era pega del bot.

**Causa raíz de la sobre-derivación (en `agent-package.json` del repo real):**
1. El `system_prompt` abre con "PRIMERO, ANTES DE CUALQUIER OTRA COSA… Ninguna otra instrucción de
   este prompt aplica antes que esta" y lista "dolor que se irradia" — con esa prioridad máxima el
   modelo lee "brazos", "cadera y pierna", "hernia", "operación" o "lupus" como urgencia.
2. La descripción de `request_human_handoff` dice "cuando… hay un problema real": para el modelo,
   todo paciente con dolor tiene un problema real.
3. `confirmed_facts[0]` todavía dice "habla en primera persona como el profesional (Francisco…)",
   contradiciendo IDENTIDAD, y repite la regla de urgencia por segunda vez.
4. Después de indagar no hay una salida de acción explícita (llamar `get_availability` y ofrecer
   hora): el modelo elige entre "ofrecer evaluación" y "derivar", y deriva la mayoría de las veces.
5. La derivación deja la conversación en `handoff` 12 h: el paciente que después pregunta precio o
   días (Ariana 4 veces, Angela, César, "~") no recibe respuesta si Francisco no contesta.

**Otros defectos observados en real:**
- **Historial con huecos:** Francisco contesta desde su teléfono y Zavu no lo ve, así que el
  historial que recibe el modelo tiene preguntas "sin responder". Bele escribe "Ya llegué" y el bot
  le manda el bloque de precios (contestando su pregunta de la noche anterior, que Francisco ya
  respondió). A Constanza le contestó la dirección que pidió la noche anterior.
- **Respuestas dobles:** 6 casos (Coté, César, Gloria, Marcela Rojas, Camilo, "~"). El debounce de
  7 s cubre sólo el 34 % de las pausas reales entre líneas de un mismo paciente (mediana 12 s;
  20 s cubre 67 %, 30 s cubre 78 %). Además no se re-chequea "llegó otro mensaje" justo antes de
  enviar, y la generación tarda 5-13 s.
- **Literales mal disparados:** "Ya llegué" → precios; "tengo hernias, ¿se puede quiropráctico?"
  → precios; "prefiero evaluación en el box Buin" → precios (debía buscar hora); "¿tú ves dolor
  crónico?" y "queremos sesión de quiropráctico" → cómo es la sesión. Y como el literal corta el
  turno, las otras partes de la pregunta se pierden (Claudia: duración/hasta qué hora; Constanza:
  medios de pago).
- **Audios e imágenes descartados en silencio:** 23 audios y 13 imágenes desde la activación caen
  en `no_text_or_sender` — ni respuesta ni registro en la consola (Paciente Gloria Galaz mandó 4
  audios el 11-09).
- **Falso positivo del guard de mutaciones:** Gloria pregunta "¿anda en Santiago?" y recibe "No pude
  confirmar esa operación de forma segura. No hice cambios en tu reserva." — el texto de respaldo
  es el mismo para cualquier herramienta bloqueada.
- **Contactos personales:** su familia recibe "este mensaje parece ser una coordinación personal…
  puedo avisarle al equipo" (Natali Figueroa, cuota de Papudo). Suena a robot con la familia.
- **SMS de derivación:** 20 enviados en 3 días; **saldo Zavu US$1,09** del crédito mensual de US$2
  (leído por `/v1/balance` el 11-09). Al ritmo actual se acaba en 2-3 días y los avisos dejan de
  llegar. El SMS dice "un cliente pide hablar contigo" aunque el cliente no lo pidió, con un
  fragmento inútil ("Soy joven", "Siii"); dos tickets duplicados cobraron dos SMS; y el `reason`
  que pasa el modelo no se guarda (todos dicen "Derivación automática del agente").
- **Francisco usa la pausa global como herramienta de trabajo:** 4 pausas, la más larga
  10-09 15:51 → 11-09 08:03 (~16 h); 185 mensajes cayeron en pausa. **Al cierre del análisis el
  bot está PAUSADO** (`za_agent_controls.updated_at` 11-09 15:58 hora Chile).

### Francisco define la regla: el agente es comercial, no un triaje · 12-09-2026

Francisco contestó el análisis de arriba y su respuesta cambia el criterio de raíz — **la
intervención suya no depende de la gravedad del caso, sino del nivel de duda del paciente**:

- **Ante cualquier cuadro, el agente avanza la conversación** con sus tres preguntas (hace cuánto
  está con el dolor, si tiene diagnóstico médico o exámenes de imagen, si hizo algún tratamiento
  antes) y remata con "Francisco prefiere no aventurarse a darte un diagnóstico y prefiere
  evaluarte, ¿quieres que veamos una hora?". Textual suyo: esas preguntas "ponen al paciente en
  contexto de que necesita el tratamiento", y el remate "lleva al paciente a que tome la decisión".
- **Cuando entra él es porque el paciente duda del tratamiento**, no porque el caso sea grave: ahí
  manda un audio explicando qué cree que tiene y cómo tratarlo, y cierra la venta agendando. De ahí
  que la opción intermedia (avisarle sin dejar de atender) sea la adecuada para todos los casos.
- **Las urgencias no cancelan la venta.** Daniel lo dejó explícito: existirán urgencias donde el
  agente puede sugerir ir a urgencia, pero eso no quita que siga llevando al cierre de la hora.
- **Audios: no se toca nada.** Está siempre atento a su WhatsApp y los escucha él.
- **No va a usar la consola, y no es un problema de costumbre:** responde manejando o con su bebé
  en brazos, y desde hace un tiempo dicta los mensajes por micrófono en vez de escribirlos. Entrar
  a la app por cada mensaje no le sirve. Todo lo que se diseñe asumiendo que él entra a la consola
  está muerto de antemano: los avisos tienen que llegar con el número del paciente para que abra el
  chat de un toque, y el agente no puede quedarse esperando que él "tome" la conversación ahí.

### Curación implementada y medida · 12-09-2026

Medido con los casos REALES de la semana (26 conversaciones reconstruidas, 3 repeticiones cada una,
contra gpt-4o-mini y el Supabase real; a nivel de engine, sin crear tickets ni mandar SMS):
**la versión desplegada daba 16/26 y la nueva da 71/78**. Los 16 casos clínicos que la semana
pasada terminaban en derivación ahora no derivan ni una sola vez.

- **Dos herramientas en vez de una.** `request_human_handoff` (calla al agente en ese hilo) queda
  sólo para tres casos: pide hablar con una persona, tema ajeno/de un tercero, o algo fuera de lo
  que el negocio cumple. La nueva `avisar_al_dueno` avisa sin interrumpir la atención — es la
  opción intermedia que pidió Francisco. Mientras hubo una sola herramienta descrita como "cuando
  hay un problema real", el modelo la usaba con cualquier paciente con dolor.
- **El prompt del paquete pasó a ser el método comercial** (y quedó más corto: 503 → ~400
  palabras). Se eliminó el bloque "PRIMERO, ANTES DE CUALQUIER OTRA COSA… ninguna otra instrucción
  aplica antes que esta" y el `confirmed_facts[0]` que todavía mandaba hablar en primera persona
  como Francisco. Los disparadores de herramienta quedaron POSITIVOS ("pide hablar con una
  persona → llama la de traspaso"), no como prohibiciones.
- **Lección repetida, medida otra vez:** la primera versión del prompt nuevo era larga y correcta,
  y **apagó el tool-calling** — los bloques literales dejaron de dispararse (el de precios cayó a
  0/1) y el traspaso legítimo también. Lo mismo pasó con una línea que agregué a `AGENDA_BEHAVIOR`
  ("nunca cierres un mensaje sin próximo paso"): con ella, el bloque respiratorio fallaba 3/3 y el
  agente redactaba el precio a mano — una vez incluso mal ($36.000 + $6.000). Reescrita para ceder
  el paso a las respuestas oficiales, volvió a 3/3.
- **El aviso al dueño se ejecuta, no se anuncia.** El modelo escribía "voy a avisar a Francisco"
  sin llamar la herramienta, 3 de 3 veces. Se resolvió por los dos lados: el prompt dice que
  decirlo no avisa a nadie, y `validateMutationClaims` ahora también bloquea la promesa en futuro
  (antes sólo cazaba la afirmación en pasado). Con eso, 3/3 llamando la herramienta.
- **El SMS ahora dice con quién hablar:** nombre y número del paciente primero, el motivo real que
  dio el modelo después, y el link a la consola al final (antes decía "un cliente pide hablar
  contigo" con un fragmento inútil y el link primero). Un solo aviso por contacto por hora
  (`OWNER_ALERT_DEDUPE_MINUTES`), que era lo que cobraba dos SMS por el mismo caso.
- **El motivo del modelo se guarda en el ticket.** Todos decían "Derivación automática del
  agente", así que la Bandeja no servía para entender por qué derivó.
- **Respuestas dobles:** espera de 7 s → 20 s (`INBOUND_DEBOUNCE_MS`), y se agregó un segundo
  chequeo de "llegó otro mensaje" DESPUÉS de generar la respuesta, que es donde se colaban (el LLM
  se demora 5-15 s más).
- **Historial con huecos:** `loadConversationHistory` marca con una nota de sistema los mensajes
  del cliente que quedaron sin respuesta y tienen más de 15 min (`OWNER_HANDLED_AFTER_MS`), para
  que el agente no conteste preguntas que Francisco ya resolvió por teléfono — el caso de "ya
  llegué" contestado con la lista de precios.
- **Mensaje de error por herramienta:** el "no hice cambios en tu reserva" ya no sale cuando lo
  bloqueado era un aviso ("todavía no dejé ese aviso, ¿quieres que le pida al equipo que te
  escriba?").
- **Quedan 2 casos medidos que NO se logran** (el texto que manda es correcto, pero no dispara la
  herramienta): domicilio fuera de zona (Peñaflor) declina y ofrece Box Buin, pero no avisa a
  Francisco — se pierde el dato de un lead que quizás pagaría el traslado; y el mensaje de Tania de
  Eleva mandando la agenda se trata como si fuera una paciente (ese contacto está silenciado en
  producción, así que hoy no tiene efecto). Los dos siguen en la batería como fallas conocidas.
- **Lo que NO se tocó, por decisión de Francisco:** los audios (los escucha él) y cualquier flujo
  que dependa de que entre a la consola.

**Sigue pendiente:** el eco de coexistencia de Meta/Zavu (única vía para que el agente se calle
solo cuando Francisco responde desde su teléfono — quedó esperando su captura de
business.facebook.com), el crédito de SMS (Daniel lo deja así y evalúa pasar los avisos a correo
cuando Francisco tenga tiempo), y que **Studio no puede regenerar este paquete**: su Supabase
(`nbjujqodjvhbxvvlfdfs`) sigue caído, así que el prompt corregido vive en el repo desplegado y en
`runtime-template/`. Si algún día Studio vuelve, hay que subirle esta versión antes de rebuildear.

### Silencio deliberado + links de acción en el SMS · 12-09-2026 (mismo día, después de lo anterior)

Las dos piezas del mismo problema: **el dueño contesta desde su propio WhatsApp y el canal no nos
entrega esos mensajes**. Todo desplegado y verificado en `franciskom.cl` real.

**1. El agente puede elegir no responder** (`no_intervenir`, genérico para la línea). La decisión
la toma el modelo, pero **el permiso lo da el runtime**: la herramienta sólo se le ofrece cuando el
historial trae la nota de mensajes del cliente que quedaron sin responder y con rato encima
(`historyAllowsSilence`) — o sea, un hilo que alguien más está atendiendo. En una conversación
nueva o en una que el propio agente está llevando, la herramienta no existe, porque callarse ahí
sería perder al cliente. Medido, 3 corridas por caso: **9/9** en las formas que lo delatan ("ya
llegué", "sí, a las 15 me acomoda", "gracias, nos vemos el jueves") y **15/15** en las que SÍ debe
responder (pregunta nueva concreta, pedir otra hora, lead nuevo).
- La nota de historial tuvo que decir explícitamente qué hacer: con la versión que sólo decía "no
  respondas eso", el silencio salía 1/9. Nombrando las formas ("responde algo que tú no dijiste,
  agradece, o acepta una hora/fecha/precio que tú no ofreciste") subió a 5/9, y lo que cerró el
  caso más terco ("sí, a las 15 me acomoda", 0/3) fue una excepción puntual en `AGENDA_BEHAVIOR`:
  con esa nota presente, no consultar disponibilidad por una hora que el agente no ofreció —
  ofrecerle otros horarios contradice lo que Francisco ya le dijo.

**2. El SMS de aviso lleva un link de un toque** (`za_action_tokens` + `owner-actions.js` +
ruta `/t/<token>`). Abre una pantalla con ESE paciente —nombre, teléfono, su último mensaje— y
tres botones: **abrir su WhatsApp** (`wa.me`, que es su flujo real), **yo sigo esta conversación**
(el agente se calla en ese hilo, con el retorno automático de 12 h que ya existía) y **no
contestarle más a esta persona** (`bot_muted`), más el reverso de cada una. Sin PIN.
- **Abrir el link no ejecuta nada**: los previsualizadores de WhatsApp y los filtros de SMS abren
  las URLs por su cuenta, así que una acción en el GET habría silenciado contactos sin que nadie
  la pidiera. Verificado en vivo: tras un GET, el token sigue sin acción registrada. Cada acción es
  un POST de un botón.
- Token aleatorio de 16 caracteres en tabla (no firmado) para que el SMS quepa en **un segmento de
  160**: con el motivo del modelo recortado en límite de palabra, el aviso completo mide 154-160
  caracteres. Antes el motivo llevaba el prefijo de la Bandeja y se iba a 2 segmentos (doble cobro).
- **Zavu tiene `franciskom.cl` aprobada por `domain_whitelist`**, así que cualquier ruta del
  dominio pasa por SMS — no hay que verificar el link nuevo. Si igual fuera rechazado, el aviso
  sale sin link (ya estaba).
- Verificado en el navegador real, PC y móvil (375px), local y después en producción: las cuatro
  acciones escriben lo que corresponde en Supabase, la pantalla refleja el estado, un token
  inexistente da 404 con mensaje legible, y al borrar los datos de prueba el link degrada bien.
  Datos de prueba (`+56900000099`, "PRUEBA Link de acción") creados y borrados en la misma sesión.

**Lo que esto cierra:** Francisco ya no necesita la pausa global para meterse con un paciente (era
lo que lo dejaba mudo 16 horas), y el aviso dejó de decirle "entra a tu consola" — que es
exactamente lo que él dijo que no iba a hacer nunca.

### Mensaje real perdido: el webhook se pasaba del límite de Zavu · 12-09-2026 (mismo día, incidente real)

Francisco mandó captura de una conversación donde el bot **no respondió del todo** a una paciente
(Guicela) que preguntaba por hora — y Francisco tuvo que meterse a mano, sin las preguntas del
método comercial. Se investigó a fondo antes de tocar nada.

**Causa confirmada (no es la herramienta de silencio nueva — ese día se activó bien, en otra
conversación):** el 3er mensaje de Guicela quedó con su evento de `za_webhook_events` trabado en
`processing` para siempre — **nunca se guardó en nuestro propio historial ni se generó respuesta**.
Zavu documenta explícito ("webhook-setup" skill): *"Return 200 quickly — respond within 30
seconds, process async"*. El webhook de este runtime bloqueaba la respuesta HTTP durante TODO el
`debounce` (subido hoy mismo de 7 a 20 s, ver entrada de arriba) más 5-15 s de generación del LLM —
podía pasarse fácil de los 30 s. No se pudo confirmar el mecanismo exacto por Vercel (los logs de
esa invocación puntual ya no estaban disponibles vía API), pero la evidencia (mensaje nunca ni
siquiera guardado, sin reintento posterior) apunta ahí con fuerza.

**Dos fixes, ninguno agrega costo de infraestructura (importante: a Francisco no se le cobra
mantención por eso, así que nada de crons nuevos ni servicios extra):**
1. **Debounce 20 s → 12 s** — sigue cubriendo la mitad de las pausas reales entre mensajes seguidos
   de un mismo cliente, con más margen bajo el límite de Zavu.
2. **Red de recuperación**, corre dentro del cron horario que ya existía (cero llamadas nuevas a
   Vercel): el webhook ahora guarda el mensaje crudo (teléfono, texto, nombre) apenas lo valida,
   ANTES de seguir — así si el resto del turno no termina, queda todo lo necesario para
   terminarlo después. El cron busca eventos trabados en `processing` con el lease vencido, los
   vuelve a tomar con la MISMA función atómica que usa el tráfico real (si Zavu también reintenta
   el mismo mensaje al mismo tiempo, sólo uno de los dos gana), y termina el trabajo: genera,
   guarda y manda la respuesta que nunca salió. Un evento que murió ANTES de guardar el mensaje
   crudo (ventana angosta) se marca `failed` en vez de quedar trabado para siempre.
   - **Deliberadamente NO se basa en "conversaciones que se ven sin contestar" desde la lista de
     Zavu** — se descartó ese diseño a propósito: Zavu no ve los mensajes que Francisco manda desde
     su propio teléfono (hueco ya documentado, 08-09-2026), así que una conversación que él ya
     atendió a mano se ve "sin contestar" para siempre del lado de Zavu. Con ese diseño, la
     recuperación le habría mandado a Guicela una respuesta duplicada del bot, horas después de que
     Francisco ya la atendió — un bug nuevo reemplazando al viejo. Sólo se reintentan eventos que
     el propio sistema empezó a procesar y no terminó.

**Verificado de punta a punta en local, sin gastar un solo mensaje real:** un evento viejo (de
antes del fix, sin el mensaje crudo guardado) se marcó `failed` limpio en vez de seguir trabado; un
evento simulado CON el mensaje crudo se volvió a tomar, reconstruyó el teléfono/texto, generó una
respuesta sensata, la guardó, e intentó mandarla — falló ahí sólo porque el ambiente de prueba
local no tenía las claves de WhatsApp a propósito. Ya en producción real, `franciskom.cl` respondió
`{checked:0, recovered:0, unrecoverable:0}` — nada atorado.

### Ronda de ventas: el agente cierra con horas reales · 14-09-2026 (desplegado, commits franciskom 2f39ce0 + f9ec81d)

**Pedido de Daniel:** la finalidad del agente es dejar la hora tomada sin intervención humana;
"tenemos un modelo potente, que sea un buen vendedor"; descuentos y planes sólo los ofrece
Francisco. Se pidió probar y reportar antes de subir — se reportó y Daniel aprobó el deploy.

**Corrección importante de mediciones anteriores:** producción corre `gpt-5.6-luna` (env
`LLM_MODEL` de Vercel), no gpt-4o-mini. Las rondas previas se midieron localmente con gpt-4o-mini.
Todo lo de esta ronda está medido con luna. Medir siempre contra el modelo de Vercel.

**Números (luna, `dryRun` = mutaciones falsas, harness `ventas.mjs`/`medir.mjs` en scratchpad):**
- Venta (casos reales: precio, domingo, "lo pienso", sin plata, pareja, hijo, domicilio, Eleva):
  código de producción anterior 8/28 → nuevo 15/15 corrida completa + 12/12 en los más difíciles.
- Regresión (no derivar por dolor, literales, silencio): 31/34, igual que antes. Fallan los mismos
  3 raros: "Ya llegué" sin historial → traspaso; paciente de Eleva preguntando su hora → la
  confunde; colega pidiendo el número → traspaso en vez de declinar.

**Qué cambió (runtime, "el modelo decide, el runtime garantiza"):**
- La respuesta literal ya no cierra el turno: sale el bloque oficial y un 2do mensaje corto con
  horas que consulta el **runtime** (`suggestedSlotsForFollowUp`, mínimo 2 horas, completa con el
  día siguiente). Precios del 2do mensaje se borran determinísticamente. Si piden domicilio, en vez
  de horas del box se pide la dirección.
- **Hora ofrecida = hora consultada en el mismo turno:** si el texto trae horas y no hubo
  `get_availability`/create/reschedule/get_my_appointment, se devuelve al modelo una vez (caso real
  medido: ante "no tengo plata" inventó "lunes 28 a las 17:00").
- `avisar_al_dueno` se rechaza si todavía no se ofrecieron horas concretas.
- Respuesta vacía de luna → reintento (antes tiraba error y el paciente quedaba sin respuesta).
- `no_intervenir`/silencio se rechaza si el mensaje trae una consulta nueva (luna se tragaba
  "¿tienes el lunes?" en hilos que Francisco había tocado).
- Horas en ventanas de riesgo (`requiere_confirmacion`) no se ofrecen primero; máx. 3 horas.
- `create_appointment` con `customer_name` (quien escribe) y `patient_name` (quien se atiende);
  Calendar lleva el nombre del paciente. Al agendar ya no se pisa el nombre con que Francisco tenía
  guardado al contacto (se agrega "Se presentó como: X" en notas).
- Prompt: vendedor del centro, objeciones → alternativa concreta y aviso después; pareja → horas
  seguidas; fuera de zona → box + aviso; nunca menciona descuentos.
- Test `hernia` del paquete tenía un `expected_behavior` viejo (fallaba ya en HEAD): actualizado a
  la regla vigente. Hecho "criterio profesional" conserva la lista de señales de urgencia.

**Verificado en vivo** (`/api/preview/chat`, luna): precio → bloque + "hoy lunes a las 16:00, o
mañana martes a las 08:00 y 18:00. ¿Cuál te dejo?"; dolor con las 3 respuestas → remate con horas.

**Pendiente conocido:** ~1 de cada 4 casos de domicilio avisa a Francisco sin que haga falta;
"en la tarde" a veces incluye una hora de la mañana; los 3 casos raros de arriba. Las pruebas
gastaron saldo de la key OpenAI de Francisco (varias decenas de corridas).

### Audios de Francisco + casos reales del 14-09: reagendar, post-agenda y direcciones · 14-09-2026 (desplegado c5baaf5)

**Lo que pidió Francisco (audios transcritos por Daniel):**
- Probar con un prompt menos rígido, y dejar que el bot se equivoque sin intervenir para medir
  errores reales (Daniel pidió permiso y Francisco aceptó).
- Idea suya: activar el mensaje de bienvenida de WhatsApp Business ("Hola, soy Francisco
  Martínez… ¿cuál sería su dolor o motivo de consulta?") para números nuevos que llegan de
  Instagram. **Pendiente verificar**: si ese saludo llega a Zavu (lo que Francisco manda desde su
  teléfono NO llega) y si la función sigue activa con coexistencia; el saludo también sale a quien
  vuelve tras ~14 días sin escribir.
- Alexis: agendó bien, pero después el bot le pidió "como cien datos" (ficha completa) y le
  preguntó "¿a qué te refieres con que no has tenido lesiones importantes?". Francisco: "si ya está
  agendado, lo demás sobra; es como hacerle la anamnesis por WhatsApp".
- Un paciente coordinado por teléfono mandó su dirección y el bot la tomó como nombre (en la base es
  Rodolfo: "Eduardo Ríos Mackenna 1544" → "¿Cuál te dejo para Eduardo Ríos?").

**Reglas confirmadas por Daniel:** después de agendar el bot no se vuelve a meter (no silencio
total: atiende pedidos concretos, calla ante "llegué/gracias/datos"); ficha = RUT, correo, nombre
(teléfono ya está); reagendar "imposible que falle" (mirar Rishtedar); una dirección nunca es un
nombre; prompt nuevo limpio en vez de parches.

**Caso grave encontrado leyendo Supabase (no lo mencionó Francisco):** Camilo Arenas pidió a las
16:17 mover su hora de las 18:00. El 1er intento falló con "ocupado en Google Calendar" (causa más
probable: el modelo mandaba ISO con offset calculado por él, y Chile cambió a -03:00 el 06-09), el
2do con "No encontré esa reserva" (la referencia no sobrevive entre turnos: el historial guarda
texto, no resultados de herramientas) y el aviso prometido se reemplazó por "Todavía no dejé ese
aviso". Nadie se enteró. Pasó con la versión desplegada esa madrugada.

**Qué se cambió (patrón Rishtedar `reschedule_reservation`):**
- `reschedule_appointment`/`cancel_appointment` resuelven la reserva por el teléfono verificado si
  la referencia falta o no calza (`listUpcomingAppointmentsForPhone`, consulta liviana nueva en
  agenda.js). Reciben `date` + `time` local (no ISO); `create_appointment` igual.
- Antes de escribir, la hora nueva se verifica contra `getAvailableSlots`; si no se puede, la
  respuesta trae `original_unchanged: true` + `alternativas_mismo_dia` reales. Error técnico (no de
  disponibilidad) → `owner_alert` automático.
- Promesa de aviso sin herramienta → el runtime cumple el aviso (ownerAlert) en vez de retractarse.
- Reserva próxima (≤3 h de gracia) → nota de sistema "venta cerrada", `no_intervenir` habilitado,
  sin seguimiento de horas tras un literal, aviso al dueño sin exigir oferta previa.
- Ficha post-agenda: sólo RUT y correo faltantes, una vez. `update_customer_profile` sólo guarda eso.
- Crear/cambiar exige que la hora esté en el mensaje del cliente o en el último mensaje del agente
  (`hourChosenByClient`); nombres con dígitos o forma de calle se rechazan.

**Verificación:** reagendar contra la agenda real con reserva de prueba insertada directo en la
base (sin Calendar ni SMS) y borrada al final: 8/8. Conversaciones post-agenda con luna (Alexis,
Camilo, Rodolfo, ficha): 18/18 en fk. Ventas 15/15. Regresión 29/34 (diferencias de redacción en
casos "declina" y los raros de siempre). Smoke en vivo OK. Harnesses nuevos en scratchpad:
`fixture_reagendar.mjs`, `probar_reagendar.mjs`, `postventa.mjs`, `fluidez.mjs`.
**Ojo al probar:** la plantilla (`runtime-template/agent-package.json`) NO tiene los literales de
Francisco; toda medición de comportamiento va contra el clon de franciskom.

### Prompt limpio + ritmo de venta "cercanía primero" · 14-09-2026 (desplegado cdde1a8)

**Pedido:** Francisco dio permiso para menos rigidez; Daniel pidió reescribir desde cero en vez de
parchar. Después de ver el primer resultado (el bot casi dejó de indagar), Daniel describió cómo
conversa Francisco: aunque le pregunten sólo el valor o la ubicación, indaga un poco sin ser
entrometido y después ofrece agenda — "generar cercanía para después devolver el golpe con un
agendamiento real". Regla confirmada con ejemplo:
- Pregunta seca (valor/ubicación/horario) sin contar qué le pasa → respuesta + UNA pregunta cercana
  ("Cuéntame, ¿qué te está molestando?"), sin horas.
- Cuenta su dolor → como mucho una pregunta por lo que falte (ninguna si ya lo contó todo).
- Mensaje siguiente → remate con horas reales.
- Pide hora directo, o no contesta la pregunta → horas altiro. Nunca más de dos mensajes sin horas.

**Prompt (agent-package de franciskom):** `system_prompt`, `role`, `tone_policy` y el hecho
"criterio profesional" reescritos; todas las reglas que funcionaban siguen (dichas una vez). Se
quitó a propósito "sin relleno empático" y la lista larga de dolores. `horario_atencion` y
`tratamiento_respiratorio` pasaron de literal a conocimiento; `como_es_la_sesion` lleva `match`
(sólo si preguntan cómo es, nunca con algo respiratorio). `AGENDA_BEHAVIOR` (compartido) más corto:
salió lo que el runtime garantiza. Prompt: 16,7k → ~13k caracteres, prohibiciones 118 → ~76.

**Garantías de runtime nuevas (engine.js):** pregunta antes de horas en el primer relato de dolor sin
detalles (`firstPainNow`, exento si responde a un pedido de datos); horas en vez de otra pregunta
cuando ya toca (`offerDue`); cierres que piden permiso ("¿te busco/te dejo/te gustaría tomar una
hora?", "puedo buscarte") o posponen ("cuando tengas…") se devuelven una vez; "¿te refieres a…?" se
devuelve una vez; un literal se manda una vez por conversación; literal con `match` que no calza →
`not_asked`; id de literal inexistente → `unknown_reply` (antes decía "ya se enviaron" y el modelo
terminaba en "no tengo ese dato"); el seguimiento de un literal con horas consultadas no puede salir
sin horas; tras un literal seco sin dolor, el seguimiento es la pregunta cercana.

**Medido (luna, clon fk2):** fluidez 29/30 (+ el fallo corregido 4/4), ventas 28/30 (los 2 de
domicilio corregidos, 8/8), post-agenda 9/9, regresión 31/34. En vivo: "Hola, valor?" → precios +
"Cuéntame, ¿qué te está molestando…?" → "Me duele la espalda baja" → "¿Hace cuánto te duele la
espalda baja?" → "hace como 2 meses" → remate con 3 horas reales.
**Menores conocidos:** tras la ubicación a veces agrega "el box queda en El Recurso" (repite parte
del bloque); sobre-aviso ocasional en domicilio. **Pendiente:** probar si el saludo automático de
WhatsApp Business llega a Zavu (necesita que Francisco lo active); semana sin intervención de
Francisco para medir errores reales.

### Revisión 1er día con los cambios (14-09 19:00 → 15-09 14:20) · 15-09-2026 — sin tocar código

Daniel le dijo a Francisco "déjalo que la cague, después parchas": semana de observar. Bot no pausado.
El bot habló en 6 conversaciones; silenciados/traspasados respetados.
- **Bien:** Esteban Cares (pide última hora de hoy → ofrece 18:30/19:00 → pide 20:00 → "la última es
  19:00, ¿te la dejo?" → agenda, pide sólo RUT/correo, calla después). Elenis: precio → pregunta
  cercana ✓; ante "tengo hernias, consultaré con el médico" responde bien y ofrece horas.
- **Carolina Pereda:** "Hola Francisco bien y tu??" (le contesta a Francisco, invisible para Zavu) →
  pide mover a martes → bot ofrece 22-09 → elige 19:00 → `not_found` (su hora no está en nuestra
  agenda) → sin aviso → ella "jajaja si caché, tranqui, nos vemos el martes" → bot "Perfecto, nos
  vemos el martes". Daniel sospecha, y las señales lo apoyan, que Francisco la coordinó por fuera.
  Confirmar con Francisco que quedó el martes 22 19:00.
- **Parches pendientes (acumular para fin de semana, esperar insight de Francisco):**
  1. reschedule/cancel `not_found` → owner_alert automático con lo pedido; nunca confirmar el cambio.
  2. "Ok / gracias" a la pregunta cercana → ofrecer horas (el nudge sólo detectaba otra pregunta, no
     despedidas tipo "si necesitas una hora, escríbeme").
  3. `customer_name` de relleno ("No confirmado") → usar el nombre guardado o pedirlo (quedó "Se
     presentó como: No confirmado" en la reserva de Esteban).
  4. Contacto personal (Valentina Pradenas Contadora, versión previa al prompt nuevo): el bot le
     contestó como si fuera Francisco ("me salió demasiado formalito 😅").
- Francisco no ha usado ningún link de acción del SMS; 0 avisos generados desde el 14-09 19:00.

### "Sesión", nunca "evaluación" · 15-09-2026 (desplegado fe1a2de)

Feedback de Francisco: la gente se confunde cuando el bot dice que se agendó "la evaluación"; él
evalúa Y trata en la misma hora. Cambios:
- **Supabase de franciskom (en vivo):** `za_services` "Evaluación · Box Buin" → "Sesión · Box Buin",
  "Evaluación · Eleva Salud" → "Sesión · Eleva Salud" (mismos ids; reservas, Calendar futuro, consola
  y página pública toman el nombre nuevo solos). "Atención a domicilio" y las respiratorias no cambian.
- Paquete (franciskom + plantilla): config de servicios, hecho "criterio profesional", test hernia y
  regla en `system_prompt` ("lo que se agenda es una sesión… nunca 'evaluación'"). Se mantuvo la frase
  de Francisco "prefiere evaluarte" (verbo, es suya). Textos oficiales intactos ("🧩 Evaluación
  completa" es parte de lo que incluye la sesión). Script: `sesion_no_evaluacion.mjs` (scratchpad).
- `agenda-tools.js`: descripción de get_availability. `public/landing.html` (sólo franciskom): las
  etiquetas de precio "Evaluación general" → "Sesión general".
- **Ojo Studio:** su base (caída) sigue con los nombres viejos; si se regenera el paquete desde Studio
  hay que aplicar el mismo cambio.
Medido con luna: ventas 15/15, fluidez 15/15, post-agenda 9/9; ningún texto de reserva dice
"evaluación". En vivo: "Tengo mañana a las 08:00, 17:30 o 18:30 para una sesión, ¿cuál te dejo?".

### Límite de Zavu agotado + el bot ahora se calla cuando Francisco contesta a mano · 15-09-2026 (desplegado c95b769)

**Lo que pasó con el plan de Zavu:** a Francisco le llegó el aviso de que se acabaron los 2.000
mensajes gratis del mes. Investigado a fondo:
- **No fue por las pruebas de esta sesión** — todas corrieron con `dryRun` contra el modelo directo o
  `/api/preview/chat`, que nunca llaman a Zavu; confirmado además que ningún número de prueba
  aparece en las 188 conversaciones reales de la cuenta.
- **El envío ya estaba pausado en el momento de revisarlo** (`Sending is paused` en el dashboard de
  Zavu) — no era "se va a topar", ya estaba topado.
- **La cuenta real (24-08 a 15-09): 2.803 mensajes**, entrantes y salientes. Soporte de Zavu dijo
  primero que sólo cuenta lo enviado — no cuadraba (sólo 265 mensajes salientes rastreables). Contando
  ambos sentidos desde el reseteo real (1 de cada mes): **2.033 desde el 01-09**, recién por encima
  de 2.000 — coincide casi exacto con el momento del aviso.
- **Por qué el cálculo original quedó corto:** se estimó pensando en tráfico de pacientes; el número
  de Francisco es también su número personal (pareja, contadora, colegio de su hija…), y el plan
  cuenta absolutamente todo lo que pasa por ese WhatsApp. Solución: subir a Zavu Pro (US$20/mes, sin
  tope de WhatsApp) — Daniel gestiona el pago, no es algo que se automatice.

**Hallazgo mayor en el camino, con arreglo real:** al preguntarle a la IA de Zavu por los "echo" de
coexistencia, salió que lo que Francisco escribe desde su propia app de WhatsApp SÍ se reenvía a
nuestro webhook — como `message.sent` con `source: "whatsapp_business_app"` y el texto completo
(confirmado con el esquema oficial en `docs.zavu.dev/guides/receiving-messages/events`). Nuestro
código lo trataba como una confirmación de entrega genérica: como nunca calzaba con ningún mensaje
nuestro, se descartaba en silencio. Verificado en el panel de Zavu que esos eventos SÍ estaban
llegando con 200 OK — la nota del 08-09 ("cero eventos message.sent") ya no aplicaba y nadie lo
había vuelto a comprobar.

**Arreglado en dos partes:**
1. `zavuOwnerEcho()` (zavu.js) distingue el eco de un envío nuestro; se revisa ANTES del callback
   genérico de entrega en el webhook. El eco se guarda como mensaje saliente real
   (`sender_type: 'human'`) en la conversación del cliente — el agente ve de verdad lo que Francisco
   dijo, no lo adivina por el tiempo transcurrido (mecanismo viejo, `OWNER_HANDLED_NOTE` a los 15 min,
   sigue como respaldo).
2. **El bot se calla de verdad para ese hilo:** al llegar el primer eco de una conversación, se marca
   `status: 'handoff'` — el mismo mecanismo que ya usa el botón "tomar" de la consola, que hace que el
   webhook de mensajes entrantes ni llame al modelo. `reclaimStaleHandoff` (ya existía, miraba el
   último mensaje humano saliente) ahora por fin tiene datos reales que mirar, y devuelve el hilo al
   bot solo a las `HANDOFF_AUTO_RETURN_HOURS` (12h por defecto) desde el último mensaje real de
   Francisco ahí.

**Verificado:** 10/10 pruebas internas, parser probado contra el payload oficial de Zavu. El primer
eco real posterior al deploy todavía no se ha dado (queda por confirmar en vivo con el próximo
mensaje que Francisco mande a mano).

## Cobro de Meta por WhatsApp · 01-10-2026

Cambio externo que afecta el costo de operar todos los agentes. Fuente: ebook de Vambe
(septiembre 2026, basado en documentación de Meta), contrastado con otras guías del mercado
(ContactShip, Wasapi, Courier, Twinny, Respond.io). La versión de la documentación oficial de Meta
que se pudo recuperar es anterior a septiembre y no menciona el cobro de servicio, así que no está
confirmado directamente contra Meta; Meta puede cambiar tarifas hasta cuatro veces al año.

**Qué cambió:**
- Los mensajes libres que el agente envía dentro de la ventana de 24 h ("mensajes de servicio")
  pasaron de gratis a cobrarse. Meta da **1.000 gratis por número de teléfono por mes** (no se
  acumulan); desde el mensaje 1.001 se cobra.
- Las **plantillas de utilidad** (recordatorios, confirmaciones) enviadas dentro de la ventana
  también se cobran, desde la primera. El cupo de 1.000 es solo para mensajes de servicio.
- Marketing y autenticación se cobraban siempre. Lo que escribe el cliente nunca se cobra.
- **Chile: US$0,02 por mensaje entregado** (servicio = utilidad = autenticación); marketing
  US$0,0889. Sin descuentos por volumen en servicio. Da igual quién responde (humano o IA) y cambiar
  de proveedor (Zavu u otro) no evita el cobro.
- La ventana de 24 h la abre solo el cliente. Anuncios Click-to-WhatsApp: ventana gratuita de 72 h
  de cualquier categoría, que arranca cuando el negocio responde dentro de las 24 h y solo si el
  cliente escribió desde la app móvil.
- **Método de pago:** Meta exige uno registrado en la cuenta de WhatsApp Business. Sin él, entrega
  los primeros 1.000 mensajes de servicio del mes y deja de entregar los siguientes.

**Consecuencias para este proyecto:**
1. En toda cotización el costo de WhatsApp se expresa como **variable**: US$0,02 por mensaje
   enviado sobre los 1.000 gratis al mes por número. Ejemplo: 3.000 mensajes al mes ≈ US$40.
2. Diseñar prompts y flujos para **minimizar mensajes enviados**: pedir todos los datos en una frase,
   no repetir confirmaciones, juntar respuestas. Cada mensaje ahorrado es ahorro directo.
3. Los recordatorios y confirmaciones (nivel B de la cotización de Brimed) son plantillas de
   utilidad y tienen costo propio. Un canal sin cobro de Meta (correo) puede ser alternativa.
4. **Pendiente de verificar:** estado del método de pago en la cuenta WhatsApp de franciskom (estaba
   `setupStatus: NOT_STARTED` el 14-09) y de Rishtedar. Y si Zavu traspasa el cobro de Meta tal cual
   o agrega recargo (no verificado).

Archivos de apoyo, fuera del repo: `C:\proyectos\cotizaciones\referencias\` (PDF original, su
texto y una guía para explicárselo a clientes).

## Revisión a fondo de franciskom + blindaje estilo Rishi · 08-10-2026

**Por qué:** revisión de todas las conversaciones atendidas por el bot (71): 17 % correctas,
32 graves, 4 dañinas. Francisco no paga (Meta, Zavu ni a Daniel) mientras el bot no funcione bien.
El informe completo, con datos de pacientes, quedó fuera del repo, en el scratchpad de la sesión
(`revision/INFORME_CONSOLIDADO.md`).

**Causas raíz encontradas:**
1. Los ecos de Francisco (lo que contesta desde su WhatsApp) **no llegan desde Zavu desde el
   24-08**: el panel de Zavu muestra "WhatsApp Business App Sync: Not synced". Sin ecos, el bot no
   sabe qué hilos lleva Francisco y le contesta a sus amigos y pacientes en curso. **Es el
   bloqueante principal y sigue abierto** (pendiente preguntarle a Zavu; no apretar "Sync" sin
   decisión de Daniel: puede importar historial, gastar cuota y requiere aprobación en el
   teléfono de Francisco).
2. Hechos guardados como prosa en el paquete: una regla interna ("el agente no debe confirmar…")
   le llegó textual a un paciente.
3. El runtime anulaba el `no_intervenir` del modelo cuando el mensaje traía "?".
4. El modelo calculaba los días de la semana ("mañana viernes" dicho un miércoles).
5. Bugs de cableado: el reclaim de handoff no leía `updated_at` (28 hilos pegados en handoff),
   414 audios, imágenes y stickers descartados sin guardarse, y el segundo bloque oficial nunca
   salía.

**Qué se hizo (commits 334be74 y f72bcd4 en github.com/dgonzaleztagle-hub/franciskom, desplegados,
y el mismo código en `runtime-template/`):**
- `za_knowledge_facts` (migración `20261008_knowledge_facts.sql`, aplicada en franciskom) con
  `visibility` public/internal. Si tiene filas, es la ÚNICA fuente de hechos. Los internos van en un
  bloque aparte y una guarda de salida bloquea cualquier borrador que los cite. Sembrados 11 hechos
  (3 internos). También se corrigió `za_business_data` ("evaluación" → "sesión", se desactivó el
  horario parcial) y se sacó la mención de planes con descuento de `za_business_info`; los planes
  quedan como hecho público: "los conversa Francisco".
- `src/turn-guards.js`: compuerta de cortesía (ok/gracias/igualmente/despedidas sin oferta
  pendiente → silencio; un saludo o primer contacto siempre se contesta), guarda de filtración,
  frases repetidas eliminadas, "mañana <día>" corregido, tabla de próximos días en el prompt y
  `dia` resuelto en código en `get_availability`.
- `get_availability.fuera_de`: los horarios que el cliente no puede se filtran en código (con la
  regla solo en el prompt, luna los ignoraba 2 de cada 3 veces).
- `responder_textual.ademas`: precio y ubicación en el mismo turno.
- Cualquier eco del dueño (texto, audio, sticker, imagen) silencia el hilo 12 h. El reclaim cuenta
  desde lo más reciente entre el último mensaje del dueño y el paso a handoff.
- Audios e imágenes entrantes se guardan como "[audio]"/"[imagen]". La respuesta fija ("no puedo
  escuchar audios…") se envía solo donde el bot lleva el hilo.
- Reentregas tardías de Zavu detectadas con `data.providerTimestamp`. OJO: el `timestamp` del sobre
  es la hora de despacho, no sirve para esto.
- Cambio o cancelación de una hora que no está en el sistema (agendada por fuera) → aviso
  automático al dueño. Antes el bot decía "no aparece tu reserva" y no avisaba a nadie.

**Cómo se verificó:** un banco de replay con 13 casos reales, corrido 2 veces cada uno contra la BD
real en `dryRun` (las herramientas que escriben se simulan), con el mismo modelo de producción
(gpt-5.6-luna): todo pasa. El script está en el scratchpad de la sesión
(`tools/replay.mjs`, tiene textos de pacientes y no va al repo). npm test y test:zavu-delivery
también pasan.

**No verificado todavía:**
- Las consolas PC y móvil en el navegador real: piden PIN y no corresponde que Claude lo ingrese.
- Tráfico real posterior al deploy.

**Pendientes, en orden:**
1. Ecos de Zavu (bloqueante).
2. SMS de alertas al dueño: 15 de 35 no llegaron; investigar al final, por decisión de Daniel.
3. Cuota gratis de Zavu: 2.000 mensajes al mes incluyendo los entrantes, se agota cerca del
   16-20 de octubre.
4. Pasar `literal_replies` a la BD.
5. Drift de `agent.name` en `runtime-template/agent-package.json`.

### Actualización 08-10-2026 (tarde): despliegues posteriores, ecos, SMS y cuota

- **Desplegado en franciskom:** `9326cb5` (emoji suelto ya no se contesta; `reactionOnly` en la compuerta de cortesía) y `7f56de7` (alertas SMS al dueño: solo `Atencion: <nombre> <telefono> necesita que lo atiendas.`, sin acentos, sin link ni motivo, 1 segmento; `toGsmSafe` en `sendZavuAlert` limpia cualquier SMS a GSM-7 y corta a 160). Antes las alertas eran Unicode de 3 segmentos (US$0,084) y no había entrega confirmada desde el 14-09 (37 SMS: 21 delivered, 13 failed, 3 sending).
- **Cuota Zavu (corregido con el panel):** el plan Free cuenta TODO lo que entra y sale, no solo lo enviado. Foto del 08-10: 834/2.000 (769 recibidos, 65 enviados), casi todo tráfico personal de Francisco en coexistencia. Ritmo ~104/día: tope hacia el 19-20 de octubre. Qué hace Zavu al llegar al tope no está confirmado (se asume que el bot queda ciego). Entra en la cotización de todo cliente en coexistencia.
- **Ecos: nunca llegaron.** La IA de Zavu dice que no dependen del Sync y que la conexión no los emite; el soporte humano no existe en Free. El silencio de 12 h por eco está construido pero inactivo. Decisión de Daniel: por ahora Francisco pausa el bot a mano desde el dashboard; no se toca el Sync sin su OK.
- **Daniel avisó a Francisco** de la cotización grupal de 10 personas (handoff de las 15:33 sin respuesta a las 16:45).
- **Pendiente (al 08-10):** revisar el tráfico real cada día para medir la tasa de conversaciones correctas (línea base 17 %); confirmar que el SMS corto llega; consolas PC/móvil (piden PIN); `literal_replies` a la BD; drift de `agent.name`; actualizar el template en el repo zeroagent (cambios sin commitear).

### Auditoría post-arreglos · 11-10-2026

Cuatro auditores en paralelo (conversaciones, ecos/handoff/alertas, reservas/Calendar, código/drift/replay)
sobre el tráfico del 08-10 al 11-10 con producción en 7d0e7ae. Informe con datos de pacientes fuera del repo:
scratchpad de la sesión 98827f48, `audit/INFORME_CONSOLIDADO.md` (+ informe_A..D, replay en `tools/replay.mjs`,
ahora apuntado al código de producción y con red de escritura bloqueada).

- **Ecos: llegan desde el 09-10 22:52Z, 1:1 con Zavu.** No cambió nada de nuestro lado; preguntar a Zavu qué cambió.
  El silencio por eco funciona y es la mejora más visible.
- **Calidad cuando el bot habla: sin cambio neto.** 18 conversaciones con bot: 3 correctas (17 %), 6 graves, 1 dañina
  (graves 45 % → 33 %). Los errores ahora son acciones sobre reservas/fechas. 7d0e7ae sin validar (4 conversaciones).
- **P0:** 0 SMS al dueño desde 7f56de7 (revisar logs Vercel); el saludo automático de WhatsApp Business entra como
  eco y deja mudo al bot con prospectos nuevos; cuota Zavu 1.195/2.000 → tope 15-18-10.
- **P1:** `cancel_appointment` sin guarda en código y sin aviso al dueño (anuló una hora ante "le confirmo mañana");
  cancelación silenciosa cuando sale un bloque oficial en el mismo turno; RUT dado tras agendar no se guarda
  (`za_update_customer_intake` pisada por 09f0aa9 al reaplicar `agenda-v1-customer-records.sql`); carrera eco/bot
  (estado no se relee tras la espera de 12 s); ecos entran al historial como "assistant"; vuelta a las 12 h en hilos
  personales; modalidad box/domicilio nunca preguntada; sin feriados.
- **Drift:** `runtime-template/` tiene el mismo `src/` que producción pero SIN commitear (turn-guards.js y la
  migración 20261008 fuera de git); `agent-package.json` de la plantilla desactualizado.
- **Preguntas para Francisco:** regla ante "le confirmo mañana"; feriados; datos de transferencia; quiropráctico sí/no;
  preguntar siempre box/domicilio; si mantiene el saludo automático.

### Arreglos 1-6 post-auditoría · 11-10-2026

Decisiones de Daniel (11-10): el SMS no es grave (basta con el aviso en el panel; las notificaciones push
quedan pendientes, Francisco usa iPhone → hay que instalar la consola en la pantalla de inicio); la cuota de
Zavu no preocupa (primero mostrar que el bot sirve); en el primer contacto el bot habla siempre, aunque sea un
amigo (para eso está el botón de silenciar); ante "le confirmo mañana" la hora SE GUARDA; feriados y datos
de transferencia, por ahora no se tocan; "quiropráctico" lo confirma Daniel con Francisco; box o domicilio
se pregunta SIEMPRE antes de agendar; el saludo automático de WhatsApp Business se mantiene y el bot lo
reconoce y sigue.

1. **RUT:** `za_update_customer_intake` restaurada con RUT (migración `20261011_customer_intake_rut_restore`,
   aplicada en franciskom) y devuelve `stored_fields`; `update_customer_profile` ya no dice "guardado" si la base
   no lo guardó. El archivo base `agenda-v1-customer-records.sql` quedó idéntico a la migración (reaplicarlo con
   la versión vieja fue lo que lo borró el 08-09). RUT recuperados a mano: Eladio y Claudia; el de Belén no (es
   el de su pareja, el paciente). Se agregó al repo franciskom la migración `20260902_service_travel_buffer`, que
   estaba aplicada en la BD pero faltaba en el repo. Herramienta para detectar funciones SQL desfasadas:
   `scratchpad/tools/fncheck.mjs` (sesión 98827f48).
2. **Cancelaciones:** candado en código (`cancelRequestedByClient` en engine.js): solo se anula si el cliente usa
   palabras de anular/cancelar o contesta que sí a un "¿te la anulo?". Si no, la herramienta responde
   `kept_booking`, el bot dice que la guarda y Francisco recibe aviso. Toda cancelación y todo cambio de hora
   hecho por el bot genera aviso (`owner_alert`) en la Bandeja. Con hora tomada, un bloque oficial ya no sale
   solo si en ese turno se anuló o cambió la hora (antes el paciente recibía solo el mapa).
3. **Saludo automático:** un eco que llega ≤2,5 s después del mensaje del cliente (medido: saludo 0,2-0,4 s,
   Francisco en persona ≥4,6 s), o con el texto de un saludo ya reconocido, se guarda como `sender_type='system'`
   y NO pasa el hilo a handoff. Si el cliente solo saludó, el bot calla ese turno (el saludo ya preguntó qué le
   pasa); si traía una consulta, el bot responde sin volver a saludar. Los 2 saludos ya guardados se
   reclasificaron. Las consolas lo muestran como "Saludo automático".
4. **Carrera e historial:** el estado del hilo se vuelve a leer después de la espera de 12 s y después de generar
   la respuesta (si Francisco entró en ese rato, no se envía, salvo que el turno haya tomado o cambiado una hora).
   En el historial del modelo, cada mensaje de Francisco lleva antes una nota "lo escribió Francisco en persona".
5. **Consola PC:** la grilla cubre el horario real (reglas de disponibilidad + reservas fuera de él, antes fija
   9-18) y no muestra canceladas.
6. **Modalidad:** si el catálogo tiene servicios en sede y a domicilio, `create_appointment` se bloquea hasta que
   el cliente haya dicho la modalidad o el bot la haya preguntado. Con hora en la sede, "la sesión es en mi casa"
   ya no recibe el mapa: el bot pide la dirección y avisa a Francisco (cambiar la modalidad de una cita lo hace él).
7. **Más reglas, agregadas por lo que encontró el replay (mismo día):**
   - un turno que tomó, cambió o anuló una hora nunca termina en silencio (`changedBookingThisTurn`: se le niega
     `no_intervenir` y, si el modelo no logra redactar, se manda un aviso fijo tipo "Tu hora del X quedó anulada").
   - Una sesión a domicilio no se agenda sin dirección (`ask_address`), y quien pidió domicilio no queda agendado
     en el box (`wrong_mode`).
   - Ante "le puedo confirmar mañana" con hora tomada, el bot no calla: dice que la guarda y avisa a Francisco.
   - Con hora tomada, cuando la paciente duda del lugar ("me equivoqué", "esa no es la dirección") o pide agendar
     en otra sede, el bot nombra su hora y le pregunta "¿te la mantengo o te la anulo?". Francisco recibe aviso.
   - Las preguntas sin "?" ("Es quiropráctico verdad") ya no se toman como cierre.
   - "Tu hora sigue agendada" con la hora en el contexto ya no se reemplaza por "No pude confirmar esa operación".
8. **Verificación:** banco de replay (`scratchpad/tools/replay.mjs`, escrituras bloqueadas). Run 2: 10 fallos,
   run 5: 85/85 pasan. Solo falla el feriado del lunes 12, que es documental y por decisión no se toca.
   `npm test` en verde. **Desplegado** en franciskom, commit `0165f8e` (READY en Vercel 11-10-2026 03:24 CL);
   franciskom.cl y /m/ cargan sin errores de consola. Lo que todavía NO se vio en real: un eco o saludo nuevo
   guardado como system y una cancelación real con aviso. Revisar en la próxima pasada por la BD.
   runtime-template quedó sincronizado con los mismos archivos, sin commit (hay otro trabajo sin commitear ahí).
9. **Ojo, "quiropráctico":** el propio sitio franciskom.cl dice "Kinesiología, Quiropraxia y Osteopatía". El
   hecho actual "no se presenta como quiropráctico" lo contradice. Está pendiente la confirmación de Daniel con
   Francisco.

### Respuestas de Francisco y revisión de la Bandeja · 12-10-2026

**Francisco (vía Daniel, 12-10):**
1. Se presenta como "Francisco Martínez, Kinesiólogo, Quiropráctico y Osteópata" (más largo, pero le da más
   valor). Hay que cambiar el hecho "no se presenta como quiropráctico".
2. Si el paciente no confirma una hora guardada, lo ideal es que el bot le escriba para recordarle. Queda para
   cuando Francisco pague Meta, porque necesita plantilla de utilidad y tiene costo.
3. Atiende feriados según su disponibilidad. En general sí trabaja, así que no se hace nada.

**Lo que se vio en la Bandeja (medido en la BD el 12-10):**
- El hilo pasa a handoff con el eco de Francisco y solo se devuelve al bot cuando el cliente vuelve a escribir
  (`reclaimStaleHandoff` corre únicamente en el webhook). Por eso la Bandeja muestra como "Necesita persona"
  hilos de hace días: 17 por "Francisco está respondiendo", más ~25 traspasos de septiembre que nunca se
  cerraron.
- Los contactos silenciados también salen como "Necesita persona". Hay 4 así, entre ellos Daniel y Mamita.
- Amorchito (esposa de Francisco) no está silenciada, y el bot alcanzó a escribirle una vez.
- "Sugerir dato" / "Correcciones pendientes" muestran 3 sugerencias y 2 correcciones `[DEMO]` sembradas el
  01-08, más 1 corrección real del 02-09 ("debe pedir nombre completo, rut y correo") que nunca se marcó.
- "El bot sigue cuando atiendo": en la BD, desde que llegan los ecos (09-10), el bot no habló ni una vez después
  de un mensaje de Francisco. Lo que sí pasa es que el bot contesta primero (en ~12 s) y Francisco entra después:
  hubo 3 hilos así, con el bot hablando en los 30 min anteriores.

**Hecho el 12-10 (franciskom `75330f5`, desplegado, READY):**
- `conversationAttention` en `conversations.js` es la regla única para las dos consolas: `needs_person` /
  `owner_handling` / `muted` / `bot`. Silenciados, hilos donde Francisco escribió último y handoffs vencidos
  (12 h) dejan de contar como pendientes. Es solo lectura: la devolución real al bot sigue siendo
  `reclaimStaleHandoff` cuando el cliente escribe. Con datos reales, el badge pasa de 21 a 0 (3 "Lo estás
  atendiendo", 6 silenciados).
- Clientes: ordenados por última conversación (`last_contact_at`), con "escribió <fecha>" en ambas consolas.
- Dato `kf-formacion` (BD y `agent-package.json`): "Kinesiólogo, Quiropráctico y Osteópata"; si preguntan si
  es quiropráctico, la respuesta es sí. El replay pasa.
- BD: Amorchito (esposa) silenciada. Se borraron las 3 sugerencias y las 3 correcciones `[DEMO]` del 01-08. La
  corrección real del 02-09 quedó marcada como resuelta (hoy se exige nombre y apellido y se piden RUT y correo).
- runtime-template sincronizado (sin commit). No verificado por dentro de la consola: requiere el PIN, lo revisa
  Daniel en su teléfono.
- **Más tarde el 12-10 (`3a89a22`, desplegado):**
  - `za_conversations.updated_at` solo cambia con el estado del hilo, no con los mensajes. Por eso la Bandeja
    (top 40) podía dejar fuera hilos activos, y Clientes salía desordenado. Ahora `conversationActivity()` usa
    el último mensaje de cada conversación, y lo comparten Bandeja y Clientes.
  - Las consolas muestran la hora del último mensaje, y la de PC marca "Silenciado" igual que la móvil.
  - **Verificación de UI sin PIN:** `scratchpad/tools/ui-mock.mjs` (sesión 98827f48), que en launch.json es
    "franciskom-consola-solo-lectura". Sirve las consolas del clon en localhost:8091 con datos reales, solo
    lectura, y responde 403 a todo lo que no sea GET. Nunca usar el PIN de producción. Las dos consolas se
    revisaron así.

## Aviso mínimo de franciskom 3 h → 1 h · 14-10-2026

- Caso: Susana pidió hora "hoy" a las 16:04 y el bot dijo "no quedan horas"; Francisco sí tenía 17:00/18:00. Causa: `minimum_notice_hours: 3` en `agent-package.json` escondía todo lo anterior a las 19:04 (y la política de cancelación "3 horas antes" es otra cosa, no se tocó).
- Cambio: 3 → 1 en el repo de franciskom (commit 622531d, desplegado READY en Vercel) y en `runtime-template/agent-package.json`. El valor viaja como parámetro a la RPC `za_available_slots`, no hay nada que cambiar en Supabase.
- Verificado con consulta real a las 16:24: Box Buin devuelve 17:30–20:00 y domicilio 17:30–19:30. Sin filtrar por Google Calendar (no hay credenciales OAuth en local), así que si Francisco tiene eventos esa tarde en Calendar, esas horas igual se descartan en producción.

## Idea en brainstorm: flujo de nodos + comparación con el bot actual · 14-10-2026

- Origen: reel de arin_darcan (agente de voz con flujo de nodos: Saludo → Servicio → Alcance → Estilo → Datos → Presentar dueño → Cierre, más un nodo GLOBAL "Pricing Question" que interrumpe desde cualquier etapa y vuelve). Daniel quiere un flujo genérico de decisión, no sólo para franciskom: franciskom es el cliente 0 y lo que se cure ahí es la base para clientes nuevos.
- Idea acordada (aún sin construir): copia aparte dentro de Zero con el flujo de franciskom como etapas + nodos globales, sin tocar producción; correr los mismos casos del banco de replay (aciertos y fallos reales) contra el motor actual y el de flujo, y comparar. Riesgos anotados: separar casos de diseño y de prueba (para no sobreajustar), correr cada caso 2 veces, reproducir las reglas acumuladas de `engine.js`/`turn-guards.js` es el trabajo grande.
- Banco de replay: `tools/replay.mjs` (31 casos, última versión del 12-10) estaba sólo en el scratchpad de la sesión 98827f48; copia guardada en `storage/vault/replay-franciskom/replay.mjs` (gitignorado, tiene textos de pacientes). Lee `.env.franciskom` de runtime-template y corre en `dryRun`.
- Mismo día: aviso mínimo de franciskom 3 h → 1 h (ver sección anterior).

## Resultado del experimento "flujo de nodos" · 14-10-2026

Informe completo: `experimentos/flujo-nodos/INFORME.md` (código en `flow.js`; banco y logs en `storage/vault/replay-franciskom/`, gitignorado).

- **Veredicto:** el flujo NO reemplaza al bot actual hoy. Banco original (84 turnos): actual 82, flujo v1 79, flujo ajustado 82, flujo sin guardas de etapa 78. Casos nuevos (22 turnos): actual 14, flujo v1 18, flujo ajustado 17. Gana en reglas de situación (urgencia, freno de plata), pero agrega un punto de falla nuevo: el detector de etapa (3 bugs propios hallados y corregidos). Las guardas de código siguen valiendo.
- **Uso recomendado:** nodos + situaciones globales como formato de construcción para clientes nuevos, con banco de pruebas propio desde el día uno.
- **Defectos del bot ACTUAL de franciskom que salieron del experimento (pendientes, no arreglados):**
  1. "¿Hasta qué hora atienden?" se trata como pedido de hora: responde el horario y ofrece horas de inmediato (la palabra "hora" dispara `ASKS_FOR_HOURS` en `engine.js`); la regla de Francisco es pregunta cercana primero, sin horas.
  2. Domicilio fuera de zona (ej. Isla de Maipo): ofrece horas a domicilio en vez de ofrecer el Box Buin y avisar a Francisco.
  3. Ante un relato de urgencia (caída, no puede mover la pierna) no menciona acudir a urgencias (0 de 2).
- Pendiente además: medir tokens/costo por turno y armar un banco independiente más grande antes de decidir algo más.

## Arreglo de los 3 defectos del bot de franciskom · 14-10-2026

Desplegado en franciskom (commit `b993058`, Vercel READY, franciskom.cl 200) y backport hecho en `runtime-template/` (sin commitear: ese árbol ya traía cambios sin commitear de otras sesiones).

1. **"¿Hasta qué hora atienden?" ya no cuenta como pedido de hora** (`engine.js`: `OPERATING_HOURS_QUESTION` se quita antes de evaluar `ASKS_FOR_HOURS`) + guarda nueva: a quien sólo hizo una pregunta seca y aún no cuenta su dolor no se le ofrecen horas (`premature_hours_offer`, un reintento).
2. **Domicilio fuera de zona**: `solutions.agenda.config.home_visit_zone` (franciskom: Buin, Linderos, Paine centro, Alto Jahuel, Maipo). `get_availability` y `create_appointment` reciben `comuna`; el código exige que esté en la zona Y que la haya dicho el cliente (el modelo se había inventado "Buin" para pasar la compuerta). Fuera de zona → `outside_zone`: ofrece Box Buin y avisa a Francisco. "Paine" a secas → pide el sector. Studio: `server.js` ahora deja pasar `home_visit_zone`, pero NO tiene campo en la UI.
3. **Urgencia**: mecanismo genérico `agent.required_mentions` (`when`/`require`/`instruction`) verificado en código con un reintento; franciskom define `urgencia`. Ojo: el paquete entregado vive en el repo de franciskom; si Studio regenera `agent-package.json`, estos campos (agent.required_mentions y config.home_visit_zone en UI) hay que reponerlos.

**Verificación** (banco de replay con el código real, 2 corridas por caso, dryRun, 0 escrituras): los 3 casos de defecto pasan 2/2 (antes 0/2), más 3 casos nuevos (domicilio en zona, domicilio sin comuna, pregunta seca de ubicación) 2/2. Banco original: 82 → 81 de 86; las diferencias son ruido o redacción (pilar-modalidad-respondida es inestable en el código ANTERIOR también: 2/5 base vs 3/5 con el arreglo; D-a2 falló por la palabra "considerada" en la respuesta, con la hora guardada correctamente). `npm test` pasa en ambos árboles.

### Medición del acierto con tráfico real · 14-10-2026

Tráfico del 11-10 09:00 al 14-10 (26 hilos, 12 con respuesta del bot; clasificación leída a mano, misma vara
del 08-10). Datos de pacientes fuera del repo (scratchpad de la sesión 0615a0c2: `brief.txt`, `pull.mjs`).

- **Resultado: 5 correctas (42 %), 4 menores, 3 graves (25 %), 0 dañinas.** Línea base 11-10: 17 % correctas, 33 % graves.
  Muestra chica (12) y mezcla de antes/después de los arreglos del 14-10; no es comparable al 71 de la base.
- **Graves:** (1) "Francisco no realiza sesiones para mascotas" repetido dos veces: dato inventado (no hay hecho
  sobre mascotas) y Francisco sí evaluó a la perrita; (2) "hoy no quedan horas" con horas libres (aviso mínimo 3 h,
  arreglado 14-10); (3) paciente pidió "hoy" y "jueves pm", el bot ofreció jueves 12:00 dos veces (mismo origen del aviso).
- **Menores:** horas ofrecidas justo tras "valores" sin pregunta de dolor (rompe el ritmo de venta); horas de inmediato
  ante un caso neurológico; respondió a RedSalud (tercero) y a una campaña automática; saludo doble con "Mucho gusto, Susana".
- **Pendiente derivado:** regla general "si el dato no está en los hechos, no lo niegues ni lo inventes: avisa al dueño";
  corregir ritmo tras pregunta de precio; no hablar a mensajes de campaña/tercero.

## Auditoría independiente del bot · 15-10-2026

- Informe: `AUDITORIA_FRANCISKOM_2026-10-15.md`. Auditoría de solo lectura de producción, sin mensajes ni mutaciones reales. GitHub y Vercel coinciden en `69475a3`, posterior a la última bitácora: ya incluye ausencia de dato ≠ negación y descarte de campañas/terceros. La BD también tiene `kf-mascotas`, confirmado por Francisco el 15-10: no reutilizar el antiguo caso como alucinación actual.
- Evidencia: 47 mensajes del bot en 19 hilos desde el 11-10 09:00 CL; lectura manual de los 10 hilos con bot desde el 13-10 21:00 CL. 24 turnos sintéticos (12 casos × 2), pruebas adversariales de guardas y prueba sintética de error parcial de Calendar. Material privado/reproducción en `storage/vault/audit-franciskom-20261015/`, ignorado por Git.
- P1 identificados: cancelación admite negaciones e hipótesis; modalidad preguntada cuenta como elegida; hora ofrecida cuenta como seleccionada; Calendar permite confirmar si falla la consulta y no chequea errores por calendario; el descarte por nuevo inbound puede ocultar confirmación de una mutación ya hecha. Los casos forzados prueban la barrera, no incidentes reales.
- Conversación: cierre comercial demasiado insistente, repetición al agregar antecedentes; fuentes contradictorias (landing 20:00, agenda/conocimiento 21:00; descuentos); aviso al dueño bloqueado hasta ofrecer horas incluso para cotización fuera de zona; datos de pago activos con nota de aprobación pendiente.
- Pruebas: `npm test` y Zavu offline pasan; 17 migraciones aplicadas 2x pasan en PGlite aislado. `npm test` no usa el motor LLM y dryRun crea éxitos antes de gran parte de la validación real: no usar sus verdes para certificar reservas.
- Operación: 0 respuestas del bot dentro de 12 h tras mensaje humano en la ventana; 0 reservas nuevas en Supabase desde el 11-10 (no demuestra ausencia de ventas en Calendar externo). Evento fallido reciente corresponde al eco de un mensaje del bot ya entregado, no a un paciente perdido. Mediana de eventos completados 21,88 s; p95 31,88 s. Promedio real de entrada del modelo: 13.911 tokens/turno.
- Recomendación: conservar infraestructura y rediseñar progresivamente autorización y decisión conversacional; primero reparar integridad y pruebas. No se implementó ni desplegó ninguna corrección. Los ensayos locales no tenían las claves de Calendar: slots sin su filtro; no validan horarios productivos. `runtime-template/src` coincide con producción tras normalizar CRLF; el paquete de la plantilla sigue desfasado.

## Feedback de Francisco · 16-10-2026 (conversar primero, sin urgencias, horas compactas)

Francisco, molesto tras ver respuestas reales del bot, pidió: (1) conversar antes de ofrecer horas aunque el cliente ya haya pedido una (hace cuánto / diagnóstico médico); (2) sacar el envío a urgencias ante expresiones como "dolor atroz"; (3) no ofrecer horas dispersas (08:00/14:00/20:00) sino pegadas a las citas que ya tiene. Su 3ª nota de voz quedó cortada ("no que me las tire con tanta dis…").

Implementado (src idéntico en runtime-template y franciskom):
- `discovery_before_hours` en `engine.js`: si el cliente contó dolor y aún no hay pregunta de descubrimiento, se reintenta una vez sin horas. No aplica si nombra un día, ya dio duración y diagnóstico, o manda RUT+correo (cierre).
- `forbidden_mentions` (regla `urgencia_sin_senal` en agent-package.json): "urgencia" sólo si el cliente describe una señal de emergencia real.
- `pickSlotShortlist` en `agenda-tools.js`: horas agrupadas junto a citas existentes (agenda + Google Calendar), con espaciado mínimo = duración de sesión; penaliza fuera de 09:00–19:00. No verificado con datos reales (Calendar no disponible en local).
- Otros 15-10: consent guards (cancelar/modalidad/hora), Calendar fail-closed, `kf-mascotas`, horario hasta 21:00.
- Regresión: banco 83/4 y nuevos 53/2 antes de ajustes; fallas restantes conocidas: D-c-feriado-lunes-12 (tool-step-limit), h-mascotas (~1/6 flake). Los casos antiguos que exigían "hora directa → horas altiro" cambiaron a propósito.

### Ajuste 16-10-2026 (tarde): urgencias eliminadas y descubrimiento invertido

Daniel: el bot no debe mandar a urgencias nunca (lo decide Francisco, que recibe aviso con `avisar_al_dueno` ante señales graves) y la regla no puede depender de palabras sueltas como "atroz".
- `forbidden_mentions` regla `sin_urgencias`: bloquea "urgencia" siempre (sin `unless`; el motor ahora acepta reglas sin `unless`).
- `discovery_before_hours` invertido en `engine.js`: no se ofrecen horas hasta haber hecho una pregunta de conversación (excluye saludos tipo "¿en qué te ayudo?"), salvo día nombrado, duración+diagnóstico ya dados, cierre con RUT+correo, u horas ya ofrecidas antes. Ya no depende de la lista PAIN.
- Casos nuevos en el holdout: saludo+dolor atroz, "me quedé trabado", "se me engarrotó", "insoportable", urgencia real (debe avisar a Francisco, no derivar).
- Regla de proceso: cada cambio corre banco completo + holdout antes de subir; cada conversación mala real pasa a ser caso permanente (evita la deriva entre arreglos).
- Fallas conocidas: D-c-feriado-lunes-12 (ofrece el feriado sin avisar), h-freno-plata (checker), h-diagnostico (checker/flake ~1/6 ignora la pregunta directa). Fixture pilar-modalidad-respondida tenía fecha pasada (corregida).
- 16-10 (noche): `answer_before_hours` en `engine.js`: ante una pregunta del cliente sobre su caso (no precio/ubicación/horarios) el bot responde y espera; las horas van en el turno siguiente. Feriados: Daniel decidió seguir agendando (Francisco corrige a mano); caso D-c-feriado retirado del banco. Regresión final: banco 88/89, nuevos 62/63 (fallas = flakes: pilar-sin-modalidad, h-dolor-con-tiempo).

### Rediseño del ritmo de conversación · 16-10-2026 (noche)

Daniel: reglamentar "x respuestas, esto sí esto no" es el enfoque equivocado; hay que detectar hacia dónde va la conversación sin exagerar. Francisco (2ª ronda de audios): el bot se "deshumanizó", mete horas sin conversar ni preguntar diagnóstico/tratamiento previo y el paciente deja el visto; el prompt está "saturado de instrucciones".
- Nuevo `runtime-template/src/conversation-judge.js`: un juez (llamada corta al modelo) lee el hilo completo y dice `ofrecer`/`conversar`. Criterio: conocer qué le pasa, desde cuándo y si lo trató/tiene diagnóstico (contado o ya preguntado); o la persona sólo quiere la hora; o ya se conversó lo razonable (>3 preguntas = interrogar). Falla abierto (si no responde, no bloquea).
- `engine.js`: eliminados los contadores/listas de palabras (primer dolor, descubrimiento, responder primero, pregunta seca, oneQuestionTooMany). El juez rechaza (máx. 2 veces) un borrador con horas cuando toca conversar; tras un bloque literal (precio) también decide si se ofrecen horas o se pregunta qué le pasa. Rondas del loop 5 → 7 (evita "excedió el límite de pasos").
- Prompt reducido a un principio (cercanía, reaccionar, ofrecer cuando se conoce el caso, corte "lo ideal es que Francisco te evalúe en persona") y regla de código `sin_urgencias` ampliada (urgencia/urgente/hospital/sapu/posta/servicio de salud). Urgencias eliminadas por completo (decide Francisco; el bot avisa con avisar_al_dueno).
- Regresión final: banco 84/85, nuevos 66/67 (fallas = flakes/checker: pilar-sin-modalidad, h-freno-plata). 15 pruebas unitarias.
- Pendiente de ver con tráfico real: efecto del juez en tono/cantidad de preguntas; horas compactas con el Calendar real. Idea de Daniel (no forzada): corte "¿qué día te acomoda?" en vez de listar horas.
- 16-10 (noche, simulaciones): se probó el bot con 3 clientes simulados (`storage/vault/replay-franciskom/sim.mjs`: hablador/inmediato/fractura). Hallazgo grave: ante hueso expuesto el bot pedía nombre para agendar y `avisar_al_dueno` estaba bloqueado hasta ofrecer horas. Arreglo: `avisar_al_dueno(grave=true)` salta ese bloqueo, no ofrece horas ni da consejos médicos, avisa a Francisco y traspasa; las exageraciones ("me muero", "atroz") no cuentan como grave. El juez pide UNA sola pregunta. Pendientes detectados: el bot sigue ofreciendo horas tras "déjame pensarlo" (hay que cerrar suave y dejar de empujar) y responde con el bloque largo de precios a preguntas como Fonasa (selección de bloque literal demasiado amplia).
- 16-10 (cierre): decisiones de Daniel tras las simulaciones. (1) Se quitó la alerta `grave` de `avisar_al_dueno` (demasiada maquinaria para un caso absurdo): ante emergencia evidente el prompt manda decirlo con todas sus letras ("escapa de lo que puede atender un kinesiólogo, llama a emergencias 131") sin ofrecer horas; el filtro `sin_urgencias` se desactiva (`unless`) sólo con hueso/sangrado/desmayo/pecho/falta de aire. (2) El juez tiene una 3ª etapa `esperar`: si el cliente dice que lo va a pensar/conversar, no se le ofrecen horas de nuevo (cierre cálido con puerta abierta); una pregunta suave por fecha más adelante vale ante un freno de plata. La guarda antigua `postponesSale` obedece al juez. (3) El bloque literal `sesion_general` (precios) sólo sale si el mensaje pide valor/precio/qué incluye (`match` en agent-package de franciskom). Regresión: banco 85/85, nuevos 70/73 (fallas = chequeos/flakes).
- 19-10-2026 (revisión de tráfico real desde 16-10): sólo 3 leads nuevos conversaron con el bot tras el juez (17-10); tono bien (una pregunta, sin urgencias, horas cuando corresponde). Arreglados: (a) tras el bloque de precios repetía "¿qué te está molestando?" aunque el cliente ya lo había dicho; (b) el seguimiento elegía el servicio "kinésica respiratoria" (primero del catálogo) para pacientes normales. Pendiente: pasar la preferencia de horario del cliente ("lo más tarde posible") a get_availability; Francisco entra a cerrar casi todos los chats de leads; el WhatsApp personal completo de Francisco entra a la base (decidir filtro por contacto).
