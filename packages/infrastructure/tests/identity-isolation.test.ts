import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AuthService,
  TenantService,
  ScopedExecutionContext,
} from '@retailos/application';
import { Roles, Permissions, User } from '@retailos/core';
import { SqliteDatabaseManager } from '../src/database/sqlite.js';
import { DatabaseMigrator } from '../src/database/migrator.js';
import { Argon2PasswordHasher } from '../src/security/argon2-password-hasher.js';
import { CryptoTokenService } from '../src/security/crypto-token-service.js';
import { SqliteTenantRepository } from '../src/database/repositories/sqlite-tenant.repository.js';
import { SqliteStoreRepository } from '../src/database/repositories/sqlite-store.repository.js';
import { SqliteUserRepository } from '../src/database/repositories/sqlite-user.repository.js';
import { SqliteSessionRepository } from '../src/database/repositories/sqlite-session.repository.js';

describe('Phase 2: Identity, RBAC & Multi-Tenant Isolation', () => {
  let dbManager: SqliteDatabaseManager;
  let tenantRepo: SqliteTenantRepository;
  let storeRepo: SqliteStoreRepository;
  let userRepo: SqliteUserRepository;
  let sessionRepo: SqliteSessionRepository;
  let passwordHasher: Argon2PasswordHasher;
  let tokenService: CryptoTokenService;
  let authService: AuthService;
  let tenantService: TenantService;

  beforeEach(async () => {
    dbManager = new SqliteDatabaseManager({ filename: ':memory:' });
    dbManager.connect();

    const migrator = new DatabaseMigrator(dbManager.getDb());
    await migrator.migrateToLatest();

    tenantRepo = new SqliteTenantRepository(dbManager.getDb());
    storeRepo = new SqliteStoreRepository(dbManager.getDb());
    userRepo = new SqliteUserRepository(dbManager.getDb());
    sessionRepo = new SqliteSessionRepository(dbManager.getDb());
    passwordHasher = new Argon2PasswordHasher();
    tokenService = new CryptoTokenService();

    authService = new AuthService(
      tenantRepo,
      userRepo,
      sessionRepo,
      passwordHasher,
      tokenService,
    );

    tenantService = new TenantService(tenantRepo, storeRepo, userRepo, passwordHasher);
  });

  afterEach(async () => {
    await dbManager.close();
  });

  it('proves Argon2id password hashing and constant-time verification', async () => {
    const plain = 'SuperSecret123!';
    const hash = await passwordHasher.hash(plain);

    expect(hash).toContain('$argon2id$');
    expect(await passwordHasher.verify(hash, plain)).toBe(true);
    expect(await passwordHasher.verify(hash, 'WrongPassword')).toBe(false);
  });

  it('performs end-to-end user authentication and session issuance', async () => {
    // 1. Setup Tenant
    const tenant = await tenantService.createTenant({
      id: 'tenant-alpha',
      name: 'Alpha Retail',
      code: 'ALPHA',
      currency: 'USD',
    });

    // 2. Setup Store
    const adminCtx = new ScopedExecutionContext({
      tenantId: tenant.id,
      userId: 'admin-seed',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'seed-setup',
    });

    const store = await tenantService.createStore(adminCtx, {
      id: 'store-alpha-1',
      name: 'Alpha Downtown',
      code: 'ALPHA-01',
    });

    // 3. Create Cashier User
    await tenantService.createUser(adminCtx, {
      id: 'user-cashier-1',
      username: 'cashier_bob',
      passwordPlain: 'BobPass123',
      fullName: 'Bob Cashier',
      role: Roles.CASHIER,
      storeId: store.id,
    });

    // 4. Test Login
    const session = await authService.login({
      tenantCode: 'ALPHA',
      username: 'cashier_bob',
      password: 'BobPass123',
    });

    expect(session.token).toBeDefined();
    expect(session.user.username).toBe('cashier_bob');
    expect(session.user.role).toBe('CASHIER');
    expect(session.user.storeId).toBe(store.id);
    expect(session.permissions).toContain(Permissions.POS_CHECKOUT);
    expect(session.permissions).not.toContain(Permissions.USERS_MANAGE);

    // 5. Validate session token and obtain ScopedExecutionContext
    const execCtx = await authService.validateSession(session.token);
    expect(execCtx.tenantId).toBe(tenant.id);
    expect(execCtx.storeId).toBe(store.id);
    expect(execCtx.userId).toBe('user-cashier-1');
    expect(execCtx.hasPermission(Permissions.POS_CHECKOUT)).toBe(true);
    expect(execCtx.hasPermission(Permissions.REPORTS_FINANCIAL_VIEW)).toBe(false);

    // 6. Test Logout / Revocation
    await authService.logout(session.token);
    await expect(authService.validateSession(session.token)).rejects.toThrow(
      'Session not found or revoked',
    );
  });

  it('strictly enforces multi-tenant boundary: Tenant A cannot see or access Tenant B data', async () => {
    // Setup Tenant A
    const tenantA = await tenantService.createTenant({
      id: 'tenant-a',
      name: 'Tenant Alpha',
      code: 'TENANT_A',
      currency: 'USD',
    });
    const ctxA = new ScopedExecutionContext({
      tenantId: tenantA.id,
      userId: 'owner-a',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'corr-a',
    });
    const storeA = await tenantService.createStore(ctxA, {
      id: 'store-a1',
      name: 'Store Alpha 1',
      code: 'STA1',
    });
    await tenantService.createUser(ctxA, {
      id: 'user-a1',
      username: 'alice_a',
      passwordPlain: 'AliceSecret123',
      fullName: 'Alice A',
      role: Roles.OWNER,
    });

    // Setup Tenant B
    const tenantB = await tenantService.createTenant({
      id: 'tenant-b',
      name: 'Tenant Beta',
      code: 'TENANT_B',
      currency: 'EUR',
    });
    const ctxB = new ScopedExecutionContext({
      tenantId: tenantB.id,
      userId: 'owner-b',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'corr-b',
    });
    const storeB = await tenantService.createStore(ctxB, {
      id: 'store-b1',
      name: 'Store Beta 1',
      code: 'STB1',
    });

    // TEST 1: Tenant A context querying Store B by ID returns null (Data Isolation)
    const storeLookupByA = await storeRepo.findById(ctxA, storeB.id);
    expect(storeLookupByA).toBeNull();

    // TEST 2: Tenant A context querying Stores list only sees Store A
    const storesListA = await storeRepo.listByTenant(ctxA);
    expect(storesListA).toHaveLength(1);
    expect(storesListA[0]!.id).toBe(storeA.id);

    // TEST 3: Tenant A attempting to save an entity with Tenant B ID throws TenantIsolationViolation
    await expect(
      storeRepo.save(ctxA, storeB),
    ).rejects.toThrow('TenantIsolationViolation');

    // TEST 4: User lookup across tenants
    const userLookupByB = await userRepo.findById(ctxB, 'user-a1');
    expect(userLookupByB).toBeNull();
  });

  it('rejects an id collision when another tenant tries to overwrite a user', async () => {
    const tenantA = await tenantService.createTenant({ id: 'tenant-collision-a', name: 'A', code: 'COL_A', currency: 'USD' });
    const tenantB = await tenantService.createTenant({ id: 'tenant-collision-b', name: 'B', code: 'COL_B', currency: 'USD' });
    const ctxA = new ScopedExecutionContext({ tenantId: tenantA.id, userId: 'owner-a', roleId: 'OWNER', permissions: new Set(['*']), correlationId: 'a' });
    const ctxB = new ScopedExecutionContext({ tenantId: tenantB.id, userId: 'owner-b', roleId: 'OWNER', permissions: new Set(['*']), correlationId: 'b' });
    await tenantService.createUser(ctxA, { id: 'shared-user-id', username: 'alice', passwordPlain: 'Password123', fullName: 'Alice', role: Roles.OWNER });
    const foreignUser = (await userRepo.findById(ctxA, 'shared-user-id'))!;
    await expect(userRepo.save(ctxB, User.create({ id: foreignUser.id, tenantId: tenantB.id, username: 'attacker', passwordHash: foreignUser.passwordHash, fullName: 'Attacker', role: Roles.OWNER }))).rejects.toThrow('TenantIsolationViolation');
    expect((await userRepo.findById(ctxA, 'shared-user-id'))?.username).toBe('alice');
  });

  it('blocks a user store-scope change until the existing session is revoked', async () => {
    const tenant = await tenantService.createTenant({ id: 'tenant-move', name: 'Move', code: 'MOVE', currency: 'USD' });
    const ctx = new ScopedExecutionContext({ tenantId: tenant.id, userId: 'owner', roleId: 'OWNER', permissions: new Set(['*']), correlationId: 'seed' });
    const firstStore = await tenantService.createStore(ctx, { id: 'move-store-1', name: 'One', code: 'ONE' });
    const secondStore = await tenantService.createStore(ctx, { id: 'move-store-2', name: 'Two', code: 'TWO' });
    await tenantService.createUser(ctx, { id: 'moving-user', username: 'moving', passwordPlain: 'Password123', fullName: 'Moving User', role: Roles.CASHIER, storeId: firstStore.id });
    const session = await authService.login({ tenantCode: 'MOVE', username: 'moving', password: 'Password123' });
    await expect(dbManager.getDb().updateTable('users').set({ store_id: secondStore.id }).where('id', '=', 'moving-user').execute())
      .rejects.toThrow('TenantIsolationViolation');
    await authService.logout(session.token);
    await dbManager.getDb().updateTable('users').set({ store_id: secondStore.id }).where('id', '=', 'moving-user').execute();
    await expect(authService.validateSession(session.token)).rejects.toThrow('Session not found or revoked');
    await expect(authService.validateSession(session.token)).rejects.toThrow('Session not found or revoked');
  });

  it('enforces store-level authorization: Store Manager cannot manage outside their store', async () => {
    const tenant = await tenantService.createTenant({
      id: 'tenant-corp',
      name: 'Corp',
      code: 'CORP',
      currency: 'USD',
    });

    const ownerCtx = new ScopedExecutionContext({
      tenantId: tenant.id,
      userId: 'owner',
      roleId: 'OWNER',
      permissions: new Set(['*']),
      correlationId: 'corr-owner',
    });

    const store1 = await tenantService.createStore(ownerCtx, {
      id: 's1',
      name: 'Branch 1',
      code: 'B1',
    });
    const store2 = await tenantService.createStore(ownerCtx, {
      id: 's2',
      name: 'Branch 2',
      code: 'B2',
    });

    // Store Manager assigned to Branch 1
    const manager1Ctx = new ScopedExecutionContext({
      tenantId: tenant.id,
      storeId: store1.id,
      userId: 'mgr-1',
      roleId: 'STORE_MANAGER',
      permissions: new Set([Permissions.USERS_MANAGE]),
      correlationId: 'corr-mgr-1',
    });

    // Attempting to create a user assigned to Branch 2 by Manager of Branch 1 must fail
    await expect(
      tenantService.createUser(manager1Ctx, {
        id: 'cashier-foreign',
        username: 'intruder',
        passwordPlain: 'Pass123456',
        fullName: 'Intruder',
        role: Roles.CASHIER,
        storeId: store2.id, // Mismatched store!
      }),
    ).rejects.toThrow('UnauthorizedError: Store Manager cannot assign users to other stores');
  });
});
