import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { GoogleAccount } from '@prisma/client';
import { GoogleTokenService, contextFor } from './google-token.service';
import { GoogleAccountRepository } from './google-account.repository';
import { TokenCryptoService } from '../crypto/token-crypto.service';
import { AppConfiguration } from '../config/configuration';
import { GoogleAccountNeedsReauthException } from '../common/errors';

jest.mock('google-auth-library');

const MockedOAuth2Client = OAuth2Client as unknown as jest.Mock;

const encryptionKey = randomBytes(32);

const config = {
  google: { clientId: 'client-id', clientSecret: 'secret', redirectUri: 'http://localhost/cb' },
  encryption: { keys: { 1: encryptionKey }, activeVersion: 1 },
  drive: { maxRetries: 0, retryBaseDelayMs: 1, accessTokenSkewSeconds: 60, uploadMaxBytes: 1 },
} as unknown as AppConfiguration;

const crypto = new TokenCryptoService(config);

/** Doble del cliente de Google: responde con el token que indique el test. */
function fakeClient(options: {
  token?: string;
  error?: unknown;
  expiryMs?: number;
  rotatedRefreshToken?: string;
}) {
  const credentials: Record<string, unknown> = {};
  const getAccessToken = jest.fn(async () => {
    if (options.error) throw options.error;
    credentials.expiry_date = Date.now() + (options.expiryMs ?? 3_600_000);
    if (options.rotatedRefreshToken) {
      credentials.refresh_token = options.rotatedRefreshToken;
    }
    return { token: options.token ?? 'access-token' };
  });

  return {
    credentials,
    setCredentials: jest.fn((values: Record<string, unknown>) => Object.assign(credentials, values)),
    getAccessToken,
  };
}

function accountFixture(overrides: Partial<GoogleAccount> = {}): GoogleAccount {
  const base = {
    id: 'account-1',
    userId: 'user-1',
    googleUserId: 'google-sub-1',
    email: 'personal@gmail.com',
    alias: 'Personal',
    picture: null,
    keyVersion: 1,
    scopes: ['https://www.googleapis.com/auth/drive'],
    status: 'ACTIVE' as GoogleAccount['status'],
    statusError: null,
    lastUsedAt: null,
    linkedAt: new Date(),
    updatedAt: new Date(),
    refreshTokenEnc: null,
  } satisfies Omit<GoogleAccount, 'refreshTokenEnc'> & { refreshTokenEnc: string | null };

  const account = { ...base, ...overrides } as GoogleAccount;

  if (!account.refreshTokenEnc) {
    account.refreshTokenEnc = crypto.seal('refresh-token-original', contextFor(account)).ciphertext;
  }
  return account;
}

describe('GoogleTokenService (motor de refresco)', () => {
  let repository: jest.Mocked<Pick<GoogleAccountRepository, 'update' | 'markNeedsReauth' | 'touch'>>;
  let service: GoogleTokenService;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = {
      update: jest.fn().mockResolvedValue(undefined),
      markNeedsReauth: jest.fn().mockResolvedValue(undefined),
      touch: jest.fn().mockResolvedValue(undefined),
    };
    service = new GoogleTokenService(
      config,
      crypto,
      repository as unknown as GoogleAccountRepository,
    );
  });

  it('canjea el refresh_token y reutiliza el access_token mientras siga vigente', async () => {
    const client = fakeClient({ token: 'access-1' });
    MockedOAuth2Client.mockImplementation(() => client);
    const account = accountFixture();

    const first = await service.getAccessToken(account);
    const second = await service.getAccessToken(account);

    expect(first).toBe('access-1');
    expect(second).toBe('access-1');
    // Dos peticiones del usuario, una sola llamada al endpoint de Google.
    expect(client.getAccessToken).toHaveBeenCalledTimes(1);
    expect(client.setCredentials).toHaveBeenCalledWith({
      refresh_token: 'refresh-token-original',
    });
  });

  it('no cachea un token que caduca dentro del margen de seguridad', async () => {
    // Caduca en 30 s y el margen es de 60 s: servirlo sería arriesgarse a que
    // expire en mitad de una subida.
    const client = fakeClient({ token: 'access-corto', expiryMs: 30_000 });
    MockedOAuth2Client.mockImplementation(() => client);
    const account = accountFixture();

    await service.getAccessToken(account);
    await service.getAccessToken(account);

    expect(client.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('deduplica refrescos concurrentes de la misma cuenta', async () => {
    const client = fakeClient({ token: 'access-1' });
    MockedOAuth2Client.mockImplementation(() => client);
    const account = accountFixture();

    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => service.getAccessToken(account)),
    );

    expect(tokens).toEqual(Array(5).fill('access-1'));
    expect(client.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('mantiene cachés independientes por cuenta (criterio de aceptación 1)', async () => {
    const accountA = accountFixture({ id: 'account-a', googleUserId: 'sub-a', email: 'a@gmail.com' });
    const accountB = accountFixture({ id: 'account-b', googleUserId: 'sub-b', email: 'b@gmail.com' });

    MockedOAuth2Client.mockImplementationOnce(() => fakeClient({ token: 'access-a' }))
      .mockImplementationOnce(() => fakeClient({ token: 'access-b' }));

    expect(await service.getAccessToken(accountA)).toBe('access-a');
    expect(await service.getAccessToken(accountB)).toBe('access-b');
    // Y cada una sigue sirviendo su propio token desde caché.
    expect(await service.getAccessToken(accountA)).toBe('access-a');
    expect(await service.getAccessToken(accountB)).toBe('access-b');
  });

  it('marca la cuenta como NEEDS_REAUTH cuando Google responde invalid_grant', async () => {
    const invalidGrant = Object.assign(new Error('invalid_grant'), {
      response: {
        status: 400,
        data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    });
    MockedOAuth2Client.mockImplementation(() => fakeClient({ error: invalidGrant }));
    const account = accountFixture();

    await expect(service.getAccessToken(account)).rejects.toThrow(
      GoogleAccountNeedsReauthException,
    );
    expect(repository.markNeedsReauth).toHaveBeenCalledWith(
      'account-1',
      'Token has been expired or revoked.',
    );
  });

  it('vuelve a cifrar y guardar el refresh_token si Google lo rota', async () => {
    MockedOAuth2Client.mockImplementation(() =>
      fakeClient({ token: 'access-1', rotatedRefreshToken: 'refresh-token-nuevo' }),
    );
    const account = accountFixture();

    await service.getAccessToken(account);

    expect(repository.update).toHaveBeenCalledTimes(1);
    const [accountId, data] = repository.update.mock.calls[0];
    expect(accountId).toBe('account-1');

    // Lo guardado debe ser el token NUEVO, cifrado (nunca en claro).
    const stored = data.refreshTokenEnc as string;
    expect(stored).not.toContain('refresh-token-nuevo');
    expect(crypto.open({ ciphertext: stored, keyVersion: 1 }, contextFor(account))).toBe(
      'refresh-token-nuevo',
    );
  });

  it('reactiva una cuenta que estaba en NEEDS_REAUTH si el token vuelve a funcionar', async () => {
    MockedOAuth2Client.mockImplementation(() => fakeClient({ token: 'access-1' }));
    const account = accountFixture({ status: 'NEEDS_REAUTH', statusError: 'fallo anterior' });

    await service.getAccessToken(account);

    expect(repository.update).toHaveBeenCalledWith('account-1', {
      status: 'ACTIVE',
      statusError: null,
    });
  });

  it('exige reautorización si la cuenta no tiene credencial almacenada', async () => {
    const account = { ...accountFixture(), refreshTokenEnc: null } as GoogleAccount;

    await expect(service.getAccessToken(account)).rejects.toThrow(
      GoogleAccountNeedsReauthException,
    );
  });

  it('invalidate() fuerza un refresco en la siguiente petición', async () => {
    const client = fakeClient({ token: 'access-1' });
    MockedOAuth2Client.mockImplementation(() => client);
    const account = accountFixture();

    await service.getAccessToken(account);
    service.invalidate(account.id);
    await service.getAccessToken(account);

    expect(client.getAccessToken).toHaveBeenCalledTimes(2);
  });
});
