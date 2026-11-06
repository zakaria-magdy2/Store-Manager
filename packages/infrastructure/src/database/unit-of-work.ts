import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely, Transaction } from 'kysely';
import type { ExecutionContext, UnitOfWork } from '@retailos/application';
import type { RetailOSDatabase } from './types.js';

/**
 * Serializes write transactions on a single SQLite database connection and
 * exposes the active transaction handle via `AsyncLocalStorage` so nested
 * operations participate in the same atomic transaction without causing
 * nested `BEGIN TRANSACTION` errors on SQLite.
 */
export class SqliteUnitOfWork implements UnitOfWork {
  private readonly txStorage = new AsyncLocalStorage<Transaction<RetailOSDatabase>>();
  private readonly db: Kysely<RetailOSDatabase>;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(dbOrManager: Kysely<RetailOSDatabase> | { getDb(): Kysely<RetailOSDatabase> }) {
    this.db = 'getDb' in dbOrManager ? dbOrManager.getDb() : dbOrManager;
  }

  /**
   * Returns the active transaction for the current async execution context,
   * or falls back to the root Kysely database instance.
   */
  public getExecutor(): Kysely<RetailOSDatabase> {
    return this.txStorage.getStore() ?? this.db;
  }

  public execute<T>(ctx: ExecutionContext, work: () => Promise<T>): Promise<T>;
  public execute<T>(work: () => Promise<T>): Promise<T>;
  public async execute<T>(
    ctxOrWork: ExecutionContext | (() => Promise<T>),
    maybeWork?: () => Promise<T>,
  ): Promise<T> {
    const work = typeof ctxOrWork === 'function' ? ctxOrWork : maybeWork!;
    const existingTx = this.txStorage.getStore();
    if (existingTx) {
      // Re-entrant call inside an already active transaction
      return work();
    }

    const next = this.writeQueue.then(async () =>
      this.db.transaction().execute(async (trx) => this.txStorage.run(trx, work)),
    );

    // Keep queue moving even if `next` rejects
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  }
}
