import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

export const DEFAULT_DESKTOP_PORT = 3210;

export const DESKTOP_IPC_CHANNELS = Object.freeze({
  HOST_STATUS: 'retailos:host:status',
  SYNC_RUN_BATCH: 'retailos:sync:run-batch',
  SYNC_STATS: 'retailos:sync:stats',
  AUDIT_VERIFY_CHAIN: 'retailos:audit:verify-chain',
} as const);

export type DesktopIpcChannel =
  (typeof DESKTOP_IPC_CHANNELS)[keyof typeof DESKTOP_IPC_CHANNELS];

const ALLOWED_IPC_CHANNEL_SET = new Set<string>(Object.values(DESKTOP_IPC_CHANNELS));

export interface DesktopWindowSecurityPolicy {
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly allowedOrigin: string;
  isAllowedNavigationUrl(targetUrl: string): boolean;
  isAllowedIpcChannel(channel: string): channel is DesktopIpcChannel;
}

export function createDesktopWindowSecurityPolicy(
  localLoopbackOrigin = 'http://127.0.0.1:4310',
): DesktopWindowSecurityPolicy {
  const parsedOrigin = new URL(localLoopbackOrigin);
  if (parsedOrigin.protocol !== 'http:' || parsedOrigin.hostname !== '127.0.0.1') {
    throw new Error(
      'DesktopSecurityError: localLoopbackOrigin must bind strictly to http://127.0.0.1',
    );
  }
  const normalizedOrigin = parsedOrigin.origin;

  return Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    allowedOrigin: normalizedOrigin,
    isAllowedNavigationUrl(targetUrl: string): boolean {
      try {
        const parsed = new URL(targetUrl);
        return parsed.origin === normalizedOrigin;
      } catch {
        return false;
      }
    },
    isAllowedIpcChannel(channel: string): channel is DesktopIpcChannel {
      return ALLOWED_IPC_CHANNEL_SET.has(channel);
    },
  });
}

export interface DesktopDataPaths {
  readonly userDataDir: string;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly backupDir: string;
  readonly dailyBackupDir: string;
}

export function resolveDesktopDataPaths(userDataDir: string): DesktopDataPaths {
  const trimmed = userDataDir.trim();
  if (!trimmed) {
    throw new Error('DesktopPathError: userDataDir must be a non-empty directory path');
  }
  const resolvedUserData = resolve(trimmed);
  const dataDir = join(resolvedUserData, 'data');
  const backupDir = join(dataDir, 'backups');
  return Object.freeze({
    userDataDir: resolvedUserData,
    dataDir,
    databasePath: join(dataDir, 'retailos.sqlite'),
    backupDir,
    dailyBackupDir: join(backupDir, 'daily'),
  });
}

export function buildServerProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  paths: DesktopDataPaths,
  port: number,
  options?: {
    readonly runAsNode?: boolean | undefined;
    readonly desktopVersion?: string | undefined;
  },
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    PORT: String(port),
    RETAILOS_DATA_DIR: paths.dataDir,
    RETAILOS_DB_PATH: paths.databasePath,
    RETAILOS_BACKUP_DIR: paths.backupDir,
  };
  if (options?.runAsNode) {
    nextEnv.ELECTRON_RUN_AS_NODE = '1';
  }
  if (options?.desktopVersion) {
    nextEnv.RETAILOS_DESKTOP_VERSION = options.desktopVersion;
  }
  return nextEnv;
}

export async function isPortFreeOnLoopback(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return false;
  }
  return new Promise<boolean>((resolvePromise) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => {
      resolvePromise(false);
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolvePromise(true));
    });
  });
}

export async function resolveAvailableLoopbackPort(
  preferredPort = DEFAULT_DESKTOP_PORT,
): Promise<number> {
  if (await isPortFreeOnLoopback(preferredPort)) {
    return preferredPort;
  }
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (error) => rejectPromise(error));
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
        probe.close(() =>
          rejectPromise(new Error('Failed to allocate a loopback port for RetailOS server')),
        );
        return;
      }
      const allocatedPort = address.port;
      probe.close((closeError) => {
        if (closeError) {
          rejectPromise(closeError);
          return;
        }
        resolvePromise(allocatedPort);
      });
    });
  });
}

export interface BootstrapIdentityCheckResult {
  readonly ok: boolean;
  readonly configured?: boolean | undefined;
  readonly companyName?: string | undefined;
  readonly companyCode?: string | undefined;
}

export async function verifyBootstrapIdentity(
  origin: string,
  timeoutMs = 1500,
): Promise<BootstrapIdentityCheckResult> {
  try {
    const response = await fetch(`${origin}/api/bootstrap`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false };
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return { ok: false };
    }
    const payload = (await response.json()) as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object' || typeof payload.configured !== 'boolean') {
      return { ok: false };
    }
    return {
      ok: true,
      configured: payload.configured,
      companyName: typeof payload.companyName === 'string' ? payload.companyName : undefined,
      companyCode: typeof payload.companyCode === 'string' ? payload.companyCode : undefined,
    };
  } catch {
    return { ok: false };
  }
}

export async function waitForServerReady(options: {
  readonly origin: string;
  readonly child: ChildProcess;
  readonly logs?: readonly string[] | undefined;
  readonly maxAttempts?: number | undefined;
  readonly intervalMs?: number | undefined;
}): Promise<BootstrapIdentityCheckResult> {
  const maxAttempts = options.maxAttempts ?? 240;
  const intervalMs = options.intervalMs ?? 125;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.child.exitCode !== null) {
      const tail = options.logs ? options.logs.slice(-25).join('') : '';
      throw new Error(
        `Embedded RetailOS server exited prematurely with code ${String(options.child.exitCode)}.${tail ? `\n${tail}` : ''}`,
      );
    }
    const identity = await verifyBootstrapIdentity(options.origin);
    if (identity.ok) {
      return identity;
    }
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, intervalMs);
      timer.unref();
    });
  }

  const tail = options.logs ? options.logs.slice(-25).join('') : '';
  throw new Error(
    `Timed out waiting for embedded RetailOS server at ${options.origin}.${tail ? `\n${tail}` : ''}`,
  );
}

interface ControlFileState {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

async function readControlFileState(dataDir: string): Promise<ControlFileState | null> {
  try {
    const raw = await readFile(join(dataDir, '.retailos-control.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.pid === 'number' &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.port === 'number' &&
      Number.isSafeInteger(parsed.port) &&
      parsed.port > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
    ) {
      return {
        pid: parsed.pid,
        port: parsed.port,
        token: parsed.token,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function forceTerminatePid(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    return;
  }
  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      execFile(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true },
        () => resolvePromise(),
      );
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process already exited.
  }
}

export async function stopManagedServerProcess(options: {
  readonly child: ChildProcess | null;
  readonly dataDir: string;
  readonly origin: string;
  readonly timeoutMs?: number | undefined;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const control = await readControlFileState(options.dataDir);
  const trackedPids = new Set<number>();
  if (options.child?.pid && Number.isSafeInteger(options.child.pid) && options.child.pid > 0) {
    trackedPids.add(options.child.pid);
  }
  if (control) {
    trackedPids.add(control.pid);
  }

  if (control) {
    const controlOrigin = `http://127.0.0.1:${String(control.port)}`;
    try {
      await fetch(`${controlOrigin}/api/internal/shutdown`, {
        method: 'POST',
        headers: {
          Origin: controlOrigin,
          'x-retailos-shutdown-token': control.token,
        },
        signal: AbortSignal.timeout(2500),
      });
    } catch {
      // Fall back to process signals below.
    }
  }

  if (options.child && options.child.exitCode === null) {
    await Promise.race([
      once(options.child, 'exit').catch(() => undefined),
      new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, timeoutMs);
        timer.unref();
      }),
    ]);
  }

  const pollDeadline = Date.now() + 1500;
  while (Date.now() < pollDeadline) {
    const anyAlive = Array.from(trackedPids).some((pid) => isProcessAlive(pid));
    if (!anyAlive) {
      return;
    }
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 100);
      timer.unref();
    });
  }

  for (const pid of trackedPids) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Ignore already dead process.
      }
    }
  }

  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 500);
    timer.unref();
  });

  for (const pid of trackedPids) {
    await forceTerminatePid(pid);
  }
}

export function startManagedServerChild(options: {
  readonly execPath: string;
  readonly serverScriptPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): { readonly child: ChildProcess; readonly logs: string[] } {
  const logs: string[] = [];
  const appendLog = (chunk: Buffer | string) => {
    logs.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    if (logs.length > 200) {
      logs.shift();
    }
  };

  const child = spawn(options.execPath, [options.serverScriptPath], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);

  return { child, logs };
}
