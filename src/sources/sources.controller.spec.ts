import { OauthCredentialsService } from '../oauth/oauth.service';
import { SourcesController } from './sources.controller';

const USER = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

function makeController(): {
  controller: SourcesController;
  credentials: { store: jest.Mock; remove: jest.Mock };
} {
  const credentials = { store: jest.fn(), remove: jest.fn() };
  const controller = new SourcesController(
    credentials as unknown as OauthCredentialsService,
  );
  return { controller, credentials };
}

describe('SourcesController.setTmdbToken', () => {
  it('stocke la clé TMDB chiffrée (provider tmdb, sans expiration)', async () => {
    const { controller, credentials } = makeController();

    await controller.setTmdbToken(USER, { token: 'my-tmdb-key' });

    expect(credentials.store).toHaveBeenCalledWith(USER, 'tmdb', {
      accessToken: 'my-tmdb-key',
      expiresAtMs: 0,
      scopes: [],
    });
  });
});

describe('SourcesController.removeTmdbToken', () => {
  it('révoque la clé TMDB du user', async () => {
    const { controller, credentials } = makeController();

    await controller.removeTmdbToken(USER);

    expect(credentials.remove).toHaveBeenCalledWith(USER, 'tmdb');
  });
});
