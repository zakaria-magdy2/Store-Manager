import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeTestEnvironment,
  cleanupPackagedTestRun,
  collectProcessTreeIdentities,
  isSameProcessIdentity,
  listRunningRetailOsPids,
  ProcessEnumerationError,
  queryWindowsProcessTable,
  terminateVerifiedProcess,
  validateServerProcessOwnership,
  waitForVerifiedProcessesExit,
} from '../scripts/test-packaged-runtime.mjs';

const TEST_EXE = 'C:\\Temp\\retailos-smoke\\app\\RetailOS.exe';
const TEST_SERVER_SCRIPT = 'C:\\Temp\\retailos-smoke\\app\\resources\\web\\server.mjs';

function makeIdentity({
  pid,
  parentPid = 100,
  name = 'RetailOS.exe',
  executablePath = TEST_EXE,
  creationDate = '2026-11-19T18:00:00.0000000Z',
  commandLine = `"${TEST_EXE}"`,
}) {
  return {
    pid,
    parentPid,
    name,
    executablePath,
    commandLine,
    creationDate,
  };
}

test('refuses termination when a PID is reused by a different process or spoofed in control file', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'retailos-test-reuse-'));
  try {
    const sentinel = join(sandbox, 'sentinel.txt');
    await writeFile(sentinel, 'keep', 'utf8');
    const controlFilePath = join(sandbox, '.retailos-control.json');

    const expectedMain = makeIdentity({
      pid: 4100,
      parentPid: 900,
      creationDate: '2026-11-19T18:00:00.0000000Z',
    });

    // 1a: PID reused by a completely different executable
    const tableDifferentExe = new Map([
      [
        4100,
        makeIdentity({
          pid: 4100,
          parentPid: 900,
          name: 'notepad.exe',
          executablePath: 'C:\\Windows\\System32\\notepad.exe',
          creationDate: '2026-11-19T18:05:00.0000000Z',
        }),
      ],
    ]);
    const killedPids = [];
    const res1 = terminateVerifiedProcess(expectedMain, {
      queryProcessTable: () => tableDifferentExe,
      killSinglePid: (pid) => killedPids.push(pid),
      platform: 'win32',
    });
    assert.equal(res1.status, 'IDENTITY_MISMATCH');
    assert.deepEqual(killedPids, []);

    // 1b: Same ExecutablePath, but different CreationDate (unrelated RetailOS.exe reused PID)
    const tableDifferentCreation = new Map([
      [
        4100,
        makeIdentity({
          pid: 4100,
          parentPid: 900,
          executablePath: TEST_EXE,
          creationDate: '2026-11-19T18:09:00.0000000Z',
        }),
      ],
    ]);
    const res2 = terminateVerifiedProcess(expectedMain, {
      queryProcessTable: () => tableDifferentCreation,
      killSinglePid: (pid) => killedPids.push(pid),
      platform: 'win32',
    });
    assert.equal(res2.status, 'IDENTITY_MISMATCH');
    assert.deepEqual(killedPids, []);
    assert.equal(isSameProcessIdentity(expectedMain, tableDifferentCreation.get(4100), { platform: 'win32' }), false);

    // 1c: Control file references a spoofed/unrelated PID pointing to a live unrelated RetailOS.exe
    const unrelatedRetailOs = makeIdentity({
      pid: 9200,
      parentPid: 1111, // Different parent
      executablePath: TEST_EXE,
      commandLine: `"${TEST_EXE}"`, // Missing server.mjs & --electron-stdio-secret
      creationDate: '2026-11-19T18:01:00.0000000Z',
    });
    await writeFile(controlFilePath, JSON.stringify({ pid: 9200, port: 3210 }), 'utf8');

    const ownershipCheck = validateServerProcessOwnership(unrelatedRetailOs, {
      expectedExePath: TEST_EXE,
      expectedParentPid: expectedMain.pid,
      expectedServerScriptPath: TEST_SERVER_SCRIPT,
      preExistingPids: new Set(),
      spawnedMainIdentity: expectedMain,
      platform: 'win32',
    });
    assert.equal(ownershipCheck.valid, false);
    assert.match(ownershipCheck.reason, /Ownership proof failed/);

    const tableWithUnrelated = new Map([[9200, unrelatedRetailOs]]);
    const ownedProcesses = new Map([[expectedMain.pid, { identity: expectedMain, depth: 0 }]]);
    const cleanupResult = await cleanupPackagedTestRun({
      ownedProcesses,
      spawnedMainIdentity: expectedMain,
      controlFilePath,
      expectedExePath: TEST_EXE,
      expectedServerScriptPath: TEST_SERVER_SCRIPT,
      preExistingPids: new Set([7777]),
      tempSandbox: sandbox,
      queryProcessTable: () => tableWithUnrelated,
      killSinglePid: (pid) => killedPids.push(pid),
      waitTimeoutMs: 200,
      pollIntervalMs: 20,
      platform: 'win32',
    });

    assert.deepEqual(killedPids, [], 'Must NEVER kill reused or unowned PIDs');
    assert.equal(cleanupResult.reusedPids.some((r) => r.pid === 9200), true);
    assert.equal(existsSync(sandbox), false, 'Sandbox cleans up once owned processes have exited');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('never terminates processes and preserves sandbox when process identity cannot be verified', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'retailos-test-unverified-'));
  try {
    const sentinel = join(sandbox, 'sentinel.txt');
    await writeFile(sentinel, 'preserve', 'utf8');

    // 2a: Recorded identity missing CreationDate -> terminateVerifiedProcess refuses
    const incompleteRecorded = {
      pid: 5100,
      parentPid: 100,
      name: 'RetailOS.exe',
      executablePath: TEST_EXE,
      creationDate: null,
    };
    const killedPids = [];
    const resRecorded = terminateVerifiedProcess(incompleteRecorded, {
      queryProcessTable: () => new Map([[5100, makeIdentity({ pid: 5100 })]]),
      killSinglePid: (pid) => killedPids.push(pid),
      platform: 'win32',
    });
    assert.equal(resRecorded.status, 'VERIFICATION_FAILED');
    assert.deepEqual(killedPids, []);

    // 2b: Live CIM record missing ExecutablePath/CreationDate -> cleanup throws & preserves sandbox
    const expectedMain = makeIdentity({ pid: 5101 });
    const ownedProcesses = new Map([[expectedMain.pid, { identity: expectedMain, depth: 0 }]]);
    const liveIncompleteTable = new Map([
      [
        5101,
        {
          pid: 5101,
          parentPid: 100,
          name: 'RetailOS.exe',
          executablePath: null,
          commandLine: null,
          creationDate: null,
        },
      ],
    ]);

    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses,
          spawnedMainIdentity: expectedMain,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandbox,
          queryProcessTable: () => liveIncompleteTable,
          killSinglePid: (pid) => killedPids.push(pid),
          waitTimeoutMs: 150,
          pollIntervalMs: 25,
          platform: 'win32',
        }),
      (err) => {
        assert.match(err.message, /Preserving temporary sandbox/);
        assert.match(err.message, /PID=5101/);
        return true;
      },
    );
    assert.deepEqual(killedPids, [], 'Must NEVER kill process with unverifiable identity');
    assert.equal(existsSync(sandbox), true, 'Sandbox must NOT be deleted when identity verification fails');
    assert.equal(existsSync(sentinel), true);

    // 2c: Spawned main PID never verified at launch (unverifiedMainPid !== null)
    const ownedEmpty = new Map();
    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: ownedEmpty,
          spawnedMainIdentity: null,
          unverifiedMainPid: 5199,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandbox,
          queryProcessTable: () => new Map(),
          killSinglePid: (pid) => killedPids.push(pid),
          waitTimeoutMs: 150,
          pollIntervalMs: 25,
          platform: 'win32',
        }),
      (err) => {
        assert.match(err.message, /PID=5199/);
        assert.match(err.message, /could not be identity-verified/);
        return true;
      },
    );
    assert.deepEqual(killedPids, []);
    assert.equal(existsSync(sandbox), true);
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('fails closed on PowerShell/CIM failure instead of treating failure as empty process list', async () => {
  // 3a: Non-zero exit from PowerShell/CIM
  assert.throws(
    () =>
      queryWindowsProcessTable({
        platform: 'win32',
        runCommand: () => ({ status: 1, stdout: '', stderr: 'Access denied' }),
      }),
    ProcessEnumerationError,
  );

  // 3b: Invalid JSON
  assert.throws(
    () =>
      queryWindowsProcessTable({
        platform: 'win32',
        runCommand: () => ({ status: 0, stdout: '{broken-json', stderr: '' }),
      }),
    ProcessEnumerationError,
  );

  // 3c: Empty array `[]` on a live host is treated as failure (fail-closed)
  assert.throws(
    () =>
      queryWindowsProcessTable({
        platform: 'win32',
        runCommand: () => ({ status: 0, stdout: '[]', stderr: '' }),
      }),
    ProcessEnumerationError,
  );

  // 3d: listRunningRetailOsPids distinguishes failure from genuine empty RetailOS count
  const failedListing = listRunningRetailOsPids({
    platform: 'win32',
    runCommand: () => ({ status: 1, stdout: '', stderr: 'CIM service unavailable' }),
  });
  assert.equal(failedListing.ok, false);
  assert.ok(failedListing.error instanceof ProcessEnumerationError);

  const genuineZeroListing = listRunningRetailOsPids({
    platform: 'win32',
    runCommand: () => ({
      status: 0,
      stdout: JSON.stringify([
        {
          ProcessId: 4,
          ParentProcessId: 0,
          Name: 'System',
          ExecutablePath: 'C:\\Windows\\System32\\ntoskrnl.exe',
          CommandLine: null,
          CreationDate: '2026-11-19T10:00:00.0000000Z',
        },
      ]),
      stderr: '',
    }),
  });
  assert.deepEqual(genuineZeroListing, { ok: true, pids: [] });

  // 3e: assertSafeTestEnvironment aborts fail-closed when CIM enumeration fails
  assert.throws(
    () =>
      assertSafeTestEnvironment(null, join(tmpdir(), 'retailos-safe-check-dir'), {
        listRunningPids: () => failedListing,
        platform: 'win32',
      }),
    /fail-closed.*unable to verify whether RetailOS\.exe is already running/i,
  );

  // 3f: collectProcessTreeIdentities throws instead of returning empty tree on CIM failure
  assert.throws(
    () =>
      collectProcessTreeIdentities(makeIdentity({ pid: 6000 }), {
        queryProcessTable: () => {
          throw new ProcessEnumerationError('CIM failure during tree collection');
        },
        platform: 'win32',
      }),
    ProcessEnumerationError,
  );

  // 3g: cleanupPackagedTestRun refuses blind kill and preserves sandbox when CIM fails
  const sandbox = await mkdtemp(join(tmpdir(), 'retailos-test-cimfail-'));
  try {
    const sentinel = join(sandbox, 'sentinel.txt');
    await writeFile(sentinel, 'preserve', 'utf8');
    const killedPids = [];
    const mainId = makeIdentity({ pid: 6001 });
    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: new Map([[6001, { identity: mainId, depth: 0 }]]),
          spawnedMainIdentity: mainId,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandbox,
          queryProcessTable: () => {
            throw new ProcessEnumerationError('PowerShell crashed');
          },
          killSinglePid: (pid) => killedPids.push(pid),
          waitTimeoutMs: 120,
          pollIntervalMs: 20,
          platform: 'win32',
        }),
      /Preserving temporary sandbox.*PowerShell crashed/,
    );
    assert.deepEqual(killedPids, []);
    assert.equal(existsSync(sandbox), true);
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('preserves tempSandbox and reports clear manual-cleanup error when owned process outlives wait timeout', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'retailos-test-timeout-'));
  try {
    const sentinel = join(sandbox, 'keep.txt');
    await writeFile(sentinel, 'must-stay', 'utf8');

    const mainId = makeIdentity({
      pid: 7100,
      parentPid: 100,
      creationDate: '2026-11-19T18:10:00.0000000Z',
    });
    const serverId = makeIdentity({
      pid: 7101,
      parentPid: 7100,
      commandLine: `"${TEST_EXE}" "${TEST_SERVER_SCRIPT}" --electron-stdio-secret`,
      creationDate: '2026-11-19T18:10:01.0000000Z',
    });
    const unrelatedExisting = makeIdentity({
      pid: 9999,
      parentPid: 50,
      creationDate: '2026-11-19T17:00:00.0000000Z',
    });

    const stubbornTable = new Map([
      [mainId.pid, mainId],
      [serverId.pid, serverId],
      [unrelatedExisting.pid, unrelatedExisting],
    ]);

    const killedPids = [];
    const owned = new Map([
      [mainId.pid, { identity: mainId, depth: 0 }],
      [serverId.pid, { identity: serverId, depth: 1 }],
    ]);

    // waitForVerifiedProcessesExit reports stubborn processes directly
    const waitResult = await waitForVerifiedProcessesExit([mainId, serverId], {
      queryProcessTable: () => stubbornTable,
      timeoutMs: 80,
      pollIntervalMs: 20,
      platform: 'win32',
    });
    assert.equal(waitResult.stillRunning.length, 2);

    // cleanupPackagedTestRun kills verified children first then parent, times out, preserves sandbox
    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: owned,
          spawnedMainIdentity: mainId,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set([unrelatedExisting.pid]),
          tempSandbox: sandbox,
          primaryError: new Error('Simulated test failure'),
          queryProcessTable: () => stubbornTable,
          killSinglePid: (pid) => killedPids.push(pid),
          waitTimeoutMs: 100,
          pollIntervalMs: 25,
          platform: 'win32',
        }),
      (err) => {
        assert.ok(err instanceof AggregateError);
        assert.match(err.message, /Simulated test failure/);
        assert.match(err.message, /Preserving temporary sandbox/);
        assert.match(err.message, /PID=7101/);
        assert.match(err.message, /PID=7100/);
        assert.match(err.message, /2026-11-19T18:10:01\.0000000Z/);
        return true;
      },
    );

    assert.deepEqual(
      killedPids,
      [7101, 7100],
      'Should terminate verified child before parent and NEVER touch unrelated PID 9999',
    );
    assert.equal(
      existsSync(sandbox),
      true,
      'tempSandbox MUST NOT be deleted while owned processes remain alive',
    );
    assert.equal(existsSync(sentinel), true);
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('deletes tempSandbox only after verified owned processes exit cleanly without touching preExistingPids', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'retailos-test-clean-'));
  try {
    const sentinel = join(sandbox, 'artifact.txt');
    await writeFile(sentinel, 'delete-after-exit', 'utf8');

    const mainId = makeIdentity({
      pid: 8100,
      parentPid: 100,
      creationDate: '2026-11-19T18:20:00.0000000Z',
    });
    const serverId = makeIdentity({
      pid: 8101,
      parentPid: 8100,
      commandLine: `"${TEST_EXE}" "${TEST_SERVER_SCRIPT}" --electron-stdio-secret`,
      creationDate: '2026-11-19T18:20:01.0000000Z',
    });
    const preExisting = makeIdentity({
      pid: 8200,
      parentPid: 8100, // Even if somehow matched as a parent, preExistingPids excludes it
      creationDate: '2026-11-19T17:00:00.0000000Z',
    });

    const liveTable = new Map([
      [mainId.pid, mainId],
      [serverId.pid, serverId],
      [preExisting.pid, preExisting],
    ]);
    const killedPids = [];

    const result = await cleanupPackagedTestRun({
      ownedProcesses: new Map([
        [mainId.pid, { identity: mainId, depth: 0 }],
        [serverId.pid, { identity: serverId, depth: 1 }],
      ]),
      spawnedMainIdentity: mainId,
      expectedExePath: TEST_EXE,
      expectedServerScriptPath: TEST_SERVER_SCRIPT,
      preExistingPids: new Set([preExisting.pid]),
      tempSandbox: sandbox,
      queryProcessTable: () => new Map(liveTable),
      killSinglePid: (pid) => {
        killedPids.push(pid);
        liveTable.delete(pid);
      },
      waitTimeoutMs: 500,
      pollIntervalMs: 25,
      platform: 'win32',
    });

    assert.equal(result.cleanedSandbox, true);
    assert.deepEqual(killedPids, [8101, 8100]);
    assert.equal(liveTable.has(preExisting.pid), true, 'Pre-existing process must remain untouched');
    assert.equal(existsSync(sandbox), false, 'Sandbox must be deleted once all owned processes exit');
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }
});
