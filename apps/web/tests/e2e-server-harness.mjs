import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServerApp } from '../server.mjs';

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

await createServerApp({
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
