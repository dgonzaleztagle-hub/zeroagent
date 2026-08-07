# Consola cliente · contrato de producto

La consola empaquetada no es una versión reducida del Studio. Es la herramienta diaria del dueño y su equipo para operar un agente ya instalado. La IA queda como infraestructura; la interfaz habla de atención, agenda, clientes y decisiones.

Se entrega como una aplicación de marca del cliente. El núcleo común es Hoy, Conversaciones, Calidad y Negocio; Agenda y futuros productos se habilitan mediante el manifest del paquete.

## Navegación objetivo implementada

- **Hoy:** prioridad humana, reservas próximas, calidad pendiente, actividad y freno global.
- **Conversaciones:** búsqueda, filtros, responsable, prioridad, historial, handoff y respuesta humana por Zavu.
- **Agenda:** calendario, reservas, servicios, equipo y disponibilidad explícita.
- **Calidad:** Playground, respuestas evaluadas y correcciones con estado.
- **Negocio:** identidad, sedes, equipo/permisos, marca, notificaciones e integraciones.
- **Onboarding privado:** ruta separada, token, 13 pasos, archivos y reanudación; después queda accesible como actualización de información.

## Principios no negociables

1. Cada conversación tiene estado, prioridad y responsable humano cuando lo requiere.
2. `Tomar conversación` silencia la IA sólo en ese hilo. `Devolver a automatización` la reactiva. La pausa global silencia todo el canal sin perder mensajes.
3. El cliente puede operar datos del negocio y reportar respuestas. No edita prompts, herramientas ni publica versiones.
4. Una reserva se confirma sólo desde disponibilidad viva. El dashboard nunca escribe disponibilidad como texto libre para que el modelo la interprete.
5. Toda corrección conserva conversación, mensaje, contexto y autor; ZeroAgent la revisa y publica mediante versión, no de manera automática.

## Navegación P0

| Vista | Pregunta que responde | Acciones |
|---|---|---|
| Inicio | ¿Qué requiere atención ahora? | Tomar caso, asignar responsable, pausar/reanudar automatización. |
| Conversaciones | ¿Qué dijo el cliente y quién responde? | Ver historial, abrir WhatsApp/Zavu, asignar, priorizar, tomar/devolver IA, aprobar/corregir una respuesta. |
| Agenda | ¿Qué se puede ofrecer y qué está reservado? | Ver calendario, abrir ficha de reserva, crear/cancelar/reagendar, gestionar horarios y bloqueos. |
| Catálogo | ¿Qué sabe de forma operativa el agente para reservar? | Servicios, duración, precio, sede, recurso y capacidades. |
| Playground | ¿Cómo responde el agente antes de publicar? | Conversar, aprobar y corregir sin salir del dashboard. |
| Calidad | ¿Qué respuestas deben mejorar? | Ver feedback pendiente y entrar al Playground integrado. |

En P0, `Catálogo` puede ser subpestaña de Agenda; no debe mezclarse con la lista de reservas.

## Agenda: fuente de verdad operativa

### Datos que alimentan directamente al agente

- **Servicio:** nombre, duración, precio, descripción corta, si está activo.
- **Sede:** nombre, dirección, zona horaria y contacto.
- **Recurso agendable:** persona, sala, box o vehículo; servicios que realiza, sede, estado, capacidad y calendario.
- **Regla de horario:** día, inicio, fin, recurso y vigencia.
- **Bloqueo:** recurso, inicio, fin y motivo interno.
- **Reserva:** cliente, teléfono, correo opcional, servicio, recurso, sede, inicio/fin, origen, estado, notas y referencia.

### Dos modelos de capacidad

1. **Cita individual:** un masajista/box atiende una reserva a la vez. Es el modelo actual y debe ser el default.
2. **Reserva con cupos:** una actividad puede tener capacidad mayor a uno (clase, tour, mesa, evento). Requiere capacidad por recurso/bloque y contador de cupos confirmados. No se simula como múltiples citas individuales.

### Visualizaciones obligatorias

- Calendario diario/semanal con pestañas por recurso agendable.
- Tarjeta de servicio que muestre duración, precio y recursos que lo pueden realizar.
- Ficha de reserva al seleccionarla: nombre, teléfono, correo, enlace `wa.me`, estado, historial y acciones permitidas.
- Vista de disponibilidad por recurso para detectar huecos y conflictos.
- Catálogo editable con validación: al desactivar un servicio/recurso, el agente deja de ofrecerlo.

## Conversaciones y atención humana

- Lista compacta, sin corte horizontal; en móvil se convierte en lista sobre la conversación.
- Panel de conversación incluye identidad/telefono, responsable, prioridad, estado, último mensaje y acciones visibles.
- `Tomar conversación` debe mostrar quién la tomó y desde cuándo.
- La respuesta humana se hace inicialmente desde Zavu; la consola tiene un enlace directo `wa.me` y, cuando Zavu confirme soporte de salida/historial humano, se evaluará composer propio.
- En handoff, el webhook guarda mensajes entrantes y no envía respuestas automáticas.

## Playground del cliente

El Playground debe ser una vista del mismo dashboard incluido en **su paquete**, no una página separada ni el Studio local. Sus acciones:

- probar consultas sin tocar conversaciones reales;
- 👍 aprobar una respuesta;
- 👎 pedir corrección con respuesta esperada;
- persistir el feedback en el Supabase del cliente y notificar el outbox de mantenimiento.

## Responsive

- Desktop: lista + conversación en dos columnas; agenda semanal.
- Tablet: lista estrecha, conversación principal.
- Móvil: navegación horizontal, lista antes de conversación, acciones en menú compacto; jamás scroll horizontal en tarjetas de conversación.

## Límites P0 conscientes

- No se construye todavía un contact center humano completo ni CRM genérico.
- No se expone la edición del prompt al cliente.
- No se simula disponibilidad con texto: los cálculos siguen en Supabase/RPC.

## Estado de implementación 2026-07-17

- Bandeja reparada: selección comprobada en Chrome, sin corte horizontal ni estado vacío superpuesto.
- Agenda: filtros por profesional, subpestaña `Servicios y equipo` y ficha de reserva con contacto comprobados.
- Playground integrado al dashboard con conversación, aprobación y corrección.
- Pendiente de la siguiente iteración: calendario diario/semanal editable, CRUD productivo de catálogo/bloqueos/capacidad y prueba contra Supabase staging real.
