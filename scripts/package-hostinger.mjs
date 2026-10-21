// Builds the two archives for Hostinger's Node.js Web Apps (one app each): deploy/backend.tar.gz and
// deploy/frontend.tar.gz. Hostinger installs dependencies itself on Linux, so node_modules (with
// Windows-only native binaries), build output, secrets (.env) and local data are left out.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE = ['node_modules', '.next', '.env', '.env.*', 'data', '*.log', '.DS_Store'];

mkdirSync(path.join(root, 'deploy'), { recursive: true });

for (const app of ['backend', 'frontend']) {
  const out = `deploy/${app}.tar.gz`;
  rmSync(path.join(root, out), { force: true });
  // Relative paths and cwd: some tar builds read "C:\..." as a remote host.
  const result = spawnSync('tar', ['-czf', out, ...EXCLUDE.map((p) => `--exclude=${p}`), '-C', app, '.'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`Could not create ${out}${result.error ? `: ${result.error.message}` : ''}`);
    process.exit(1);
  }
  console.log(`${out}  ${(statSync(path.join(root, out)).size / 1024).toFixed(0)} KB`);
}
console.log('\nUpload each archive as its own Node.js Web App in hPanel (see README → Hostinger).');
