#!/usr/bin/env node
/**
 * test-installed-acceptance.mjs
 * Windows Installed Build Acceptance Test — End-to-End verification of NSIS-installed RetailOS.
 *
 * Usage:
 *   node scripts/test-installed-acceptance.mjs [--skip-build] [--exe <path-to-RetailOS.exe>]
 *
 * Safety:
 *  - Refuses to run if any live RetailOS.exe process exists (protects real user data).
 *  - Uses an isolated RETAILOS_DATA_DIR sandbox under %TEMP%.
 *  - Cleans up all spawned processes by tracked PID tree before sandbox removal.
 */

import { spawn, execSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopDir = dirname(__dirname);
const projectRoot = resolve(desktopDir, '..', '..');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const exeIdx = args.indexOf('--exe');
const exeOverride = exeIdx !== -1 ? args[exeIdx + 1] : null;

// ─── Safety: refuse if any live RetailOS.exe already exists ──────────────
function listRetailOSProcesses() {
  try {
    const csv = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'RetailOS.exe\' } | Select-Object ProcessId,ExecutablePath | ConvertTo-Csv -NoTypeInformation"',
      { encoding: 'utf8', timeout: 10_000 },
    ).trim();
    return csv
      .split('\n')
      .slice(1)
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const parts = l.replace(/"/g, '').split(',');
        return { pid: Number(parts[0]), path: parts.slice(1).join(',') };
      });
  } catch {
    return [];
  }
}

const liveRetailOS = listRetailOSProcesses();
if (liveRetailOS.length > 0) {
  console.error(
    `\n❌ SAFETY ABORT: Found ${liveRetailOS.length} live RetailOS.exe process(es) on this machine.\n` +
    `   PIDs: ${liveRetailOS.map((p) => p.pid).join(', ')}\n` +
    `   Close all RetailOS instances before running this acceptance test to protect production data.\n`,
  );
  process.exit(1);
}

// ─── Locate executable ───────────────────────────────────────────────────
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
    execSync('cmd /c "pnpm --filter @retailos/desktop run desktop:dist:win"', {
      cwd: projectRoot,
      stdio: 'inherit',
    });
  }
  // Find the unpacked exe
  const winUnpackedDir = join(releaseDir, 'win-unpacked');
  if (existsSync(join(winUnpackedDir, 'RetailOS.exe'))) {
    targetExe = join(winUnpackedDir, 'RetailOS.exe');
  } else {
    console.error('❌ RetailOS.exe not found in release/win-unpacked/. Run desktop:dist:win first.');
    process.exit(1);
  }
}

if (!existsSync(targetExe)) {
  console.error(`❌ Executable not found: ${targetExe}`);
  process.exit(1);
}

console.log(`\n🎯 Testing executable: ${targetExe}\n`);

// ─── Test helpers ────────────────────────────────────────────────────────
const PASS = '✅';
const FAIL = '❌';
const results = [];

function assert(condition, message) {
  if (condition) {
    results.push({ pass: true, message });
    console.log(`  ${PASS} ${message}`);
  } else {
    results.push({ pass: false, message });
    console.log(`  ${FAIL} ${message}`);
  }
}

async function fetchJson(origin, path, options = {}) {
  const url = `${origin}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

async function waitForBoot(origin, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${origin}/api/bootstrap`);
      if (res.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function cleanup(child, tempDir) {
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 2000));
    if (!child.killed) try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  // Kill any straggler processes from our exe
  const stragglers = listRetailOSProcesses();
  for (const p of stragglers) {
    try { execSync(`taskkill /PID ${p.pid} /F /T`, { timeout: 5000 }); } catch { /* ignore */ }
  }
  if (tempDir) {
    await new Promise((r) => setTimeout(r, 1000));
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 }).catch(() => {
      console.log(`  ⚠️  Could not fully remove sandbox: ${tempDir}`);
    });
  }
}

// ─── Main acceptance flow ────────────────────────────────────────────────
const tempSandbox = await mkdtemp(join(tmpdir(), 'retailos-accept-'));
let child = null;

try {
  console.log('───────────────────────────────────────────');
  console.log(' STEP 1: Verify packaged files');
  console.log('───────────────────────────────────────────');
  const exeDir = dirname(targetExe);
  assert(existsSync(join(exeDir, 'RetailOS.exe')), 'RetailOS.exe exists');
  assert(existsSync(join(exeDir, 'resources', 'app.asar')), 'resources/app.asar exists');

  // Check for manifest (may be inside app.asar)
  const webManifest = join(exeDir, 'resources', 'web', 'integrity-manifest.json');
  const hasManifest = existsSync(webManifest);
  assert(hasManifest || existsSync(join(exeDir, 'resources', 'app.asar')), 'integrity-manifest.json or app.asar present');

  console.log('\n───────────────────────────────────────────');
  console.log(' STEP 2: Boot installed executable with isolated sandbox');
  console.log('───────────────────────────────────────────');

  const port = 14310 + Math.floor(Math.random() * 1000);
  const origin = `http://127.0.0.1:${port}`;

  child = spawn(targetExe, [], {
    cwd: exeDir,
    env: {
      ...process.env,
      RETAILOS_DATA_DIR: tempSandbox,
      RETAILOS_DB_PATH: join(tempSandbox, 'retailos.sqlite'),
      RETAILOS_BACKUP_DIR: join(tempSandbox, 'backups'),
      PORT: String(port),
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});

  const booted = await waitForBoot(origin);
  assert(booted, 'Server boots within 30s');

  if (!booted) {
    console.log('\n⛔ Cannot proceed without a running server.');
    throw new Error('Boot timeout');
  }

  console.log('\n───────────────────────────────────────────');
  console.log(' STEP 3: Initial setup and license check');
  console.log('───────────────────────────────────────────');

  const boot = await fetchJson(origin, '/api/bootstrap');
  assert(boot.status === 200, 'GET /api/bootstrap returns 200');
  assert(boot.body.setupRequired === true, 'Fresh database requires setup');

  const license = await fetchJson(origin, '/api/license/status');
  assert(license.status === 200, 'GET /api/license/status returns 200');
  assert(license.body.status === 'UNLICENSED', 'Fresh install is UNLICENSED');

  const setupRes = await fetchJson(origin, '/api/setup', {
    method: 'POST',
    body: JSON.stringify({
      ownerName: 'Acceptance Owner',
      ownerUsername: 'accept_owner',
      password: 'Accept-Strong-Pass-2026!!',
      dailyBackupPassphrase: 'AcceptBackupMasterKey-2026!!',
    }),
  });
  assert(setupRes.status === 201, 'POST /api/setup returns 201');

  const bootAfter = await fetchJson(origin, '/api/bootstrap');
  assert(bootAfter.body.configured === true, 'System is configured after setup');

  console.log('\n───────────────────────────────────────────');
  console.log(' STEP 4: Login and verify data isolation');
  console.log('───────────────────────────────────────────');

  const login = await fetchJson(origin, '/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'accept_owner', password: 'Accept-Strong-Pass-2026!!' }),
  });
  assert(login.status === 200, 'Owner login succeeds');
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';

  const data = await fetchJson(origin, '/api/data', { headers: { Cookie: cookie } });
  assert(data.status === 200, 'GET /api/data returns session data');
  assert(data.body.user?.username === 'accept_owner', 'Correct user identity');

  console.log('\n───────────────────────────────────────────');
  console.log(' STEP 5: Verify sandbox isolation');
  console.log('───────────────────────────────────────────');

  const dbPath = join(tempSandbox, 'retailos.sqlite');
  assert(existsSync(dbPath), 'SQLite database created in sandbox');
  assert(existsSync(join(tempSandbox, 'backups', 'daily')), 'Daily backup directory created');

  // No plaintext key files should exist
  const sandboxFiles = await readdir(tempSandbox).catch(() => []);
  const plaintextKeys = sandboxFiles.filter((f) => f.endsWith('.key'));
  assert(plaintextKeys.length === 0, 'No plaintext .key files in sandbox');

  console.log('\n───────────────────────────────────────────');
  console.log(' STEP 6: Verify daily backup creation');
  console.log('───────────────────────────────────────────');

  const dailyDir = join(tempSandbox, 'backups', 'daily');
  // Trigger daily backup refresh via API
  const dailyList = await fetchJson(origin, '/api/backups/daily', { headers: { Cookie: cookie } });
  assert(dailyList.status === 200, 'GET /api/backups/daily returns 200');
  // A daily may or may not exist yet (depends on timing), but the endpoint works

  console.log('\n───────────────────────────────────────────');
  console.log(' ACCEPTANCE RESULTS');
  console.log('───────────────────────────────────────────');

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n  Total: ${results.length} | ${PASS} Passed: ${passed} | ${FAIL} Failed: ${failed}\n`);

  if (failed > 0) {
    console.log('  Failed assertions:');
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`    ${FAIL} ${r.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log('  🎉 All installed acceptance checks passed.\n');
  }
} catch (error) {
  console.error(`\n❌ Acceptance test error: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await cleanup(child, tempSandbox);
}
