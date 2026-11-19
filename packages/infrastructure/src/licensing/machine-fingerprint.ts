import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { arch, cpus, hostname, platform } from 'node:os';
import { formatMachineCodeFromDigest } from '@retailos/core';

const WINDOWS_PROBE_TIMEOUT_MS = 10_000;
const WINDOWS_REG_MAX_ATTEMPTS = 3;
const WINDOWS_REG_RETRY_BACKOFF_MS = 200;
const PLACEHOLDER_UUID_SET = new Set([
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
]);

export type HardwareIdentitySource =
  | 'win32-guid'
  | 'win32-uuid'
  | 'linux-id'
  | 'fallback'
  | 'override';

export interface ResolvedMachineIdentity {
  readonly seed: string;
  readonly machineId: string;
  readonly isHardwareBacked: boolean;
  readonly source: HardwareIdentitySource;
}

export interface ResolveHardwareIdentityOptions {
  readonly seedOverride?: string | undefined;
  readonly platformOverride?: NodeJS.Platform | undefined;
  readonly maxRegAttempts?: number | undefined;
  readonly retryBackoffMs?: number | undefined;
  readonly sleepFn?: ((ms: number) => void) | undefined;
  readonly readWinGuidFn?: (() => string | null) | undefined;
  readonly readWinUuidFn?: (() => string | null) | undefined;
  readonly readLinuxIdFn?: (() => string | null) | undefined;
}

let cachedHardwareIdentity: ResolvedMachineIdentity | null = null;

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, ms);
}

function normalizeUuidCandidate(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const match = raw.match(
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  );
  const captured = match?.[1];
  if (!captured) {
    return null;
  }
  const normalized = captured.toLowerCase();
  return PLACEHOLDER_UUID_SET.has(normalized) ? null : normalized;
}

function readWindowsRegistryMachineGuid(): string | null {
  try {
    const output = execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', windowsHide: true, timeout: WINDOWS_PROBE_TIMEOUT_MS },
    );
    const match = output.match(/MachineGuid\s+REG_[A-Z_]+\s+([^\r\n]+)/i);
    const value = match?.[1]?.trim();
    return value && value.length > 0 ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

function readWindowsHardwareUuid(): string | null {
  try {
    const psOutput = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID'],
      { encoding: 'utf8', windowsHide: true, timeout: WINDOWS_PROBE_TIMEOUT_MS },
    );
    const psUuid = normalizeUuidCandidate(psOutput);
    if (psUuid) {
      return psUuid;
    }
  } catch {
    // Fall back to WMIC below on older Windows hosts where CimInstance/PowerShell fails.
  }

  try {
    const wmicOutput = execFileSync('wmic.exe', ['csproduct', 'get', 'uuid'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: WINDOWS_PROBE_TIMEOUT_MS,
    });
    return normalizeUuidCandidate(wmicOutput);
  } catch {
    return null;
  }
}

function readLinuxMachineId(): string | null {
  for (const candidate of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      if (existsSync(candidate)) {
        const value = readFileSync(candidate, 'utf8').trim();
        if (value.length > 0) {
          return value.toLowerCase();
        }
      }
    } catch {
      // Ignore unreadable system file
    }
  }
  return null;
}

export function deriveMachineIdFromSeed(seed: string): string {
  const digestHex = createHash('sha256')
    .update(`RetailOS-Hardware-v1:${seed}`)
    .digest('hex');
  return formatMachineCodeFromDigest(digestHex);
}

export function resolveHardwareIdentityDetails(
  options?: ResolveHardwareIdentityOptions,
): ResolvedMachineIdentity {
  if (options?.seedOverride !== undefined) {
    return {
      seed: options.seedOverride,
      machineId: deriveMachineIdFromSeed(options.seedOverride),
      isHardwareBacked: true,
      source: 'override',
    };
  }

  const targetPlatform = options?.platformOverride ?? platform();
  if (targetPlatform === 'win32') {
    const maxAttempts = Math.max(1, options?.maxRegAttempts ?? WINDOWS_REG_MAX_ATTEMPTS);
    const backoffMs = Math.max(0, options?.retryBackoffMs ?? WINDOWS_REG_RETRY_BACKOFF_MS);
    const readGuid = options?.readWinGuidFn ?? readWindowsRegistryMachineGuid;
    const sleep = options?.sleepFn ?? sleepSync;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const guid = readGuid();
      if (guid) {
        const seed = `win32-guid:${guid}`;
        return {
          seed,
          machineId: deriveMachineIdFromSeed(seed),
          isHardwareBacked: true,
          source: 'win32-guid',
        };
      }
      if (attempt < maxAttempts && backoffMs > 0) {
        sleep(backoffMs);
      }
    }

    const uuid = (options?.readWinUuidFn ?? readWindowsHardwareUuid)();
    if (uuid) {
      const seed = `win32-uuid:${uuid}`;
      return {
        seed,
        machineId: deriveMachineIdFromSeed(seed),
        isHardwareBacked: true,
        source: 'win32-uuid',
      };
    }
  } else if (targetPlatform === 'linux') {
    const linuxId = (options?.readLinuxIdFn ?? readLinuxMachineId)();
    if (linuxId) {
      const seed = `linux-id:${linuxId}`;
      return {
        seed,
        machineId: deriveMachineIdFromSeed(seed),
        isHardwareBacked: true,
        source: 'linux-id',
      };
    }
  }

  const cpuModel = cpus()[0]?.model?.trim() ?? 'unknown-cpu';
  const fallbackSeed = `fallback:${targetPlatform}|${arch()}|${cpuModel}|${hostname()}`;
  return {
    seed: fallbackSeed,
    machineId: deriveMachineIdFromSeed(fallbackSeed),
    isHardwareBacked: false,
    source: 'fallback',
  };
}

export function resolveRawHardwareIdentity(): string {
  return resolveMachineIdentity().seed;
}

export function resolveMachineIdentity(): ResolvedMachineIdentity {
  if (cachedHardwareIdentity !== null && cachedHardwareIdentity.isHardwareBacked) {
    return cachedHardwareIdentity;
  }
  const resolved = resolveHardwareIdentityDetails();
  // Never cache degraded non-hardware fallback digests so transient boot failures can recover.
  if (resolved.isHardwareBacked) {
    cachedHardwareIdentity = resolved;
  }
  return resolved;
}

export function getMachineId(options?: { readonly seedOverride?: string | undefined }): string {
  if (options?.seedOverride !== undefined) {
    return deriveMachineIdFromSeed(options.seedOverride);
  }
  return resolveMachineIdentity().machineId;
}
