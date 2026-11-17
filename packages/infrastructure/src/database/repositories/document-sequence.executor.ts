import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { RetailOSDatabase } from '../types.js';

export interface DocSequenceConfig {
  tenantId: string;
  docType: 'SALE' | 'PURCHASE' | 'SHIFT' | 'RETURN' | 'STOCKTAKE';
  prefix: string;
  existingTable:
    | 'sales'
    | 'supplier_purchases'
    | 'cashier_shifts'
    | 'customer_returns'
    | 'stocktake_sessions';
  existingCol:
    | 'sale_number'
    | 'invoice_number'
    | 'shift_number'
    | 'return_number'
    | 'session_number';
}

/**
 * Allocates a monotonically increasing, collision-free document number inside
 * an active database transaction so aborted/rolled-back writes never consume
 * a sequence number.
 */
export async function allocateDocumentNumberInTransaction(
  executor: Kysely<RetailOSDatabase>,
  config: DocSequenceConfig,
): Promise<string> {
  const { tenantId, docType, prefix, existingTable, existingCol } = config;
  const existingRows = await sql<{ num: string | null }>`
    SELECT ${sql.ref(existingCol)} AS num
    FROM ${sql.table(existingTable)}
    WHERE tenant_id = ${tenantId}
      AND ${sql.ref(existingCol)} IS NOT NULL;
  `.execute(executor);

  let maxExisting = 1000n;
  const escapedPrefix = prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const prefixRe = new RegExp(`^${escapedPrefix}(\\d+)$`);
  for (const row of existingRows.rows) {
    const match = String(row.num ?? '').match(prefixRe);
    if (match?.[1]) {
      const parsed = BigInt(match[1]);
      if (parsed > maxExisting) {
        maxExisting = parsed;
      }
    }
  }

  await executor
    .insertInto('document_sequences')
    .values({
      tenant_id: tenantId,
      doc_type: docType,
      last_seq: maxExisting,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'doc_type']).doNothing())
    .execute();

  const bumpNext = async (): Promise<bigint> => {
    const bumped = await executor
      .updateTable('document_sequences')
      .set((eb) => ({ last_seq: eb(eb.ref('last_seq'), '+', 1) }))
      .where('tenant_id', '=', tenantId)
      .where('doc_type', '=', docType)
      .returning('last_seq')
      .executeTakeFirst();
    return BigInt(bumped?.last_seq ?? maxExisting + 1n);
  };

  let seq = await bumpNext();
  while (true) {
    const candidate = `${prefix}${seq.toString()}`;
    const existing = await sql<{ id: string }>`
      SELECT id
      FROM ${sql.table(existingTable)}
      WHERE tenant_id = ${tenantId}
        AND ${sql.ref(existingCol)} = ${candidate}
      LIMIT 1;
    `.execute(executor);
    if (existing.rows.length === 0) {
      return candidate;
    }
    seq = await bumpNext();
  }
}
