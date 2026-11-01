import type { MoneyDTO } from './money.dto.js';

export type StockMovementTypeDTO =
  | 'PURCHASE_RECEIPT'
  | 'SALE'
  | 'CUSTOMER_RETURN'
  | 'SUPPLIER_RETURN'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'INVENTORY_ADJUSTMENT'
  | 'DAMAGE_WRITE_OFF';

export interface InventoryPositionDTO {
  id: string;
  tenantId: string;
  storeId: string;
  variantId: string;
  quantityOnHand: string; // BigInt string
  wacCost: MoneyDTO;
  updatedAt: string;
}

export interface StockMovementDTO {
  id: string;
  tenantId: string;
  storeId: string;
  variantId: string;
  movementType: StockMovementTypeDTO;
  quantityDelta: string; // Signed BigInt string
  unitCost: MoneyDTO;
  resultingQuantity: string; // BigInt string
  resultingWac: MoneyDTO;
  sourceType: string;
  sourceId: string;
  createdByUserId: string;
  createdAt: string;
}

export interface StockOperationResultDTO {
  movement: StockMovementDTO;
  quantityOnHand: string;
  wacCost: MoneyDTO;
}

export interface InventoryTransferResultDTO {
  out: StockMovementDTO;
  in: StockMovementDTO;
}
