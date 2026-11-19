import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = dirname(scriptsDir);

export class ProcessEnumerationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ProcessEnumerationError';
  }
}

export function parseCliArg(flagName, argv = process.argv) {
  const index = argv.indexOf(flagName);
  if (index === -1 || index + 1 >= argv.length) {
    return null;
  }
  return argv[index + 1];
}

export function pathsEqual(candidatePath, otherPath, platform = process.platform) {
  if (typeof candidatePath !== 'string' || typeof otherPath !== 'string') {
    return false;
  }
  const a = candidatePath.trim();
  const b = otherPath.trim();
  if (!a || !b) {
    return false;
  }
  if (platform === 'win32') {
    return resolve(a).toLowerCase() === resolve(b).toLowerCase();
  }
  return resolve(a) === resolve(b);
}

export function isPathInsideOrEqual(candidatePath, baseDir, platform = process.platform) {
  const resolvedCandidate = resolve(candidatePath);
  const resolvedBase = resolve(baseDir);
  if (platform === 'win32') {
    const c = resolvedCandidate.toLowerCase();
    const b = resolvedBase.toLowerCase();
    return c === b || c.startsWith(`${b}${sep}`);
  }
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${sep}`);
}

export function isCompleteProcessIdentity(identity) {
  return Boolean(
    identity &&
      typeof identity === 'object' &&
      Number.isInteger(identity.pid) &&
      identity.pid > 0 &&
      typeof identity.executablePath === 'string' &&
      identity.executablePath.trim().length > 0 &&
      typeof identity.creationDate === 'string' &&
      identity.creationDate.trim().length > 0,
  );
}

export function isSameProcessIdentity(expected, actual, { platform = process.platform } = {}) {
  if (!isCompleteProcessIdentity(expected) || !isCompleteProcessIdentity(actual)) {
    return false;
  }
  if (expected.pid !== actual.pid) {
    return false;
  }
  if (!pathsEqual(expected.executablePath, actual.executablePath, platform)) {
    return false;
  }
  if (expected.creationDate.trim() !== actual.creationDate.trim()) {
    return false;
  }
  if (
    expected.parentPid !== null &&
    expected.parentPid !== undefined &&
    actual.parentPid !== null &&
    actual.parentPid !== undefined &&
    expected.parentPid !== actual.parentPid
  ) {
    return false;
  }
  return true;
}

export function formatProcessIdentity(identity) {
  if (!identity || typeof identity !== 'object') {
    return 'unknown-process';
  }
  const pid = Number.isInteger(identity.pid) ? String(identity.pid) : 'unknown-pid';
  const exe =
    typeof identity.executablePath === 'string' && identity.executablePath.trim()
      ? identity.executablePath.trim()
      : 'unknown-path';
  const created =
    typeof identity.creationDate === 'string' && identity.creationDate.trim()
      ? identity.creationDate.trim()
      : 'unknown-creation-date';
  const ppid =
    Number.isInteger(identity.parentPid) && identity.parentPid > 0
      ? String(identity.parentPid)
      : 'unknown-ppid';
  return `PID=${pid}, ExecutablePath="${exe}", CreationDate=${created}, ParentPID=${ppid}`;
}

async function readAsarIndex(asarPath) {
  const handle = await open(asarPath, 'r');
  try {
    const headerSizeBuf = Buffer.alloc(16);
    await handle.read(headerSizeBuf, 0, 16, 0);
    const jsonSize = headerSizeBuf.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonSize);
    await handle.read(jsonBuf, 0, jsonSize, 16);
    return JSON.parse(jsonBuf.toString('utf8'));
  } finally {
    await handle.close();
  }
}

function collectAsarPaths(node, prefix = '', acc = []) {
  const entries = node?.files ?? {};
  for (const [name, meta] of Object.entries(entries)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (meta && typeof meta === 'object' && 'files' in meta) {
      acc.push(`${rel}/`);
      collectAsarPaths(meta, rel, acc);
    } else {
      acc.push(rel);
    }
  }
  return acc;
}

function defaultRunPowerShellCim(encodedCommand) {
  return spawnSync('powershell', ['-NoProfile', '-EncodedCommand', encodedCommand], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

const WIN32_PROCESS_CIM_SCRIPT = [
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = $OutputEncoding',
  "$ErrorActionPreference = 'Stop'",
  "$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, @{Name='CreationDate';Expression={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }})",
  'ConvertTo-Json -InputObject $rows -Compress -Depth 3',
].join('; ');

const WIN32_PROCESS_CIM_ENCODED = Buffer.from(WIN32_PROCESS_CIM_SCRIPT, 'utf16le').toString('base64');

export function queryWindowsProcessTable({
  runCommand = defaultRunPowerShellCim,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') {
    throw new ProcessEnumerationError(
      `Windows CIM process enumeration is unavailable on platform "${platform}"`,
    );
  }

  let res;
  try {
    res = runCommand(WIN32_PROCESS_CIM_ENCODED);
  } catch (err) {
    throw new ProcessEnumerationError(
      `Failed to invoke PowerShell/CIM process query: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  if (!res || res.error) {
    const msg = res?.error ? res.error.message : 'missing spawnSync result';
    throw new ProcessEnumerationError(`PowerShell/CIM execution failed: ${msg}`, {
      cause: res?.error,
    });
  }

  if (res.status !== 0) {
    const stderrText = String(res.stderr ?? '').trim();
    throw new ProcessEnumerationError(
      `PowerShell/CIM process query exited with code ${String(res.status)}${stderrText ? `: ${stderrText}` : ''}`,
    );
  }

  const stdoutText = String(res.stdout ?? '').trim();
  if (!stdoutText) {
    throw new ProcessEnumerationError('PowerShell/CIM process query returned empty output');
  }

  let parsed;
  try {
    parsed = JSON.parse(stdoutText);
  } catch (err) {
    throw new ProcessEnumerationError(
      `PowerShell/CIM process query returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ProcessEnumerationError(
      'PowerShell/CIM process query returned non-array payload',
    );
  }

  if (parsed.length === 0) {
    throw new ProcessEnumerationError(
      'PowerShell/CIM process query returned 0 processes on a live host (treating empty process table as enumeration failure)',
    );
  }

  const table = new Map();
  for (const row of parsed) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const pid = Number(row.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const rawParent = row.ParentProcessId;
    const parentPid =
      rawParent !== null && rawParent !== undefined && Number.isInteger(Number(rawParent)) && Number(rawParent) > 0
        ? Number(rawParent)
        : null;
    table.set(pid, {
      pid,
      parentPid,
      name: typeof row.Name === 'string' ? row.Name : null,
      executablePath:
        typeof row.ExecutablePath === 'string' && row.ExecutablePath.trim()
          ? row.ExecutablePath.trim()
          : null,
      commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : null,
      creationDate:
        typeof row.CreationDate === 'string' && row.CreationDate.trim()
          ? row.CreationDate.trim()
          : null,
    });
  }

  if (table.size === 0) {
    throw new ProcessEnumerationError(
      'PowerShell/CIM process query yielded no valid process entries',
    );
  }

  return table;
}

export function listRunningRetailOsPids({
  queryProcessTable,
  runCommand = defaultRunPowerShellCim,
  platform = process.platform,
} = {}) {
  try {
    const table = queryProcessTable
      ? queryProcessTable()
      : queryWindowsProcessTable({ runCommand, platform });
    const pids = [];
    for (const entry of table.values()) {
      if (typeof entry.name === 'string' && entry.name.toLowerCase() === 'retailos.exe') {
        pids.push(entry.pid);
      }
    }
    return { ok: true, pids };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { ok: false, error };
  }
}

export function validateServerProcessOwnership(
  candidateIdentity,
  {
    expectedExePath,
    expectedParentPid = null,
    expectedServerScriptPath,
    preExistingPids = new Set(),
    spawnedMainIdentity = null,
    platform = process.platform,
  },
) {
  if (!isCompleteProcessIdentity(candidateIdentity)) {
    return {
      valid: false,
      reason: `Incomplete server process identity (${formatProcessIdentity(candidateIdentity)})`,
    };
  }
  if (preExistingPids.has(candidateIdentity.pid)) {
    return {
      valid: false,
      reason: `PID ${candidateIdentity.pid} existed before this test started`,
    };
  }
  if (!pathsEqual(candidateIdentity.executablePath, expectedExePath, platform)) {
    return {
      valid: false,
      reason: `ExecutablePath mismatch for PID ${candidateIdentity.pid}: expected "${expectedExePath}", got "${candidateIdentity.executablePath}"`,
    };
  }

  if (spawnedMainIdentity?.creationDate) {
    const serverCreatedMs = Date.parse(candidateIdentity.creationDate);
    const mainCreatedMs = Date.parse(spawnedMainIdentity.creationDate);
    if (Number.isFinite(serverCreatedMs) && Number.isFinite(mainCreatedMs) && serverCreatedMs < mainCreatedMs - 1000) {
      return {
        valid: false,
        reason: `CreationDate ${candidateIdentity.creationDate} precedes spawned parent creation ${spawnedMainIdentity.creationDate}`,
      };
    }
  }

  const parentMatches =
    expectedParentPid !== null &&
    expectedParentPid !== undefined &&
    candidateIdentity.parentPid === expectedParentPid;

  let cmdMatches = false;
  if (typeof candidateIdentity.commandLine === 'string' && expectedServerScriptPath) {
    const cmdText =
      platform === 'win32'
        ? candidateIdentity.commandLine.toLowerCase()
        : candidateIdentity.commandLine;
    const expectedScript =
      platform === 'win32'
        ? resolve(expectedServerScriptPath).toLowerCase()
        : resolve(expectedServerScriptPath);
    cmdMatches =
      cmdText.includes('--electron-stdio-secret') && cmdText.includes(expectedScript);
  }

  if (!parentMatches && !cmdMatches) {
    return {
      valid: false,
      reason: `Ownership proof failed for PID ${candidateIdentity.pid}: neither ParentProcessId (${String(candidateIdentity.parentPid)}) matches ${String(expectedParentPid)} nor CommandLine references "${expectedServerScriptPath}" with --electron-stdio-secret`,
    };
  }

  return { valid: true, identity: candidateIdentity };
}

export function collectProcessTreeIdentities(
  rootIdentity,
  {
    queryProcessTable = () => queryWindowsProcessTable(),
    preExistingPids = new Set(),
    platform = process.platform,
  } = {},
) {
  if (!isCompleteProcessIdentity(rootIdentity)) {
    throw new ProcessEnumerationError(
      `Cannot collect process tree without complete root identity (${formatProcessIdentity(rootIdentity)})`,
    );
  }

  const table = queryProcessTable();
  const childrenByParent = new Map();
  for (const entry of table.values()) {
    if (entry.parentPid !== null && entry.parentPid !== undefined) {
      if (!childrenByParent.has(entry.parentPid)) {
        childrenByParent.set(entry.parentPid, []);
      }
      childrenByParent.get(entry.parentPid).push(entry);
    }
  }

  const identities = new Map();
  const depths = new Map();
  const liveRoot = table.get(rootIdentity.pid);
  if (liveRoot && isSameProcessIdentity(rootIdentity, liveRoot, { platform })) {
    identities.set(liveRoot.pid, liveRoot);
    depths.set(liveRoot.pid, 0);
  }

  const queue = [{ pid: rootIdentity.pid, creationDate: rootIdentity.creationDate, depth: 0 }];
  const visited = new Set([rootIdentity.pid]);

  while (queue.length > 0) {
    const current = queue.shift();
    const currentCreatedMs = Date.parse(current.creationDate);
    for (const childEntry of childrenByParent.get(current.pid) ?? []) {
      if (visited.has(childEntry.pid) || preExistingPids.has(childEntry.pid)) {
        continue;
      }
      if (!isCompleteProcessIdentity(childEntry)) {
        continue;
      }
      const childCreatedMs = Date.parse(childEntry.creationDate);
      if (
        Number.isFinite(currentCreatedMs) &&
        Number.isFinite(childCreatedMs) &&
        childCreatedMs < currentCreatedMs - 1000
      ) {
        continue;
      }
      visited.add(childEntry.pid);
      identities.set(childEntry.pid, childEntry);
      depths.set(childEntry.pid, current.depth + 1);
      queue.push({
        pid: childEntry.pid,
        creationDate: childEntry.creationDate,
        depth: current.depth + 1,
      });
    }
  }

  return { identities, depths };
}

function defaultKillSinglePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Ignore if already exited.
  }
}

export function terminateVerifiedProcess(
  expectedIdentity,
  {
    queryProcessTable = () => queryWindowsProcessTable(),
    killSinglePid = defaultKillSinglePid,
    preExistingPids = new Set(),
    platform = process.platform,
  } = {},
) {
  const pid = expectedIdentity?.pid;
  if (Number.isInteger(pid) && preExistingPids.has(pid)) {
    return {
      status: 'REFUSED_PREEXISTING',
      pid,
      reason: `Refused to terminate PID ${pid} because it existed prior to this test`,
    };
  }
  if (!isCompleteProcessIdentity(expectedIdentity)) {
    return {
      status: 'VERIFICATION_FAILED',
      pid: Number.isInteger(pid) ? pid : null,
      reason: `Cannot terminate process with incomplete recorded identity (${formatProcessIdentity(expectedIdentity)})`,
    };
  }

  let table;
  try {
    table = queryProcessTable();
  } catch (err) {
    return {
      status: 'VERIFICATION_FAILED',
      pid: expectedIdentity.pid,
      reason: `Cannot re-verify PID ${expectedIdentity.pid} before termination: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const live = table.get(expectedIdentity.pid);
  if (!live) {
    return { status: 'ALREADY_EXITED', pid: expectedIdentity.pid };
  }

  if (!isCompleteProcessIdentity(live)) {
    return {
      status: 'VERIFICATION_FAILED',
      pid: expectedIdentity.pid,
      reason: `Live process record for PID ${expectedIdentity.pid} lacks verifiable ExecutablePath/CreationDate (${formatProcessIdentity(live)})`,
    };
  }

  if (!isSameProcessIdentity(expectedIdentity, live, { platform })) {
    return {
      status: 'IDENTITY_MISMATCH',
      pid: expectedIdentity.pid,
      expected: expectedIdentity,
      actual: live,
      reason: `Refused to terminate PID ${expectedIdentity.pid}: identity mismatch (expected [${formatProcessIdentity(expectedIdentity)}], actual [${formatProcessIdentity(live)}])`,
    };
  }

  killSinglePid(expectedIdentity.pid);
  return { status: 'TERMINATED', pid: expectedIdentity.pid };
}

export async function waitForVerifiedProcessesExit(
  expectedIdentities,
  {
    queryProcessTable = () => queryWindowsProcessTable(),
    timeoutMs = 10_000,
    pollIntervalMs = 150,
    platform = process.platform,
  } = {},
) {
  const deduped = new Map();
  const invalidExpected = [];
  for (const identity of expectedIdentities) {
    if (!isCompleteProcessIdentity(identity)) {
      invalidExpected.push({
        identity,
        reason: `Incomplete recorded identity (${formatProcessIdentity(identity)})`,
      });
      continue;
    }
    deduped.set(identity.pid, identity);
  }

  if (deduped.size === 0) {
    return { stillRunning: [], unverified: invalidExpected, reusedPids: [] };
  }

  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;

  while (true) {
    let table = null;
    let queryErr = null;
    try {
      table = queryProcessTable();
    } catch (err) {
      queryErr = err instanceof Error ? err : new Error(String(err));
    }

    if (table) {
      const stillRunning = [];
      const unverified = [...invalidExpected];
      const reusedPids = [];

      for (const expected of deduped.values()) {
        const live = table.get(expected.pid);
        if (!live) {
          continue;
        }
        if (!isCompleteProcessIdentity(live)) {
          unverified.push({
            identity: expected,
            reason: `Live process record for PID ${expected.pid} cannot be verified (${formatProcessIdentity(live)})`,
          });
          continue;
        }
        if (!isSameProcessIdentity(expected, live, { platform })) {
          reusedPids.push({
            pid: expected.pid,
            expected,
            actual: live,
          });
          continue;
        }
        stillRunning.push(live);
      }

      lastSnapshot = { stillRunning, unverified, reusedPids };
      if (stillRunning.length === 0 && unverified.length === 0) {
        return lastSnapshot;
      }
    } else if (Date.now() >= deadline) {
      return {
        stillRunning: [],
        unverified: [
          ...invalidExpected,
          ...Array.from(deduped.values()).map((identity) => ({
            identity,
            reason: `Failed to verify exit of PID ${identity.pid}: ${queryErr?.message ?? 'enumeration failed'}`,
          })),
        ],
        reusedPids: [],
      };
    }

    if (Date.now() >= deadline) {
      return (
        lastSnapshot ?? {
          stillRunning: [],
          unverified: [
            ...invalidExpected,
            ...Array.from(deduped.values()).map((identity) => ({
              identity,
              reason: `Timed out before verifying exit of PID ${identity.pid}`,
            })),
          ],
          reusedPids: [],
        }
      );
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }
}

export async function removeDirWithRetries(dirPath, { maxAttempts = 10, delayMs = 300 } = {}) {
  if (!dirPath || !existsSync(dirPath)) {
    return;
  }
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      if (!existsSync(dirPath)) {
        return;
      }
      lastError = new Error(`Directory still exists after rm attempt ${attempt}: ${dirPath}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < maxAttempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw new Error(
    `Failed to delete temporary test directory "${dirPath}" after ${maxAttempts} attempts: ${lastError?.message ?? 'unknown error'}`,
    { cause: lastError ?? undefined },
  );
}

export function assertSafeTestEnvironment(
  explicitExe,
  tempUserDataDir,
  { listRunningPids = () => listRunningRetailOsPids(), platform = process.platform } = {},
) {
  const runningCheck = listRunningPids();
  if (!runningCheck || runningCheck.ok !== true) {
    const errDetail = runningCheck?.error
      ? runningCheck.error.message
      : 'unknown enumeration failure';
    throw new Error(
      `Refusing to run test-packaged-runtime (fail-closed): unable to verify whether RetailOS.exe is already running (${errDetail})`,
      { cause: runningCheck?.error },
    );
  }

  const preExistingPids = new Set(runningCheck.pids);
  if (preExistingPids.size > 0) {
    throw new Error(
      `Refusing to run test-packaged-runtime while RetailOS.exe is already running (PIDs: ${Array.from(preExistingPids).join(', ')}). Close existing instances first to avoid affecting a live session.`,
    );
  }

  const systemTmp = resolve(tmpdir());
  assert.ok(
    isPathInsideOrEqual(tempUserDataDir, systemTmp, platform) &&
      !pathsEqual(tempUserDataDir, systemTmp, platform),
    `Unsafe test userDataDir outside system temp: ${tempUserDataDir}`,
  );
  if (process.env.APPDATA) {
    assert.equal(
      isPathInsideOrEqual(tempUserDataDir, process.env.APPDATA, platform),
      false,
      `Refusing to run with userDataDir inside live APPDATA: ${tempUserDataDir}`,
    );
  }

  if (explicitExe) {
    const resolvedExe = resolve(explicitExe);
    const protectedInstallDirs = [];
    if (process.env.LOCALAPPDATA) {
      protectedInstallDirs.push(join(process.env.LOCALAPPDATA, 'Programs', 'RetailOS'));
      protectedInstallDirs.push(join(process.env.LOCALAPPDATA, 'RetailOS'));
    }
    if (process.env.ProgramFiles) {
      protectedInstallDirs.push(join(process.env.ProgramFiles, 'RetailOS'));
    }
    if (process.env['ProgramFiles(x86)']) {
      protectedInstallDirs.push(join(process.env['ProgramFiles(x86)'], 'RetailOS'));
    }
    if (process.env.APPDATA) {
      protectedInstallDirs.push(process.env.APPDATA);
    }

    for (const protectedDir of protectedInstallDirs) {
      if (isPathInsideOrEqual(resolvedExe, protectedDir, platform)) {
        throw new Error(
          `Refusing to target a live RetailOS installation path via --exe: ${resolvedExe}. Use a temporary isolated install directory inside temp instead.`,
        );
      }
    }

    if (!existsSync(resolvedExe)) {
      throw new Error(`Specified --exe path does not exist: ${resolvedExe}`);
    }
  }

  return preExistingPids;
}

export async function cleanupPackagedTestRun({
  ownedProcesses,
  spawnedMainIdentity = null,
  unverifiedMainPid = null,
  controlFilePath = null,
  expectedExePath,
  expectedServerScriptPath,
  preExistingPids = new Set(),
  tempSandbox,
  primaryError = null,
  queryProcessTable = () => queryWindowsProcessTable(),
  killSinglePid = defaultKillSinglePid,
  removeDir = removeDirWithRetries,
  waitTimeoutMs = 10_000,
  pollIntervalMs = 150,
  platform = process.platform,
}) {
  const cleanupErrors = [];
  const unverifiedOwned = [];
  const remainingOwned = [];
  const reusedPids = [];

  if (unverifiedMainPid !== null && !ownedProcesses.has(unverifiedMainPid)) {
    unverifiedOwned.push({
      identity: {
        pid: unverifiedMainPid,
        executablePath: expectedExePath,
        creationDate: null,
        parentPid: null,
      },
      reason: `Spawned main process PID ${unverifiedMainPid} could not be identity-verified via CIM at launch`,
    });
  }

  if (controlFilePath && existsSync(controlFilePath)) {
    try {
      const controlRaw = JSON.parse(await readFile(controlFilePath, 'utf8'));
      const candidatePid = controlRaw?.pid;
      if (
        typeof candidatePid === 'number' &&
        Number.isInteger(candidatePid) &&
        candidatePid > 0 &&
        !ownedProcesses.has(candidatePid)
      ) {
        if (preExistingPids.has(candidatePid)) {
          // Do not claim or terminate a pre-existing process
        } else {
          try {
            const table = queryProcessTable();
            const liveCandidate = table.get(candidatePid);
            if (liveCandidate) {
              const ownership = validateServerProcessOwnership(liveCandidate, {
                expectedExePath,
                expectedParentPid: spawnedMainIdentity?.pid ?? null,
                expectedServerScriptPath,
                preExistingPids,
                spawnedMainIdentity,
                platform,
              });
              if (ownership.valid) {
                ownedProcesses.set(candidatePid, { identity: ownership.identity, depth: 1 });
              } else {
                // If live process is clearly not our server (reused/unrelated), refuse kill; do not misclassify reused PID as ours,
                // UNLESS identity itself was incomplete (unable to verify)
                if (!isCompleteProcessIdentity(liveCandidate)) {
                  unverifiedOwned.push({
                    identity: liveCandidate,
                    reason: ownership.reason,
                  });
                } else {
                  reusedPids.push({
                    pid: candidatePid,
                    expected: {
                      pid: candidatePid,
                      executablePath: expectedExePath,
                      creationDate: 'owned-server',
                    },
                    actual: liveCandidate,
                    reason: ownership.reason,
                  });
                }
              }
            }
          } catch (enumErr) {
            unverifiedOwned.push({
              identity: {
                pid: candidatePid,
                executablePath: expectedExePath,
                creationDate: null,
                parentPid: spawnedMainIdentity?.pid ?? null,
              },
              reason: `Unable to verify control-file PID ${candidatePid} via CIM: ${enumErr instanceof Error ? enumErr.message : String(enumErr)}`,
            });
          }
        }
      }
    } catch {
      // Control file may be truncated on abrupt failure
    }
  }

  if (spawnedMainIdentity) {
    try {
      const { identities, depths } = collectProcessTreeIdentities(spawnedMainIdentity, {
        queryProcessTable,
        preExistingPids,
        platform,
      });
      for (const [pid, identity] of identities.entries()) {
        if (!preExistingPids.has(pid) && !ownedProcesses.has(pid)) {
          ownedProcesses.set(pid, { identity, depth: depths.get(pid) ?? 1 });
        }
      }
    } catch (treeErr) {
      unverifiedOwned.push({
        identity: spawnedMainIdentity,
        reason: `Failed to enumerate process tree for cleanup: ${treeErr instanceof Error ? treeErr.message : String(treeErr)}`,
      });
    }
  }

  const orderedOwned = Array.from(ownedProcesses.values()).sort((a, b) => b.depth - a.depth);
  for (const record of orderedOwned) {
    const termResult = terminateVerifiedProcess(record.identity, {
      queryProcessTable,
      killSinglePid,
      preExistingPids,
      platform,
    });
    if (termResult.status === 'VERIFICATION_FAILED') {
      unverifiedOwned.push({
        identity: record.identity,
        reason: termResult.reason,
      });
    } else if (termResult.status === 'IDENTITY_MISMATCH') {
      reusedPids.push({
        pid: termResult.pid,
        expected: termResult.expected,
        actual: termResult.actual,
        reason: termResult.reason,
      });
    } else if (termResult.status === 'REFUSED_PREEXISTING') {
      cleanupErrors.push(termResult.reason);
    }
  }

  const waitTargets = orderedOwned
    .filter(
      (record) =>
        !reusedPids.some((reused) => reused.pid === record.identity.pid) &&
        !unverifiedOwned.some((u) => u.identity?.pid === record.identity.pid),
    )
    .map((record) => record.identity);

  if (waitTargets.length > 0) {
    const waitResult = await waitForVerifiedProcessesExit(waitTargets, {
      queryProcessTable,
      timeoutMs: waitTimeoutMs,
      pollIntervalMs,
      platform,
    });
    for (const live of waitResult.stillRunning) {
      remainingOwned.push({
        identity: live,
        reason: `Process still running after ${waitTimeoutMs}ms termination wait timeout`,
      });
    }
    for (const u of waitResult.unverified) {
      unverifiedOwned.push(u);
    }
    for (const reused of waitResult.reusedPids) {
      reusedPids.push(reused);
    }
  }

  const blockers = [...remainingOwned, ...unverifiedOwned];
  if (blockers.length > 0) {
    const blockerDetails = blockers
      .map(
        (b) =>
          `[${formatProcessIdentity(b.identity)} -> Reason: ${b.reason}]`,
      )
      .join('; ');
    cleanupErrors.push(
      `Preserving temporary sandbox "${tempSandbox}" because ${blockers.length} test-owned or unverified process(es) remain or could not be verified: ${blockerDetails}. Manual cleanup: verify PID(s) and ExecutablePath above before closing manually, then delete "${tempSandbox}".`,
    );
  } else if (tempSandbox) {
    try {
      await removeDir(tempSandbox, { maxAttempts: 10, delayMs: 300 });
    } catch (cleanupDirError) {
      cleanupErrors.push(
        cleanupDirError instanceof Error ? cleanupDirError.message : String(cleanupDirError),
      );
    }
  }

  if (cleanupErrors.length > 0) {
    const cleanupError = new Error(`Packaged runtime cleanup failed: ${cleanupErrors.join(' | ')}`);
    if (primaryError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        `${primaryError.message}\nAdditionally, ${cleanupError.message}`,
      );
    }
    throw cleanupError;
  }

  return {
    cleanedSandbox: Boolean(tempSandbox),
    reusedPids,
  };
}

async function captureSpawnedMainIdentity(
  pid,
  expectedExePath,
  {
    queryProcessTable = () => queryWindowsProcessTable(),
    timeoutMs = 3_000,
    platform = process.platform,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const table = queryProcessTable();
      const rec = table.get(pid);
      if (rec) {
        if (!isCompleteProcessIdentity(rec)) {
          throw new ProcessEnumerationError(
            `Spawned main process PID ${pid} returned incomplete identity (${formatProcessIdentity(rec)})`,
          );
        }
        if (!pathsEqual(rec.executablePath, expectedExePath, platform)) {
          throw new ProcessEnumerationError(
            `Spawned main process PID ${pid} executable mismatch: expected "${expectedExePath}", got "${rec.executablePath}"`,
          );
        }
        return rec;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!(lastError instanceof ProcessEnumerationError)) {
        throw lastError;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new ProcessEnumerationError(
    `Unable to capture verifiable process identity for spawned PID ${pid} within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`,
    { cause: lastError ?? undefined },
  );
}

export async function runPackagedRuntimeTest({ argv = process.argv } = {}) {
  const explicitExe = parseCliArg('--exe', argv);
  const unpackedSourceDir = join(desktopDir, 'release', 'win-unpacked');
  const tempSandbox = await mkdtemp(join(tmpdir(), 'retailos-packaged-smoke-'));
  const tempUserDataDir = join(tempSandbox, 'userData');
  const controlFilePath = join(tempUserDataDir, 'data', '.retailos-control.json');
  const desktopLogPath = join(tempUserDataDir, 'data', 'desktop.log');

  let preExistingPids = new Set();
  let child = null;
  let spawnedMainIdentity = null;
  let unverifiedMainPid = null;
  let targetExePath = join(unpackedSourceDir, 'RetailOS.exe');
  let expectedServerScriptPath = join(unpackedSourceDir, 'resources', 'web', 'server.mjs');
  const ownedProcesses = new Map();
  let primaryError = null;

  try {
    preExistingPids = assertSafeTestEnvironment(explicitExe, tempUserDataDir);

    let targetAppDir = unpackedSourceDir;
    let copiedOutOfRepo = false;

    if (explicitExe) {
      targetExePath = resolve(explicitExe);
      targetAppDir = dirname(targetExePath);
    } else {
      assert.ok(
        existsSync(join(unpackedSourceDir, 'RetailOS.exe')),
        `Packaged executable not found at ${join(unpackedSourceDir, 'RetailOS.exe')}. Run desktop packaging first.`,
      );
      targetAppDir = join(tempSandbox, 'app');
      await cp(unpackedSourceDir, targetAppDir, { recursive: true, dereference: true });
      targetExePath = join(targetAppDir, 'RetailOS.exe');
      copiedOutOfRepo = true;
    }

    expectedServerScriptPath = join(targetAppDir, 'resources', 'web', 'server.mjs');

    const asarPath = join(targetAppDir, 'resources', 'app.asar');
    assert.ok(existsSync(asarPath), `Missing app.asar at ${asarPath}`);

    const asarHeader = await readAsarIndex(asarPath);
    const asarEntries = collectAsarPaths(asarHeader);
    for (const expectedEntry of [
      'package.json',
      'dist/main.js',
      'dist/runtime.js',
      'dist/license-public-key.generated.js',
      'dist/preload.cjs',
    ]) {
      assert.ok(
        asarEntries.includes(expectedEntry),
        `app.asar missing required entry "${expectedEntry}". Found: ${asarEntries.join(', ')}`,
      );
    }
    const forbiddenAsarEntries = asarEntries.filter(
      (entry) =>
        entry.includes('node_modules') ||
        entry.includes('@retailos') ||
        entry.includes('better-sqlite3'),
    );
    assert.deepEqual(
      forbiddenAsarEntries,
      [],
      `app.asar must NOT contain node_modules or backend packages: ${forbiddenAsarEntries.join(', ')}`,
    );

    const webResourcesDir = join(targetAppDir, 'resources', 'web');
    assert.ok(existsSync(expectedServerScriptPath), 'Missing resources/web/server.mjs');
    assert.ok(
      existsSync(join(webResourcesDir, 'integrity-manifest.json')),
      'Missing resources/web/integrity-manifest.json',
    );
    assert.ok(
      existsSync(join(webResourcesDir, 'node_modules', '@retailos', 'infrastructure', 'dist', 'index.js')),
      'Missing resources/web/node_modules/@retailos/infrastructure',
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.NODE_ENV = 'production';
    env.RETAILOS_DESKTOP_USER_DATA_DIR = tempUserDataDir;
    env.RETAILOS_DESKTOP_LOG = '1';

    child = spawn(targetExePath, [], {
      cwd: targetAppDir,
      env,
      stdio: 'ignore',
    });
    if (!(typeof child.pid === 'number' && Number.isInteger(child.pid) && child.pid > 0)) {
      throw new Error('Failed to capture spawned RetailOS.exe PID');
    }
    unverifiedMainPid = child.pid;

    let earlyExitError = null;
    let controlData = null;
    child.once('exit', (code, signal) => {
      if (!controlData) {
        earlyExitError = new Error(
          `RetailOS.exe exited prematurely (code=${String(code)}, signal=${String(signal)})`,
        );
      }
    });

    spawnedMainIdentity = await captureSpawnedMainIdentity(child.pid, targetExePath);
    unverifiedMainPid = null;
    ownedProcesses.set(spawnedMainIdentity.pid, { identity: spawnedMainIdentity, depth: 0 });

    let trackedServerIdentity = null;
    let bootstrapJson = null;
    let licenseStatus = null;
    const deadline = Date.now() + 45_000;

    while (Date.now() < deadline) {
      if (earlyExitError) {
        const logContent = existsSync(desktopLogPath) ? await readFile(desktopLogPath, 'utf8') : '';
        throw new Error(`${earlyExitError.message}\n${logContent}`);
      }
      if (existsSync(controlFilePath)) {
        try {
          const parsed = JSON.parse(await readFile(controlFilePath, 'utf8'));
          if (
            !trackedServerIdentity &&
            parsed &&
            typeof parsed.pid === 'number' &&
            Number.isInteger(parsed.pid) &&
            parsed.pid > 0
          ) {
            const table = queryWindowsProcessTable();
            const liveServer = table.get(parsed.pid);
            if (liveServer) {
              const ownership = validateServerProcessOwnership(liveServer, {
                expectedExePath: targetExePath,
                expectedParentPid: spawnedMainIdentity.pid,
                expectedServerScriptPath,
                preExistingPids,
                spawnedMainIdentity,
              });
              if (!ownership.valid) {
                throw new Error(
                  `Refusing to track control-file PID ${parsed.pid}: ${ownership.reason}`,
                );
              }
              trackedServerIdentity = ownership.identity;
              ownedProcesses.set(trackedServerIdentity.pid, {
                identity: trackedServerIdentity,
                depth: 1,
              });
            }
          }
          const logSoFar = existsSync(desktopLogPath) ? await readFile(desktopLogPath, 'utf8') : '';
          const windowLoaded =
            logSoFar.includes('webContents did-finish-load') &&
            logSoFar.includes('window ready-to-show');
          if (
            windowLoaded &&
            trackedServerIdentity &&
            parsed &&
            typeof parsed.port === 'number' &&
            parsed.pid === trackedServerIdentity.pid
          ) {
            const bootRes = await fetch(`http://127.0.0.1:${parsed.port}/api/bootstrap`);
            if (bootRes.ok) {
              bootstrapJson = await bootRes.json();
              const licRes = await fetch(`http://127.0.0.1:${parsed.port}/api/license/status`);
              licenseStatus = await licRes.json();
              controlData = parsed;
              break;
            }
          }
        } catch (loopErr) {
          if (loopErr instanceof Error && loopErr.message.startsWith('Refusing to track')) {
            throw loopErr;
          }
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }

    const logText = existsSync(desktopLogPath) ? await readFile(desktopLogPath, 'utf8') : '';
    assert.ok(controlData, `Timed out waiting for packaged RetailOS server. Log:\n${logText}`);
    assert.ok(trackedServerIdentity, 'Managed server identity was not verified via CIM');
    assert.equal(bootstrapJson?.configured, true);
    assert.equal(bootstrapJson?.setupRequired, true);
    assert.equal(licenseStatus?.status, 'UNLICENSED');
    assert.match(logText, /server ready at http:\/\/127\.0\.0\.1:/);
    assert.match(logText, /webContents did-finish-load/);
    assert.doesNotMatch(logText, /ERR_MODULE_NOT_FOUND|fatal startup error/);

    const treeSnapshot = collectProcessTreeIdentities(spawnedMainIdentity, {
      preExistingPids,
    });
    for (const [pid, identity] of treeSnapshot.identities.entries()) {
      if (!ownedProcesses.has(pid)) {
        ownedProcesses.set(pid, {
          identity,
          depth: treeSnapshot.depths.get(pid) ?? 1,
        });
      }
    }

    const exitPromise = new Promise((resolvePromise) => {
      child.once('exit', (code) => resolvePromise(code));
    });
    if (process.platform === 'win32') {
      const closeAttempt = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          [
            `Add-Type -TypeDefinition 'using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; public static class WinEnum { public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam); public static int CloseBrowserWindows(uint targetPid) { int count = 0; EnumWindows((hWnd, lParam) => { uint pid; GetWindowThreadProcessId(hWnd, out pid); if (pid == targetPid) { var sbC = new StringBuilder(256); GetClassName(hWnd, sbC, 256); if (sbC.ToString() == "Chrome_WidgetWin_1" && IsWindowVisible(hWnd)) { if (PostMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero)) count++; } } return true; }, IntPtr.Zero); return count; } }'`,
            `[WinEnum]::CloseBrowserWindows([uint32]${String(spawnedMainIdentity.pid)})`,
          ].join('; '),
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      if (closeAttempt.status !== 0 || Number.parseInt(closeAttempt.stdout.trim(), 10) < 1) {
        spawnSync('taskkill.exe', ['/PID', String(spawnedMainIdentity.pid)], { windowsHide: true });
      }
    } else {
      child.kill('SIGTERM');
    }

    const exitCode = await Promise.race([
      exitPromise,
      new Promise((resolvePromise) => setTimeout(() => resolvePromise('TIMEOUT'), 15_000)),
    ]);
    if (exitCode === 'TIMEOUT') {
      throw new Error(
        `RetailOS.exe (${formatProcessIdentity(spawnedMainIdentity)}) did not exit cleanly within 15s.\nLog:\n${logText}`,
      );
    }

    const expectedToExit = Array.from(ownedProcesses.values()).map((r) => r.identity);
    const exitVerification = await waitForVerifiedProcessesExit(expectedToExit, {
      timeoutMs: 8_000,
      pollIntervalMs: 200,
    });
    assert.deepEqual(
      exitVerification.stillRunning.map((p) => formatProcessIdentity(p)),
      [],
      `Orphan verified process(es) still running after window close`,
    );
    assert.deepEqual(
      exitVerification.unverified.map((u) => u.reason),
      [],
      'Failed to verify clean exit of test-owned processes',
    );
    assert.equal(
      existsSync(controlFilePath),
      false,
      'Runtime control file should be removed after clean desktop shutdown',
    );

    console.log(
      JSON.stringify({
        ok: true,
        copiedOutOfRepo,
        exePath: targetExePath,
        sandboxDir: tempSandbox,
        spawnedMainPid: spawnedMainIdentity.pid,
        spawnedMainCreationDate: spawnedMainIdentity.creationDate,
        serverPid: trackedServerIdentity.pid,
        serverCreationDate: trackedServerIdentity.creationDate,
        asarEntries,
        serverPort: controlData.port,
        bootstrapConfigured: bootstrapJson.configured,
        licenseStatus: licenseStatus.status,
        exitCode,
        orphanPidsRemaining: exitVerification.stillRunning.length,
      }),
    );
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    throw primaryError;
  } finally {
    await cleanupPackagedTestRun({
      ownedProcesses,
      spawnedMainIdentity,
      unverifiedMainPid,
      controlFilePath,
      expectedExePath: targetExePath,
      expectedServerScriptPath,
      preExistingPids,
      tempSandbox,
      primaryError,
    });
  }
}

function isInvokedDirectly() {
  const selfPath = fileURLToPath(import.meta.url);
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    return realpathSync(resolve(entryArg)) === realpathSync(selfPath);
  } catch {
    return resolve(entryArg) === resolve(selfPath);
  }
}

if (isInvokedDirectly()) {
  await runPackagedRuntimeTest();
}
