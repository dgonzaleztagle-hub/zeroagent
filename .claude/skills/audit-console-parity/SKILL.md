---
name: audit-console-parity
description: >-
  Compara la consola de escritorio (runtime-template/public/agenda.html + client-console-v2.js)
  contra la consola móvil (runtime-template/public/m/index.html + m.js) para detectar campos,
  validaciones o estados que existen en una pero no en la otra. Usa esta skill SIEMPRE después de
  agregar o modificar un formulario, badge de estado, o pantalla en cualquiera de las dos
  consolas, o cuando el usuario pida "revisa que PC y móvil estén parejos", "chequea paridad",
  "¿esto también está en el otro formato?". Nace de un caso real (franciskom, 01/02-08-2026): el
  formulario de reserva móvil capturaba correo pero no sede; el de escritorio capturaba sede pero
  no correo — nadie lo había notado porque cada consola se construyó en sesiones distintas.
---

# Audit: paridad PC ↔ móvil

El problema de fondo: PC y móvil son dos árboles de archivos HTML/JS independientes que
implementan la misma consola del cliente. Nada los mantiene sincronizados automáticamente —
agregar un campo a uno no avisa que falta en el otro.

## Paso 1 — Diff de campos de formulario

Para cada `<dialog>`/`<form>` equivalente, lista los `id=` de sus inputs en ambos lados y compara:

```bash
grep -oE 'id="[a-z-]+"' runtime-template/public/agenda.html | sort -u > /tmp/pc-ids.txt
grep -oE 'id="[a-z-]+"' runtime-template/public/m/index.html | sort -u > /tmp/m-ids.txt
diff /tmp/pc-ids.txt /tmp/m-ids.txt
```

No todo lo que aparece en el diff es un problema (cada consola tiene elementos propios de su
layout) — pero cualquier campo de **datos del negocio** (captura de cliente, reserva, ficha) que
aparezca en un lado y no en el otro es sospechoso. Ejemplo real ya encontrado: `booking-email`
sólo en móvil, `booking-location` sólo en escritorio, en el mismo formulario "Nueva reserva".

## Paso 2 — Diff de badges/estados

Busca en ambos JS (`client-console-v2.js` y `m/m.js`) las funciones que mapean un estado a una
etiqueta visible (`statusLabel`, `segmentLabel`, badges de integración, etc.) y compara: ¿existen
las mismas etiquetas en los dos lados?, ¿alguna quedó como el enum crudo de Supabase sin traducir
en un lado pero no en el otro? (pasó con el estado de `za_feedback_items` — `NEW`/`REVIEWING` sin
traducir en PC, nunca se notó porque esa tabla siempre estaba vacía hasta que se sembraron datos).

## Paso 3 — Elementos hardcodeados vs. dinámicos

Busca HTML estático que debería ser dinámico: `grep -n "CONECTADO\|Casa Aura\|placeholder" en
agenda.html` — cualquier badge o texto que parezca un valor real pero no tenga `id=` ni se
actualice desde JS es sospechoso (pasó con "WhatsApp · Zavu CONECTADO", hardcodeado en el HTML
sin relación al estado real del canal).

## Paso 4 — Navegación y cobertura de pantallas

Lista las vistas de cada consola (`data-view=`/`nav-item` en PC, `data-view=`/bottom-nav en
móvil) y confirma que cada funcionalidad relevante para el dueño del negocio esté en ambas, o que
la ausencia sea una decisión consciente (documentada), no un olvido.

## Qué hacer con lo encontrado

No arregles todo automáticamente sin avisar — reporta el diff completo primero (qué campo/estado
falta en cuál lado) y deja que el usuario decida cuál es el comportamiento correcto antes de
tocar código, especialmente si el fix implica decidir un flujo de negocio (no sólo copiar un
campo de un lado al otro).
