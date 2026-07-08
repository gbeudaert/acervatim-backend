import { Global, Module } from '@nestjs/common';
import { RedisHealthService } from './redis-health.service';

/**
 * Sonde de disponibilité Redis, exposée globalement : les producteurs de jobs (adapters sources,
 * gbooks, import de série) l'injectent pour court-circuiter le chemin interactif quand Redis est
 * indisponible (cf. {@link RedisHealthService}).
 */
@Global()
@Module({
  providers: [RedisHealthService],
  exports: [RedisHealthService],
})
export class RedisHealthModule {}
