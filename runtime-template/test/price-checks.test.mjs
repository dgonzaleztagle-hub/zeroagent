import test from 'node:test';
import assert from 'node:assert/strict';
import { unexpectedCatalogPrices } from '../src/price-checks.js';

test('un precio viejo se rechaza y un recargo desglosado del catálogo se conserva', () => {
  const catalog = { services: [{ price_clp: 44000, price_note: '$38.000 + $6.000 de traslado' }] };
  assert.deepEqual(unexpectedCatalogPrices('La sesión cuesta $36.000.', catalog), [36000]);
  assert.deepEqual(unexpectedCatalogPrices('$38.000 más $6.000 de traslado.', catalog), []);
  assert.deepEqual(unexpectedCatalogPrices('Total $44.000.', catalog), [44000]);
});

test('un precio válido para otro servicio no justifica el precio del Box nombrado', () => {
  const catalog = { services: [{ name: 'Sesión · Box Buin', price_clp: 38000 }, { name: 'Sesión kinésica respiratoria · Domicilio Buín', price_clp: 36000 }] };
  assert.deepEqual(unexpectedCatalogPrices('En el Box Buin cuesta $36.000.', catalog), [36000]);
  assert.deepEqual(unexpectedCatalogPrices('En el Box Buin cuesta $38.000.', catalog), []);
});
