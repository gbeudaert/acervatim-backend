import { Injectable } from '@nestjs/common';
import { AesService } from '../common/crypto/aes.service';
import { PrismaService } from '../prisma/prisma.service';

export type OauthProvider = 'discogs' | 'mal' | 'tmdb';

export interface StoreCredentialsInput {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms ; 0 = jamais (OAuth 1.0a sans expiration). */
  expiresAtMs: number;
  scopes: string[];
}

export interface DecryptedCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  scopes: string[];
}

export interface ConnectedProvider {
  provider: string;
  expiresAtMs: number;
}

const ENCRYPTION_KEY_VERSION = 1;

@Injectable()
export class OauthCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aes: AesService,
  ) {}

  async store(
    userId: string,
    provider: OauthProvider,
    creds: StoreCredentialsInput,
  ): Promise<void> {
    const accessTokenEncrypted = this.aes.encrypt(creds.accessToken);
    const refreshTokenEncrypted = creds.refreshToken
      ? this.aes.encrypt(creds.refreshToken)
      : null;

    await this.prisma.oauthCredential.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        accessTokenEncrypted,
        refreshTokenEncrypted,
        expiresAt: BigInt(creds.expiresAtMs),
        scopes: creds.scopes,
        encryptedWithKeyVersion: ENCRYPTION_KEY_VERSION,
      },
      update: {
        accessTokenEncrypted,
        refreshTokenEncrypted,
        expiresAt: BigInt(creds.expiresAtMs),
        scopes: creds.scopes,
        encryptedWithKeyVersion: ENCRYPTION_KEY_VERSION,
      },
    });
  }

  async get(
    userId: string,
    provider: OauthProvider,
  ): Promise<DecryptedCredentials | null> {
    const row = await this.prisma.oauthCredential.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row) return null;

    return {
      accessToken: this.aes.decrypt(row.accessTokenEncrypted),
      refreshToken: row.refreshTokenEncrypted
        ? this.aes.decrypt(row.refreshTokenEncrypted)
        : undefined,
      expiresAtMs: Number(row.expiresAt),
      scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    };
  }

  async remove(userId: string, provider: OauthProvider): Promise<void> {
    await this.prisma.oauthCredential.deleteMany({
      where: { userId, provider },
    });
  }

  async listConnected(userId: string): Promise<ConnectedProvider[]> {
    const rows = await this.prisma.oauthCredential.findMany({
      where: { userId },
      select: { provider: true, expiresAt: true },
    });
    return rows.map((r) => ({
      provider: r.provider,
      expiresAtMs: Number(r.expiresAt),
    }));
  }
}
