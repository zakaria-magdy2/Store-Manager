import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 028:
 * Single-row persistent store for offline hardware-locked licensing
 * and integrity-checked monotonic clock watermark against clock tampering.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE system_licensing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      activation_token TEXT,
      last_verified_clock_ms INTEGER NOT NULL,
      clock_hmac TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS system_licensing;`.execute(db);
}
