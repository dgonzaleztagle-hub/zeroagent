# ZeroAgent — contexto de este repo

Antes de diseñar, cambiar o delegar trabajo en este proyecto, **leer `PROJECT_CONTEXT.md`
completo** — es la bitácora viva del proyecto, se actualiza en cada hito y no contiene secretos.

## Lo mínimo que cualquier sesión debe saber de entrada

- **Studio** (`server.js`, `app.js`, puerto 8080) es la herramienta interna de Daniel para
  construir/versionar clientes. **`runtime-template/`** es lo que realmente se entrega a cada
  cliente — no confundir uno con otro.
- **El estándar de demo para un cliente nuevo, desde el 30-07-2026, es: consola móvil nativa
  (`runtime-template/public/m/`) + Supabase propio del cliente + despliegue a Vercel.** Docker/VPS
  quedó obsoleto como camino principal. Ver la sección **"Estándar de demo por cliente ·
  30-07-2026"** en `PROJECT_CONTEXT.md` para el procedimiento paso a paso — incluye un bug real
  de detección de framework en Vercel que costó horas de debugging la primera vez; no repetirlo.
- Cada cliente tiene su **propio proyecto Supabase y su propio proyecto Vercel** — nunca mezclar
  infraestructura entre clientes (p. ej. Rishtedar). Si el conector MCP de Vercel/Supabase
  pre-conectado en el entorno no es la cuenta correcta para el cliente en cuestión, pedirle a
  Daniel un token de acceso de la cuenta correcta en vez de usar el conector por defecto.
- Nunca poner secretos (tokens, service role keys) en memoria de IA en texto plano ni en archivos
  del repo que no estén cubiertos por `.gitignore`. Van en `.env.*` locales, con un puntero (sin
  el valor) en la memoria de sesión si hace falta recordarlos entre conversaciones.
- Antes de asumir que algo "ya se puede dar por listo", verificar en el navegador real (Vercel
  real, no sólo `curl`) — es política del proyecto, no una sugerencia.
