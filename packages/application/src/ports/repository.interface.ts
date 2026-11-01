import type { ExecutionContext } from '../context/execution-context.js';

export interface BaseRepository<TEntity, TId = string> {
  findById(ctx: ExecutionContext, id: TId): Promise<TEntity | null>;
  save(ctx: ExecutionContext, entity: TEntity): Promise<void>;
  delete(ctx: ExecutionContext, id: TId): Promise<void>;
}
