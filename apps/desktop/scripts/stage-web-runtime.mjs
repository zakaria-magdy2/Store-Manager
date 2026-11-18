import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = dirname(scriptsDir);
const workspaceDir = dirname(dirname(desktopDir));
const stageRootDir = join(desktopDir, 'stage');
const stageWebDir = join(stageRootDir, 'web');

await rm(stageRootDir, { recursive: true, force: true });

const pnpmArgs = [
  '--filter',
  '@retailos/web',
  'deploy',
  '--prod',
  '--legacy',
  '--prefer-offline',
  stageWebDir,
];

const deployResult =
  process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm', ...pnpmArgs], {
        cwd: workspaceDir,
        stdio: 'inherit',
      })
    : spawnSync('pnpm', pnpmArgs, {
        cwd: workspaceDir,
        stdio: 'inherit',
      });

if (deployResult.status !== 0) {
  throw new Error(
    `Failed to stage @retailos/web runtime via pnpm deploy (exit ${String(deployResult.status ?? 1)})`,
  );
}

// Flatten pnpm virtual store into plain physical directories (zero symlinks / junctions)
// so the Windows installer and Electron resources work reliably on any install path.
const rawNodeModules = join(stageWebDir, 'node_modules');
const flatNodeModules = join(stageWebDir, '.flat_node_modules');
await mkdir(flatNodeModules, { recursive: true });

const pnpmStoreDir = join(rawNodeModules, '.pnpm');
if (existsSync(pnpmStoreDir)) {
  const storeEntries = await readdir(pnpmStoreDir);
  for (const storeEntry of storeEntries) {
    if (storeEntry === 'node_modules' || storeEntry === 'lock.yaml') {
      continue;
    }
    const innerModulesDir = join(pnpmStoreDir, storeEntry, 'node_modules');
    if (!existsSync(innerModulesDir)) {
      continue;
    }
    const pkgEntries = await readdir(innerModulesDir);
    for (const pkgEntry of pkgEntries) {
      const fullPkgPath = join(innerModulesDir, pkgEntry);
      if (pkgEntry.startsWith('@')) {
        const scopedEntries = await readdir(fullPkgPath);
        for (const scopedPkg of scopedEntries) {
          const scopedFullPath = join(fullPkgPath, scopedPkg);
          const stat = await lstat(scopedFullPath);
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            continue;
          }
          const destPath = join(flatNodeModules, pkgEntry, scopedPkg);
          await mkdir(dirname(destPath), { recursive: true });
          await cp(scopedFullPath, destPath, { recursive: true, dereference: true });
          // Remove nested pnpm node_modules inside flattened package since dependencies are hoisted.
          await rm(join(destPath, 'node_modules'), { recursive: true, force: true });
        }
      } else {
        const stat = await lstat(fullPkgPath);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          continue;
        }
        const destPath = join(flatNodeModules, pkgEntry);
        await cp(fullPkgPath, destPath, { recursive: true, dereference: true });
        await rm(join(destPath, 'node_modules'), { recursive: true, force: true });
      }
    }
  }
}

await rm(rawNodeModules, { recursive: true, force: true });
await rename(flatNodeModules, rawNodeModules);

// Remove source/test folders from workspace packages inside node_modules/@retailos/*
const retailosModDir = join(rawNodeModules, '@retailos');
if (existsSync(retailosModDir)) {
  for (const pkgName of await readdir(retailosModDir)) {
    for (const trimDir of ['src', 'tests', 'tsconfig.tsbuildinfo', 'tsconfig.json', 'tsconfig.eslint.json']) {
      await rm(join(retailosModDir, pkgName, trimDir), { recursive: true, force: true });
    }
  }
}

// Never bundle live or test databases, tests, build configs, or duplicate web dist artifacts.
for (const unsafeEntry of [
  'data',
  'tests',
  'dist',
  '.turbo',
  '.playwright-results',
  'playwright-report',
  'test-results',
  'build.mjs',
  'playwright.config.mjs',
  'pnpm-lock.yaml',
]) {
  await rm(join(stageWebDir, unsafeEntry), { recursive: true, force: true });
}
const rootEntries = await readdir(stageWebDir);
for (const entry of rootEntries) {
  if (entry.startsWith('.test-')) {
    await rm(join(stageWebDir, entry), { recursive: true, force: true });
  }
}

const requiredPaths = [
  join(stageWebDir, 'server.mjs'),
  join(stageWebDir, 'public', 'index.html'),
  join(stageWebDir, 'public', 'app.js'),
  join(stageWebDir, 'public', 'styles.css'),
  join(
    stageWebDir,
    'node_modules',
    '@retailos',
    'infrastructure',
    'dist',
    'database',
    'migrator.js',
  ),
  join(
    stageWebDir,
    'node_modules',
    '@retailos',
    'infrastructure',
    'dist',
    'database',
    'migrations',
    '027_supplier_refunds.js',
  ),
  join(stageWebDir, 'node_modules', '@retailos', 'application', 'dist', 'index.js'),
  join(stageWebDir, 'node_modules', '@retailos', 'core', 'dist', 'index.js'),
  join(stageWebDir, 'node_modules', '@retailos', 'shared', 'dist', 'index.js'),
  join(stageWebDir, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node'),
  join(stageWebDir, 'node_modules', '@node-rs', 'argon2', 'index.js'),
  join(stageWebDir, 'node_modules', 'kysely', 'package.json'),
  join(stageWebDir, 'node_modules', 'zod', 'package.json'),
];

for (const reqPath of requiredPaths) {
  if (!existsSync(reqPath)) {
    throw new Error(`Staged desktop web runtime is missing required artifact: ${reqPath}`);
  }
}

// Verify vendor keygen tools and private keys are NEVER bundled into desktop stage/release.
if (existsSync(join(stageWebDir, 'tools')) || existsSync(join(stageWebDir, 'vendor-keygen'))) {
  throw new Error('Security violation: vendor-keygen tools directory must never be staged.');
}

async function assertNoPrivateKeysStaged(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await assertNoPrivateKeysStaged(fullPath);
      continue;
    }
    if (entry.name.toLowerCase().endsWith('private.pem') || entry.name.toLowerCase().includes('vendor-keygen')) {
      throw new Error(`Security violation: forbidden vendor key artifact staged at ${fullPath}`);
    }
    if (entry.name.endsWith('.pem') || entry.name.endsWith('.key')) {
      const content = await readFile(fullPath, 'utf8');
      if (content.includes('PRIVATE KEY')) {
        throw new Error(`Security violation: private key material detected in staged file ${fullPath}`);
      }
    }
  }
}

await assertNoPrivateKeysStaged(stageWebDir);

console.log(`Staged standalone RetailOS desktop web runtime at ${stageWebDir}`);
