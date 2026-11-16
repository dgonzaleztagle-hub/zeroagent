# Revisión, correcciones y evaluación con GPT-6 Luna

Estado: candidata validada y desplegada en producción con GPT-6 Luna. Francisco sigue pausado.

Despliegue verificado el 16-11-2026 a las 14:52 UTC: `dpl_GAGg71vmKBtPjKB1B2u38imt7vXP`,
código `8f5a924`, asignado a franciskom.cl. Configuración efectiva: OpenAI, `gpt-6-luna`,
`RUNTIME_MODE=production`, canal Zavu; selección de IA por entorno, sin override BYOK.
Se conservó la credencial de Francisco y la landing propia. Nueve comprobaciones HTTP pasaron,
incluido el control autenticado que confirma `paused`. El canario directo con su cuenta volvió
a dar 429 por créditos agotados. Sólo quedan cargar créditos y despausar por indicación de Francisco.
El alcance y los pendientes se detallan en `PLAN_REESTRUCTURA_MOTOR_V2.md`.

Resultado final de la segunda revisión: **68/68 pruebas locales, 12/12 gates, 53/53 casos
congelados con GPT-6 Luna y ocho turnos completos en dos negocios sintéticos**. Cero errores
del banco final y cero intentos de acceso externo fuera de inferencia durante los casos.
Resumen publicable y huellas: `reports/franciskom-luna6-2026-11-16.json`.
La corrida congelada final costó aproximadamente US$0,0302; es una estimación de inferencia,
no una consulta de saldo. Los resultados anteriores se conservan como historial.

## Cambios locales implementados

- Compatibilidad `gpt-6-luna` con Chat Completions y function calling, con razonamiento `none`.
- `answerTurn`, con alias retrocompatible `answerWithGroq`; errores identifican al proveedor.
- Hilo canónico con autor explícito y compatibilidad con notas históricas.
- Estado derivado registrado en diagnostics, separado de la evidencia de herramientas.
- Lista ordenada de controles de borrador asíncronos, autorización de mutaciones y política de
  silencio en módulos separados. Persisten áreas por simplificar: no se declara completa toda
  la separación arquitectónica ni la portabilidad hacia otros negocios.
- Reparación del parser del auditor; reauditoría de borradores rechazados y del seguimiento
  después de respuestas oficiales. Un segundo borrador sin respaldo se bloquea y avisa al dueño.
- Rechazo de hora negada y de cancelación ambigua; días próximos requieren evidencia.
- Una elección de hora aceptada se comunica explícitamente y no vuelve al descubrimiento clínico.
- Avisos al dueño también funcionan para ejercicios y seguimiento sin exigir una oferta comercial.
- Validación de precios contra el servicio identificado en el catálogo, incluyendo desglose.
- Rechazo del fallback determinista en el canal real aunque `RUNTIME_MODE` esté mal configurado.
- Relectura de pausa antes de mensajes automáticos y seguimientos.
- Simulación por operación que conserva validaciones antes de simular escrituras; handoff tampoco
  escribe con `dryRun`. Locks y mutaciones SQL reales no están certificados por esta simulación.

## Validación

- Suite runtime: 47/47 tests deterministas.
- Gates adicionales: paquete Agenda, mutation-claims, timezone-parsing, customer-records,
  knowledge-regressions y regression-matcher pasan.
- El gate de paquete tenía una fecha dependiente de la hora de ejecución: una sesión podía cruzar
  medianoche. El fixture ahora usa mediodía de America/Santiago.
- Canario real con API del restaurante: GPT-6 Luna respondió HTTP 200 y llamó la función pedida.
- Referencia inicial: 28/30, sin excepciones.
- Corrida ampliada intermedia: 45/47; un límite de pasos y una expectativa fallida. Ambos casos
  pasaron en una repetición dirigida tras corregir la interferencia entre elección y juez.
- Primera corrida posterior a extracción: 52/53, sin excepciones; el caso restante reofrecía horas.
- Revisión manual posterior detectó un precio equivocado que un banco superficial no habría
  certificado. Se añadió control por servicio y pruebas específicas.
- Corrida completa con Calendar real: 52/53 expectativas originales, sin excepciones ni intentos
  de escritura. `loop-recurso` esperaba pedir nombre para las 09:30, pero freebusy real sólo devuelve
  las 08:00: el bot ofreció esa alternativa. Es una premisa histórica invalidada por datos vivos.
- Repetición dirigida con Calendar después de aclarar el auditor: precio Box y domicilio pasan;
  los dos casos históricos de las 09:30 ofrecen las 08:00 porque la elegida no está libre. El
  auditor ya no rechaza esa explicación. Los resultados originales no se sobrescribieron y
  mantienen sus fallos de expectativa, documentados aquí en lugar de convertirlos en falsos verdes.
- Costo estimado de las corridas de esta ejecución: aproximadamente US$0,16, incluyendo una
  estimación conservadora para la referencia inicial sin detalle de caché. No es un balance de cuenta.

## Tono observado

En casos sintéticos el modelo produjo espontáneamente mensajes como:

> Pucha, qué lata que el dolor te esté quitando el sueño. ¿Hace cuánto partió?

No se introdujo una regla que exija “pucha” ni una frase de empatía determinada. Los ejemplos no
certifican todo el tono posible; se revisó también que una consulta seca de precio no provoque
lástima ni que un cliente que posterga reciba una lista insistente de horas.

## Aislamiento y producción

La clave de Rishtedar sólo se usa dentro del proceso de prueba. No se editó su repositorio,
configuración ni despliegue. El banco registra tokens/costo estimado y bloquea escrituras remotas.
La configuración de cifrado/OAuth de Francisco se pudo consultar en Vercel y cargar únicamente
en memoria para freebusy; no se escribió en archivos env.
Google informa que el calendario público de feriados no es legible y lo descarta; la conexión
operativa de Calendar sí se usó en la última corrida.

Antes del despliegue se confirmó mediante lectura de Vercel esta configuración productiva:

- `LLM_MODEL=gpt-5.6-luna`.
- `RUNTIME_MODE=preview_local`, que explica el fallback observado cuando se agotó el crédito.

Durante esa evaluación de la candidata no se cambió el entorno productivo ni se reactivó el bot.
El despliegue posterior solicitado por Daniel está documentado al principio de este informe;
la pausa se conservó y se verificó desde el runtime publicado.

## Segunda revisión: contratos y repetibilidad

- El motor acepta dependencias explícitas del banco para congelar las lecturas externas sin
  cambiar el recorrido productivo. Las herramientas reales validan las solicitudes; los efectos
  del banco se confirman en una agenda local y nunca se escriben en producción.
- `booking-selection.js` valida la última elección cronológica y evita cruzar días/horas antiguos.
  Se verifican negaciones, preguntas, alternativas, meses, años, fechas inválidas y fechas relativas
  ancladas al mensaje. La propiedad de minutos recorre 24 horas por cuatro minutos por dos
  formatos, con elección escrita y aceptación, y rechaza el minuto vecino.
- La primera corrida congelada dio 52/53. Reveló una falla del lector: la rama «las 09» consumía
  parcialmente «las 09:30». Se corrigió la lectura completa, no la expectativa del caso.
- Se verificaron RPC y migraciones reales en PostgreSQL embebido (PGlite): duplicación, choque
  de horarios, pertenencia al teléfono, rollback de reagenda, liberación de cupo y permisos.
- Se probaron las funciones reales de Calendar con HTTP simulado: rutas por sede/modalidad,
  invitación por correo, cambio/borrado en el calendario original, 404/410, caída de OAuth y
  freebusy transitorio. No se crean eventos ni se mandan invitaciones reales.
- El perfil de Francisco vive en datos versionados. Se preserva al guardar desde Studio incluso
  si la interfaz omite el campo. Se construyó y verificó una barbería desde una base SQLite temporal.
- Dos negocios sintéticos completaron ocho turnos con Luna real: reservar, postergar confirmación
  sin anular, reagendar y cancelar. Una revisión textual detectó que el marcador dry_run del
  simulador confundía al auditor; el banco ahora comunica éxito sólo después del efecto local.
  La repetición posterior pasó los ocho turnos y la explicación del cambio.
- La pausa se prueba por salida: estado pausado, estado desconocido o fallo de lectura impiden
  enviar. Una lectura remota posterior confirmó que Francisco sigue `paused`.

## Alcance de la candidata y operación

- Consolidación de cortesía, vacío y flujo literal; reducción del contexto mutable de los checks.
- La separación arquitectónica de esos bloques sigue siendo gradual; los contratos observables
  se verifican antes de cualquier despliegue. No se presenta esa limpieza como un requisito nuevo.
- Las pruebas locales no certifican disponibilidad futura de OpenAI, entrega real de WhatsApp,
  escrituras reales de Google ni concurrencia entre procesos independientes de PostgreSQL.
- La publicación y la activación son pasos distintos. La configuración objetivo y el orden de
  verificación están en `releases/franciskom-luna6.json`; recuperar saldo no autoriza activar.

El archivo `runtime-template/CANDIDATA_LUNA6.md` acompaña al paquete preparado. El bot seguirá
pausado hasta la instrucción expresa de Francisco; la cuenta del restaurante no viaja en el paquete.
