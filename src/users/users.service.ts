import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

export interface UserMe {
  userId: string;
  createdAt: Date;
}

export interface UserExport {
  exportedAt: string;
  schemaVersion: number;
  data: {
    user: { id: string; createdAt: Date; updatedAt: Date };
    collections: unknown[];
    collectionNodes: unknown[];
    items: unknown[];
    oauthCredentials: unknown[];
    subscription: unknown | null;
    premiumGrant: unknown | null;
    invitationRedemptions: unknown[];
    /** Partages que j'ai émis sur mes collections. */
    collectionShares: unknown[];
    /** Partages que j'ai rejoints en tant que membre. */
    shareMemberships: unknown[];
    auditLogs: unknown[];
  };
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async findById(userId: string): Promise<UserMe> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, createdAt: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return { userId: user.id, createdAt: user.createdAt };
  }

  /**
   * RGPD art. 20 — dump complet de TOUTES les données du user.
   * Tokens OAuth retournés chiffrés tels quels (la clé n'est jamais exfiltrée).
   * On consigne l'export AVANT le fetch pour qu'une lecture cassée laisse quand même
   * une trace dans `audit_logs`.
   */
  async exportMe(userId: string): Promise<UserExport> {
    await this.auditLog.record({ userId, action: 'user.export' });

    const [
      user,
      collections,
      collectionNodes,
      items,
      oauthCredentials,
      subscription,
      premiumGrant,
      invitationRedemptions,
      collectionShares,
      shareMemberships,
      auditLogs,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, createdAt: true, updatedAt: true },
      }),
      this.prisma.collection.findMany({ where: { userId } }),
      // Les nœuds (séries) portent leur propre unifiedData/userData/sources : sans eux
      // l'export amputerait la collection de tout le niveau série (note, commentaire,
      // isWishlist, synopsis curé).
      this.prisma.collectionNode.findMany({ where: { userId } }),
      this.prisma.item.findMany({ where: { userId } }),
      this.prisma.oauthCredential.findMany({ where: { userId } }),
      this.prisma.subscription.findUnique({ where: { userId } }),
      this.prisma.premiumGrant.findUnique({ where: { userId } }),
      this.prisma.invitationRedemption.findMany({ where: { userId } }),
      // Les deux sens du partage. `codeHash` est exclu : c'est le secret qui autorise à rejoindre,
      // il n'a rien à faire dans un fichier qui sort du serveur — et le code en clair n'existe
      // plus nulle part de toute façon.
      this.prisma.collectionShare.findMany({
        where: { ownerUserId: userId },
        select: {
          id: true,
          collectionId: true,
          scope: true,
          maxUses: true,
          usedCount: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
          members: {
            select: {
              memberUserId: true,
              redeemedAt: true,
              revokedAt: true,
            },
          },
        },
      }),
      this.prisma.collectionShareMember.findMany({
        where: { memberUserId: userId },
        select: {
          shareId: true,
          redeemedAt: true,
          revokedAt: true,
          share: { select: { collectionId: true, scope: true } },
        },
      }),
      this.prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: 1,
      data: {
        user,
        collections,
        collectionNodes,
        items,
        oauthCredentials,
        subscription,
        premiumGrant,
        invitationRedemptions,
        collectionShares,
        shareMemberships,
        auditLogs,
      },
    };
  }

  /**
   * Supprime le user (cascade Prisma sur collections/items/oauth/subscription/grant/redemptions,
   * et sur les partages : ses `CollectionShare` via `Collection`, ses adhésions via `User`).
   * On écrit l'audit AVANT le delete : sinon le cascade FK ferait disparaître la trace du grant…
   * mais `audit_logs.userId` n'a PAS de FK (volontaire) — la ligne d'audit survit donc à l'user.
   */
  async deleteMe(userId: string): Promise<{ deleted: true }> {
    await this.auditLog.record({ userId, action: 'user.delete' });
    try {
      await this.prisma.user.delete({ where: { id: userId } });
    } catch (err) {
      // P2025 = Record not found. Idempotent : un double delete ne casse pas.
      const code = (err as { code?: string }).code;
      if (code !== 'P2025') throw err;
    }
    this.logger.log(`user.delete user=${userId.slice(0, 8)}…`);
    return { deleted: true };
  }
}
