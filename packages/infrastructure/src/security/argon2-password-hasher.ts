import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from '@retailos/application';

export class Argon2PasswordHasher implements PasswordHasher {
  public async hash(password: string): Promise<string> {
    if (!password) {
      throw new Error('PasswordHasherError: Password cannot be empty');
    }
    // Argon2id parameters: memoryCost 19456 (19 MB), timeCost 2, outputLen 32
    return hash(password, {
      memoryCost: 19456,
      timeCost: 2,
      outputLen: 32,
    });
  }

  public async verify(hashString: string, plain: string): Promise<boolean> {
    if (!hashString || !plain) {
      return false;
    }
    try {
      return await verify(hashString, plain);
    } catch {
      return false;
    }
  }
}
