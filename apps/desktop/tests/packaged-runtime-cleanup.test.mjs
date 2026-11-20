import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeTestEnvironment,
  captureSpawnedMainIdentity,
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

test('captures only the spawned RetailOS process with a complete matching executable identity', async () => {
  const expected = makeIdentity({ pid: 4100, executablePath: TEST_EXE });
  const captured = await captureSpawnedMainIdentity(4100, TEST_EXE, {
    queryProcessTable: () => new Map([[4100, expected]]),
    platform: 'win32',
  });
  assert.equal(captured, expected);

  const wrongExecutable = makeIdentity({ pid: 4101, executablePath: 'C:\\Temp\\other\\RetailOS.exe' });
  await assert.rejects(
    () => captureSpawnedMainIdentity(4101, TEST_EXE, {
      queryProcessTable: () => new Map([[4101, wrongExecutable]]),
      timeoutMs: 50,
      platform: 'win32',
    }),
    /executable mismatch/,
  );
});

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

test('stops tree traversal when root PID does not exist or was reused and tracks verified server tree independently', async () => {
  const mainId = makeIdentity({
    pid: 9100,
    parentPid: 100,
    creationDate: '2026-11-19T18:30:00.0000000Z',
  });

  // 1a: Root PID does not exist, and an unproven process has ParentProcessId == mainId.pid
  // -> Do NOT kill PID 9150, record it as unverified blocker, and preserve tempSandbox
  const orphanTableWithAbsentRoot = new Map([
    [
      9150,
      makeIdentity({
        pid: 9150,
        parentPid: 9100,
        name: 'chrome.exe',
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        creationDate: '2026-11-19T18:35:00.0000000Z',
      }),
    ],
  ]);
  const missingRootTree = collectProcessTreeIdentities(mainId, {
    queryProcessTable: () => orphanTableWithAbsentRoot,
    platform: 'win32',
  });
  assert.equal(missingRootTree.rootStatus, 'ROOT_EXITED');
  assert.equal(missingRootTree.identities.size, 0);
  assert.equal(missingRootTree.unverifiedDescendants.length, 1);
  assert.equal(missingRootTree.unverifiedDescendants[0].identity.pid, 9150);

  const sandboxAbsentRoot = await mkdtemp(join(tmpdir(), 'retailos-test-exited-root-'));
  try {
    const sentinel = join(sandboxAbsentRoot, 'keep-exited.txt');
    await writeFile(sentinel, 'preserve', 'utf8');
    const killedOnExited = [];
    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: new Map([[mainId.pid, { identity: mainId, depth: 0 }]]),
          spawnedMainIdentity: mainId,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandboxAbsentRoot,
          queryProcessTable: () => new Map(orphanTableWithAbsentRoot),
          killSinglePid: (pid) => killedOnExited.push(pid),
          waitTimeoutMs: 200,
          pollIntervalMs: 20,
          platform: 'win32',
        }),
      (err) => {
        assert.match(err.message, /Preserving temporary sandbox/);
        assert.match(err.message, /PID=9150/);
        return true;
      },
    );
    assert.deepEqual(killedOnExited, [], 'Must NEVER kill unproven potential descendant PID 9150');
    assert.equal(existsSync(sandboxAbsentRoot), true, 'Sandbox MUST NOT be deleted when unproven PID 9150 exists');
    assert.equal(existsSync(sentinel), true);
  } finally {
    await rm(sandboxAbsentRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  // 1b-i: Root PID reused by unrelated process with children referencing ParentProcessId == 9100
  // -> Do NOT kill reused root or any child/grandchild/orphan, fail closed and preserve sandbox
  const reusedRoot = makeIdentity({
    pid: 9100,
    parentPid: 100,
    name: 'pwsh.exe',
    executablePath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    creationDate: '2026-11-19T18:40:00.0000000Z',
  });
  const reusedRootChild = makeIdentity({
    pid: 9101,
    parentPid: 9100,
    name: 'node.exe',
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    creationDate: '2026-11-19T18:40:02.0000000Z',
  });
  const reusedRootGrandchild = makeIdentity({
    pid: 9102,
    parentPid: 9101,
    name: 'cmd.exe',
    executablePath: 'C:\\Windows\\System32\\cmd.exe',
    creationDate: '2026-11-19T18:40:03.0000000Z',
  });
  const orphanChildOfOldRoot = makeIdentity({
    pid: 9103,
    parentPid: 9100,
    name: 'helper.exe',
    executablePath: 'C:\\Tools\\helper.exe',
    creationDate: '2026-11-19T18:30:05.0000000Z',
  });
  const reusedTableWithChildren = new Map([
    [reusedRoot.pid, reusedRoot],
    [reusedRootChild.pid, reusedRootChild],
    [reusedRootGrandchild.pid, reusedRootGrandchild],
    [orphanChildOfOldRoot.pid, orphanChildOfOldRoot],
  ]);
  const reusedTree = collectProcessTreeIdentities(mainId, {
    queryProcessTable: () => reusedTableWithChildren,
    platform: 'win32',
  });
  assert.equal(reusedTree.rootStatus, 'ROOT_REUSED');
  assert.equal(reusedTree.identities.size, 0);
  const flaggedReusedChildren = reusedTree.unverifiedDescendants.map((d) => d.identity.pid).sort((a, b) => a - b);
  assert.deepEqual(flaggedReusedChildren, [9101, 9103]);

  const sandboxReusedWithChildren = await mkdtemp(join(tmpdir(), 'retailos-test-reused-root-children-'));
  try {
    const sentinel = join(sandboxReusedWithChildren, 'keep-reused.txt');
    await writeFile(sentinel, 'preserve', 'utf8');
    const killedOnReusedChildren = [];
    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: new Map([[mainId.pid, { identity: mainId, depth: 0 }]]),
          spawnedMainIdentity: mainId,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandboxReusedWithChildren,
          queryProcessTable: () => new Map(reusedTableWithChildren),
          killSinglePid: (pid) => killedOnReusedChildren.push(pid),
          waitTimeoutMs: 200,
          pollIntervalMs: 20,
          platform: 'win32',
        }),
      (err) => {
        assert.match(err.message, /Preserving temporary sandbox/);
        assert.match(err.message, /PID=9101/);
        assert.match(err.message, /PID=9103/);
        return true;
      },
    );
    assert.deepEqual(
      killedOnReusedChildren,
      [],
      'Must NEVER kill reused root or any potential/grandchild processes',
    );
    assert.equal(
      existsSync(sandboxReusedWithChildren),
      true,
      'Sandbox MUST NOT be deleted when processes reference reused root PID 9100',
    );
    assert.equal(existsSync(sentinel), true);
  } finally {
    await rm(sandboxReusedWithChildren, { recursive: true, force: true }).catch(() => undefined);
  }

  // 1b-ii: Root PID reused with NO processes referencing ParentProcessId == 9100
  // -> Never kills reused root and cleanly removes tempSandbox
  const reusedTableClean = new Map([[reusedRoot.pid, reusedRoot]]);
  const sandboxReusedClean = await mkdtemp(join(tmpdir(), 'retailos-test-reused-root-clean-'));
  try {
    const killedOnReusedClean = [];
    const cleanupReused = await cleanupPackagedTestRun({
      ownedProcesses: new Map([[mainId.pid, { identity: mainId, depth: 0 }]]),
      spawnedMainIdentity: mainId,
      expectedExePath: TEST_EXE,
      expectedServerScriptPath: TEST_SERVER_SCRIPT,
      preExistingPids: new Set(),
      tempSandbox: sandboxReusedClean,
      queryProcessTable: () => new Map(reusedTableClean),
      killSinglePid: (pid) => killedOnReusedClean.push(pid),
      waitTimeoutMs: 200,
      pollIntervalMs: 20,
      platform: 'win32',
    });
    assert.deepEqual(killedOnReusedClean, [], 'Must NEVER kill reused root');
    assert.equal(cleanupReused.reusedPids.some((r) => r.pid === 9100), true);
    assert.equal(cleanupReused.cleanedSandbox, true);
    assert.equal(existsSync(sandboxReusedClean), false);
  } finally {
    await rm(sandboxReusedClean, { recursive: true, force: true }).catch(() => undefined);
  }

  // 1c-i: Root exited, verified Server tree (9201 -> 9202) and unrelated process (parentPid=555)
  // -> Cleans verified server tree, never touches PID 9301, deletes sandbox
  const sandboxServerTreeClean = await mkdtemp(join(tmpdir(), 'retailos-test-srv-tree-clean-'));
  try {
    const verifiedServer = makeIdentity({
      pid: 9201,
      parentPid: 9100,
      commandLine: `"${TEST_EXE}" "${TEST_SERVER_SCRIPT}" --electron-stdio-secret`,
      creationDate: '2026-11-19T18:30:02.0000000Z',
    });
    const verifiedServerWorker = makeIdentity({
      pid: 9202,
      parentPid: 9201,
      name: 'conhost.exe',
      executablePath: 'C:\\Windows\\System32\\conhost.exe',
      creationDate: '2026-11-19T18:30:03.0000000Z',
    });
    const unrelatedOtherParent = makeIdentity({
      pid: 9301,
      parentPid: 555,
      name: 'unrelated.exe',
      executablePath: 'C:\\Tools\\unrelated.exe',
      creationDate: '2026-11-19T18:35:00.0000000Z',
    });
    const cleanMixedTable = new Map([
      [verifiedServer.pid, verifiedServer],
      [verifiedServerWorker.pid, verifiedServerWorker],
      [unrelatedOtherParent.pid, unrelatedOtherParent],
    ]);
    const killedPidsClean = [];

    const result = await cleanupPackagedTestRun({
      ownedProcesses: new Map([
        [mainId.pid, { identity: mainId, depth: 0 }],
        [verifiedServer.pid, { identity: verifiedServer, depth: 1 }],
      ]),
      spawnedMainIdentity: mainId,
      trackedServerIdentity: verifiedServer,
      expectedExePath: TEST_EXE,
      expectedServerScriptPath: TEST_SERVER_SCRIPT,
      preExistingPids: new Set(),
      tempSandbox: sandboxServerTreeClean,
      queryProcessTable: () => new Map(cleanMixedTable),
      killSinglePid: (pid) => {
        killedPidsClean.push(pid);
        cleanMixedTable.delete(pid);
      },
      waitTimeoutMs: 400,
      pollIntervalMs: 25,
      platform: 'win32',
    });

    assert.deepEqual(
      killedPidsClean,
      [9202, 9201],
      'Should terminate verified server child then verified server, NEVER unrelated PID 9301',
    );
    assert.equal(cleanMixedTable.has(9301), true);
    assert.equal(result.cleanedSandbox, true);
    assert.equal(existsSync(sandboxServerTreeClean), false);
  } finally {
    await rm(sandboxServerTreeClean, { recursive: true, force: true }).catch(() => undefined);
  }

  // 1c-ii: Root exited, verified Server tree (9201 -> 9202) PLUS unproven process 9300 referencing ParentProcessId == 9100
  // -> Terminates verified [9202, 9201], NEVER kills 9300, fails closed & preserves sandbox
  const sandboxServerTreeMixed = await mkdtemp(join(tmpdir(), 'retailos-test-srv-tree-mixed-'));
  try {
    const sentinel = join(sandboxServerTreeMixed, 'keep-mixed.txt');
    await writeFile(sentinel, 'preserve', 'utf8');
    const verifiedServer = makeIdentity({
      pid: 9201,
      parentPid: 9100,
      commandLine: `"${TEST_EXE}" "${TEST_SERVER_SCRIPT}" --electron-stdio-secret`,
      creationDate: '2026-11-19T18:30:02.0000000Z',
    });
    const verifiedServerWorker = makeIdentity({
      pid: 9202,
      parentPid: 9201,
      name: 'conhost.exe',
      executablePath: 'C:\\Windows\\System32\\conhost.exe',
      creationDate: '2026-11-19T18:30:03.0000000Z',
    });
    const unprovenCoincidentalChild = makeIdentity({
      pid: 9300,
      parentPid: 9100,
      name: 'unrelated.exe',
      executablePath: 'C:\\Tools\\unrelated.exe',
      creationDate: '2026-11-19T18:35:00.0000000Z',
    });
    const mixedTable = new Map([
      [verifiedServer.pid, verifiedServer],
      [verifiedServerWorker.pid, verifiedServerWorker],
      [unprovenCoincidentalChild.pid, unprovenCoincidentalChild],
    ]);
    const killedPidsMixed = [];

    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: new Map([
            [mainId.pid, { identity: mainId, depth: 0 }],
            [verifiedServer.pid, { identity: verifiedServer, depth: 1 }],
          ]),
          spawnedMainIdentity: mainId,
          trackedServerIdentity: verifiedServer,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandboxServerTreeMixed,
          queryProcessTable: () => new Map(mixedTable),
          killSinglePid: (pid) => {
            killedPidsMixed.push(pid);
            mixedTable.delete(pid);
          },
          waitTimeoutMs: 400,
          pollIntervalMs: 25,
          platform: 'win32',
        }),
      (err) => {
        assert.match(err.message, /Preserving temporary sandbox/);
        assert.match(err.message, /PID=9300/);
        return true;
      },
    );

    assert.deepEqual(
      killedPidsMixed,
      [9202, 9201],
      'Should terminate verified server tree ONLY and NEVER kill unproven PID 9300',
    );
    assert.equal(mixedTable.has(9300), true);
    assert.equal(existsSync(sandboxServerTreeMixed), true, 'Sandbox MUST NOT be deleted when unproven PID 9300 exists');
    assert.equal(existsSync(sentinel), true);
  } finally {
    await rm(sandboxServerTreeMixed, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('fails closed and preserves sandbox on incomplete direct or nested descendants (no silent skip)', async () => {
  const rootId = makeIdentity({
    pid: 9400,
    parentPid: 100,
    creationDate: '2026-11-19T18:45:00.0000000Z',
  });

  // 2a: Direct descendant with incomplete identity (missing ExecutablePath & CreationDate)
  const sandboxDirect = await mkdtemp(join(tmpdir(), 'retailos-test-inc-direct-'));
  try {
    const sentinel = join(sandboxDirect, 'keep.txt');
    await writeFile(sentinel, 'preserve', 'utf8');

    const incompleteDirectChild = {
      pid: 9401,
      parentPid: 9400,
      name: 'helper.exe',
      executablePath: null,
      commandLine: null,
      creationDate: null,
    };
    const directTable = new Map([
      [rootId.pid, rootId],
      [incompleteDirectChild.pid, incompleteDirectChild],
    ]);

    const directTree = collectProcessTreeIdentities(rootId, {
      queryProcessTable: () => directTable,
      platform: 'win32',
    });
    assert.equal(directTree.rootStatus, 'LIVE_VERIFIED');
    assert.equal(directTree.unverifiedDescendants.length, 1);
    assert.equal(directTree.unverifiedDescendants[0].identity.pid, 9401);

    const killedPids = [];
    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: new Map([[rootId.pid, { identity: rootId, depth: 0 }]]),
          spawnedMainIdentity: rootId,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandboxDirect,
          queryProcessTable: () => new Map(directTable),
          killSinglePid: (pid) => {
            killedPids.push(pid);
            directTable.delete(pid);
          },
          waitTimeoutMs: 250,
          pollIntervalMs: 25,
          platform: 'win32',
        }),
      (err) => {
        assert.match(err.message, /Preserving temporary sandbox/);
        assert.match(err.message, /PID=9401/);
        assert.match(err.message, /incomplete identity/);
        return true;
      },
    );

    assert.equal(killedPids.includes(9401), false, 'Must NEVER kill incomplete descendant 9401');
    assert.equal(existsSync(sandboxDirect), true, 'Sandbox MUST NOT be deleted while descendant 9401 is unverified');
    assert.equal(existsSync(sentinel), true);
  } finally {
    await rm(sandboxDirect, { recursive: true, force: true }).catch(() => undefined);
  }

  // 2b: Nested grandchild descendant with incomplete identity
  const sandboxNested = await mkdtemp(join(tmpdir(), 'retailos-test-inc-nested-'));
  try {
    const sentinel = join(sandboxNested, 'keep.txt');
    await writeFile(sentinel, 'preserve-nested', 'utf8');

    const verifiedChild = makeIdentity({
      pid: 9410,
      parentPid: 9400,
      commandLine: `"${TEST_EXE}" "${TEST_SERVER_SCRIPT}" --electron-stdio-secret`,
      creationDate: '2026-11-19T18:45:02.0000000Z',
    });
    const incompleteGrandchild = {
      pid: 9411,
      parentPid: 9410,
      name: 'worker.exe',
      executablePath: 'C:\\Tools\\worker.exe',
      commandLine: null,
      creationDate: null, // Missing CreationDate
    };
    const nestedTable = new Map([
      [rootId.pid, rootId],
      [verifiedChild.pid, verifiedChild],
      [incompleteGrandchild.pid, incompleteGrandchild],
    ]);

    const nestedTree = collectProcessTreeIdentities(rootId, {
      queryProcessTable: () => nestedTable,
      platform: 'win32',
    });
    assert.equal(nestedTree.rootStatus, 'LIVE_VERIFIED');
    assert.equal(nestedTree.unverifiedDescendants.length, 1);
    assert.equal(nestedTree.unverifiedDescendants[0].identity.pid, 9411);
    assert.equal(nestedTree.unverifiedDescendants[0].parentPid, 9410);

    const killedPids = [];
    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: new Map([[rootId.pid, { identity: rootId, depth: 0 }]]),
          spawnedMainIdentity: rootId,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandboxNested,
          queryProcessTable: () => new Map(nestedTable),
          killSinglePid: (pid) => {
            killedPids.push(pid);
            nestedTable.delete(pid);
          },
          waitTimeoutMs: 250,
          pollIntervalMs: 25,
          platform: 'win32',
        }),
      (err) => {
        assert.match(err.message, /Preserving temporary sandbox/);
        assert.match(err.message, /PID=9411/);
        assert.match(err.message, /parent PID 9410/);
        return true;
      },
    );

    assert.equal(killedPids.includes(9411), false, 'Must NEVER kill incomplete nested descendant 9411');
    assert.equal(existsSync(sandboxNested), true, 'Sandbox MUST NOT be deleted while nested descendant is unverified');
    assert.equal(existsSync(sentinel), true);
  } finally {
    await rm(sandboxNested, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('assertSafeTestEnvironment blocks Symlink/Junction bypasses pointing into protected RetailOS install dirs', async () => {
  const rootTmp = await mkdtemp(join(tmpdir(), 'retailos-test-junction-'));
  try {
    const protectedParentDir = join(rootTmp, 'protected-parent');
    const protectedInstallDir = join(protectedParentDir, 'RetailOS');
    await mkdir(protectedInstallDir, { recursive: true });
    const realProtectedExe = join(protectedInstallDir, 'RetailOS.exe');
    await writeFile(realProtectedExe, 'dummy-exe', 'utf8');

    const isolatedInstallDir = join(rootTmp, 'isolated-app');
    await mkdir(isolatedInstallDir, { recursive: true });
    const isolatedExe = join(isolatedInstallDir, 'RetailOS.exe');
    await writeFile(isolatedExe, 'dummy-exe', 'utf8');

    const junctionToInstall = join(rootTmp, 'alias-install-junction');
    await symlink(protectedInstallDir, junctionToInstall, 'junction');

    const junctionToParent = join(rootTmp, 'alias-parent-junction');
    await symlink(protectedParentDir, junctionToParent, 'junction');

    const safeTempUserData = join(tmpdir(), 'retailos-safe-userdata-check');
    const noRunningPids = () => ({ ok: true, pids: [] });

    // Direct junction pointing to protected install directory must be rejected
    assert.throws(
      () =>
        assertSafeTestEnvironment(join(junctionToInstall, 'RetailOS.exe'), safeTempUserData, {
          listRunningPids: noRunningPids,
          protectedInstallDirs: [protectedInstallDir],
        }),
      /Symlink\/Junction/,
    );

    // Junction pointing to parent directory of protected install must also be rejected
    assert.throws(
      () =>
        assertSafeTestEnvironment(join(junctionToParent, 'RetailOS', 'RetailOS.exe'), safeTempUserData, {
          listRunningPids: noRunningPids,
          protectedInstallDirs: [protectedInstallDir],
        }),
      /Symlink\/Junction/,
    );

    // Genuine isolated executable outside protected install dirs passes
    const pre = assertSafeTestEnvironment(isolatedExe, safeTempUserData, {
      listRunningPids: noRunningPids,
      protectedInstallDirs: [protectedInstallDir],
    });
    assert.equal(pre.size, 0);
  } finally {
    await rm(rootTmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('validateServerProcessOwnership verifies live parent identity and rejects Parent PID reuse', async () => {
  const mainId = makeIdentity({
    pid: 4100,
    parentPid: 100,
    creationDate: '2026-11-19T18:00:00.0000000Z',
  });
  const candidateServer = makeIdentity({
    pid: 4200,
    parentPid: 4100,
    executablePath: TEST_EXE,
    commandLine: `"${TEST_EXE}" "${TEST_SERVER_SCRIPT}" --electron-stdio-secret`,
    creationDate: '2026-11-19T18:00:03.0000000Z',
  });

  // 1. Parent PID reused by different executable (even when server candidate cmdline matches) -> REJECT
  const reusedParentDiffExe = makeIdentity({
    pid: 4100,
    parentPid: 100,
    name: 'pwsh.exe',
    executablePath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    creationDate: '2026-11-19T18:05:00.0000000Z',
  });
  const resDiffExe = validateServerProcessOwnership(candidateServer, {
    expectedExePath: TEST_EXE,
    expectedParentPid: mainId.pid,
    expectedServerScriptPath: TEST_SERVER_SCRIPT,
    preExistingPids: new Set(),
    spawnedMainIdentity: mainId,
    processTable: new Map([
      [reusedParentDiffExe.pid, reusedParentDiffExe],
      [candidateServer.pid, candidateServer],
    ]),
    platform: 'win32',
  });
  assert.equal(resDiffExe.valid, false);
  assert.equal(resDiffExe.parentPidReused, true);
  assert.equal(resDiffExe.unverified, true);
  assert.match(resDiffExe.reason, /parent PID.*reused/i);

  // 2. Parent PID reused by same RetailOS executable with different CreationDate -> REJECT
  const reusedParentSameExe = makeIdentity({
    pid: 4100,
    parentPid: 100,
    executablePath: TEST_EXE,
    creationDate: '2026-11-19T18:09:00.0000000Z',
  });
  const resSameExe = validateServerProcessOwnership(candidateServer, {
    expectedExePath: TEST_EXE,
    expectedParentPid: mainId.pid,
    expectedServerScriptPath: TEST_SERVER_SCRIPT,
    preExistingPids: new Set(),
    spawnedMainIdentity: mainId,
    processTable: new Map([
      [reusedParentSameExe.pid, reusedParentSameExe],
      [candidateServer.pid, candidateServer],
    ]),
    platform: 'win32',
  });
  assert.equal(resSameExe.valid, false);
  assert.equal(resSameExe.parentPidReused, true);
  assert.equal(resSameExe.unverified, true);

  // 3. Parent absent (ROOT_EXITED) -> MUST reject EVEN IF CommandLine matches server.mjs & --electron-stdio-secret!
  const resMissingParentStrongCmd = validateServerProcessOwnership(candidateServer, {
    expectedExePath: TEST_EXE,
    expectedParentPid: mainId.pid,
    expectedServerScriptPath: TEST_SERVER_SCRIPT,
    preExistingPids: new Set(),
    spawnedMainIdentity: mainId,
    processTable: new Map([[candidateServer.pid, candidateServer]]), // Parent PID 4100 is absent
    platform: 'win32',
  });
  assert.equal(resMissingParentStrongCmd.valid, false);
  assert.equal(resMissingParentStrongCmd.parentMissing, true);
  assert.equal(resMissingParentStrongCmd.unverified, true);
  assert.match(resMissingParentStrongCmd.reason, /live parent PID 4100 is not running/i);

  // 3b. Omitted processTable -> NEVER allow CommandLine or ParentProcessId alone to validate
  const resOmittedTable = validateServerProcessOwnership(candidateServer, {
    expectedExePath: TEST_EXE,
    expectedParentPid: mainId.pid,
    expectedServerScriptPath: TEST_SERVER_SCRIPT,
    preExistingPids: new Set(),
    spawnedMainIdentity: mainId,
    platform: 'win32',
  });
  assert.equal(resOmittedTable.valid, false);
  assert.equal(resOmittedTable.parentMissing, true);
  assert.equal(resOmittedTable.unverified, true);

  // 3c. Non-server Electron child (e.g., --type=renderer) under a verified parent -> REJECT (not the server)
  const rendererChild = makeIdentity({
    pid: 4202,
    parentPid: 4100,
    executablePath: TEST_EXE,
    commandLine: `"${TEST_EXE}" --type=renderer --app-user-model-id=com.retailos.desktop`,
    creationDate: '2026-11-19T18:00:02.0000000Z',
  });
  const resRendererChild = validateServerProcessOwnership(rendererChild, {
    expectedExePath: TEST_EXE,
    expectedParentPid: mainId.pid,
    expectedServerScriptPath: TEST_SERVER_SCRIPT,
    preExistingPids: new Set(),
    spawnedMainIdentity: mainId,
    processTable: new Map([
      [mainId.pid, mainId],
      [rendererChild.pid, rendererChild],
    ]),
    platform: 'win32',
  });
  assert.equal(resRendererChild.valid, false);
  assert.equal(resRendererChild.unverified, false);
  assert.match(resRendererChild.reason, /CommandLine does not reference/i);

  // 4. Incomplete live parent identity (missing ExecutablePath & CreationDate) -> REJECT fail-closed
  const incompleteLiveParent = {
    pid: 4100,
    parentPid: 100,
    name: 'RetailOS.exe',
    executablePath: null,
    commandLine: null,
    creationDate: null,
  };
  const resIncompleteParent = validateServerProcessOwnership(candidateServer, {
    expectedExePath: TEST_EXE,
    expectedParentPid: mainId.pid,
    expectedServerScriptPath: TEST_SERVER_SCRIPT,
    preExistingPids: new Set(),
    spawnedMainIdentity: mainId,
    processTable: new Map([
      [incompleteLiveParent.pid, incompleteLiveParent],
      [candidateServer.pid, candidateServer],
    ]),
    platform: 'win32',
  });
  assert.equal(resIncompleteParent.valid, false);
  assert.equal(resIncompleteParent.parentUnverified, true);
  assert.equal(resIncompleteParent.unverified, true);
  assert.match(resIncompleteParent.reason, /incomplete identity/i);

  // 5. Verified live parent identity matches spawnedMainIdentity -> VALID
  const resVerified = validateServerProcessOwnership(candidateServer, {
    expectedExePath: TEST_EXE,
    expectedParentPid: mainId.pid,
    expectedServerScriptPath: TEST_SERVER_SCRIPT,
    preExistingPids: new Set(),
    spawnedMainIdentity: mainId,
    processTable: new Map([
      [mainId.pid, mainId],
      [candidateServer.pid, candidateServer],
    ]),
    platform: 'win32',
  });
  assert.equal(resVerified.valid, true);
  assert.equal(resVerified.identity.pid, 4200);

  // 6. End-to-end cleanupPackagedTestRun with control file referencing candidate whose parent PID was reused
  // -> MUST NOT kill candidate or reused parent, MUST reject & preserve tempSandbox
  const sandbox = await mkdtemp(join(tmpdir(), 'retailos-test-parent-reuse-'));
  try {
    const sentinel = join(sandbox, 'sentinel-parent-reuse.txt');
    await writeFile(sentinel, 'preserve', 'utf8');
    const controlFilePath = join(sandbox, '.retailos-control.json');
    await writeFile(controlFilePath, JSON.stringify({ pid: candidateServer.pid, port: 3210 }), 'utf8');

    const tableWithReusedParent = new Map([
      [reusedParentDiffExe.pid, reusedParentDiffExe],
      [candidateServer.pid, candidateServer],
    ]);
    const killedPids = [];

    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: new Map([[mainId.pid, { identity: mainId, depth: 0 }]]),
          spawnedMainIdentity: mainId,
          controlFilePath,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandbox,
          queryProcessTable: () => new Map(tableWithReusedParent),
          killSinglePid: (pid) => killedPids.push(pid),
          waitTimeoutMs: 200,
          pollIntervalMs: 20,
          platform: 'win32',
        }),
      (err) => {
        assert.match(err.message, /Preserving temporary sandbox/);
        assert.match(err.message, /PID=4200/);
        assert.match(err.message, /parent PID 4100 was reused/i);
        return true;
      },
    );

    assert.deepEqual(killedPids, [], 'Must NEVER kill candidate server or reused parent process');
    assert.equal(existsSync(sandbox), true, 'Sandbox MUST NOT be deleted when parent PID reuse blocks verification');
    assert.equal(existsSync(sentinel), true);
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
  }

  // 7. End-to-end cleanupPackagedTestRun with ROOT_EXITED + control file referencing server-like candidate
  // -> Because live parent is absent, NEVER kill candidate (CommandLine cannot bypass), fail closed & preserve sandbox
  const sandboxExitedParentCtrl = await mkdtemp(join(tmpdir(), 'retailos-test-exited-ctrl-'));
  try {
    const sentinel = join(sandboxExitedParentCtrl, 'keep-exited-ctrl.txt');
    await writeFile(sentinel, 'preserve', 'utf8');
    const controlFilePath = join(sandboxExitedParentCtrl, '.retailos-control.json');
    await writeFile(controlFilePath, JSON.stringify({ pid: candidateServer.pid, port: 3210 }), 'utf8');

    const tableParentExited = new Map([[candidateServer.pid, candidateServer]]);
    const killedPids = [];

    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: new Map([[mainId.pid, { identity: mainId, depth: 0 }]]),
          spawnedMainIdentity: mainId,
          controlFilePath,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandboxExitedParentCtrl,
          queryProcessTable: () => new Map(tableParentExited),
          killSinglePid: (pid) => killedPids.push(pid),
          waitTimeoutMs: 200,
          pollIntervalMs: 20,
          platform: 'win32',
        }),
      (err) => {
        assert.match(err.message, /Preserving temporary sandbox/);
        assert.match(err.message, /PID=4200/);
        return true;
      },
    );

    assert.deepEqual(killedPids, [], 'Must NEVER kill unverified candidate when parent is absent');
    assert.equal(existsSync(sandboxExitedParentCtrl), true);
    assert.equal(existsSync(sentinel), true);
  } finally {
    await rm(sandboxExitedParentCtrl, { recursive: true, force: true }).catch(() => undefined);
  }

  // 8. ROOT_UNVERIFIED (incomplete live root) + potential child citing root PID
  // -> Never kill root or potential child, flag both in unverifiedDescendants, preserve sandbox
  const incompleteLiveRoot = {
    pid: 4100,
    parentPid: 100,
    name: 'RetailOS.exe',
    executablePath: null,
    commandLine: null,
    creationDate: null,
  };
  const potentialChildUnderUnverifiedRoot = makeIdentity({
    pid: 4300,
    parentPid: 4100,
    name: 'helper.exe',
    executablePath: 'C:\\Tools\\helper.exe',
    creationDate: '2026-11-19T18:01:00.0000000Z',
  });
  const unverifiedRootTable = new Map([
    [4100, incompleteLiveRoot],
    [4300, potentialChildUnderUnverifiedRoot],
  ]);
  const unverifiedTree = collectProcessTreeIdentities(mainId, {
    queryProcessTable: () => unverifiedRootTable,
    platform: 'win32',
  });
  assert.equal(unverifiedTree.rootStatus, 'ROOT_UNVERIFIED');
  assert.equal(unverifiedTree.identities.size, 0);
  assert.deepEqual(
    unverifiedTree.unverifiedDescendants.map((d) => d.identity.pid).sort((a, b) => a - b),
    [4100, 4300],
  );

  const sandboxUnverifiedRoot = await mkdtemp(join(tmpdir(), 'retailos-test-unverified-root-'));
  try {
    const sentinel = join(sandboxUnverifiedRoot, 'keep-unverified-root.txt');
    await writeFile(sentinel, 'preserve', 'utf8');
    const killedPids = [];

    await assert.rejects(
      () =>
        cleanupPackagedTestRun({
          ownedProcesses: new Map([[mainId.pid, { identity: mainId, depth: 0 }]]),
          spawnedMainIdentity: mainId,
          expectedExePath: TEST_EXE,
          expectedServerScriptPath: TEST_SERVER_SCRIPT,
          preExistingPids: new Set(),
          tempSandbox: sandboxUnverifiedRoot,
          queryProcessTable: () => new Map(unverifiedRootTable),
          killSinglePid: (pid) => killedPids.push(pid),
          waitTimeoutMs: 200,
          pollIntervalMs: 20,
          platform: 'win32',
        }),
      (err) => {
        assert.match(err.message, /Preserving temporary sandbox/);
        assert.match(err.message, /PID=4100/);
        assert.match(err.message, /PID=4300/);
        return true;
      },
    );

    assert.deepEqual(killedPids, []);
    assert.equal(existsSync(sandboxUnverifiedRoot), true);
    assert.equal(existsSync(sentinel), true);
  } finally {
    await rm(sandboxUnverifiedRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
