import { getPermissionsForRole } from '@retailos/core';
import type { AuthSessionDTO } from '@retailos/shared';
import type {
  TenantRepository,
  UserRepository,
  SessionRepository,
} from '../ports/identity-repositories.interface.js';
import type { PasswordHasher } from '../ports/password-hasher.interface.js';
import type { TokenService } from '../ports/token-service.interface.js';
import { ScopedExecutionContext } from '../context/execution-context.js';

export interface AuthServiceConfig {
  sessionTtlHours?: number;
}

export class AuthService {
  private readonly sessionTtlHours: number;

  constructor(
    private readonly tenantRepo: TenantRepository,
    private readonly userRepo: UserRepository,
    private readonly sessionRepo: SessionRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenService: TokenService,
    config?: AuthServiceConfig,
  ) {
    this.sessionTtlHours = config?.sessionTtlHours ?? 24;
  }

  public async login(params: {
    tenantCode: string;
    username: string;
    password: string;
    clientCorrelationId?: string;
  }): Promise<AuthSessionDTO> {
    const tenant = await this.tenantRepo.findByCode(params.tenantCode.trim());
    if (!tenant || !tenant.isActive) {
      throw new Error('AuthenticationError: Invalid tenant or tenant inactive');
    }

    const user = await this.userRepo.findByUsername(
      tenant.id,
      params.username.trim().toLowerCase(),
    );
    if (!user || !user.isActive) {
      throw new Error('AuthenticationError: Invalid username or password');
    }

    const isMatch = await this.passwordHasher.verify(user.passwordHash, params.password);
    if (!isMatch) {
      throw new Error('AuthenticationError: Invalid username or password');
    }

    const rawToken = this.tokenService.generateToken();
    const tokenHash = this.tokenService.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 3600 * 1000);

    // Derive the session row id from the 256-bit token hash instead of using
    // Math.random(). The token itself remains the only bearer secret.
    const sessionId = `sess_${tokenHash.substring(0, 32)}`;

    await this.sessionRepo.createSession({
      id: sessionId,
      tenantId: tenant.id,
      storeId: user.storeId,
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    const permsSet = getPermissionsForRole(user.role);
    const permissions = Array.from(permsSet);

    return {
      token: rawToken,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        tenantId: user.tenantId,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        storeId: user.storeId,
        isActive: user.isActive,
        createdAt: user.createdAt.toISOString(),
      },
      permissions,
    };
  }

  public async validateSession(
    rawToken: string,
    correlationId?: string,
  ): Promise<ScopedExecutionContext> {
    if (!rawToken?.trim()) {
      throw new Error('AuthenticationError: Token is missing');
    }

    const tokenHash = this.tokenService.hashToken(rawToken.trim());
    const session = await this.sessionRepo.findSessionByTokenHash(tokenHash);

    if (!session || session.isRevoked) {
      throw new Error('AuthenticationError: Session not found or revoked');
    }

    if (new Date() > session.expiresAt) {
      throw new Error('AuthenticationError: Session has expired');
    }

    // Load full user to get role & active status
    const dummyCtx = new ScopedExecutionContext({
      tenantId: session.tenantId,
      userId: session.userId,
      roleId: 'INTERNAL',
      permissions: new Set(['*']),
      correlationId: correlationId ?? 'sys-session-validation',
    });

    const user = await this.userRepo.findById(dummyCtx, session.userId);
    if (!user || !user.isActive) {
      throw new Error('AuthenticationError: User account is inactive or disabled');
    }

    const permissions = getPermissionsForRole(user.role);

    return new ScopedExecutionContext({
      tenantId: session.tenantId,
      storeId: session.storeId,
      userId: session.userId,
      roleId: user.role,
      permissions,
      correlationId: correlationId ?? `req_${Date.now()}`,
    });
  }

  public async logout(rawToken: string): Promise<void> {
    if (!rawToken?.trim()) {
      return;
    }
    const tokenHash = this.tokenService.hashToken(rawToken.trim());
    await this.sessionRepo.revokeSession(tokenHash);
  }
}
