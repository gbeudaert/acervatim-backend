import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminTokenGuard } from '../../invitations/admin-token.guard';
import { PremiumGuard } from '../../premium/premium.guard';
import { SeriesUpdatesController } from './series-updates.controller';

function guardsOf(method: keyof SeriesUpdatesController): unknown[] {
  return (
    Reflect.getMetadata(
      GUARDS_METADATA,
      SeriesUpdatesController.prototype[method],
    ) ?? []
  );
}

describe('SeriesUpdatesController — gardes', () => {
  it('GET series-updates : JWT puis premium, dans cet ordre (PremiumGuard lit req.userId)', () => {
    expect(guardsOf('list')).toEqual([JwtAuthGuard, PremiumGuard]);
  });

  it('POST admin/edition-watch/run : jeton admin seulement, aucune garde de classe JWT', () => {
    expect(guardsOf('run')).toEqual([AdminTokenGuard]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SeriesUpdatesController),
    ).toBeUndefined();
  });

  it('délègue la lecture au service pour l’utilisateur courant', async () => {
    const watch = {
      seriesUpdates: jest.fn().mockResolvedValue({ updates: [] }),
    };
    const ctrl = new SeriesUpdatesController(watch as never);
    await expect(ctrl.list('u1')).resolves.toEqual({ updates: [] });
    expect(watch.seriesUpdates).toHaveBeenCalledWith('u1');
  });
});
