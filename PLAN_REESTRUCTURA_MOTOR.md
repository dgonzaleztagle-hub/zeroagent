# Plan de reestructura del motor del bot (runtime-template)

> Plan vigente y estado de ejecución: [PLAN_REESTRUCTURA_MOTOR_V2.md](PLAN_REESTRUCTURA_MOTOR_V2.md).
> Este documento conserva la propuesta original; para ejecutar, usar V2.

Escrito el 15-11-2026 por el modelo grande, para que lo ejecute Sonnet en sesiones nuevas, una fase
por sesión. Estado: **aprobado por Daniel; ejecución iniciada por Codex.**

> **Revisión de ejecución · 15-11-2026 (Codex).** Daniel aprobó ejecutar la reestructura y
> migrar de `gpt-5.6-luna` a `gpt-6-luna`, usando la cuenta productiva para los replays. Antes de
> ejecutar se corrigió el diseño con estas condiciones: el banco combina pruebas deterministas con
> un replay vivo; el autor del hilo viaja como dato explícito y no sólo como nota textual; la ficha
> diagnóstica no entra en `toolTrace`; los seguros admiten evaluación asíncrona y efectos explícitos;
> autorización, ejecución y postprocesamiento de herramientas son capas distintas; `dryRun` se
> simula por operación; y el reloj del turno se inyecta también en `agenda-tools.js`.
>
> Primer canario de `gpt-6-luna`: bloqueado antes de inferencia con HTTP 429, `You have no credits
> remaining`. No es un rate limit temporal. Hasta recuperar saldo no se cambia el modelo de Vercel
> ni se genera una línea base falsa. Avance seguro ya realizado en el template: compatibilidad de
> Chat Completions con GPT-6 Luna (`reasoning_effort:none`), P1, reloj inyectable, hilo canónico y
> pruebas unitarias; `npm test` pasa 34/34.

Alcance: solo el motor de conversación de `runtime-template/src` (lo que decide qué contesta el bot
y cuándo agenda). Fuera de alcance: consolas, Studio, Google Calendar, Zavu, base de datos.

Cómo se hizo el análisis: lectura completa de `engine.js`, `turn-decision.js`,
`conversation-judge.js`, `grounding-judge.js`, `consent-guards.js`, `turn-guards.js`,
`base-behavior.js`, `agenda-behavior.js`; lectura parcial de `agenda-tools.js` (definición de
herramientas y códigos de error), `server.js` (camino del mensaje entrante) y `conversations.js`
(armado del historial); contraste con los incidentes escritos en `PROJECT_CONTEXT.md` (14-10 al
15-11) y `AUDITORIA_FRANCISKOM_2026-10-15.md`. Cero replays, cero llamadas al modelo.
No se leyó: `agenda.js`, `google-calendar.js`, `zavu.js`, `handoffs.js`, el resto de `server.js`.

---

## 1. Cómo está armado hoy

Un mensaje de WhatsApp recorre esto:

1. `server.js` (webhook): espera corta por si el cliente sigue escribiendo, revisa pausa, traspaso,
   contacto silenciado y adjuntos sin texto. Arma el historial (últimos 20 mensajes) con notas de
   sistema que marcan qué escribió Francisco.
2. `engine.js`, función `answerWithGroq`: **una sola función de unas 820 líneas** que hace todo lo
   demás, en este orden:
   - compuerta de cortesía ("gracias", "ok") por lista de palabras: se calla sin llamar al modelo;
   - clasificador de ruta (1 llamada al modelo): consulta clínica, cita no verificada, respuesta al
     dueño, reserva, otro. Las tres primeras las resuelve el código con texto fijo, aviso o silencio;
   - arma el prompt (reglas base + reglas de agenda + catálogo + prompt del cliente + fechas + hechos);
   - bucle de hasta 7 vueltas con el modelo. En cada vuelta el modelo o escribe un borrador o pide
     una herramienta;
   - **si escribe un borrador**, pasa por unos 11 seguros en fila (horas no consultadas, eco de
     pregunta, juez de ritmo, menciones obligatorias y prohibidas, pide permiso para agendar, fuga
     de texto interno, repetición, auditor de respaldo, afirmación de cita sin evidencia). Cada
     seguro que rechaza le devuelve al modelo un "ese mensaje NO se envió, corrige esto" y gasta
     una vuelta;
   - **si pide una herramienta**, antes de ejecutarla pasa por otros seguros (unos 25 caminos
     distintos): no agendar sin hora elegida, sin día nombrado o sin modalidad; no cancelar sin que
     el cliente lo pida; no avisar al dueño sin haber ofrecido horas; cuándo puede callarse; cuándo
     puede mandar un bloque literal.
3. `agenda-tools.js` ejecuta la herramienta y aplica sus propias validaciones (apellido, zona de
   domicilio, hora ocupada).

Por turno hay hasta cuatro tipos de llamada al modelo (clasificador, conversación con hasta 7
vueltas, juez de ritmo, auditor), todas con la misma clave de producción. Medido el 15-10: 13.900
tokens de entrada por turno en promedio, 22 segundos de mediana.

## 2. Dónde la estructura misma produce errores

Esto es distinto de los errores puntuales: son las razones por las que arreglar uno suele dejar otro.

**E1. El bot no tiene ficha de la conversación.** Qué modalidad eligió el cliente, qué día se
habló, qué hora aceptó, si ya se le ofrecieron horas: nada de eso se guarda. Cada turno se vuelve a
deducir leyendo el texto con expresiones regulares, y **cada seguro lo deduce por su cuenta, con su
propia regla y su propia ventana de mensajes**. Casi todos los incidentes graves son de esta clase:
Pilar (modalidad), El Recurso (el 10-11, bucle sin agendar), Marjorie (día 19 por 26), Claudia
(cancelación), "sábado 14". Además, lo dicho hace más de 20 mensajes desaparece.

**E2. La misma decisión se toma en varios lugares.** Callarse se decide en cinco sitios (compuerta
de cortesía, ruta "respuesta al dueño", cinco ramas de `no_intervenir`, borrador vacío, y `server.js`).
Avisar al dueño, en cinco. Cuando se corrige uno, los otros quedan con la regla vieja. Es el patrón
"se arregló un lado y no el otro" de la auditoría del 19-08, ahora dentro de un solo archivo.

**E3. Los seguros se pisan.** Todos comparten las 7 vueltas, cada uno con su propio tope (vuelta 3,
4 o 5) y su propia bandera de "ya disparé". El juez dice "no ofrezcas horas" y el seguro de cierre
dice "ofrece horas"; se resolvió con banderas sueltas (`closingRetried`, `clientIsWaiting`). El
orden importa y no está escrito en ningún lado: es el orden en que quedaron los `if`. Los últimos
seguros de la fila son los que se saltan cuando las vueltas se acaban.

**E4. Los jueces leen un hilo peor que el del clasificador.** El clasificador distingue CLIENTE,
ASISTENTE y FRANCISCO. El juez de ritmo y el auditor no: para ellos las notas de sistema son
"CLIENTE" y lo que escribió Francisco es del bot. Tres funciones distintas arman el mismo hilo de
tres maneras.

**E5. Reglas por palabras conviven con "juicio, no reglas".** Siguen vivas listas de palabras para
"trae un pedido nuevo", "posterga", "pide permiso", "duda de su hora", "domicilio". La del 15-11
("domicilio" activó la regla de visita en una pregunta que no era eso) es de esta clase.

**E6. El motor genérico tiene a Francisco adentro.** "Francisco", kinesiología, "Buin", "centro
médico" y la kinesiología respiratoria están escritos en 15 archivos de `src` (25 veces solo en
`engine.js`, 13 en `turn-decision.js`), incluidos los prompts del clasificador y del juez. Para un
segundo cliente hoy habría que editar el motor, no el paquete. Esto es lo que más pesa para el
negocio: es lo que impide vender el mismo motor a otro rubro.

**E7. El banco de pruebas no prueba lo que valida la herramienta.** Con `dryRun`,
`agenda-tools.js` corta antes de sus validaciones (línea 265) y devuelve éxito. Un verde del banco
no certifica zona, apellido ni fecha. Ya lo decía la auditoría del 15-10 y sigue igual.

### Errores puntuales encontrados leyendo (no arreglados)

- **P1. El auditor de respaldo nunca rechaza nada.** `grounding-judge.js`, `parseAuditVerdict`:
  exige que el veredicto traiga `clase` igual a `paradero` o `cita`, pero el prompt solo le pide al
  modelo `sin_respaldo`, `detalle` y `promete_aviso`. Comprobado sin gastar API: con
  `{"sin_respaldo":true,...}` devuelve `unsupported: false`. Está así desde que se creó el archivo
  (commit `414c85a`, 03-11). O sea: el seguro general contra "Francisco ya va en camino" está
  desconectado; lo que sí funciona es la parte de `promete_aviso`. Cada turno paga esa llamada.
- **P2.** `suggestedSlotsForFollowUp` usa `Date.now()` en vez del reloj del turno (`nowDate`): en
  replay con fecha fija calcula con la fecha real.
- **P3.** La función se llama `answerWithGroq` y los errores dicen "Groq"; producción usa OpenAI.
  Solo confunde al leer logs.

## 3. Alternativas

**A. No cambiar la estructura; seguir arreglando caso a caso.**
Gana: cero riesgo de regresión hoy. Pierde: cada arreglo sigue costando un replay grande y sigue
habiendo ramas gemelas; no sirve para un segundo cliente. Costo: el que ya se está pagando.

**B. Ordenar por dentro, sin cambiar lo que el bot hace.** Mismo bucle y mismos seguros, pero cada
cosa en un solo lugar: un hilo etiquetado, una ficha del turno, una lista ordenada de seguros de
borrador, un módulo que autoriza herramientas, una política de silencio, y lo de Francisco en el
paquete. Gana: E2, E3, E4, E6 y la mitad de E1; cada fase se puede verificar porque el
comportamiento tiene que quedar igual. Pierde: no mejora por sí sola la conversación. Costo: 7
fases cortas.

**C. Reescribir sobre otro esquema (flujo de nodos, Parlant).** Ya se probó dos veces con datos:
nodos (14-10) empató y agregó fallas propias; Parlant (08-11) no resuelve el estado duro. No se
repite.

**D. Ficha guardada en base de datos + reserva por identificador de hora.** Es la otra mitad de
E1 (lo dicho hace más de 20 mensajes, la evidencia de cada elección). Gana: memoria real de la
reserva. Pierde: aparece un problema nuevo, la ficha desactualizada (el cliente cambia de idea,
Francisco agenda por teléfono). Costo: migración SQL, modo sombra y un plan propio.

## 4. Recomendación

**B ahora; D solo después, y solo si la ficha derivada de la fase 3 muestra que hace falta.**

Razones: el motor no está mal pensado, está apilado. Las piezas correctas ya existen (clasificador
con acciones en código, seguros de consentimiento como funciones puras, fechas resueltas en
código). Lo que falta es que cada decisión viva en un solo sitio. B se puede hacer sin apostar la
relación con Francisco, porque casi todas las fases tienen como verificador "el bot hace
exactamente lo mismo que antes".

Lo que B no arregla, para no venderlo de más: el tono, el ritmo de venta y que el bot hable en
hilos de contactos personales o pacientes en curso. Eso último es una decisión de producto
pendiente (filtro por contacto), no de estructura, y es de las que más molesta a Francisco.

Genérico o del cliente: todo B es genérico y portable. La fase 7 es la que convierte el motor en
producto para otro rubro.

---

## 5. Reglas para quien ejecuta (Sonnet)

1. **Una fase por sesión.** Leer este archivo completo y `PROJECT_CONTEXT.md` antes de empezar.
   No empezar una fase si la anterior no quedó marcada como hecha en la sección 7.
2. **Ante algo no previsto en este plan, parar, anotarlo y no resolverlo.** Se anota en la sección
   8 de este archivo y como pendiente con `agregar-pendiente.js`. Vale para: un test que falla por
   algo que la fase no tocó, un caso del banco que cambia de resultado, un archivo que no calza con
   lo descrito, una duda de regla de negocio.
3. **En las fases marcadas "sin cambio de conducta" no se cambia ningún texto que lea el modelo ni
   ninguna condición.** Se mueve código, no se mejora. Si al moverlo se ve un error, se anota en la
   sección 8.
4. **Banco: una corrida por fase, dos como máximo.** La segunda solo si la primera tuvo
   diferencias, para distinguir variación del modelo de regresión. Nunca con la clave de
   producción (fase 0). Ningún otro replay.
5. **No se despliega sin el OK de Daniel.** Al terminar la fase: commit local en el template,
   informe corto (qué se movió, resultado del verificador, qué no se verificó) y esperar. Con su
   OK: copiar al clon de franciskom, `npm test`, commit, push, comprobar en Vercel que el deploy
   quedó READY y que franciskom.cl responde.
6. **No tocar:** `.env*` existentes (solo se crea `.env.replay`), la base de datos, el paquete de
   producción de franciskom salvo en la fase 7, las consolas.
7. Fechas y horas siempre con el reloj del turno (`nowDate`) y zona `America/Santiago`.
8. Las ubicaciones se dan por nombre de función o de bandera, no por número de línea: los números
   se mueven con cada fase.

## 6. Fases

### Fase 0 · Preparación (no toca el motor)

Requisito de Daniel: una clave de OpenAI aparte de la de Francisco, con tope de gasto (US$5
alcanza para todo el plan).

- Crear `runtime-template/.env.replay` (ya cubierto por `.gitignore`) con `LLM_API_KEY`,
  `LLM_MODEL`, `LLM_PROVIDER`, `LLM_BASE_URL` de la clave de pruebas. El modelo, el mismo de
  producción (leer `LLM_MODEL` del proyecto en Vercel, no del archivo local).
- Crear `storage/vault/replay-franciskom/banco.mjs` a partir de `engine-run2.mjs`: carga
  `.env.franciskom`, **pisa las variables `LLM_*` con `.env.replay` y se niega a correr si ese
  archivo no existe**; corre cada caso una vez; guarda por caso el texto, si fue silencio, la ruta,
  y las herramientas con sus argumentos en `out/<fase>.json`; anota cada corrida en `out/runs.log`
  y se niega a correr una tercera vez la misma fase.
- Banco fijo, 30 casos: `casos/cases.json` (15), `casos/cases3.json` (7), `casos/cases5.json` (5)
  y `cases-1511.json` (3). Ya están copiados en `storage/vault/replay-franciskom/casos/`.
- Agregar `compara.mjs`: compara dos archivos de `out/` e informa, por caso, si cambió el silencio,
  la ruta, las herramientas llamadas o sus argumentos. El texto no se compara palabra por palabra.
- Correr la línea base una vez con el código actual: `out/base.json`.

Verificador: existe `out/base.json` con 30 casos; `runs.log` muestra una corrida; ejecutar
`banco.mjs` sin `.env.replay` falla con mensaje claro.

### Fase 1 · Arreglos de cableado (cambia conducta, poco)

- P1: en `parseAuditVerdict` quitar la condición de `clase`; `unsupported` pasa a ser
  `verdict.sin_respaldo === true`. Agregar `test/grounding-judge.test.mjs` con tres casos: con
  respaldo, sin respaldo, JSON inválido (no bloquea).
- P2: `suggestedSlotsForFollowUp` recibe el reloj del turno.
- No se toca P3 todavía (se hace en la fase 3, cuando se parte la función).

Decisión ya tomada: se conecta el auditor tal como fue diseñado el 03-11, no se rediseña. Riesgo
conocido: al empezar a rechazar de verdad puede gastar una vuelta en turnos donde antes no, y
aparecer el error "excedió el límite de pasos". Por eso el verificador mira eso primero.

Verificador: `npm test`; banco contra `base.json`. Se acepta: mismos silencios, rutas y
herramientas. Se informa a Daniel, caso por caso, cada turno donde el auditor rechazó (queda en la
traza como seguro disparado) y cualquier caso que termine en error de límite de pasos. Si hay uno
solo de estos últimos, no se despliega.

### Fase 2 · Un solo hilo etiquetado (cambia conducta, poco)

- Archivo nuevo `src/thread.js` con `labelThread(history)`: es el `labelHistory` de
  `turn-decision.js`, movido. Devuelve cada mensaje con quién habla: cliente, asistente, dueño,
  saludo automático, nota.
- `formatRouterInput`, `formatJudgeInput` y `formatAuditInput` pasan a usarlo. El juez y el auditor
  empiezan a ver "FRANCISCO:" separado y dejan de ver las notas de sistema como "CLIENTE".
- En los prompts del juez y del auditor, una sola frase nueva que explique la etiqueta, copiada de
  la que ya tiene el clasificador. Nada más.

No se toca: el historial que recibe el modelo conversacional.

Verificador: tests unitarios nuevos de `labelThread` (hilo con eco de Francisco, con saludo
automático, con nota de "ya atendido"); `npm test`; banco contra `out/fase1.json`: mismos silencios,
rutas y herramientas.

### Fase 3 · Ficha del turno (sin cambio de conducta)

- Archivo nuevo `src/turn-state.js` con `deriveTurnState({ history, message, catalog, upcoming,
  toolTrace, now })`. Devuelve un objeto con todo lo que hoy se deduce suelto: modalidad
  establecida, día conversado, hora elegida por el cliente, oferta concreta hecha, cliente posterga,
  cliente trae pedido nuevo, cliente duda de su hora, reserva vigente, reserva cambiada en este
  turno, quién lleva el hilo.
- Se mueven ahí, sin editarlas, las funciones de `consent-guards.js` y las expresiones regulares
  equivalentes que hoy están dentro de `answerWithGroq` (buscar por nombre: `bringsNewRequest`,
  `postponesConfirmation`, `doubtedBookingNow`, `concreteOfferMade`, `asksPermissionToBook`,
  `postponesSale`). `consent-guards.js` queda reexportando para no romper los tests.
- Lo que depende de la traza de herramientas del turno se recalcula después de cada herramienta.
- La ficha se agrega a la traza del turno (`{ name: 'state', result }`): desde aquí se puede ver en
  producción qué creyó el bot en cada turno sin reproducirlo.
- Se renombra `answerWithGroq` a `answerTurn`, dejando el nombre viejo exportado como alias.

Decisión ya tomada: la ficha se **deriva** en cada turno, no se guarda. Guardarla es la alternativa
D y se decide después, mirando en la traza cuántas veces la ficha derivada se equivoca.

Verificador: `npm test` (los tests de consentimiento pasan sin cambios); banco contra
`out/fase2.json`: idéntico en silencios, rutas, herramientas y argumentos.

### Fase 4 · Seguros de borrador como lista ordenada (sin cambio de conducta)

- Archivo nuevo `src/draft-checks.js`: una lista en el mismo orden actual, cada elemento con
  `id`, `maxRound`, `once`, `applies(ctx)` y `check(draft, ctx)` que devuelve nada o
  `{ guard, instruction }`. El bucle de `engine.js` recorre la lista en vez de tener los `if` en fila.
- Las banderas sueltas (`hoursRetried`, `echoRetried`, `closingRetried`, `leakRetried`,
  `repeatRetried`, `groundingRetried`, `mutationRetried`, `stageRejections`) pasan a un solo
  contador por `id`.
- La precedencia entre el juez de ritmo y el seguro de cierre queda escrita como dato en la lista
  (hoy es una condición escondida), sin cambiarla.

No se toca: el texto de ninguna instrucción, ningún tope de vuelta, el orden.

Verificador: test unitario que recorre la lista con borradores de ejemplo y comprueba qué seguro
dispara (uno por seguro, sin modelo); banco contra `out/fase3.json`: idéntico, incluidos los
seguros disparados por caso.

### Fase 5 · Autorización de herramientas y silencio, cada uno en su módulo (sin cambio de conducta)

- Archivo nuevo `src/tool-authorization.js` con `authorizeToolCall(name, args, state, ctx)`:
  devuelve permitir, o negar con `{ error, instruction, ownerAlert }`. Se mueven ahí las ramas que
  hoy están antes de `executeAgendaTool` para `create_appointment`, `reschedule_appointment`,
  `cancel_appointment`, `avisar_al_dueno`, `responder_textual`.
- Archivo nuevo `src/silence-policy.js` con una función por momento (antes del modelo, cuando el
  modelo pide `no_intervenir` o `ignorar_mensaje_ajeno`, cuando el borrador viene vacío). Las cinco
  ramas de `no_intervenir` y la compuerta de cortesía se mueven ahí.
- `engine.js` queda como coordinador: contexto, ruta, prompt, bucle, salida.

Verificador: tests unitarios por rama (una ficha de entrada, un resultado esperado, sin modelo);
banco contra `out/fase4.json`: idéntico.

### Fase 6 · Banco fiel (no toca producción)

- En `agenda-tools.js`, el corte de `dryRun` se mueve desde el inicio de `executeAgendaTool` hasta
  justo antes de escribir en la base: con `dryRun` corren todas las validaciones (apellido, zona,
  fecha, aviso mínimo, hora ocupada) y solo se simula la escritura.
- Antes de mover, confirmar con una búsqueda que ningún camino de producción pasa `dryRun` (el
  15-11 `server.js` no lo usaba). Si alguno lo usa, parar y anotar.

Verificador: tests unitarios nuevos (reserva en fecha pasada, fuera de zona y sin apellido con
`dryRun` devuelven el error real, no éxito); banco contra `out/fase5.json`. Aquí **sí se esperan
diferencias**: cada caso que antes pasaba y ahora recibe un error de validación se lista para
Daniel. Son huecos que el banco escondía, no regresiones.

### Fase 7 · Lo de Francisco sale del motor (sin cambio de conducta para franciskom)

- Campos nuevos en el paquete del cliente, bajo `agent`: `owner_name`, `practice_brief` (una
  frase: qué hace el negocio y qué cuenta como consulta que solo responde el dueño),
  `discovery_points` (las tres cosas que el juez quiere saber antes de ofrecer horas) y
  `external_place_words`. No existen hoy: se crean, y se rellenan en el paquete de franciskom con
  exactamente lo que hoy está escrito en el código.
- En `src`, todo "Francisco", "kinesiólogo", "Buin", "centro médico" y la regla de kinesiología
  respiratoria se reemplaza por esos campos. Los prompts del clasificador, del juez y del auditor
  se arman con ellos. El texto final que recibe el modelo para franciskom tiene que quedar igual
  carácter por carácter.
- Ojo, efecto dominó conocido: si Studio regenera `agent-package.json` estos campos se pierden.
  Studio tiene que dejarlos pasar (como se hizo con `home_visit_zone`); la interfaz para editarlos
  no entra en esta fase.

Verificador: test que arma los tres prompts con el paquete de franciskom y los compara con una copia
guardada de los prompts de antes de la fase; búsqueda de "francisco", "kinesi" y "buin" en `src`
devuelve cero fuera de comentarios; banco contra `out/fase6.json`: idéntico. Segundo verificador:
armar los prompts con `.env.quiro-demo` y su paquete y leer que no nombren a Francisco.

### Fase 8 · Decidir sobre la ficha guardada (no es de ejecución)

Con dos semanas de tráfico real tras la fase 3, leer de la traza cuántos turnos tuvieron la ficha
derivada equivocada y por qué. Si la causa es "se dijo hace más de 20 mensajes" o "no hay cómo
saber qué eligió", vale la alternativa D y se escribe su plan aparte (migración, evidencia por
dato, invalidación, modo sombra). Si no, se cierra.

## 7. Estado de las fases

| Fase | Estado | Fecha | Commit template | Desplegado |
|------|--------|-------|-----------------|------------|
| 0 | pendiente | | | no aplica |
| 1 | pendiente | | | |
| 2 | pendiente | | | |
| 3 | pendiente | | | |
| 4 | pendiente | | | |
| 5 | pendiente | | | |
| 6 | pendiente | | | no aplica |
| 7 | pendiente | | | |
| 8 | pendiente | | | no aplica |

## 8. Cosas no previstas (las anota quien ejecuta)

(vacío)
