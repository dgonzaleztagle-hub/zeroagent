# Reestructura del motor — plan vigente y estado verificable

Este documento reemplaza las instrucciones de ejecución de `PLAN_REESTRUCTURA_MOTOR.md`.
El documento original se conserva como diagnóstico histórico. Daniel autorizó la implementación,
la evaluación de GPT-6 Luna y el uso temporal de la API de Rishtedar exclusivamente para pruebas.
El bot de Francisco permanece pausado. La clave del restaurante nunca se instala en producción.

## Criterios de salida

- Las mutaciones exigen consentimiento comprobado y validaciones de agenda.
- El canal real exige modelo: no puede degradarse al buscador determinista por una variable de modo.
- La pausa vuelve a comprobarse inmediatamente antes de cada envío automático.
- Calidez natural y brevedad: no se exige usar frases como “pucha”, se preserva el prompt de tono.
- Las pruebas deterministas verifican ramas y efectos; los replays LLM evalúan conducta.
- Un replay contra la base viva se identifica como integración parcial: no es replay histórico
  determinista ni certifica Calendar si falta su conexión.
- Se conserva evidencia de cada corrida, sin sobrescribir resultados ni registrar secretos.

## Fases y estado local

| Fase | Estado | Evidencia / trabajo restante |
|---|---|---|
| 0. Banco y compatibilidad GPT-6 | Implementado localmente | Canario HTTP 200; banco con expectativas, trazas, consumo, reloj y agenda congelados; red restringida a inferencia. |
| 1. Cableado y seguridad inmediata | Implementado localmente | P1, reloj en motor/herramientas, consentimiento negativo/ambiguo, canal requireModel, pausa antes de enviar. Reloj SQL/disponibilidad viva sigue siendo real. |
| 2. Hilo canónico | Implementado localmente | actor explícito prevalece; notas no cortan ráfagas; jueces comparten etiquetas. Compatibilidad textual histórica preservada. |
| 3. Estado derivado | Implementado con transición | `turn-state.js` conserva diagnóstico; `booking-selection.js` comprueba la última elección de fecha/hora, rechazos, ambigüedad y cambios. Modalidad mantiene su guarda separada, verificada antes de crear. |
| 4. Borradores ordenados | Implementado con transición | `draft-checks.js` ejecuta lista ordenada asíncrona; preserva textos y contadores previos. Auditor también revisa reintentos y seguimientos literales. El contexto mutable todavía necesita simplificarse. |
| 5. Autorización y silencio | Parcial | Mutaciones en `tool-authorization.js`; ramas de herramientas de silencio en `silence-policy.js`. Cortesía/vacío y flujo literal conservan lógica en otros módulos; falta completar su consolidación. |
| 6. Agenda y SQL | Validado localmente | Herramientas reales sobre agenda congelada; SQL real y migraciones en PGlite: idempotencia, ocupación, identidad, rollback y permisos. Adaptador Calendar real probado con servidor simulado. Freebusy productivo verificado sólo en lectura. |
| 7. Política por negocio | Implementado localmente | Esquema versionado, perfil de Francisco en paquete y `client-policies`, preservación Studio, snapshots y prueba de construcción de barbería desde SQLite temporal. |
| 8. Memoria persistente | Decisión diferida por diseño | No es requisito de esta candidata: el estado se deriva con evidencia del hilo. No agregar memoria persistente sin una necesidad medida y reglas de invalidación. |

## Batería y aislamiento

`storage/vault/replay-franciskom/banco.mjs` carga los datos de Francisco y pasa explícitamente
la credencial del restaurante por `context.llm`. No modifica `.env` ni credenciales remotas.
Sólo admite lecturas y endpoints POST de inferencia/disponibilidad/freebusy; bloquea otras escrituras.
La corrida ampliada incluye 47 casos históricos y 6 casos de tono/seguridad.
Los datos de pacientes y resultados quedan en el vault gitignorado. Los seis casos nuevos son
sintéticos y viven en `runtime-template/test/conversation-cases.json`.

Cada salida informa silencios, herramientas, argumentos, guardas, errores, avisos, handoffs y
tokens. No hay equivalencia garantizada por una sola corrida. Si falla un caso, se revisa su traza
y se agrega una prueba determinista antes de repetir. La API no se utiliza para probar mecánica
que ya puede ejercitarse con respuestas guionadas.

## Verificación repetible de la candidata

- `npm run test:certify`: runtime, SQL real, paquete, fechas, afirmaciones, fichas,
  conocimiento, matcher, seguridad de preview, instalación limpia y preservación de políticas.
  Fuerza SQLite temporal para Studio y no utiliza las claves productivas.
- Guarda informe nuevo con SHA256 de las fuentes y rechaza corridas donde el código cambie
  durante la certificación. Los resultados privados quedan en `storage/vault/certification/`.
- `LLM_TEST_API_KEY=<clave autorizada> node scripts/verify-luna-conversations.mjs`: dos negocios
  sintéticos con Luna real, herramientas reales y agenda congelada; reserva, duda sin cancelar,
  reagenda y cancelación explícita. No exige frases fijas de empatía.
- Banco privado: `node storage/vault/replay-franciskom/banco.mjs <fase-nueva> gpt-6-luna --all --frozen`.
  Conserva la misma foto de catálogo/conocimiento, reloj, casos y huella del fixture. No vuelve a
  consultar producción durante los casos. Los historiales privados no se suben a GitHub.

## Resultados intermedios

La candidata posterior a esos resultados pasó 68/68 pruebas locales, 12/12 gates, 53/53
replays congelados con GPT-6 Luna y ocho turnos completos de dos negocios sintéticos.
Evidencia resumida: `reports/franciskom-luna6-2026-11-16.json`.

- Referencia inicial sobre los cambios locales anteriores: 28/30, sin excepciones.
- Correcciones ampliadas: 45/47; un límite de pasos y un fallo de expectativa.
- Repetición dirigida posterior a corregir la interferencia del juez: 2/2.
- Suite local: 47/47; gates de paquete, mutation-claims, timezone-parsing, customer-records,
  knowledge-regressions y regression-matcher pasan.
- Corrida con Calendar real: 52/53 expectativas históricas; una expectativa dependía de las 09:30,
  actualmente ocupadas. Las trazas y la repetición dirigida confirman alternativas reales a las
  08:00. Consultar `INFORME_REESTRUCTURA_MOTOR.md`; no se modifican resultados para ocultar fallos.

## Antes de desplegar o reactivar

1. Usar la candidata y evidencia indicadas en `INFORME_REESTRUCTURA_MOTOR.md`.
2. Aplicar `releases/franciskom-luna6.json` al desplegar y verificar también la selección BYOK
   efectiva: puede prevalecer sobre LLM_MODEL. Conservar exclusivamente la cuenta de Francisco.
3. Verificar despliegue, salud del proveedor y control `paused` antes y después del cambio.
4. Mantener pausa aun con créditos cargados. Reactivar únicamente por indicación de Francisco.

Los contratos de Calendar se ejercitan sin crear citas reales; no se confunde esa prueba con
una escritura productiva ni una prueba de carrera entre procesos independientes de PostgreSQL.

La candidata `8f5a924` ya está desplegada y verificada en producción como
`dpl_GAGg71vmKBtPjKB1B2u38imt7vXP`. Se conserva la pausa. El canario productivo confirma
créditos agotados; la activación queda reservada a la indicación de Francisco.
