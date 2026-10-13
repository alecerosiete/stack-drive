import { GoogleAccount } from '@prisma/client';
import { DriveAggregateService } from './drive-aggregate.service';
import { DriveService } from './drive.service';
import { DriveClientFactory, DriveContext } from '../google/drive-client.factory';
import { AppConfiguration } from '../config/configuration';
import { StorageQuotaView, toAccountRef } from './drive.types';
import { GoogleAccountNeedsReauthException } from '../common/errors';
import { Readable } from 'node:stream';
import { TransferDto } from './dto/drive.dto';

const GB = 1_000_000_000;
const FIFTEEN_GB = 15 * GB;

const config = {
  rebalance: { threshold: 0.9, maxMoves: 25, candidateSampleSize: 200 },
} as unknown as AppConfiguration;

function account(id: string, email: string): GoogleAccount {
  return {
    id,
    userId: 'user-1',
    googleUserId: `sub-${id}`,
    email,
    alias: email,
    picture: null,
    refreshTokenEnc: 'sobre-cifrado',
    keyVersion: 1,
    scopes: [],
    status: 'ACTIVE',
    statusError: null,
    lastUsedAt: null,
    linkedAt: new Date(),
    updatedAt: new Date(),
  } as GoogleAccount;
}

function quotaFor(acc: GoogleAccount, usage: number, limit: number | null = FIFTEEN_GB): StorageQuotaView {
  return {
    account: toAccountRef(acc),
    limit,
    usage,
    usageInDrive: usage,
    usageInDriveTrash: 0,
    usageOutsideDrive: 0,
    freeBytes: limit === null ? null : limit - usage,
    usedPercent: limit === null ? null : Math.round((usage / limit) * 1000) / 10,
  };
}

interface Harness {
  service: DriveAggregateService;
  listFiles: jest.Mock;
  getQuota: jest.Mock;
}

function harness(accounts: GoogleAccount[], quotas: Record<string, StorageQuotaView | Error>): Harness {
  const listFiles = jest.fn().mockResolvedValue({ data: { files: [] } });

  const clients = {
    listAccounts: jest.fn().mockResolvedValue(accounts),
    forResolvedAccount: jest.fn(
      async (acc: GoogleAccount): Promise<DriveContext> =>
        ({ account: acc, drive: { files: { list: listFiles } } }) as unknown as DriveContext,
    ),
    forAccount: jest.fn(),
    invalidateToken: jest.fn(),
  } as unknown as DriveClientFactory;

  const getQuota = jest.fn(async (ctx: DriveContext) => {
    const quota = quotas[ctx.account.id];
    if (quota instanceof Error) throw quota;
    return quota;
  });

  const drive = { getQuota } as unknown as DriveService;

  return { service: new DriveAggregateService(clients, drive, config), listFiles, getQuota };
}

describe('DriveAggregateService.rebalancePlan', () => {
  const full = account('acc-full', 'llena@gmail.com');
  const spacious = account('acc-free', 'libre@gmail.com');

  it('no propone nada si ninguna cuenta supera el umbral', async () => {
    const { service } = harness([full, spacious], {
      'acc-full': quotaFor(full, 10 * GB), // 66 %
      'acc-free': quotaFor(spacious, 1 * GB),
    });

    const plan = await service.rebalancePlan('user-1');

    expect(plan.underPressure).toEqual([]);
    expect(plan.moves).toEqual([]);
    expect(plan.notes.join(' ')).toMatch(/no hace falta redistribuir/i);
  });

  it('propone mover los archivos más grandes hasta bajar del umbral', async () => {
    const { service, listFiles } = harness([full, spacious], {
      'acc-full': quotaFor(full, 14.25 * GB), // 95 %
      'acc-free': quotaFor(spacious, 1 * GB),
    });

    listFiles.mockResolvedValue({
      data: {
        files: [
          { id: 'f1', name: 'video.mp4', mimeType: 'video/mp4', size: String(500_000_000) },
          { id: 'f2', name: 'backup.zip', mimeType: 'application/zip', size: String(300_000_000) },
          { id: 'f3', name: 'foto.jpg', mimeType: 'image/jpeg', size: String(100_000_000) },
        ],
      },
    });

    const plan = await service.rebalancePlan('user-1');

    // Hay que liberar 750 MB: con el de 500 y el de 300 ya se consigue.
    expect(plan.underPressure).toHaveLength(1);
    expect(plan.underPressure[0].bytesToFree).toBe(750_000_000);
    expect(plan.moves.map((move) => move.file.id)).toEqual(['f1', 'f2']);
    expect(plan.moves.every((move) => move.to.id === 'acc-free')).toBe(true);
    expect(plan.freedBytes).toBe(800_000_000);
    expect(plan.unresolvedBytes).toBe(0);
  });

  it('deja claro que el plan no se ha ejecutado', async () => {
    const { service } = harness([full, spacious], {
      'acc-full': quotaFor(full, 14.25 * GB),
      'acc-free': quotaFor(spacious, 1 * GB),
    });

    const plan = await service.rebalancePlan('user-1');

    expect(plan.notes.join(' ')).toMatch(/no se ha ejecutado/i);
  });

  it('descarta documentos nativos de Google y archivos sin bytes', async () => {
    const { service, listFiles } = harness([full, spacious], {
      'acc-full': quotaFor(full, 14.25 * GB),
      'acc-free': quotaFor(spacious, 1 * GB),
    });

    listFiles.mockResolvedValue({
      data: {
        files: [
          {
            id: 'doc',
            name: 'Memoria',
            mimeType: 'application/vnd.google-apps.document',
            size: String(900_000_000),
          },
          { id: 'vacio', name: 'vacio.txt', mimeType: 'text/plain', size: '0' },
          { id: 'real', name: 'iso.img', mimeType: 'application/octet-stream', size: String(800_000_000) },
        ],
      },
    });

    const plan = await service.rebalancePlan('user-1');

    // Un Doc de Google ocupa 0 bytes de cuota: moverlo no libera nada.
    expect(plan.moves.map((move) => move.file.id)).toEqual(['real']);
  });

  it('respeta el margen del destino y reporta lo que no puede liberar', async () => {
    const alsoFull = account('acc-also-full', 'tambien-llena@gmail.com');
    const { service, listFiles } = harness([full, alsoFull], {
      'acc-full': quotaFor(full, 14.25 * GB),
      'acc-also-full': quotaFor(alsoFull, 14 * GB), // 93 %: tampoco sirve de destino
    });

    listFiles.mockResolvedValue({
      data: { files: [{ id: 'f1', name: 'x.bin', mimeType: 'application/octet-stream', size: String(GB) }] },
    });

    const plan = await service.rebalancePlan('user-1');

    expect(plan.moves).toEqual([]);
    expect(plan.unresolvedBytes).toBeGreaterThan(0);
    expect(plan.notes.join(' ')).toMatch(/Vincula otra cuenta/i);
  });

  it('no propone más movimientos de los que caben en el destino', async () => {
    const small = account('acc-small', 'pequena@gmail.com');
    const { service, listFiles } = harness([full, small], {
      'acc-full': quotaFor(full, 14.25 * GB),
      // Margen disponible en destino: 0.9*15GB - 13GB = 500 MB.
      'acc-small': quotaFor(small, 13 * GB),
    });

    listFiles.mockResolvedValue({
      data: {
        files: [
          { id: 'f1', name: 'a.bin', mimeType: 'application/octet-stream', size: String(400_000_000) },
          { id: 'f2', name: 'b.bin', mimeType: 'application/octet-stream', size: String(400_000_000) },
        ],
      },
    });

    const plan = await service.rebalancePlan('user-1');

    expect(plan.moves.map((move) => move.file.id)).toEqual(['f1']);
    expect(plan.unresolvedBytes).toBe(350_000_000);
  });

  it('sigue dando resultado aunque una cuenta falle (tolerancia a fallos parciales)', async () => {
    const broken = account('acc-broken', 'revocada@gmail.com');
    const { service } = harness([full, spacious, broken], {
      'acc-full': quotaFor(full, 10 * GB),
      'acc-free': quotaFor(spacious, 1 * GB),
      'acc-broken': new GoogleAccountNeedsReauthException(
        'acc-broken',
        'revocada@gmail.com',
        'invalid_grant',
      ),
    });

    const plan = await service.rebalancePlan('user-1');

    expect(plan.quotas).toHaveLength(2);
    expect(plan.failures).toHaveLength(1);
    expect(plan.failures[0].code).toBe('GOOGLE_ACCOUNT_NEEDS_REAUTH');
    expect(plan.failures[0].account.email).toBe('revocada@gmail.com');
  });
});

describe('DriveAggregateService.quota', () => {
  it('suma los totales y recomienda la cuenta con más espacio libre', async () => {
    const a = account('acc-a', 'a@gmail.com');
    const b = account('acc-b', 'b@gmail.com');
    const { service } = harness([a, b], {
      'acc-a': quotaFor(a, 14 * GB),
      'acc-b': quotaFor(b, 2 * GB),
    });

    const result = await service.quota('user-1');

    expect(result.totals.limit).toBe(30 * GB);
    expect(result.totals.usage).toBe(16 * GB);
    expect(result.totals.freeBytes).toBe(14 * GB);
    expect(result.recommendedAccountId).toBe('acc-b');
  });
});

describe('DriveAggregateService.transfer (borrado del original)', () => {
  const origin = account('acc-a', 'a@gmail.com');
  const target = account('acc-b', 'b@gmail.com');

  function transferHarness(uploaded = { size: 100, md5Checksum: 'abc' }) {
    const ctxFor = (acc: GoogleAccount) => ({ account: acc, drive: {} }) as unknown as DriveContext;
    const clients = {
      forAccount: jest.fn(async (_user: string, id: string) =>
        ctxFor(id === origin.id ? origin : target),
      ),
      forResolvedAccount: jest.fn(async (acc: GoogleAccount) => ctxFor(acc)),
    } as unknown as DriveClientFactory;

    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const drive = {
      getFile: jest.fn().mockResolvedValue({
        id: 'f1',
        name: 'video.mp4',
        mimeType: 'video/mp4',
        isFolder: false,
        size: 100,
        md5Checksum: 'abc',
      }),
      download: jest.fn().mockResolvedValue({
        stream: Readable.from([]),
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        size: 100,
      }),
      uploadFile: jest.fn().mockResolvedValue({ id: 'copia', ...uploaded }),
      openMedia: jest.fn().mockResolvedValue(Readable.from([])),
      // Abre el origen como lo haría la subida real, para comprobar desde qué
      // cuenta y archivo se leen los bytes.
      uploadResumable: jest.fn(
        async (_ctx: DriveContext, _file: unknown, open: (offset: number) => Promise<Readable>) => {
          await open(0);
          return { id: 'copia', ...uploaded };
        },
      ),
      deleteFile,
    } as unknown as DriveService;

    return { service: new DriveAggregateService(clients, drive, config), deleteFile, drive };
  }

  const request = (extra: Partial<TransferDto> = {}): TransferDto =>
    ({
      from: { accountId: origin.id, fileId: 'f1' },
      to: { accountId: target.id },
      deleteSource: true,
      ...extra,
    }) as TransferDto;

  it('por defecto envía el original a la papelera, no lo borra', async () => {
    const { service, deleteFile } = transferHarness();

    const result = await service.transfer('user-1', request());

    expect(deleteFile).toHaveBeenCalledWith(expect.anything(), 'f1', false);
    expect(result).toMatchObject({ sourceTrashed: true, sourceDeleted: false });
  });

  it('con permanentlyDeleteSource borra el original para liberar la cuota ya', async () => {
    const { service, deleteFile } = transferHarness();

    const result = await service.transfer('user-1', request({ permanentlyDeleteSource: true }));

    expect(deleteFile).toHaveBeenCalledWith(expect.anything(), 'f1', true);
    expect(result).toMatchObject({ sourceTrashed: false, sourceDeleted: true });
  });

  it('nunca borra de forma permanente si la copia no se puede verificar', async () => {
    // Ni md5 ni tamaño coinciden.
    const { service, deleteFile } = transferHarness({ size: 99, md5Checksum: 'otro-md5' });

    await expect(
      service.transfer('user-1', request({ permanentlyDeleteSource: true })),
    ).rejects.toThrow(/no se pudo verificar/i);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('un archivo binario va por la subida reanudable, leyendo del origen', async () => {
    const { service, drive } = transferHarness();

    await service.transfer('user-1', request({ to: { accountId: target.id, parentId: 'dest' } }));

    expect(drive.uploadResumable).toHaveBeenCalledWith(
      expect.objectContaining({ account: target }),
      { name: 'video.mp4', mimeType: 'video/mp4', size: 100 },
      expect.any(Function),
      { parentId: 'dest' },
    );
    expect(drive.openMedia).toHaveBeenCalledWith(expect.objectContaining({ account: origin }), 'f1', 0);
    expect(drive.uploadFile).not.toHaveBeenCalled();
  });

  it('un documento de Google se exporta y va por la subida simple (no tiene tamaño)', async () => {
    const { service, drive } = transferHarness();
    (drive.getFile as jest.Mock).mockResolvedValue({
      id: 'f1',
      name: 'Acta',
      mimeType: 'application/vnd.google-apps.document',
      isFolder: false,
      size: null,
      md5Checksum: null,
    });

    await service.transfer('user-1', request({ deleteSource: false }));

    expect(drive.uploadFile).toHaveBeenCalled();
    expect(drive.uploadResumable).not.toHaveBeenCalled();
  });

  it('rechaza permanentlyDeleteSource sin deleteSource', async () => {
    const { service, deleteFile } = transferHarness();

    await expect(
      service.transfer('user-1', request({ deleteSource: false, permanentlyDeleteSource: true })),
    ).rejects.toThrow(/requiere deleteSource/);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
