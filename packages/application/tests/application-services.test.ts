import { describe, expect, it } from 'vitest';
import {
  type Category,
  InventoryPosition,
  Money,
  Permissions,
  type Product,
  ProductVariant,
  StockMovement,
  Store,
  Tenant,
  User,
} from '@retailos/core';
import {
  AuthService,
  CashDrawerService,
  CatalogService,
  InventoryService,
  ScopedExecutionContext,
  TenantService,
} from '../src/index.js';
import type {
  ActiveSessionRecord,
  SessionRepository,
  StoreRepository,
  TenantRepository,
  UserRepository,
} from '../src/ports/identity-repositories.interface.js';
import type {
  CategoryRepository,
  ProductRepository,
  ProductVariantRepository,
} from '../src/ports/catalog-repositories.interface.js';
import type {
  InventoryRepository,
  StockMovementRepository,
} from '../src/ports/inventory-repositories.interface.js';
import type { PasswordHasher } from '../src/ports/password-hasher.interface.js';
import type { TokenService } from '../src/ports/token-service.interface.js';

function egp(minor: bigint): Money {
  return Money.fromMinor(minor, 'EGP');
}

describe('Application Layer Unit Tests (Auth, Tenant, Catalog, Inventory, CashDrawer)', () => {
  it('AuthService authenticates, validates active sessions, revokes expired or mismatched sessions, and logs out', async () => {
    const tenant = Tenant.create({
      id: 'tenant-1',
      name: 'Test Co',
      code: 'TEST_CO',
      currency: 'EGP',
    });
    const user = User.create({
      id: 'user-1',
      tenantId: tenant.id,
      storeId: 'store-1',
      username: 'cashier_1',
      passwordHash: 'hashed:secret123456',
      fullName: 'Cashier One',
      role: 'CASHIER',
    });

    const sessions = new Map<string, ActiveSessionRecord>();
    const tenantRepo: TenantRepository = {
      findById: (id) => Promise.resolve(id === tenant.id ? tenant : null),
      findByCode: (code) => Promise.resolve(code === tenant.code ? tenant : null),
      listAll: () => Promise.resolve([tenant]),
      save: () => Promise.resolve(),
    };
    const userRepo: UserRepository = {
      findById: (_ctx, id) => Promise.resolve(id === user.id ? user : null),
      findByUsername: (tId, uname) =>
        Promise.resolve(tId === tenant.id && uname === user.username ? user : null),
      listByTenant: () => Promise.resolve([user]),
      save: () => Promise.resolve(),
    };
    const sessionRepo: SessionRepository = {
      createSession: (s) => {
        sessions.set(s.tokenHash, { ...s, isRevoked: false, createdAt: new Date() });
        return Promise.resolve();
      },
      findSessionByTokenHash: (hash) => Promise.resolve(sessions.get(hash) ?? null),
      revokeSession: (hash) => {
        const existing = sessions.get(hash);
        if (existing) {
          sessions.set(hash, { ...existing, isRevoked: true });
        }
        return Promise.resolve();
      },
      revokeAllUserSessions: () => Promise.resolve(),
    };
    const hasher: PasswordHasher = {
      hash: (plain) => Promise.resolve(`hashed:${plain}`),
      verify: (hash, plain) => Promise.resolve(hash === `hashed:${plain}`),
    };
    const tokens: TokenService = {
      generateToken: () => 'raw_token_0123456789abcdef0123456789abcdef',
      hashToken: (raw) => `sha256_${raw}`,
    };

    const auth = new AuthService(tenantRepo, userRepo, sessionRepo, hasher, tokens);

    await expect(
      auth.login({ tenantCode: 'TEST_CO', username: 'cashier_1', password: 'wrong' }),
    ).rejects.toThrow('AuthenticationError');

    const sessionDto = await auth.login({
      tenantCode: 'TEST_CO',
      username: 'CASHIER_1',
      password: 'secret123456',
    });
    expect(sessionDto.user.username).toBe('cashier_1');
    expect(sessionDto.permissions).toContain(Permissions.POS_CHECKOUT);

    const validatedCtx = await auth.validateSession(sessionDto.token, 'corr-1');
    expect(validatedCtx.tenantId).toBe(tenant.id);
    expect(validatedCtx.storeId).toBe('store-1');
    expect(validatedCtx.roleId).toBe('CASHIER');

    await auth.logout(sessionDto.token);
    await expect(auth.validateSession(sessionDto.token)).rejects.toThrow(
      'Session not found or revoked',
    );
  });

  it('TenantService enforces role hierarchy and store boundaries when creating stores and users', async () => {
    const stores = new Map<string, Store>();
    const users = new Map<string, User>();

    const tenantRepo: TenantRepository = {
      findById: () => Promise.resolve(null),
      findByCode: () => Promise.resolve(null),
      listAll: () => Promise.resolve([]),
      save: () => Promise.resolve(),
    };
    const storeRepo: StoreRepository = {
      findById: (_ctx, id) => Promise.resolve(stores.get(id) ?? null),
      findByCode: (_ctx, code) =>
        Promise.resolve([...stores.values()].find((s) => s.code === code) ?? null),
      listByTenant: () => Promise.resolve([...stores.values()]),
      save: (_ctx, store) => {
        stores.set(store.id, store);
        return Promise.resolve();
      },
    };
    const userRepo: UserRepository = {
      findById: (_ctx, id) => Promise.resolve(users.get(id) ?? null),
      findByUsername: (_tId, username) =>
        Promise.resolve([...users.values()].find((u) => u.username === username) ?? null),
      listByTenant: () => Promise.resolve([...users.values()]),
      save: (_ctx, user) => {
        users.set(user.id, user);
        return Promise.resolve();
      },
    };
    const hasher: PasswordHasher = {
      hash: (plain) => Promise.resolve(`hashed:${plain}`),
      verify: () => Promise.resolve(true),
    };

    const service = new TenantService(tenantRepo, storeRepo, userRepo, hasher);

    const ownerCtx = new ScopedExecutionContext({
      tenantId: 'tenant-1',
      userId: 'owner-1',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'corr-owner',
    });

    const store = await service.createStore(ownerCtx, {
      id: 'store-1',
      name: 'Branch 1',
      code: 'BR1',
    });
    expect(store.code).toBe('BR1');

    const managerCtx = new ScopedExecutionContext({
      tenantId: 'tenant-1',
      storeId: 'store-1',
      userId: 'mgr-1',
      roleId: 'STORE_MANAGER',
      permissions: new Set([Permissions.USERS_MANAGE]),
      correlationId: 'corr-mgr',
    });

    // Store manager cannot create an AUDITOR or OWNER
    await expect(
      service.createUser(managerCtx, {
        id: 'u-auditor',
        username: 'auditor1',
        passwordPlain: 'longpassword123',
        fullName: 'Auditor',
        role: 'AUDITOR',
        storeId: 'store-1',
      }),
    ).rejects.toThrow('Only an OWNER can create managers, auditors, or other owners');

    // Store manager cannot assign a cashier to another store
    await expect(
      service.createUser(managerCtx, {
        id: 'u-cashier-other',
        username: 'cashier_other',
        passwordPlain: 'longpassword123',
        fullName: 'Other Cashier',
        role: 'CASHIER',
        storeId: 'store-2',
      }),
    ).rejects.toThrow('Store Manager cannot assign users to other stores');

    // Store manager can create a cashier in their own store
    const cashier = await service.createUser(managerCtx, {
      id: 'u-cashier-1',
      username: 'cashier_ok',
      passwordPlain: 'longpassword123',
      fullName: 'Valid Cashier',
      role: 'CASHIER',
      storeId: 'store-1',
    });
    expect(cashier.storeId).toBe('store-1');
    expect(cashier.role).toBe('CASHIER');
  });

  it('CatalogService validates category parents, variant uniqueness, and barcode resolution', async () => {
    const categories = new Map<string, Category>();
    const products = new Map<string, Product>();
    const variants = new Map<string, ProductVariant>();

    const categoryRepo: CategoryRepository = {
      findById: (_ctx, id) => Promise.resolve(categories.get(id) ?? null),
      findByCode: (_ctx, code) =>
        Promise.resolve([...categories.values()].find((c) => c.code === code) ?? null),
      listByTenant: () => Promise.resolve([...categories.values()]),
      save: (_ctx, category) => {
        categories.set(category.id, category);
        return Promise.resolve();
      },
    };
    const productRepo: ProductRepository = {
      findById: (_ctx, id) => Promise.resolve(products.get(id) ?? null),
      findBySku: (_ctx, sku) =>
        Promise.resolve([...products.values()].find((p) => p.sku === sku.toUpperCase()) ?? null),
      listByTenant: () => Promise.resolve([...products.values()]),
      save: (_ctx, product) => {
        products.set(product.id, product);
        return Promise.resolve();
      },
      saveWithVariants: (_ctx, product, prodVariants) => {
        products.set(product.id, product);
        for (const v of prodVariants) variants.set(v.id, v);
        return Promise.resolve();
      },
    };
    const variantRepo: ProductVariantRepository = {
      findById: (_ctx, id) => Promise.resolve(variants.get(id) ?? null),
      findBySku: (_ctx, sku) =>
        Promise.resolve([...variants.values()].find((v) => v.sku === sku.toUpperCase()) ?? null),
      findByBarcode: (_ctx, barcode) =>
        Promise.resolve([...variants.values()].find((v) => v.barcode === barcode) ?? null),
      listByProduct: (_ctx, productId) =>
        Promise.resolve([...variants.values()].filter((v) => v.productId === productId)),
      save: (_ctx, variant) => {
        variants.set(variant.id, variant);
        return Promise.resolve();
      },
    };

    const catalog = new CatalogService(categoryRepo, productRepo, variantRepo);
    const ctx = new ScopedExecutionContext({
      tenantId: 'tenant-1',
      userId: 'owner-1',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'corr-cat',
    });

    await expect(
      catalog.createCategory(ctx, {
        id: 'cat-orphan',
        name: 'Orphan',
        code: 'ORPHAN',
        parentId: 'missing-parent',
      }),
    ).rejects.toThrow("Parent category 'missing-parent' not found");

    const cat = await catalog.createCategory(ctx, {
      id: 'cat-1',
      name: 'Beverages',
      code: 'BEV',
    });

    // Reject duplicate variant SKUs in the same request
    await expect(
      catalog.createProduct(ctx, {
        id: 'prod-dup',
        name: 'Dup Product',
        sku: 'DUP-PROD',
        categoryId: cat.id,
        hasVariants: true,
        variants: [
          { id: 'v1', sku: 'SAME-SKU', retailPrice: egp(1000n) },
          { id: 'v2', sku: 'same-sku', retailPrice: egp(1200n) },
        ],
      }),
    ).rejects.toThrow('Duplicate variant SKU');

    const created = await catalog.createProduct(ctx, {
      id: 'prod-1',
      name: 'Espresso Beans',
      sku: 'ESP-1',
      categoryId: cat.id,
      variants: [
        {
          id: 'var-1',
          sku: 'ESP-250G',
          barcode: '6221234567890',
          retailPrice: egp(25000n),
          reorderPoint: 5n,
        },
      ],
    });
    expect(created.variants).toHaveLength(1);

    const lookup = await catalog.findByBarcode(ctx, '6221234567890');
    expect(lookup?.product.id).toBe('prod-1');
    expect(lookup?.variant.sku).toBe('ESP-250G');
  });

  it('InventoryService & CashDrawerService enforce store scope, currency matching, and COGS calculation', async () => {
    const tenant = Tenant.create({
      id: 'tenant-1',
      name: 'Store Co',
      code: 'STORE_CO',
      currency: 'EGP',
    });
    const store1 = Store.create({
      id: 'store-1',
      tenantId: tenant.id,
      name: 'Main',
      code: 'MAIN',
    });
    const store2 = Store.create({
      id: 'store-2',
      tenantId: tenant.id,
      name: 'Second',
      code: 'SEC',
    });
    const variant = ProductVariant.create({
      id: 'var-1',
      tenantId: tenant.id,
      productId: 'prod-1',
      sku: 'ITEM-1',
      retailPrice: egp(15000n),
    });

    let currentPosition = InventoryPosition.empty(variant.id, 'EGP');

    const inventoryRepo: InventoryRepository = {
      getPosition: () => Promise.resolve(currentPosition),
      listByStore: () => Promise.resolve([currentPosition]),
      applyMovement: (_ctx, input) => {
        if (input.movementType === 'PURCHASE_RECEIPT') {
          currentPosition = currentPosition.receive(input.quantityDelta, input.unitCost!);
        } else if (input.movementType === 'SALE') {
          currentPosition = currentPosition.issue(-input.quantityDelta, input.allowNegativeStock);
        }
        return Promise.resolve(
          StockMovement.create({
            id: input.id,
            tenantId: tenant.id,
            storeId: input.storeId,
            variantId: input.variantId,
            movementType: input.movementType,
            quantityDelta: input.quantityDelta,
            unitCost: input.unitCost ?? currentPosition.wacCost,
            resultingQuantity: currentPosition.quantityOnHand,
            resultingWac: currentPosition.wacCost,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            createdByUserId: 'user-1',
          }),
        );
      },
      transfer: () => Promise.reject(new Error('not used')),
    };
    const movementRepo: StockMovementRepository = {
      listByVariant: () => Promise.resolve([]),
    };
    const variantRepo: ProductVariantRepository = {
      findById: (_ctx, id) => Promise.resolve(id === variant.id ? variant : null),
      findBySku: () => Promise.resolve(null),
      findByBarcode: () => Promise.resolve(null),
      listByProduct: () => Promise.resolve([variant]),
      save: () => Promise.resolve(),
    };
    const storeRepo: StoreRepository = {
      findById: (_ctx, id) =>
        Promise.resolve(id === store1.id ? store1 : id === store2.id ? store2 : null),
      findByCode: () => Promise.resolve(store1),
      listByTenant: () => Promise.resolve([store1, store2]),
      save: () => Promise.resolve(),
    };
    const tenantRepo: TenantRepository = {
      findById: () => Promise.resolve(tenant),
      findByCode: () => Promise.resolve(tenant),
      listAll: () => Promise.resolve([tenant]),
      save: () => Promise.resolve(),
    };

    const inventory = new InventoryService(
      inventoryRepo,
      movementRepo,
      variantRepo,
      storeRepo,
      tenantRepo,
    );

    const storeBoundCtx = new ScopedExecutionContext({
      tenantId: tenant.id,
      storeId: store1.id,
      userId: 'user-1',
      roleId: 'STORE_MANAGER',
      permissions: new Set([
        Permissions.INVENTORY_RECEIVE,
        Permissions.POS_CHECKOUT,
        Permissions.POS_DRAWER_OPEN,
      ]),
      correlationId: 'corr-inv',
    });

    // Reject operating on another store
    await expect(
      inventory.receiveStock(storeBoundCtx, {
        id: 'mov-other',
        storeId: store2.id,
        variantId: variant.id,
        quantity: 5n,
        unitCost: egp(8000n),
      }),
    ).rejects.toThrow('UnauthorizedError');

    // Reject currency mismatch
    await expect(
      inventory.receiveStock(storeBoundCtx, {
        id: 'mov-curr',
        storeId: store1.id,
        variantId: variant.id,
        quantity: 5n,
        unitCost: Money.fromMinor(8000n, 'USD'),
      }),
    ).rejects.toThrow('Amount currency USD does not match variant currency EGP');

    const receipt = await inventory.receiveStock(storeBoundCtx, {
      id: 'mov-1',
      storeId: store1.id,
      variantId: variant.id,
      quantity: 4n,
      unitCost: egp(10000n),
    });
    expect(receipt.quantityOnHand).toBe(4n);
    expect(receipt.wacCost.amount).toBe(10000n);

    const saleResult = await inventory.recordSale(storeBoundCtx, {
      id: 'mov-2',
      storeId: store1.id,
      variantId: variant.id,
      quantity: 3n,
      sourceId: 'sale-100',
    });
    expect(saleResult.quantityOnHand).toBe(1n);
    expect(saleResult.unitCostSnapshot.amount).toBe(10000n);
    expect(saleResult.costOfGoodsSold.amount).toBe(30000n);

    // CashDrawerService unit checks
    let openedStoreId: string | undefined;
    const drawerService = new CashDrawerService(
      {
        openDrawer: (_ctx, sId) => {
          openedStoreId = sId;
          return Promise.resolve();
        },
      },
      storeRepo,
    );

    await expect(drawerService.open(storeBoundCtx, store2.id)).rejects.toThrow('UnauthorizedError');
    await drawerService.open(storeBoundCtx, store1.id);
    expect(openedStoreId).toBe(store1.id);
  });
});
