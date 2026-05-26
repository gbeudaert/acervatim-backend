import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditRecordInput {
  userId?: string | null;
  action: string;
  target?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Append-only. N'expose aucune méthode `update` ou `delete` : la trace ne se réécrit pas.
 * Les erreurs d'écriture sont avalées (loggées) pour ne pas casser le chemin métier
 * — un échec d'audit doit alerter, pas faire échouer un login ou un export.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: input.userId ?? null,
          action: input.action,
          target: input.target ?? null,
          metadata: input.metadata ?? Prisma.JsonNull,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`audit.record failed action=${input.action}: ${msg}`);
    }
  }
}
