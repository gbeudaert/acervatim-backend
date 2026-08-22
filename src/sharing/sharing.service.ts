import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { AuditLogService } from '../common/audit/audit-log.service';
import { HashService } from '../common/crypto/hash.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShareDto } from './dto/create-share.dto';
import { ShareCodeInvalidException } from './share-code-invalid.exception';
import { ShareScope } from './share-scope';

/** Résumé de collection rendu à un membre : le strict nécessaire pour l'afficher dans une liste. */
export interface SharedCollectionSummary {
  id: string;
  name: string;
  type: string;
  itemCount: number;
}

export interface CreatedShare {
  id: string;
  /** Code en clair. Retourné UNE seule fois, au propriétaire qui crée le partage. */
  code: string;
  collectionId: string;
  scope: ShareScope;
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  createdAt: Date;
}

export interface ShareMemberView {
  /** UUID opaque : aucun email, aucun nom — il n'y en a pas en base (invariant privacy). */
  memberUserId: string;
  redeemedAt: Date;
}

export interface ShareView {
  id: string;
  collectionId: string;
  scope: ShareScope;
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  createdAt: Date;
  members: ShareMemberView[];
}

export interface ReceivedShare {
  shareId: string;
  collectionId: string;
  scope: ShareScope;
  redeemedAt: Date;
  collection: SharedCollectionSummary;
}

export interface RedeemedShare extends ReceivedShare {
  /** `true` si le membre avait déjà rejoint : le redeem est idempotent, il ne consomme rien. */
  alreadyMember: boolean;
}

const COLLECTION_SUMMARY_SELECT = {
  id: true,
  name: true,
  itemCount: true,
  type: { select: { code: true } },
} as const;

type CollectionSummaryRow = {
  id: string;
  name: string;
  itemCount: number;
  type: { code: string };
};

function toSummary(row: CollectionSummaryRow): SharedCollectionSummary {
  return {
    id: row.id,
    name: row.name,
    type: row.type.code,
    itemCount: row.itemCount,
  };
}

@Injectable()
export class SharingService implements OnModuleInit {
  private readonly logger = new Logger(SharingService.name);
  private pepper!: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly hash: HashService,
    private readonly auditLog: AuditLogService,
  ) {}

  onModuleInit() {
    const pepper = this.config.get<string>('SHARE_CODE_PEPPER');
    if (!pepper || pepper.length < 32) {
      throw new Error(
        'SHARE_CODE_PEPPER must be set (>= 32 chars, base64 recommandé)',
      );
    }
    this.pepper = pepper;
  }

  private hashCode(code: string): string {
    return this.hash.hmacSha256Hex(this.pepper, code);
  }

  /** 18 octets aléatoires -> 24 chars base64url. ~144 bits : hors de portée d'un balayage en ligne. */
  private generateCode(): string {
    return randomBytes(18).toString('base64url');
  }

  /** 404 si la collection n'existe pas OU appartient à un autre user — indistinguables (pas de leak). */
  private async assertOwnedCollection(
    userId: string,
    collectionId: string,
  ): Promise<void> {
    const collection = await this.prisma.collection.findFirst({
      where: { id: collectionId, userId },
      select: { id: true },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
  }

  /** 404 si le partage n'existe pas OU n'est pas au requérant — même convention. */
  private async assertOwnedShare(userId: string, shareId: string) {
    const share = await this.prisma.collectionShare.findFirst({
      where: { id: shareId, ownerUserId: userId },
      select: { id: true, scope: true, revokedAt: true },
    });
    if (!share) {
      throw new NotFoundException('Share not found');
    }
    return share;
  }

  async create(
    userId: string,
    collectionId: string,
    dto: CreateShareDto,
  ): Promise<CreatedShare> {
    await this.assertOwnedCollection(userId, collectionId);

    const code = this.generateCode();
    const codeHash = this.hashCode(code);
    const share = await this.prisma.collectionShare.create({
      data: {
        collectionId,
        ownerUserId: userId,
        codeHash,
        scope: dto.scope,
        maxUses: dto.maxUses ?? 1,
        expiresAt: dto.expiresAt != null ? BigInt(dto.expiresAt) : null,
      },
    });

    await this.auditLog.record({
      userId,
      action: 'share.create',
      target: share.id,
      metadata: { scope: share.scope },
    });
    this.logger.log(
      `share.create share=${share.id.slice(0, 8)}… scope=${share.scope} maxUses=${share.maxUses}`,
    );

    return {
      id: share.id,
      code,
      collectionId: share.collectionId,
      scope: share.scope as ShareScope,
      maxUses: share.maxUses,
      usedCount: share.usedCount,
      expiresAt: share.expiresAt != null ? Number(share.expiresAt) : null,
      createdAt: share.createdAt,
    };
  }

  /**
   * Partages non révoqués d'une collection, membres actifs inclus.
   *
   * Les partages **expirés** restent listés : le propriétaire doit voir pourquoi son code ne prend
   * plus, et `expiresAt` le lui dit. Seule la révocation fait disparaître la ligne.
   * Ni le code (il n'existe plus nulle part) ni son hash ne sortent d'ici.
   */
  async list(userId: string, collectionId: string): Promise<ShareView[]> {
    await this.assertOwnedCollection(userId, collectionId);

    const shares = await this.prisma.collectionShare.findMany({
      where: { collectionId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        members: {
          where: { revokedAt: null },
          orderBy: { redeemedAt: 'asc' },
          select: { memberUserId: true, redeemedAt: true },
        },
      },
    });

    return shares.map((share) => ({
      id: share.id,
      collectionId: share.collectionId,
      scope: share.scope as ShareScope,
      maxUses: share.maxUses,
      usedCount: share.usedCount,
      expiresAt: share.expiresAt != null ? Number(share.expiresAt) : null,
      createdAt: share.createdAt,
      members: share.members,
    }));
  }

  /**
   * Révoque le partage entier : le code cesse de prendre ET tous les membres perdent l'accès.
   * Marquage, pas suppression — la trace de ce qui a été partagé doit survivre à la révocation.
   * Idempotent : re-révoquer ne change rien et ne ré-audite pas.
   */
  async revoke(userId: string, shareId: string): Promise<void> {
    const share = await this.assertOwnedShare(userId, shareId);
    if (share.revokedAt) return;

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.collectionShare.update({
        where: { id: shareId },
        data: { revokedAt: now },
      }),
      this.prisma.collectionShareMember.updateMany({
        where: { shareId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    await this.auditLog.record({
      userId,
      action: 'share.revoke',
      target: shareId,
      metadata: { scope: share.scope },
    });
    this.logger.log(`share.revoke share=${shareId.slice(0, 8)}…`);
  }

  /**
   * Éjecte un membre sans toucher au partage : le code reste valide pour les autres.
   * Le membre éjecté ne peut pas revenir avec le même code (cf. `redeem`).
   */
  async revokeMember(
    userId: string,
    shareId: string,
    memberUserId: string,
  ): Promise<void> {
    const share = await this.assertOwnedShare(userId, shareId);

    const member = await this.prisma.collectionShareMember.findUnique({
      where: { shareId_memberUserId: { shareId, memberUserId } },
      select: { revokedAt: true },
    });
    if (!member) {
      throw new NotFoundException('Share member not found');
    }
    if (member.revokedAt) return;

    await this.prisma.collectionShareMember.update({
      where: { shareId_memberUserId: { shareId, memberUserId } },
      data: { revokedAt: new Date() },
    });

    await this.auditLog.record({
      userId,
      action: 'share.member.revoke',
      target: shareId,
      metadata: { scope: share.scope },
    });
    this.logger.log(
      `share.member.revoke share=${shareId.slice(0, 8)}… member=${memberUserId.slice(0, 8)}…`,
    );
  }

  /**
   * Consomme un code pour `userId`.
   *
   * - **Idempotent** : un membre déjà actif ré-appelle sans reconsommer une place.
   * - **Atomique** : contrôles + incrément de `usedCount` + création du membre dans la même
   *   transaction, l'incrément gardé par un `updateMany` conditionnel (même patron que les
   *   invitations) — deux redeems concurrents sur la dernière place ne peuvent pas passer tous deux.
   * - **Aucun oracle** : tout refus lié au code sort en `ShareCodeInvalidException`, un seul statut,
   *   un seul message. Seul le propriétaire obtient une erreur distincte (400), et pour cause : il
   *   connaît déjà l'existence de son propre code.
   */
  async redeem(rawCode: string, userId: string): Promise<RedeemedShare> {
    const codeHash = this.hashCode(rawCode);

    const result = await this.prisma.$transaction(async (tx) => {
      const share = await tx.collectionShare.findUnique({
        where: { codeHash },
        include: { collection: { select: COLLECTION_SUMMARY_SELECT } },
      });
      if (!share) {
        throw new ShareCodeInvalidException();
      }
      if (share.ownerUserId === userId) {
        throw new BadRequestException(
          'Impossible de rejoindre son propre partage',
        );
      }
      if (share.revokedAt) {
        throw new ShareCodeInvalidException();
      }
      if (share.expiresAt != null && Number(share.expiresAt) < Date.now()) {
        throw new ShareCodeInvalidException();
      }

      const existing = await tx.collectionShareMember.findUnique({
        where: {
          shareId_memberUserId: { shareId: share.id, memberUserId: userId },
        },
      });
      if (existing) {
        // Membre éjecté : le code ne le fait pas revenir, sinon révoquer un membre ne servirait
        // à rien tant que le partage vit.
        if (existing.revokedAt) {
          throw new ShareCodeInvalidException();
        }
        return {
          shareId: share.id,
          collectionId: share.collectionId,
          scope: share.scope as ShareScope,
          redeemedAt: existing.redeemedAt,
          collection: toSummary(share.collection),
          alreadyMember: true,
        };
      }

      if (share.usedCount >= share.maxUses) {
        throw new ShareCodeInvalidException();
      }
      // Garde optimiste : n'incrémente que si la place est encore libre.
      const bumped = await tx.collectionShare.updateMany({
        where: { id: share.id, usedCount: { lt: share.maxUses } },
        data: { usedCount: { increment: 1 } },
      });
      if (bumped.count === 0) {
        throw new ShareCodeInvalidException();
      }

      const member = await tx.collectionShareMember.create({
        data: { shareId: share.id, memberUserId: userId },
      });

      return {
        shareId: share.id,
        collectionId: share.collectionId,
        scope: share.scope as ShareScope,
        redeemedAt: member.redeemedAt,
        collection: toSummary(share.collection),
        alreadyMember: false,
      };
    });

    if (!result.alreadyMember) {
      await this.auditLog.record({
        userId,
        action: 'share.redeem',
        target: result.shareId,
        metadata: { scope: result.scope },
      });
      this.logger.log(
        `share.redeem share=${result.shareId.slice(0, 8)}… member=${userId.slice(0, 8)}…`,
      );
    }
    return result;
  }

  /**
   * Partages que j'ai rejoints et qui vivent encore.
   *
   * `expiresAt` n'entre pas dans le filtre : il borne l'usage du **code**, pas l'adhésion déjà
   * acquise. Une adhésion ne tombe que sur révocation (du partage ou du membre).
   */
  async listReceived(userId: string): Promise<ReceivedShare[]> {
    const memberships = await this.prisma.collectionShareMember.findMany({
      where: {
        memberUserId: userId,
        revokedAt: null,
        share: { revokedAt: null },
      },
      orderBy: { redeemedAt: 'desc' },
      include: {
        share: {
          include: { collection: { select: COLLECTION_SUMMARY_SELECT } },
        },
      },
    });

    return memberships.map((m) => ({
      shareId: m.shareId,
      collectionId: m.share.collectionId,
      scope: m.share.scope as ShareScope,
      redeemedAt: m.redeemedAt,
      collection: toSummary(m.share.collection),
    }));
  }
}
