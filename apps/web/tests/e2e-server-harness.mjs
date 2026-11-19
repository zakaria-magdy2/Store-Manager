import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServerApp } from '../server.mjs';

export const DEFAULT_HARNESS_READY_TIMEOUT_MS = 60_000;

export function createTestTempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupTempDir(dirPath) {
  if (!dirPath) {
    return;
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export async function waitForHarnessReady(
  targetUrl,
  proc,
  getLog = () => '',
  timeoutMs = DEFAULT_HARNESS_READY_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) {
      throw new Error(`Harness server exited with ${proc.exitCode}\n${getLog()}`);
    }
    try {
      const response = await fetch(`${targetUrl}/api/bootstrap`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the local server is listening or deadline expires.
    }
    await new Promise((r) => setTimeout(r, 125));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms\n${getLog()}`);
}

export async function terminateChildProcessTree(proc, gracefulWaitMs = 3000) {
  if (!proc) {
    return;
  }
  const isAlive = () => proc.exitCode === null && proc.signalCode === null;
  if (!isAlive()) {
    return;
  }

  try {
    proc.kill('SIGTERM');
  } catch {
    // Ignore if already exited.
  }

  await Promise.race([
    once(proc, 'exit').catch(() => undefined),
    new Promise((r) => setTimeout(r, gracefulWaitMs)),
  ]);

  if (!isAlive()) {
    return;
  }

  const pid = proc.pid;
  if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
    if (process.platform === 'win32') {
      await new Promise((resolvePromise) => {
        execFile(
          'taskkill.exe',
          ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true },
          () => resolvePromise(),
        );
      });
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Ignore already dead process.
      }
    }
    await Promise.race([
      once(proc, 'exit').catch(() => undefined),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  }
}

function isInvokedDirectly() {
  const selfPath = fileURLToPath(import.meta.url);
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try {
    return realpathSync(resolve(entryArg)) === realpathSync(selfPath);
  } catch {
    return resolve(entryArg) === resolve(selfPath);
  }
}

if (isInvokedDirectly()) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('e2e-server-harness.mjs may only run under NODE_ENV=test');
  }

  const rawPubKey = process.env.RETAILOS_TEST_LICENSE_PUBLIC_KEY?.trim();
  const licensePublicKey = rawPubKey ? rawPubKey.replace(/\\n/g, '\n') : undefined;
  const rawWatermarkSecret = process.env.RETAILOS_TEST_WATERMARK_SECRET?.trim();
  const watermarkSecret =
    rawWatermarkSecret && rawWatermarkSecret.length >= 32
      ? rawWatermarkSecret
      : randomBytes(32).toString('hex');
  const dailyBackupSecret = randomBytes(32).toString('base64url');
  const testClockFile = process.env.RETAILOS_TEST_CLOCK_FILE?.trim() || null;
  const testExternalClockFile = process.env.RETAILOS_TEST_EXTERNAL_CLOCK_FILE?.trim() || null;

  let initialExternalWatermarkMs = 0;
  if (testExternalClockFile && existsSync(testExternalClockFile)) {
    try {
      const parsed = Number.parseInt(readFileSync(testExternalClockFile, 'utf8').trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) initialExternalWatermarkMs = parsed;
    } catch {
      initialExternalWatermarkMs = 0;
    }
  }

  const appHandle = await createServerApp({
    licensePublicKey,
    watermarkSecret,
    dailyBackupSecret,
    externalWatermarkMs: initialExternalWatermarkMs,
    onWatermarkAdvance: testExternalClockFile
      ? (clockMs) => {
          writeFileSync(testExternalClockFile, String(clockMs), 'utf8');
        }
      : undefined,
    nowProvider: testClockFile
      ? () => {
          try {
            if (existsSync(testClockFile)) {
              const parsed = Number.parseInt(readFileSync(testClockFile, 'utf8').trim(), 10);
              if (Number.isFinite(parsed) && parsed > 0) return parsed;
            }
          } catch {
            // fallback to current wall clock
          }
          return Date.now();
        }
      : undefined,
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void appHandle.shutdown().finally(() => process.exit(0));
    });
  }
}
