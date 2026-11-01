import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add store_id to users table for store assignments
  await db.schema
    .alterTable('users')
    .addColumn('store_id', 'text', (col) => col.references('stores.id').onDelete('set null'))
    .execute();

  // 13. Sessions Table
  await db.schema
    .createTable('sessions')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('tenant_id', 'text', (col) =>
      col.notNull().references('tenants.id').onDelete('restrict'),
    )
    .addColumn('store_id', 'text', (col) => col.references('stores.id').onDelete('set null'))
    .addColumn('user_id', 'text', (col) =>
      col.notNull().references('users.id').onDelete('restrict'),
    )
    .addColumn('token_hash', 'text', (col) => col.notNull().unique())
    .addColumn('expires_at', 'text', (col) => col.notNull())
    .addColumn('is_revoked', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute();

  await db.schema
    .createIndex('idx_sessions_token_hash')
    .on('sessions')
    .column('token_hash')
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_sessions_tenant_user')
    .on('sessions')
    .columns(['tenant_id', 'user_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('sessions').execute();
}
