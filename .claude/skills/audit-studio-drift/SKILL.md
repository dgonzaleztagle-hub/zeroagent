---
name: audit-studio-drift
description: >-
  Verifica que lo aprobado en ZeroAgent Studio (conocimientos, config de Agenda, checklist de
  infraestructura) coincida realmente con lo que está embebido en la última versión APROBADA y
  con lo que hay desplegado en producción para un cliente. Usa esta skill SIEMPRE antes de
  declarar un cliente "listo", antes de una demo, antes de decirle a Daniel que "está todo
  sincronizado", o cuando pida "audita [cliente]", "revisa el estado de Studio", "¿está al día la
  versión de X?", "resync [cliente]". Nace de un caso real (franciskom, 01-08-2026): 4 de 6
  conocimientos aprobados en Studio nunca se re-empaquetaron después del build, y el checklist de
  infraestructura decía "no realizado" en todo pese a que ya estaba en producción real.
---

# Audit: drift Studio ↔ producción

El problema de fondo: en este proyecto, aprobar un hecho de conocimiento en Studio y que ese
hecho llegue al agente real desplegado **son dos pasos separados y desacoplados**. Nada avisa
automáticamente cuando quedan desincronizados — hay que ir a buscarlo.

## Paso 1 — Contar lo aprobado en Studio vs. lo embebido en la versión publicada

Consulta directa a `database.sqlite` (raíz del repo Studio, `creador agentes/database.sqlite`):

```bash
node -e "
import('sqlite').then(async ({open}) => {
  const sqlite3 = (await import('sqlite3')).default;
  const db = await open({ filename: 'database.sqlite', driver: sqlite3.Database });
  const clientId = '<CLIENTE>';
  const approved = await db.all(\"SELECT id, subject FROM knowledge_items WHERE client_id = ? AND status='approved'\", [clientId]);
  const version = await db.get('SELECT version, status, package_json, approved_at FROM agent_versions WHERE client_id = ? AND status=\"approved\" ORDER BY approved_at DESC LIMIT 1', [clientId]);
  const embedded = version ? JSON.parse(version.package_json).knowledge.confirmed_facts.length : 0;
  console.log('Aprobados en Studio:', approved.length, '· Embebidos en versión', version?.version, ':', embedded);
  if (approved.length !== embedded) console.log('⚠️ DRIFT: hay conocimiento aprobado que nunca se empaquetó.');
  await db.close();
});
"
```

Si hay drift: generar nueva versión (`POST /api/clients/:id/versions` con body `{version, summary}` —
usa `buildClientPackage` internamente, que SIEMPRE lee el estado vivo de la DB, así que la nueva
versión queda al día automáticamente), aprobarla (`PUT /api/clients/:id/versions/:versionId/approve`),
y reconstruir (`POST /api/clients/:id/versions/:versionId/build-runtime` con `{target}`).

También revisa mientras estás ahí:
- `client.desc` (`SELECT desc FROM clients WHERE id=?`) — ¿tiene alguna nota interna que no
  debería ser visible al cliente? (pasó con franciskom: "Instancia de PRODUCCIÓN real — nunca
  mezclar con quiro-demo" se filtró a la ficha de negocio real). Las notas internas van en
  `project_notes`, no en `desc`.
- Tests duplicados o con `last_result` siempre `null` en `agent_tests` — indican que nadie corrió
  `npm test` contra el paquete real desde que se escribieron.

## Paso 2 — Checklist de infraestructura vs. realidad

```bash
node -e "
import('sqlite').then(async ({open}) => {
  const sqlite3 = (await import('sqlite3')).default;
  const db = await open({ filename: 'database.sqlite', driver: sqlite3.Database });
  const infra = await db.get('SELECT * FROM client_infrastructure WHERE client_id=?', ['<CLIENTE>']);
  console.log(infra);
  await db.close();
});
"
```

Si `migration_applied`/`catalog_seeded`/`env_vars_set` están en `0` pero tú sabes (o el usuario
confirma) que ya están hechos en la realidad, o si `vercel_project_url` está vacío pese a que el
cliente ya tiene un deploy real: actualízalo con
`PUT /api/clients/:id/deployment-checklist` (`{vercelProjectUrl, migrationApplied, catalogSeeded, envVarsSet}`).

Si `connection_status` no es `connected` o `last_checked_at` tiene más de 24h, refresca con
`POST /api/clients/:id/infrastructure/test` (usa la credencial ya guardada en el vault local, no
pide nada nuevo) — el preflight de `build-runtime` a `staging`/`production` lo exige igual, así
que hacerlo antes evita una vuelta extra.

## Paso 3 — Preflight antes de construir a producción

`GET /api/clients/:id/installation-preflight?target=production` devuelve `blockers` (impiden el
build) y `warnings` (no impiden, sólo avisan). Un blocker típico y ya conocido: pedir una fuente
original aprobada — este proyecto ya no bloquea producción por eso (se relajó a advertencia el
02-08-2026, porque hay clientes reales cuyo conocimiento se curó a mano, sin documentos que
subir); si ves ese blocker reaparecer, es una regresión.

## Qué NO hace esta skill

No sustituye probar el agente real (chat, reservas) — sólo confirma que "lo que Studio cree que
está aprobado" coincide con "lo que el paquete desplegado realmente contiene". Verificación
funcional en navegador real sigue siendo obligatoria aparte (ver política del proyecto en
`CLAUDE.md`).
