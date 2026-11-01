import {
  InvalidStockOperationError,
  Permissions,
} from '@retailos/core';
import type { Money, ProductVariant, StockMovement } from '@retailos/core';
import type { ExecutionContext } from '../context/execution-context.js';
import type { StoreRepository, TenantRepository } from '../ports/identity-repositories.interface.js';
import type {
  InventoryRepository,
  StockMovementRepository,
} from '../ports/inventory-repositories.interface.js';
import type { ProductVariantRepository } from '../ports/catalog-repositories.interface.js';

export interface StockOperationResult {
  movement: StockMovement;
  quantityOnHand: bigint;
  wacCost: Money;
}

export interface SaleOperationResult extends StockOperationResult {
  unitCostSnapshot: Money;
  costOfGoodsSold: Money;
}

export interface TransferOperationResult {
  out: StockMovement;
  in: StockMovement;
}

export class InventoryService {
  constructor(
    private readonly inventoryRepo: InventoryRepository,
    private readonly movementRepo: StockMovementRepository,
    private readonly variantRepo: ProductVariantRepository,
    private readonly storeRepo: StoreRepository,
    private readonly tenantRepo: TenantRepository,
  ) {}

  public async receiveStock(
    ctx: ExecutionContext,
    params: {
      id: string;
      storeId: string;
      variantId: string;
      quantity: bigint;
      unitCost: Money;
      sourceType?: string | undefined;
      sourceId?: string | undefined;
    },
  ): Promise<StockOperationResult> {
    ctx.assertPermission(Permissions.INVENTORY_RECEIVE);
    this.assertStoreAccess(ctx, params.storeId);
    this.assertPositiveQuantity(params.quantity, 'Received quantity');

    const variant = await this.resolveVariant(ctx, params.variantId, true);
    this.assertCurrency(variant, params.unitCost);

    const movement = await this.inventoryRepo.applyMovement(ctx, {
      id: params.id,
      storeId: params.storeId,
      variantId: variant.id,
      currency: variant.retailPrice.currency.code,
      movementType: 'PURCHASE_RECEIPT',
      quantityDelta: params.quantity,
      unitCost: params.unitCost,
      sourceType: params.sourceType ?? 'PURCHASE',
      sourceId: params.sourceId ?? params.id,
      allowNegativeStock: await this.isNegativeStockAllowed(ctx),
    });

    return this.toResult(movement);
  }

  public async recordSale(
    ctx: ExecutionContext,
    params: {
      id: string;
      storeId: string;
      variantId: string;
      quantity: bigint;
      sourceId: string;
    },
  ): Promise<SaleOperationResult> {
    ctx.assertPermission(Permissions.POS_CHECKOUT);
    this.assertStoreAccess(ctx, params.storeId);
    this.assertPositiveQuantity(params.quantity, 'Sold quantity');

    const variant = await this.resolveVariant(ctx, params.variantId, true);

    const movement = await this.inventoryRepo.applyMovement(ctx, {
      id: params.id,
      storeId: params.storeId,
      variantId: variant.id,
      currency: variant.retailPrice.currency.code,
      movementType: 'SALE',
      quantityDelta: -params.quantity,
      sourceType: 'SALE',
      sourceId: params.sourceId,
      allowNegativeStock: await this.isNegativeStockAllowed(ctx),
    });

    return {
      ...this.toResult(movement),
      unitCostSnapshot: movement.unitCost,
      costOfGoodsSold: movement.unitCost.multiply(params.quantity),
    };
  }

  public async recordCustomerReturn(
    ctx: ExecutionContext,
    params: {
      id: string;
      storeId: string;
      variantId: string;
      quantity: bigint;
      sourceId: string;
      unitCost?: Money | undefined;
    },
  ): Promise<StockOperationResult> {
    ctx.assertPermission(Permissions.POS_REFUND);
    this.assertStoreAccess(ctx, params.storeId);
    this.assertPositiveQuantity(params.quantity, 'Returned quantity');

    const variant = await this.resolveVariant(ctx, params.variantId, false);
    const unitCost =
      params.unitCost ??
      (await this.inventoryRepo.getPosition(ctx, params.storeId, variant.id))?.wacCost;

    if (!unitCost) {
      throw new InvalidStockOperationError(
        'Customer return requires a unit cost when the variant has no inventory valuation yet',
      );
    }
    this.assertCurrency(variant, unitCost);

    const movement = await this.inventoryRepo.applyMovement(ctx, {
      id: params.id,
      storeId: params.storeId,
      variantId: variant.id,
      currency: variant.retailPrice.currency.code,
      movementType: 'CUSTOMER_RETURN',
      quantityDelta: params.quantity,
      unitCost,
      sourceType: 'RETURN',
      sourceId: params.sourceId,
      allowNegativeStock: await this.isNegativeStockAllowed(ctx),
    });

    return this.toResult(movement);
  }

  public async recordSupplierReturn(
    ctx: ExecutionContext,
    params: {
      id: string;
      storeId: string;
      variantId: string;
      quantity: bigint;
      sourceId: string;
    },
  ): Promise<StockOperationResult> {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    return this.issueAtCurrentCost(ctx, {
      ...params,
      movementType: 'SUPPLIER_RETURN',
      sourceType: 'RETURN',
    });
  }

  public async recordDamage(
    ctx: ExecutionContext,
    params: {
      id: string;
      storeId: string;
      variantId: string;
      quantity: bigint;
      sourceId: string;
    },
  ): Promise<StockOperationResult> {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    return this.issueAtCurrentCost(ctx, {
      ...params,
      movementType: 'DAMAGE_WRITE_OFF',
      sourceType: 'DAMAGE',
    });
  }

  public async adjustStock(
    ctx: ExecutionContext,
    params: {
      id: string;
      storeId: string;
      variantId: string;
      targetQuantity: bigint;
      unitCost?: Money | undefined;
      reason?: string | undefined;
    },
  ): Promise<StockOperationResult> {
    ctx.assertPermission(Permissions.INVENTORY_ADJUST);
    this.assertStoreAccess(ctx, params.storeId);

    if (params.targetQuantity < 0n) {
      throw new InvalidStockOperationError('Target quantity cannot be negative');
    }

    const variant = await this.resolveVariant(ctx, params.variantId, false);
    const position = await this.inventoryRepo.getPosition(ctx, params.storeId, variant.id);
    const currentQuantity = position?.quantityOnHand ?? 0n;
    const delta = params.targetQuantity - currentQuantity;

    if (delta === 0n) {
      throw new InvalidStockOperationError('Adjustment would not change the quantity on hand');
    }

    if (delta > 0n) {
      if (!params.unitCost) {
        throw new InvalidStockOperationError('Positive adjustments require a unit cost');
      }
      this.assertCurrency(variant, params.unitCost);
    }

    const movement = await this.inventoryRepo.applyMovement(ctx, {
      id: params.id,
      storeId: params.storeId,
      variantId: variant.id,
      currency: variant.retailPrice.currency.code,
      movementType: 'INVENTORY_ADJUSTMENT',
      quantityDelta: delta,
      unitCost: params.unitCost,
      sourceType: 'ADJUSTMENT',
      sourceId: params.reason?.trim() || params.id,
    });

    return this.toResult(movement);
  }

  public async transferStock(
    ctx: ExecutionContext,
    params: {
      id: string;
      fromStoreId: string;
      toStoreId: string;
      variantId: string;
      quantity: bigint;
    },
  ): Promise<TransferOperationResult> {
    ctx.assertPermission(Permissions.INVENTORY_TRANSFER);
    this.assertStoreAccess(ctx, params.fromStoreId);
    this.assertPositiveQuantity(params.quantity, 'Transferred quantity');
    if (params.fromStoreId === params.toStoreId) {
      throw new InvalidStockOperationError('Source and destination stores must differ');
    }

    const destination = await this.storeRepo.findById(ctx, params.toStoreId);
    if (!destination) {
      throw new InvalidStockOperationError(
        `Destination store '${params.toStoreId}' does not exist in this tenant`,
      );
    }

    const variant = await this.resolveVariant(ctx, params.variantId, false);

    return this.inventoryRepo.transfer(ctx, {
      outMovementId: `${params.id}:out`,
      inMovementId: `${params.id}:in`,
      fromStoreId: params.fromStoreId,
      toStoreId: params.toStoreId,
      variantId: variant.id,
      quantity: params.quantity,
      currency: variant.retailPrice.currency.code,
      sourceType: 'TRANSFER',
      sourceId: params.id,
    });
  }

  public async getPosition(
    ctx: ExecutionContext,
    storeId: string,
    variantId: string,
  ) {
    ctx.assertPermission(Permissions.INVENTORY_VIEW);
    this.assertStoreAccess(ctx, storeId);
    return this.inventoryRepo.getPosition(ctx, storeId, variantId);
  }

  public async listByStore(ctx: ExecutionContext, storeId: string) {
    ctx.assertPermission(Permissions.INVENTORY_VIEW);
    this.assertStoreAccess(ctx, storeId);
    return this.inventoryRepo.listByStore(ctx, storeId);
  }

  public async listMovements(
    ctx: ExecutionContext,
    storeId: string,
    variantId: string,
    limit = 100,
  ): Promise<StockMovement[]> {
    ctx.assertPermission(Permissions.INVENTORY_VIEW);
    this.assertStoreAccess(ctx, storeId);
    return this.movementRepo.listByVariant(ctx, storeId, variantId, limit);
  }

  private async issueAtCurrentCost(
    ctx: ExecutionContext,
    params: {
      id: string;
      storeId: string;
      variantId: string;
      quantity: bigint;
      sourceId: string;
      movementType: 'SUPPLIER_RETURN' | 'DAMAGE_WRITE_OFF';
      sourceType: string;
    },
  ): Promise<StockOperationResult> {
    this.assertStoreAccess(ctx, params.storeId);
    this.assertPositiveQuantity(params.quantity, 'Issued quantity');

    const variant = await this.resolveVariant(ctx, params.variantId, false);

    const movement = await this.inventoryRepo.applyMovement(ctx, {
      id: params.id,
      storeId: params.storeId,
      variantId: variant.id,
      currency: variant.retailPrice.currency.code,
      movementType: params.movementType,
      quantityDelta: -params.quantity,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      allowNegativeStock: await this.isNegativeStockAllowed(ctx),
    });

    return this.toResult(movement);
  }

  private async resolveVariant(
    ctx: ExecutionContext,
    variantId: string,
    requireActive: boolean,
  ): Promise<ProductVariant> {
    const variant = await this.variantRepo.findById(ctx, variantId);
    if (!variant) {
      throw new InvalidStockOperationError(`Variant '${variantId}' was not found in this tenant`);
    }
    if (requireActive && !variant.isActive) {
      throw new InvalidStockOperationError(`Variant '${variantId}' is inactive`);
    }
    return variant;
  }

  private assertStoreAccess(ctx: ExecutionContext, storeId: string): void {
    if (ctx.storeId !== undefined && ctx.storeId !== storeId) {
      throw new Error(
        `UnauthorizedError: User ${ctx.userId} cannot operate on store '${storeId}'`,
      );
    }
  }

  private assertPositiveQuantity(quantity: bigint, label: string): void {
    if (quantity <= 0n) {
      throw new InvalidStockOperationError(`${label} must be strictly positive`);
    }
  }

  private assertCurrency(variant: ProductVariant, amount: Money): void {
    if (amount.currency.code !== variant.retailPrice.currency.code) {
      throw new InvalidStockOperationError(
        `Amount currency ${amount.currency.code} does not match variant currency ${variant.retailPrice.currency.code}`,
      );
    }
  }

  private async isNegativeStockAllowed(ctx: ExecutionContext): Promise<boolean> {
    const tenant = await this.tenantRepo.findById(ctx.tenantId);
    return tenant?.allowNegativeStock ?? false;
  }

  private toResult(movement: StockMovement): StockOperationResult {
    return {
      movement,
      quantityOnHand: movement.resultingQuantity,
      wacCost: movement.resultingWac,
    };
  }
}
