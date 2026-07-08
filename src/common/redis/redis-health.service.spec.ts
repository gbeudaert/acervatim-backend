import { RedisHealthService } from './redis-health.service';

/**
 * On ne teste PAS l'ouverture d'une vraie connexion ioredis ici (ce serait un e2e Redis) : on couvre
 * la **mécanique du drapeau** que les événements de connexion pilotent (`setAvailable`). Le câblage
 * `ready`/`close` → `setAvailable` est du code standard ioredis, exercé au boot réel.
 */
describe('RedisHealthService (drapeau de disponibilité)', () => {
  function make() {
    const config = { get: jest.fn((_k: string, d: unknown) => d) };
    const svc = new RedisHealthService(config as never);
    // Accès au setter privé piloté par les événements de connexion.
    const setAvailable = (v: boolean) =>
      (svc as unknown as { setAvailable(v: boolean): void }).setAvailable(v);
    return { svc, setAvailable };
  }

  it('indisponible tant que la connexion n’est pas prête (état initial)', () => {
    const { svc } = make();
    expect(svc.isAvailable()).toBe(false);
  });

  it('`ready` → disponible ; `close` → indisponible', () => {
    const { svc, setAvailable } = make();
    setAvailable(true); // ← émis par l'événement `ready`
    expect(svc.isAvailable()).toBe(true);
    setAvailable(false); // ← émis par `close`/`end`
    expect(svc.isAvailable()).toBe(false);
  });
});
