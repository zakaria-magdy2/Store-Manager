#!/usr/bin/env node
/**
 * Isolated Windows acceptance checks for a packaged RetailOS executable.
 *
 * Safety properties:
 * - Native Win32 process identity enumeration must succeed; uncertainty aborts before launch.
 * - The app's actual Electron userData path, database, and backups are redirected to one
 *   unique OS temp directory before Electron starts.
 * - Cleanup terminates only process identities verified as descendants of this run.
 * - No installer, uninstaller, or production data directory is modified.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeTestEnvironment,
  captureSpawnedMainIdentity,
  cleanupPackagedTestRun,
  queryWindowsProcessTable,
  validateServerProcessOwnership,
} from './test-packaged-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const desktopDir = dirname(dirname(__filename));
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const exeIdx = args.indexOf('--exe');
const exeOverride = exeIdx !== -1 ? args[exeIdx + 1] : null;
const PASS = '✅';
const FAIL = '❌';
const results = [];

if (process.platform !== 'win32') {
  console.error('❌ This acceptance test requires Windows DPAPI and Windows process identity checks.');
  process.exit(1);
}

function assertCheck(condition, message) {
  results.push({ pass: Boolean(condition), message });
  console.log(`  ${condition ? PASS : FAIL} ${message}`);
  assert.ok(condition, message);
}

async function fetchJson(origin, path, options = {}) {
  const res = await fetch(`${origin}${path}`, {
    ...options,
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return existsSync(filePath);
}

async function listFilesRecursively(root) {
  const result = [];
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  await visit(root);
  return result;
}

let targetExe;
if (exeOverride) {
  targetExe = resolve(exeOverride);
} else {
  const releaseDir = join(desktopDir, 'release');
  if (!existsSync(releaseDir)) {
    if (skipBuild) {
      console.error('❌ No release directory found and --skip-build was passed.');
      process.exit(1);
    }
    console.log('📦 Building desktop installer...');
    const { spawnSync } = await import('node:child_process');
    const build = spawnSync(
      'cmd.exe',
      ['/d', '/s', '/c', 'pnpm --filter @retailos/desktop run desktop:dist:win'],
      { cwd: dirname(dirname(desktopDir)), stdio: 'inherit', windowsHide: true },
    );
    if (build.error || build.status !== 0) {
      throw new Error(`Windows desktop build failed: ${build.error?.message ?? build.status}`);
    }
  }
  const candidate = join(releaseDir, 'win-unpacked', 'RetailOS.exe');
  if (!existsSync(candidate)) {
    throw new Error('RetailOS.exe not found in release/win-unpacked/. Run desktop:dist:win first.');
  }
  targetExe = candidate;
}

if (!existsSync(targetExe) || basename(targetExe).toLowerCase() !== 'retailos.exe') {
  throw new Error(`Expected an existing RetailOS.exe, received: ${targetExe}`);
}

const tempSandbox = await mkdtemp(join(tmpdir(), 'retailos-accept-'));
const dataDir = join(tempSandbox, 'data');
const databasePath = join(dataDir, 'retailos.sqlite');
const backupDir = join(dataDir, 'backups');
const dailyBackupDir = join(backupDir, 'daily');
const controlFilePath = join(dataDir, '.retailos-control.json');
const expectedServerScriptPath = join(dirname(targetExe), 'resources', 'web', 'server.mjs');
let preExistingPids = new Set();
const ownedProcesses = new Map();
let child = null;
let childStdout = '';
let childStderr = '';
let spawnedMainIdentity = null;
let trackedServerIdentity = null;
let unverifiedMainPid = null;
let primaryError = null;

function resetOwnedProcessState() {
  child = null;
  childStdout = '';
  childStderr = '';
  spawnedMainIdentity = null;
  trackedServerIdentity = null;
  unverifiedMainPid = null;
  ownedProcesses.clear();
}

async function launchDesktop() {
  const appEnv = {
    ...process.env,
    // Electron enters Node mode based on this variable's presence; "0" is still unsafe.
    NODE_ENV: 'production',
    RETAILOS_DESKTOP_USER_DATA_DIR: tempSandbox,
    RETAILOS_DATA_DIR: dataDir,
    RETAILOS_DB_PATH: databasePath,
    RETAILOS_BACKUP_DIR: backupDir,
  };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(targetExe, [], {
    cwd: dirname(targetExe),
    // Electron reads userData before app readiness; RETAILOS_DATA_DIR alone is insufficient.
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  childStdout = '';
  childStderr = '';
  child.stdout?.on('data', (chunk) => {
    childStdout = `${childStdout}${chunk}`.slice(-8_000);
  });
  child.stderr?.on('data', (chunk) => {
    childStderr = `${childStderr}${chunk}`.slice(-8_000);
  });
  if (!(Number.isInteger(child.pid) && child.pid > 0)) {
    throw new Error('Failed to capture spawned RetailOS.exe PID');
  }
  unverifiedMainPid = child.pid;
  const spawnedChild = child;
  const childExit = new Promise((_, reject) => {
    spawnedChild.once('exit', (code, signal) => {
      const diagnostics = [childStdout, childStderr].filter(Boolean).join('\n').trim();
      reject(new Error(
        `RetailOS.exe exited before process identity verification (code=${code}, signal=${signal ?? 'none'})${diagnostics ? `\n${diagnostics}` : ''}`,
      ));
    });
  });
  spawnedMainIdentity = await Promise.race([
    captureSpawnedMainIdentity(child.pid, targetExe),
    childExit,
  ]);
  unverifiedMainPid = null;
  ownedProcesses.set(spawnedMainIdentity.pid, { identity: spawnedMainIdentity, depth: 0 });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`RetailOS.exe exited before server readiness (code=${child.exitCode})`);
    }
    try {
      if (existsSync(controlFilePath)) {
        const control = JSON.parse(await readFile(controlFilePath, 'utf8'));
        if (Number.isInteger(control.pid) && control.pid > 0 && Number.isInteger(control.port)) {
          const origin = `http://127.0.0.1:${control.port}`;
          const bootstrap = await fetch(`${origin}/api/bootstrap`);
          if (!bootstrap.ok) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
            continue;
          }
          const table = queryWindowsProcessTable();
          const liveServer = table.get(control.pid);
          if (liveServer) {
            const ownership = validateServerProcessOwnership(liveServer, {
              expectedExePath: targetExe,
              expectedParentPid: spawnedMainIdentity.pid,
              expectedServerScriptPath,
              preExistingPids,
              spawnedMainIdentity,
              processTable: table,
            });
            if (!ownership.valid) {
              throw new Error(`Refusing to track unverified managed server: ${ownership.reason}`);
            }
            trackedServerIdentity = ownership.identity;
            ownedProcesses.set(trackedServerIdentity.pid, { identity: trackedServerIdentity, depth: 1 });
            return { control, origin };
          }
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError || error?.cause?.code === 'ENOENT') {
        // Control file creation and HTTP readiness can be observed a fraction apart.
      } else if (error?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNREFUSED') {
        // Server is still starting.
      } else {
        throw error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error('Packaged RetailOS did not expose a verified local server within 30 seconds.');
}

async function stopDesktop({ removeSandbox }) {
  await cleanupPackagedTestRun({
    ownedProcesses,
    spawnedMainIdentity,
    trackedServerIdentity,
    unverifiedMainPid,
    controlFilePath,
    expectedExePath: targetExe,
    expectedServerScriptPath,
    preExistingPids,
    tempSandbox: removeSandbox ? tempSandbox : null,
    primaryError,
  });
  resetOwnedProcessState();
}

try {
  preExistingPids = assertSafeTestEnvironment(exeOverride, tempSandbox);

  console.log(`\n🎯 Testing isolated packaged executable: ${targetExe}\n`);
  assertCheck(existsSync(targetExe), 'RetailOS.exe exists');
  assertCheck(existsSync(join(dirname(targetExe), 'resources', 'app.asar')), 'resources/app.asar exists');
  assertCheck(existsSync(expectedServerScriptPath), 'Packaged web server exists');

  console.log('\n───────────────────────────────────────────');
  console.log(' STEP 1: Start the packaged app in isolated userData');
  console.log('───────────────────────────────────────────');
  const firstLaunch = await launchDesktop();
  let origin = firstLaunch.origin;
  assertCheck(existsSync(databasePath), 'SQLite database is confined to temporary userData/data');
  assertCheck(existsSync(dailyBackupDir), 'Daily backup directory is confined to temporary userData/data');

  const licenseWatermarkPath = join(tempSandbox, 'license-watermark.bin');
  const dailyBackupPath = join(tempSandbox, 'daily-backup.bin');
  assertCheck(await waitForFile(licenseWatermarkPath), 'Windows safeStorage produced the license DPAPI file');
  assertCheck(await waitForFile(dailyBackupPath), 'Windows safeStorage produced the backup DPAPI file');

  console.log('\n───────────────────────────────────────────');
  console.log(' STEP 2: Verify setup and license fail-closed behavior');
  console.log('───────────────────────────────────────────');
  const boot = await fetchJson(origin, '/api/bootstrap');
  assertCheck(boot.status === 200 && boot.body.setupRequired === true, 'Fresh sandbox requires setup');
  const license = await fetchJson(origin, '/api/license/status');
  assertCheck(license.status === 200 && license.body.status === 'UNLICENSED', 'Fresh sandbox is UNLICENSED');

  const setupRes = await fetchJson(origin, '/api/setup', {
    method: 'POST',
    body: JSON.stringify({
      ownerName: 'Acceptance Owner',
      ownerUsername: 'accept_owner',
      password: 'Accept-Strong-Pass-2026!!',
      dailyBackupPassphrase: 'AcceptBackupMasterKey-2026!!',
    }),
  });
  assertCheck(setupRes.status === 201, 'Owner setup succeeds in isolated database');

  const login = await fetchJson(origin, '/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'accept_owner', password: 'Accept-Strong-Pass-2026!!' }),
  });
  assertCheck(login.status === 200, 'Owner login succeeds');
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assertCheck(cookie.length > 0, 'Login issued an owner session cookie');

  const blockedMutation = await fetchJson(origin, '/api/products', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ name: 'Synthetic unlicensed product', sku: 'ACC-UNLICENSED' }),
  });
  assertCheck(
    blockedMutation.status === 402 && blockedMutation.body.code === 'LICENSE_REQUIRED',
    'Unlicensed product mutation is rejected with 402 LICENSE_REQUIRED',
  );

  const data = await fetchJson(origin, '/api/data', { headers: { Cookie: cookie } });
  assertCheck(
    data.status === 200 && typeof login.body.user?.id === 'string' && data.body.user?.id === login.body.user.id,
    'Authenticated session data matches the owner created in the sandbox',
  );
  assertCheck(existsSync(databasePath), 'SQLite database remains in temporary userData/data');
  assertCheck(existsSync(dailyBackupDir), 'Daily backup directory remains in temporary userData/data');

  const keyringPath = join(tempSandbox, 'daily-backup-keyring.bin');
  assertCheck(await waitForFile(keyringPath), 'DPAPI keyring ACK persisted after master passphrase setup');
  for (const path of [licenseWatermarkPath, dailyBackupPath, keyringPath]) {
    const bytes = await readFile(path);
    const fileInfo = await stat(path);
    assertCheck(fileInfo.isFile() && fileInfo.size > 0, `${basename(path)} is a non-empty DPAPI artifact`);
    assertCheck(
      !bytes.includes(Buffer.from('AcceptBackupMasterKey-2026!!')),
      `${basename(path)} does not contain the supplied passphrase in plaintext`,
    );
  }

  const sandboxFiles = await listFilesRecursively(tempSandbox);
  const plaintextKeyFiles = sandboxFiles.filter((path) => /\.key$/i.test(path));
  assertCheck(plaintextKeyFiles.length === 0, 'No plaintext .key files exist anywhere in userData');
  for (const legacyName of ['.retailos-watermark.key', '.retailos-daily.key']) {
    assertCheck(!existsSync(join(dataDir, legacyName)), `${legacyName} plaintext fallback is absent`);
  }

  console.log('\n───────────────────────────────────────────');
  console.log(' STEP 3: Restart under the same Windows DPAPI profile');
  console.log('───────────────────────────────────────────');
  await stopDesktop({ removeSandbox: false });
  const secondLaunch = await launchDesktop();
  origin = secondLaunch.origin;
  const restartLicense = await fetchJson(origin, '/api/license/status');
  const restartBootstrap = await fetchJson(origin, '/api/bootstrap');
  assertCheck(
    restartLicense.status === 200 && restartLicense.body.status === 'UNLICENSED',
    'DPAPI watermark decrypts consistently after packaged-app restart',
  );
  assertCheck(
    restartBootstrap.status === 200 && restartBootstrap.body.configured === true,
    'SQLite setup survives packaged-app restart without leaving the sandbox',
  );
  assertCheck(existsSync(licenseWatermarkPath) && existsSync(dailyBackupPath) && existsSync(keyringPath), 'DPAPI artifacts persist across restart');

  console.log('\n───────────────────────────────────────────');
  console.log(' STEP 4: Acceptance results');
  console.log('───────────────────────────────────────────');
  const passed = results.filter((item) => item.pass).length;
  const failed = results.filter((item) => !item.pass).length;
  console.log(`\n  Total: ${results.length} | ${PASS} Passed: ${passed} | ${FAIL} Failed: ${failed}\n`);
  if (failed > 0) process.exitCode = 1;
} catch (error) {
  primaryError = error instanceof Error ? error : new Error(String(error));
  console.error(`\n❌ Acceptance test error: ${primaryError.message}\n`);
  process.exitCode = 1;
} finally {
  if (child || spawnedMainIdentity || trackedServerIdentity || unverifiedMainPid !== null) {
    try {
      await stopDesktop({ removeSandbox: true });
    } catch (error) {
      console.error(`❌ Safe process cleanup failed; preserving the temporary sandbox: ${error.message}`);
      process.exitCode = 1;
    }
  } else if (existsSync(tempSandbox)) {
    // No executable was started. Only the newly-created, uniquely named OS temp directory is removed.
    const normalizedTemp = resolve(tempSandbox);
    const normalizedRoot = resolve(tmpdir());
    if (!normalizedTemp.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}\\`)) {
      console.error(`❌ Refusing to remove a path outside the OS temp directory: ${tempSandbox}`);
      process.exitCode = 1;
    } else {
      const { rm } = await import('node:fs/promises');
      await rm(tempSandbox, { recursive: true, force: true });
    }
  }
}
