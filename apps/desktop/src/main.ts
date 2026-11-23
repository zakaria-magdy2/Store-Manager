import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  buildServerProcessEnv,
  createDesktopWindowSecurityPolicy,
  DEFAULT_DESKTOP_PORT,
  type DesktopDataPaths,
  type DesktopWindowSecurityPolicy,
  readDesktopDailyBackupHistory,
  readExternalClockWatermark,
  resolveAvailableLoopbackPort,
  resolveDesktopApplicationName,
  resolveDesktopDataPaths,
  resolveOrCreateDesktopDailyBackupSecret,
  resolveOrCreateDesktopWatermarkSecret,
  startManagedServerChild,
  stopManagedServerProcess,
  updateDesktopDailyBackupSecret,
  verifyStagedRuntimeIntegrity,
  waitForServerReady,
  writeExternalClockWatermark,
} from './runtime.js';

const CHANNELS = Object.freeze({
  GET_INFO: 'retailos:desktop:get-info',
  OPEN_DATA_FOLDER: 'retailos:desktop:open-data-folder',
  OPEN_BACKUPS_FOLDER: 'retailos:desktop:open-backups-folder',
  PRINT_RECEIPT: 'retailos:desktop:print-receipt',
} as const);

const WINDOW_TITLE = 'رف — إدارة المتجر';

const currentDir = dirname(fileURLToPath(import.meta.url));
const overrideUserDataDir = process.env.RETAILOS_DESKTOP_USER_DATA_DIR?.trim();
const previewResetMarkerExists = app.isPackaged
  && existsSync(join(process.resourcesPath, 'web', 'preview-reset-mode.js'));
app.setName(resolveDesktopApplicationName(previewResetMarkerExists));
if (overrideUserDataDir) {
  app.setPath('userData', resolve(overrideUserDataDir));
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let serverChild: ChildProcess | null = null;
let serverOrigin = `http://127.0.0.1:${String(DEFAULT_DESKTOP_PORT)}`;
let desktopPaths: DesktopDataPaths | null = null;
let activeSecurityPolicy: DesktopWindowSecurityPolicy | null = null;
let quitHandled = false;
let shutdownInFlight: Promise<void> | null = null;
let pendingClockPersist: Promise<void> = Promise.resolve();
let pendingDailyKeyPersist: Promise<void> = Promise.resolve();
let webContentsGuardInstalled = false;
const trustedPopupWebContentsIds = new Set<number>();

function writeDesktopLog(message: string, force = false): void {
  if (!force && process.env.RETAILOS_DESKTOP_LOG !== '1') {
    return;
  }
  const targetDir = desktopPaths?.dataDir ?? overrideUserDataDir;
  if (!targetDir) {
    return;
  }
  const line = `[${new Date().toISOString()}] ${message}\n`;
  void mkdir(targetDir, { recursive: true })
    .then(() => appendFile(join(targetDir, 'desktop.log'), line, 'utf8'))
    .catch(() => undefined);
}

function resolveWebServerScriptPath(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'web', 'server.mjs')]
    : [
        resolve(currentDir, '..', '..', 'web', 'server.mjs'),
        join(process.resourcesPath, 'web', 'server.mjs'),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `RetailOS desktop startup error: Could not find embedded web server at any expected path (${candidates.join(', ')})`,
  );
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  if (!activeSecurityPolicy) {
    throw new Error('Forbidden: Security policy is not initialized');
  }
  const senderUrl = event.senderFrame?.url ?? '';
  if (!activeSecurityPolicy.isAllowedNavigationUrl(senderUrl)) {
    throw new Error(`Forbidden Desktop IPC origin: ${senderUrl}`);
  }
}

async function shutdownServerOnce(): Promise<void> {
  if (shutdownInFlight) {
    return shutdownInFlight;
  }
  shutdownInFlight = (async () => {
    if (desktopPaths) {
      await stopManagedServerProcess({
        child: serverChild,
        dataDir: desktopPaths.dataDir,
        origin: serverOrigin,
      });
    }
    await pendingClockPersist.catch(() => undefined);
    await pendingDailyKeyPersist.catch(() => undefined);
    serverChild = null;
  })();
  return shutdownInFlight;
}

function registerIpcHandlers(): void {
  ipcMain.handle(CHANNELS.GET_INFO, (event) => {
    assertTrustedIpcSender(event);
    if (!desktopPaths) {
      throw new Error('Desktop data paths are not initialized');
    }
    return {
      appName: app.getName(),
      appVersion: app.getVersion(),
      userDataDir: desktopPaths.userDataDir,
      dataDir: desktopPaths.dataDir,
      backupDir: desktopPaths.backupDir,
      serverOrigin,
    };
  });

  ipcMain.handle(CHANNELS.OPEN_DATA_FOLDER, async (event) => {
    assertTrustedIpcSender(event);
    if (!desktopPaths) {
      return { ok: false };
    }
    await mkdir(desktopPaths.dataDir, { recursive: true });
    const openError = await shell.openPath(desktopPaths.dataDir);
    return { ok: openError === '' };
  });

  ipcMain.handle(CHANNELS.OPEN_BACKUPS_FOLDER, async (event) => {
    assertTrustedIpcSender(event);
    if (!desktopPaths) {
      return { ok: false };
    }
    await mkdir(desktopPaths.dailyBackupDir, { recursive: true });
    const openError = await shell.openPath(desktopPaths.backupDir);
    return { ok: openError === '' };
  });

  ipcMain.handle(
    CHANNELS.PRINT_RECEIPT,
    async (event, rawOptions?: { readonly silent?: boolean | undefined }) => {
      assertTrustedIpcSender(event);
      const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      if (!targetWindow || targetWindow.isDestroyed()) {
        return { printed: false };
      }
      const silent = Boolean(rawOptions?.silent);
      return new Promise<{ readonly printed: boolean }>((resolvePromise) => {
        targetWindow.webContents.print(
          { silent, printBackground: true },
          (success) => resolvePromise({ printed: success }),
        );
      });
    },
  );
}

function resolveWindowIconPath(): string | undefined {
  const candidates = [
    join(currentDir, '..', 'build', 'icon.ico'),
    join(currentDir, '..', 'build', 'icon.png'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function createMainWindow(origin: string, securityPolicy: DesktopWindowSecurityPolicy): BrowserWindow {
  const preloadPath = join(currentDir, 'preload.cjs');
  const iconPath = resolveWindowIconPath();
  const win = new BrowserWindow({
    title: WINDOW_TITLE,
    ...(iconPath ? { icon: iconPath } : {}),
    width: 1400,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      contextIsolation: securityPolicy.contextIsolation,
      nodeIntegration: securityPolicy.nodeIntegration,
      sandbox: securityPolicy.sandbox,
      webSecurity: securityPolicy.webSecurity,
      allowRunningInsecureContent: securityPolicy.allowRunningInsecureContent,
      preload: preloadPath,
    },
  });

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!securityPolicy.isAllowedNavigationUrl(targetUrl)) {
      event.preventDefault();
    }
  });

  win.webContents.on('did-create-window', (childWindow, details) => {
    const childContentsId = childWindow.webContents.id;
    if (
      activeSecurityPolicy &&
      (details.url === 'about:blank' || activeSecurityPolicy.isAllowedNavigationUrl(details.url))
    ) {
      trustedPopupWebContentsIds.add(childContentsId);
      childWindow.webContents.once('destroyed', () => {
        trustedPopupWebContentsIds.delete(childContentsId);
      });
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || securityPolicy.isAllowedNavigationUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'رف — طباعة',
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: securityPolicy.contextIsolation,
            nodeIntegration: securityPolicy.nodeIntegration,
            sandbox: securityPolicy.sandbox,
            webSecurity: securityPolicy.webSecurity,
            allowRunningInsecureContent: securityPolicy.allowRunningInsecureContent,
          },
        },
      };
    }
    return { action: 'deny' };
  });

  const fallbackShowTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      writeDesktopLog('window fallback show triggered');
      win.maximize();
      win.show();
    }
  }, 3000);
  fallbackShowTimer.unref();

  win.once('ready-to-show', () => {
    clearTimeout(fallbackShowTimer);
    writeDesktopLog('window ready-to-show');
    if (!win.isDestroyed()) {
      win.maximize();
      win.show();
    }
  });

  win.webContents.on('did-finish-load', () => {
    writeDesktopLog(`webContents did-finish-load title=${win.getTitle()}`);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    writeDesktopLog(
      `webContents did-fail-load code=${String(errorCode)} desc=${errorDescription} url=${validatedUrl}`,
    );
  });

  win.on('closed', () => {
    clearTimeout(fallbackShowTimer);
    writeDesktopLog('mainWindow closed');
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  writeDesktopLog(`loading URL ${origin}`);
  void win.loadURL(origin);
  return win;
}

function installGlobalWebContentsGuards(): void {
  if (webContentsGuardInstalled) {
    return;
  }
  webContentsGuardInstalled = true;

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (navEvent, targetUrl) => {
      if (!activeSecurityPolicy || !activeSecurityPolicy.isAllowedChildNavigationUrl(targetUrl)) {
        navEvent.preventDefault();
      }
    });

    // Lock down any child / popup WebContents (including about:blank print windows)
    // so it cannot spawn nested popups or navigate off-origin.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    contents.once('destroyed', () => {
      trustedPopupWebContentsIds.delete(contents.id);
    });
  });
}

async function bootDesktopApplication(): Promise<void> {
  const userDataDir = app.getPath('userData');
  const paths = resolveDesktopDataPaths(userDataDir);
  desktopPaths = paths;
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.dailyBackupDir, { recursive: true });

  const port = await resolveAvailableLoopbackPort(DEFAULT_DESKTOP_PORT);
  serverOrigin = `http://127.0.0.1:${String(port)}`;
  const securityPolicy = createDesktopWindowSecurityPolicy(serverOrigin);
  activeSecurityPolicy = securityPolicy;

  const desktopVersion = app.getVersion();
  process.env.RETAILOS_DESKTOP_VERSION = desktopVersion;

  const requireDpapi = process.platform === 'win32' && (app.isPackaged || process.env.NODE_ENV === 'production');
  const serverScriptPath = resolveWebServerScriptPath();
  await verifyStagedRuntimeIntegrity({
    webDir: dirname(serverScriptPath),
    requireManifest: app.isPackaged || process.env.NODE_ENV === 'production',
  });

  const watermarkSecret = await resolveOrCreateDesktopWatermarkSecret({
    userDataDir: paths.userDataDir,
    safeStorage,
    requireDpapi,
    legacyPlaintextKeyPath: join(paths.dataDir, '.retailos-watermark.key'),
  });
  const dailyBackupSecret = await resolveOrCreateDesktopDailyBackupSecret({
    userDataDir: paths.userDataDir,
    safeStorage,
    requireDpapi,
    legacyPlaintextKeyPath: join(paths.dataDir, '.retailos-daily.key'),
  });
  const dailyBackupKeyHistory = (
    await readDesktopDailyBackupHistory({
      userDataDir: paths.userDataDir,
      safeStorage,
      requireDpapi,
    })
  ).filter((item) => item !== dailyBackupSecret);
  const externalClock = await readExternalClockWatermark({
    userDataDir: paths.userDataDir,
    watermarkSecret,
    safeStorage,
    requireDpapi,
  });

  const childEnv = buildServerProcessEnv(process.env, paths, port, {
    runAsNode: true,
    desktopVersion,
  });

  const managed = startManagedServerChild({
    execPath: process.execPath,
    serverScriptPath,
    cwd: dirname(serverScriptPath),
    env: childEnv,
    watermarkSecret,
    dailyBackupSecret,
    dailyBackupKeyHistory,
    externalClockMs: externalClock.clockMs,
    externalClockTampered: externalClock.tampered,
    onClockAdvance: (nextClockMs) => {
      pendingClockPersist = pendingClockPersist
        .then(() =>
          writeExternalClockWatermark({
            userDataDir: paths.userDataDir,
            watermarkSecret,
            clockMs: nextClockMs,
            safeStorage,
            requireDpapi,
          }),
        )
        .catch(() => undefined);
    },
    onDailyBackupSecretUpdate: (nextSecret) => {
      const task = pendingDailyKeyPersist.then(() =>
        updateDesktopDailyBackupSecret({
          userDataDir: paths.userDataDir,
          dailyBackupSecret: nextSecret,
          safeStorage,
          requireDpapi,
        }),
      );
      pendingDailyKeyPersist = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
  });
  serverChild = managed.child;

  await waitForServerReady({
    origin: serverOrigin,
    child: managed.child,
    logs: managed.logs,
  });
  writeDesktopLog(`server ready at ${serverOrigin}`);

  installGlobalWebContentsGuards();

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const requestingUrl = details.requestingUrl || webContents.getURL();
      const openerOrigin = trustedPopupWebContentsIds.has(webContents.id)
        ? serverOrigin
        : undefined;
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
      const requestedPermission = permission === 'media'
        && mediaTypes?.includes('video')
        && !mediaTypes.includes('audio')
        ? 'camera'
        : permission;
      callback(
        Boolean(
          activeSecurityPolicy?.isAllowedPermissionRequest(
            requestedPermission,
            requestingUrl,
            openerOrigin,
          ),
        ),
      );
    },
  );

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const targetUrl = requestingOrigin || webContents?.getURL() || '';
    const openerOrigin =
      webContents && trustedPopupWebContentsIds.has(webContents.id) ? serverOrigin : undefined;
    const requestedPermission = permission === 'media'
      && details?.mediaType === 'video'
      ? 'camera'
      : permission;
    return Boolean(
      activeSecurityPolicy?.isAllowedPermissionRequest(requestedPermission, targetUrl, openerOrigin),
    );
  });

  registerIpcHandlers();
  mainWindow = createMainWindow(serverOrigin, securityPolicy);
  writeDesktopLog('mainWindow created');
}

if (singleInstanceLock) {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    writeDesktopLog('app window-all-closed');
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    writeDesktopLog(`app before-quit handled=${String(quitHandled)}`);
    if (quitHandled) {
      return;
    }
    event.preventDefault();
    quitHandled = true;
    void shutdownServerOnce().finally(() => {
      writeDesktopLog('server shutdown finished; exiting');
      app.exit(0);
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      quitHandled = true;
      void shutdownServerOnce().finally(() => {
        app.exit(0);
      });
    });
  }

  void app
    .whenReady()
    .then(() => bootDesktopApplication())
    .catch(async (error: unknown) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      writeDesktopLog(`fatal startup error: ${detail}`, true);
      await shutdownServerOnce().catch(() => undefined);
      dialog.showErrorBox(
        'رف — تعذر تشغيل النظام',
        `حدث خطأ أثناء تشغيل خادم رَفّ المحلي:\n\n${detail}`,
      );
      quitHandled = true;
      app.exit(1);
    });
}
