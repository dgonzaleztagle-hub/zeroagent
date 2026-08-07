import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedAgendaCatalog } from './agenda.js';
import { ensureInitialOwner } from './conversations.js';

try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packageData = JSON.parse(await fs.readFile(path.join(root, 'agent-package.json'), 'utf8'));
  const result = await seedAgendaCatalog(packageData);
  const owner = await ensureInitialOwner({ name: process.env.CLIENT_OWNER_NAME, email: process.env.CLIENT_OWNER_EMAIL });
  console.log(`Agenda configurada · sedes=${result.locations}, servicios=${result.services}, recursos=${result.resources}`);
  if (owner) console.log(`Responsable inicial configurado · ${owner.name}`);
} catch (error) {
  console.error(`No se pudo configurar Agenda: ${error.message}`);
  process.exitCode = 1;
}
