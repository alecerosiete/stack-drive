import { Inject, Injectable } from '@nestjs/common';
import { QuotaSample } from '@prisma/client';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { toAccountRef } from './drive.types';
import { QuotaHistory, QuotaHistoryPoint } from './quota-history.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lectura del histórico de cuota que escribe el vigilante.
 *
 * Solo lee de la base de datos, nunca llama a Google: el histórico es lo que
 * se midió en su momento, y medir ahora no lo completaría.
 */
@Injectable()
export class QuotaHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {}

  async history(userId: string, days: number): Promise<QuotaHistory> {
    const to = new Date();
    const from = new Date(to.getTime() - days * DAY_MS);

    // Las cuentas se filtran por userId ANTES de buscar muestras: así el
    // aislamiento entre tenants no depende de la consulta de la serie.
    const accounts = await this.prisma.googleAccount.findMany({
      where: { userId },
      orderBy: { linkedAt: 'asc' },
    });
    const samples = accounts.length
      ? await this.prisma.quotaSample.findMany({
          where: { accountId: { in: accounts.map((a) => a.id) }, capturedAt: { gte: from } },
          orderBy: { capturedAt: 'asc' },
        })
      : [];

    const byAccount = new Map<string, QuotaHistoryPoint[]>();
    for (const sample of samples) {
      const points = byAccount.get(sample.accountId) ?? [];
      points.push(toPoint(sample));
      byAccount.set(sample.accountId, points);
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      watchEnabled: this.config.quotaWatch.enabled,
      accounts: accounts.map((account) => ({
        account: toAccountRef(account),
        points: byAccount.get(account.id) ?? [],
      })),
    };
  }
}

function toPoint(sample: QuotaSample): QuotaHistoryPoint {
  const limit = sample.limitBytes === null ? null : Number(sample.limitBytes);
  const usage = Number(sample.usageBytes);
  return {
    capturedAt: sample.capturedAt.toISOString(),
    limit,
    usage,
    usageInDrive: Number(sample.usageInDriveBytes),
    usageInDriveTrash: Number(sample.usageInTrashBytes),
    // Mismo redondeo que `DriveService.getQuota`, para que la serie y la
    // vista actual muestren la misma cifra.
    usedPercent: limit === null || limit === 0 ? null : Math.round((usage / limit) * 1000) / 10,
  };
}
