export type LicenseStatus =
  | 'ACTIVE'
  | 'EXPIRED'
  | 'UNLICENSED'
  | 'MACHINE_MISMATCH'
  | 'CLOCK_TAMPERED';

export interface LicensePayload {
  readonly licenseId: string;
  readonly customerName: string;
  readonly machineId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly planName: string;
}

export interface LicenseEvaluation {
  readonly status: LicenseStatus;
  readonly machineId: string;
  readonly customerName: string | null;
  readonly planName: string | null;
  readonly issuedAt: string | null;
  readonly expiresAt: string | null;
  readonly daysRemaining: number | null;
  readonly licenseId: string | null;
  readonly reason: string | null;
}

export interface ParsedLicenseToken {
  readonly signingInput: string;
  readonly payloadBase64Url: string;
  readonly signatureBase64Url: string;
}

export const LICENSE_TOKEN_PREFIX = 'ROS1';
export const MACHINE_ID_PATTERN =
  /^ROS-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;

const SAFE_MACHINE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const MS_PER_DAY = 86_400_000;

/**
 * Formats a SHA-256 hex digest deterministically into `ROS-XXXX-XXXX-XXXX`
 * avoiding visually ambiguous characters (`0/O`, `1/I`).
 */
export function formatMachineCodeFromDigest(digestHex: string): string {
  const normalized = digestHex.trim().toLowerCase();
  if (!/^[0-9a-f]{24,}$/.test(normalized)) {
    throw new Error('Invalid hardware digest for machine code formatting');
  }

  let chars = '';
  for (let i = 0; i < 12; i += 1) {
    const hiHex = normalized.charCodeAt(i * 2);
    const loHex = normalized.charCodeAt(i * 2 + 1);
    const byteVal = hexNibble(hiHex) * 16 + hexNibble(loHex);
    const alphabetIdx = byteVal % SAFE_MACHINE_ALPHABET.length;
    chars += SAFE_MACHINE_ALPHABET.charAt(alphabetIdx);
  }

  return `ROS-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

function hexNibble(charCode: number): number {
  if (charCode >= 48 && charCode <= 57) return charCode - 48;
  return charCode - 87; // 'a'..'f' -> 10..15
}

export function parseLicenseTokenFormat(rawToken: string): ParsedLicenseToken | null {
  const trimmed = rawToken.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [prefix, payloadBase64Url, signatureBase64Url] = parts;
  if (
    prefix !== LICENSE_TOKEN_PREFIX ||
    !payloadBase64Url ||
    !signatureBase64Url ||
    !BASE64URL_SEGMENT.test(payloadBase64Url) ||
    !BASE64URL_SEGMENT.test(signatureBase64Url)
  ) {
    return null;
  }

  return {
    signingInput: `${prefix}.${payloadBase64Url}`,
    payloadBase64Url,
    signatureBase64Url,
  };
}

export function validateLicensePayloadObject(value: unknown): LicensePayload | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const fields = [
    'licenseId',
    'customerName',
    'machineId',
    'issuedAt',
    'expiresAt',
    'planName',
  ] as const;

  for (const field of fields) {
    if (typeof candidate[field] !== 'string' || candidate[field].trim().length === 0) {
      return null;
    }
  }

  const machineId = (candidate.machineId as string).trim();
  if (!MACHINE_ID_PATTERN.test(machineId)) {
    return null;
  }

  const issuedMs = Date.parse(candidate.issuedAt as string);
  const expiresMs = Date.parse(candidate.expiresAt as string);
  if (!globalThis.Number.isFinite(issuedMs) || !globalThis.Number.isFinite(expiresMs)) {
    return null;
  }
  if (expiresMs <= issuedMs) {
    return null;
  }

  return {
    licenseId: (candidate.licenseId as string).trim(),
    customerName: (candidate.customerName as string).trim(),
    machineId,
    issuedAt: (candidate.issuedAt as string).trim(),
    expiresAt: (candidate.expiresAt as string).trim(),
    planName: (candidate.planName as string).trim(),
  };
}

export function computeRemainingDaysCeiling(nowMs: number, expiresMs: number): number {
  const diff = expiresMs - nowMs;
  if (diff <= 0) {
    return 0;
  }
  const remainder = diff % MS_PER_DAY;
  return remainder === 0 ? diff / MS_PER_DAY : (diff - remainder) / MS_PER_DAY + 1;
}
