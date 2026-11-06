import type { Kysely } from 'kysely';
import {
  InventoryPosition,
  InvalidStockOperationError,
  StockMovement,
} from '@retailos/core';
import type {
  ApplyStockMovementCommand,
  ExecutionContext,
  InventoryPositionRecord,
  InventoryRepository,
  TransferStockCommand,
} from '@retailos/application';
import type { RetailOSDatabase } from '../types.js';
import { Money } from '@retailos/core';
import { toBigInt } from '../values.js';
import {
  applyStockMovementInTransaction,
  assertPositionCurrency,
  findInventoryRow,
  insertStockMovement,
  persistInventoryPosition,
  toInventoryPosition,
  type InventoryRow,
} from './stock-movement.executor.js';

export class SqliteInventoryRepository implements InventoryRepository {
  constructor(private readonly db: Kysely<RetailOSDatabase>) {}

  public async getPosition(
    ctx: ExecutionContext,
    storeId: string,
    variantId: string,
  ): Promise<InventoryPositionRecord | null> {
    const row = await this.db
      .selectFrom('inventory_items')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('store_id', '=', storeId)
      .where('variant_id', '=', variantId)
      .executeTakeFirst();

    return row ? this.toPositionRecord(row) : null;
  }

  public async listByStore(
    ctx: ExecutionContext,
    storeId: string,
  ): Promise<InventoryPositionRecord[]> {
    const rows = await this.db
      .selectFrom('inventory_items')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('store_id', '=', storeId)
      .orderBy('updated_at', 'desc')
      .execute();

    return rows.map((row) => this.toPositionRecord(row));
  }

  public async applyMovement(
    ctx: ExecutionContext,
    command: ApplyStockMovementCommand,
  ): Promise<StockMovement> {
    return this.db
      .transaction()
      .execute((trx) => applyStockMovementInTransaction(trx, ctx, command));
  }

  public async transfer(
    ctx: ExecutionContext,
    command: TransferStockCommand,
  ): Promise<{ out: StockMovement; in: StockMovement }> {
    return this.db.transaction().execute(async (trx) => {
      if (command.fromStoreId === command.toStoreId) {
        throw new InvalidStockOperationError('Source and destination stores must differ');
      }
      if (command.quantity <= 0n) {
        throw new InvalidStockOperationError('Transferred quantity must be strictly positive');
      }

      const sourceRow = await findInventoryRow(
        trx,
        ctx,
        command.fromStoreId,
        command.variantId,
      );
      if (!sourceRow) {
        throw new InvalidStockOperationError(
          `No inventory exists for variant '${command.variantId}' in the source store`,
        );
      }
      if (sourceRow.currency !== command.currency) {
        throw new InvalidStockOperationError(
          `Inventory currency ${sourceRow.currency} does not match requested currency ${command.currency}`,
        );
      }

      const source = toInventoryPosition(sourceRow);
      const sourceAfter = source.issue(command.quantity, false);
      const transferredCost = source.wacCost;

      const destinationRow = await findInventoryRow(
        trx,
        ctx,
        command.toStoreId,
        command.variantId,
      );
      const destination = destinationRow
        ? toInventoryPosition(destinationRow)
        : InventoryPosition.empty(command.variantId, command.currency);
      assertPositionCurrency(destination, command.currency);

      const destinationAfter = destination.receive(command.quantity, transferredCost);
      const now = new Date();

      await persistInventoryPosition(
        trx,
        ctx,
        command.fromStoreId,
        sourceRow,
        sourceAfter,
        now,
      );
      await persistInventoryPosition(
        trx,
        ctx,
        command.toStoreId,
        destinationRow,
        destinationAfter,
        now,
      );

      const outMovement = StockMovement.create({
        id: command.outMovementId,
        tenantId: ctx.tenantId,
        storeId: command.fromStoreId,
        variantId: command.variantId,
        movementType: 'TRANSFER_OUT',
        quantityDelta: -command.quantity,
        unitCost: transferredCost,
        resultingQuantity: sourceAfter.quantityOnHand,
        resultingWac: sourceAfter.wacCost,
        sourceType: command.sourceType,
        sourceId: command.sourceId,
        createdByUserId: ctx.userId,
        createdAt: now,
      });

      const inMovement = StockMovement.create({
        id: command.inMovementId,
        tenantId: ctx.tenantId,
        storeId: command.toStoreId,
        variantId: command.variantId,
        movementType: 'TRANSFER_IN',
        quantityDelta: command.quantity,
        unitCost: transferredCost,
        resultingQuantity: destinationAfter.quantityOnHand,
        resultingWac: destinationAfter.wacCost,
        sourceType: command.sourceType,
        sourceId: command.sourceId,
        createdByUserId: ctx.userId,
        createdAt: now,
      });

      await insertStockMovement(trx, outMovement);
      await insertStockMovement(trx, inMovement);

      return { out: outMovement, in: inMovement };
    });
  }

  private toPositionRecord(row: InventoryRow): InventoryPositionRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      variantId: row.variant_id,
      quantityOnHand: toBigInt(row.quantity_on_hand),
      wacCost: Money.fromMinor(toBigInt(row.wac_cost), row.currency),
      updatedAt: new Date(row.updated_at),
    };
  }
}
