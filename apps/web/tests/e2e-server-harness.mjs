import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
const testClockFile = process.env.RETAILOS_TEST_CLOCK_FILE?.trim() || null;

await createServerApp({
  licensePublicKey,
  watermarkSecret,
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
