import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { GoogleAccount } from '@prisma/client';
import { APP_CONFIG, AppConfiguration } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { DriveClientFactory } from '../google/drive-client.factory';
import { DriveService } from '../drive/drive.service';
import { QUOTA_WATCH_QUEUE } from './jobs.constants';

export interface QuotaWatchSummary {
  scanned: number;
  failed: number;
  /** Muestras del histórico purgadas por superar `QUOTA_HISTORY_DAYS`. */
  pruned: number;
  underPressure: Array<{ accountId: string; email: string; usedPercent: number }>;
}

/** Cuentas que se consultan a la vez: suficiente para ir rápido sin saturar. */
const BATCH_SIZE = 5;

/**
 * Vigilante periódico de cuotas.
 *
 * Mide el ocupado de cada cuenta vinculada y guarda la foto en
 * `quota_snapshots`, para que el panel pueda mostrar el estado sin llamar a
 * Google en cada carga y para avisar al usuario antes de que una cuenta se
 * llene. Cada medición se añade además al histórico (`quota_samples`).
 *
 * Deliberadamente NO mueve ningún archivo: la redistribución siempre la
 * dispara el usuario sobre un plan que ha visto y aceptado
 * (`GET /drive/rebalance/plan`).
 */
@Processor(QUOTA_WATCH_QUEUE, { concurrency: 1 })
export class QuotaWatchProcessor extends WorkerHost {
  private readonly logger = new Logger(QuotaWatchProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: DriveClientFactory,
    private readonly drive: DriveService,
    @Inject(APP_CONFIG) private readonly config: AppConfiguration,
  ) {
    super();
  }

  async process(): Promise<QuotaWatchSummary> {
    const accounts = await this.prisma.googleAccount.findMany({ where: { status: 'ACTIVE' } });
    const summary: QuotaWatchSummary = { scanned: 0, failed: 0, pruned: 0, underPressure: [] };

    for (let index = 0; index < accounts.length; index += BATCH_SIZE) {
      const batch = accounts.slice(index, index + BATCH_SIZE);
      const outcomes = await Promise.allSettled(batch.map((account) => this.measure(account)));

      outcomes.forEach((outcome, position) => {
        const account = batch[position];
        if (outcome.status === 'rejected') {
          summary.failed += 1;
          this.logger.warn(
            `No se pudo medir la cuota de ${account.email}: ` +
              `${outcome.reason instanceof Error ? outcome.reason.message : 'error desconocido'}`,
          );
          return;
        }

        summary.scanned += 1;
        const usedPercent = outcome.value;
        if (usedPercent !== null && usedPercent / 100 >= this.config.rebalance.threshold) {
          summary.underPressure.push({
            accountId: account.id,
            email: account.email,
            usedPercent,
          });
        }
      });
    }

    summary.pruned = await this.pruneHistory();

    if (summary.underPressure.length > 0) {
      this.logger.warn(
        `${summary.underPressure.length} cuenta(s) por encima del ` +
          `${Math.round(this.config.rebalance.threshold * 100)} % de cuota: ` +
          summary.underPressure.map((item) => `${item.email} (${item.usedPercent} %)`).join(', '),
      );
    }

    this.logger.log(
      `Vigilancia de cuotas: ${summary.scanned} medidas, ${summary.failed} fallos, ` +
        `${summary.underPressure.length} bajo presión, ${summary.pruned} muestras antiguas purgadas`,
    );
    return summary;
  }

  /** Mide y persiste la cuota de una cuenta. Devuelve el % ocupado. */
  private async measure(account: GoogleAccount): Promise<number | null> {
    const ctx = await this.clients.forResolvedAccount(account);
    const quota = await this.drive.getQuota(ctx);

    const capturedAt = new Date();
    const limitBytes = quota.limit === null ? null : BigInt(Math.trunc(quota.limit));
    const usageBytes = BigInt(Math.trunc(quota.usage));
    const snapshot = { limitBytes, usageBytes, usedPercent: quota.usedPercent, capturedAt };

    // En una transacción: la foto y la última muestra del histórico deben
    // contar siempre lo mismo.
    await this.prisma.$transaction([
      this.prisma.quotaSnapshot.upsert({
        where: { accountId: account.id },
        create: { accountId: account.id, ...snapshot },
        update: snapshot,
      }),
      this.prisma.quotaSample.create({
        data: {
          accountId: account.id,
          limitBytes,
          usageBytes,
          usageInDriveBytes: BigInt(Math.trunc(quota.usageInDrive)),
          usageInTrashBytes: BigInt(Math.trunc(quota.usageInDriveTrash)),
          capturedAt,
        },
      }),
    ]);

    return quota.usedPercent;
  }

  /** Borra las muestras más antiguas que la retención configurada. */
  private async pruneHistory(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.quotaWatch.historyDays * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.quotaSample.deleteMany({
      where: { capturedAt: { lt: cutoff } },
    });
    return count;
  }
}
