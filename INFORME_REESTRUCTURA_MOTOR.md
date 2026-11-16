# Revisión, correcciones y evaluación con GPT-6 Luna

Estado: candidata local evaluada en lectura; reestructura parcialmente implementada. No desplegada.
Francisco sigue pausado.
El alcance y los pendientes se detallan en `PLAN_REESTRUCTURA_MOTOR_V2.md`.

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

Se confirmó mediante lectura de Vercel que la configuración productiva actual sigue siendo:

- `LLM_MODEL=gpt-5.6-luna`.
- `RUNTIME_MODE=preview_local`, que explica el fallback observado cuando se agotó el crédito.

Se verificó que el control global continúa `paused` y que no hay mensajes automáticos registrados
desde la pausa solicitada. Cambiar el modelo o desplegar requiere portar y verificar la candidata;
no se cambió el entorno productivo ni se reactivó el bot durante estas pruebas.

## Límites que permanecen abiertos

- Replay histórico reproducible con dependencias congeladas y reloj uniforme en todas las capas.
- Consentimiento conjunto fecha/hora/modalidad y su invalidación completa ante cambios de idea.
- Consolidación de cortesía, vacío y flujo literal; reducción del contexto mutable de los checks.
- Extraer completamente la política de Francisco y conservarla al regenerar paquetes en Studio.
- Integración de escritura sobre staging aislado y observación posterior al despliegue.
- Decisión de memoria persistente tras medir tráfico real.

Un resultado verde en el banco no equivale a completar estos pendientes ni a certificar producción.
