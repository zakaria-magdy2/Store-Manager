import type { Tenant, Store, User } from '@retailos/core';
import type { ExecutionContext } from '../context/execution-context.js';

export interface ActiveSessionRecord {
  id: string;
  tenantId: string;
  storeId?: string | undefined;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  isRevoked: boolean;
  createdAt: Date;
}

export interface TenantRepository {
  findById(id: string): Promise<Tenant | null>;
  findByCode(code: string): Promise<Tenant | null>;
  save(tenant: Tenant): Promise<void>;
  listAll(): Promise<Tenant[]>;
}

export interface StoreRepository {
  findById(ctx: ExecutionContext, id: string): Promise<Store | null>;
  findByCode(ctx: ExecutionContext, code: string): Promise<Store | null>;
  listByTenant(ctx: ExecutionContext): Promise<Store[]>;
  save(ctx: ExecutionContext, store: Store): Promise<void>;
}

export interface UserRepository {
  findById(ctx: ExecutionContext, id: string): Promise<User | null>;
  findByUsername(tenantId: string, username: string): Promise<User | null>;
  listByTenant(ctx: ExecutionContext): Promise<User[]>;
  save(ctx: ExecutionContext, user: User): Promise<void>;
}

export interface SessionRepository {
  createSession(session: {
    id: string;
    tenantId: string;
    storeId?: string | undefined;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;

  findSessionByTokenHash(tokenHash: string): Promise<ActiveSessionRecord | null>;
  revokeSession(tokenHash: string): Promise<void>;
  revokeAllUserSessions(tenantId: string, userId: string): Promise<void>;
}
