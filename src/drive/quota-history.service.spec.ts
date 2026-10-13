import { GoogleAccount, QuotaSample } from '@prisma/client';
import { AppConfiguration } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaHistoryService } from './quota-history.service';

const account = (id: string, email: string) => ({ id, userId: 'user-1', email, alias: null }) as GoogleAccount;

const sample = (accountId: string, capturedAt: string, usage: bigint, limit: bigint | null = 100n) =>
  ({
    id: 1n,
    accountId,
    capturedAt: new Date(capturedAt),
    limitBytes: limit,
    usageBytes: usage,
    usageInDriveBytes: usage / 2n,
    usageInTrashBytes: 1n,
  }) as QuotaSample;

function harness(accounts: GoogleAccount[], samples: QuotaSample[], watchEnabled = true) {
  const prisma = {
    googleAccount: { findMany: jest.fn().mockResolvedValue(accounts) },
    quotaSample: { findMany: jest.fn().mockResolvedValue(samples) },
  } as unknown as PrismaService;
  const config = { quotaWatch: { enabled: watchEnabled } } as AppConfiguration;
  return { service: new QuotaHistoryService(prisma, config), prisma };
}

describe('QuotaHistoryService', () => {
  it('agrupa la serie por cuenta y convierte los BigInt a números', async () => {
    const { service } = harness(
      [account('a', 'a@gmail.com'), account('b', 'b@gmail.com')],
      [
        sample('a', '2026-10-01T00:00:00Z', 40n),
        sample('b', '2026-10-01T00:00:00Z', 10n, null),
        sample('a', '2026-10-02T00:00:00Z', 55n),
      ],
    );

    const history = await service.history('user-1', 30);

    const [a, b] = history.accounts;
    expect(a.account.email).toBe('a@gmail.com');
    expect(a.points).toEqual([
      {
        capturedAt: '2026-10-01T00:00:00.000Z',
        limit: 100,
        usage: 40,
        usageInDrive: 20,
        usageInDriveTrash: 1,
        usedPercent: 40,
      },
      expect.objectContaining({ capturedAt: '2026-10-02T00:00:00.000Z', usage: 55, usedPercent: 55 }),
    ]);
    // Almacenamiento ilimitado: sin límite no hay porcentaje.
    expect(b.points[0]).toMatchObject({ limit: null, usedPercent: null });
  });

  it('solo busca muestras de las cuentas del usuario y dentro de la ventana pedida', async () => {
    const { service, prisma } = harness([account('a', 'a@gmail.com')], []);
    const before = Date.now();

    await service.history('user-1', 7);

    expect(prisma.googleAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    const where = (prisma.quotaSample.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.accountId).toEqual({ in: ['a'] });
    const from = where.capturedAt.gte.getTime();
    expect(before - from).toBeGreaterThanOrEqual(7 * 24 * 3600 * 1000 - 1000);
    expect(before - from).toBeLessThanOrEqual(7 * 24 * 3600 * 1000 + 1000);
  });

  it('incluye las cuentas sin muestras e indica si el vigilante está apagado', async () => {
    const { service, prisma } = harness([account('a', 'a@gmail.com')], [], false);

    const history = await service.history('user-1', 30);

    expect(history.watchEnabled).toBe(false);
    expect(history.accounts).toEqual([{ account: expect.objectContaining({ id: 'a' }), points: [] }]);
    expect(prisma.quotaSample.findMany).toHaveBeenCalled();
  });

  it('sin cuentas no consulta la serie', async () => {
    const { service, prisma } = harness([], []);

    await expect(service.history('user-1', 30)).resolves.toMatchObject({ accounts: [] });
    expect(prisma.quotaSample.findMany).not.toHaveBeenCalled();
  });
});
