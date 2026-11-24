import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Safety for upgrading legacy databases that might have >1 OPEN shift in the same store:
  // keep the most recently started OPEN shift per (tenant_id, store_id) and close any older duplicates.
  await sql`
    UPDATE cashier_shifts
    SET status = 'CLOSED',
        ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'OPEN'
      AND id NOT IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY tenant_id, store_id ORDER BY started_at DESC, id DESC) AS rn
          FROM cashier_shifts
          WHERE status = 'OPEN'
        )
        WHERE rn = 1
      );
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cashier_shifts_one_open_per_store
    ON cashier_shifts(tenant_id, store_id)
    WHERE status = 'OPEN';
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_cashier_shifts_one_open_per_store;`.execute(db);
}
