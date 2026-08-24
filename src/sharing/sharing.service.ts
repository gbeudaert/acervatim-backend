import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AuditLogService } from '../common/audit/audit-log.service';
import { HashService } from '../common/crypto/hash.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShareDto } from './dto/create-share.dto';
import { ShareCodeInvalidException } from './share-code-invalid.exception';
import { ShareFilterService } from './share-filter.service';
import {
  normalizeStatuses,
  parseStatuses,
  ShareStatus,
} from './share-statuses';

/** Une collection exposée par un partage, telle que la voit le **propriétaire**. */
export interface ShareEntryView {
  collectionId: string;
  name: string;
  type: string;
  statuses: ShareStatus[];
}

/**
 * Idem pour un **membre**, avec le nombre d'éléments qu'il verra effectivement.
 *
 * Le propriétaire n'a pas ce compte : sur son écran de gestion, ce qui l'intéresse est *quelles*
 * collections et *quels* statuts. Le calculer pour lui coûterait une requête par entrée et par
 * partage, sur une liste de partages qui n'est pas plafonnée.
 */
export interface ReceivedEntryView extends ShareEntryView {
  itemCount: number;
}

export interface ShareMemberView {
  /** UUID opaque : aucun email, aucun nom — il n'y en a pas en base (invariant privacy). */
  memberUserId: string;
  redeemedAt: Date;
}

export interface ShareView {
  id: string;
  /** Libellé du propriétaire. Ne sort que vers lui. */
  label: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  createdAt: Date;
  collections: ShareEntryView[];
  members: ShareMemberView[];
}

export interface CreatedShare extends ShareView {
  /** Code en clair. Retourné UNE seule fois, au propriétaire qui crée le partage. */
  code: string;
}

export interface ReceivedShare {
  shareId: string;
  /** Libellé du **membre**. Celui du propriétaire ne lui est jamais transmis. */
  label: string | null;
  redeemedAt: Date;
  collections: ReceivedEntryView[];
}

export interface RedeemedShare extends ReceivedShare {
  /** `true` si le membre avait déjà rejoint : le redeem est idempotent, il ne consomme rien. */
  alreadyMember: boolean;
}

/**
 * Les entrées sortent triées par nom de collection.
 *
 * Sans `orderBy`, Prisma les rend dans l'ordre de la clé composite `[shareId, collectionId]` :
 * un ordre par UUID, donc arbitraire et différent d'un partage à l'autre. Trier par nom donne au
 * client une liste stable et lisible sans qu'il ait à la retrier.
 */
const ENTRY_INCLUDE = {
  entries: {
    orderBy: { collection: { name: 'asc' } },
    include: {
      collection: { select: { name: true, type: { select: { code: true } } } },
    },
  },
} as const;

const ACTIVE_MEMBERS = {
  where: { revokedAt: null },
  orderBy: { redeemedAt: 'asc' },
  select: { memberUserId: true, redeemedAt: true },
} as const;

type EntryRow = {
  collectionId: string;
  statuses: Prisma.JsonValue;
  collection: { name: string; type: { code: string } };
};

function toEntryView(row: EntryRow): ShareEntryView {
  return {
    collectionId: row.collectionId,
    name: row.collection.name,
    type: row.collection.type.code,
    statuses: parseStatuses(row.statuses),
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
    private readonly filter: ShareFilterService,
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

  /**
   * 404 si l'une des collections n'existe pas OU n'appartient pas au requérant — indistinguables
   * (pas de leak), et sans dire **laquelle** : un partage se compose de collections qu'on possède,
   * répondre plus finement ferait de la création de partage un test d'existence.
   */
  private async assertOwnsAll(
    userId: string,
    collectionIds: string[],
  ): Promise<void> {
    const owned = await this.prisma.collection.count({
      where: { id: { in: collectionIds }, userId },
    });
    if (owned !== collectionIds.length) {
      throw new NotFoundException('Collection not found');
    }
  }

  /** 404 si le partage n'existe pas OU n'est pas au requérant — même convention. */
  private async assertOwnedShare(userId: string, shareId: string) {
    const share = await this.prisma.collectionShare.findFirst({
      where: { id: shareId, ownerUserId: userId },
      select: { id: true, revokedAt: true },
    });
    if (!share) {
      throw new NotFoundException('Share not found');
    }
    return share;
  }

  async create(userId: string, dto: CreateShareDto): Promise<CreatedShare> {
    const entries = dto.collections.map((e) => ({
      collectionId: e.collectionId,
      statuses: normalizeStatuses(e.statuses),
    }));
    await this.assertOwnsAll(
      userId,
      entries.map((e) => e.collectionId),
    );

    const code = this.generateCode();
    const share = await this.prisma.collectionShare.create({
      data: {
        ownerUserId: userId,
        codeHash: this.hashCode(code),
        label: dto.label ?? null,
        maxUses: dto.maxUses ?? 1,
        expiresAt: dto.expiresAt != null ? BigInt(dto.expiresAt) : null,
        entries: { create: entries },
      },
      include: ENTRY_INCLUDE,
    });

    // Ni le libellé ni les identifiants de collection : l'audit dit qu'un partage a été créé et de
    // quelle taille, pas ce qu'il nomme.
    await this.auditLog.record({
      userId,
      action: 'share.create',
      target: share.id,
      metadata: { collections: entries.length },
    });
    this.logger.log(
      `share.create share=${share.id.slice(0, 8)}… collections=${entries.length} maxUses=${share.maxUses}`,
    );

    return { ...this.toView(share, []), code };
  }

  /**
   * Partages non révoqués que j'ai émis, membres actifs inclus. `collectionId` restreint aux
   * partages exposant cette collection — de quoi ancrer un écran sur une collection donnée.
   *
   * Les partages **expirés** restent listés : le propriétaire doit voir pourquoi son code ne prend
   * plus, et `expiresAt` le lui dit. Seule la révocation fait disparaître la ligne.
   * Ni le code (il n'existe plus nulle part) ni son hash ne sortent d'ici.
   */
  async list(userId: string, collectionId?: string): Promise<ShareView[]> {
    if (collectionId) {
      await this.assertOwnsAll(userId, [collectionId]);
    }
    const shares = await this.prisma.collectionShare.findMany({
      where: {
        ownerUserId: userId,
        revokedAt: null,
        ...(collectionId ? { entries: { some: { collectionId } } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { ...ENTRY_INCLUDE, members: ACTIVE_MEMBERS },
    });
    return shares.map((share) => this.toView(share, share.members));
  }

  /**
   * Renomme un partage que j'ai émis.
   *
   * Le libellé est le seul champ modifiable après coup : changer les collections ou les statuts d'un
   * partage vivant modifierait sans le dire ce que ses membres voient déjà. Un changement de portée
   * passe donc par une révocation et un nouveau code — visible des deux côtés.
   */
  async updateLabel(
    userId: string,
    shareId: string,
    label: string | null,
  ): Promise<ShareView> {
    await this.assertOwnedShare(userId, shareId);
    const share = await this.prisma.collectionShare.update({
      where: { id: shareId },
      data: { label },
      include: { ...ENTRY_INCLUDE, members: ACTIVE_MEMBERS },
    });
    return this.toView(share, share.members);
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
    await this.assertOwnedShare(userId, shareId);

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
    });
    this.logger.log(
      `share.member.revoke share=${shareId.slice(0, 8)}… member=${memberUserId.slice(0, 8)}…`,
    );
  }

  /**
   * Consomme un code pour `userId`.
   *
   * - **Idempotent** : un membre déjà actif ré-appelle sans reconsommer une place. Un `label` fourni
   *   au passage est tout de même appliqué — c'est le seul effet utile d'un redeem répété.
   * - **Atomique** : contrôles + incrément de `usedCount` + création du membre dans la même
   *   transaction, l'incrément gardé par un `updateMany` conditionnel (même patron que les
   *   invitations) — deux redeems concurrents sur la dernière place ne peuvent pas passer tous deux.
   * - **Aucun oracle** : tout refus lié au code sort en `ShareCodeInvalidException`, un seul statut,
   *   un seul message. Seul le propriétaire obtient une erreur distincte (400), et pour cause : il
   *   connaît déjà l'existence de son propre code.
   */
  async redeem(
    rawCode: string,
    userId: string,
    label: string | null = null,
  ): Promise<RedeemedShare> {
    const codeHash = this.hashCode(rawCode);

    const result = await this.prisma.$transaction(async (tx) => {
      const share = await tx.collectionShare.findUnique({
        where: { codeHash },
        include: ENTRY_INCLUDE,
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
        if (label !== null) {
          await tx.collectionShareMember.update({
            where: {
              shareId_memberUserId: { shareId: share.id, memberUserId: userId },
            },
            data: { label },
          });
        }
        return {
          shareId: share.id,
          label: label ?? existing.label,
          redeemedAt: existing.redeemedAt,
          entries: share.entries,
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
        data: { shareId: share.id, memberUserId: userId, label },
      });

      return {
        shareId: share.id,
        label: member.label,
        redeemedAt: member.redeemedAt,
        entries: share.entries,
        alreadyMember: false,
      };
    });

    if (!result.alreadyMember) {
      await this.auditLog.record({
        userId,
        action: 'share.redeem',
        target: result.shareId,
      });
      this.logger.log(
        `share.redeem share=${result.shareId.slice(0, 8)}… member=${userId.slice(0, 8)}…`,
      );
    }

    // Comptes hors transaction : lecture dérivée, elle n'a rien à faire dans la section critique du
    // redeem (qui ne garde que l'incrément de `usedCount`).
    return {
      shareId: result.shareId,
      label: result.label,
      redeemedAt: result.redeemedAt,
      collections: await this.toReceivedEntries(result.entries),
      alreadyMember: result.alreadyMember,
    };
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
      include: { share: { include: ENTRY_INCLUDE } },
    });

    return Promise.all(
      memberships.map(async (m) => ({
        shareId: m.shareId,
        label: m.label,
        redeemedAt: m.redeemedAt,
        collections: await this.toReceivedEntries(m.share.entries),
      })),
    );
  }

  /** Renomme, côté membre, un partage que j'ai rejoint. Le propriétaire ne voit pas ce libellé. */
  async updateMembershipLabel(
    userId: string,
    shareId: string,
    label: string | null,
  ): Promise<ReceivedShare> {
    const membership = await this.prisma.collectionShareMember.findFirst({
      where: {
        shareId,
        memberUserId: userId,
        revokedAt: null,
        share: { revokedAt: null },
      },
      select: { shareId: true },
    });
    if (!membership) {
      throw new NotFoundException('Share not found');
    }
    const updated = await this.prisma.collectionShareMember.update({
      where: { shareId_memberUserId: { shareId, memberUserId: userId } },
      data: { label },
      include: { share: { include: ENTRY_INCLUDE } },
    });
    return {
      shareId: updated.shareId,
      label: updated.label,
      redeemedAt: updated.redeemedAt,
      collections: await this.toReceivedEntries(updated.share.entries),
    };
  }

  private toView(
    share: {
      id: string;
      label: string | null;
      maxUses: number;
      usedCount: number;
      expiresAt: bigint | null;
      createdAt: Date;
      entries: EntryRow[];
    },
    members: ShareMemberView[],
  ): ShareView {
    return {
      id: share.id,
      label: share.label,
      maxUses: share.maxUses,
      usedCount: share.usedCount,
      expiresAt: share.expiresAt != null ? Number(share.expiresAt) : null,
      createdAt: share.createdAt,
      collections: share.entries.map(toEntryView),
      members,
    };
  }

  /** Ajoute à chaque entrée le nombre d'éléments visibles sous ses statuts. */
  private async toReceivedEntries(
    entries: EntryRow[],
  ): Promise<ReceivedEntryView[]> {
    return Promise.all(
      entries.map(async (row) => {
        const view = toEntryView(row);
        return {
          ...view,
          itemCount: await this.filter.countItems(
            view.collectionId,
            view.statuses,
          ),
        };
      }),
    );
  }
}
