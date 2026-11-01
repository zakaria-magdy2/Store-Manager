import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  InventoryPosition,
  InvalidStockOperationError,
  Money,
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
import { toBigInt } from '../values.js';

type Executor = Kysely<RetailOSDatabase>;

type InventoryRow = {
  id: string;
  tenant_id: string;
  store_id: string;
  variant_id: string;
  quantity_on_hand: bigint;
  wac_cost: bigint;
  currency: string;
  updated_at: string;
};

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
    return this.db.transaction().execute((trx) => this.applyMovementWithin(trx, ctx, command));
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

      const sourceRow = await this.findRow(trx, ctx, command.fromStoreId, command.variantId);
      if (!sourceRow) {
        throw new InvalidStockOperationError(
          `No inventory exists for variant '${command.variantId}' in the source store`,
        );
      }
      this.assertRowCurrency(sourceRow, command.currency);

      const source = this.toPosition(sourceRow);
      const sourceAfter = source.issue(command.quantity, false);
      const transferredCost = source.wacCost;

      const destinationRow = await this.findRow(trx, ctx, command.toStoreId, command.variantId);
      const destination = destinationRow
        ? this.toPosition(destinationRow)
        : InventoryPosition.empty(command.variantId, command.currency);
      this.assertPositionCurrency(destination, command.currency);

      const destinationAfter = destination.receive(command.quantity, transferredCost);
      const now = new Date();

      await this.persistPosition(trx, ctx, command.fromStoreId, sourceRow, sourceAfter, now);
      await this.persistPosition(
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

      await this.insertMovement(trx, outMovement);
      await this.insertMovement(trx, inMovement);

      return { out: outMovement, in: inMovement };
    });
  }

  private async applyMovementWithin(
    trx: Executor,
    ctx: ExecutionContext,
    command: ApplyStockMovementCommand,
  ): Promise<StockMovement> {
    if (command.quantityDelta === 0n) {
      throw new InvalidStockOperationError('Stock movement quantity delta cannot be zero');
    }

    const existingRow = await this.findRow(trx, ctx, command.storeId, command.variantId);
    const current = existingRow
      ? this.toPosition(existingRow)
      : InventoryPosition.empty(command.variantId, command.currency);
    this.assertPositionCurrency(current, command.currency);

    let next: InventoryPosition;
    let unitCost: Money;

    if (command.quantityDelta > 0n) {
      if (!command.unitCost) {
        throw new InvalidStockOperationError('Incoming stock movements require a unit cost');
      }
      if (command.unitCost.currency.code !== command.currency) {
        throw new InvalidStockOperationError(
          `Unit cost currency ${command.unitCost.currency.code} does not match inventory currency ${command.currency}`,
        );
      }
      next = current.receive(command.quantityDelta, command.unitCost);
      unitCost = command.unitCost;
    } else {
      next = current.issue(-command.quantityDelta, command.allowNegativeStock ?? false);
      unitCost = current.wacCost;
    }

    const now = new Date();
    await this.persistPosition(trx, ctx, command.storeId, existingRow, next, now);

    const movement = StockMovement.create({
      id: command.id,
      tenantId: ctx.tenantId,
      storeId: command.storeId,
      variantId: command.variantId,
      movementType: command.movementType,
      quantityDelta: command.quantityDelta,
      unitCost,
      resultingQuantity: next.quantityOnHand,
      resultingWac: next.wacCost,
      sourceType: command.sourceType,
      sourceId: command.sourceId,
      createdByUserId: ctx.userId,
      createdAt: now,
    });

    await this.insertMovement(trx, movement);
    return movement;
  }

  private async findRow(
    db: Executor,
    ctx: ExecutionContext,
    storeId: string,
    variantId: string,
  ): Promise<InventoryRow | undefined> {
    return db
      .selectFrom('inventory_items')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('store_id', '=', storeId)
      .where('variant_id', '=', variantId)
      .executeTakeFirst();
  }

  private async persistPosition(
    db: Executor,
    ctx: ExecutionContext,
    storeId: string,
    existingRow: InventoryRow | undefined,
    position: InventoryPosition,
    now: Date,
  ): Promise<void> {
    if (existingRow) {
      await db
        .updateTable('inventory_items')
        .set({
          quantity_on_hand: position.quantityOnHand,
          wac_cost: position.wacCost.amount,
          updated_at: now.toISOString(),
        })
        .where('id', '=', existingRow.id)
        .where('tenant_id', '=', ctx.tenantId)
        .execute();
      return;
    }

    await db
      .insertInto('inventory_items')
      .values({
        id: `inv_${randomUUID()}`,
        tenant_id: ctx.tenantId,
        store_id: storeId,
        variant_id: position.variantId,
        quantity_on_hand: position.quantityOnHand,
        wac_cost: position.wacCost.amount,
        currency: position.wacCost.currency.code,
        updated_at: now.toISOString(),
      })
      .execute();
  }

  private async insertMovement(db: Executor, movement: StockMovement): Promise<void> {
    await db
      .insertInto('stock_movements')
      .values({
        id: movement.id,
        tenant_id: movement.tenantId,
        store_id: movement.storeId,
        variant_id: movement.variantId,
        movement_type: movement.movementType,
        quantity_delta: movement.quantityDelta,
        unit_cost: movement.unitCost.amount,
        currency: movement.unitCost.currency.code,
        resulting_quantity: movement.resultingQuantity,
        resulting_wac: movement.resultingWac.amount,
        source_type: movement.sourceType,
        source_id: movement.sourceId,
        created_by_user_id: movement.createdByUserId,
        created_at: movement.createdAt.toISOString(),
      })
      .execute();
  }

  private toPosition(row: InventoryRow): InventoryPosition {
    return InventoryPosition.create({
      variantId: row.variant_id,
      quantityOnHand: toBigInt(row.quantity_on_hand),
      wacCost: Money.fromMinor(toBigInt(row.wac_cost), row.currency),
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

  private assertRowCurrency(row: InventoryRow, currency: string): void {
    if (row.currency !== currency) {
      throw new InvalidStockOperationError(
        `Inventory currency ${row.currency} does not match requested currency ${currency}`,
      );
    }
  }

  private assertPositionCurrency(position: InventoryPosition, currency: string): void {
    if (position.wacCost.currency.code !== currency) {
      throw new InvalidStockOperationError(
        `Inventory currency ${position.wacCost.currency.code} does not match requested currency ${currency}`,
      );
    }
  }
}
