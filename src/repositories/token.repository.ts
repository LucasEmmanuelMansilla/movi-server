import crypto from 'crypto';
import { env } from '../env';

export class TokenRepository {
  private static instance: TokenRepository;
  private readonly algorithm = 'aes-256-cbc';
  private readonly key: Buffer;

  private constructor() {
    this.key = crypto.scryptSync(env.SUPABASE_SERVICE_ROLE_KEY || 'default-key', 'salt', 32);
  }

  public static getInstance(): TokenRepository {
    if (!TokenRepository.instance) {
      TokenRepository.instance = new TokenRepository();
    }
    return TokenRepository.instance;
  }

  public encrypt(token: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  public decrypt(encryptedToken: string): string {
    try {
      const [ivHex, encrypted] = encryptedToken.split(':');
      if (!ivHex || !encrypted) return encryptedToken;

      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      return encryptedToken;
    }
  }
}
