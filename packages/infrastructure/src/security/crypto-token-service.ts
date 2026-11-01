import { randomBytes, createHash } from 'node:crypto';
import type { TokenService } from '@retailos/application';

export class CryptoTokenService implements TokenService {
  public generateToken(): string {
    // 256 bits of cryptographically secure entropy
    return randomBytes(32).toString('hex');
  }

  public hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
