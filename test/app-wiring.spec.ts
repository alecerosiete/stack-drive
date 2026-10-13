import { randomBytes } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { AppModule } from '../src/app.module';
import { APP_CONFIG, loadConfiguration } from '../src/config/configuration';
import { PrismaService } from '../src/prisma/prisma.service';
import { QUOTA_WATCH_QUEUE, TRANSFER_QUEUE } from '../src/jobs/jobs.constants';
import { AuthService } from '../src/auth/auth.service';
import { AccountsService } from '../src/accounts/accounts.service';
import { DriveService } from '../src/drive/drive.service';
import { DriveAggregateService } from '../src/drive/drive-aggregate.service';
import { GoogleOAuthService } from '../src/google/google-oauth.service';
import { GoogleTokenService } from '../src/google/google-token.service';
import { TransferJobsService } from '../src/jobs/transfer-jobs.service';
import { DriveController } from '../src/drive/drive.controller';
import { DriveAggregateController } from '../src/drive/drive-aggregate.controller';
import { AccountsController } from '../src/accounts/accounts.controller';
import { AuthController } from '../src/auth/auth.controller';
import { GoogleOAuthController } from '../src/google/google-oauth.controller';
import { TransfersController } from '../src/jobs/transfers.controller';

/**
 * Verifica que todo el grafo de inyección de la aplicación se resuelve.
 *
 * Usa `compile()` y no `init()` a propósito: así se instancian todos los
 * proveedores y controladores (que es lo que se quiere comprobar) sin ejecutar
 * los hooks de ciclo de vida, que abrirían conexiones reales a PostgreSQL y
 * Redis. PrismaService y las colas se sustituyen por dobles.
 */
describe('AppModule (grafo de dependencias)', () => {
  let moduleRef: TestingModule;

  const env = {
    NODE_ENV: 'test',
    JWT_SECRET: 'x'.repeat(48),
    GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/google/callback',
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  } as NodeJS.ProcessEnv;

  const fakeQueue = {
    add: jest.fn(),
    getJob: jest.fn(),
    getJobs: jest.fn().mockResolvedValue([]),
    upsertJobScheduler: jest.fn(),
    removeJobScheduler: jest.fn(),
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(loadConfiguration(env))
      .overrideProvider(PrismaService)
      .useValue({ $queryRaw: jest.fn(), $connect: jest.fn(), $disconnect: jest.fn() })
      .overrideProvider(getQueueToken(TRANSFER_QUEUE))
      .useValue(fakeQueue)
      .overrideProvider(getQueueToken(QUOTA_WATCH_QUEUE))
      .useValue(fakeQueue)
      .compile();
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  it.each([
    ['AuthService', AuthService],
    ['AccountsService', AccountsService],
    ['DriveService', DriveService],
    ['DriveAggregateService', DriveAggregateService],
    ['GoogleOAuthService', GoogleOAuthService],
    ['GoogleTokenService', GoogleTokenService],
    ['TransferJobsService', TransferJobsService],
  ])('resuelve %s con todas sus dependencias', (_name, token) => {
    expect(moduleRef.get(token as never)).toBeDefined();
  });

  it.each([
    ['AuthController', AuthController],
    ['GoogleOAuthController', GoogleOAuthController],
    ['AccountsController', AccountsController],
    ['DriveAggregateController', DriveAggregateController],
    ['DriveController', DriveController],
    ['TransfersController', TransfersController],
  ])('instancia %s', (_name, token) => {
    expect(moduleRef.get(token as never)).toBeDefined();
  });
});

describe('loadConfiguration', () => {
  const base = {
    JWT_SECRET: 'x'.repeat(48),
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REDIRECT_URI: 'http://localhost/cb',
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  } as NodeJS.ProcessEnv;

  it('falla al arrancar si falta una variable obligatoria', () => {
    expect(() => loadConfiguration({ ...base, GOOGLE_CLIENT_SECRET: undefined })).toThrow(
      /falta la variable de entorno GOOGLE_CLIENT_SECRET/,
    );
  });

  it('rechaza una clave de cifrado que no mida 32 bytes', () => {
    expect(() =>
      loadConfiguration({ ...base, TOKEN_ENCRYPTION_KEY: randomBytes(16).toString('base64') }),
    ).toThrow(/clave AES-256 de 32 bytes/);
  });

  it('rechaza un JWT_SECRET corto', () => {
    expect(() => loadConfiguration({ ...base, JWT_SECRET: 'corto' })).toThrow(
      /al menos 32 caracteres/,
    );
  });

  it('construye el anillo de claves con varias versiones', () => {
    const v1 = randomBytes(32).toString('base64');
    const v2 = randomBytes(32).toString('base64');

    const config = loadConfiguration({
      ...base,
      TOKEN_ENCRYPTION_KEY: undefined,
      TOKEN_ENCRYPTION_KEYS: `1:${v1},2:${v2}`,
      TOKEN_ENCRYPTION_KEY_VERSION: '2',
    });

    expect(Object.keys(config.encryption.keys)).toEqual(['1', '2']);
    expect(config.encryption.activeVersion).toBe(2);
  });

  it('rechaza marcar como activa una versión de clave que no existe', () => {
    expect(() =>
      loadConfiguration({ ...base, TOKEN_ENCRYPTION_KEY_VERSION: '7' }),
    ).toThrow(/no existe en el anillo de claves/);
  });

  it('valida que el umbral de redistribución sea una fracción', () => {
    expect(() => loadConfiguration({ ...base, REBALANCE_THRESHOLD: '90' })).toThrow(
      /fracción entre 0 y 1/,
    );
    expect(loadConfiguration({ ...base, REBALANCE_THRESHOLD: '0.85' }).rebalance.threshold).toBe(
      0.85,
    );
  });

  it('rechaza una retención del histórico de cuota que lo vaciaría', () => {
    expect(() => loadConfiguration({ ...base, QUOTA_HISTORY_DAYS: '0' })).toThrow(/QUOTA_HISTORY_DAYS/);
    expect(() => loadConfiguration({ ...base, QUOTA_HISTORY_DAYS: '1.5' })).toThrow(/QUOTA_HISTORY_DAYS/);
    expect(loadConfiguration(base).quotaWatch.historyDays).toBe(90);
  });

  it('usa el scope de Drive completo por defecto', () => {
    expect(loadConfiguration(base).google.scopes).toContain(
      'https://www.googleapis.com/auth/drive',
    );
  });
});
