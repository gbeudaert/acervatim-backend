import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HashService } from '../common/crypto/hash.service';
import { PrismaService } from '../prisma/prisma.service';

export interface ResolvedUser {
  userId: string;
  isNew: boolean;
}

/**
 * Centralise le mapping `(provider, subject)` → `userId` interne.
 *
 * Sprint 02 (single provider) : seul `google` est persisté, dans `users.google_sub_hash`.
 * Pour ajouter Apple / Facebook plus tard :
 *   1. Schéma : remplacer le champ par une table `user_identities (userId, provider, subjectHash)`
 *      (PK composite `provider, subjectHash`), garder `google_sub_hash` côté migration legacy
 *      ou backfill puis drop.
 *   2. Ce service : router selon `provider` au lieu d'écrire un champ fixe.
 * Aucun autre fichier ne touche à la colonne d'identité — l'abstraction tient ici.
 */
@Injectable()
export class IdentityResolverService implements OnModuleInit {
  private pepper!: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly hash: HashService,
  ) {}

  onModuleInit() {
    const pepper = this.config.get<string>('SUB_HASH_PEPPER');
    if (!pepper || pepper.length < 32) {
      throw new Error('SUB_HASH_PEPPER must be set (≥ 32 chars)');
    }
    this.pepper = pepper;
  }

  /**
   * Calcule HMAC-SHA-256(pepper, "{provider}:{subject}") et upsert le user correspondant.
   * Le préfixe `provider:` est inclus dans le clair haché pour éviter toute collision
   * théorique entre deux providers qui auraient le même subject brut.
   */
  async resolveOrCreate(
    provider: string,
    subject: string,
  ): Promise<ResolvedUser> {
    if (provider !== 'google') {
      // À adapter quand on introduit `user_identities` (cf. JSDoc classe).
      throw new Error(
        `IdentityResolver: provider "${provider}" not yet wired to persistence`,
      );
    }

    const subjectHash = this.hash.hmacSha256Hex(
      this.pepper,
      `${provider}:${subject}`,
    );

    const existing = await this.prisma.user.findUnique({
      where: { googleSubHash: subjectHash },
      select: { id: true },
    });
    if (existing) {
      return { userId: existing.id, isNew: false };
    }

    const created = await this.prisma.user.create({
      data: { googleSubHash: subjectHash },
      select: { id: true },
    });
    return { userId: created.id, isNew: true };
  }
}
