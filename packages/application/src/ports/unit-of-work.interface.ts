import type { ExecutionContext } from '../context/execution-context.js';

export interface UnitOfWork {
  execute<T>(ctx: ExecutionContext, work: () => Promise<T>): Promise<T>;
}
