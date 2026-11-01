import type { Kysely, Migration } from 'kysely';
import { Migrator } from 'kysely';
import { Logger } from '../logger/logger.js';
import type { RetailOSDatabase } from './types.js';
import * as initialFoundation from './migrations/001_initial_foundation.js';
import * as identitySessions from './migrations/002_identity_sessions.js';

export class DatabaseMigrator {
  private readonly logger: Logger;

  constructor(private readonly db: Kysely<RetailOSDatabase>) {
    this.logger = new Logger('DatabaseMigrator');
  }

  public async migrateToLatest(): Promise<{
    success: boolean;
    executedMigrations: string[];
    error?: Error;
  }> {
    const migrations: Record<string, Migration> = {
      '001_initial_foundation': {
        up: initialFoundation.up,
        down: initialFoundation.down,
      },
      '002_identity_sessions': {
        up: identitySessions.up,
        down: identitySessions.down,
      },
    };

    // Cast to Kysely<unknown> as required by Kysely's Migrator API
    const migrator = new Migrator({
      db: this.db as Kysely<unknown>,
      provider: {
        getMigrations: () => Promise.resolve(migrations),
      },
    });

    this.logger.info('Running database migrations to latest version...');
    const { error, results } = await migrator.migrateToLatest();

    const executed: string[] = [];
    results?.forEach((it) => {
      if (it.status === 'Success') {
        executed.push(it.migrationName);
        this.logger.info(`Migration '${it.migrationName}' successfully executed.`);
      } else if (it.status === 'Error') {
        this.logger.error(`Migration '${it.migrationName}' failed.`);
      }
    });

    if (error) {
      this.logger.error('Database migration failed', error as Error);
      return { success: false, executedMigrations: executed, error: error as Error };
    }

    return { success: true, executedMigrations: executed };
  }
}
