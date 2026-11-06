import type { ExecutionContext } from '../context/execution-context.js';

export interface CashDrawerPort {
  openDrawer(ctx: ExecutionContext, storeId: string): Promise<void>;
}
