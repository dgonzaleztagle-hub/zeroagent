import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function vaultFile(vaultRoot, clientId, namespace = 'primary') {
  const safeClient = String(clientId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeNamespace = String(namespace).replace(/[^a-zA-Z0-9_-]/g, '_');
  const suffix = safeNamespace === 'primary' ? '' : `.${safeNamespace}`;
  return path.join(vaultRoot, `${safeClient}${suffix}.dpapi`);
}

async function runDpapi(mode, value) {
  const script = mode === 'protect'
    ? "Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes($env:ZEROAGENT_VAULT_VALUE); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
    : "Add-Type -AssemblyName System.Security; $bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:ZEROAGENT_VAULT_VALUE),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($bytes)";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, ZEROAGENT_VAULT_VALUE: value },
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

export function createLocalVault(vaultRoot) {
  return {
    async store(clientId, secret, namespace = 'primary') {
      if (!secret?.trim()) throw new Error('La credencial no puede estar vacía.');
      await fs.mkdir(vaultRoot, { recursive: true });
      const encrypted = await runDpapi('protect', secret.trim());
      await fs.writeFile(vaultFile(vaultRoot, clientId, namespace), encrypted, { encoding: 'utf8', mode: 0o600 });
      return { hint: `${secret.trim().slice(0, 6)}…${secret.trim().slice(-4)}` };
    },
    async read(clientId, namespace = 'primary') {
      const encrypted = await fs.readFile(vaultFile(vaultRoot, clientId, namespace), 'utf8');
      return runDpapi('unprotect', encrypted.trim());
    },
    async remove(clientId, namespace = 'primary') {
      await fs.rm(vaultFile(vaultRoot, clientId, namespace), { force: true });
    },
    async exists(clientId, namespace = 'primary') {
      try { await fs.access(vaultFile(vaultRoot, clientId, namespace)); return true; } catch { return false; }
    }
  };
}
