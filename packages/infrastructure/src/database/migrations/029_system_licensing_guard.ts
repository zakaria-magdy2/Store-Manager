import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 029:
 * Protect `system_licensing` from SQL DELETE statements so tampering cannot
 * silently wipe the monotonic clock watermark or saved activation token.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TRIGGER IF NOT EXISTS trg_system_licensing_no_delete
    BEFORE DELETE ON system_licensing
    BEGIN
      SELECT RAISE(ABORT, 'system_licensing is append-protected: deletion is forbidden');
    END;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_system_licensing_no_delete;`.execute(db);
}
