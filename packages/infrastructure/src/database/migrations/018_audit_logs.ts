import { sql, type Kysely } from 'kysely';
import type { RetailOSDatabase } from '../types.js';

export async function up(db: Kysely<RetailOSDatabase>): Promise<void> {
  await db.schema
    .createTable('audit_logs')
    .addColumn('sequence_no', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('id', 'text', (col) => col.notNull().unique())
    .addColumn('tenant_id', 'text', (col) => col.notNull().references('tenants.id'))
    .addColumn('store_id', 'text', (col) => col.references('stores.id'))
    .addColumn('actor_user_id', 'text', (col) => col.references('users.id'))
    .addColumn('actor_username', 'text', (col) => col.notNull())
    .addColumn('actor_role', 'text', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('entity_type', 'text', (col) => col.notNull())
    .addColumn('entity_id', 'text')
    .addColumn('summary', 'text', (col) => col.notNull())
    .addColumn('metadata_json', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('previous_hash', 'text', (col) => col.notNull())
    .addColumn('entry_hash', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_audit_logs_tenant_seq')
    .on('audit_logs')
    .columns(['tenant_id', 'sequence_no'])
    .execute();

  await db.schema
    .createIndex('idx_audit_logs_tenant_action')
    .on('audit_logs')
    .columns(['tenant_id', 'action'])
    .execute();

  await sql`
    CREATE TRIGGER trg_audit_logs_tenant_guard_insert
    BEFORE INSERT ON audit_logs
    FOR EACH ROW
    BEGIN
      SELECT CASE
        WHEN NEW.store_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM stores WHERE id = NEW.store_id AND tenant_id = NEW.tenant_id
        ) THEN RAISE(ABORT, 'TenantIsolationViolation: audit_logs.store_id must belong to tenant_id')
        WHEN NEW.actor_user_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM users WHERE id = NEW.actor_user_id AND tenant_id = NEW.tenant_id
        ) THEN RAISE(ABORT, 'TenantIsolationViolation: audit_logs.actor_user_id must belong to tenant_id')
      END;
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_audit_logs_immutable_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'audit_logs is append-only: records cannot be modified');
    END;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_audit_logs_immutable_delete
    BEFORE DELETE ON audit_logs
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'audit_logs is append-only: records cannot be deleted');
    END;
  `.execute(db);
}

export async function down(db: Kysely<RetailOSDatabase>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_audit_logs_immutable_delete`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_audit_logs_immutable_update`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_audit_logs_tenant_guard_insert`.execute(db);
  await db.schema.dropIndex('idx_audit_logs_tenant_action').ifExists().execute();
  await db.schema.dropIndex('idx_audit_logs_tenant_seq').ifExists().execute();
  await db.schema.dropTable('audit_logs').ifExists().execute();
}
