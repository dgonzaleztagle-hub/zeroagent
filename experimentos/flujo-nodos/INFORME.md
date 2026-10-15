# Experimento: flujo de nodos vs. bot actual de franciskom · 14-10-2026

## Qué se probó

Mismo bot, mismas herramientas y mismos seguros de código; lo único que cambia es **cómo se le dan las
instrucciones al modelo**:

- **A · Actual (producción):** un prompt único con todas las reglas de ventas (`AGENDA_BEHAVIOR` +
  `system_prompt` del negocio, ~7.100 caracteres) en cada turno.
- **B · Flujo:** el código decide en qué etapa va la conversación (bienvenida, descubrir motivo,
  entender caso, ofrecer horas, cerrar reserva, con hora tomada) y sólo ese nodo se le entrega al
  modelo, más 9 "situaciones globales" que pueden aparecer en cualquier etapa (info oficial, urgencia,
  diagnóstico, freno de plata, otra persona, domicilio, cambio de hora, humano, cortesía). Prompt de
  ~5.000-5.500 caracteres (~25 % menos). Definición en `flow.js`.
- **C · Flujo sin las guardas de etapa:** como B pero apagando los reintentos del motor que hoy fuerzan
  "primero una pregunta" y "ahora ofrece horas". Para ver si el flujo los reemplaza.

Todo corrió contra la base real de franciskom en modo `dryRun` (nada se escribe, verificado: 0
escrituras bloqueadas en las 7 corridas), con el mismo modelo de producción, 2 veces por caso.

Dos bancos:
1. **Banco original:** 42 casos reales de franciskom (84 turnos con 2 corridas).
2. **Casos nuevos:** 11 casos que escribí después de ver el primer resultado (22 turnos), para comprobar
   que el flujo no sólo calza con lo que se usó para diseñarlo.

## Resultado en una línea

**El flujo no es mejor en general: empata con el bot actual en el banco original (82/84 ambos, después de
un ajuste), y gana en reglas de "situación" (urgencia, freno de plata) en los casos nuevos.** Su valor real
estuvo en otra parte: hizo visible 3 defectos que el bot de producción ya tiene.

## Cifras

| Motor | Banco original (84 turnos) | Casos nuevos (22 turnos) |
|---|---|---|
| A · Actual | **82** | 14 |
| B1 · Flujo, primera versión | 79 | 18 |
| B2 · Flujo, ajustado tras ver el banco original | **82** | 17 |
| C1 · Flujo sin guardas de etapa | 78 | no corrió |

Notas para leer bien la tabla:
- Son 2 corridas por caso y pocos casos: una diferencia de 1 o 2 turnos es ruido del modelo, no señal.
- En los casos nuevos corregí un error mío del chequeo (el caso "diagnóstico" marcaba como falla un
  "no puedo confirmar si tienes una hernia"); con eso ese caso pasa en los tres motores.
- B2 se ajustó mirando los fallos del banco original, así que su 82 no es una prueba limpia. Los casos
  nuevos se escribieron antes de ajustar B2 y B2 no se tocó después de verlos.
- No medí tokens ni costo por turno; sólo el tamaño del prompt.

## Dónde el flujo lo hizo mejor

- **Urgencia** (caso nuevo: "me caí de la escalera ayer y no puedo mover la pierna"): el bot actual
  hizo preguntas y **nunca mencionó acudir a urgencias** (0 de 2). El flujo lo mencionó 4 de 4. La regla
  existe en el prompt actual, pero está enterrada entre 7.000 caracteres; como nodo global explícito se cumple.
- **Freno de plata** ("está caro, no tengo la plata ahora"): el actual dijo que Francisco "puede
  conversar planes" y "no puedo ofrecer descuentos" (menciona lo que la regla dice que no se menciona);
  el flujo propuso una fecha concreta más adelante (3 de 4).
- **Hora tomada + "la sesión es en mi casa"** (caso con hora tomada): el actual falló 2 de 2 (le mandó el
  bloque de otra sede); el flujo pasó 2 de 2. Ojo: ese caso usa una fecha que ya pasó, así que no es
  concluyente.

## Dónde lo hizo peor (y por qué importa)

El flujo introdujo **fallos propios**, todos en el mismo lugar: decidir en qué etapa va la conversación.

1. **Un error de redacción tumbó un caso entero.** Escribí en la situación "info oficial" que "forma de
   pago" tiene bloque oficial; no lo tiene. Resultado: ante "¿qué tipo de pago?" el bot mandó la lista de
   precios (0 de 2). Corregida esa línea, pasó 2 de 2. **En un flujo, una línea mal puesta cambia el
   comportamiento de todos los clientes en esa situación.**
2. **El detector de etapa se equivocó.** Una regex no reconoció "¿Box Buin o a domicilio?" como pregunta
   de modalidad y la conversación quedó en la etapa equivocada. Corregido, pero es la clase de bug que
   un prompt largo no tiene.
3. **La etapa tapó la intención.** Alguien que escribe "¿puedo cambiar mi hora del sábado?" y es su
   primer mensaje en el hilo cayó en "bienvenida" y el bot le preguntó qué le molestaba. El prompt largo
   lo manejaba porque no tiene etapas. Arreglo: la etapa pasa a ser "lo que haces cuando nada más aplica".
4. **Un turno terminó en error** ("excedió el límite de pasos de herramientas") en una de las 86 corridas
   del flujo ajustado. No ocurrió en el bot actual.
5. **Los seguros de código siguen valiendo.** Sin las guardas de etapa (C) el resultado fue el peor de
   todos (78). El flujo no las reemplaza; las complementa.

## Defectos del bot ACTUAL que el experimento dejó al descubierto

Fallan igual en producción y en el flujo, así que no los causó el flujo. Son nuestros, y hay que arreglarlos:

1. **"¿Hasta qué hora atienden?" se trata como si pidiera hora.** El bot responde el horario y le ofrece
   horas de inmediato. La regla de Francisco (pregunta seca → pregunta cercana por su dolor, todavía sin
   horas) no se cumple. Causa: la palabra "hora" dispara el modo "ofrecer horas" (`ASKS_FOR_HOURS` en
   `engine.js`). 0 de 2 en los tres motores.
2. **Domicilio fuera de la zona (ej. Isla de Maipo): ofrece horas a domicilio igual.** La regla es
   ofrecer el Box Buin y avisar a Francisco; el bot dice que el traslado "lo confirma Francisco" y ofrece
   horas a domicilio. 0 de 2 en los tres motores.
3. **Urgencia sin mencionar** (descrita arriba). 0 de 2 en el actual.

## Qué concluyo

- **Reemplazar el bot actual por el flujo, hoy, no se justifica:** el banco original no mejora y el flujo
  agrega un punto de falla nuevo (la etapa).
- **La idea de fondo sí sirve, como método de construcción para clientes nuevos:** tener nodos y
  situaciones globales explícitos y nombrados obliga a escribir cada regla una sola vez, en un lugar
  donde se ve; y las reglas de "situación" se cumplieron mejor. Eso es lo que pediría para un cliente
  nuevo (con su propio banco de pruebas desde el día uno).
- **El mayor valor del experimento fue el banco de pruebas, no el flujo:** forzó a mirar el bot actual
  con casos nuevos y encontró 3 defectos reales.

## Qué no se probó

- Costo y latencia por turno (tokens no medidos).
- Un banco independiente y grande: 11 casos nuevos son pocos y los escribí yo, conociendo el diseño.
- Google Calendar: no había credenciales en esta máquina, así que las horas no se filtraron contra el
  Calendar en ningún motor (igual para los tres).
- Conversaciones largas de varios turnos reales: los casos son un mensaje sobre un historial armado.

## Archivos

- `flow.js` (versión ajustada) y `flow.v1.js` (primera versión): definición de nodos, globales y detector
  de etapa.
- `runtime/` y `runtime-v1/`: copia del runtime de franciskom con el motor modificado (ignoradas por git:
  traen datos del negocio).
- Banco de pruebas y registros completos: `storage/vault/replay-franciskom/` (ignorado por git: trae
  textos de pacientes). Se corre con `RUNTIME_DIR=<carpeta> FLOW_MODE=flow node bench.mjs - '' 2`
  (`HOLDOUT=1` para los casos nuevos) y se compara con `node compare.mjs A=<log> B=<log>`.
