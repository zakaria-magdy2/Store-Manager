import Database, { type Database as DatabaseInstance } from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { RetailOSDatabase } from './types.js';
import { Logger } from '../logger/logger.js';

export interface SqliteConnectionOptions {
  filename: string;
  readOnly?: boolean;
}

export class SqliteDatabaseManager {
  private rawDb: DatabaseInstance | null = null;
  private kyselyDb: Kysely<RetailOSDatabase> | null = null;
  private readonly logger: Logger;

  constructor(private readonly options: SqliteConnectionOptions) {
    this.logger = new Logger('SqliteDatabaseManager');
  }

  public getDb(): Kysely<RetailOSDatabase> {
    if (!this.kyselyDb) {
      this.connect();
    }
    return this.kyselyDb!;
  }

  public getRawDatabase(): DatabaseInstance {
    if (!this.rawDb) {
      this.connect();
    }
    return this.rawDb!;
  }

  public connect(): void {
    if (this.rawDb) {
      return;
    }

    this.logger.info(`Connecting to SQLite database: ${this.options.filename}`);
    this.rawDb = new Database(this.options.filename, {
      readonly: this.options.readOnly ?? false,
      fileMustExist: false,
    });

    // Enforce high-performance & safe retail defaults
    this.rawDb.pragma('journal_mode = WAL');
    this.rawDb.pragma('synchronous = NORMAL');
    this.rawDb.pragma('foreign_keys = ON');
    this.rawDb.pragma('busy_timeout = 5000');

    this.kyselyDb = new Kysely<RetailOSDatabase>({
      dialect: new SqliteDialect({
        database: this.rawDb,
      }),
    });
  }

  /**
   * Releases every native resource held by this manager.
   *
   * The Kysely instance owns the driver/pool that wraps the `better-sqlite3`
   * handle, so it must be destroyed as well. Closing only the raw handle leaves
   * pooled connections and native statements alive until garbage collection,
   * which can crash the process when the Node environment is torn down (finalizers
   * run against an already-disposed isolate). Always `await` this method.
   */
  public async close(): Promise<void> {
    if (!this.rawDb) {
      return;
    }

    this.logger.info(`Closing SQLite database: ${this.options.filename}`);
    try {
      // Run checkpoint before closing to flush WAL into main DB
      this.rawDb.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      this.logger.warn(`Checkpoint on close returned non-fatal notice: ${String(err)}`);
    }

    const kyselyDb = this.kyselyDb;
    const rawDb = this.rawDb;
    this.kyselyDb = null;
    this.rawDb = null;

    if (kyselyDb) {
      // Kysely's destroy() closes the underlying better-sqlite3 handle.
      await kyselyDb.destroy();
    } else if (rawDb.open) {
      rawDb.close();
    }
  }
}
