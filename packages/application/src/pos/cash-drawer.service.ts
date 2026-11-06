import { InvalidSaleError, Permissions } from '@retailos/core';
import type { ExecutionContext } from '../context/execution-context.js';
import type { StoreRepository } from '../ports/identity-repositories.interface.js';
import type { CashDrawerPort } from '../ports/hardware-ports.interface.js';

export class CashDrawerService {
  constructor(
    private readonly drawer: CashDrawerPort,
    private readonly storeRepo: StoreRepository,
  ) {}

  public async open(ctx: ExecutionContext, storeId: string): Promise<void> {
    ctx.assertPermission(Permissions.POS_DRAWER_OPEN);
    if (ctx.storeId !== undefined && ctx.storeId !== storeId) {
      throw new Error(`UnauthorizedError: User ${ctx.userId} cannot open another store's drawer`);
    }
    const store = await this.storeRepo.findById(ctx, storeId);
    if (!store) {
      throw new InvalidSaleError(`Store '${storeId}' does not exist in this tenant`);
    }
    await this.drawer.openDrawer(ctx, storeId);
  }
}
