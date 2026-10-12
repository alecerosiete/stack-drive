import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DriveAggregateService } from '../drive/drive-aggregate.service';
import { TransferResult } from '../drive/drive-aggregate.types';
import { TRANSFER_QUEUE } from './jobs.constants';
import { TransferJobData } from './transfer-jobs.service';

/**
 * La concurrencia se lee del entorno aquí y no del `ConfigService` porque el
 * decorador se evalúa al cargar la clase, antes de que exista el contenedor
 * de inyección de Nest.
 */
const CONCURRENCY = Number(process.env.TRANSFER_CONCURRENCY ?? 2) || 2;

/** Worker que ejecuta las transferencias entre cuentas de Google. */
@Processor(TRANSFER_QUEUE, { concurrency: CONCURRENCY })
export class TransferProcessor extends WorkerHost {
  private readonly logger = new Logger(TransferProcessor.name);

  constructor(private readonly aggregate: DriveAggregateService) {
    super();
  }

  async process(job: Job<TransferJobData, TransferResult>): Promise<TransferResult> {
    const { userId, transfer } = job.data;

    return this.aggregate.transfer(userId, transfer, {
      onProgress: (percent) => {
        // `updateProgress` escribe en Redis: lo dejamos en manos del servicio,
        // que solo notifica cuando el porcentaje cambia de forma apreciable.
        void job.updateProgress(percent);
      },
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<TransferJobData>, error: Error): void {
    this.logger.error(
      `Transferencia ${job.id} falló en el intento ${job.attemptsMade}: ${error.message}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<TransferJobData, TransferResult>): void {
    const result = job.returnvalue;
    this.logger.log(
      `Transferencia ${job.id} completada en ${result?.durationMs ?? '?'} ms ` +
        `(verificación: ${result?.verification ?? 'n/a'})`,
    );
  }
}
