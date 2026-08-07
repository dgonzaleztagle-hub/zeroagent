import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchAgendaOutbox } from './outbox.js';

try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packageData = JSON.parse(await fs.readFile(path.join(root, 'agent-package.json'), 'utf8'));
  console.log(JSON.stringify(await dispatchAgendaOutbox(packageData)));
} catch (error) {
  console.error(`No se pudo despachar outbox: ${error.message}`);
  process.exitCode = 1;
}
