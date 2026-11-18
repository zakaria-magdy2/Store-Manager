import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { arch, cpus, hostname, platform } from 'node:os';
import { formatMachineCodeFromDigest } from '@retailos/core';

let cachedMachineId: string | null = null;

function readWindowsRegistryMachineGuid(): string | null {
  try {
    const output = execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
    );
    const match = output.match(/MachineGuid\s+REG_[A-Z_]+\s+([^\r\n]+)/i);
    const value = match?.[1]?.trim();
    return value && value.length > 0 ? value.toLowerCase() : null;
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

export function resolveRawHardwareIdentity(): string {
  if (platform() === 'win32') {
    const guid = readWindowsRegistryMachineGuid();
    if (guid) {
      return `win32-guid:${guid}`;
    }
  } else if (platform() === 'linux') {
    const linuxId = readLinuxMachineId();
    if (linuxId) {
      return `linux-id:${linuxId}`;
    }
  }

  const cpuModel = cpus()[0]?.model?.trim() ?? 'unknown-cpu';
  return `fallback:${platform()}|${arch()}|${cpuModel}|${hostname()}`;
}

export function deriveMachineIdFromSeed(seed: string): string {
  const digestHex = createHash('sha256')
    .update(`RetailOS-Hardware-v1:${seed}`)
    .digest('hex');
  return formatMachineCodeFromDigest(digestHex);
}

export function getMachineId(options?: { readonly seedOverride?: string | undefined }): string {
  if (options?.seedOverride !== undefined) {
    return deriveMachineIdFromSeed(options.seedOverride);
  }
  if (cachedMachineId !== null) {
    return cachedMachineId;
  }
  cachedMachineId = deriveMachineIdFromSeed(resolveRawHardwareIdentity());
  return cachedMachineId;
}
