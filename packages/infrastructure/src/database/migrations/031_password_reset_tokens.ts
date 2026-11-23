import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('used_password_reset_tokens')
    .ifNotExists()
    .addColumn('reset_id', 'text', (col) => col.primaryKey())
    .addColumn('machine_id', 'text', (col) => col.notNull())
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('used_at', 'text', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('used_password_reset_tokens').ifExists().execute();
}
