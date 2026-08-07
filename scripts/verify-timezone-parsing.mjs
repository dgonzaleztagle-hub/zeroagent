// Reproduce el bug real: Vercel corre el runtime en UTC, no en America/Santiago (esta máquina
// de desarrollo sí está en Chile, por eso el bug pasó inadvertido localmente). Fuerza TZ=UTC vía
// proceso hijo para que el test falle exactamente como fallaría en producción si `asIso()`
// volviera a confiar en `new Date(valorSinOffset)`.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isChild = process.env.ZA_TZ_TEST_CHILD === '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!isChild) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TZ: 'UTC', ZA_TZ_TEST_CHILD: '1' },
    stdio: 'inherit'
  });
  process.exit(result.status ?? 1);
}

assert.equal(new Date().getTimezoneOffset(), 0, 'Este proceso debía forzar TZ=UTC.');

const { asIso } = await import(pathToFileURL(path.join(root, 'runtime-template/src/agenda.js')).href);

// Valor crudo tal cual lo manda un <input type="datetime-local"> (reserva pública, reserva/bloqueo
// manual desde consola PC y móvil): sin offset. Con TZ=UTC en el proceso, `new Date(valor)` lo
// interpretaría como UTC — 4 horas antes de lo que el negocio en Chile realmente pidió.
const naive = '2026-08-10T10:00';
const iso = asIso(naive, 'America/Santiago');
assert.ok(iso, 'asIso debe devolver un ISO válido para un datetime-local bien formado.');

// Invariante real: formatear el instante UTC resultante de vuelta en la zona del negocio debe
// reproducir la misma hora de pared que el usuario tipeó, sin importar el offset exacto de Chile
// en esa fecha (fijo o con DST histórico).
const backToChile = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).format(new Date(iso));
assert.equal(backToChile.replace(', ', 'T'), naive, `"${naive}" en horario de Chile debe volver a leerse como ${naive}, no como ${backToChile}.`);

// Con el bug original, el ISO resultante sería igual al valor crudo interpretado como UTC.
const buggyIso = new Date(naive).toISOString();
assert.notEqual(iso, buggyIso, 'La corrección no debe coincidir con la interpretación UTC ingenua (ese era el bug).');

// Valores que YA traen offset explícito (como el reagendamiento desde m.js, que convierte en el
// navegador antes de enviar) deben pasar intactos, sin una segunda conversión de zona horaria.
const alreadyAbsolute = '2026-08-10T14:00:00.000Z';
assert.equal(asIso(alreadyAbsolute, 'America/Santiago'), alreadyAbsolute, 'Un ISO con Z ya es un instante absoluto: no debe reinterpretarse con la zona del negocio.');

console.log('PASS · asIso interpreta <input type="datetime-local"> en la zona horaria del negocio, incluso con el proceso corriendo en TZ=UTC (como Vercel).');
