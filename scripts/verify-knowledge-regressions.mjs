import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zeroagent-knowledge-'));
const packageData = {
  agent: { policy: { unknown_fact_behavior: 'admit_unknown_and_offer_handoff' } },
  knowledge: { confirmed_facts: [{ id: 'price', category: 'precios', subject: 'Precio de consulta', value: 'La consulta cuesta 20.000 pesos.' }] },
  tests: [{ question: '¿Cuánto cuesta la consulta?', expected_behavior: 'Debe informar que cuesta 20.000 pesos.', knowledge_item_id: 'price' }]
};

try {
  await fs.cp(path.join(root, 'runtime-template'), temporary, { recursive: true });
  const packagePath = path.join(temporary, 'agent-package.json');
  await fs.writeFile(packagePath, JSON.stringify(packageData));
  const valid = spawnSync(process.execPath, ['src/run-tests.js'], { cwd: temporary, encoding: 'utf8' });
  assert.equal(valid.status, 0, `El caso válido debió pasar:\n${valid.stdout}${valid.stderr}`);

  packageData.knowledge.confirmed_facts[0].value = 'XXXX DATO FALSO XXXX';
  await fs.writeFile(packagePath, JSON.stringify(packageData));
  const corrupted = spawnSync(process.execPath, ['src/run-tests.js'], { cwd: temporary, encoding: 'utf8' });
  assert.notEqual(corrupted.status, 0, 'La suite aceptó conocimiento corrompido.');
  assert.match(corrupted.stdout, /FAIL/, 'La corrupción no quedó reportada como fallo.');
  console.log('PASS · Las regresiones de conocimiento rechazan hechos corrompidos.');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
