import type { ExecutionContext } from '@retailos/application';
import {
  OutboxSyncWorker,
  SqliteAuditLogRepository,
  type SqliteDatabaseManager,
  SqliteOutboxRepository,
  type OutboxSyncTransport,
} from '@retailos/infrastructure';

type DatabaseHandle = ConstructorParameters<typeof SqliteOutboxRepository>[0];

export const DESKTOP_IPC_CHANNELS = Object.freeze({
  HOST_STATUS: 'retailos:host:status',
  SYNC_RUN_BATCH: 'retailos:sync:run-batch',
  SYNC_STATS: 'retailos:sync:stats',
  AUDIT_VERIFY_CHAIN: 'retailos:audit:verify-chain',
} as const);

export type DesktopIpcChannel =
  (typeof DESKTOP_IPC_CHANNELS)[keyof typeof DESKTOP_IPC_CHANNELS];

const ALLOWED_IPC_CHANNEL_SET = new Set<string>(Object.values(DESKTOP_IPC_CHANNELS));

export interface DesktopWindowSecurityPolicy {
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly allowedOrigin: string;
  isAllowedNavigationUrl(targetUrl: string): boolean;
  isAllowedIpcChannel(channel: string): channel is DesktopIpcChannel;
}

export function createDesktopWindowSecurityPolicy(
  localLoopbackOrigin = 'http://127.0.0.1:4310',
): DesktopWindowSecurityPolicy {
  const parsedOrigin = new URL(localLoopbackOrigin);
  if (parsedOrigin.protocol !== 'http:' || parsedOrigin.hostname !== '127.0.0.1') {
    throw new Error(
      'DesktopSecurityError: localLoopbackOrigin must bind strictly to http://127.0.0.1',
    );
  }
  const normalizedOrigin = parsedOrigin.origin;

  return Object.freeze({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    allowedOrigin: normalizedOrigin,
    isAllowedNavigationUrl(targetUrl: string): boolean {
      try {
        const parsed = new URL(targetUrl);
        return parsed.origin === normalizedOrigin;
      } catch {
        return false;
      }
    },
    isAllowedIpcChannel(channel: string): channel is DesktopIpcChannel {
      return ALLOWED_IPC_CHANNEL_SET.has(channel);
    },
  });
}

export interface DesktopHostStatus {
  readonly mode: 'OFFLINE_FIRST_DESKTOP';
  readonly allowedOrigin: string;
  readonly outboxPendingCount: number;
  readonly outboxSyncedCount: number;
  readonly outboxLastSequenceNo: number;
  readonly auditChainValid: boolean;
  readonly auditCheckedEntries: number;
}

export class DesktopHostSupervisor {
  private readonly outboxRepo: SqliteOutboxRepository;
  private readonly auditRepo: SqliteAuditLogRepository;
  private readonly syncWorker: OutboxSyncWorker;
  private readonly securityPolicy: DesktopWindowSecurityPolicy;

  constructor(options: {
    db: DatabaseHandle | SqliteDatabaseManager;
    transport: OutboxSyncTransport;
    localLoopbackOrigin?: string | undefined;
  }) {
    const dbHandle: DatabaseHandle =
      'getDb' in options.db ? options.db.getDb() : options.db;
    this.outboxRepo = new SqliteOutboxRepository(dbHandle);
    this.auditRepo = new SqliteAuditLogRepository(dbHandle);
    this.syncWorker = new OutboxSyncWorker(this.outboxRepo, options.transport);
    this.securityPolicy = createDesktopWindowSecurityPolicy(options.localLoopbackOrigin);
  }

  public getSecurityPolicy(): DesktopWindowSecurityPolicy {
    return this.securityPolicy;
  }

  public async dispatchIpc(
    ctx: ExecutionContext,
    channel: string,
    payload?: { batchSize?: number | undefined },
  ): Promise<unknown> {
    if (!this.securityPolicy.isAllowedIpcChannel(channel)) {
      throw Object.assign(new Error(`Unauthorized Desktop IPC channel: ${channel}`), {
        status: 403,
      });
    }

    switch (channel) {
      case DESKTOP_IPC_CHANNELS.HOST_STATUS:
        return this.getHostStatus(ctx);
      case DESKTOP_IPC_CHANNELS.SYNC_STATS:
        return this.outboxRepo.getStats(ctx);
      case DESKTOP_IPC_CHANNELS.SYNC_RUN_BATCH:
        return this.syncWorker.syncPendingBatch(ctx, payload?.batchSize ?? 50);
      case DESKTOP_IPC_CHANNELS.AUDIT_VERIFY_CHAIN:
        return this.auditRepo.verifyChain(ctx);
    }
  }

  public async getHostStatus(ctx: ExecutionContext): Promise<DesktopHostStatus> {
    const [outboxStats, auditVerification] = await Promise.all([
      this.outboxRepo.getStats(ctx),
      this.auditRepo.verifyChain(ctx),
    ]);

    return {
      mode: 'OFFLINE_FIRST_DESKTOP',
      allowedOrigin: this.securityPolicy.allowedOrigin,
      outboxPendingCount: outboxStats.pendingCount,
      outboxSyncedCount: outboxStats.syncedCount,
      outboxLastSequenceNo: outboxStats.lastSequenceNo,
      auditChainValid: auditVerification.valid,
      auditCheckedEntries: auditVerification.checkedCount,
    };
  }
}
