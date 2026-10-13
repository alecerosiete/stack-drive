import { GoogleAccount } from '@prisma/client';
import { AppConfiguration } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { DriveClientFactory } from '../google/drive-client.factory';
import { DriveService } from '../drive/drive.service';
import { QuotaWatchProcessor } from './quota-watch.processor';

const account = (id: string, email: string) => ({ id, email, status: 'ACTIVE' }) as GoogleAccount;

function harness(failing: string[] = []) {
  const prisma = {
    googleAccount: {
      findMany: jest.fn().mockResolvedValue([account('a', 'a@gmail.com'), account('b', 'b@gmail.com')]),
    },
    quotaSnapshot: { upsert: jest.fn((args) => ({ op: 'upsert', args })) },
    quotaSample: {
      create: jest.fn((args) => ({ op: 'create', args })),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  } as unknown as PrismaService;
  const clients = {
    forResolvedAccount: jest.fn(async (acc: GoogleAccount) => ({ account: acc })),
  } as unknown as DriveClientFactory;
  const drive = {
    getQuota: jest.fn(async (ctx: { account: GoogleAccount }) => {
      if (failing.includes(ctx.account.id)) throw new Error('invalid_grant');
      return { limit: 1000, usage: 950, usageInDrive: 900, usageInDriveTrash: 50, usedPercent: 95 };
    }),
  } as unknown as DriveService;
  const config = {
    rebalance: { threshold: 0.9 },
    quotaWatch: { historyDays: 90 },
  } as unknown as AppConfiguration;
  return { processor: new QuotaWatchProcessor(prisma, clients, drive, config), prisma };
}

describe('QuotaWatchProcessor', () => {
  it('guarda la foto y una muestra del histórico en la misma transacción', async () => {
    const { processor, prisma } = harness();

    await processor.process();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    const [upsert, create] = (prisma.$transaction as jest.Mock).mock.calls[0][0];
    expect(upsert.op).toBe('upsert');
    expect(create.args.data).toMatchObject({
      accountId: 'a',
      limitBytes: 1000n,
      usageBytes: 950n,
      usageInDriveBytes: 900n,
      usageInTrashBytes: 50n,
    });
    // La foto y la muestra comparten instante.
    expect(create.args.data.capturedAt).toBe(upsert.args.update.capturedAt);
  });

  it('purga las muestras más antiguas que la retención', async () => {
    const { processor, prisma } = harness();
    const before = Date.now();

    const summary = await processor.process();

    expect(summary.pruned).toBe(3);
    const cutoff = (prisma.quotaSample.deleteMany as jest.Mock).mock.calls[0][0].where.capturedAt.lt;
    expect(Math.abs(before - cutoff.getTime() - 90 * 24 * 3600 * 1000)).toBeLessThan(1000);
  });

  it('una cuenta que falla no impide registrar las demás', async () => {
    const { processor, prisma } = harness(['a']);

    const summary = await processor.process();

    expect(summary).toMatchObject({ scanned: 1, failed: 1 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(summary.underPressure.map((u) => u.email)).toEqual(['b@gmail.com']);
  });
});
