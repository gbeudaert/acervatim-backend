import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { HashService } from '../common/crypto/hash.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';

export interface CreatedInvitation {
  /** Code en clair. Retourné UNE seule fois, à l'admin qui crée l'invitation. */
  code: string;
  /** HMAC stocké en base, utile pour identifier la row (préfixe seulement dans les logs). */
  codeHash: string;
}

export interface RedeemResult {
  alreadyRedeemed: boolean;
  premiumGranted: boolean;
  reason: string;
}

@Injectable()
export class InvitationsService implements OnModuleInit {
  private readonly logger = new Logger(InvitationsService.name);
  private pepper!: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly hash: HashService,
  ) {}

  onModuleInit() {
    const pepper = this.config.get<string>('INVITE_CODE_PEPPER');
    if (!pepper || pepper.length < 32) {
      throw new Error('INVITE_CODE_PEPPER must be set (≥ 32 chars, base64 recommandé)');
    }
    this.pepper = pepper;
  }

  private hashCode(code: string): string {
    return this.hash.hmacSha256Hex(this.pepper, code);
  }

  /** 18 octets aléatoires → 24 chars base64url. ~144 bits d'entropie. */
  private generateCode(): string {
    return randomBytes(18).toString('base64url');
  }

  async create(input: CreateInvitationDto): Promise<CreatedInvitation> {
    const code = this.generateCode();
    const codeHash = this.hashCode(code);

    await this.prisma.invitation.create({
      data: {
        codeHash,
        reason: input.reason,
        grantsPremium: input.grantsPremium ?? false,
        premiumExpiresAt:
          input.premiumExpiresAt != null ? BigInt(input.premiumExpiresAt) : null,
        maxUses: input.maxUses ?? 1,
        expiresAt: input.expiresAt != null ? BigInt(input.expiresAt) : null,
        createdBy: input.createdBy,
        notes: input.notes,
      },
    });

    this.logger.log(
      `Invitation créée hash=${codeHash.slice(0, 8)}… reason=${input.reason} maxUses=${input.maxUses ?? 1}`,
    );
    return { code, codeHash };
  }

  /**
   * Consomme un code pour `userId`.
   * - Idempotent : si l'utilisateur a déjà claim ce code → success no-op.
   * - Atomique : check expiration + maxUses + insert redemption + grant dans la même transaction.
   * - Robuste à la concurrence : l'incrément de usedCount est gardé par updateMany conditionnel.
   */
  async redeem(rawCode: string, userId: string): Promise<RedeemResult> {
    const codeHash = this.hashCode(rawCode);

    return this.prisma.$transaction(async (tx) => {
      const invitation = await tx.invitation.findUnique({ where: { codeHash } });
      if (!invitation) {
        throw new NotFoundException('Invitation introuvable');
      }

      const nowMs = Date.now();
      if (invitation.expiresAt != null && Number(invitation.expiresAt) < nowMs) {
        throw new ForbiddenException('Invitation expirée');
      }

      const existing = await tx.invitationRedemption.findUnique({
        where: {
          invitationCodeHash_userId: { invitationCodeHash: codeHash, userId },
        },
      });
      if (existing) {
        return {
          alreadyRedeemed: true,
          premiumGranted: invitation.grantsPremium,
          reason: invitation.reason,
        };
      }

      if (invitation.usedCount >= invitation.maxUses) {
        throw new ForbiddenException('Invitation épuisée');
      }

      // Garde optimiste : n'incrémente que si la place est encore là.
      const bumped = await tx.invitation.updateMany({
        where: { codeHash, usedCount: { lt: invitation.maxUses } },
        data: { usedCount: { increment: 1 } },
      });
      if (bumped.count === 0) {
        throw new ConflictException('Invitation épuisée (race)');
      }

      await tx.invitationRedemption.create({
        data: { invitationCodeHash: codeHash, userId },
      });

      if (invitation.grantsPremium) {
        // Ne JAMAIS écraser un grant existant (l'utilisateur peut déjà être premium,
        // ou avoir un grant permanent qu'on ne veut pas dégrader).
        await tx.premiumGrant.upsert({
          where: { userId },
          create: {
            userId,
            reason: invitation.reason,
            grantedBy: invitation.createdBy ?? 'invitation',
            expiresAt: invitation.premiumExpiresAt,
            notes: `via invitation ${codeHash.slice(0, 8)}…`,
          },
          update: {},
        });
      }

      this.logger.log(
        `Invitation claim hash=${codeHash.slice(0, 8)}… user=${userId.slice(0, 8)}… premium=${invitation.grantsPremium}`,
      );

      return {
        alreadyRedeemed: false,
        premiumGranted: invitation.grantsPremium,
        reason: invitation.reason,
      };
    });
  }

  /** Pour cron : supprime les invitations expirées (libère la place + nettoie). */
  async purgeExpired(): Promise<number> {
    const res = await this.prisma.invitation.deleteMany({
      where: { expiresAt: { not: null, lt: BigInt(Date.now()) } },
    });
    if (res.count > 0) {
      this.logger.log(`Purgé ${res.count} invitation(s) expirée(s)`);
    }
    return res.count;
  }
}