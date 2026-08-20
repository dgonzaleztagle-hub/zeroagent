---
name: audit-build-hygiene
description: >-
  Verifica que un build de runtime generado por ZeroAgent Studio (storage/agent-builds/<cliente>/)
  no mezcle archivos de OTRO cliente (credenciales .env, seeds de demo, datos ficticios de otro
  negocio), y que el manifiesto de instalación (INSTALLATION.json) liste todas las migraciones SQL
  que realmente existen en runtime-template/supabase/. Usa esta skill SIEMPRE después de generar
  un build nuevo, antes de copiarlo/desplegarlo a un cliente, o cuando el usuario pida "revisa el
  build de [cliente]", "¿el paquete está limpio?", "chequea que no se mezcle nada". Nace de un
  caso real (franciskom, 01-08-2026): el build ya generado contenía tanto .env.franciskom como
  .env.quiro-demo (credenciales reales de dos clientes mezcladas en disco), y el manifiesto sólo
  declaraba 1 de 3 migraciones SQL necesarias.
---

# Audit: higiene del build/paquete

El problema de fondo: `buildClientRuntime()` (en `server.js`, Studio) copia toda la carpeta
`runtime-template/` con `fs.cp`. Cualquier archivo que viva ahí — incluidos los `.env.<cliente>`
de uso local del operador, o SQL de seed de demo de otro cliente ficticio — se copia también,
salvo que el filtro de exclusión lo cubra explícitamente.

## Paso 1 — ¿El build contiene credenciales de OTRO cliente?

```bash
ls -la storage/agent-builds/<cliente>/<build>/ | grep -i env
```

Sólo debería aparecer `.env.example`. Si aparece cualquier `.env.<algo>` (sea del mismo cliente o
de otro), es un problema — el propio `BUILD.json` de cada build promete `"credentials": "not
included"`, así que ni siquiera el `.env` del cliente correcto debería estar ahí (las
credenciales reales se configuran en el hosting de destino, no se hornean en el build).

Si encuentras filtrado esperado ya aplicado (`buildClientRuntime` excluye `.env*` salvo
`.env.example` desde el 01-08-2026) pero igual aparece algo, es una regresión en ese filtro —
revisa la función en `server.js` antes de asumir que es sólo ese build viejo.

## Paso 2 — ¿Hay archivos de OTRO cliente ficticio mezclados?

```bash
grep -rl "Ignacio Prieto\|Vitalis\|Casa Aura" storage/agent-builds/<cliente>/<build>/ 2>/dev/null
```

(Ajusta los nombres de búsqueda a los clientes demo conocidos del momento — el objetivo es
cualquier nombre de negocio/persona que NO sea el cliente real de este build.) Encontrado una vez:
`supabase/_seed-demo.sql` con datos de un doctor ficticio de OTRO demo, copiado sin filtro a
cualquier build porque vive suelto en `runtime-template/supabase/`. No es tan grave como un
secreto (nunca se ejecuta solo), pero confunde y no debería estar ahí.

## Paso 3 — ¿El manifiesto de instalación lista TODAS las migraciones que existen?

```bash
ls runtime-template/supabase/*.sql
node -e "console.log(JSON.parse(require('fs').readFileSync('storage/agent-builds/<cliente>/<build>/INSTALLATION.json','utf8')).agenda.migration)"
```

Compara ambas listas a mano. Si `runtime-template/supabase/` tiene un `.sql` nuevo (porque se
agregó una feature) y `INSTALLATION.json` no lo menciona, un cliente instalado siguiendo sólo el
manifiesto queda con tablas faltantes — pasó con `agenda-v1-extras.sql` (handoffs, sugerencias) y
`agenda-v1-direct-data.sql` (datos/info del negocio), agregados como feature sin actualizar el
manifiesto que los declara.

## Paso 4 — ¿El `package.json` del build tiene lo que el Dockerfile/README asumen?

Si `runtime-template/Dockerfile` hace `CMD ["npm", "start"]`, confirma que
`runtime-template/package.json` de verdad tenga un script `start` que funcione (hoy usa
`_local-preview-wrapper.mjs`, el único lugar permitido para abrir un servidor HTTP real fuera de
Vercel — nunca agregar `createServer`/`.listen()` directo en `src/server.js`, Vercel lo detecta
por análisis de texto y rompe el deploy serverless).

## Qué hacer con lo encontrado

Secretos mezclados → limpiar el build ya generado (borrar los `.env` que no correspondan) y
arreglar el filtro en `buildClientRuntime` si el filtro mismo falló. Manifiesto incompleto →
actualizar la lista en `server.js` donde se genera `INSTALLATION.json`. Nunca asumas que un build
viejo ya generado antes de un fix de higiene está limpio retroactivamente — revísalo también.
