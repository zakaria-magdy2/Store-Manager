import { rename } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServerApp } from '../server.mjs';

const injected = process.env.RETAILOS_TEST_RESTORE_FAILURE === '1';
let candidateMoveFailed = false;
let rollbackMoveFailed = false;
const app = await createServerApp({
  licensePublicKey: process.env.RETAILOS_TEST_LICENSE_PUBLIC_KEY,
  watermarkSecret: process.env.RETAILOS_TEST_WATERMARK_SECRET,
  dailyBackupSecret: process.env.RETAILOS_TEST_DAILY_BACKUP_SECRET,
  licenseIdentityProvider: () => ({ machineId: process.env.RETAILOS_TEST_MACHINE_ID, isHardwareBacked: true }),
  restoreFileOperations: injected ? {
    renameFile: async (from, to) => {
      if (!candidateMoveFailed && from.endsWith('candidate.sqlite') && to.endsWith('retailos.sqlite')) {
        candidateMoveFailed = true;
        process.stdout.write('INJECTED_CANDIDATE_INSTALL_FAILURE\n');
        throw new Error('synthetic candidate installation failure');
      }
      if (candidateMoveFailed && !rollbackMoveFailed && from.endsWith('previous.sqlite') && to.endsWith('retailos.sqlite')) {
        rollbackMoveFailed = true;
        process.stdout.write('INJECTED_ROLLBACK_INSTALL_FAILURE\n');
        throw new Error('synthetic rollback installation failure');
      }
      return rename(from, to);
    },
  } : undefined,
  onRestoreRestartRequested: () => {
    process.stdout.write('RESTORE_RESPONSE_FINISHED\n');
  },
});
if (!app.server.listening) await once(app.server, 'listening');

process.stdout.write(`RESTORE_HARNESS_READY ${app.port}\n`);
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line !== 'TEST_SHUTDOWN') return;
  void app.shutdown().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`TEST_SHUTDOWN_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void app.shutdown().finally(() => process.exit(0));
  });
}
