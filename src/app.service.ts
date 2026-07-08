import { Injectable } from '@nestjs/common';
import { RedisHealthService } from './common/redis/redis-health.service';

@Injectable()
export class AppService {
  constructor(private readonly redisHealth: RedisHealthService) {}

  health() {
    // `status` reste `ok` même si Redis est down : Redis n'est pas vital au boot de l'API (le chemin
    // interactif dégrade en 503 propre, cf. RedisHealthService) — le marquer unhealthy déclencherait
    // un redémarrage inutile du conteneur. On expose l'état pour l'observabilité.
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      redis: this.redisHealth.isAvailable() ? 'up' : 'down',
    };
  }
}
