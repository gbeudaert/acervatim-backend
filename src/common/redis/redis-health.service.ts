import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { Redis } from 'ioredis';

/**
 * Sonde de disponibilité Redis + **circuit-breaker** du chemin interactif.
 *
 * Problème : les files BullMQ (`gbooks`, `bnf`, `mal`, `discogs`, `tmdb`) attendent le worker via
 * `waitUntilFinished(..., ~15 s)`. Si Redis tombe, chaque appel **interactif** (`search`,
 * `edition-mapping`) reste bloqué jusqu'au timeout avant d'échouer — exactement le timeout client qui
 * faisait échouer les scans (incident 0.5.3), mais généralisé à toutes les sources.
 *
 * Solution : une **connexion Redis dédiée** dont l'état (`ready`/`close`) pilote un drapeau
 * `available` mis à jour ~immédiatement sur coupure. Les producteurs consultent `isAvailable()`
 * **avant** d'enfiler : Redis down → `503` propre tout de suite (chemin interactif) ou dégradation en
 * `null` (chemin best-effort jaquettes), sans attendre les 15 s. C'est le durcissement P3 annoncé.
 *
 * NB : la connexion applicative BullMQ (producteurs/workers) se reconnecte de son côté ; cette sonde
 * ne fait qu'**observer** l'état pour court-circuiter vite. Elle n'émet aucune commande (le drapeau
 * vient des seuls événements de connexion), `enableOfflineQueue: false` garantit qu'un éventuel
 * `ping` échouerait vite plutôt que d'être mis en file hors-ligne.
 */
@Injectable()
export class RedisHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthService.name);
  private client?: Redis;
  private available = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.client = new IORedis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      // On veut échouer vite, pas mettre des commandes en file hors-ligne.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      // Reconnexion bornée (backoff court plafonné) — la sonde doit re-détecter le retour vite.
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });

    this.client.on('ready', () => this.setAvailable(true));
    this.client.on('close', () => this.setAvailable(false));
    this.client.on('end', () => this.setAvailable(false));
    // Obligatoire : sans listener 'error', un EventEmitter lève et fait planter le process. On
    // n'agit pas ici (l'état vient de ready/close) — juste une trace en debug pour ne pas spammer.
    this.client.on('error', (err: Error) =>
      this.logger.debug(`redis health probe error: ${err.message}`),
    );
  }

  /** `true` si la connexion Redis dédiée est établie (dernier événement = `ready`). */
  isAvailable(): boolean {
    return this.available;
  }

  private setAvailable(value: boolean): void {
    if (this.available === value) return;
    this.available = value;
    this.logger.log(`redis ${value ? 'disponible' : 'indisponible'}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    // quit() attend le drain ; en cas d'indisponibilité, disconnect() coupe sans attendre.
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
