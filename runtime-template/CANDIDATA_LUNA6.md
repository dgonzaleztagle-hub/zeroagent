# Candidata GPT-6 Luna de Francisco

Esta carpeta contiene el runtime preparado para `gpt-6-luna`. El código no cambia por sí solo
el modelo desplegado ni activa el bot. La instrucción vigente es mantener la pausa hasta que
Francisco indique expresamente lo contrario, incluso después de cargar créditos.

Configuración objetivo: `LLM_PROVIDER=openai`, `LLM_MODEL=gpt-6-luna`,
`RUNTIME_MODE=production`, `CHANNEL_PROVIDER=zavu`. Conservar las credenciales de Francisco.
Si existe selección BYOK en Supabase, su modelo prevalece y debe verificarse también.
Nunca instalar la clave del restaurante en este runtime desplegado.

Verificación local desde la raíz del repositorio: `npm run test:certify`.
Prueba optativa de conversaciones con modelo real: definir `LLM_TEST_API_KEY` y ejecutar
`node scripts/verify-luna-conversations.mjs`. No carga claves de producción automáticamente.
Ambos comandos generan evidencia nueva, sin sobrescribir corridas anteriores, dentro del vault.
Los replays de conversaciones históricas permanecen privados; no viajan en este artefacto.

La certificación local cubre el coordinador, herramientas, SQL y construcción del paquete.
Las pruebas de modelo congelan la agenda y simulan sus escrituras localmente. Esto no equivale
a enviar mensajes ni a crear eventos reales de Google Calendar. El despliegue se verifica con
la pausa conservada; cargar créditos nunca debe reactivar al bot automáticamente.
