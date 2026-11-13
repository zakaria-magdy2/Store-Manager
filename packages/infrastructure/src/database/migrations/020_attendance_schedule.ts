import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('users').addColumn('shift_start_time', 'text').execute();
  await db.schema
    .alterTable('users')
    .addColumn('late_grace_minutes', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('late_grace_minutes').execute();
  await db.schema.alterTable('users').dropColumn('shift_start_time').execute();
}
