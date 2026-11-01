export interface TokenService {
  /**
   * Generates a cryptographically strong random token string (e.g. 256-bit).
   */
  generateToken(): string;

  /**
   * Hashes the token (e.g. SHA-256) for safe database storage and indexed lookup.
   */
  hashToken(token: string): string;
}
