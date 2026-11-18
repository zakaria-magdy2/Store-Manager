import { execFileSync } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = dirname(scriptsDir);
const workspaceDir = dirname(dirname(desktopDir));
const tscBin = join(workspaceDir, 'node_modules', 'typescript', 'bin', 'tsc');

execFileSync(process.execPath, [tscBin, '-p', join(desktopDir, 'tsconfig.preload.json')], {
  cwd: desktopDir,
  stdio: 'inherit',
});

await copyFile(
  join(desktopDir, 'dist', 'preload-cjs', 'preload.js'),
  join(desktopDir, 'dist', 'preload.cjs'),
);
await rm(join(desktopDir, 'dist', 'preload-cjs'), { recursive: true, force: true });
