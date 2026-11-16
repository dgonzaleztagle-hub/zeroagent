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
| 0. Banco y compatibilidad GPT-6 | Implementado localmente | Canario de tool calling HTTP 200; banco con expectativas, errores, traza y consumo. Falta congelar dependencias para replay histórico reproducible. |
| 1. Cableado y seguridad inmediata | Implementado localmente | P1, reloj en motor/herramientas, consentimiento negativo/ambiguo, canal requireModel, pausa antes de enviar. Reloj SQL/disponibilidad viva sigue siendo real. |
| 2. Hilo canónico | Implementado localmente | actor explícito prevalece; notas no cortan ráfagas; jueces comparten etiquetas. Compatibilidad textual histórica preservada. |
| 3. Estado derivado | Parcial | `turn-state.js`: señales, evidencia, candidato, consentimiento, cambios y turno de habla. Se registra como diagnostics, separado de herramientas. Falta consolidar la elección conjunta fecha/hora/modalidad y toda su invalidación. |
| 4. Borradores ordenados | Implementado con transición | `draft-checks.js` ejecuta lista ordenada asíncrona; preserva textos y contadores previos. Auditor también revisa reintentos y seguimientos literales. El contexto mutable todavía necesita simplificarse. |
| 5. Autorización y silencio | Parcial | Mutaciones en `tool-authorization.js`; ramas de herramientas de silencio en `silence-policy.js`. Cortesía/vacío y flujo literal conservan lógica en otros módulos; falta completar su consolidación. |
| 6. Simulación de escrituras | Parcial | Crear valida catálogo, identidad, apellido, zona, tiempo y disponibilidad; cancelación/perfil/handoff no escriben; reagenda conserva simulación. Freebusy real verificado; no certifica locks ni escrituras RPC/Calendar. |
| 7. Política por negocio | Pendiente | Extraer política de Francisco con esquema validado, preservación en Studio y snapshots de prompts; no hacer sustituciones textuales globales. |
| 8. Memoria persistente | Pendiente de observación | Decisión posterior al tráfico real; requiere evidencia e invalidación, no sólo booleanos guardados. |

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

## Resultados intermedios

- Referencia inicial sobre los cambios locales anteriores: 28/30, sin excepciones.
- Correcciones ampliadas: 45/47; un límite de pasos y un fallo de expectativa.
- Repetición dirigida posterior a corregir la interferencia del juez: 2/2.
- Suite local: 47/47; gates de paquete, mutation-claims, timezone-parsing, customer-records,
  knowledge-regressions y regression-matcher pasan.
- Corrida con Calendar real: 52/53 expectativas históricas; una expectativa dependía de las 09:30,
  actualmente ocupadas. Las trazas y la repetición dirigida confirman alternativas reales a las
  08:00. Consultar `INFORME_REESTRUCTURA_MOTOR.md`; no se modifican resultados para ocultar fallos.

## Antes de desplegar o reactivar

1. Cerrar la corrida actual y revisar también el texto completo, particularmente tono y errores.
2. Resolver los fallos que aparezcan; no marcar el plan entero como terminado por un replay verde.
3. Verificar el despliegue/credencial efectivos de Francisco y recuperar saldo de su cuenta.
4. La lectura de Calendar ya se verificó con configuración sólo en memoria; falta probar las
   escrituras de reservas sobre staging aislado.
5. Portar únicamente la candidata validada, manteniendo pausa, y verificar el despliegue real.
6. Reactivar sólo después de verificar salud del proveedor. La autorización de pruebas con la
   clave del restaurante no autoriza cambiar la cuenta productiva de Francisco.

Los cambios son locales; todavía no existe certificación productiva ni despliegue de GPT-6 Luna.
