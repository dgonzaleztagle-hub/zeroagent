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
| Checklist de staging | implementada | `AGENDA_V1_STAGING_CHECKLIST.md` |

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
