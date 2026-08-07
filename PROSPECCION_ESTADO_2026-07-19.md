# Prospección · estado, arreglos y gaps · 19-07-2026

## Qué es (confirmado leyendo el código)

Herramienta **interna del Studio** (local, nunca viaja en el paquete del cliente) para descubrir negocios locales, calificarlos y llevarlos por un pipeline hasta convertirlos en un proyecto ZeroAgent. No es multi-tenant ni tiene relación con el runtime del cliente.

**Flujo completo:** búsqueda por vertical + zona → Serper Places trae negocios → scoring determinista los prioriza → CRM (vista Foco con ficha 360° + vista Pipeline con drag&drop) → convertir un prospecto calificado en cliente con etapa `intake`, listo para enviar la entrevista guiada.

**Datos:** SQLite (`prospecting_searches`, `prospects`, `prospect_activities`). Deduplicación por dominio, teléfono normalizado, o nombre+ubicación. 5 verticales: Agenda, Leads, Ventas, Atención, Personalizada.

## Verificado funcionando en vivo hoy (localhost:8080)

- Cargar escenario demo: 5 negocios con score (67–93), stats y estado del proveedor correctos.
- Ficha 360°: evidencia/señales, teléfono, `wa.me`, mensaje sugerido, formulario de estado/notas/seguimiento, botón convertir.
- Mutación de prospecto (PATCH) por API: OK.
- Badge de seguimiento vencido: renderiza con color de alerta correcto.
- Filtro de estado con "Descartados": presente.

## Arreglado hoy

| # | Problema | Arreglo | Archivo |
|---|---|---|---|
| 1 | Mutaciones del CRM fallaban en silencio (updateProspect, convertProspect, submit de ficha, drag&drop del pipeline, cargar escenario, copiar mensaje): un error de red dejaba la UI sin feedback. | Manejo de error visible (`alert`) + recarga que revierte la UI optimista. | `prospecting.js` |
| 2 | `coverage` (barrio/comuna/ciudad/región) se guardaba pero **no cambiaba la búsqueda** — control muerto. | Ahora modifica realmente la query geográfica a Serper. | `server.js` |
| 3 | Link "Sitio" de la ficha no bloqueaba esquema `javascript:` (dato viene de Serper, externo). | `safeHref()` sólo permite `http(s)`. | `prospecting.js` |
| 4 | `next_action_at` se capturaba pero **nunca se mostraba** — la promesa de "seguimiento" estaba a medias. | Badge en cada fila: "Seguimiento vencido" (alerta) o fecha próxima. | `prospecting.js` + `prospecting.css` |
| 5 | Filtro de estado sin opción "Descartado" (el backend y la ficha sí lo permiten). | Opción agregada. | `index.html` |
| 6 | No había forma sencilla de configurar `SERPER_API_KEY`/`GROQ_API_KEY` (no había cargador de `.env` ni el paquete `dotenv`). | Cargador de `.env` de cero dependencias en el arranque + `.env.example`. | `server.js` + `.env.example` |

## Para dejar la búsqueda REAL al 100% (acción tuya, 2 minutos)

Hoy la búsqueda real **no puede ejecutarse** porque falta `SERPER_API_KEY` — sólo corre el escenario demo. Todo el cableado ya está listo y verificado por código. Para activarla:

1. Consigue una clave en https://serper.dev (tiene plan gratuito).
2. Copia `.env.example` a `.env` y pega la clave en `SERPER_API_KEY=`.
3. Reinicia el server (`node server.js`). El cargador de `.env` la toma automáticamente y el indicador pasa a "Búsqueda real disponible".

> Nota: el server que corre ahora es el código anterior (sin el cargador de `.env`). Los arreglos de interfaz ya están en vivo porque se sirven como archivos estáticos, pero el cargador de `.env` y el cambio de cobertura recién quedan activos tras reiniciar — que es justo lo que harás al agregar la clave.

## Gaps y oportunidades (documentados, no bloquean el uso hoy)

**Gaps de alcance de búsqueda:**
- **Tope de 20 resultados por búsqueda, sin paginación.** Serper `/places` se llama con `num: 20` y una sola pasada. Para una comuna con muchos negocios, te quedas corto. Oportunidad: paginar (`page`/offset) y acumular, o permitir "traer más".
- **Sin enriquecimiento de correo.** La columna `email` existe en la tabla pero nunca se llena (Serper Places no lo trae). El mensaje sugerido asume WhatsApp. Oportunidad: un segundo paso que visite el sitio del prospecto y extraiga correo/redes.
- **Scoring sólo por palabras clave** (`scoreProspect`): encaje de rubro por substring, presencia de teléfono/web, rating y reseñas, y detección de agenda online. Es explicable y determinista (bien para empezar), pero no entiende sinónimos ni contexto. Oportunidad: capa LLM opcional para reclasificar los casos borde, consistente con el resto del producto.

**Oportunidades de producto:**
- **Seguimientos como agenda de trabajo.** Ya surfacimos los vencidos en la lista; el siguiente paso natural es una vista "Hoy" que junte todos los seguimientos del día y los cuente como stat, para que Prospección funcione como bandeja de acción diaria (referencia Close/Attio que ya menciona el PROJECT_CONTEXT).
- **Plantillas de mensaje por vertical.** Hoy el mensaje sugerido es una sola fórmula con el pitch de la vertical. Oportunidad: 2–3 variantes por vertical y por señal (ej. "sin web" vs "con agenda ya montada").
- **Métrica de conversión del embudo.** Con `prospect_activities` ya registrando cambios de estado, se puede calcular tasa nuevo→contactado→calificado→convertido sin trabajo extra de datos.

## Estado

Prospección queda **funcional al 100% en su flujo demo + CRM** (verificado en vivo). La búsqueda real queda **completamente cableada y lista para enchufar** con una clave Serper + reinicio. Los gaps de arriba son ampliaciones de alcance, no fallas del flujo actual.

---

# Reauditoría con lente de cosecha de contactos · 19-07-2026 (tarde)

Objetivo aclarado por Daniel: *"búsquedas que me entreguen WhatsApp y correos de negocios locales, para enviarles info y demo de lo que vendo desde ZeroAgent."* Reauditado todo el flujo con ese norte.

## Hallazgo principal (ya resuelto hoy)

**La búsqueda solo entregaba teléfono + web de Serper; el correo nunca se llenaba y el WhatsApp era una adivinanza desde el teléfono** (que muchas veces es un fijo, y `wa.me` sobre un fijo no funciona). Es decir: el flujo NO cumplía el objetivo comercial declarado.

Se resolvió portando el patrón que tu propio **Radar de hojacero** ya tenía probado (`hojacero/app/api/radar/search/route.ts`, función `scrapeContactInfo`): ahora cada búsqueda, además de Serper, **visita el sitio de cada negocio y extrae correo, WhatsApp, Instagram y Facebook**.

Implementado y verificado en vivo:
- `scrapeBusinessContacts()` + `mapWithConcurrency()` en `server.js` (scraping en paralelo, máx 4 sitios, timeout 5s por sitio).
- Columnas nuevas en `prospects`: `whatsapp`, `instagram`, `facebook` (migración idempotente para la base existente).
- El scoring ahora premia contactabilidad: +12 correo visible, +10 WhatsApp propio, +4 redes activas — porque un lead contactable vale más para tu objetivo.
- La ficha muestra correo (botón `mailto:`), WhatsApp (botón `wa.me` **con el mensaje sugerido precargado**), redes (link directo) y los datos en la grilla de contacto.
- La lista marca cada negocio con tags "correo"/"WhatsApp" para ver de un vistazo cuáles son contactables.
- El aviso post-búsqueda reporta cuántos traen correo y WhatsApp propio.
- La respuesta del endpoint devuelve `with_email` y `with_whatsapp`.

**Prueba real (Las Condes, "spa masajes centro estética"):** 10 negocios encontrados → **8 con correo, 5 con WhatsApp propio**, con Instagram incluido. Ejemplos reales extraídos: correos `@gmail.com` y de dominio propio, números WhatsApp con código país listos para `wa.me`. Exactamente la materia prima para tu outreach.

## Gaps que quedan (para tu objetivo de contacto — priorizados)

1. **[Alto valor] Export masivo de contactables (CSV).** Para enviar info/demo a escala necesitas sacar la lista (nombre, correo, WhatsApp, rubro, zona) de un click. Hoy no hay export. Es lo primero que agregaría a continuación.
2. **[Alto valor] El scraper solo lee la home.** Muchos negocios ponen el correo en `/contacto` o `/contact`. Buscar también esas rutas subiría bastante el rinde de correos. hojacero tampoco lo hace, así que es mejora para ambos.
3. **[Medio] Negocios sin web quedan sin correo.** Serper igual trae su teléfono, pero sin sitio no hay correo. Si tienen Instagram/Facebook, el siguiente paso sería scrapear esas redes o al menos dejar el link para contacto manual.
4. **[Medio] Distinguir móvil de fijo.** Cuando no hay WhatsApp scrapeado, la ficha cae al teléfono; si es fijo, el `wa.me` no sirve. Marcar "probable móvil" (celulares chilenos parten con 9) evita intentos fallidos.
5. **[Bajo] Tope de 20 resultados sin paginación** (heredado). Para barridos grandes de una comuna conviene paginar.
6. **[Bajo] Plantillas de mensaje por vertical/señal.** Hoy el mensaje sugerido es una sola fórmula. Variantes ("sin agenda online" vs "spa premium") mejoran la tasa de respuesta.

## Oportunidades de producto

- **Bandeja de outreach diaria:** juntar los contactables nuevos + seguimientos vencidos en una vista "Hoy" para trabajar la cosecha como rutina.
- **Registro de envío:** un botón "marqué contactado por correo/WhatsApp" que registre la actividad automáticamente (los `prospect_activities` ya existen).
- **Reutilización cruzada:** el `scrapeBusinessContacts` que quedó acá es idéntico en propósito al de hojacero. Candidato claro para tu carpeta `MODULOS` como extractor de contactos reusable entre proyectos.

## Nota técnica / legal

El scraping es de datos de contacto públicos, una sola petición por sitio con timeout de 5s y User-Agent de navegador — bajo impacto. Aun así, para volúmenes grandes conviene respetar un ritmo prudente. El `.env` con las claves quedó protegido por `.gitignore`.

---

# CRM: contactabilidad y trazabilidad · 19-07-2026 (cierre)

Segundo pedido de Daniel: al entrar a Prospección, cómo se mete un prospecto al CRM para empezar a trabajarlo, con foco en **contactabilidad** y **trazabilidad**. Implementado y verificado en vivo.

## Flujo de trabajo resultante

1. Buscas → los negocios entran al radar como `Nuevo`, ya con correo/WhatsApp cosechados.
2. Abres la ficha y contactas con **un click**: el botón WhatsApp (con mensaje precargado) o Correo abre el canal y, en el mismo gesto, **registra el contacto en la historia y avanza la etapa** `Nuevo → Contactado`. No hay paso manual de "marcar como contactado".
3. La ficha muestra el estado de trazabilidad arriba: *"Sin contactar aún"* o *"Último contacto: 19-jul, 03:51 p.m. · WhatsApp"*. Para llamadas/visitas hay un enlace "Registrar llamada/visita".
4. Cada contacto y cada cambio de etapa queda en la línea de tiempo de la ficha (tabla `prospect_activities`), así hay historial completo de qué se hizo y cuándo.
5. Fijas un próximo seguimiento; si vence, la lista lo marca en naranja ("Seguimiento vencido").
6. Cuando calienta, lo conviertes en proyecto ZeroAgent.

## Piezas nuevas

- **Endpoint `POST /api/prospecting/prospects/:id/contact`** (`server.js`): registra actividad `contacted`, guarda `last_contacted_at` + `last_contact_channel`, y avanza `new/shortlisted → contacted`. Canales: WhatsApp, Correo, Llamada, Instagram, Visita.
- **Columnas nuevas** en `prospects`: `last_contacted_at`, `last_contact_channel` (migración idempotente).
- **Export CSV** (`GET /api/prospecting/export`): respeta los filtros activos (estado/búsqueda), con BOM para que Excel abra bien las tildes. Columnas: negocio, rubro, zona, dirección, teléfono, WhatsApp, correo, Instagram, Facebook, sitio, score, encaje, estado, último contacto, canal, próximo seguimiento. Botón "Exportar CSV" en el encabezado.
- **UX de contacto de un click** (`prospecting.js`): los botones WhatsApp/Correo loguean al abrir el canal; línea de "último contacto" en la ficha; tags de contactabilidad y estado en la lista.

## Verificado en vivo

- Contactar por WhatsApp: la ficha pasó de "Sin contactar aún" a "Último contacto: … · WhatsApp", el estado avanzó a Contactado, y quedaron las actividades `contacted` + `status_changed` en la historia.
- Export CSV: cabeceras correctas (`text/csv`, `attachment; filename=prospectos-AAAA-MM-DD.csv`), 25 filas con todos los campos de contacto y trazabilidad.
- Revisión de diseño (screenshot): ficha coherente — acciones WhatsApp/Correo/Sitio/Copiar, línea de trazabilidad con check verde, señales de contactabilidad, grilla de contacto; lista con tags CORREO/WhatsApp y badge de seguimiento vencido.

## Lo que sigue quedando como oportunidad (no bloquea)

- Plantillas de mensaje por vertical/señal.
- Paginación de Serper (hoy tope 20 por búsqueda).
- Scrapear también redes (Instagram/Facebook) para negocios sin sitio web.

---

# Bandeja "Hoy" y afinado de contacto · 19-07-2026 (cierre 2)

Pedido: armar todo lo que sirva, con una buena UX fijada en el objetivo (encontrar negocios con WhatsApp/correo → ofrecerles la demo → trabajarlos con trazabilidad). Implementado y verificado en vivo.

## Bandeja "Hoy" (nueva vista por defecto del CRM)

Al entrar a Prospección, la primera pestaña ahora es **Hoy** (antes caía en Foco). Responde de una la pregunta operativa "¿a quién le escribo hoy?":

- **Seguimientos de hoy:** compromisos que vencen o ya vencieron (no cerrados), ordenados por urgencia.
- **Por contactar:** negocios con correo o WhatsApp, aún sin primer contacto, ordenados por score (tope 20).
- Cada negocio es una tarjeta compacta con sus tags de contactabilidad y **acciones directas**: WhatsApp (verde, mensaje precargado) y Correo (propuesta lista). Contactar desde la tarjeta registra el contacto y avanza la etapa igual que en la ficha. Click en el cuerpo de la tarjeta abre la ficha completa en Foco.
- Estados vacíos con sentido: "Estás al día" cuando no hay nada pendiente, "El radar está vacío" cuando no hay prospectos.

## Afinado de contacto (contactabilidad más confiable)

- **Móvil vs fijo:** el botón WhatsApp sólo aparece cuando el número es realmente alcanzable — WhatsApp scrapeado del sitio, o un móvil chileno (9 + 8 dígitos). Un fijo ya no genera un `wa.me` que no funciona.
- **Correo listo para enviar:** el botón Correo abre `mailto:` con **asunto y cuerpo (tu mensaje de venta) precargados** — un click y sólo revisas antes de enviar.
- **Más correos:** el scraper, si la home no trae correo, busca también en `/contacto`, `/contact`, `/contactenos` y `/contacto-nosotros`.

## Verificado en vivo (funcional + diseño)

- Hoy es la pestaña activa por defecto; secciones "Seguimientos de hoy" (1) y "Por contactar" (20) con 21 tarjetas, 20 acciones WhatsApp y 6 de correo.
- Contactar desde una tarjeta: registró el contacto (status → contacted, trazado) y refrescó la bandeja; abrir una tarjeta saltó a Foco con la ficha correcta.
- Screenshot con lente de diseño: dos columnas legibles, jerarquía clara, acento verde para la acción principal (WhatsApp), tarjetas escaneables; las que no tienen correo muestran sólo WhatsApp, confirmando la lógica móvil/correo.

## Estado

Prospección quedó como una **herramienta de outreach de trabajo diario**: buscar → cosechar WhatsApp/correo → abrir "Hoy" → contactar con un click (mensaje/propuesta lista) → todo trazado → exportar o convertir. Verificado end-to-end con datos reales.
