import type { ExecutionContext } from '@retailos/application';
import {
  OutboxSyncWorker,
  SqliteAuditLogRepository,
  type SqliteDatabaseManager,
  SqliteOutboxRepository,
  type OutboxSyncTransport,
} from '@retailos/infrastructure';
import {
  createDesktopWindowSecurityPolicy,
  DESKTOP_IPC_CHANNELS,
  type DesktopWindowSecurityPolicy,
} from './runtime.js';

export * from './runtime.js';

type DatabaseHandle = ConstructorParameters<typeof SqliteOutboxRepository>[0];

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
