import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = Object.freeze({
  GET_INFO: 'retailos:desktop:get-info',
  OPEN_DATA_FOLDER: 'retailos:desktop:open-data-folder',
  OPEN_BACKUPS_FOLDER: 'retailos:desktop:open-backups-folder',
  PRINT_RECEIPT: 'retailos:desktop:print-receipt',
} as const);

export interface PrintReceiptOptions {
  readonly silent?: boolean | undefined;
}

export interface DesktopRuntimeInfo {
  readonly appName: string;
  readonly appVersion: string;
  readonly userDataDir: string;
  readonly dataDir: string;
  readonly backupDir: string;
  readonly serverOrigin: string;
}

export interface RetailOSDesktopBridge {
  readonly isDesktop: true;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  getInfo(): Promise<DesktopRuntimeInfo>;
  openDataFolder(): Promise<{ readonly ok: boolean }>;
  openBackupsFolder(): Promise<{ readonly ok: boolean }>;
  printReceipt(options?: PrintReceiptOptions): Promise<{ readonly printed: boolean }>;
}

const desktopVersion = process.env.RETAILOS_DESKTOP_VERSION ?? '0.1.0';

const desktopBridge: RetailOSDesktopBridge = Object.freeze({
  isDesktop: true,
  version: desktopVersion,
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke(CHANNELS.GET_INFO) as Promise<DesktopRuntimeInfo>,
  openDataFolder: () =>
    ipcRenderer.invoke(CHANNELS.OPEN_DATA_FOLDER) as Promise<{ readonly ok: boolean }>,
  openBackupsFolder: () =>
    ipcRenderer.invoke(CHANNELS.OPEN_BACKUPS_FOLDER) as Promise<{ readonly ok: boolean }>,
  printReceipt: (options?: PrintReceiptOptions) =>
    ipcRenderer.invoke(CHANNELS.PRINT_RECEIPT, {
      silent: Boolean(options?.silent),
    }) as Promise<{ readonly printed: boolean }>,
});

contextBridge.exposeInMainWorld('retailosDesktop', desktopBridge);
