import { Tenant, Store, User, Permissions } from '@retailos/core';
import type { Role } from '@retailos/core';
import type { ExecutionContext } from '../context/execution-context.js';
import type {
  TenantRepository,
  StoreRepository,
  UserRepository,
} from '../ports/identity-repositories.interface.js';
import type { PasswordHasher } from '../ports/password-hasher.interface.js';

export class TenantService {
  constructor(
    private readonly tenantRepo: TenantRepository,
    private readonly storeRepo: StoreRepository,
    private readonly userRepo: UserRepository,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  public async createTenant(params: {
    id: string;
    name: string;
    code: string;
    currency: string;
  }): Promise<Tenant> {
    const existing = await this.tenantRepo.findByCode(params.code.trim().toUpperCase());
    if (existing) {
      throw new Error(`TenantError: Tenant code '${params.code}' is already registered`);
    }

    const tenant = Tenant.create(params);
    await this.tenantRepo.save(tenant);
    return tenant;
  }

  public async createStore(
    ctx: ExecutionContext,
    params: {
      id: string;
      name: string;
      code: string;
      address?: string | undefined;
      phone?: string | undefined;
    },
  ): Promise<Store> {
    ctx.assertPermission(Permissions.STORES_MANAGE);

    const existing = await this.storeRepo.findByCode(ctx, params.code.trim().toUpperCase());
    if (existing) {
      throw new Error(`StoreError: Store code '${params.code}' already exists in this tenant`);
    }

    const store = Store.create({
      id: params.id,
      tenantId: ctx.tenantId, // STRICT: always bound to caller's tenantId
      name: params.name,
      code: params.code,
      address: params.address,
      phone: params.phone,
    });

    await this.storeRepo.save(ctx, store);
    return store;
  }

  public async createUser(
    ctx: ExecutionContext,
    params: {
      id: string;
      username: string;
      passwordPlain: string;
      fullName: string;
      role: Role;
      storeId?: string | undefined;
    },
  ): Promise<User> {
    ctx.assertPermission(Permissions.USERS_MANAGE);

    // If caller has storeId (e.g. Store Manager), they can only create users inside their store
    if (ctx.storeId && params.storeId && ctx.storeId !== params.storeId) {
      throw new Error('UnauthorizedError: Store Manager cannot assign users to other stores');
    }

    // Verify assigned store exists in this tenant if storeId is specified
    if (params.storeId) {
      const store = await this.storeRepo.findById(ctx, params.storeId);
      if (!store) {
        throw new Error('StoreError: Assigned store does not exist in this tenant');
      }
    }

    const existing = await this.userRepo.findByUsername(ctx.tenantId, params.username.toLowerCase());
    if (existing) {
      throw new Error(`UserError: Username '${params.username}' is already taken in this tenant`);
    }

    const passwordHash = await this.passwordHasher.hash(params.passwordPlain);

    const user = User.create({
      id: params.id,
      tenantId: ctx.tenantId, // STRICT: always bound to caller's tenantId
      username: params.username,
      passwordHash,
      fullName: params.fullName,
      role: params.role,
      storeId: params.storeId,
    });

    await this.userRepo.save(ctx, user);
    return user;
  }
}
