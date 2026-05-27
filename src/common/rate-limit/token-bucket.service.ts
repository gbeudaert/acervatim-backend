import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const CAS_MAX_ATTEMPTS = 5;
const BUCKET_IDLE_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class TokenBucketService {
  private readonly logger = new Logger(TokenBucketService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Consomme un token du bucket. `true` si autorisé, `false` si dépassement.
   *
   * Algo : leaky bucket / token bucket.
   * - Refill = elapsed * refillPerSec, clampé à `capacity`.
   * - Update atomique via `updateMany` conditionné sur `lastRefill` (CAS optimiste).
   *   En cas de conflit on relit et on retente — borné à CAS_MAX_ATTEMPTS pour éviter le livelock.
   */
  async consume(
    bucketKey: string,
    capacity: number,
    refillPerSec: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
      const now = Date.now();
      const existing = await this.prisma.rateLimitBucket.findUnique({
        where: { bucketKey },
      });

      if (!existing) {
        const created = await this.tryCreate(bucketKey, capacity, now);
        if (created) return true;
        continue;
      }

      const elapsedSec = Math.max(
        0,
        (now - Number(existing.lastRefill)) / 1000,
      );
      const refilled = Math.min(
        capacity,
        existing.tokens + elapsedSec * refillPerSec,
      );

      if (refilled < 1) {
        return false;
      }

      const res = await this.prisma.rateLimitBucket.updateMany({
        where: { bucketKey, lastRefill: existing.lastRefill },
        data: {
          tokens: refilled - 1,
          lastRefill: BigInt(now),
          expiresAt: new Date(now + BUCKET_IDLE_TTL_MS),
        },
      });
      if (res.count === 1) return true;
    }

    this.logger.warn(
      `token-bucket: CAS gave up after ${CAS_MAX_ATTEMPTS} attempts on ${bucketKey}`,
    );
    return false;
  }

  private async tryCreate(
    bucketKey: string,
    capacity: number,
    now: number,
  ): Promise<boolean> {
    try {
      await this.prisma.rateLimitBucket.create({
        data: {
          bucketKey,
          tokens: capacity - 1,
          lastRefill: BigInt(now),
          expiresAt: new Date(now + BUCKET_IDLE_TTL_MS),
        },
      });
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return false;
      }
      throw err;
    }
  }

  async pruneExpired(): Promise<number> {
    const res = await this.prisma.rateLimitBucket.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (res.count > 0) {
      this.logger.log(`token-bucket: pruned ${res.count} expired rows`);
    }
    return res.count;
  }
}
