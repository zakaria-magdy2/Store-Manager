import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('users').addColumn('phone', 'text').execute();
  await db.schema.alterTable('users').addColumn('employment_start_date', 'text').execute();
  await sql`UPDATE users SET employment_start_date = substr(created_at, 1, 10) WHERE employment_start_date IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('employment_start_date').execute();
  await db.schema.alterTable('users').dropColumn('phone').execute();
}
